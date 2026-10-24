import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { configurePtz } from '../lib/ptz.mjs';

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

const directions = ['up', 'down', 'left', 'right'];
const labels = { up: '云台向上', down: '云台向下', left: '云台向左', right: '云台向右' };
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

test('Home app receives distinct direction names and configured names in HAP responses', async t => {
  const f = await fixture(t);
  const cache = new IdentifierCache('AA:BB:CC:DD:EE:01');
  const names = [], configuredNames = [];
  for (const direction of directions) {
    const service = f.accessory.getServiceById(hap.Service.Switch, `mijia-ptz-${direction}`);
    service._assignIDs(cache, f.accessory.UUID);
    const wire = await service.toHAP(undefined, false);
    assert.equal(service.displayName, labels[direction]);
    const name = wire.characteristics.find(value => value.type === '23');
    const configuredName = wire.characteristics.find(value => value.type === 'E3');
    assert.equal(name?.value, labels[direction]);
    assert.equal(configuredName?.value, labels[direction]);
    names.push(name.value);
    configuredNames.push(configuredName.value);
  }
  assert.equal(new Set(names).size, directions.length);
  assert.equal(new Set(configuredNames).size, directions.length);
  assert.deepEqual(f.calls, []);
});

test('direction naming migrates existing services without changing identity or custom configured names', async t => {
  const accessory = new hap.Accessory('Existing PTZ camera', hap.uuid.generate('ptz-name-migration'));
  const cache = new IdentifierCache('AA:BB:CC:DD:EE:02');
  const previous = new Map();
  for (const direction of directions) {
    const service = accessory.addService(hap.Service.Switch, '摄像头开关', `mijia-ptz-${direction}`);
    service._assignIDs(cache, accessory.UUID);
    assert.equal(service.testCharacteristic(hap.Characteristic.ConfiguredName), false);
    previous.set(direction, { service, iid: service.iid, onIid: service.getCharacteristic(hap.Characteristic.On).iid });
  }
  const calls = [], warnings = [];
  accessory.on('characteristic-warning', value => warnings.push(value));
  const runtime = { getPtzCapabilities: async () => capabilities, selected: () => selection,
    movePtz: async direction => { calls.push(direction); return { accepted: true, direction }; } };
  const configure = async () => {
    const manager = await configurePtz({ api: { hap }, accessory, runtime, selection });
    assert.ok(manager);
    t.after(() => manager.shutdown());
  };
  const verifyIdentities = () => {
    assert.equal(accessory.services.filter(service => service.UUID === hap.Service.Switch.UUID).length, directions.length);
    for (const direction of directions) {
      const original = previous.get(direction);
      const service = accessory.getServiceById(hap.Service.Switch, `mijia-ptz-${direction}`);
      service._assignIDs(cache, accessory.UUID);
      assert.equal(service, original.service);
      assert.equal(service.subtype, `mijia-ptz-${direction}`);
      assert.equal(service.iid, original.iid);
      assert.equal(service.getCharacteristic(hap.Characteristic.On).iid, original.onIid);
      assert.equal(service.displayName, labels[direction]);
      assert.equal(service.getCharacteristic(hap.Characteristic.Name).value, labels[direction]);
    }
    assert.deepEqual(calls, []);
    assert.deepEqual(warnings, []);
  };
  await configure();
  verifyIdentities();
  for (const direction of directions) {
    assert.equal(previous.get(direction).service.getCharacteristic(hap.Characteristic.ConfiguredName).value, labels[direction]);
  }
  previous.get('left').service.updateCharacteristic(hap.Characteristic.ConfiguredName, '自定左转');
  previous.get('right').service.updateCharacteristic(hap.Characteristic.ConfiguredName, '');
  await configure();
  verifyIdentities();
  assert.equal(previous.get('left').service.getCharacteristic(hap.Characteristic.ConfiguredName).value, '自定左转');
  assert.equal(previous.get('right').service.getCharacteristic(hap.Characteristic.ConfiguredName).value, labels.right);
});

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
