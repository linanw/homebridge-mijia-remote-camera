import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { NightVisionManager, configureNightVision, supportsNightVision } from '../lib/night-vision.mjs';

function fixture(options = {}) {
  let current = 'auto', reads = 0;
  const writes = [];
  const manager = new NightVisionManager({
    getMode: async () => { ++reads; return { mode: current }; },
    setMode: async mode => { writes.push(mode); current = mode; return { mode }; },
    ...options,
  });
  return { manager, writes, reads: () => reads };
}

test('verified models only; automatic policy maps to an enabled HomeKit switch without any write', async () => {
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

test('HomeKit service uses a fixed subtype, preserves Auto on repeated On, and exposes safe HAP errors', async () => {
  const updates = [], warnings = [], writes = [];
  const characteristic = { onGet(fn) { this.get = fn; return this; }, onSet(fn) { this.set = fn; return this; } };
  const service = { getCharacteristic: () => characteristic, updateCharacteristic: (...args) => updates.push(args) };
  const api = { hap: { Service: { Switch: 'switch' }, Characteristic: { On: 'on' },
    HAPStatus: { SERVICE_COMMUNICATION_FAILURE: -70402 },
    HapStatusError: class extends Error { constructor(status) { super('HAP failure'); this.status = status; } } } };
  const accessory = { getServiceById: (_type, subtype) => { assert.equal(subtype, 'mijia-night-vision'); return service; } };
  const runtime = { getNightVision: async () => ({ mode: 'auto' }), setNightVision: async mode => { writes.push(mode); return { mode }; } };
  assert.equal(configureNightVision({ api, accessory, runtime, model: 'unknown' }), null);
  const manager = configureNightVision({ api, accessory, runtime, model: 'chuangmi.camera.061a01', log: { warn: line => warnings.push(line) } });
  try {
    assert.equal(await characteristic.get(), true);
    await characteristic.set(true);
    assert.deepEqual(writes, []);
    await characteristic.set(false);
    assert.deepEqual(writes, ['off']);
    assert.deepEqual(updates.at(-1), ['on', false]);
    runtime.setNightVision = async () => { throw new Error('PRIVATE_TOKEN'); };
    await assert.rejects(characteristic.set(true), { status: -70402 });
    assert.ok(warnings.every(line => !line.includes('PRIVATE_TOKEN')));
    assert.equal(updates.at(-1)[1], false);
  } finally { manager.shutdown(); }
});
