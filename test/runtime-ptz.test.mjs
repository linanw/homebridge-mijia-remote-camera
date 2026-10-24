import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { RuntimeManager } from '../lib/runtime.mjs';

const selected = { homeId: '1', homeOwner: '2', deviceId: '3', model: 'chuangmi.camera.061a01', region: 'cn' };
const tick = () => new Promise(setImmediate);
async function fixture(t, overrides = {}) {
  const storage = await mkdtemp(join(tmpdir(), 'mijia-runtime-ptz-'));
  await mkdir(join(storage, '.micam')); await writeFile(join(storage, '.micam/credentials.json'), '{}');
  const calls = [], contexts = [];
  const runtime = new RuntimeManager({ storagePath: storage, javaPath: 'java', jarPath: 'vendor', bridgePath: 'bridge',
    spawn: () => { throw new Error('PTZ must reuse active session'); }, terminateProcess: async () => {},
    cloudControl: { context: async (...args) => { contexts.push(args); } },
    ptzSupported: model => model === selected.model,
    ptzRequest: async (_control, direction) => { calls.push(direction); return { accepted: true, direction, movement: 'step', private: 'PRIVATE_TOKEN' }; },
    ...overrides });
  t.after(async () => { await runtime.close(); await rm(storage, { recursive: true, force: true }); });
  await runtime.select(selected); runtime.ready = true; runtime.child = {}; runtime.ptzControl = { port: 32001, token: 'b'.repeat(64) };
  return { runtime, calls, contexts };
}
test('PTZ separates verified support from current session availability and returns no source details', async t => {
  const { runtime, calls, contexts } = await fixture(t);
  assert.deepEqual(await runtime.getPtzCapabilities(), { supported: true, available: true, directions: ['up', 'down', 'left', 'right'], relativeStep: true, zoom: false, absolutePosition: false });
  assert.deepEqual(await runtime.movePtz('left'), { accepted: true, direction: 'left', movement: 'step' });
  assert.equal(contexts[0][0].deviceId, selected.deviceId); assert.equal(contexts[0][1], 'cn');
  assert.deepEqual(calls, ['left']); assert.doesNotMatch(JSON.stringify(runtime.status()), /token|32001|PRIVATE/);
  runtime.ptzControl = null; assert.equal((await runtime.getPtzCapabilities()).available, false);
  await assert.rejects(runtime.movePtz('up'), { reason: 'ptz_unavailable' });
});
test('unknown models, unsupported directions and paused/closed runtime never issue commands', async t => {
  const { runtime, calls } = await fixture(t, { ptzSupported: () => false });
  await assert.rejects(runtime.movePtz('left'), { reason: 'ptz_unsupported' });
  for (const direction of ['stop', 1, 'left;PRIVATE', null, {}]) await assert.rejects(runtime.movePtz(direction), { reason: 'invalid_request' });
  await runtime.pause(); await assert.rejects(runtime.movePtz('left'), { reason: 'auth_in_progress' });
  await runtime.close(); await assert.rejects(runtime.movePtz('left'), { reason: 'runtime_closed' });
  assert.deepEqual(calls, []);
});
test('concurrent PTZ and immediate repeat commands are rejected instead of queued', async t => {
  let release;
  const { runtime } = await fixture(t, { ptzRequest: async (_control, direction) => new Promise(resolve => { release = () => resolve({ accepted: true, direction, movement: 'step' }); }) });
  const first = runtime.movePtz('left'); await tick();
  await assert.rejects(runtime.movePtz('right'), { reason: 'ptz_busy' }); release(); await first;
  await assert.rejects(runtime.movePtz('right'), { reason: 'ptz_busy' });
});
test('selection changes cancel active PTZ and reject a late acknowledgement from the old session', async t => {
  let release, signal;
  const { runtime } = await fixture(t, { ptzRequest: async (_control, direction, options) => { signal = options.signal; return new Promise(resolve => { release = () => resolve({ accepted: true, direction, movement: 'step' }); }); } });
  const first = runtime.movePtz('up'); const rejection = assert.rejects(first, { reason: 'query_cancelled' }); await tick();
  await runtime.select({ ...selected, deviceId: '4' }); assert.equal(signal.aborted, true); release(); await rejection;
});
test('PTZ deadline includes delayed private-cache verification and cannot send after timeout', async t => {
  let release;
  const { runtime, calls } = await fixture(t, { cloudControl: { context: () => new Promise(resolve => { release = resolve; }) } });
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  try {
    const pending = runtime.movePtz('down'); const rejection = assert.rejects(pending, { reason: 'ptz_timeout' });
    t.mock.timers.tick(3001); await rejection; release(); await Promise.resolve(); await Promise.resolve();
    assert.deepEqual(calls, []); assert.equal(runtime.ptzBusy, false);
  } finally { t.mock.timers.reset(); }
});
test('PTZ errors are fixed reasons and expired sessions retain existing refresh behavior', async t => {
  const { runtime } = await fixture(t, { ptzRequest: async () => { throw new Error('PRIVATE_TOKEN'); } });
  await assert.rejects(runtime.movePtz('left'), error => error.reason === 'ptz_unavailable' && !String(error).includes('PRIVATE'));
  runtime.lastPtzAt = null; runtime.cloudControl.context = async () => { throw Object.assign(new Error('PRIVATE'), { reason: 'night_vision_unavailable' }); };
  await assert.rejects(runtime.movePtz('right'), { reason: 'ptz_unavailable' });
  let renewed = 0; runtime._renewControlSession = () => { renewed++; };
  runtime.cloudControl.context = async () => { throw { reason: 'session_expired' }; };
  await assert.rejects(runtime.movePtz('right'), { reason: 'session_expired' }); assert.equal(renewed, 1);
});
test('control IPC accepts only bounded private descriptors and stop removes availability', async t => {
  const storage = await mkdtemp(join(tmpdir(), 'mijia-runtime-ptz-ipc-'));
  await mkdir(join(storage, '.micam')); await writeFile(join(storage, '.micam/credentials.json'), '{}');
  let child;
  const runtime = new RuntimeManager({ storagePath: storage, javaPath: 'java', jarPath: 'vendor', bridgePath: 'bridge',
    choosePort: async () => 32001, ptzSupported: () => true,
    spawn: () => {
      child = new EventEmitter(); child.stdout = new PassThrough(); child.json = value => child.stdout.write(JSON.stringify(value) + '\n');
      process.nextTick(() => child.json({ success: true, event: 'ready', port: 32001, videoReceived: true, codec: 'H264' }));
      return child;
    }, terminateProcess: async item => item?.emit('close', 0) });
  t.after(async () => { await runtime.close(); await rm(storage, { recursive: true, force: true }); });
  await runtime.select(selected); await runtime.start();
  for (const descriptor of [{ controlPort: 80, controlToken: 'a'.repeat(64) }, { controlPort: 32002, controlToken: 'PRIVATE_TOKEN' }]) {
    child.json({ success: true, event: 'control_ready', ...descriptor });
    assert.equal((await runtime.getPtzCapabilities()).available, false);
  }
  child.json({ success: true, event: 'control_ready', controlPort: 32002, controlToken: 'a'.repeat(64), url: 'https://PRIVATE_HOST' });
  assert.equal((await runtime.getPtzCapabilities()).available, true);
  assert.doesNotMatch(JSON.stringify(runtime.status()), /controlToken|controlPort|32002|PRIVATE_HOST|a{64}/);
  child.json({ success: true, event: 'control_unavailable' });
  assert.equal((await runtime.getPtzCapabilities()).available, false);
  child.json({ success: true, event: 'control_ready', controlPort: 32002, controlToken: 'a'.repeat(64) });
  await runtime.stop(); assert.equal((await runtime.getPtzCapabilities()).available, false);
});
