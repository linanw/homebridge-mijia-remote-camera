import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createRequire } from 'node:module';
import register from '../index.mjs';
import { MijiaRemoteCameraPlatform, PLUGIN_NAME } from '../lib/platform.mjs';

const require = createRequire(import.meta.url);
const hostRequire = createRequire(require.resolve('homebridge'));
let hap;
try { hap = hostRequire('@homebridge/hap-nodejs'); } catch { hap = hostRequire('hap-nodejs'); }
const hostMain = require.resolve('homebridge');
const { PlatformAccessory } = await import(new URL('./platformAccessory.js', 'file://' + hostMain));
let hapMain;
try { hapMain = hostRequire.resolve('@homebridge/hap-nodejs'); } catch { hapMain = hostRequire.resolve('hap-nodejs'); }
const tlv = await import(new URL('./lib/util/tlv.js', 'file://' + hapMain));

const chosen = { homeId: '101', homeOwner: '202', deviceId: '303', name: '摄像头', model: 'chuangmi.camera.061a01' };
function fixture(selection = chosen) {
  const messages = [];
  const log = Object.fromEntries(['info', 'warn', 'error', 'debug'].map(key => [key, text => messages.push(text)]));
  const api = new EventEmitter();
  api.user = { storagePath: () => '/private/homebridge' };
  api.hap = {
    uuid: { generate: value => createHash('sha256').update(value).digest('hex') },
    Categories: { CAMERA: 17 },
    Service: { AccessoryInformation: 'AccessoryInformation' },
    Characteristic: { Manufacturer: 'manufacturer', Model: 'model', SerialNumber: 'serial', FirmwareRevision: 'version' },
  };
  api.platformAccessory = class {
    constructor(name, uuid) { this.name = name; this.UUID = uuid; this.characteristics = {}; }
    getService() { return { setCharacteristic: (key, value) => { this.characteristics[key] = value; return this.getService(); } }; }
    configureController(controller) { this.controller = controller; }
  };
  const published = [];
  api.publishExternalAccessories = (plugin, accessories) => { assert.equal(plugin, PLUGIN_NAME); published.push(...accessories); };
  const runtime = new EventEmitter();
  runtime.current = selection;
  runtime.selected = () => runtime.current;
  runtime.starts = runtime.stops = runtime.closes = 0;
  runtime.start = async () => { runtime.starts++; return 'http://127.0.0.1:23456/cam.ts'; };
  runtime.stop = async () => { runtime.stops++; };
  runtime.close = async () => { runtime.closes++; };
  runtime.talkSource = () => undefined;
  runtime.getNightVision = async () => ({ mode: 'auto' });
  runtime.setNightVision = async mode => ({ mode });
  const delegates = [];
  const options = {
    runtimeFactory: async params => {
      assert.equal(params.storagePath, '/private/homebridge/mijia-remote-camera');
      return runtime;
    },
    delegateFactory: () => {
      const value = { controller: {}, resets: 0, shutdowns: 0,
        reset() { this.resets++; }, shutdown() { this.shutdowns++; } };
      delegates.push(value); return value;
    },
  };
  const platform = new MijiaRemoteCameraPlatform(log, { enableNightVision: false }, api, options);
  return { platform, api, runtime, published, delegates, messages, options, log };
}

test('entry point registers the scoped npm plugin with the existing platform alias', () => {
  let registration;
  register({ registerPlatform: (...values) => { registration = values; } });
  assert.deepEqual(registration, ['@linanw/homebridge-mijia-remote-camera', 'MijiaRemoteCamera', MijiaRemoteCameraPlatform]);
});

test('unconfigured plugin starts setup service without publishing a fake camera', async () => {
  const fixtureValue = fixture(null);
  await fixtureValue.platform.launch();
  assert.equal(fixtureValue.published.length, 0);
  assert.equal(fixtureValue.runtime.starts, 0);
  await fixtureValue.platform.shutdown();
  assert.equal(fixtureValue.runtime.closes, 1);
});

test('selected device publishes one native external accessory with opaque stable identity', async () => {
  const { platform, published, runtime } = fixture();
  await platform.launch();
  assert.equal(published.length, 1);
  assert.equal(runtime.starts, 1);
  assert.equal(published[0].UUID, createHash('sha256').update(`homebridge-mijia-remote-camera:${chosen.deviceId}`).digest('hex'));
  assert.notEqual(published[0].characteristics.serial, chosen.deviceId);
  assert.ok(!published[0].characteristics.serial.includes(chosen.deviceId));
  assert.equal(platform.deviceId, chosen.deviceId);
  await platform.shutdown();
});

test('same camera refreshed after home selection keeps accessory and resets old streams', async () => {
  const { platform, published, runtime, delegates } = fixture();
  await platform.launch();
  runtime.current = { ...chosen, homeId: '404', homeOwner: '505' };
  runtime.emit('selection');
  await platform.refreshQueue;
  assert.equal(published.length, 1);
  assert.equal(delegates[0].resets, 1);
  assert.equal(runtime.starts, 2);
  await platform.shutdown();
});

test('runtime reports media from the current native camera without changing accessory identity', async () => {
  const { platform, runtime, delegates } = fixture();
  await platform.launch();
  delegates[0].getMediaDiagnostics = () => ({ snapshot: { requests: 3 }, activeStreams: 0 });
  assert.deepEqual(runtime.mediaDiagnostics(), { snapshot: { requests: 3 }, activeStreams: 0 });
  await platform.shutdown();
});

test('different camera stops old streams and requires restart instead of duplicate publication', async () => {
  const { platform, runtime, published, delegates, messages } = fixture();
  await platform.launch();
  runtime.current = { ...chosen, deviceId: '909' };
  runtime.emit('selection');
  await platform.refreshQueue;
  assert.equal(published.length, 1);
  assert.equal(delegates[0].shutdowns, 1);
  assert.ok(messages.some(message => message.includes('重启 Homebridge')));
  await platform.shutdown();
});

test('configured identifiers never bypass private runtime selection', async () => {
  const { platform, published } = fixture(null);
  platform.config = { deviceId: '999', homeId: '888', homeOwner: '777' };
  await platform.launch();
  assert.equal(published.length, 0);
  await platform.shutdown();
});

test('shutdown removes selection listener and releases runtime exactly once', async () => {
  const { platform, runtime, delegates } = fixture();
  await platform.launch();
  await platform.shutdown();
  await platform.shutdown();
  assert.equal(runtime.listenerCount('selection'), 0);
  assert.equal(runtime.stops, 1);
  assert.equal(runtime.closes, 1);
  assert.equal(delegates[0].shutdowns, 1);
});

test('initialization errors do not include raw backend details in Homebridge logs', async () => {
  const { api, log, messages } = fixture();
  const platform = new MijiaRemoteCameraPlatform(log, {}, api, {
    runtimeFactory: async () => { throw new Error('PRIVATE_TOKEN_AND_SIGNED_URL'); },
  });
  api.emit('didFinishLaunching');
  await platform.launchPromise;
  assert.ok(messages.length > 0);
  assert.ok(!JSON.stringify(messages).includes('PRIVATE_TOKEN'));
});


test('production platform publishes AAC-ELD with real microphone, two-way speaker and night switch', async () => {
  const { api, options, log, runtime, published } = fixture();
  api.hap = hap;
  api.platformAccessory = PlatformAccessory;
  const platform = new MijiaRemoteCameraPlatform(log, {}, api, { runtimeFactory: options.runtimeFactory });
  try {
    await platform.launch();
    const accessory = published[0];
    assert.ok(accessory.getService(hap.Service.Microphone));
    assert.equal(accessory.getService(hap.Service.Microphone).getCharacteristic(hap.Characteristic.Mute).value, false);
    assert.ok(accessory.getService(hap.Service.Speaker));
    assert.equal(accessory.getService(hap.Service.Speaker).getCharacteristic(hap.Characteristic.Mute).value, false);
    assert.ok(accessory.getServiceById(hap.Service.Switch, 'mijia-night-vision'));
    assert.ok(accessory.getServiceById(hap.Service.Switch, 'mijia-night-vision-auto'));
    runtime.emit('night-mode', { mode: 'auto' });
    assert.equal(accessory.getServiceById(hap.Service.Switch, 'mijia-night-vision').getCharacteristic(hap.Characteristic.On).value, false);
    assert.equal(accessory.getServiceById(hap.Service.Switch, 'mijia-night-vision-auto').getCharacteristic(hap.Characteristic.On).value, true);
    runtime.emit('night-mode', { mode: 'off' });
    assert.equal(accessory.getServiceById(hap.Service.Switch, 'mijia-night-vision').getCharacteristic(hap.Characteristic.On).value, false);
    assert.equal(accessory.getServiceById(hap.Service.Switch, 'mijia-night-vision-auto').getCharacteristic(hap.Characteristic.On).value, false);
    assert.equal(platform.nightVision.status().mode, 'off');
    assert.equal(platform.delegate.talkbackEnabled, true);
    assert.equal(platform.delegate.controller.recordingManagement, undefined);
    const streams = accessory.services.filter(service => service.UUID === hap.Service.CameraRTPStreamManagement.UUID);
    assert.equal(streams.length, 1);
    const audio = tlv.decode(Buffer.from(streams[0].getCharacteristic(hap.Characteristic.SupportedAudioStreamConfiguration).value, 'base64'));
    const codec = tlv.decode(audio[1]);
    const parameters = tlv.decode(codec[2]);
    assert.equal(codec[1][0], 2, 'AAC-ELD codec');
    assert.equal(parameters[1][0], 1, 'mono audio declaration');
    assert.equal(parameters[3][0], 1, '16kHz sample rate');
    assert.equal(runtime.starts, 1);
  } finally { await platform.shutdown(); }
});

test('metadata updates the same HAP accessory without restarting or resetting its video', async () => {
  const value = fixture({ ...chosen, region: 'cn' });
  let enabled = true;
  value.runtime.metadataStatus = () => ({ enabled, metadata: null });
  value.api.hap.Characteristic.Name = 'name';
  await value.platform.launch();
  const accessory = value.published[0], identity = accessory.UUID;
  const metadata = { ...chosen, region: 'cn', name: '米家新名称', roomId: '606', roomName: '书房', homeName: '家', revision: 1 };
  value.runtime.emit('metadata', metadata);
  assert.equal(value.published.length, 1);
  assert.equal(accessory.UUID, identity);
  assert.equal(accessory.displayName, '米家新名称');
  assert.equal(accessory.characteristics.name, '米家新名称');
  assert.equal(value.platform.metadata.roomName, '书房');
  assert.equal(value.runtime.starts, 1);
  assert.equal(value.runtime.stops, 0);
  assert.equal(value.delegates[0].resets, 0);
  value.runtime.emit('metadata', { ...metadata, homeId: '999', name: 'OTHER_HOME' });
  value.runtime.emit('metadata', { ...metadata, deviceId: '999', name: 'OTHER_CAMERA' });
  assert.equal(accessory.displayName, '米家新名称');
  enabled = false;
  value.runtime.emit('metadata', { ...metadata, name: '同步已暂停' });
  assert.equal(accessory.displayName, '米家新名称');
  await value.platform.shutdown();
  assert.equal(value.runtime.listenerCount('metadata'), 0);
});

test('Homebridge shutdown records a bounded error when resource cleanup rejects', async () => {
  const value = fixture(null);
  await value.platform.launch();
  value.runtime.close = async () => { throw new Error('PRIVATE_BACKEND_ERROR'); };
  value.api.emit('shutdown');
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(value.messages.some(message => message.includes('资源未能正常释放')));
  assert.ok(!value.messages.some(message => message.includes('PRIVATE')));
});
