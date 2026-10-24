import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { MijiaRemoteCameraPlatform } from '../lib/platform.mjs';
import { attachServices } from '../lib/runtime-factory.mjs';
import { createRpcClient } from '../lib/rpc.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function fixture() {
  const api = new EventEmitter(); api.user = { storagePath: () => '/private/homebridge' };
  api.hap = { uuid: { generate: () => 'stable-uuid' }, Categories: { CAMERA: 17 },
    Service: { AccessoryInformation: 'info' }, Characteristic: {} };
  api.platformAccessory = class { getService() { return undefined; } configureController() {} };
  let published = 0;
  api.publishExternalAccessories = () => { published++; };
  const runtime = new EventEmitter();
  runtime.selected = () => ({ deviceId: '303', homeId: '101', homeOwner: '202' });
  runtime.start = async () => {}; runtime.stop = async () => {}; runtime.close = async () => {};
  const calls = { starts: 0, closes: 0 };
  const matter = { start: async () => { calls.starts++; }, close: async () => { calls.closes++; },
    status: () => ({ enabled: true, running: true, deviceType: 322 }),
    pairing: () => ({ manualPairingCode: '12345678901', qrPairingCode: 'MT:SYNTHETICCODE' }),
    openCommissioningWindow: async () => ({ enabled: true, commissioningWindowOpen: true }),
    closeCommissioningWindow: async () => ({ enabled: true, commissioningWindowOpen: false }) };
  const messages = []; const log = Object.fromEntries(['info','warn','error'].map(k => [k, s => messages.push(s)]));
  const platform = new MijiaRemoteCameraPlatform(log, { enableMatter: true, enableNightVision: false }, api, {
    runtimeFactory: async () => runtime, delegateFactory: () => ({ controller: {}, shutdown() {} }),
    matterServiceFactory: () => matter });
  return { platform, runtime, matter, calls, messages, published: () => published };
}

test('Matter failure preserves existing native HomeKit publication and sanitized logs', async () => {
  const f = fixture();
  f.matter.start = async () => { throw new Error('PRIVATE_SDP'); };
  await f.platform.launch(); await f.platform.matterStart;
  assert.equal(f.published(), 1);
  assert.equal(f.platform.accessory !== undefined, true);
  assert.doesNotMatch(JSON.stringify(f.messages), /PRIVATE/);
  assert.ok(f.messages.some(s => s.includes('Matter')));
  await f.platform.shutdown(); assert.equal(f.calls.closes, 1);
});

test('Matter lifecycle follows camera selection; private admin operations are separate from status', async () => {
  const f = fixture(); await f.platform.launch(); await f.platform.matterStart;
  assert.equal(f.calls.starts, 1);
  assert.equal(f.runtime.matterStatus().deviceType, 322);
  assert.equal((await f.runtime.matterPairing()).manualPairingCode, '12345678901');
  f.runtime.selected = () => ({ deviceId: '304', homeId: '101', homeOwner: '202' });
  await f.platform.refresh(); assert.equal(f.calls.closes, 1); assert.equal(f.published(), 1);
  await f.platform.shutdown();
});

test('private socket forwards Matter admin operations and status without merging pairing codes', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'mijia-matter-rpc-'));
  const f = fixture();
  f.runtime.status = () => ({ ready: true });
  f.runtime.pause = async () => {}; f.runtime.credentialsChanged = async () => {};
  const auth = { cancel: async () => {}, status: () => ({ state: 'idle' }) };
  await attachServices(f.runtime, auth, storage);
  await f.platform.launch(); await f.platform.matterStart;
  const client = createRpcClient(storage);
  try {
    const status = await client.request('status');
    assert.equal(status.matter.deviceType, 322);
    assert.doesNotMatch(JSON.stringify(status), /Pairing|12345678901|MT:/);
    assert.equal((await client.request('matter.pairing')).manualPairingCode, '12345678901');
    assert.equal((await client.request('matter.openWindow')).commissioningWindowOpen, true);
    assert.equal((await client.request('matter.closeWindow')).commissioningWindowOpen, false);
  } finally { await f.platform.shutdown(); await rm(storage, { recursive: true, force: true }); }
});

test('shutdown while selection is pending cannot publish or leave a Matter server behind', async () => {
  const f = fixture(); let select;
  f.runtime.selected = () => new Promise(resolve => { select = resolve; });
  const launch = f.platform.launch();
  await new Promise(resolve => setImmediate(resolve));
  await f.platform.shutdown();
  select({ deviceId: '303', homeId: '101', homeOwner: '202' });
  await launch;
  assert.equal(f.published(), 0); assert.equal(f.calls.starts, 0);
  assert.equal(f.platform.matter, undefined);
});
