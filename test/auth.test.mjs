import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, stat, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AuthError, BrowserLoginManager } from '../lib/auth.mjs';
import { createUiHandlers } from '../homebridge-ui/server.js';

const LOGIN = 'https://account.xiaomi.com/longPolling/login?ticket=PRIVATE_LOGIN';
const POLL = 'https://account.xiaomi.com/longPolling/listen?ticket=PRIVATE_POLL';
const STS = 'https://sts.api.io.mi.com/sts?ticket=PRIVATE_STS';
const OFFER = { loginUrl: LOGIN, lp: POLL, timeout: 30, qr: 'https://account.xiaomi.com/qr?ticket=PRIVATE_QR' };
const APPROVED = { code: 0, userId: '123456789', ssecurity: 'PRIVATE_SECURITY', passToken: 'PRIVATE_PASS', location: STS };

function response(data = {}, status = 200, cookies = [], extraHeaders = {}) {
  const headers = new Headers(extraHeaders);
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  return new Response([204, 304].includes(status) ? null : '&&&START&&&' + JSON.stringify(data), { status, headers });
}
function success(offer = OFFER, approved = APPROVED) {
  return [response(offer, 200, ['offer=ONE; Path=/; Secure']), response(approved),
    response({}, 200, ['serviceToken=PRIVATE_SERVICE; Domain=.sts.api.io.mi.com; Path=/; Secure'])];
}
async function fixture(t, actions = []) {
  const directory = await mkdtemp(join(tmpdir(), 'mijia-auth-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, '.micam', 'credentials.json');
  await mkdir(join(directory, '.micam'));
  const old = '{"user":"111","deviceId":"stableDevice","passToken":"OLD_PRIVATE"}';
  await writeFile(path, old);
  const requests = [];
  let now = 0;
  const transport = async (url, options) => {
    requests.push({ url, options });
    assert(actions.length, 'Tests must never access a real network');
    const action = actions.shift();
    if (typeof action === 'function') return action(url, options);
    if (action instanceof Error) throw action;
    return action;
  };
  const manager = new BrowserLoginManager({ storagePath: directory, fetchImpl: transport,
    clock: () => now, sleep: async milliseconds => { now += milliseconds; } });
  t.after(() => manager.cancel());
  return { directory, path, old, manager, requests, actions, advance: milliseconds => { now += milliseconds; } };
}

test('browser approval saves a complete paired session privately, preserving stable device identity', async t => {
  const { path, directory, manager, requests } = await fixture(t, success());
  let paused = false;
  manager.beforeCommit = async () => { paused = true; };
  const offer = await manager.start({ region: 'sg' });
  assert.equal(offer.loginUrl, LOGIN);
  assert.equal(offer.expiresIn, 30);
  await manager.job.done;
  assert.equal(manager.status().state, 'complete');
  assert.equal(paused, true);
  const stored = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(stored, { user: '123456789', userId: '123456789', ssecurity: 'PRIVATE_SECURITY',
    serviceToken: 'PRIVATE_SERVICE', region: 'sg', deviceId: 'stableDevice', passToken: 'PRIVATE_PASS' });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(join(directory, '.micam'))).mode & 0o777, 0o700);
  assert.equal(requests.length, 3);
  assert.match(requests[1].options.headers.Cookie, /offer=ONE/);
  assert.equal(requests[2].options.headers.Cookie, undefined);
  assert.doesNotMatch(JSON.stringify(manager.status()), /PRIVATE|123456789|https:/);
});

test('malformed prior credentials are preserved on failure and replaced only on complete success', async t => {
  const { path, manager, actions } = await fixture(t, [new Error('PRIVATE_SERVER_URL')]);
  await writeFile(path, '{broken OLD_PRIVATE');
  await assert.rejects(manager.start(), error => error instanceof AuthError && error.reason === 'network_error');
  assert.equal(await readFile(path, 'utf8'), '{broken OLD_PRIVATE');
  actions.push(...success());
  await manager.start();
  await manager.job.done;
  assert.equal(manager.status().success, true);
  assert(JSON.parse(await readFile(path, 'utf8')).deviceId);
});

test('cancellation aborts a pending request and preserves previous credentials', async t => {
  const pending = (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('PRIVATE_ABORT')), { once: true }));
  const { path, old, manager } = await fixture(t, [response(OFFER), pending]);
  await manager.start();
  await manager.cancel();
  assert.equal(manager.status().state, 'cancelled');
  assert.equal(await readFile(path, 'utf8'), old);
});

test('server expiry is capped at 180 seconds and pending polling cannot run indefinitely', async t => {
  const f = await fixture(t, [response({ ...OFFER, timeout: 999999 })]);
  for (let i = 0; i < 361; i++) f.actions.push(response({}, 204));
  const offer = await f.manager.start();
  assert.equal(offer.expiresIn, 180);
  await f.manager.job.done;
  assert.equal(f.manager.status().reason, 'login_expired');
  assert.equal(await readFile(f.path, 'utf8'), f.old);
  assert(f.requests.length <= 362);
});

test('malicious offered URLs are rejected without output or a second request', async t => {
  const bad = ['http://account.xiaomi.com/login', 'https://xiaomi.com.evil.test/login',
    'https://user@account.xiaomi.com/login', 'https://account.xiaomi.com:444/login',
    'https://account.xiaomi.com./login', 'https://account.xiaomi.com\\@evil.test/',
    'https://account.xiaomi.com/\nPRIVATE', '//account.xiaomi.com/login'];
  for (const field of ['loginUrl', 'lp', 'qr']) {
    for (const value of bad) {
      const f = await fixture(t, [response({ ...OFFER, [field]: value })]);
      await assert.rejects(f.manager.start(), error => error.reason === 'unsafe_url' && !error.message.includes('PRIVATE'));
      assert.equal(f.requests.length, 1);
      assert.equal(await readFile(f.path, 'utf8'), f.old);
    }
  }
});

test('account web callbacks and conflicting service callbacks cannot replace a Xiaomiio session', async t => {
  for (const location of ['https://account.xiaomi.com/pass/serviceLogin?sid=passport',
    'https://sts.api.io.mi.com/another-service', 'https://sts.api.io.mi.com/sts?sid=passport',
    'https://sts.api.io.mi.com/sts?sid=xiaomiio&sid=passport']) {
    const f = await fixture(t, success(OFFER, { ...APPROVED, location }));
    await f.manager.start();
    await f.manager.job.done;
    assert.equal(f.manager.status().reason, 'unsafe_url');
    assert.equal(f.requests.length, 2);
    assert.equal(await readFile(f.path, 'utf8'), f.old);
  }
});

test('an account-page cookie after redirect cannot substitute for the original STS cookie', async t => {
  const f = await fixture(t, [response(OFFER), response(APPROVED),
    response({}, 302, [], { location: 'https://account.xiaomi.com/finish' }),
    response({}, 200, ['serviceToken=PRIVATE_WEB; Path=/; Secure'])]);
  await f.manager.start();
  await f.manager.job.done;
  assert.equal(f.manager.status().reason, 'incomplete_session');
  assert.equal(await readFile(f.path, 'utf8'), f.old);
});

test('redirects never send credentials to an untrusted destination', async t => {
  const f = await fixture(t, [response(OFFER), response(APPROVED), response({}, 302, [], { location: 'https://evil.test/PRIVATE' })]);
  await f.manager.start();
  await f.manager.job.done;
  assert.equal(f.manager.status().reason, 'unsafe_url');
  assert.equal(f.requests.length, 3);
  assert.equal(await readFile(f.path, 'utf8'), f.old);
});

test('partial sessions, nonnumeric IDs, and missing service cookies preserve old credentials', async t => {
  const invalid = [{ ...APPROVED, ssecurity: '' }, { ...APPROVED, userId: 'email@example.test' },
    { ...APPROVED, userId: 9007199254740994 }];
  for (const approved of invalid) {
    const f = await fixture(t, success(OFFER, approved));
    await f.manager.start(); await f.manager.job.done;
    assert.equal(f.manager.status().reason, 'incomplete_session');
    assert.equal(await readFile(f.path, 'utf8'), f.old);
  }
  const f = await fixture(t, [response(OFFER), response(APPROVED), response()]);
  await f.manager.start(); await f.manager.job.done;
  assert.equal(f.manager.status().reason, 'incomplete_session');
  assert.equal(await readFile(f.path, 'utf8'), f.old);
});

test('omitted passToken never copies a stale token into the fresh cached session', async t => {
  const approved = { ...APPROVED }; delete approved.passToken;
  const f = await fixture(t, success(OFFER, approved));
  await f.manager.start(); await f.manager.job.done;
  assert.equal(f.manager.status().success, true);
  assert.equal(JSON.parse(await readFile(f.path, 'utf8')).passToken, undefined);
});

test('oversized and invalid responses are sanitized rather than logged or persisted', async t => {
  const f = await fixture(t, [new Response('PRIVATE'.repeat(180000))]);
  await assert.rejects(f.manager.start(), error => error.reason === 'unexpected_response' && !error.message.includes('PRIVATE'));
  assert.equal(await readFile(f.path, 'utf8'), f.old);
});

test('before-commit failure or cancellation preserves old file', async t => {
  const f = await fixture(t, success());
  f.manager.beforeCommit = async () => { throw new Error('PRIVATE_RUNTIME_ERROR'); };
  await f.manager.start(); await f.manager.job.done;
  assert.equal(f.manager.status().reason, 'runtime_unavailable');
  assert.equal(await readFile(f.path, 'utf8'), f.old);
});

test('symlink credentials are never followed for writes', async t => {
  const f = await fixture(t, success());
  await unlinkFixture(f.path);
  const destination = join(f.directory, 'elsewhere');
  await writeFile(destination, 'PRIVATE_DESTINATION');
  await symlink(destination, f.path);
  await f.manager.start(); await f.manager.job.done;
  assert.equal(f.manager.status().reason, 'credentials_write_failed');
  assert.equal(await readFile(destination, 'utf8'), 'PRIVATE_DESTINATION');
});
async function unlinkFixture(path) { await rm(path); }

test('UI proxy permits only known route fields and keeps raw backend errors private', async () => {
  const calls = [];
  const routes = createUiHandlers({ request: async (method, payload) => { calls.push({ method, payload }); return { ok: true }; } });
  await routes['/devices']({ homeId: '202', homeOwner: '11', storagePath: '/PRIVATE', javaPath: '/PRIVATE' });
  assert.deepEqual(calls, [{ method: 'devices', payload: { homeId: '202', homeOwner: '11' } }]);
  await assert.rejects(routes['/select']({ homeId: '202', homeOwner: '11', deviceId: 'PRIVATE' }), error => error.requestError.reason === 'invalid_request');
  assert.equal(calls.length, 1);
  const bad = createUiHandlers({ request: async () => { throw new Error('https://PRIVATE_TOKEN'); } });
  await assert.rejects(bad['/status'](), error => error.message === 'request_failed' && error.requestError.reason === 'operation_failed' && !JSON.stringify(error).includes('PRIVATE'));
});

test('UI translates an absent runtime into a bootstrap-safe error', async () => {
  const routes = createUiHandlers({ request: async () => { throw Object.assign(new Error('PRIVATE_PATH'), { code: 'ENOENT' }); } });
  await assert.rejects(routes['/status'](), error => error.requestError.reason === 'plugin_not_running');
});
