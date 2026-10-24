import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { MatterService } from '../lib/matter-service.mjs';
import { safeDiagnostics } from '../lib/diagnostics.mjs';
import { createUiHandlers } from '../homebridge-ui/server.js';

function fixture(config = { enableMatter: true }) {
  const runtime = new EventEmitter();
  runtime.selected = () => ({ deviceId: '303', model: 'chuangmi.camera.061a01' });
  runtime.ffmpegPath = '/ffmpeg';
  const calls = { device: 0, media: 0, starts: 0, closes: 0, mediaCloses: 0, ends: 0 };
  let params, mediaParams;
  const device = { start: async () => { calls.starts++; }, close: () => { calls.closes++; },
    closeSessions: async () => { calls.ends++; },
    status: () => ({ running: true, commissioned: true, deviceType: 322, activeSessions: 1,
      manualPairingCode: 'PRIVATE', qrPairingCode: 'PRIVATE', fabricId: 'PRIVATE' }),
    pairing: () => ({ manualPairingCode: '12345678901', qrPairingCode: 'MT:0123456789ABCDEF', unknown: 'PRIVATE' }),
    openCommissioningWindow: async () => {}, closeCommissioningWindow: async () => {} };
  const media = { close: () => { calls.mediaCloses++; },
    status: () => ({ sessions: 1, videoPackets: 25, talkBytes: 7, active: true, sdp: 'PRIVATE' }) };
  const options = { runtime, config, storagePath: '/private/storage',
    deviceFactory: async value => { calls.device++; params = value; return device; },
    mediaFactory: async value => { calls.media++; mediaParams = value; return media; } };
  return { service: new MatterService(options), runtime, calls, device, media, options, params: () => params, mediaParams: () => mediaParams };
}

test('Matter disabled by default loads no stack, media process or listener', async () => {
  const { service, calls, runtime } = fixture({});
  assert.deepEqual(await service.start(), { enabled: false, running: false, state: 'disabled', reason: 'matter_disabled' });
  assert.equal(calls.device + calls.media, 0);
  assert.equal(runtime.listenerCount('status'), 0);
  assert.throws(() => service.pairing(), { reason: 'matter_disabled' });
  await service.close();
});

test('coalesces startup, validates configuration and sanitizes state including nested media', async () => {
  const { service, calls, params, runtime } = fixture();
  await Promise.all([service.start(), service.start()]);
  assert.equal(calls.starts, 1);
  assert.equal(params().port, 5540);
  assert.equal(params().networkInterface, 'eth0');
  assert.equal(params().config.nightVision, true);
  assert.equal(params().config.bitRate, 700000);
  assert.doesNotMatch(params().serialNumber, /303/);
  assert.doesNotMatch(JSON.stringify(service.status()), /PRIVATE|Pairing|fabric|sdp/);
  assert.equal(safeDiagnostics({ matter: { ...service.status(), sdp: 'PRIVATE' } }).matter.media.videoPackets, 25);
  runtime.emit('status', { ready: false });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.ends, 1);
  runtime.emit('status', { ready: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.ends, 1);
  await Promise.all([service.close(), service.close()]);
  assert.equal(calls.closes, 1); assert.equal(calls.mediaCloses, 1);
  assert.equal(runtime.listenerCount('status'), 0);
});

test('pairing is separate private admin operation and window controls do not return secrets', async () => {
  const { service, device } = fixture();
  await service.start();
  assert.deepEqual(service.pairing(), { manualPairingCode: '12345678901', qrPairingCode: 'MT:0123456789ABCDEF' });
  assert.doesNotMatch(JSON.stringify(await service.openCommissioningWindow()), /12345678901|MT:/);
  await service.closeCommissioningWindow();
  device.pairing = () => ({ manualPairingCode: 'PRIVATE', qrPairingCode: 'PRIVATE' });
  assert.throws(() => service.pairing(), { reason: 'matter_pairing_unavailable' });
  device.status = () => { throw new Error('PRIVATE'); };
  assert.doesNotThrow(() => service.status());
  await service.close();
});

test('failure releases components, hides details and remains independent from HomeKit', async () => {
  const { service, device, calls } = fixture();
  device.start = async () => { throw Object.assign(new Error('PRIVATE_SIGNED_URL'), { code: 'EADDRINUSE' }); };
  await assert.rejects(service.start(), { reason: 'matter_port_in_use', message: 'matter_port_in_use' });
  assert.equal(calls.closes, 1); assert.equal(calls.mediaCloses, 1);
  assert.equal(service.status().state, 'failed');
  assert.doesNotMatch(JSON.stringify(service.status()), /PRIVATE/);
  await service.close();
});

test('rejects malformed ports and interfaces before opening any stack or socket', async () => {
  for (const value of [{ matterPort: 80 }, { matterPort: '5540' }, { matterInterface: '../private' }]) {
    const { service, calls } = fixture({ enableMatter: true, ...value });
    await assert.rejects(service.start(), { reason: 'matter_configuration_invalid' });
    assert.equal(calls.device + calls.media, 0);
    await service.close();
  }
});

test('shutdown during asynchronous startup never leaves a live Matter server', async () => {
  const { options, device, calls } = fixture();
  let release;
  options.deviceFactory = async () => { await new Promise(resolve => { release = resolve; }); return device; };
  const service = new MatterService(options);
  const start = service.start();
  await new Promise(resolve => setImmediate(resolve));
  const stop = service.close(); release();
  await assert.rejects(start, { reason: 'matter_closed' });
  await stop;
  assert.equal(calls.starts, 0); assert.equal(calls.closes, 1);
  assert.equal(service.status().running, false);
});

test('UI routes use private IPC for pairing and preserve typed sanitized errors', async () => {
  const calls = [];
  const handlers = createUiHandlers({ request: async (...args) => { calls.push(args); return { success: true }; } });
  await handlers['/matter/pairing'](); await handlers['/matter/open-window'](); await handlers['/matter/close-window']();
  assert.deepEqual(calls.map(c => c[0]), ['matter.pairing', 'matter.openWindow', 'matter.closeWindow']);
  const bad = createUiHandlers({ request: async () => { throw Object.assign(new Error('PRIVATE'), { reason: 'matter_not_ready' }); } });
  await assert.rejects(bad['/matter/pairing'](), error => error.message === 'request_failed' && error.requestError.reason === 'matter_not_ready');
});

test('Matter failures retain only fixed negotiation stages and exception names', () => {
  const value = safeDiagnostics({ matter: { media: { failures: 1, lastFailure: 'negotiation_failed',
    lastFailureStage: 'replace_video_track', lastFailureType: 'InvalidModificationError', raw: 'PRIVATE' } } });
  assert.equal(value.matter.media.lastFailureStage, 'replace_video_track');
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE|raw/);
  assert.deepEqual(safeDiagnostics({ matter: { media: { lastFailure: 'PRIVATE_URL',
    lastFailureStage: 'PRIVATE_SDP', lastFailureType: 'PRIVATE_KEY' } } }), {});
});


test('Matter playback capacity is the same bounded value for transport and resource accounting', async () => {
  for (const [value, expected] of [[undefined, 2], [1, 1], [2, 2], [4, 4], [0, 2], [5, 2], [2.5, 2], ['4', 2]]) {
    const f = fixture({ enableMatter: true, ...(value === undefined ? {} : { matterMaxStreams: value }) });
    try {
      await f.service.start();
      assert.equal(f.params().config.maxStreams, expected);
      assert.equal(f.mediaParams().config.maxStreams, expected);
      assert.equal(f.mediaParams().config.enableMatter, true);
    } finally { await f.service.close(); }
  }
});
