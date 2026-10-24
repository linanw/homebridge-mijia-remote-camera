import net from 'node:net';
import { chmod, lstat, mkdir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

const METHODS = new Set(['status', 'homes', 'devices', 'select', 'pause', 'resume', 'auth.start', 'auth.status', 'auth.cancel', 'night.get', 'night.set', 'ptz.capabilities', 'ptz.move', 'matter.pairing', 'matter.openWindow', 'matter.closeWindow', 'metadata.status', 'metadata.refresh', 'metadata.sync', 'metadata.update']);
const MAX_REQUEST = 32768;
const MAX_RESPONSE = 1048576;
const REASONS = new Set(['operation_failed', 'invalid_request', 'response_too_large', 'invalid_response', 'plugin_not_running',
  'operation_timeout', 'rpc_start_failed', 'unsupported_platform', 'bundled_runtime_missing', 'not_selected', 'starting',
  'ready', 'stopped', 'retrying', 'connect_timeout', 'authentication_required', 'session_expired', 'camera_offline',
  'camera_not_in_home', 'unsupported_transport', 'invalid_home_selection', 'invalid_home_response', 'missing_home_owner',
  'invalid_device_response', 'device_pagination_incomplete', 'home_request_failed', 'home_request_rejected',
  'discovery_failed', 'backend_failed', 'connection_failed', 'no_video', 'port_in_use', 'runtime_in_use', 'runtime_closed',
  'runtime_unavailable', 'query_timeout', 'query_cancelled', 'invalid_backend_response', 'storage_failed', 'auth_in_progress',
  'invalid_region', 'unsafe_url', 'network_error', 'request_timeout', 'unexpected_response', 'login_expired', 'login_cancelled',
  'login_not_approved', 'incomplete_session', 'credentials_write_failed', 'unknown_login',
  'night_vision_unsupported', 'night_vision_unavailable', 'night_vision_rejected', 'night_vision_not_applied', 'night_vision_timeout',
  'ptz_unsupported', 'ptz_unavailable', 'ptz_rejected', 'ptz_timeout', 'ptz_busy',
  'matter_disabled', 'matter_not_ready', 'matter_start_failed', 'matter_port_in_use', 'matter_configuration_invalid',
  'matter_pairing_unavailable', 'matter_window_failed', 'matter_closed',
  'metadata_unavailable', 'metadata_incomplete', 'metadata_conflict', 'metadata_busy',
  'metadata_unconfirmed', 'metadata_write_unsupported', 'metadata_not_owner', 'metadata_not_applied']);

export function socketPath(storagePath) {
  const normal = join(resolve(storagePath), 'control.sock');
  if (Buffer.byteLength(normal) <= 100) return normal;
  const short = join(resolve(storagePath), 'c.sock');
  if (Buffer.byteLength(short) <= 100) return short;
  throw Object.assign(new Error('rpc_start_failed'), { reason: 'rpc_start_failed' });
}

export function safeReason(error) {
  return REASONS.has(error?.reason)
    ? error.reason : 'operation_failed';
}

export async function startRpcServer(storagePath, handler) {
  await mkdir(storagePath, { recursive: true, mode: 0o700 });
  await chmod(storagePath, 0o700);
  const path = socketPath(storagePath);
  // The caller holds RuntimeManager's per-storage process lock before cleanup.
  try {
    const old = await lstat(path);
    if (!old.isSocket() || (process.getuid && old.uid !== process.getuid())) throw new Error('unsafe_socket');
    await unlink(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw Object.assign(new Error('rpc_start_failed'), { reason: 'rpc_start_failed' });
  }
  const clients = new Set();
  const server = net.createServer((socket) => {
    clients.add(socket);
    socket.setTimeout(125000, () => socket.destroy());
    socket.on('close', () => clients.delete(socket));
    socket.on('error', () => {});
    let text = '', bytes = 0, handled = false;
    const decoder = new StringDecoder('utf8');
    const reply = (message) => {
      if (socket.destroyed) return;
      const encoded = JSON.stringify(message);
      socket.end(encoded.length <= MAX_RESPONSE ? `${encoded}\n` : '{"ok":false,"reason":"response_too_large"}\n');
    };
    socket.on('data', async (chunk) => {
      if (handled) return;
      bytes += chunk.length;
      if (bytes > MAX_REQUEST) { handled = true; reply({ ok: false, reason: 'invalid_request' }); return; }
      text += decoder.write(chunk);
      if (!text.includes('\n')) return;
      handled = true;
      let request;
      try {
        request = JSON.parse(text.slice(0, text.indexOf('\n')));
        if (!request || !METHODS.has(request.method) || !request.payload || typeof request.payload !== 'object' || Array.isArray(request.payload)) throw new Error();
      } catch { reply({ ok: false, reason: 'invalid_request' }); return; }
      try { reply({ ok: true, result: await handler(request.method, request.payload) }); }
      catch (error) { reply({ ok: false, reason: safeReason(error) }); }
    });
  });
  await new Promise((accept, reject) => {
    server.once('error', reject);
    server.listen(path, accept);
  });
  await chmod(path, 0o600);
  return { close: async () => {
    for (const socket of clients) socket.destroy();
    await new Promise((accept) => server.close(accept));
    await unlink(path).catch(() => {});
  } };
}

export function createRpcClient(storagePath) {
  return { request(method, payload = {}) {
    if (!METHODS.has(method)) return Promise.reject(Object.assign(new Error('invalid_request'), { reason: 'invalid_request' }));
    return new Promise((accept, reject) => {
      const socket = net.createConnection(socketPath(storagePath));
      let buffer = '', bytes = 0, done = false;
      const decoder = new StringDecoder('utf8');
      const fail = (reason) => {
        if (done) return;
        done = true;
        socket.destroy();
        reject(Object.assign(new Error(reason), { reason }));
      };
      socket.setTimeout(120000, () => fail('operation_timeout'));
      socket.once('error', () => fail('plugin_not_running'));
      socket.once('connect', () => socket.write(`${JSON.stringify({ method, payload })}\n`));
      socket.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE) { fail('response_too_large'); return; }
        buffer += decoder.write(chunk);
        if (!buffer.includes('\n') || done) return;
        let response;
        try { response = JSON.parse(buffer.slice(0, buffer.indexOf('\n'))); }
        catch { fail('invalid_response'); return; }
        if (response.ok !== true) { fail(safeReason(response)); return; }
        done = true;
        socket.destroy();
        accept(response.result);
      });
      socket.on('end', () => { if (!done) fail('plugin_not_running'); });
    });
  } };
}
