import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { configurePtz } from '../lib/ptz.mjs';

const require = createRequire(import.meta.url);
const hostRequire = createRequire(require.resolve('homebridge'));
let hap;
try { hap = hostRequire('@homebridge/hap-nodejs'); } catch { hap = hostRequire('hap-nodejs'); }

const directions = ['up', 'down', 'left', 'right'];
const selection = { deviceId: '30', homeId: '10', homeOwner: '20' };
const capabilities = { supported: true, available: true, relativeStep: true, directions };
const tick = () => new Promise(setImmediate);
async function fixture(t, overrides = {}) {
  const accessory = new hap.Accessory('PTZ test', hap.uuid.generate('ptz-test'));
  const calls = [], logs = [];
  const runtime = { getPtzCapabilities: async () => capabilities, selected: () => selection,
    movePtz: async direction => { calls.push(direction); return { accepted: true, direction }; }, ...overrides };
  const manager = await configurePtz({ api: { hap }, accessory, runtime, selection, log: { warn: x => logs.push(x) } });
  t.after(() => manager?.shutdown());
  const on = direction => accessory.getServiceById(hap.Service.Switch, `mijia-ptz-${direction}`)?.getCharacteristic(hap.Characteristic.On);
  return { accessory, calls, logs, manager, on, runtime };
}

test('Home app direction switches send one finite action and always return to off', async t => {
  const f = await fixture(t);
  assert.ok(f.manager);
  assert.equal(f.calls.length, 0);
  for (const direction of directions) {
    assert.equal(await f.on(direction).handleGetRequest(), false);
    await f.on(direction).handleSetRequest(true);
    await tick();
    assert.equal(f.on(direction).value, false);
    await f.on(direction).handleSetRequest(false);
  }
  assert.deepEqual(f.calls, directions);
  f.manager.shutdown();
  await assert.rejects(f.on('left').handleSetRequest(true));
  assert.deepEqual(f.calls, directions);
});

test('unverified or incomplete capabilities do not publish direction controls', async t => {
  for (const value of [{ ...capabilities, supported: false }, { ...capabilities, relativeStep: false },
    { ...capabilities, directions: ['up'] }]) {
    const f = await fixture(t, { getPtzCapabilities: async () => value });
    assert.equal(f.manager, null);
    assert.equal(f.on('up'), undefined);
  }
});

test('concurrent and stale-camera Home app commands cannot move another camera', async t => {
  let release;
  const calls = [];
  const f = await fixture(t, { movePtz: direction => { calls.push(direction); return new Promise(resolve => release = () => resolve({ accepted: true, direction })); } });
  const first = f.on('left').handleSetRequest(true);
  await tick();
  await assert.rejects(f.on('up').handleSetRequest(true), e => e === hap.HAPStatus.RESOURCE_BUSY);
  assert.deepEqual(calls, ['left']);
  release(); await first;
  f.runtime.selected = () => ({ ...selection, deviceId: '31' });
  await assert.rejects(f.on('right').handleSetRequest(true));
  assert.deepEqual(calls, ['left']);
});

test('unknown or unaccepted replies fail without leaking command details', async t => {
  const f = await fixture(t, { movePtz: async () => { throw Object.assign(new Error('PRIVATE_TOKEN'), { reason: 'PRIVATE_RESPONSE' }); } });
  await assert.rejects(f.on('down').handleSetRequest(true));
  await tick();
  assert.equal(f.on('down').value, false);
  assert.equal(f.logs.length, 1);
  assert.doesNotMatch(f.logs.join(''), /PRIVATE/);
  f.runtime.movePtz = async () => ({ accepted: false, direction: 'up' });
  await assert.rejects(f.on('up').handleSetRequest(true));
});
