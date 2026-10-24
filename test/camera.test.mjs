import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createSocket } from 'node:dgram';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { existsSync } from 'node:fs';
import test from 'node:test';
import { MijiaCameraDelegate } from '../lib/camera.mjs';

const require = createRequire(import.meta.url);
const hostRequire = createRequire(require.resolve('homebridge'));
let hap;
try { hap = hostRequire('@homebridge/hap-nodejs'); } catch { hap = hostRequire('hap-nodejs'); }
const log = { info() {}, warn() {}, error() {}, debug() {} };
const privateFFmpeg = fileURLToPath(new URL('../assets/runtime/ffmpeg', import.meta.url));
const nativeMediaSkip = process.platform !== 'linux' || process.arch !== 'x64'
  ? 'The native JPEG/SRTP integration requires Linux x64.'
  : !existsSync(privateFFmpeg)
    ? 'Private assets/runtime/ffmpeg is not distributed in the public source; provide the local runtime bundle to run native JPEG/SRTP integration.'
    : !existsSync('/usr/bin/ffmpeg')
      ? 'The independent /usr/bin/ffmpeg synthetic source and SRTP receiver are unavailable.'
      : false;
const invoke = call => new Promise((resolve, reject) => call((failure, value) => failure ? reject(failure) : resolve(value)));
const request = () => ({ sessionID: randomUUID(), targetAddress: '127.0.0.1', addressVersion: 'ipv4',
  video: { port: 5000, srtpCryptoSuite: 0, srtp_key: randomBytes(16), srtp_salt: randomBytes(14) },
  audio: { port: 5100, srtpCryptoSuite: 0, srtp_key: randomBytes(16), srtp_salt: randomBytes(14) } });
const camera = (runtime = { ensureReady: async () => 'http://127.0.0.1:23456/cam.ts' }, options = {}) =>
  new MijiaCameraDelegate({ api: { hap }, log, runtime, ffmpegPath: '/usr/bin/ffmpeg', ...options });
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function eventually(check) {
  for (let attempt = 0; attempt < 100; attempt++) { if (check()) return; await delay(1); }
  assert.fail('Media condition did not settle');
}
class FakeFFmpeg extends EventEmitter {
  constructor() { super(); this.stdout = new PassThrough(); this.stderr = new PassThrough(); this.exitCode = null; this.signalCode = null; this.kills = []; }
  exit(code = 0, signal = null) {
    if (this.exited) return;
    this.exited = true; this.exitCode = code; this.signalCode = signal;
    this.stdout.end(); this.stderr.end(); this.emit('close', code, signal);
  }
  kill(signal) { this.kills.push(signal); queueMicrotask(() => this.exit(null, signal)); return true; }
}

test('split progress starts once and RTCP counters remain safe through stream cleanup', async () => {
  const child = new FakeFFmpeg(), events = [];
  const delegate = camera(undefined, { spawnProcess: () => child, onMediaEvent: event => events.push(event) });
  const sender = createSocket('udp4');
  try {
    const input = request();
    const endpoint = await invoke(callback => delegate.prepareStream(input, callback));
    const privateSession = delegate.sessions.get(input.sessionID);
    let callbacks = 0;
    const pending = new Promise((resolve, reject) => delegate.handleStreamRequest({ type: 'start', sessionID: input.sessionID }, failure => {
      callbacks++; failure ? reject(failure) : resolve();
    }));
    await eventually(() => child.stdout.listenerCount('data') > 0);
    child.stdout.write('fra'); child.stdout.write('me=0\nfra');
    assert.equal(callbacks, 0);
    child.stdout.write('me= '); child.stdout.write('2\nprogress=continue\n');
    await pending;
    child.stdout.write('frame=3\n');
    assert.equal(callbacks, 1);
    assert.equal(delegate.getMediaDiagnostics().stream.firstFrames, 1);
    await new Promise(resolve => sender.bind(0, '127.0.0.1', resolve));
    sender.send(Buffer.from([0x80, 0xc9, 0, 0]), endpoint.video.port, '127.0.0.1');
    await eventually(() => delegate.getMediaDiagnostics().stream.rtcpPackets === 1);
    sender.send(Buffer.from([0x80, 0xc9, 0, 0]), endpoint.video.port, '127.0.0.1');
    await eventually(() => delegate.getMediaDiagnostics().stream.rtcpPackets === 2);
    assert.equal(events.filter(value => value.type === 'stream_rtcp_first').length, 1);
    child.exit(1);
    assert.equal(callbacks, 1);
    assert.equal(delegate.sessions.size, 0);
    assert.equal(delegate.jobs.size, 0);
    assert.ok(privateSession.crypto.every(byte => byte === 0));
    assert.ok(privateSession.audioKey.every(byte => byte === 0));
    assert.ok(privateSession.audioSalt.every(byte => byte === 0));
    assert.throws(() => privateSession.audioSocket.address());
    assert.equal(delegate.getMediaDiagnostics().stream.lastFailure, 'ffmpeg_exit');
    assert.equal(events.filter(value => value.type === 'stream_failure').length, 1);
    const serialized = JSON.stringify({ events, diagnostics: delegate.getMediaDiagnostics() });
    assert.ok(!serialized.includes('127.0.0.1') && !serialized.includes(input.sessionID));
    assert.ok(!serialized.includes(input.video.srtp_key.toString('base64')));
  } finally { sender.close(); delegate.shutdown(); }
});

test('stream startup has one deadline covering both source wait and encoding', async () => {
  const child = new FakeFFmpeg();
  let spawned = 0;
  const delegate = camera({ ensureReady: async () => { await delay(80); return 'http://127.0.0.1:23456/cam.ts'; } },
    { startDeadlineMs: 120, spawnProcess: () => { spawned++; return child; } });
  try {
    const input = request();
    await invoke(callback => delegate.prepareStream(input, callback));
    const started = performance.now();
    await assert.rejects(invoke(callback => delegate.handleStreamRequest({ type: 'start', sessionID: input.sessionID }, callback)), { reason: 'start_timeout' });
    assert.equal(spawned, 1);
    assert.ok(performance.now() - started < 185, 'source wait must not add a second encoding deadline');
    assert.equal(delegate.sessions.size, 0);
    assert.equal(delegate.jobs.size, 0);
    assert.equal(delegate.getMediaDiagnostics().stream.lastFailure, 'start_timeout');
    assert.ok(child.kills.includes('SIGTERM'));
  } finally { delegate.shutdown(); }
});

test('a source resolving after startup timeout cannot create a late FFmpeg process', async () => {
  let resolveSource, spawned = 0;
  const source = new Promise(resolve => { resolveSource = resolve; });
  const delegate = camera({ ensureReady: () => source }, { startDeadlineMs: 30, spawnProcess: () => { spawned++; return new FakeFFmpeg(); } });
  try {
    const input = request();
    await invoke(callback => delegate.prepareStream(input, callback));
    await assert.rejects(invoke(callback => delegate.handleStreamRequest({ type: 'start', sessionID: input.sessionID }, callback)), { reason: 'start_timeout' });
    resolveSource('http://127.0.0.1:23456/cam.ts');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(spawned, 0);
    assert.equal(delegate.sessions.size, 0);
    assert.equal(delegate.getMediaDiagnostics().stream.failures, 1);
  } finally { resolveSource('http://127.0.0.1:23456/cam.ts'); delegate.shutdown(); }
});

test('stderr and observer failures expose only fixed media categories', async () => {
  const child = new FakeFFmpeg(), events = [];
  const delegate = camera(undefined, { spawnProcess: () => child, onMediaEvent: event => {
    events.push(event); event.private = 'OBSERVER_MUTATION'; throw new Error('PRIVATE_OBSERVER');
  } });
  try {
    const input = request();
    await invoke(callback => delegate.prepareStream(input, callback));
    const pending = invoke(callback => delegate.handleStreamRequest({ type: 'start', sessionID: input.sessionID }, callback));
    pending.catch(() => {});
    await eventually(() => child.stdout.listenerCount('data') > 0);
    child.stderr.write(`PRIVATE_TOKEN http://user:PRIVATE@secret.invalid/ -srtp_out_params ${input.video.srtp_key.toString('base64')}\nUnknown enc`);
    child.stderr.write("oder 'private'\n");
    child.exit(1);
    await assert.rejects(pending, failure => failure.reason === 'encoder_unavailable' && !failure.message.includes('PRIVATE'));
    assert.equal(delegate.getMediaDiagnostics().stream.lastFailure, 'encoder_unavailable');
    const diagnostic = JSON.stringify(delegate.getMediaDiagnostics());
    assert.ok(!diagnostic.includes('PRIVATE') && !diagnostic.includes('secret.invalid') && !diagnostic.includes('OBSERVER_MUTATION'));
    assert.ok(!diagnostic.includes(input.video.srtp_key.toString('base64')));
    assert.equal(events.find(value => value.type === 'stream_failure').exitCode, 1);
    assert.equal(delegate.sessions.size, 0);
  } finally { delegate.shutdown(); }
});

test('snapshot diagnostics count cached requests and sanitize a failing encoder signal', async () => {
  const events = [];
  let spawned = 0;
  const delegate = camera(undefined, { spawnProcess: () => {
    spawned++; const child = new FakeFFmpeg();
    process.nextTick(() => { child.stdout.write(Buffer.from([0xff, 0xd8, 1, 2, 0xff, 0xd9])); child.exit(0); });
    return child;
  }, onMediaEvent: event => events.push(event) });
  try {
    await invoke(callback => delegate.handleSnapshotRequest({ width: 4096, height: 4096 }, callback));
    await invoke(callback => delegate.handleSnapshotRequest({ width: 4096, height: 4096 }, callback));
    const snapshot = delegate.getMediaDiagnostics().snapshot;
    assert.equal(snapshot.requests, 2); assert.equal(snapshot.successes, 2); assert.equal(snapshot.failures, 0);
    assert.equal(spawned, 1);
    const success = events.filter(value => value.type === 'snapshot_success');
    assert.equal(success[1].cached, true);
    assert.equal(success[1].width, 640); assert.equal(success[1].height, 360);
  } finally { delegate.shutdown(); }
  const child = new FakeFFmpeg();
  const failed = camera(undefined, { spawnProcess: () => child });
  try {
    const pending = invoke(callback => failed.handleSnapshotRequest({ width: 320, height: 180 }, callback)); pending.catch(() => {});
    await eventually(() => child.stdout.listenerCount('data') > 0);
    child.exit(null, 'SIGILL');
    await assert.rejects(pending, { reason: 'ffmpeg_cpu_unsupported' });
    assert.equal(failed.getMediaDiagnostics().snapshot.lastFailure, 'ffmpeg_cpu_unsupported');
    assert.equal(failed.getMediaDiagnostics().lastEvent.signal, 'SIGILL');
  } finally { failed.shutdown(); }
});

test('snapshot timeout settles once and stops its child without leaking a job', async () => {
  const child = new FakeFFmpeg(), events = [];
  const delegate = camera(undefined, { spawnProcess: () => child, snapshotTimeoutMs: 20, onMediaEvent: value => events.push(value) });
  try {
    await Promise.all([delay(35), assert.rejects(invoke(callback => delegate.handleSnapshotRequest({ width: 320, height: 180 }, callback)), { reason: 'snapshot_timeout' })]);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(delegate.jobs.size, 0);
    assert.equal(delegate.getMediaDiagnostics().snapshot.failures, 1);
    assert.equal(events.filter(value => value.type === 'snapshot_failure').length, 1);
    assert.ok(child.kills.includes('SIGTERM'));
  } finally { delegate.shutdown(); }
});

async function freeUdp() {
  const socket = createSocket('udp4');
  await new Promise(resolve => socket.bind(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}

test('explicit video-only override preserves the minimal controller and video prepare contract', async () => {
  const delegate = camera(undefined, { audioCompatibility: false });
  try {
    const accessory = new hap.Accessory('Video-only test', hap.uuid.generate('video-only-test'));
    accessory.configureController(delegate.controller);
    assert.equal(accessory.getService(hap.Service.Microphone), undefined);
    assert.equal(delegate.controller.recordingManagement, undefined);
    const input = request(); delete input.audio;
    const endpoint = await invoke(callback => delegate.prepareStream(input, callback));
    assert.ok(endpoint.video.port > 0);
    assert.equal(endpoint.audio, undefined);
  } finally { delegate.shutdown(); }
});

test('prepare reserves a live UDP endpoint and permits only one stream', async () => {
  const delegate = camera();
  try {
    const first = request();
    const prepared = await invoke(callback => delegate.prepareStream(first, callback));
    assert.ok(prepared.video.port > 0);
    assert.deepEqual(prepared.video.srtp_key, first.video.srtp_key);
    await assert.rejects(invoke(callback => delegate.prepareStream(request(), callback)));
    await invoke(callback => delegate.handleStreamRequest({ sessionID: first.sessionID, type: 'stop' }, callback));
    assert.equal(delegate.sessions.size, 0);
    const second = request();
    await invoke(callback => delegate.prepareStream(second, callback));
    assert.equal(delegate.sessions.size, 1);
  } finally { delegate.shutdown(); }
});

test('untrusted destinations and crypto cannot enter FFmpeg arguments', async () => {
  const delegate = camera();
  try {
    for (const value of [
      { ...request(), targetAddress: 'example.com -i PRIVATE_TOKEN' },
      { ...request(), targetAddress: 'https://evil.example' },
      { ...request(), video: { ...request().video, srtpCryptoSuite: 2 } },
      { ...request(), video: { ...request().video, srtp_key: Buffer.alloc(2) } },
    ]) {
      await assert.rejects(invoke(callback => delegate.prepareStream(value, callback)));
      assert.equal(delegate.sessions.size, 0);
    }
  } finally { delegate.shutdown(); }
});

test('cold runtime and unsafe source URLs produce only safe errors', async () => {
  for (const runtime of [
    { ensureReady: async () => { throw new Error('PRIVATE_CREDENTIALS'); } },
    { ensureReady: async () => 'http://evil.example/cam.ts?PRIVATE_TOKEN' },
    { ensureReady: async () => 'http://user:PRIVATE@127.0.0.1:12345/cam.ts' },
  ]) {
    const delegate = camera(runtime, { spawnProcess() { throw new Error('Must not spawn'); } });
    try {
      await assert.rejects(invoke(callback => delegate.handleSnapshotRequest({ width: 320, height: 180 }, callback)),
        failure => !failure.message.includes('PRIVATE') && !failure.message.includes('evil'));
    } finally { delegate.shutdown(); }
  }
});

test('snapshot process errors are redacted and do not leave a pending cache', async () => {
  const delegate = camera(undefined, { spawnProcess() { throw new Error('PRIVATE_COMMAND_LINE'); } });
  try {
    await assert.rejects(invoke(callback => delegate.handleSnapshotRequest({ width: 320, height: 180 }, callback)),
      failure => !failure.message.includes('PRIVATE'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(delegate.snapshots.size, 0);
    assert.equal(delegate.jobs.size, 0);
  } finally { delegate.shutdown(); }
});

test('shutdown wipes private stream material and prevents new requests', async () => {
  const delegate = camera();
  const prepare = request();
  await invoke(callback => delegate.prepareStream(prepare, callback));
  const privateSession = delegate.sessions.get(prepare.sessionID);
  delegate.shutdown();
  assert.ok(privateSession.crypto.every(byte => byte === 0));
  assert.ok(privateSession.key.every(byte => byte === 0));
  assert.ok(privateSession.audioKey.every(byte => byte === 0));
  assert.ok(privateSession.audioSalt.every(byte => byte === 0));
  assert.throws(() => privateSession.audioSocket.address());
  assert.equal(delegate.sessions.size, 0);
  await assert.rejects(invoke(callback => delegate.handleSnapshotRequest({ width: 320, height: 180 }, callback)));
});

test('simultaneous different-size snapshots have a bounded work queue', async () => {
  let rejectSource;
  const source = new Promise((_, reject) => { rejectSource = reject; });
  const delegate = camera({ ensureReady: () => source });
  const first = invoke(callback => delegate.handleSnapshotRequest({ width: 320, height: 180 }, callback));
  const second = invoke(callback => delegate.handleSnapshotRequest({ width: 322, height: 180 }, callback));
  await assert.rejects(invoke(callback => delegate.handleSnapshotRequest({ width: 324, height: 180 }, callback)));
  assert.equal(delegate.snapshots.size, 2);
  rejectSource(new Error('Unavailable'));
  await Promise.allSettled([first, second]);
  delegate.shutdown();
});

test('reselecting the same published camera can resume after a suspended selection', async () => {
  const delegate = camera();
  delegate.shutdown();
  delegate.resume();
  const prepared = request();
  await invoke(callback => delegate.prepareStream(prepared, callback));
  assert.equal(delegate.sessions.size, 1);
  delegate.shutdown();
});

test('native delegate generates JPEG and sends decodable SRTP from a synthetic source', { timeout: 30000, skip: nativeMediaSkip }, async () => {
  const children = new Set();
  const child = (command, args) => {
    const process = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    children.add(process);
    process.once('close', () => children.delete(process));
    return process;
  };
  const server = createServer((incoming, outgoing) => {
    if (incoming.url !== '/cam.ts') { outgoing.writeHead(404); outgoing.end(); return; }
    outgoing.writeHead(200, { 'Content-Type': 'video/mp2t' });
    const source = child('/usr/bin/ffmpeg', ['-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi',
      '-i', 'testsrc2=size=640x360:rate=12', '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
      '-threads', '1', '-g', '12', '-keyint_min', '12', '-sc_threshold', '0', '-pix_fmt', 'yuv420p',
      '-an', '-f', 'mpegts', 'pipe:1']);
    source.stdout.pipe(outgoing);
    outgoing.once('close', () => source.kill('SIGTERM'));
    source.once('close', () => outgoing.end());
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/cam.ts`;
  const delegate = camera({ ensureReady: async () => url }, {
    ffmpegPath: privateFFmpeg,
  });
  try {
    const jpeg = await invoke(callback => delegate.handleSnapshotRequest({ width: 320, height: 180 }, callback));
    assert.equal(jpeg.readUInt16BE(0), 0xffd8);
    assert.ok(jpeg.length > 1000);
    const cached = await invoke(callback => delegate.handleSnapshotRequest({ width: 320, height: 180 }, callback));
    assert.equal(jpeg, cached);

    const prepared = request();
    prepared.video.port = await freeUdp();
    await invoke(callback => delegate.prepareStream(prepared, callback));
    const srtp = Buffer.concat([prepared.video.srtp_key, prepared.video.srtp_salt]).toString('base64');
    const sdp = `v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=Native synthetic QA\r\nc=IN IP4 127.0.0.1\r\nt=0 0\r\n`
      + `m=video ${prepared.video.port} RTP/SAVP 99\r\na=rtpmap:99 H264/90000\r\na=fmtp:99 packetization-mode=1\r\n`
      + `a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:${srtp}\r\na=rtcp-mux\r\n`;
    const receiver = child('/usr/bin/ffmpeg', ['-hide_banner', '-loglevel', 'error',
      '-protocol_whitelist', 'file,pipe,udp,rtp,crypto', '-f', 'sdp', '-i', 'pipe:0',
      '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1']);
    let frame = Buffer.alloc(0);
    receiver.stdout.on('data', data => { frame = Buffer.concat([frame, data]); });
    const received = new Promise((resolve, reject) => {
      receiver.once('error', reject);
      receiver.once('close', code => code === 0 ? resolve() : reject(new Error('Synthetic SRTP decoding failed')));
    });
    receiver.stdin.end(sdp);
    await new Promise(resolve => setTimeout(resolve, 100));
    await invoke(callback => delegate.handleStreamRequest({ sessionID: prepared.sessionID, type: 'start',
      video: { width: 640, height: 360, fps: 12, max_bit_rate: 700, pt: 99, profile: 0, level: 0, mtu: 1316 } }, callback));
    const process = delegate.sessions.get(prepared.sessionID).process;
    const exit = new Promise(resolve => process.once('close', resolve));
    await received;
    assert.equal(frame.readUInt16BE(0), 0xffd8);
    assert.ok(frame.length > 1000);
    await invoke(callback => delegate.handleStreamRequest({ sessionID: prepared.sessionID, type: 'stop' }, callback));
    await exit;
    assert.equal(delegate.sessions.size, 0);
    assert.equal(delegate.jobs.size, 0);
  } finally {
    delegate.shutdown();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await Promise.all([...children].map(process => new Promise(resolve => {
      if (!children.has(process)) { resolve(); return; }
      process.once('close', resolve);
      try { process.kill('SIGKILL'); } catch { resolve(); }
    })));
  }
});


test('default AAC negotiation owns distinct idle audio endpoint and keeps FFmpeg video-only', async () => {
  const child = new FakeFFmpeg(); let args;
  const delegate = camera(undefined, { spawnProcess: (_binary, value) => { args = value; return child; } });
  try {
    const input = request();
    const audioKey = Buffer.from(input.audio.srtp_key), audioSalt = Buffer.from(input.audio.srtp_salt);
    const prepared = await invoke(callback => delegate.prepareStream(input, callback));
    const session = delegate.sessions.get(input.sessionID);
    assert.notEqual(prepared.video.port, prepared.audio.port);
    assert.ok(prepared.audio.port > 0);
    assert.deepEqual(prepared.audio.srtp_key, audioKey);
    assert.deepEqual(prepared.audio.srtp_salt, audioSalt);
    assert.notEqual(prepared.audio.srtp_key, input.audio.srtp_key);
    assert.notEqual(prepared.audio.srtp_key, session.audioKey);
    input.audio.srtp_key.fill(42); input.audio.srtp_salt.fill(43);
    prepared.audio.srtp_key.fill(44); prepared.audio.srtp_salt.fill(45);
    assert.deepEqual(session.audioKey, audioKey);
    assert.deepEqual(session.audioSalt, audioSalt);
    const pending = invoke(callback => delegate.handleStreamRequest({ type: 'start', sessionID: input.sessionID,
      audio: { codec: 'AAC-eld', sample_rate: 16, pt: 110, max_bit_rate: 24 } }, callback));
    await eventually(() => !!args); child.stdout.write('frame=1\n'); await pending;
    assert.ok(args.includes('-an'));
    assert.ok(!args.includes('-c:a') && !args.includes('-codec:a'));
    assert.equal(args.filter(value => value.startsWith('srtp://')).length, 1);
    delegate.stopStream(input.sessionID);
    assert.ok(session.audioKey.every(byte => byte === 0));
    assert.ok(session.audioSalt.every(byte => byte === 0));
    assert.throws(() => session.audioSocket.address());
    assert.equal(delegate.sessions.size, 0);
  } finally { delegate.shutdown(); }
});

test('default prepare rejects invalid audio negotiation without retaining a session', async () => {
  const delegate = camera();
  try {
    const base = request();
    for (const audio of [undefined, { ...base.audio, port: 0 }, { ...base.audio, port: 65536 },
      { ...base.audio, srtpCryptoSuite: 2 }, { ...base.audio, srtp_key: Buffer.alloc(15) },
      { ...base.audio, srtp_salt: Buffer.alloc(13) }, { ...base.audio, srtp_key: 'untrusted' }]) {
      await assert.rejects(invoke(callback => delegate.prepareStream({ ...request(), audio }, callback)), { reason: 'invalid_prepare' });
      assert.equal(delegate.sessions.size, 0);
    }
  } finally { delegate.shutdown(); }
});

test('shutdown before UDP bindings settle completes prepare once and wipes both endpoints', async () => {
  const delegate = camera(); const input = request(); let calls = 0;
  const prepared = new Promise(resolve => delegate.prepareStream(input, failure => { calls++; resolve(failure); }));
  const session = delegate.sessions.get(input.sessionID);
  delegate.shutdown();
  assert.equal((await prepared).reason, 'stream_reset');
  await delay(10);
  assert.equal(calls, 1);
  assert.equal(delegate.sessions.size, 0);
  for (const key of ['crypto', 'key', 'salt', 'audioKey', 'audioSalt']) assert.ok(session[key].every(byte => byte === 0));
  assert.throws(() => session.socket.address());
  assert.throws(() => session.audioSocket.address());
});

test('idle audio endpoint failure closes the video endpoint and wipes owned material', async () => {
  const delegate = camera(); const input = request();
  try {
    await invoke(callback => delegate.prepareStream(input, callback));
    const session = delegate.sessions.get(input.sessionID);
    session.audioSocket.emit('error', new Error('PRIVATE_SOCKET_FAILURE'));
    assert.equal(delegate.sessions.size, 0);
    assert.equal(delegate.getMediaDiagnostics().stream.lastFailure, 'udp_error');
    for (const key of ['crypto', 'key', 'salt', 'audioKey', 'audioSalt']) assert.ok(session[key].every(byte => byte === 0));
    assert.throws(() => session.socket.address());
    assert.throws(() => session.audioSocket.address());
    assert.ok(!JSON.stringify(delegate.getMediaDiagnostics()).includes('PRIVATE'));
  } finally { delegate.shutdown(); }
});
