import { createHash, randomBytes as secureRandomBytes } from 'node:crypto';
import { Agent, request as httpsRequest } from 'node:https';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';

const REGIONS = new Set(['cn', 'ru', 'de', 'sg', 'us', 'i2']);
const MODELS = new Set(['chuangmi.camera.061a01', 'chuangmi.camera.061a03']);
const MODES = ['on', 'off', 'auto'];
const TTL = 24 * 60 * 60 * 1000;
const MAX_RESPONSE = 64 * 1024;
const REASONS = new Set(['invalid_request', 'authentication_required', 'session_expired',
  'night_vision_unsupported', 'night_vision_unavailable', 'night_vision_rejected',
  'night_vision_not_applied', 'night_vision_timeout', 'runtime_closed', 'query_cancelled']);

export class CloudControlError extends Error {
  constructor(reason) {
    const safe = REASONS.has(reason) ? reason : 'night_vision_unavailable';
    super(safe); this.name = 'CloudControlError'; this.reason = safe;
  }
}
const failure = reason => new CloudControlError(reason);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && /^[0-9]{1,30}$/.test(value);

async function readPrivateJson(file, maximum) {
  let handle, bytes;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maximum) return null;
    bytes = Buffer.alloc(maximum + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > maximum) return null;
    const value = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
    return object(value) ? value : null;
  } catch { return null; }
  finally { bytes?.fill(0); await handle?.close().catch(() => {}); }
}

function base64(value, maximum = 256, reason = 'authentication_required') {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 === 1) throw failure(reason);
  const decoded = Buffer.from(value, 'base64');
  if (!decoded.length || decoded.toString('base64').replace(/=+$/, '') !== value.replace(/=+$/, '')) {
    decoded.fill(0); throw failure(reason);
  }
  return decoded;
}

/** Standard RC4 KSA/PRGA with Xiaomi's required 1024-byte keystream discard. */
function rc4(key, input) {
  const state = new Uint8Array(256), output = Buffer.alloc(input.length);
  for (let i = 0; i < 256; i++) state[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + state[i] + key[i % key.length]) & 255;
    [state[i], state[j]] = [state[j], state[i]];
  }
  let i = 0; j = 0;
  try {
    for (let position = -1024; position < input.length; position++) {
      i = (i + 1) & 255; j = (j + state[i]) & 255;
      [state[i], state[j]] = [state[j], state[i]];
      if (position >= 0) output[position] = input[position] ^ state[(state[i] + state[j]) & 255];
    }
    return output;
  } finally { state.fill(0); }
}

function signature(apiPath, key, entries) {
  return createHash('sha1').update(['POST', apiPath, ...entries.map(([name, value]) => `${name}=${value}`), key].join('&')).digest('base64');
}

function makeForm(apiPath, payload, credentials, nonceBytes) {
  let security, key, plain, cipher;
  try {
    security = base64(credentials.ssecurity);
    key = createHash('sha256').update(security).update(nonceBytes).digest();
    const signed = key.toString('base64'), entries = [['data', JSON.stringify(payload)]];
    entries.push(['rc4_hash__', signature(apiPath, signed, entries)]);
    for (const entry of entries) {
      plain = Buffer.from(entry[1], 'utf8'); cipher = rc4(key, plain);
      entry[1] = cipher.toString('base64'); plain.fill(0); cipher.fill(0);
    }
    entries.push(['signature', signature(apiPath, signed, entries)], ['ssecurity', credentials.ssecurity], ['_nonce', nonceBytes.toString('base64')]);
    const body = Buffer.from(new URLSearchParams(entries).toString(), 'utf8');
    if (body.length > 16 * 1024) throw failure('invalid_request');
    return { body, key };
  } catch (error) { key?.fill(0); throw error; }
  finally { security?.fill(0); plain?.fill(0); cipher?.fill(0); }
}

function checkedReply(value) {
  if (!object(value)) throw failure('night_vision_unavailable');
  if (value.code === 3 || value.message === 'SERVICETOKEN_EXPIRED' || value.message === 'serviceToken expired')
    throw failure('session_expired');
  if (!Number.isSafeInteger(value.code) || value.code !== 0) throw failure('night_vision_rejected');
  return value;
}

function resultItem(reply, did) {
  const results = checkedReply(reply).result;
  if (!Array.isArray(results) || results.length > 1000) throw failure('night_vision_unavailable');
  const matched = results.filter(item => object(item) && item.did === did && item.siid === 2 && item.piid === 3);
  if (matched.length !== 1) throw failure('night_vision_unavailable');
  if (matched[0].code !== 0) throw failure('night_vision_rejected');
  return matched[0];
}

function postHttps({ url, headers, body, timeoutMs, signal }, agent) {
  return new Promise((resolve, reject) => {
    let settled = false, timer, request, response, total = 0;
    const chunks = [];
    const finish = (error, value) => {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', cancelled);
      for (const chunk of chunks) chunk.fill(0);
      error ? reject(error) : resolve(value);
    };
    const cancel = reason => {
      request?.destroy(); response?.destroy(); finish(failure(reason));
    };
    const cancelled = () => cancel('query_cancelled');
    try {
      if (signal?.aborted) { finish(failure('query_cancelled')); return; }
      request = httpsRequest(url, { method: 'POST', headers, agent }, received => {
        response = received;
        if (response.statusCode !== 200) { cancel('night_vision_rejected'); return; }
        if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
          cancel('night_vision_unavailable'); return;
        }
        response.on('data', chunk => {
          if (settled) { chunk.fill(0); return; }
          total += chunk.length;
          if (total > MAX_RESPONSE) { chunk.fill(0); cancel('night_vision_unavailable'); return; }
          chunks.push(chunk);
        });
        response.once('error', () => finish(failure('night_vision_unavailable')));
        response.once('end', () => finish(null, { statusCode: 200, body: Buffer.concat(chunks, total) }));
      });
      request.once('error', () => finish(failure('night_vision_unavailable')));
      signal?.addEventListener('abort', cancelled, { once: true });
      timer = setTimeout(() => cancel('night_vision_timeout'), timeoutMs);
      request.end(body);
    } catch { cancel('night_vision_unavailable'); }
  });
}

/** Narrow MIOT 2/3 control. Capability comes from an authoritative private device lookup cache. */
export class CloudControlClient {
  constructor({ storagePath, credentialsFile, capabilityFile, timeoutMs = 5500, readDatasource = 1,
    readJson = readPrivateJson, request, now = Date.now, randomBytes = secureRandomBytes } = {}) {
    const supplied = value => value === undefined || typeof value === 'string' && value.length > 0;
    if ((!storagePath && !credentialsFile) || ![storagePath, credentialsFile, capabilityFile].every(supplied)
      || ![0, 1].includes(readDatasource) || typeof readJson !== 'function' || typeof now !== 'function'
      || typeof randomBytes !== 'function' || request !== undefined && typeof request !== 'function') throw failure('invalid_request');
    this.credentialsFile = credentialsFile ?? path.join(storagePath, '.micam', 'credentials.json');
    this.capabilityFile = capabilityFile ?? path.join(path.dirname(this.credentialsFile), 'night-vision-capability.json');
    this.timeoutMs = Number.isFinite(timeoutMs) ? Math.max(100, Math.min(6000, timeoutMs)) : 5500;
    this.readDatasource = readDatasource; this.readJson = readJson; this.now = now; this.randomBytes = randomBytes;
    this.agent = request ? null : new Agent({ keepAlive: true, maxSockets: 2, maxFreeSockets: 1, timeout: 10000 });
    this.request = request ?? (options => postHttps(options, this.agent));
    this.closed = false;
  }

  async context(selection, region) {
    if (this.closed) throw failure('runtime_closed');
    if (!REGIONS.has(region) || !object(selection) || ![selection.homeId, selection.homeOwner, selection.deviceId].every(id))
      throw failure('invalid_request');
    if (!MODELS.has(selection.model)) throw failure('night_vision_unsupported');
    const [credentials, capability] = await Promise.all([
      this.readJson(this.credentialsFile, 16384), this.readJson(this.capabilityFile, 4096),
    ]);
    if (!object(credentials) || !id(credentials.userId) || typeof credentials.serviceToken !== 'string'
      || !/^[\x21-\x3A\x3C-\x7E]{1,4096}$/.test(credentials.serviceToken)
      || typeof credentials.deviceId !== 'string' || !/^[\x20-\x7E]{1,128}$/.test(credentials.deviceId))
      throw failure('authentication_required');
    const security = base64(credentials.ssecurity); security.fill(0);
    const now = this.now();
    if (!object(capability) || capability.version !== 2 || !Number.isSafeInteger(capability.verifiedAt)
      || capability.verifiedAt < 0 || capability.verifiedAt > now || now - capability.verifiedAt >= TTL
      || capability.account !== credentials.userId || capability.region !== region
      || capability.homeId !== selection.homeId || capability.owner !== selection.homeOwner
      || capability.did !== selection.deviceId || capability.model !== selection.model)
      throw Object.assign(failure('night_vision_unavailable'), { capabilityRequired: true });
    return { credentials, did: selection.deviceId, region };
  }

  async call(context, apiPath, payload, deadline, signal) {
    if (this.closed) throw failure('runtime_closed');
    if (signal?.aborted) throw failure('query_cancelled');
    const remaining = Math.min(this.timeoutMs, deadline - Date.now());
    if (remaining <= 0) throw failure('night_vision_timeout');
    let nonce, body, key, responseBytes, decoded;
    try {
      nonce = Buffer.alloc(12);
      const random = this.randomBytes(8); if (!Buffer.isBuffer(random) || random.length !== 8) throw failure('night_vision_unavailable');
      random.copy(nonce); random.fill(0); nonce.writeUInt32BE(Math.floor(this.now() / 60000) >>> 0, 8);
      ({ body, key } = makeForm(apiPath, payload, context.credentials, nonce));
      const host = context.region === 'cn' ? 'api.io.mi.com' : `${context.region}.api.io.mi.com`;
      const response = await this.request({ url: `https://${host}/app${apiPath}`, method: 'POST', body, timeoutMs: remaining,
        signal, maxResponseBytes: MAX_RESPONSE, headers: {
          'User-Agent': `Android-7.1.1-1.0.0-ONEPLUS A3010-136-${context.credentials.deviceId} APP/xiaomi.smarthome APPV/62830`,
          'x-xiaomi-protocal-flag-cli': 'PROTOCAL-HTTP2', 'Content-Type': 'application/x-www-form-urlencoded',
          'MIOT-ENCRYPT-ALGORITHM': 'ENCRYPT-RC4', 'Accept-Encoding': 'identity',
          Cookie: `userId=${context.credentials.userId}; serviceToken=${context.credentials.serviceToken}; yetAnotherServiceToken=${context.credentials.serviceToken}; locale=en_GB; timezone=GMT%2B03%3A00; is_daylight=0; dst_offset=0; channel=MI_APP_STORE`,
        } });
      if (response?.statusCode !== 200) throw failure('night_vision_rejected');
      if (!(typeof response.body === 'string' || Buffer.isBuffer(response.body))) throw failure('night_vision_unavailable');
      responseBytes = Buffer.isBuffer(response.body) ? response.body : Buffer.from(response.body, 'utf8');
      if (!responseBytes.length || responseBytes.length > MAX_RESPONSE) throw failure('night_vision_unavailable');
      let plain;
      try { plain = JSON.parse(responseBytes.toString('utf8')); } catch { }
      if (object(plain)) { checkedReply(plain); throw failure('night_vision_unavailable'); }
      const encrypted = base64(responseBytes.toString('utf8'), MAX_RESPONSE, 'night_vision_unavailable');
      try { decoded = rc4(key, encrypted); } finally { encrypted.fill(0); }
      return checkedReply(JSON.parse(decoded.toString('utf8')));
    } catch (error) {
      if (error instanceof CloudControlError) throw error;
      throw failure(signal?.aborted ? 'query_cancelled' : 'night_vision_unavailable');
    } finally { nonce?.fill(0); body?.fill(0); key?.fill(0); responseBytes?.fill(0); decoded?.fill(0); }
  }

  async perform(selection, region, mode, signal) {
    const deadline = Date.now() + this.timeoutMs;
    try {
      const context = await this.context(selection, region);
      if (mode !== undefined) {
        if (!MODES.includes(mode)) throw failure('invalid_request');
        resultItem(await this.call(context, '/miotspec/prop/set', { params: [{ did: context.did, siid: 2, piid: 3, value: MODES.indexOf(mode) }] }, deadline, signal), context.did);
      }
      const item = resultItem(await this.call(context, '/miotspec/prop/get', {
        datasource: mode === undefined ? this.readDatasource : 1,
        params: [{ did: context.did, siid: 2, piid: 3 }],
      }, deadline, signal), context.did);
      if (!Number.isSafeInteger(item.value) || !MODES[item.value]) throw failure('night_vision_unavailable');
      if (mode !== undefined && MODES[item.value] !== mode) throw failure('night_vision_not_applied');
      return { mode: MODES[item.value] };
    } catch (error) {
      if (error instanceof CloudControlError) throw error;
      throw failure(signal?.aborted ? 'query_cancelled' : 'night_vision_unavailable');
    }
  }
  getNightVision(selection, region, { signal } = {}) { return this.perform(selection, region, undefined, signal); }
  setNightVision(selection, region, mode, { signal } = {}) {
    if (!MODES.includes(mode)) return Promise.reject(failure('invalid_request'));
    return this.perform(selection, region, mode, signal);
  }
  close() { this.closed = true; this.agent?.destroy(); }
}
