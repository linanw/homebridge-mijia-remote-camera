import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { HomebridgePluginUiServer, RequestError } from '@homebridge/plugin-ui-utils';
import { RuntimeSetupJob } from '../lib/setup-job.mjs';

const SAFE_REASONS = new Set(['plugin_not_running', 'invalid_request', 'unauthenticated', 'auth_required',
  'home_request_failed', 'home_request_rejected', 'session_expired', 'invalid_home_selection',
  'invalid_selection', 'selection_missing', 'not_ready', 'backend_unavailable', 'invalid_region',
  'unsafe_url', 'network_error', 'request_timeout', 'unexpected_response', 'login_expired',
  'login_cancelled', 'login_not_approved', 'incomplete_session', 'credentials_write_failed',
  'runtime_unavailable', 'unknown_login', 'probe_failed', 'unsupported_protocol', 'offline',
  'operation_failed', 'runtime_locked', 'authentication_required', 'camera_offline', 'camera_not_in_home',
  'unsupported_transport', 'no_video', 'connect_timeout', 'backend_failed', 'storage_failed',
  'runtime_in_use', 'query_timeout', 'unsupported_platform', 'bundled_runtime_missing', 'not_selected', 'auth_in_progress',
  'runtime_components_missing', 'runtime_components_invalid', 'night_vision_unsupported', 'night_vision_unavailable',
  'metadata_unavailable', 'metadata_incomplete', 'metadata_conflict', 'metadata_busy', 'metadata_read_only',
  'metadata_rejected', 'metadata_unconfirmed', 'metadata_not_applied',
  'metadata_write_unsupported', 'metadata_not_owner',
  'night_vision_rejected', 'night_vision_not_applied', 'night_vision_timeout',
  'ptz_unsupported', 'ptz_unavailable', 'ptz_rejected', 'ptz_timeout', 'ptz_busy',
  'matter_disabled', 'matter_not_ready', 'matter_start_failed', 'matter_port_in_use', 'matter_configuration_invalid',
  'matter_pairing_unavailable', 'matter_window_failed', 'matter_closed']);

function failureReason(error) {
  if (['ENOENT', 'ECONNREFUSED'].includes(error?.code)) return 'plugin_not_running';
  if (error?.code === 'ETIMEDOUT') return 'request_timeout';
  if (SAFE_REASONS.has(error?.reason)) return error.reason;
  if (SAFE_REASONS.has(error?.message)) return error.message;
  return 'operation_failed';
}

function id(value) {
  if (typeof value !== 'string' || !/^[0-9]{1,30}$/.test(value)) throw new Error('invalid_request');
  return value;
}
function label(value, fallback) {
  return typeof value === 'string' && value.trim() && value.length <= 128 && !/[\x00-\x1f\x7f]/.test(value) ? value.trim() : fallback;
}
function loginId(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[a-z0-9-]{1,64}$/i.test(value)) throw new Error('invalid_request');
  return value;
}

function metadataGuard(payload, required = false) {
  const result = {};
  if (payload?.expectedRevision !== undefined) {
    if (!Number.isSafeInteger(payload.expectedRevision) || payload.expectedRevision < 0) throw new Error('invalid_request');
    result.expectedRevision = payload.expectedRevision;
  }
  if (payload?.expectedSourceEpoch !== undefined) {
    if (typeof payload.expectedSourceEpoch !== 'string' || !/^[a-f0-9-]{36}$/.test(payload.expectedSourceEpoch)) throw new Error('invalid_request');
    result.expectedSourceEpoch = payload.expectedSourceEpoch;
  }
  if (payload?.expectedIdentity !== undefined) {
    if (typeof payload.expectedIdentity !== 'string' || !/^[a-f0-9]{64}$/.test(payload.expectedIdentity)) throw new Error('invalid_request');
    result.expectedIdentity = payload.expectedIdentity;
  }
  if (required && ['expectedIdentity', 'expectedSourceEpoch', 'expectedRevision'].some(key => result[key] === undefined)) throw new Error('invalid_request');
  return result;
}

/** Pure proxy: the active Homebridge plugin owns all auth jobs and Java processes. */
export function createUiHandlers(runtime) {
  const routes = {
    '/auth/start': payload => {
      const region = payload?.region ?? 'cn';
      if (!['cn', 'de', 'us', 'ru', 'sg', 'i2'].includes(region)) throw new Error('invalid_region');
      return runtime.request('auth.start', { region });
    },
    '/auth/status': payload => runtime.request('auth.status', { loginId: loginId(payload?.loginId) }),
    '/auth/cancel': payload => runtime.request('auth.cancel', { loginId: loginId(payload?.loginId) }),
    '/homes': () => runtime.request('homes', {}),
    '/devices': payload => runtime.request('devices', { homeId: id(payload?.homeId), homeOwner: id(payload?.homeOwner) }),
    '/select': payload => runtime.request('select', { homeId: id(payload?.homeId), homeOwner: id(payload?.homeOwner),
      deviceId: id(payload?.deviceId), name: label(payload?.name, '米家摄像头'), model: label(payload?.model, 'Xiaomi Camera'),
      region: ['cn', 'de', 'us', 'ru', 'sg', 'i2'].includes(payload?.region) ? payload.region : 'cn' }),
    '/status': () => runtime.request('status', {}),
    '/metadata/status': () => runtime.request('metadata.status', {}),
    '/metadata/refresh': payload => runtime.request('metadata.refresh', metadataGuard(payload)),
    '/metadata/sync': payload => {
      if (typeof payload?.enabled !== 'boolean') throw new Error('invalid_request');
      return runtime.request('metadata.sync', { ...metadataGuard(payload), enabled: payload.enabled });
    },
    '/metadata/update': payload => {
      const guard = metadataGuard(payload, true);
      if (payload?.operation === 'rename') {
        if (typeof payload.name !== 'string' || !payload.name.length || payload.name.length > 160
          || !payload.name.isWellFormed() || payload.name.trim() !== payload.name || /[\p{Cc}]/u.test(payload.name)) throw new Error('invalid_request');
        return runtime.request('metadata.update', { ...guard, operation: 'rename', name: payload.name });
      }
      if (payload?.operation === 'move') {
        return runtime.request('metadata.update', { ...guard, operation: 'move', roomId: id(payload.roomId) });
      }
      throw new Error('invalid_request');
    },
    '/matter/pairing': () => runtime.request('matter.pairing', {}),
    '/matter/open-window': () => runtime.request('matter.openWindow', {}),
    '/matter/close-window': () => runtime.request('matter.closeWindow', {}),
    '/night/get': () => runtime.request('night.get', {}),
    '/night/set': payload => {
      if (!['auto', 'on', 'off'].includes(payload?.mode)) throw new Error('invalid_request');
      return runtime.request('night.set', { mode: payload.mode });
    },
    '/ptz/capabilities': () => runtime.request('ptz.capabilities', {}),
    '/ptz/move': payload => {
      if (!['up', 'down', 'left', 'right'].includes(payload?.direction)) throw new Error('invalid_request');
      return runtime.request('ptz.move', { direction: payload.direction });
    },
    '/resume': () => runtime.request('resume', {}),
  };
  return Object.fromEntries(Object.entries(routes).map(([path, handle]) => [path, async payload => {
    try { return await handle(payload); }
    catch (error) { throw new RequestError('request_failed', { reason: failureReason(error) }); }
  }]));
}

export async function runUiServer() {
  const { createRpcClient } = await import('../lib/rpc.mjs');
  const { resolveRuntimeAssets } = await import('../lib/runtime-assets.mjs');
  class MijiaPluginUiServer extends HomebridgePluginUiServer {
    constructor() {
      super();
      const storagePath = this.homebridgeStoragePath;
      if (!storagePath) throw new Error('plugin_not_running');
      const setup = new RuntimeSetupJob({ homebridgeStoragePath: storagePath });
      this.onRequest('/components/import', payload => setup.start(payload));
      this.onRequest('/components/import-status', () => setup.safeStatus());
      const client = createRpcClient(join(storagePath, 'mijia-remote-camera'));
      for (const [path, handler] of Object.entries(createUiHandlers(client))) this.onRequest(path, handler);
      this.onRequest('/components', async () => {
        try {
          await resolveRuntimeAssets({ storagePath: join(storagePath, 'mijia-remote-camera') });
          return { ready: true };
        } catch (error) { return { ready: false, reason: failureReason(error) }; }
      });
      this.ready();
    }
  }
  return new MijiaPluginUiServer();
}

let entrypoint = false;
try { entrypoint = Boolean(process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])); } catch {}
if (entrypoint) {
  runUiServer().catch(() => { process.stderr.write('Mijia plugin UI could not start.\n'); process.exitCode = 1; });
}
