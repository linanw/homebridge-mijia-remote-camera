import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RuntimeManager } from '../lib/runtime.mjs';

const selected = { homeId: '202', homeOwner: '22', deviceId: '803', name: '异地摄像头', model: 'chuangmi.camera.061a01' };
const credentials = { user: '123', userId: '123', ssecurity: 'PRIVATE_SECURITY', serviceToken: 'PRIVATE_TOKEN', passToken: 'PRIVATE_PASS', region: 'cn' };
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function eventually(check) {
  for (let attempt = 0; attempt < 100; attempt++) { if (check()) return; await delay(5); }
  assert.fail('Condition did not settle');
}
class Child extends EventEmitter {
  constructor() { super(); this.stdout = new PassThrough(); this.pid = 987654; this.exitCode = null; this.signalCode = null; }
  json(value) { this.stdout.write(JSON.stringify(value) + '\n'); }
  exit(code = 0) { if (this.exitCode !== null) return; this.exitCode = code; this.emit('close', code); }
}
async function fixture(t, handler, extra = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mijia-runtime-test-'));
  await fs.mkdir(path.join(directory, '.micam'));
  await fs.writeFile(path.join(directory, '.micam/credentials.json'), JSON.stringify(credentials));
  const calls = [], terminated = [];
  const manager = new RuntimeManager({ storagePath: directory, javaPath: '/bundled/java', jarPath: '/bundled/micam.jar', bridgePath: '/bundled/bridge.jar',
    choosePort: async () => 32188, retryDelays: [15, 30, 60], connectTimeoutMs: 500,
    spawn: (command, args, options) => {
      const child = new Child(); calls.push({ command, args, options, child });
      process.nextTick(() => handler?.(child, args, calls.length)); return child;
    }, terminateProcess: async child => { if (child) { terminated.push(child); child.exit(0); } }, ...extra });
  t.after(async () => { await manager.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { manager, directory, calls, terminated };
}
function backendIndex(args) { return args.findIndex(value => ['mijia.bridge.Bridge', 'mijia.bridge.NightVisionControl'].includes(value)); }
function action(args) { return args[backendIndex(args) + 1]; }
function ready(child, args) { child.json({ success: true, event: 'ready', port: Number(args[args.indexOf('stream') + 5]), videoReceived: true, codec: 'H264' }); }

test('selected home and actual owner survive private atomic persistence and stream argv', async t => {
  const { manager, directory, calls } = await fixture(t, ready);
  let emitted;
  manager.on('selection', value => { emitted = value; });
  await manager.select(selected);
  assert.equal(emitted.deviceId, '803');
  assert.equal((await fs.stat(path.join(directory, 'selection.json'))).mode & 0o777, 0o600);
  assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
  assert.equal(await manager.start(), 'http://127.0.0.1:32188/cam.ts');
  assert.deepEqual(calls[0].args.slice(-8), ['stream', 'cn', '202', '22', '803', '32188', '1', '1']);
  assert.equal(calls[0].options.detached, true);
  assert.deepEqual(calls[0].options.stdio, ['ignore', 'pipe', 'ignore']);
  assert.equal(manager.status().ready, true);
  assert.equal(JSON.stringify(calls).includes('PRIVATE_TOKEN'), false);
});

test('no selection starts no child and reports a safe not_selected error', async t => {
  const { manager, calls } = await fixture(t);
  await assert.rejects(manager.start(), { reason: 'not_selected' });
  assert.equal(calls.length, 0);
});

test('invalid numeric IDs never reach the backend', async t => {
  const { manager, calls } = await fixture(t);
  await assert.rejects(manager.select({ ...selected, homeId: '202 --other=bad' }), { reason: 'invalid_request' });
  assert.equal(calls.length, 0);
  assert.equal(manager.selected(), null);
});

test('IDs above Number precision remain exact strings', async t => {
  const { manager, calls } = await fixture(t, ready);
  await manager.select({ ...selected, homeId: '9223372036854775808' });
  await manager.start();
  assert.equal(calls[0].args[calls[0].args.indexOf('stream') + 2], '9223372036854775808');
});

test('a second runtime cannot acquire live ownership of the same storage', async t => {
  const { manager, directory } = await fixture(t);
  await manager.open();
  const other = new RuntimeManager({ storagePath: directory, javaPath: 'java', jarPath: 'micam', bridgePath: 'bridge', spawn: () => { throw Error('Must not spawn'); } });
  t.after(() => other.close());
  await assert.rejects(other.open(), { reason: 'runtime_in_use' });
});

test('dead owner is reclaimed and shutdown releases only its own lock', async t => {
  const { manager, directory } = await fixture(t);
  await fs.writeFile(path.join(directory, 'runtime-owner.json'), JSON.stringify({ pid: 2147483647, token: 'dead', start: '1' }));
  await manager.open();
  assert.notEqual(JSON.parse(await fs.readFile(path.join(directory, 'runtime-owner.json'))).token, 'dead');
  await manager.close();
  await assert.rejects(fs.stat(path.join(directory, 'runtime-owner.json')), { code: 'ENOENT' });
});

test('queries return only their documented fields and preserve selected nondefault owner', async t => {
  const { manager, calls } = await fixture(t, (child, args) => {
    if (action(args) === 'homes') child.json({ success: true, homes: [{ id: '202', ownerId: '22', name: '家庭', shared: true, passToken: 'PRIVATE_PASS' }] });
    else child.json({ success: true, devices: [{ deviceId: '803', name: '摄像头', model: 'chuangmi.camera.061a01', online: true, serviceToken: 'PRIVATE_TOKEN' }] });
    child.exit();
  });
  assert.deepEqual(await manager.discoverHomes(), [{ id: '202', ownerId: '22', name: '家庭', shared: true }]);
  assert.deepEqual(await manager.discoverDevices('202', '22'), [{ deviceId: '803', name: '摄像头', model: 'chuangmi.camera.061a01', online: true }]);
  assert.deepEqual(calls[1].args.slice(-4), ['devices', 'cn', '202', '22']);
});

test('malformed raw discovery output never escapes into exceptions', async t => {
  const { manager } = await fixture(t, child => { child.stdout.write('PRIVATE_PASS=https://secret.example/'); child.exit(2); });
  await assert.rejects(manager.discoverHomes(), error => error.reason === 'invalid_backend_response' && !String(error).includes('PRIVATE'));
});

test('typed discovery failures retain safe reason/code and no body', async t => {
  const { manager } = await fixture(t, child => { child.json({ success: false, reason: 'home_request_rejected', code: -6, raw: 'PRIVATE_TOKEN' }); child.exit(7); });
  await assert.rejects(manager.discoverHomes(), error => error.reason === 'home_request_rejected' && error.code === -6 && !String(error).includes('PRIVATE'));
});

test('auth and unsupported transport block automatic reconnection', async t => {
  for (const [code, reason] of [[2, 'authentication_required'], [2, 'session_expired'], [1, 'unsupported_transport'],
    [3, 'session_expired'], [3, 'home_request_rejected'], [0, 'invalid_home_selection'],
    ...['home_request_rejected', 'invalid_home_selection', 'invalid_home_response', 'missing_home_owner',
      'invalid_device_response', 'device_pagination_incomplete', 'camera_not_in_home'].map(reason => [7, reason])]) {
    const { manager, calls } = await fixture(t, child => { child.json({ success: false, reason, vendor: 3 }); child.exit(code); });
    await manager.select(selected);
    await assert.rejects(manager.start(), { reason });
    assert.equal(manager.status().state, 'blocked');
    assert.equal(manager.status().vendor, 3);
    await delay(70); assert.equal(calls.length, 1);
    await manager.close();
  }
});

test('a failed stream device lookup retries even when separate home/device discovery succeeds', async t => {
  let streamAttempts = 0, nextPort = 32188;
  const { manager, calls, directory } = await fixture(t, (child, args) => {
    if (action(args) === 'homes') {
      child.json({ success: true, homes: [{ id: '202', ownerId: '22', name: '家庭', shared: true }] }); child.exit();
    } else if (action(args) === 'devices') {
      child.json({ success: true, devices: [{ ...selected, online: true }] }); child.exit();
    } else if (++streamAttempts === 1) {
      child.json({ success: false, reason: 'home_request_failed' }); child.exit(7);
    } else ready(child, args);
  }, { choosePort: async () => nextPort++, retryDelays: [120, 240, 480] });
  await manager.select(selected);
  const credentialsBefore = await fs.readFile(path.join(directory, '.micam/credentials.json'));
  const selectionBefore = await fs.readFile(path.join(directory, 'selection.json'));
  await assert.rejects(manager.start(), { reason: 'home_request_failed' });
  assert.equal(manager.status().state, 'retrying');
  const timer = manager.retryTimer, retryAt = manager.status().retryAt;
  assert.equal((await manager.discoverHomes()).length, 1);
  assert.equal((await manager.discoverDevices('202', '22'))[0].deviceId, selected.deviceId);
  assert.equal(manager.status().authenticated, true);
  assert.equal(manager.status().ready, false, 'successful lists are not proof of received video');
  assert.equal(manager.retryTimer, timer, 'discovery does not replace the scheduled stream retry');
  assert.equal(manager.status().retryAt, retryAt);
  assert.equal(await manager.ensureReady({ timeoutMs: 300 }), 'http://127.0.0.1:32189/cam.ts');
  assert.equal(streamAttempts, 2);
  assert.equal(calls.filter(call => action(call.args) === 'stream').length, 2);
  assert.equal(manager.status().videoReceived, true);
  assert.equal(manager.status().lastFailure, 'home_request_failed');
  assert.deepEqual(await fs.readFile(path.join(directory, '.micam/credentials.json')), credentialsBefore);
  assert.deepEqual(await fs.readFile(path.join(directory, 'selection.json')), selectionBefore);
});

test('stopping after a failed cloud lookup cancels its scheduled stream retry', async t => {
  const { manager, calls } = await fixture(t, child => {
    child.json({ success: false, reason: 'home_request_failed' }); child.exit(7);
  });
  await manager.select(selected);
  await assert.rejects(manager.start(), { reason: 'home_request_failed' });
  await manager.stop(); await delay(80);
  assert.equal(calls.length, 1);
  assert.equal(manager.retryTimer, null);
  assert.equal(manager.status().state, 'stopped');
});

test('explicit reconnect starts a stopped selected camera once and preserves a healthy stream', async t => {
  const { manager, calls, terminated } = await fixture(t, ready);
  await manager.select(selected);
  await Promise.all(Array.from({ length: 4 }, () => manager.resume()));
  await eventually(() => manager.ready);
  assert.equal(calls.length, 1, 'reconnect starts without HomeKit requesting a snapshot');
  await manager.resume();
  assert.equal(calls.length, 1);
  assert.equal(terminated.length, 0);
  assert.equal(manager.status().ready, true);
});

test('explicit reconnect without a selected camera does not start a backend process', async t => {
  const { manager, calls } = await fixture(t, ready);
  await manager.resume();
  assert.equal(calls.length, 0);
  assert.equal(manager.status().selected, false);
});

test('explicit reconnect neither duplicates an in-flight attempt nor shortens cloud-error backoff', async t => {
  const { manager, calls } = await fixture(t, null, { retryDelays: [120, 240, 480] });
  await manager.select(selected);
  const start = manager.start();
  const rejected = assert.rejects(start, { reason: 'home_request_failed' });
  await eventually(() => calls.length === 1);
  await manager.resume();
  assert.equal(calls.length, 1);
  calls[0].child.json({ success: false, reason: 'home_request_failed' }); calls[0].child.exit(7);
  await rejected;
  const timer = manager.retryTimer, retryAt = manager.status().retryAt;
  await manager.resume();
  assert.equal(manager.retryTimer, timer);
  assert.equal(manager.status().retryAt, retryAt);
  assert.equal(manager.status().state, 'retrying');
  assert.equal(calls.length, 1);
});

test('explicit reconnect releases an old blocked state without clearing account or camera selection', async t => {
  const { manager, calls, directory } = await fixture(t, (child, args, count) => {
    if (count === 1) { child.json({ success: false, reason: 'home_request_rejected' }); child.exit(7); }
    else ready(child, args);
  });
  await manager.select(selected);
  const before = await fs.readFile(path.join(directory, '.micam/credentials.json'));
  await assert.rejects(manager.start(), { reason: 'home_request_rejected' });
  assert.equal(manager.status().state, 'blocked');
  await manager.resume();
  await eventually(() => manager.ready);
  assert.equal(calls.length, 2);
  assert.equal(manager.selected().deviceId, selected.deviceId);
  assert.deepEqual(await fs.readFile(path.join(directory, '.micam/credentials.json')), before);
});

test('a reconnect waiting for storage cannot undo a later pause, stop or close', async t => {
  for (const operation of ['pause', 'stop', 'close']) {
    const { manager, calls } = await fixture(t, ready);
    await manager.select(selected);
    const originalOpen = manager.open.bind(manager);
    let release;
    manager.open = () => new Promise(resolve => { release = () => resolve(manager); });
    try {
      const reconnect = manager.resume();
      await manager[operation]();
      release(); await reconnect;
      assert.equal(calls.length, 0);
      assert.equal(manager.status().state, operation === 'pause' ? 'paused' : 'stopped');
      assert.equal(manager.status().paused, operation === 'pause');
      assert.equal(manager.closed, operation === 'close');
    } finally { manager.open = originalOpen; }
  }
});

test('transient connection failure retries with a fresh loopback endpoint', async t => {
  const { manager, calls } = await fixture(t, (child, args, count) => {
    if (count === 1) { child.json({ success: false, reason: 'connection_failed' }); child.exit(3); }
    else ready(child, args);
  });
  await manager.select(selected);
  await assert.rejects(manager.start(), { reason: 'connection_failed' });
  await eventually(() => manager.status().ready);
  assert.equal(calls.length, 2);
});

test('stop cancels delayed retries without modifying credential files', async t => {
  const { manager, directory, calls } = await fixture(t, child => { child.json({ success: false, reason: 'camera_offline' }); child.exit(4); });
  const before = await fs.readFile(path.join(directory, '.micam/credentials.json'));
  await manager.select(selected);
  await assert.rejects(manager.start(), { reason: 'camera_offline' });
  await manager.stop(); await delay(80);
  assert.equal(calls.length, 1);
  assert.deepEqual(await fs.readFile(path.join(directory, '.micam/credentials.json')), before);
});

test('changing selection stops the old process before starting the new home', async t => {
  const { manager, calls, terminated } = await fixture(t, ready);
  await manager.select(selected); await manager.start();
  await manager.select({ ...selected, homeId: '303', homeOwner: '33', deviceId: '804' });
  assert.equal(terminated[0], calls[0].child);
  assert.equal(manager.status().ready, false);
  await manager.start();
  assert.deepEqual(calls[1].args.slice(-6, -3), ['303', '33', '804']);
});

test('cold HomeKit requests fail fast while a single warm connection continues', async t => {
  const { manager, calls } = await fixture(t);
  await manager.select(selected);
  await assert.rejects(manager.ensureReady({ timeoutMs: 3 }), { reason: 'starting' });
  assert.equal(calls.length, 1);
  ready(calls[0].child, calls[0].args);
  assert.equal(await manager.ensureReady(), 'http://127.0.0.1:32188/cam.ts');
  assert.equal(calls.length, 1);
});

test('bridge ready event must bind to expected port, codec and received video', async t => {
  const { manager, calls } = await fixture(t);
  await manager.select(selected);
  const start = manager.start();
  await eventually(() => calls.length === 1);
  const child = calls[0].child;
  child.json({ success: true, event: 'ready', port: 1, codec: 'H264', videoReceived: true });
  assert.equal(manager.status().ready, false);
  child.json({ success: true, event: 'ready', port: 32188, codec: 'JPEG', videoReceived: true });
  assert.equal(manager.status().ready, false);
  ready(child, calls[0].args); await start;
  assert.equal(manager.status().ready, true);
});

test('new credentials and region update transport region without stale platform config', async t => {
  const { manager, directory, calls } = await fixture(t, ready);
  await manager.select(selected); await manager.start();
  await manager.setRegion('sg');
  await fs.writeFile(path.join(directory, '.micam/credentials.json'), JSON.stringify({ ...credentials, region: 'sg' }));
  await manager.credentialsChanged();
  await manager.start();
  assert.equal(calls[1].args[calls[1].args.indexOf('stream') + 1], 'sg');
  assert.equal(manager.status().region, 'sg');
  assert.equal(JSON.stringify(manager.status()).includes('PRIVATE'), false);
});

test('query startup timeout terminates helper with no raw exception', async t => {
  const { manager, calls, terminated } = await fixture(t, null, { queryTimeoutMs: 5000 });
  await manager.open();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const rejected = assert.rejects(manager.discoverHomes(), { reason: 'query_timeout' });
  await new Promise(setImmediate);
  assert.equal(calls.length, 1, 'the helper started before its deadline');
  t.mock.timers.tick(5000);
  await rejected;
  assert.equal(terminated.length, 1);
});

test('close makes subsequent runtime use fail without spawning a process', async t => {
  const { manager, calls } = await fixture(t);
  await manager.open(); await manager.close();
  await assert.rejects(manager.start(), { reason: 'runtime_closed' });
  assert.equal(calls.length, 0);
});

test('brief ready connections do not reset increasing retry backoff', async t => {
  const { manager } = await fixture(t, (child, args, count) => {
    if (count < 3) { child.json({ success: false, reason: 'connection_failed' }); child.exit(3); }
    else ready(child, args);
  });
  await manager.select(selected);
  await assert.rejects(manager.start(), { reason: 'connection_failed' });
  await eventually(() => manager.ready);
  assert.equal(manager.attempt, 2);
});

test('closing concurrently with initial open cannot leave a live owner file', async t => {
  const { manager, directory } = await fixture(t);
  const opening = manager.open();
  const closing = manager.close();
  await assert.rejects(opening, { reason: 'runtime_closed' });
  await closing;
  await assert.rejects(fs.stat(path.join(directory, 'runtime-owner.json')), { code: 'ENOENT' });
});

test('auth pause prevents HomeKit requests and queries from restarting Java', async t => {
  const { manager, calls } = await fixture(t, ready);
  await manager.select(selected); await manager.start();
  const pause = manager.pause();
  await assert.rejects(manager.ensureReady(), { reason: 'auth_in_progress' });
  await assert.rejects(manager.start(), { reason: 'auth_in_progress' });
  await assert.rejects(manager.discoverHomes(), { reason: 'auth_in_progress' });
  await pause;
  assert.equal(calls.length, 1);
  assert.equal(manager.status().paused, true);
  await manager.credentialsChanged();
  assert.equal(manager.status().paused, false);
  await manager.start();
  assert.equal(calls.length, 2);
});

test('queries queued before auth pause cannot execute after an active query is killed', async t => {
  const { manager, calls } = await fixture(t);
  const first = manager.discoverHomes().catch(error => error.reason);
  const second = manager.discoverHomes().catch(error => error.reason);
  await eventually(() => calls.length === 1);
  await manager.pause();
  await first;
  assert.equal(await second, 'auth_in_progress');
  assert.equal(calls.length, 1);
});

test('explicit committed selection clears auth pause only after stopping old work', async t => {
  const { manager } = await fixture(t, ready);
  await manager.pause();
  await manager.select(selected);
  assert.equal(manager.status().paused, false);
  assert.equal(await manager.start(), 'http://127.0.0.1:32188/cam.ts');
});

test('HomeKit readiness requests preserve the scheduled backoff and retain failure history', async t => {
  const { manager, calls } = await fixture(t, (child, args, count) => {
    if (count === 1) { child.json({ success: false, reason: 'connection_failed' }); child.exit(3); }
    else ready(child, args);
  }, { retryDelays: [120, 240, 480] });
  await manager.select(selected);
  await assert.rejects(manager.start(), { reason: 'connection_failed' });
  const failed = manager.status();
  const scheduledTimer = manager.retryTimer;
  assert.equal(failed.state, 'retrying');
  assert.equal(failed.attempt, 1);
  assert.equal(failed.lastFailure, 'connection_failed');
  assert.ok(Number.isFinite(Date.parse(failed.lastFailureAt)));
  assert.ok(Date.parse(failed.retryAt) > Date.now());
  assert.equal(failed.retryInSeconds, 1);
  assert.equal(failed.connectingSince, null);
  for (let request = 0; request < 3; request++) {
    await assert.rejects(manager.ensureReady({ timeoutMs: 2 }), { reason: 'starting' });
    assert.equal(calls.length, 1);
    assert.equal(manager.retryTimer, scheduledTimer);
    assert.equal(manager.status().retryAt, failed.retryAt);
    assert.equal(manager.listenerCount('status'), 0);
  }
  const source = await manager.ensureReady({ timeoutMs: 300 });
  assert.equal(source, 'http://127.0.0.1:32188/cam.ts');
  assert.equal(calls.length, 2);
  const connected = manager.status();
  assert.equal(connected.attempt, 2);
  assert.equal(connected.lastFailure, failed.lastFailure);
  assert.equal(connected.lastFailureAt, failed.lastFailureAt);
  assert.equal(connected.retryAt, null);
  assert.equal(connected.retryInSeconds, 0);
  assert.equal(connected.connectingSince, null);
  assert.equal(manager.listenerCount('status'), 0);
});

test('whitelisted progress is monotonic, safe and tied to the active generation', async t => {
  const { manager, calls } = await fixture(t);
  await manager.select(selected);
  const first = manager.start(); first.catch(() => {});
  await eventually(() => calls.length === 1);
  const child = calls[0].child;
  const starting = manager.status();
  assert.equal(starting.attempt, 1);
  assert.ok(Number.isFinite(Date.parse(starting.connectingSince)));
  assert.ok(Number.isInteger(starting.connectingElapsedSeconds) && starting.connectingElapsedSeconds >= 0);
  child.json({ success: true, event: 'progress', stage: 'device_lookup', token: 'PRIVATE_PROGRESS' });
  assert.equal(manager.status().stage, 'device_lookup');
  child.json({ success: true, event: 'progress', stage: 'provisioning', vendor: 4 });
  assert.equal(manager.status().vendor, 4);
  child.json({ success: true, event: 'progress', stage: 'PRIVATE_PROGRESS', vendor: 99 });
  assert.equal(manager.status().stage, 'provisioning');
  child.json({ success: true, event: 'progress', stage: 'authentication', vendor: 101 });
  child.json({ success: true, event: 'progress', stage: 'device_lookup', vendor: 98 });
  assert.equal(manager.status().stage, 'authentication');
  assert.equal(manager.status().vendor, 4);
  assert.equal(JSON.stringify(manager.status()).includes('PRIVATE_PROGRESS'), false);
  await manager.stop();
  await assert.rejects(first, { reason: 'stopped' });
  const next = manager.start(); next.catch(() => {});
  await eventually(() => calls.length === 2);
  child.json({ success: true, event: 'progress', stage: 'waiting_video', vendor: 99 });
  assert.equal(manager.status().stage, null);
  assert.equal(manager.status().vendor, undefined);
  calls[1].child.json({ success: true, event: 'progress', stage: 'waiting_video', vendor: 4 });
  ready(calls[1].child, calls[1].args);
  await next;
  calls[1].child.json({ success: true, event: 'progress', stage: 'waiting_video', vendor: 99 });
  assert.equal(manager.status().state, 'ready');
  assert.equal(manager.status().stage, null);
  assert.equal(manager.status().vendor, 4);
});

test('connection timeout records safe history and its retry still runs with HomeKit waiting', async t => {
  const { manager, calls, terminated } = await fixture(t, (child, args, count) => {
    if (count > 1) ready(child, args);
  }, { connectTimeoutMs: 50, retryDelays: [10, 20, 40] });
  await manager.select(selected);
  await assert.rejects(manager.start(), { reason: 'connect_timeout' });
  assert.equal(terminated.length, 1);
  assert.equal(manager.status().state, 'retrying');
  assert.equal(manager.status().lastFailure, 'connect_timeout');
  assert.equal(manager.status().attempt, 1);
  assert.ok(manager.status().retryAt);
  await manager.ensureReady({ timeoutMs: 100 });
  assert.equal(calls.length, 2);
  assert.equal(manager.status().ready, true);
  assert.equal(manager.status().attempt, 2);
  assert.equal(manager.status().lastFailure, 'connect_timeout');
});

test('stop and a new selection clear the previous camera failure and connection counters', async t => {
  const { manager } = await fixture(t, child => {
    child.json({ success: false, reason: 'unsupported_transport', vendor: 9 }); child.exit(1);
  });
  await manager.select(selected);
  await assert.rejects(manager.start(), { reason: 'unsupported_transport' });
  assert.equal(manager.status().lastFailure, 'unsupported_transport');
  assert.equal(manager.status().vendor, 9);
  await manager.select({ ...selected, deviceId: '804' });
  const clean = manager.status();
  assert.equal(clean.attempt, 0);
  assert.equal(clean.lastFailure, null);
  assert.equal(clean.lastFailureAt, null);
  assert.equal(clean.vendor, undefined);
  assert.equal(clean.stage, null);
  assert.equal(clean.connectingSince, null);
  assert.equal(clean.retryAt, null);
  assert.equal(clean.retryInSeconds, 0);
});

test('night vision commands use the dedicated helper, exact selected home owner and documented modes only', async t => {
  const { manager, calls } = await fixture(t, (child, args) => {
    const mode = action(args) === 'set' ? args.at(-1) : 'auto';
    child.json({ success: true, mode, did: 'PRIVATE_DEVICE', raw: 'PRIVATE_TOKEN' });
    child.exit();
  });
  await manager.select(selected);
  assert.deepEqual(await manager.getNightVision(), { mode: 'auto' });
  assert.deepEqual(await manager.setNightVision('off'), { mode: 'off' });
  assert.deepEqual(await manager.setNightVision('on'), { mode: 'on' });
  assert.deepEqual(await manager.setNightVision('auto'), { mode: 'auto' });
  assert.equal(calls[0].args[backendIndex(calls[0].args)], 'mijia.bridge.NightVisionControl');
  assert.deepEqual(calls[0].args.slice(-5), ['get', 'cn', '202', '22', '803']);
  assert.deepEqual(calls[1].args.slice(-6), ['set', 'cn', '202', '22', '803', 'off']);
  assert.ok(calls.every(call => !JSON.stringify(call.args).includes('PRIVATE')));
  assert.ok(!JSON.stringify(manager.status()).includes('PRIVATE'));
  await assert.rejects(manager.setNightVision('toggle'), { reason: 'invalid_request' });
  assert.equal(calls.length, 4);
});

test('night vision without selection does not start a helper', async t => {
  const { manager, calls } = await fixture(t);
  await assert.rejects(manager.getNightVision(), { reason: 'not_selected' });
  await assert.rejects(manager.setNightVision('off'), { reason: 'not_selected' });
  assert.equal(calls.length, 0);
});

test('night vision rejects malformed modes and retains only fixed safe backend reasons', async t => {
  const replies = [
    { success: true, mode: 'PRIVATE_TOKEN' },
    { success: false, reason: 'night_vision_rejected', raw: 'PRIVATE_TOKEN' },
    { success: false, reason: 'PRIVATE_TOKEN', raw: 'PRIVATE_TOKEN' },
  ];
  const { manager } = await fixture(t, child => {
    const reply = replies.shift(); child.json(reply); child.exit(reply.success ? 0 : 8);
  });
  await manager.select(selected);
  for (const reason of ['invalid_backend_response', 'night_vision_rejected', 'backend_failed']) {
    await assert.rejects(manager.getNightVision(), error => error.reason === reason && !String(error).includes('PRIVATE'));
  }
});

test('queued night vision work is cancelled when the selected home or region changes before it can run', async t => {
  for (const change of [{ deviceId: '804' }, { region: 'sg' }]) {
    const { manager, directory, calls } = await fixture(t);
    await manager.select({ ...selected, region: 'cn' });
    const discovery = manager.discoverHomes();
    await eventually(() => calls.length === 1);
    const night = manager.setNightVision('off');
    await fs.writeFile(path.join(directory, 'selection.json'), JSON.stringify({ ...selected, region: 'cn', ...change }));
    calls[0].child.json({ success: true, homes: [] }); calls[0].child.exit();
    await discovery;
    await assert.rejects(night, { reason: 'query_cancelled' });
    assert.equal(calls.length, 1);
  }
});

test('a night vision result for a selection that changed in flight is never returned as confirmed', async t => {
  const { manager, directory, calls } = await fixture(t);
  await manager.select(selected);
  const night = manager.getNightVision();
  await eventually(() => calls.length === 1);
  await fs.writeFile(path.join(directory, 'selection.json'), JSON.stringify({ ...selected, deviceId: '804' }));
  calls[0].child.json({ success: true, mode: 'auto' }); calls[0].child.exit();
  await assert.rejects(night, { reason: 'query_cancelled' });
});

test('night vision has a bounded deadline and cannot spawn after a delayed open resumes', async t => {
  const { manager, calls } = await fixture(t);
  await manager.select(selected);
  const originalOpen = manager.open.bind(manager);
  let release, entered = false;
  manager.open = async () => { entered = true; await new Promise(resolve => { release = resolve; }); return manager; };
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  try {
    const night = manager.setNightVision('off');
    const rejection = assert.rejects(night, { reason: 'query_timeout' });
    for (let tick = 0; tick < 10 && !entered; tick++) await Promise.resolve();
    assert.equal(entered, true);
    t.mock.timers.tick(6501);
    await rejection;
    release();
    await manager.queryChain;
    assert.equal(calls.length, 0);
  } finally { manager.open = originalOpen; t.mock.timers.reset(); }
});

test('an expired queued night vision write never executes after the earlier query completes', async t => {
  const { manager, calls } = await fixture(t);
  await manager.select(selected);
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  try {
    const discovery = manager.discoverHomes();
    for (let tick = 0; tick < 10 && !calls.length; tick++) await Promise.resolve();
    assert.equal(calls.length, 1);
    const night = manager.setNightVision('off');
    const rejection = assert.rejects(night, { reason: 'query_timeout' });
    t.mock.timers.tick(6501);
    await rejection;
    calls[0].child.json({ success: true, homes: [] }); calls[0].child.exit();
    await discovery; await manager.queryChain;
    assert.equal(calls.length, 1);
  } finally { t.mock.timers.reset(); }
});

test('timed-out helpers finish termination before the next credential-sharing query starts', async t => {
  let releaseTermination, terminating = false;
  const { manager, calls } = await fixture(t, (child, _args, count) => {
    if (count > 1) { child.json({ success: true, homes: [] }); child.exit(); }
  }, { queryTimeoutMs: 5, terminateProcess: async child => {
    if (!child) return;
    terminating = true;
    await new Promise(resolve => { releaseTermination = resolve; });
    child.exit();
  } });
  const first = manager.discoverHomes();
  const firstRejection = assert.rejects(first, { reason: 'query_timeout' });
  const second = manager.discoverHomes();
  await eventually(() => terminating);
  assert.equal(calls.length, 1);
  releaseTermination();
  await firstRejection;
  assert.deepEqual(await second, []);
  assert.equal(calls.length, 2);
});
