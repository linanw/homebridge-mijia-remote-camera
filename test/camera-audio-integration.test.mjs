import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { createSocket } from 'node:dgram';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { MijiaCameraDelegate } from '../lib/camera.mjs';

const require = createRequire(import.meta.url);
const hostRequire = createRequire(require.resolve('homebridge'));
let hap;
if (process.env.MIJIA_CAMERA_HAP_MODULE) hap = hostRequire(process.env.MIJIA_CAMERA_HAP_MODULE);
else { try { hap = hostRequire('@homebridge/hap-nodejs'); } catch { hap = hostRequire('hap-nodejs'); } }
const binary = fileURLToPath(new URL('../assets/runtime/ffmpeg', import.meta.url));
const audioIntegrationSkip = process.platform !== 'linux' || process.arch !== 'x64'
  ? 'The native AAC-ELD/SRTP audio integration requires Linux x64.'
  : !existsSync(binary)
    ? 'Private assets/runtime/ffmpeg with AAC-ELD codecs is not distributed in the public source; provide the local runtime bundle to run native audio integration.'
    : false;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const invoke = fn => new Promise((resolve, reject) => fn((failure, value) => failure ? reject(failure) : resolve(value)));
async function eventually(check, message, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (check()) return; await delay(25); }
  assert.fail(message);
}
async function freeUdp() {
  const socket = createSocket('udp4');
  await new Promise(resolve => socket.bind(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}
class FakeVideo extends EventEmitter {
  constructor() { super(); this.stdout = new PassThrough(); this.stderr = new PassThrough(); this.exitCode = null; this.signalCode = null; }
  kill(signal) { if (!this.signalCode) { this.signalCode = signal; queueMicrotask(() => this.emit('close', null, signal)); } return true; }
}
function syntheticInput() {
  return { sessionID: randomUUID(), targetAddress: '127.0.0.1', addressVersion: 'ipv4',
    video: { port: 5000, srtpCryptoSuite: 0, srtp_key: randomBytes(16), srtp_salt: randomBytes(14) },
    audio: { port: 5100, srtpCryptoSuite: 0, srtp_key: randomBytes(16), srtp_salt: randomBytes(14) } };
}
const audioRequest = { codec: 'AAC-eld', sample_rate: 16, channel: 1, pt: 110, max_bit_rate: 24 };
function audioSdp(port, key) {
  return `v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=Synthetic audio QA\r\nc=IN IP4 127.0.0.1\r\nt=0 0\r\n`
    + `m=audio ${port} RTP/SAVP 110\r\na=rtpmap:110 MPEG4-GENERIC/16000/1\r\na=rtcp-mux\r\n`
    + `a=fmtp:110 profile-level-id=1;mode=AAC-hbr;sizelength=13;indexlength=3;indexdeltalength=3;config=F8F0212C00BC00\r\n`
    + `a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:${key}\r\n`;
}
function wavHeader() {
  const b = Buffer.alloc(44);
  b.write('RIFF'); b.writeUInt32LE(0x7fffffff, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24); b.writeUInt32LE(16000, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(0x7fffffff - 36, 40);
  return b;
}
function assertTone(bytes) {
  assert.ok(bytes.length >= 3200, 'Synthetic PCM audio must contain decoded samples');
  let energy = 0, changes = 0, previous = 0;
  for (let n = 0; n + 1 < bytes.length; n += 2) {
    const sample = bytes.readInt16LE(n); energy += sample * sample;
    if ((sample > 0) !== (previous > 0)) changes++;
    previous = sample;
  }
  assert.ok(Math.sqrt(energy / (bytes.length / 2)) > 300, 'Decoded camera tone must not be silence');
  assert.ok(changes > 20, 'Decoded audio must retain the synthetic tone waveform');
}
function rms(bytes) {
  if (bytes.length < 2) return Infinity;
  let energy = 0;
  for (let n = 0; n + 1 < bytes.length; n += 2) energy += bytes.readInt16LE(n) ** 2;
  return Math.sqrt(energy / Math.floor(bytes.length / 2));
}
async function fixture(runtime) {
  const processes = new Set(), video = new FakeVideo();
  const child = args => {
    const process = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    processes.add(process); process.once('close', () => processes.delete(process));
    return process;
  };
  const delegate = new MijiaCameraDelegate({ api: { hap }, log: { info() {}, warn() {}, error() {} },
    runtime: { ensureReady: async () => 'http://127.0.0.1:23456/cam.ts', ...runtime }, ffmpegPath: binary,
    spawnProcess: (_, args) => args.includes('libx264') ? video : child(args) });
  return { delegate, video, child, async close() {
    delegate.shutdown();
    await Promise.all([...processes].map(process => new Promise(resolve => {
      process.once('close', resolve); try { process.kill('SIGKILL'); } catch { resolve(); }
    })));
  } };
}
async function activate(f, input) {
  const prepared = await invoke(cb => f.delegate.prepareStream(input, cb));
  const started = invoke(cb => f.delegate.handleStreamRequest({ type: 'start', sessionID: input.sessionID, audio: audioRequest }, cb));
  await eventually(() => f.video.stdout.listenerCount('data'), 'Video fixture did not start');
  f.video.stdout.write('frame=1\n'); await started;
  return prepared;
}

test('real camera PCM is transcoded to independently decrypted AAC-ELD SRTP', { timeout: 25000, skip: audioIntegrationSkip }, async () => {
  let sample = 0;
  const server = createServer((request, response) => {
    if (request.url !== '/audio.wav') { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'Content-Type': 'audio/wav' }); response.write(wavHeader());
    const timer = setInterval(() => {
      const bytes = Buffer.alloc(320);
      for (let n = 0; n < 160; n++) bytes.writeInt16LE(Math.round(9000 * Math.sin(2 * Math.PI * 440 * sample++ / 8000)), n * 2);
      response.write(bytes);
    }, 20);
    response.once('close', () => clearInterval(timer));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const f = await fixture({ audioSource: () => ({ url: `http://127.0.0.1:${server.address().port}/audio.wav`, codec: 'PCMA', sampleRate: 8000, channels: 1 }) });
  try {
    const input = syntheticInput(); input.audio.port = await freeUdp();
    const receiver = f.child(['-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file,pipe,udp,rtp,crypto',
      '-analyzeduration', '0', '-probesize', '32', '-f', 'sdp', '-c:a', 'libfdk_aac', '-i', 'pipe:0',
      '-map', '0:a:0', '-c:a', 'pcm_s16le', '-ar', '16000', '-ac', '1', '-f', 's16le', 'pipe:1']);
    let pcm = Buffer.alloc(0), latest = Buffer.alloc(0);
    receiver.stdout.on('data', bytes => {
      if (pcm.length < 64000) pcm = Buffer.concat([pcm, bytes]);
      latest = Buffer.concat([latest, bytes]).subarray(-16000);
    });
    receiver.stdin.end(audioSdp(input.audio.port, Buffer.concat([input.audio.srtp_key, input.audio.srtp_salt]).toString('base64')));
    await delay(150); await activate(f, input);
    await eventually(() => pcm.length > 8000, 'Independent receiver did not decode camera AAC-ELD audio');
    assertTone(pcm);
    await eventually(() => f.delegate.getMediaDiagnostics().audio.state === 'streaming', 'Real audio did not report its first encoded frame');
    const encoder = f.delegate.sessions.get(input.sessionID).audioProcess, initialVolume = rms(pcm.subarray(-8000));
    f.delegate.controller.emit('microphone-change', true, 100);
    await eventually(() => latest.length >= 8000 && rms(latest) < 20, 'HomeKit microphone mute did not mute independently decoded audio', 5000);
    assert.equal(f.delegate.sessions.get(input.sessionID).audioProcess, encoder);
    assert.equal(f.delegate.getMediaDiagnostics().audio.state, 'muted');
    f.delegate.controller.emit('microphone-change', false, 50);
    await eventually(() => rms(latest) > initialVolume * 0.35 && rms(latest) < initialVolume * 0.65,
      'HomeKit unmute/volume did not resume decrypted audio at the requested volume', 5000);
    assert.equal(f.delegate.sessions.get(input.sessionID).audioProcess, encoder);
    assert.equal(f.delegate.getMediaDiagnostics().audio.starts, 1);
    assert.equal(f.video.signalCode, null); assert.equal(f.delegate.sessions.size, 1);
  } finally { await f.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('HomeKit AAC-ELD SRTP talkback becomes real backend PCM and stops after the talk button is released', { timeout: 25000, skip: audioIntegrationSkip }, async () => {
  let pcm = Buffer.alloc(0), ended = false;
  const server = createServer((request, response) => {
    if (request.url !== '/talk.pcm' || request.method !== 'POST') { response.writeHead(404).end(); return; }
    request.on('data', bytes => { if (pcm.length < 128000) pcm = Buffer.concat([pcm, bytes]); });
    request.once('end', () => { ended = true; response.writeHead(200).end(); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const f = await fixture({ audioSource: () => undefined,
    talkSource: () => ({ url: `http://127.0.0.1:${server.address().port}/talk.pcm`, codec: 'PCMA', format: 's16le', sampleRate: 8000, channels: 1 }) });
  try {
    const input = syntheticInput(), prepared = await activate(f, input);
    assert.equal(f.delegate.talkbackEnabled, true);
    const sender = f.child(['-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=16000',
      '-t', '7', '-c:a', 'libfdk_aac', '-profile:a', 'aac_eld', '-frame_length', '480', '-flags', '+global_header', '-ar', '16000', '-ac', '1', '-b:a', '24k',
      '-payload_type', '110', '-ssrc', '1234567', '-f', 'rtp', '-srtp_out_suite', 'AES_CM_128_HMAC_SHA1_80',
      '-srtp_out_params', Buffer.concat([input.audio.srtp_key, input.audio.srtp_salt]).toString('base64'),
      `srtp://127.0.0.1:${prepared.audio.port}?rtcpport=${prepared.audio.port}&pkt_size=188`]);
    await eventually(() => pcm.length > 4000, 'HomeKit talkback was not decoded into backend PCM');
    assertTone(pcm); assert.equal(f.delegate.getMediaDiagnostics().talkback.state, 'streaming');
    sender.kill('SIGTERM');
    await eventually(() => ended && !f.delegate.sessions.get(input.sessionID).talkback, 'Talkback did not stop when incoming voice ended', 5000);
    assert.equal(f.video.signalCode, null); assert.equal(f.delegate.sessions.size, 1);
  } finally { await f.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('Opus camera listening and talkback preserve real audio through independent codec decoders', { timeout: 25000, skip: audioIntegrationSkip }, async () => {
  let f, opus = Buffer.alloc(0), ended = false;
  const server = createServer((request, response) => {
    if (request.url === '/audio.ogg') {
      response.writeHead(200, { 'Content-Type': 'audio/ogg' });
      const tone = f.child(['-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
        '-c:a', 'libopus', '-frame_duration', '40', '-ar', '48000', '-ac', '2', '-f', 'ogg', '-page_duration', '40000', 'pipe:1']);
      tone.stdout.pipe(response); response.once('close', () => tone.kill('SIGTERM')); return;
    }
    if (request.url === '/talk.ogg' && request.method === 'POST') {
      request.on('data', bytes => { if (opus.length < 128000) opus = Buffer.concat([opus, bytes]); });
      request.once('end', () => { ended = true; response.writeHead(200).end(); }); return;
    }
    response.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  f = await fixture({ audioSource: () => ({ url: `${base}/audio.ogg`, codec: 'OPUS', sampleRate: 48000, channels: 2 }),
    talkSource: () => ({ url: `${base}/talk.ogg`, codec: 'OPUS', format: 'ogg', sampleRate: 48000, channels: 2 }) });
  try {
    const input = syntheticInput(); input.audio.port = await freeUdp();
    const receiver = f.child(['-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file,pipe,udp,rtp,crypto',
      '-analyzeduration', '0', '-probesize', '32', '-f', 'sdp', '-c:a', 'libfdk_aac', '-i', 'pipe:0',
      '-map', '0:a:0', '-c:a', 'pcm_s16le', '-ar', '16000', '-ac', '1', '-f', 's16le', 'pipe:1']);
    let listeningPcm = Buffer.alloc(0);
    receiver.stdout.on('data', bytes => { if (listeningPcm.length < 64000) listeningPcm = Buffer.concat([listeningPcm, bytes]); });
    receiver.stdin.end(audioSdp(input.audio.port, Buffer.concat([input.audio.srtp_key, input.audio.srtp_salt]).toString('base64')));
    await delay(150); const prepared = await activate(f, input);
    const sender = f.child(['-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=16000',
      '-t', '7', '-c:a', 'libfdk_aac', '-profile:a', 'aac_eld', '-frame_length', '480', '-flags', '+global_header', '-ar', '16000', '-ac', '1', '-b:a', '24k',
      '-payload_type', '110', '-ssrc', '7654321', '-f', 'rtp', '-srtp_out_suite', 'AES_CM_128_HMAC_SHA1_80',
      '-srtp_out_params', Buffer.concat([input.audio.srtp_key, input.audio.srtp_salt]).toString('base64'),
      `srtp://127.0.0.1:${prepared.audio.port}?rtcpport=${prepared.audio.port}&pkt_size=188`]);
    await eventually(() => listeningPcm.length > 8000 && opus.length > 2000, 'Opus audio did not traverse both HomeKit paths');
    assertTone(listeningPcm);
    // Keep the button down long enough to verify a waveform rather than only Ogg headers.
    await delay(750); sender.kill('SIGTERM');
    f.delegate.controller.emit('speaker-change', true, 100);
    await eventually(() => ended, 'Speaker mute did not close the camera talk stream', 5000);
    assert.equal(f.delegate.getMediaDiagnostics().talkback.muted, true);
    const head = opus.indexOf('OpusHead'); assert.ok(head >= 0, 'Talkback must contain Opus headers');
    assert.equal(opus[head + 9], 2); assert.equal(opus.readUInt32LE(head + 12), 48000);
    const decoder = f.child(['-hide_banner', '-loglevel', 'error', '-f', 'ogg', '-i', 'pipe:0',
      '-map', '0:a:0', '-c:a', 'pcm_s16le', '-ar', '8000', '-ac', '1', '-f', 's16le', 'pipe:1']);
    let talkPcm = Buffer.alloc(0); decoder.stdout.on('data', bytes => { talkPcm = Buffer.concat([talkPcm, bytes]); });
    const decoded = new Promise((resolve, reject) => { decoder.once('error', reject); decoder.once('close', code => code === 0 ? resolve() : reject(new Error('Synthetic Opus talkback decode failed'))); });
    decoder.stdin.end(opus); await decoded; assertTone(talkPcm);
    assert.equal(f.video.signalCode, null); assert.equal(f.delegate.sessions.size, 1);
  } finally { await f.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
