import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { CookieJar } from 'tough-cookie';

const MAX_BODY = 1024 * 1024;
const REGIONS = new Set(['cn', 'de', 'us', 'ru', 'sg', 'i2']);
const REASONS = new Set(['invalid_region', 'unsafe_url', 'network_error', 'request_timeout',
  'unexpected_response', 'login_expired', 'login_cancelled', 'login_not_approved',
  'incomplete_session', 'credentials_write_failed', 'runtime_unavailable', 'unknown_login']);

export class AuthError extends Error {
  constructor(reason) {
    const safe = REASONS.has(reason) ? reason : 'unexpected_response';
    super(safe);
    this.name = 'AuthError';
    this.reason = safe;
  }
}

export function officialUrl(value) {
  try {
    if (typeof value !== 'string' || !value || /[\x00-\x20\x7f\\]/.test(value)) throw new Error();
    const url = new URL(value);
    const host = url.hostname;
    const official = host === 'mi.com' || host.endsWith('.mi.com') || host === 'xiaomi.com' || host.endsWith('.xiaomi.com');
    if (url.protocol !== 'https:' || !official || url.username || url.password || url.hash
      || (url.port && url.port !== '443') || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(host)) throw new Error();
    return url.href;
  } catch { throw new AuthError('unsafe_url'); }
}

function serviceUrl(value) {
  const validated = officialUrl(value);
  const url = new URL(validated);
  const services = url.searchParams.getAll('sid');
  if (url.hostname !== 'sts.api.io.mi.com' || url.pathname !== '/sts'
    || (services.length && (services.length !== 1 || services[0] !== 'xiaomiio'))) throw new AuthError('unsafe_url');
  return validated;
}

const cleanString = value => typeof value === 'string' && value.length > 0 && value.trim() === value && !/[\x00-\x20\x7f]/.test(value);
const numeric = value => typeof value === 'string' && /^[0-9]{1,30}$/.test(value);
const delay = (milliseconds, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(new AuthError('login_cancelled')); return; }
  const timer = setTimeout(done, milliseconds);
  function done() { signal?.removeEventListener('abort', abort); resolve(); }
  function abort() { clearTimeout(timer); reject(new AuthError('login_cancelled')); }
  signal?.addEventListener('abort', abort, { once: true });
});

async function responseBody(response) {
  let body = '';
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) { await reader.cancel(); throw new AuthError('unexpected_response'); }
      chunks.push(value);
    }
    body = Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8');
  } else {
    body = await response.text();
    if (Buffer.byteLength(body) > MAX_BODY) throw new AuthError('unexpected_response');
  }
  return body;
}

function jsonReply(response) {
  if (response.status !== 200) throw new AuthError('unexpected_response');
  try {
    let text = response.body.trimStart();
    if (text.startsWith('&&&START&&&')) text = text.slice(11);
    const result = JSON.parse(text);
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error();
    return result;
  } catch { throw new AuthError('unexpected_response'); }
}

class Session {
  constructor(manager, job) { this.manager = manager; this.job = job; this.jar = new CookieJar(); }
  async get(value, timeoutMs = 20_000) {
    let current = officialUrl(value);
    for (let redirect = 0; redirect <= 8; redirect++) {
      this.manager.assertCurrent(this.job);
      const remaining = this.job.deadline ? this.job.deadline - this.manager.clock() : timeoutMs;
      if (remaining <= 0) throw new AuthError('login_expired');
      const controller = new AbortController();
      let timedOut = false;
      const abort = () => controller.abort();
      this.job.controller.signal.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, Math.min(timeoutMs, remaining));
      timer.unref?.();
      let response;
      let body;
      try {
        const cookie = await this.jar.getCookieString(current);
        const headers = { Accept: 'application/json, text/plain, */*', 'Content-Type': 'application/x-www-form-urlencoded' };
        if (cookie) headers.Cookie = cookie;
        response = await this.manager.fetchImpl(current, { method: 'GET', headers, redirect: 'manual', signal: controller.signal });
        body = await responseBody(response);
        this.manager.assertCurrent(this.job);
      } catch (error) {
        if (error instanceof AuthError) throw error;
        if (this.job.controller.signal.aborted) throw new AuthError('login_cancelled');
        throw new AuthError(timedOut ? 'request_timeout' : 'network_error');
      } finally {
        clearTimeout(timer);
        this.job.controller.signal.removeEventListener('abort', abort);
      }
      for (const cookie of response.headers.getSetCookie?.() ?? []) {
        await this.jar.setCookie(cookie, current, { ignoreError: true });
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location || redirect === 8) throw new AuthError('unexpected_response');
        current = officialUrl(new URL(location, current).href);
        continue;
      }
      return { status: response.status, body };
    }
    throw new AuthError('unexpected_response');
  }
  async clearServiceTokens() {
    const data = await this.jar.serialize();
    data.cookies = data.cookies.filter(cookie => cookie.key !== 'serviceToken');
    this.jar = await CookieJar.deserialize(data);
  }
}

async function oldDeviceId(path) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BODY) return null;
    const old = JSON.parse(await readFile(path, 'utf8'));
    return cleanString(old.deviceId) ? old.deviceId : null;
  } catch { return null; }
}

async function writeCredentials(path, value, assertCurrent) {
  const directory = dirname(path);
  const temporary = join(directory, `.credentials-${randomUUID()}.tmp`);
  let handle;
  let committed = false;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const parent = await lstat(directory);
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error();
    await chmod(directory, 0o700);
    try { if ((await lstat(path)).isSymbolicLink()) throw new AuthError('credentials_write_failed'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(value, null, 2) + '\n', 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    assertCurrent();
    await rename(temporary, path);
    committed = true;
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw new AuthError('credentials_write_failed');
  } finally {
    if (handle) await handle.close().catch(() => {});
    if (!committed) await unlink(temporary).catch(() => {});
  }
}

/** Fresh browser-approved Xiaomiio session, owned by the plugin runtime process. */
export class BrowserLoginManager {
  constructor({ storagePath, fetchImpl = globalThis.fetch, clock = Date.now, sleep = delay, beforeCommit } = {}) {
    if (typeof storagePath !== 'string' || !storagePath) throw new TypeError('storagePath is required');
    this.storagePath = storagePath;
    this.credentialsPath = join(storagePath, '.micam', 'credentials.json');
    this.fetchImpl = fetchImpl;
    this.clock = clock;
    this.sleep = sleep;
    this.beforeCommit = beforeCommit;
    this.job = null;
  }
  assertCurrent(job) {
    if (this.job !== job || job.controller.signal.aborted) throw new AuthError('login_cancelled');
    if (job.deadline && this.clock() >= job.deadline) throw new AuthError('login_expired');
  }
  async start({ region = 'cn' } = {}) {
    if (!REGIONS.has(region)) throw new AuthError('invalid_region');
    await this.cancel();
    const job = { id: randomUUID(), state: 'starting', reason: null, region, controller: new AbortController(), deadline: null, done: null };
    this.job = job;
    const session = new Session(this, job);
    try {
      const params = new URLSearchParams({ _qrsize: '480', qs: '%3Fsid%3Dxiaomiio%26_json%3Dtrue',
        callback: 'https://sts.api.io.mi.com/sts', _hasLogo: 'false', sid: 'xiaomiio', serviceParam: '',
        _locale: 'en_GB', _dc: String(this.clock()) });
      const offer = jsonReply(await session.get(`https://account.xiaomi.com/longPolling/loginUrl?${params}`));
      const loginUrl = officialUrl(offer.loginUrl);
      const pollingUrl = officialUrl(offer.lp);
      if (offer.qr != null) officialUrl(offer.qr);
      const timeout = Number(offer.timeout);
      if (typeof offer.timeout === 'boolean' || !Number.isFinite(timeout) || timeout <= 0) throw new AuthError('unexpected_response');
      this.assertCurrent(job);
      job.deadline = this.clock() + Math.min(timeout * 1000, 180_000);
      job.state = 'waiting';
      job.done = this.finish(job, session, pollingUrl).catch(error => {
        if (this.job !== job) return;
        job.state = error instanceof AuthError && error.reason === 'login_cancelled' ? 'cancelled' : 'error';
        job.reason = error instanceof AuthError ? error.reason : 'unexpected_response';
      });
      return { loginId: job.id, loginUrl, expiresIn: Math.ceil((job.deadline - this.clock()) / 1000) };
    } catch (error) {
      job.state = 'error';
      job.reason = error instanceof AuthError ? error.reason : 'unexpected_response';
      throw new AuthError(job.reason);
    }
  }
  async finish(job, session, pollingUrl) {
    let approved;
    while (true) {
      this.assertCurrent(job);
      let response;
      try { response = await session.get(pollingUrl, 10_000); }
      catch (error) {
        if (!(error instanceof AuthError) || error.reason !== 'request_timeout') throw error;
        await this.sleep(Math.min(200, Math.max(0, job.deadline - this.clock())), job.controller.signal);
        continue;
      }
      this.assertCurrent(job);
      if ([204, 408, 504].includes(response.status)) {
        await this.sleep(Math.min(500, Math.max(0, job.deadline - this.clock())), job.controller.signal);
        continue;
      }
      approved = jsonReply(response);
      if (approved.code != null && approved.code !== 0) throw new AuthError('login_not_approved');
      break;
    }
    const uid = Number.isSafeInteger(approved.userId) ? String(approved.userId) : approved.userId;
    if (!numeric(uid) || !cleanString(approved.ssecurity)) throw new AuthError('incomplete_session');
    const location = serviceUrl(approved.location);
    await session.clearServiceTokens();
    const finished = await session.get(location);
    if (finished.status !== 200) throw new AuthError('incomplete_session');
    const cookies = await session.jar.getCookies(location);
    const serviceToken = cookies.find(cookie => cookie.key === 'serviceToken')?.value;
    if (!cleanString(serviceToken)) throw new AuthError('incomplete_session');
    const credentials = { user: uid, userId: uid, ssecurity: approved.ssecurity,
      serviceToken, region: job.region, deviceId: await oldDeviceId(this.credentialsPath) ?? randomBytes(8).toString('hex') };
    if (cleanString(approved.passToken)) credentials.passToken = approved.passToken;
    this.assertCurrent(job);
    if (this.beforeCommit) {
      try { await this.beforeCommit(); } catch { throw new AuthError('runtime_unavailable'); }
    }
    this.assertCurrent(job);
    await writeCredentials(this.credentialsPath, credentials, () => this.assertCurrent(job));
    job.state = 'complete';
    job.reason = null;
  }
  status(loginId) {
    const job = this.job;
    if (!job) return { state: 'idle', success: false, remainingSeconds: 0 };
    if (loginId && loginId !== job.id) return { state: 'error', reason: 'unknown_login', success: false, remainingSeconds: 0 };
    const result = { loginId: job.id, state: job.state, success: job.state === 'complete',
      remainingSeconds: job.state === 'waiting' ? Math.max(0, Math.ceil((job.deadline - this.clock()) / 1000)) : 0 };
    if (job.reason) result.reason = job.reason;
    return result;
  }
  async cancel(loginId) {
    const job = this.job;
    if (!job || (loginId && job.id !== loginId)) return this.status(loginId);
    if (job.state === 'starting' || job.state === 'waiting') {
      job.controller.abort();
      job.state = 'cancelled';
      job.reason = 'login_cancelled';
      await job.done;
    }
    return this.status(loginId);
  }
}
