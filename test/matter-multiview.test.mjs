import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { createSocket } from 'node:dgram';
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { RTCPeerConnection, RTCRtpCodecParameters } from 'werift';
import { createMatterMedia } from '../lib/matter-media.mjs';

const ffmpeg = process.env.MATTER_TEST_FFMPEG || fileURLToPath(new URL('../assets/runtime/ffmpeg', import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (!check()) { assert.ok(Date.now() < deadline, 'multiview media condition timed out'); await delay(25); }
}
const peerConfig = { bundlePolicy: 'max-bundle', iceServers: [], iceUseTcp: false, iceUseIpv6: false,
  iceAdditionalHostAddresses: ['127.0.0.1'], codecs: {
    video: [new RTCRtpCodecParameters({ mimeType: 'video/H264', clockRate: 90000, payloadType: 96,
      parameters: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f' })],
    audio: [new RTCRtpCodecParameters({ mimeType: 'audio/opus', clockRate: 48000, channels: 2, payloadType: 111,
      parameters: 'minptime=10;useinbandfec=1' })],
  } };
const request = { video: { width: 320, height: 180, frameRate: 15, bitRate: 256000 }, audio: { bitRate: 24000 } };
function launch(args) {
  const child = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.resume(); child.stdin.on('error', () => {}); return child;
}
function stop(child) {
  if (!child) return;
  child.stdin?.end(); child.kill('SIGTERM');
  const deadline = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 1000);
  deadline.unref(); child.once('close', () => clearTimeout(deadline));
}
async function udp() {
  const value = createSocket('udp4'); await new Promise(resolve => value.bind(0, '127.0.0.1', resolve)); return value;
}
async function fixture() {
  const jobs = new Set(), connections = new Set(), gets = { video: 0, audio: 0 };
  const server = createServer((req, res) => {
    const kind = req.url === '/cam.ts' ? 'video' : req.url === '/audio.ogg' ? 'audio' : undefined;
    if (!kind) { res.writeHead(404); res.end(); return; }
    gets[kind]++;
    const args = kind === 'video'
      ? ['-re', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=15', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
        '-preset', 'ultrafast', '-tune', 'zerolatency', '-g', '15', '-f', 'mpegts', 'pipe:1']
      : ['-re', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-c:a', 'libopus', '-ar', '48000',
        '-ac', '2', '-f', 'ogg', '-page_duration', '20000', 'pipe:1'];
    const child = launch(args); jobs.add(child); res.writeHead(200); res.flushHeaders(); child.stdout.pipe(res);
    res.on('close', () => child.kill('SIGTERM')); child.once('close', () => jobs.delete(child));
  });
  server.on('connection', connection => { connections.add(connection); connection.once('close', () => connections.delete(connection)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { gets, runtime: { ensureReady: async () => `${base}/cam.ts`,
    audioSource: () => ({ url: `${base}/audio.ogg`, format: 'ogg', sampleRate: 48000, channels: 2 }) },
    async close() { for (const child of jobs) child.kill('SIGTERM'); for (const connection of connections) connection.destroy();
      await new Promise(resolve => server.close(resolve)); } };
}
function h264Decoder() {
  const child = launch(['-f', 'h264', '-i', 'pipe:0', '-f', 'framemd5', 'pipe:1']);
  let output = '', fragmented = false; child.stdout.on('data', bytes => output += bytes);
  const start = Buffer.from([0, 0, 0, 1]);
  return { child, write(packet) {
    const p = packet.payload, type = p[0] & 31;
    if (type >= 1 && type <= 23) child.stdin.write(Buffer.concat([start, p]));
    else if (type === 24) { for (let i = 1; i + 2 <= p.length;) { const n = p.readUInt16BE(i); i += 2;
      if (!n || i + n > p.length) break; child.stdin.write(Buffer.concat([start, p.subarray(i, i + n)])); i += n; } }
    else if (type === 28 && p.length > 2) {
      if (p[1] & 128) { fragmented = true; child.stdin.write(Buffer.concat([start, Buffer.from([(p[0] & 224) | (p[1] & 31)]), p.subarray(2)])); }
      else if (fragmented) child.stdin.write(p.subarray(2)); if (p[1] & 64) fragmented = false;
    }
  }, async finish() { const done = new Promise(resolve => child.once('close', resolve)); child.stdin.end(); await done;
    return output.split('\n').filter(line => line && !line.startsWith('#')).length; } };
}
async function receiver(media, id, options = request) {
  const peer = new RTCPeerConnection(peerConfig), decoder = h264Decoder(), forward = await udp();
  const reservation = await udp(), port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const audio = launch(['-protocol_whitelist', 'pipe,udp,rtp', '-analyzeduration', '0', '-probesize', '32768',
    '-f', 'sdp', '-i', 'pipe:0', '-c:a', 'pcm_s16le', '-f', 's16le', 'pipe:1']);
  const received = { video: 0, audio: 0, audioBytes: 0 }; let stopped = false, decodingDone = false;
  audio.stdout.on('data', bytes => received.audioBytes += bytes.length);
  audio.stdin.end(`v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=Multiview\r\nc=IN IP4 127.0.0.1\r\nt=0 0\r\nm=audio ${port} RTP/AVP 111\r\na=rtpmap:111 opus/48000/2\r\n`);
  peer.onTrack.subscribe(track => track.onReceiveRtp.subscribe(packet => {
    if (stopped) return;
    if (track.kind === 'video') { received.video++; decoder.write(packet); }
    else { received.audio++; const copy = packet.clone(); copy.header.payloadType = 111; copy.header.extensions = [];
      forward.send(copy.serialize(), port, '127.0.0.1', () => {}); }
  }));
  try {
    const { offer } = await media.createSession({ id, ...options });
    await peer.setRemoteDescription({ type: 'offer', sdp: offer }); await peer.setLocalDescription(await peer.createAnswer());
    await media.provideAnswer(id, peer.localDescription.sdp);
  } catch (error) { stopped = true; stop(decoder.child); stop(audio); forward.close(); await peer.close(); throw error; }
  return { peer, received, async finish() {
    stopped = true; const frames = await decoder.finish(); decodingDone = true; return frames;
  }, async close() { stopped = true; if (!decodingDone) stop(decoder.child); stop(audio); forward.close(); await peer.close(); } };
}

test('two independent viewers decode shared H264/Opus; leaving and replacement do not interrupt the other viewer', { timeout: 50000 }, async t => {
  try { await access(ffmpeg); } catch { t.skip('bundled FFmpeg not available'); return; }
  const source = await fixture(), spawns = [], viewers = [];
  const media = createMatterMedia({ runtime: source.runtime, ffmpegPath: ffmpeg, config: { matterLoopbackIce: true },
    spawnProcess(path, args, options) { spawns.push(args); return spawn(path, args, options); } });
  try {
    const first = await receiver(media, 'first'); viewers.push(first);
    await until(() => first.received.video > 20 && first.received.audioBytes > 30000);
    const second = await receiver(media, 'second'); viewers.push(second);
    await until(() => second.received.video > 25 && second.received.audioBytes > 30000);
    assert.equal(media.status().activeSessions, 2);
    assert.equal(media.status().videoSources, 1); assert.equal(media.status().audioSources, 1);
    assert.deepEqual(source.gets, { video: 1, audio: 1 }, 'identical viewers open one camera and microphone input');
    assert.equal(spawns.filter(args => args.includes('libx264')).length, 1, 'video is encoded once');
    assert.equal(spawns.filter(args => args.includes('libopus')).length, 1, 'audio is encoded once');
    await assert.rejects(media.createSession({ id: 'over-capacity', ...request }), { reason: 'session_busy' });
    assert.equal(media.status().activeSessions, 2);
    const held = [...media.sources.values()];
    const secondBefore = second.received.video; await media.closeSession('first');
    assert.ok(await first.finish() > 5, 'first viewer receives decodable H264');
    await until(() => second.received.video > secondBefore + 20);
    assert.equal(media.status().activeSessions, 1); assert.equal(media.status().videoSources, 1);
    await assert.rejects(media.createSession({ id: 'failed-peer', ...request,
      offer: 'v=0\r\na=fingerprint:PRIVATE_TEST\r\na=ice-ufrag:PRIVATE_TEST\r\n' }), { reason: 'media_not_offered' });
    assert.equal(media.status().activeSessions, 1, 'failed negotiation releases only its own reservation');
    const replacement = await receiver(media, 'replacement'); viewers.push(replacement);
    await until(() => replacement.received.video > 25 && replacement.received.audioBytes > 30000);
    assert.deepEqual(source.gets, { video: 1, audio: 1 }, 'replacement attaches to the existing source');
    assert.equal(media.status().activeSessions, 2); assert.ok(second.received.video > secondBefore + 25);
    media.setMicrophoneMuted(true); await delay(350);
    const mutedAudio = [second.received.audio, replacement.received.audio], continuingVideo = second.received.video;
    const audioSpawnsBefore = spawns.filter(args => args.includes('libopus')).length;
    media.setMicrophoneVolume(50); await delay(400);
    assert.deepEqual([second.received.audio, replacement.received.audio], mutedAudio, 'global microphone mute affects both viewers');
    assert.ok(second.received.video > continuingVideo, 'microphone mute preserves video');
    assert.equal(spawns.filter(args => args.includes('libopus')).length, audioSpawnsBefore, 'muted volume change does not start audio');
    media.setMicrophoneMuted(false);
    await until(() => second.received.audio > mutedAudio[0] + 10 && replacement.received.audio > mutedAudio[1] + 10);
    assert.deepEqual(source.gets, { video: 1, audio: 2 }, 'unmute restarts exactly one shared microphone input');
    assert.equal(spawns.filter(args => args.includes('libopus')).length, audioSpawnsBefore + 1);
    held.push(...media.sources.values());
    await media.closeSession('second'); assert.ok(await second.finish() > 5, 'second viewer receives decodable H264');
    await media.closeSession('replacement'); assert.ok(await replacement.finish() > 5, 'replacement receives decodable H264');
    assert.equal(media.status().active, false); assert.equal(media.status().activeSessions, 0);
    assert.equal(media.status().activeSources, 0); assert.equal(media.sources.size, 0); assert.equal(media.sessions.size, 0);
    for (const item of held) { assert.equal(item.jobs.size, 0); assert.equal(item.sockets.size, 0); }
    assert.equal(JSON.stringify(media.status()).includes('PRIVATE_TEST'), false);
  } finally { await media.close(); for (const viewer of viewers) await viewer.close(); await source.close(); }
});

test('concurrent setup reserves two slots before awaits, rejects duplicate IDs, and frees capacity independently', { timeout: 15000 }, async () => {
  const media = createMatterMedia({ runtime: {}, config: { matterLoopbackIce: true } });
  try {
    const pending = media.createSession({ id: 1, video: {} });
    await assert.rejects(media.createSession({ id: '1', video: {} }), { reason: 'duplicate_session' });
    const second = media.createSession({ id: 'second', video: {} });
    await assert.rejects(media.createSession({ id: 'third', video: {} }), { reason: 'session_busy' });
    await Promise.all([pending, second]);
    assert.equal(media.status().activeSessions, 2); const original = media.getSession(1);
    assert.equal(media.getSession('1'), original, 'numeric and string IDs denote the same reservation');
    await media.closeSession('second'); assert.equal(media.getSession(1), original);
    await media.createSession({ id: 'third', video: {} }); assert.equal(media.status().activeSessions, 2);
    await media.closeSession('unknown'); assert.equal(media.status().activeSessions, 2);
  } finally { await media.close(); }
  assert.equal(media.status().activeSessions, 0); assert.equal(media.status().activeSources, 0);
});

test('talkback has one owner; mute and closing that owner release only its claim', { timeout: 15000 }, async () => {
  let sourceRequests = 0;
  const media = createMatterMedia({ runtime: { talkSource() { sourceRequests++; return new Promise(() => {}); } },
    config: { matterLoopbackIce: true } });
  const packet = { clone() { return { header: {}, serialize: () => Buffer.from([128, 111, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]) }; } };
  try {
    await media.createSession({ id: 'talk-first', audio: {} });
    await media.createSession({ id: 'talk-second', audio: {} });
    const first = media.getSession('talk-first'), second = media.getSession('talk-second');
    media.receiveTalk(first, packet); media.receiveTalk(second, packet);
    assert.equal(sourceRequests, 1); assert.equal(media.talkOwner, first);
    assert.equal(first.talk.queue.length, 1); assert.equal(second.talk, undefined);
    assert.equal(media.status().talkPackets, 1); assert.equal(media.status().talkbackActive, true);
    media.setSpeakerMuted(true); assert.equal(media.status().talkbackActive, false);
    media.receiveTalk(second, packet); assert.equal(sourceRequests, 1, 'mute does not open another talk source');
    media.setSpeakerMuted(false); media.receiveTalk(second, packet);
    assert.equal(media.talkOwner, second); assert.equal(sourceRequests, 2);
    await media.closeSession('talk-first'); assert.equal(media.talkOwner, second, 'closing another viewer preserves the active speaker');
    media.setSpeakerVolume(50); assert.equal(media.status().talkbackActive, false);
    media.receiveTalk(second, packet); assert.equal(sourceRequests, 3);
    await media.closeSession('talk-second'); assert.equal(media.status().talkbackActive, false);
    assert.equal(media.status().activeSessions, 0);
  } finally { await media.close(); }
});

test('closing the last viewer during a delayed camera startup prevents a late encoder or socket leak', { timeout: 15000 }, async () => {
  let releaseSource, sourceRequested = false, spawns = 0;
  const media = createMatterMedia({ runtime: { ensureReady() { sourceRequested = true; return new Promise(resolve => releaseSource = resolve); } },
    config: { matterLoopbackIce: true }, spawnProcess() { spawns++; throw new Error('late source must not spawn'); } });
  const peer = new RTCPeerConnection(peerConfig);
  try {
    const { offer } = await media.createSession({ id: 'late', video: request.video });
    await peer.setRemoteDescription({ type: 'offer', sdp: offer }); await peer.setLocalDescription(await peer.createAnswer());
    await media.provideAnswer('late', peer.localDescription.sdp); await until(() => sourceRequested);
    const pendingSources = [...media.sources.values()]; await media.closeSession('late');
    releaseSource('http://127.0.0.1:12345/cam.ts'); await delay(50);
    assert.equal(spawns, 0); assert.equal(media.status().activeSources, 0); assert.equal(media.status().activeSessions, 0);
    for (const source of pendingSources) { assert.equal(source.jobs.size, 0); assert.equal(source.sockets.size, 0); }
  } finally { releaseSource?.('http://127.0.0.1:12345/cam.ts'); await media.close(); await peer.close(); }
});

test('an encoder failure is limited to its profile and preserves another profile and viewer', { timeout: 25000 }, async t => {
  try { await access(ffmpeg); } catch { t.skip('bundled FFmpeg not available'); return; }
  const source = await fixture(), media = createMatterMedia({ runtime: source.runtime, ffmpegPath: ffmpeg,
    config: { matterLoopbackIce: true } }), viewers = [];
  try {
    const first = await receiver(media, 'profile-first', { video: request.video }); viewers.push(first);
    const second = await receiver(media, 'profile-second', { video: { ...request.video, width: 384 } }); viewers.push(second);
    await until(() => first.received.video > 20 && second.received.video > 20);
    assert.equal(media.status().videoSources, 2); assert.deepEqual(source.gets, { video: 2, audio: 0 });
    const survivor = media.getSession('profile-second'), before = second.received.video;
    media.failSource(media.getSession('profile-first').videoSource, 'ffmpeg_exit');
    await until(() => media.status().activeSessions === 1 && second.received.video > before + 15);
    assert.equal(media.getSession('profile-second'), survivor); assert.equal(media.status().videoSources, 1);
    assert.equal(media.status().state, 'connected'); assert.equal(media.status().lastFailure, 'ffmpeg_exit');
  } finally { await media.close(); for (const viewer of viewers) await viewer.close(); await source.close(); }
});

test('late negotiation cleanup cannot close a replacement that reuses the same session ID', { timeout: 15000 }, async () => {
  const media = createMatterMedia({ runtime: {}, config: { matterLoopbackIce: true } });
  let release;
  try {
    const pending = media.createSession({ id: 'reused', video: {} });
    const oldSession = media.getSession('reused');
    oldSession.peer.setLocalDescription = async () => { await new Promise(resolve => release = resolve); throw new Error('delayed old negotiation'); };
    const rejected = assert.rejects(pending, { reason: 'session_closed' });
    await until(() => Boolean(release)); await media.closeSession('reused');
    await media.createSession({ id: 'reused', video: {} });
    const replacement = media.getSession('reused'); assert.notEqual(replacement, oldSession);
    release(); await rejected;
    assert.equal(media.getSession('reused'), replacement);
    assert.equal(media.status().activeSessions, 1); assert.equal(media.status().failures, 0);
  } finally { release?.(); await media.close(); }
});
