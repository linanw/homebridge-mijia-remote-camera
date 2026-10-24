import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { NightVisionManager, configureNightVision, supportsNightVision } from '../lib/night-vision.mjs';

const require = createRequire(import.meta.url);
const hostRequire = createRequire(require.resolve('homebridge'));
let hap, IdentifierCache;
try {
  hap = hostRequire('@homebridge/hap-nodejs');
  ({ IdentifierCache } = hostRequire('@homebridge/hap-nodejs/dist/lib/model/IdentifierCache'));
} catch {
  hap = hostRequire('hap-nodejs');
  ({ IdentifierCache } = hostRequire('hap-nodejs/dist/lib/model/IdentifierCache'));
}
const tick = () => new Promise(setImmediate);
const subtypes = { on: 'mijia-night-vision', auto: 'mijia-night-vision-auto' };
const names = { on: '手动夜视', auto: '自动夜视' };

function fixture(options = {}) {
  let current = 'auto', reads = 0;
  const writes = [], switchCalls = [];
  const manager = new NightVisionManager({
    getMode: async () => { ++reads; return { mode: current }; },
    setMode: async mode => { writes.push(mode); current = mode; return { mode }; },
    setModeSwitch: async (mode, enabled) => {
      switchCalls.push({ mode, enabled });
      const next = enabled ? mode : current === mode ? 'off' : current;
      if (next !== current) writes.push(next);
      current = next;
      return { mode: current };
    },
    ...options,
  });
  return { manager, writes, switchCalls, reads: () => reads, changeCurrent: mode => { current = mode; } };
}

test('verified models only; the legacy enabled API preserves automatic policy without a write', async () => {
  assert.equal(supportsNightVision('chuangmi.camera.061a01'), true);
  assert.equal(supportsNightVision('chuangmi.camera.061a03'), true);
  assert.equal(supportsNightVision('chuangmi.camera.unverified'), false);
  const f = fixture({ pollIntervalMs: 5 });
  f.manager.start();
  try {
    await delay(20);
    assert.equal((await f.manager.get()).mode, 'auto');
    assert.equal((await f.manager.get()).enabled, true);
    assert.ok(f.reads() >= 2);
    assert.deepEqual(f.writes, []);
    await f.manager.setEnabled(true);
    assert.equal(f.manager.status().mode, 'auto');
    assert.deepEqual(f.writes, []);
  } finally { f.manager.shutdown(); }
});

test('off/on and explicit automatic mode writes require the confirmed policy', async () => {
  const f = fixture();
  await f.manager.setEnabled(false);
  assert.equal(f.manager.status().enabled, false);
  await f.manager.setEnabled(true);
  await f.manager.set('auto');
  assert.deepEqual(f.writes, ['off', 'on', 'auto']);
  assert.equal(f.manager.status().mode, 'auto');
  f.manager.shutdown();
});

test('simultaneous HomeKit writes run in order and preserve their final requested state', async () => {
  const f = fixture({ setMode: async mode => { f.writes.push(mode); await delay(5); return { mode }; } });
  await f.manager.get();
  await Promise.all([f.manager.setEnabled(false), f.manager.setEnabled(true)]);
  assert.deepEqual(f.writes, ['off', 'on']);
  assert.equal(f.manager.status().mode, 'on');
  f.manager.shutdown();
});

test('a late pre-write read cannot overwrite the confirmed newer policy', async () => {
  let release;
  const f = fixture({ getMode: () => new Promise(resolve => { release = resolve; }) });
  const read = f.manager.get();
  await delay(0);
  await f.manager.set('off');
  release({ mode: 'auto' });
  assert.equal((await read).mode, 'off');
  assert.equal(f.manager.status().mode, 'off');
  f.manager.shutdown();
});

test('mismatched readback and unexpected upstream errors leave the last confirmed state intact', async () => {
  const failures = [];
  const f = fixture({ onFailure: reason => failures.push(reason), setMode: async () => ({ mode: 'auto' }) });
  await f.manager.get();
  await assert.rejects(f.manager.set('off'), { reason: 'night_vision_not_applied' });
  assert.equal(f.manager.status().mode, 'auto');
  assert.equal(f.manager.status().lastFailure, 'night_vision_not_applied');
  assert.deepEqual(failures, ['night_vision_not_applied']);
  f.manager.getMode = async () => { throw new Error('PRIVATE_TOKEN http://secret.invalid'); };
  await assert.rejects(f.manager.get({ force: true }), error => {
    assert.equal(error.reason, 'night_vision_unavailable');
    assert.ok(!error.message.includes('PRIVATE'));
    return true;
  });
  f.manager.shutdown();
});

test('a stalled request is bounded, late results are ignored, and shutdown rejects further operations', async () => {
  let release;
  const f = fixture({ timeoutMs: 10, getMode: () => new Promise(resolve => { release = resolve; }) });
  await Promise.all([assert.rejects(f.manager.get(), { reason: 'night_vision_timeout' }), delay(20)]);
  release({ mode: 'on' });
  await delay(0);
  assert.equal(f.manager.status().mode, null);
  f.manager.shutdown();
  await assert.rejects(f.manager.get(), { reason: 'runtime_closed' });
  await assert.rejects(f.manager.set('off'), { reason: 'runtime_closed' });
});

test('mode switches delegate one atomic operation and never decide an off write from the manager cache', async t => {
  const f = fixture();
  t.after(() => f.manager.shutdown());
  await f.manager.get();
  assert.equal(f.manager.status().mode, 'auto');
  // Another client changed the real device while the manager's ten-second cache is fresh.
  f.changeCurrent('on');
  assert.equal((await f.manager.setModeEnabled('auto', false)).mode, 'on');
  assert.equal(f.reads(), 1, 'fresh conditional reads belong to the atomic backend callback');
  assert.deepEqual(f.switchCalls, [{ mode: 'auto', enabled: false }]);
  assert.deepEqual(f.writes, []);
  assert.equal((await f.manager.setModeEnabled('on', false)).mode, 'off');
  assert.deepEqual(f.writes, ['off']);
});

test('queued mode switches preserve a newly selected mode when an older switch sends delayed false', async t => {
  const f = fixture();
  t.after(() => f.manager.shutdown());
  await Promise.all([
    f.manager.setModeEnabled('on', true),
    f.manager.setModeEnabled('auto', true),
    f.manager.setModeEnabled('on', false),
  ]);
  assert.equal(f.manager.status().mode, 'auto');
  assert.deepEqual(f.writes, ['on', 'auto']);
  await Promise.all([
    f.manager.setModeEnabled('on', true),
    f.manager.setModeEnabled('auto', false),
  ]);
  assert.equal(f.manager.status().mode, 'on');
  assert.deepEqual(f.writes, ['on', 'auto', 'on']);
});

test('mode switches remain single flight while the authoritative callback is pending', async t => {
  let active = 0, maximum = 0;
  const calls = [];
  const f = fixture({ setModeSwitch: async (mode, enabled) => {
    maximum = Math.max(maximum, ++active);
    calls.push({ mode, enabled });
    await delay(5);
    --active;
    return { mode: enabled ? mode : 'off' };
  } });
  t.after(() => f.manager.shutdown());
  await Promise.all([f.manager.setModeEnabled('on', true), f.manager.setModeEnabled('auto', true)]);
  assert.equal(maximum, 1);
  assert.deepEqual(calls, [{ mode: 'on', enabled: true }, { mode: 'auto', enabled: true }]);
  assert.equal(f.manager.status().mode, 'auto');
});

test('invalid mode switches and a missing atomic callback reject without falling back to unsafe legacy writes', async t => {
  const f = fixture();
  t.after(() => f.manager.shutdown());
  for (const [mode, enabled] of [['off', true], ['invalid', false], ['on', 1], ['auto', 'false'], ['on', null]])
    await assert.rejects(f.manager.setModeEnabled(mode, enabled), { reason: 'night_vision_rejected' });
  assert.deepEqual(f.switchCalls, []);
  assert.deepEqual(f.writes, []);
  assert.equal(f.reads(), 0);
  let legacyWrites = 0;
  const manager = new NightVisionManager({
    getMode: async () => ({ mode: 'auto' }),
    setMode: async () => { ++legacyWrites; return { mode: 'off' }; },
  });
  t.after(() => manager.shutdown());
  await assert.rejects(manager.setModeEnabled('auto', false), { reason: 'night_vision_unavailable' });
  assert.equal(legacyWrites, 0);
});

test('mode switch readback must confirm enable or removal of the requested policy; errors preserve confirmed state', async t => {
  const failures = [];
  const f = fixture({ onFailure: reason => failures.push(reason), setModeSwitch: async () => ({ mode: 'auto' }) });
  t.after(() => f.manager.shutdown());
  await f.manager.get();
  await assert.rejects(f.manager.setModeEnabled('on', true), { reason: 'night_vision_not_applied' });
  await assert.rejects(f.manager.setModeEnabled('auto', false), { reason: 'night_vision_not_applied' });
  assert.equal(f.manager.status().mode, 'auto');
  assert.deepEqual(failures, ['night_vision_not_applied', 'night_vision_not_applied']);
  f.manager.setModeSwitch = async () => { throw new Error('PRIVATE_TOKEN http://secret.invalid'); };
  await assert.rejects(f.manager.setModeEnabled('on', true), error => {
    assert.equal(error.reason, 'night_vision_unavailable');
    assert.doesNotMatch(error.message, /PRIVATE|secret/);
    return true;
  });
  assert.equal(f.manager.status().mode, 'auto');
});

test('a newer external mode observation wins over an older in-flight read', async t => {
  let release;
  const f = fixture({ getMode: () => new Promise(resolve => { release = resolve; }) });
  t.after(() => f.manager.shutdown());
  const read = f.manager.get();
  await tick();
  f.manager.observe('auto');
  release({ mode: 'on' });
  assert.equal((await read).mode, 'auto');
  assert.equal(f.manager.status().mode, 'auto');
  assert.deepEqual(f.writes, []);
});

test('mode switch timeout cannot accept a late result or run queued work after shutdown', async t => {
  let release;
  const f = fixture({ timeoutMs: 10,
    setModeSwitch: () => new Promise(resolve => { release = resolve; }),
  });
  t.after(() => f.manager.shutdown());
  await f.manager.get();
  await Promise.all([assert.rejects(f.manager.setModeEnabled('on', true), { reason: 'night_vision_timeout' }), delay(20)]);
  release({ mode: 'on' });
  await tick();
  assert.equal(f.manager.status().mode, 'auto');
  f.manager.shutdown();
  await assert.rejects(f.manager.setModeEnabled('auto', false), { reason: 'runtime_closed' });
});

async function hapFixture(t, { initial = 'auto', accessory, overrides = {} } = {}) {
  const runtime = new EventEmitter();
  const calls = [], warnings = [];
  let current = initial, reads = 0;
  runtime.getNightVision = async () => { ++reads; return { mode: current }; };
  runtime.setNightVision = async mode => {
    throw new Error(`Unsafe legacy setter used for ${mode}`);
  };
  runtime.setNightVisionSwitch = async (mode, enabled) => {
    calls.push({ mode, enabled });
    current = enabled ? mode : current === mode ? 'off' : current;
    runtime.emit('night-mode', { mode: current });
    return { mode: current };
  };
  Object.assign(runtime, overrides);
  accessory ||= new hap.Accessory('Night vision test', hap.uuid.generate(`night-vision-test-${initial}`));
  const manager = configureNightVision({ api: { hap }, accessory, runtime, model: 'chuangmi.camera.061a01',
    log: { warn: value => warnings.push(value) } });
  t.after(() => manager.shutdown());
  await manager.get();
  const service = mode => accessory.getServiceById(hap.Service.Switch, subtypes[mode]);
  const on = mode => service(mode).getCharacteristic(hap.Characteristic.On);
  return { runtime, accessory, manager, calls, warnings, service, on, reads: () => reads };
}

test('real HomeKit services expose two distinct names and exact mutually exclusive on, auto and off states', async t => {
  for (const initial of ['on', 'auto', 'off']) {
    const f = await hapFixture(t, { initial });
    const cache = new IdentifierCache('AA:BB:CC:DD:EF:01');
    const wireNames = [];
    for (const mode of ['on', 'auto']) {
      const service = f.service(mode);
      service._assignIDs(cache, f.accessory.UUID);
      const wire = await service.toHAP(undefined, false);
      assert.equal(service.displayName, names[mode]);
      assert.equal(wire.characteristics.find(value => value.type === '23')?.value, names[mode]);
      assert.equal(wire.characteristics.find(value => value.type === 'E3')?.value, names[mode]);
      assert.equal(await f.on(mode).handleGetRequest(), initial === mode);
      assert.equal(f.on(mode).value, initial === mode);
      wireNames.push(wire.characteristics.find(value => value.type === 'E3').value);
    }
    assert.equal(new Set(wireNames).size, 2);
    assert.equal(f.manager.status().enabled, initial !== 'off', 'legacy API retains automatic-is-enabled semantics');
    assert.deepEqual(f.calls, [], 'registration, status reads and HAP serialization do not write policies');
  }
});

test('real HomeKit mode writes switch policies and ignore delayed false for the other mode', async t => {
  const f = await hapFixture(t);
  await f.on('on').handleSetRequest(true);
  assert.equal(f.on('on').value, true);
  assert.equal(f.on('auto').value, false);
  await f.on('auto').handleSetRequest(true);
  assert.equal(f.on('on').value, false);
  assert.equal(f.on('auto').value, true);
  await f.on('on').handleSetRequest(false);
  assert.equal(f.manager.status().mode, 'auto');
  assert.equal(f.on('auto').value, true);
  await f.on('on').handleSetRequest(true);
  await f.on('auto').handleSetRequest(false);
  assert.equal(f.manager.status().mode, 'on');
  assert.equal(f.on('on').value, true);
  await f.on('on').handleSetRequest(false);
  assert.equal(f.manager.status().mode, 'off');
  assert.equal(f.on('on').value, false);
  assert.equal(f.on('auto').value, false);
  assert.deepEqual(f.calls, [
    { mode: 'on', enabled: true }, { mode: 'auto', enabled: true }, { mode: 'on', enabled: false },
    { mode: 'on', enabled: true }, { mode: 'auto', enabled: false }, { mode: 'on', enabled: false },
  ]);
});

test('external UI and Matter observations update both HomeKit switches without a feedback write or listener leak', async t => {
  const f = await hapFixture(t);
  assert.equal(f.runtime.listenerCount('night-mode'), 1);
  for (const mode of ['on', 'auto', 'off']) {
    f.runtime.emit('night-mode', { mode });
    assert.equal(f.on('on').value, mode === 'on');
    assert.equal(f.on('auto').value, mode === 'auto');
  }
  assert.deepEqual(f.calls, []);
  f.manager.shutdown();
  assert.equal(f.runtime.listenerCount('night-mode'), 0);
  f.runtime.emit('night-mode', { mode: 'on' });
  assert.equal(f.manager.status().mode, 'off');
  assert.equal(f.on('on').value, false);
  await assert.rejects(f.on('auto').handleSetRequest(true), value => value === hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  assert.deepEqual(f.calls, []);
});

test('real HomeKit failures use safe HAP errors and keep both switches at the last confirmed mode', async t => {
  const f = await hapFixture(t, { initial: 'on' });
  f.runtime.setNightVisionSwitch = async () => { throw new Error('PRIVATE_TOKEN'); };
  await assert.rejects(f.on('auto').handleSetRequest(true), value => value === hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  assert.equal(f.manager.status().mode, 'on');
  assert.equal(f.on('on').value, true);
  assert.equal(f.on('auto').value, false);
  assert.equal(f.warnings.length, 1);
  assert.doesNotMatch(f.warnings.join(''), /PRIVATE_TOKEN/);
});

test('night service migration keeps the original service and On IIDs, adds only one auto service, and preserves custom names', async t => {
  const accessory = new hap.Accessory('Existing camera', hap.uuid.generate('night-vision-migration'));
  const cache = new IdentifierCache('AA:BB:CC:DD:EF:02');
  const previous = accessory.addService(hap.Service.Switch, '摄像头开关', subtypes.on);
  previous._assignIDs(cache, accessory.UUID);
  const serviceIid = previous.iid, onIid = previous.getCharacteristic(hap.Characteristic.On).iid;
  const warnings = [];
  accessory.on('characteristic-warning', value => warnings.push(value));
  const first = await hapFixture(t, { accessory });
  const verify = f => {
    assert.equal(accessory.services.filter(service => service.UUID === hap.Service.Switch.UUID).length, 2);
    assert.equal(f.service('on'), previous);
    previous._assignIDs(cache, accessory.UUID);
    assert.equal(previous.iid, serviceIid);
    assert.equal(previous.getCharacteristic(hap.Characteristic.On).iid, onIid);
    for (const mode of ['on', 'auto']) {
      assert.equal(f.service(mode).displayName, names[mode]);
      assert.equal(f.service(mode).getCharacteristic(hap.Characteristic.Name).value, names[mode]);
    }
    assert.deepEqual(f.calls, []);
  };
  verify(first);
  assert.equal(previous.getCharacteristic(hap.Characteristic.ConfiguredName).value, names.on);
  previous.updateCharacteristic(hap.Characteristic.ConfiguredName, '我的手动红外');
  first.service('auto').updateCharacteristic(hap.Characteristic.ConfiguredName, '');
  first.manager.shutdown();
  const second = await hapFixture(t, { accessory });
  verify(second);
  assert.equal(previous.getCharacteristic(hap.Characteristic.ConfiguredName).value, '我的手动红外');
  assert.equal(second.service('auto').getCharacteristic(hap.Characteristic.ConfiguredName).value, names.auto);
  assert.deepEqual(warnings, []);
});

test('an unverified model publishes neither night switch and never queries the camera', () => {
  const accessory = new hap.Accessory('Unverified camera', hap.uuid.generate('night-vision-unsupported'));
  const runtime = { getNightVision: () => { throw new Error('must not query'); } };
  assert.equal(configureNightVision({ api: { hap }, accessory, runtime, model: 'unknown' }), null);
  assert.equal(accessory.services.filter(service => service.UUID === hap.Service.Switch.UUID).length, 0);
});
