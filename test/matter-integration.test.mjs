import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createMatterDevice } from '../lib/matter-device.mjs';

const fakeMedia = () => ({
  async createSession() { throw new Error('No stream was requested'); },
  async closeSession() {},
  async snapshot() { return { data: Buffer.from([255, 216, 255, 217]), width: 640, height: 360 }; },
  setMicrophoneMuted() {}, setMicrophoneVolume() {},
});

test('Matter camera preserves private commissioning identity across restart and exposes safe status', { timeout: 15000 }, async () => {
  const storagePath = await mkdtemp(path.join(tmpdir(), 'mijia-matter-lifecycle-'));
  const options = { storagePath, name: 'Synthetic camera QA', serialNumber: 'synthetic-lifecycle', networkInterface: 'lo', port: 0,
    media: fakeMedia(), config: { listeningAddressIpv4: '127.0.0.1', listeningAddressIpv6: '::1' } };
  let camera;
  try {
    camera = await createMatterDevice(options);
    await camera.start();
    const state = camera.status();
    assert.equal(state.deviceType, 0x0142);
    assert.equal(state.running, true);
    assert.equal(state.commissioned, false);
    assert.equal(state.activeSessions, 0);
    assert.doesNotMatch(JSON.stringify(state), /manualPairingCode|qrPairingCode|passcode|MT:/);
    const pairing = camera.pairing();
    assert.ok(pairing.manualPairingCode.length > 0);
    assert.equal((await stat(path.join(storagePath, 'matter'))).mode & 0o777, 0o700);
    await camera.closeCommissioningWindow();
    assert.equal(camera.status().commissioningWindowOpen, false);
    await camera.close();
    camera = await createMatterDevice(options);
    await camera.start();
    // Assertions deliberately compare in memory: onboarding credentials never appear in test output.
    assert.ok(JSON.stringify(camera.pairing()) === JSON.stringify(pairing), 'commissioning identity changed on restart');
    await camera.openCommissioningWindow();
    assert.equal(camera.status().commissioningWindowOpen, true);
  } finally {
    await camera?.close();
    await rm(storagePath, { recursive: true, force: true });
  }
});

// Optional interoperability test against the same pinned server used by MatterDesk.
// MATTER_SERVER_BIN must name matter-server@1.5.3's dist/esm/bin.js.
// It never connects to the user's controller, camera, NAS or existing fabric.
test('Matter Server commissions, streams, controls and reconnects a real camera endpoint', {
  timeout: 90000, skip: !process.env.MATTER_SERVER_BIN,
}, async () => {
  const { spawn, execFile } = await import('node:child_process');
  const { createServer } = await import('node:http');
  const { createServer: createTcpServer } = await import('node:net');
  const { access, writeFile, realpath } = await import('node:fs/promises');
  const { createRequire } = await import('node:module');
  const { pathToFileURL, fileURLToPath } = await import('node:url');
  const { NodeJsNetwork } = await import('@matter/nodejs');
  const { Logger } = await import('@matter/main');
  const { QrPairingCodeCodec } = await import('@matter/main/types');
  const { RTCPeerConnection, RTCRtpCodecParameters } = await import('werift');
  const { createMatterMedia } = await import('../lib/matter-media.mjs');
  const bin = await realpath(process.env.MATTER_SERVER_BIN);
  const ffmpeg = process.env.MATTER_TEST_FFMPEG || fileURLToPath(new URL('../assets/runtime/ffmpeg', import.meta.url));
  await access(ffmpeg);
  const dir = await mkdtemp(path.join(tmpdir(), 'mijia-matter-interoperability-'));
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(check, message, timeout = 15000) {
    const start = Date.now();
    while (!check()) { assert.ok(Date.now() - start < timeout, message); await delay(25); }
  }
  async function freePort() {
    const socket = createTcpServer();
    await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
    const result = socket.address().port;
    await new Promise(resolve => socket.close(resolve));
    return result;
  }

  // mDNS cannot route IPv6 link-local records over Linux lo. This test-only NIC
  // adapter keeps discovery and every TCP connection on loopback. CASE, TLV,
  // cluster conformance, WebSocket commands and WebRTC remain the actual stacks.
  const getIpMac = NodeJsNetwork.prototype.getIpMac;
  const getNetInterfaces = NodeJsNetwork.prototype.getNetInterfaces;
  const connectTcp = NodeJsNetwork.prototype.connectTcp;
  NodeJsNetwork.prototype.getIpMac = function (name) {
    const result = getIpMac.call(this, name);
    return result && name === 'lo' ? { ...result, mac: '02:00:00:00:00:01', ipV6: [] } : result;
  };
  NodeJsNetwork.prototype.getNetInterfaces = () => [{ name: 'lo', type: 2 }];
  NodeJsNetwork.prototype.connectTcp = function (host, port, options) {
    return connectTcp.call(this, /^fe[89ab][0-9a-f]*:.*%lo$/i.test(host) ? '::1' : host, port, options);
  };
  const moduleEntry = createRequire(pathToFileURL(bin)).resolve('@matter/nodejs');
  const childNetworkModule = pathToFileURL(path.resolve(path.dirname(moduleEntry), '../esm/net/NodeJsNetwork.js')).href;
  const devicePort = await freePort();
  const preloadPath = path.join(dir, 'loopback-only.mjs');
  await writeFile(preloadPath, `
const {NodeJsNetwork}=await import(${JSON.stringify(childNetworkModule)});
const {NodeJsUdpSocket}=await import(${JSON.stringify(new URL('./NodeJsUdpSocket.js', childNetworkModule).href)});
const send=NodeJsUdpSocket.prototype.send;
NodeJsUdpSocket.prototype.send=function(host,port,data){return send.call(this,host,port===5540&&(host==='127.0.0.1'||host==='::1')?${devicePort}:port,data);};
const getIpMac=NodeJsNetwork.prototype.getIpMac;
NodeJsNetwork.prototype.getIpMac=function(name){const r=getIpMac.call(this,name);return r&&name==='lo'?{...r,mac:'02:00:00:00:00:01',ipV6:[]}:r;};
NodeJsNetwork.prototype.getNetInterfaces=()=>[{name:'lo',type:2}];
const connectTcp=NodeJsNetwork.prototype.connectTcp;
NodeJsNetwork.prototype.connectTcp=function(host,port,options){return connectTcp.call(this,/^fe[89ab][0-9a-f]*:.*%lo$/i.test(host)?'::1':host,port,options);};
`, { mode: 0o600 });

  const jobs = new Set(), sockets = new Set(), pending = new Map(), events = [];
  let camera, media, controller, ws, remote, requestId = 0, nightMode = 'auto', failNightWrite = false;
  const source = createServer((request, response) => {
    const args = request.url === '/cam.ts'
      ? ['-re', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=12', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', '-tune', 'zerolatency', '-g', '12', '-f', 'mpegts', 'pipe:1']
      : request.url === '/audio.ogg'
        ? ['-re', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-c:a', 'libopus', '-ar', '48000', '-ac', '2', '-f', 'ogg', '-page_duration', '20000', 'pipe:1'] : undefined;
    if (!args) { response.writeHead(404); response.end(); return; }
    const child = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', ...args], { stdio: ['ignore', 'pipe', 'ignore'] });
    jobs.add(child); child.once('close', () => jobs.delete(child));
    response.writeHead(200); response.flushHeaders(); child.stdout.pipe(response);
    response.once('close', () => child.kill('SIGTERM'));
  });
  source.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  const received = { video: 0, audio: 0 };
  const rpc = (command, args = {}) => new Promise((resolve, reject) => {
    const id = String(++requestId);
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Matter Server timed out: ${command}`)); }, 20000);
    pending.set(id, { resolve(value) { clearTimeout(timer); resolve(value); }, reject(error) { clearTimeout(timer); reject(error); } });
    ws.send(JSON.stringify({ message_id: id, command, args }));
  });
  try {
    await new Promise(resolve => source.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${source.address().port}`;
    const runtime = { ensureReady: async () => `${base}/cam.ts`,
      audioSource: () => ({ url: `${base}/audio.ogg`, format: 'ogg', sampleRate: 48000, channels: 2 }),
      async getNightVision() { return { mode: nightMode }; },
      async setNightVision(mode) { if (failNightWrite) throw new Error('Synthetic control failure'); nightMode = mode; return { mode }; },
    };
    media = createMatterMedia({ runtime, ffmpegPath: ffmpeg, config: { matterLoopbackIce: true }, snapshotDelegate: {
      handleSnapshotRequest(options, callback) {
        execFile(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc=size=${options.width}x${options.height}:rate=1`,
          '-frames:v', '1', '-c:v', 'mjpeg', '-f', 'image2pipe', 'pipe:1'], { encoding: 'buffer', maxBuffer: 1000000 }, callback);
      },
    } });
    const options = { storagePath: path.join(dir, 'device'), name: 'Synthetic camera interoperability QA', serialNumber: 'synthetic-interoperability',
      networkInterface: 'lo', port: devicePort, media, runtime, config: { width: 640, height: 360, frameRate: 12, nightVision: true, enableTalkback: true,
        listeningAddressIpv4: '127.0.0.1', listeningAddressIpv6: '::1' } };
    camera = await createMatterDevice(options); await camera.start(); Logger.level = 'fatal';
    const port = await freePort();
    controller = spawn(process.execPath, ['--import', preloadPath, bin, '--storage-path', path.join(dir, 'controller'),
      '--port', String(port), '--listen-address', '127.0.0.1', '--primary-interface', 'lo', '--log-level', 'fatal',
      '--dcl-offline', '--enable-test-net-dcl', '--disable-ota', '--disable-dashboard', '--disable-thread-diagnostics'],
    { cwd: dir, stdio: ['ignore', 'ignore', 'ignore'] });
    const start = Date.now();
    while (!ws) {
      try {
        ws = await new Promise((resolve, reject) => {
          const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
          socket.onopen = () => resolve(socket); socket.onerror = () => reject(new Error('Server is starting'));
        });
      } catch { assert.ok(Date.now() - start < 15000 && controller.exitCode === null, 'Isolated Matter Server failed to start'); await delay(100); }
    }
    ws.onmessage = message => {
      const value = JSON.parse(String(message.data));
      if (value.message_id !== undefined) {
        const waiter = pending.get(String(value.message_id));
        if (!waiter) return;
        pending.delete(String(value.message_id));
        if (value.error_code !== undefined) waiter.reject(new Error(`Matter Server error ${value.error_code}`));
        else waiter.resolve(value.result);
      } else if (value.event) events.push(value);
    };
    await rpc('start_listening');
    const [{ passcode }] = QrPairingCodeCodec.decode(camera.pairing().qrPairingCode);
    const node = await rpc('commission_on_network', { setup_pin_code: passcode, ip_addr: '127.0.0.1', discovery_timeout_s: 10 });
    assert.equal(camera.status().commissioned, true);
    assert.ok(node.attributes['1/29/0'].some(type => (type.deviceType ?? type.device_type ?? type[0]) === 0x0142));
    const target = { node_id: node.node_id, endpoint_id: 1 };
    const capabilities = await rpc('camera_get_capabilities', target);
    assert.ok(capabilities.video.codecs.includes('H264'));
    assert.ok(capabilities.audio.codecs.includes('OPUS'));
    assert.ok(capabilities.snapshot.capabilities.some(item => item.image_codec === 'JPEG'));

    const snapshot = await rpc('camera_snapshot', { ...target, resolution: { width: 320, height: 180 }, codec: 'JPEG' });
    assert.ok(snapshot && JSON.stringify(snapshot).length > 1000, 'Snapshot payload was empty');
    const write = (attribute, value) => rpc('write_attribute', { node_id: node.node_id, attribute_path: `1/1361/${attribute}`, value });
    const read = attribute => rpc('read_attribute', { node_id: node.node_id, attribute_path: `1/1361/${attribute}` });
    assert.equal((await write(22, 1))[0].Status, 0);
    assert.equal(nightMode, 'on');
    failNightWrite = true;
    assert.notEqual((await write(22, 0))[0].Status, 0);
    failNightWrite = false;
    assert.equal((await read(22))['1/1361/22'], 1, 'Failed hardware write changed the reported mode');

    const codecs = { video: [new RTCRtpCodecParameters({ mimeType: 'video/H264', clockRate: 90000, payloadType: 96,
      parameters: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f' })],
    audio: [new RTCRtpCodecParameters({ mimeType: 'audio/opus', clockRate: 48000, channels: 2, payloadType: 111,
      parameters: 'minptime=10;useinbandfec=1' })] };
    remote = new RTCPeerConnection({ bundlePolicy: 'max-bundle', iceServers: [], iceUseIpv6: false, iceUseTcp: false,
      iceAdditionalHostAddresses: ['127.0.0.1'], codecs });
    remote.onTrack.subscribe(track => track.onReceiveRtp.subscribe(() => received[track.kind]++));
    remote.addTransceiver('video', { direction: 'recvonly' }); remote.addTransceiver('audio', { direction: 'recvonly' });
    await remote.setLocalDescription(await remote.createOffer());
    const stream = await rpc('camera_start_stream', { ...target, stream_usage: 'LiveView', sdp: remote.localDescription.sdp,
      video: { codecs: ['H264'], min_resolution: { width: 640, height: 360 }, max_resolution: { width: 640, height: 360 },
        min_frame_rate: 12, max_frame_rate: 12 }, audio: { codecs: ['OPUS'], sample_rate: 48000, channel_count: 1, bit_rate: 24000 },
      client_session_key: 'synthetic-interoperability' });
    assert.ok(stream.video && stream.audio);
    let answer;
    await until(() => (answer = events.find(event => event.event === 'webrtc_callback' && event.data.event_type === 'answer')),
      'Camera did not send its Matter Requestor answer');
    await remote.setRemoteDescription({ type: 'answer', sdp: answer.data.data.sdp });
    await until(() => remote.connectionState === 'connected' && received.video > 30 && received.audio > 60,
      'Authenticated camera stream did not deliver H264 and Opus');
    assert.equal((await write(29, true))[0].Status, 0);
    assert.equal(media.status().microphoneMuted, true);
    await delay(100); const settledAudio = received.audio; await delay(400);
    assert.equal(received.audio, settledAudio, 'Muted microphone continued sending RTP');
    assert.equal((await write(29, false))[0].Status, 0);
    await until(() => received.audio > settledAudio + 10, 'Microphone audio did not resume');

    const stopped = await rpc('camera_stop_stream', { ...target, webrtc_session_id: stream.webrtc_session_id });
    assert.equal(stopped.ended, true);
    assert.equal(camera.status().activeSessions, 0);
    assert.equal(media.status().active, false);
    await remote.close(); remote = undefined;
    async function releaseStreams(result) {
      for (const kind of ['video', 'audio']) if (result[kind])
        await rpc('camera_release_stream', { ...target, kind, stream_id: result[kind].stream_id });
    }
    await releaseStreams(stream);
    async function additionalMediaCase({ key, video = true, audio = true, trickle = false }) {
      remote = new RTCPeerConnection({ bundlePolicy: 'max-bundle', iceServers: [], iceUseIpv6: false, iceUseTcp: false,
        iceAdditionalHostAddresses: ['127.0.0.1'], codecs: trickle ? { ...codecs, video: [
          new RTCRtpCodecParameters({ mimeType: 'video/H264', clockRate: 90000, payloadType: 106,
            parameters: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f' }), ...codecs.video,
        ] } : codecs });
      const localCandidates = [];
      remote.onIceCandidate.subscribe(candidate => { if (candidate) localCandidates.push({ candidate: candidate.candidate,
        sdpMid: candidate.sdpMid ?? null, sdpMLineIndex: candidate.sdpMLineIndex ?? null }); });
      if (video) remote.addTransceiver('video', { direction: 'recvonly' });
      if (audio) remote.addTransceiver('audio', { direction: trickle ? 'sendrecv' : 'recvonly' });
      let packets = 0;
      remote.onTrack.subscribe(track => track.onReceiveRtp.subscribe(() => packets++));
      await remote.setLocalDescription(await remote.createOffer());
      const eventOffset = events.length;
      const offer = trickle ? remote.localDescription.sdp.replace(/^a=candidate:.*\r?\n/gm, '').replace(/^a=end-of-candidates.*\r?\n/gm, '')
        : remote.localDescription.sdp;
      // Broad codec hints, a sending audio transceiver with no microphone track,
      // multiple H264 profiles (an incompatible profile first), and candidates
      // racing the start response mirror Chromium's frontend. The sender must
      // constrain codec selection before applying this remote offer.
      const starting = rpc('camera_start_stream', { ...target, stream_usage: 'LiveView', sdp: offer,
        video: video ? { codecs: ['H264'] } : false, audio: audio ? { codecs: ['OPUS'] } : false,
        allow_eviction: false, ...(trickle ? { talkback: true } : {}), client_session_key: key });
      const earlyIce = trickle ? rpc('camera_provide_ice_candidates', { ...target, client_session_key: key,
        ice_candidates: localCandidates }).then(() => ({ ok: true }), () => ({ ok: false })) : undefined;
      const result = await starting;
      if (earlyIce) assert.equal((await earlyIce).ok, true, 'Candidates arriving before the start response were rejected');
      let answerEvent;
      await until(() => (answerEvent = events.slice(eventOffset).find(event => event.event === 'webrtc_callback'
        && event.data.event_type === 'answer' && event.data.client_session_key === key)), `${key}: Matter answer was missing`);
      await remote.setRemoteDescription({ type: 'answer', sdp: answerEvent.data.data.sdp });
      await until(() => remote.connectionState === 'connected' && packets > 15, `${key}: media did not connect`);
      assert.equal((await rpc('camera_stop_stream', { ...target, webrtc_session_id: result.webrtc_session_id })).ended, true);
      assert.equal(camera.status().activeSessions, 0, `${key}: camera resources leaked after stop`);
      assert.equal(media.status().active, false, `${key}: media resources leaked after stop`);
      await remote.close(); remote = undefined;
      await releaseStreams(result);
    }
    await additionalMediaCase({ key: 'video-only', audio: false });
    await additionalMediaCase({ key: 'audio-only', video: false });
    await additionalMediaCase({ key: 'chromium-like-restart', trickle: true });
    await camera.close(); camera = await createMatterDevice(options); await camera.start(); Logger.level = 'fatal';
    assert.equal(camera.status().commissioned, true, 'Paired fabric was lost on restart');
    assert.equal(camera.status().activeSessions, 0);
    assert.equal(camera.status().videoStreams, 0);
    assert.equal(camera.status().audioStreams, 0);
    const identity = await rpc('read_attribute', { node_id: node.node_id, attribute_path: '1/29/0' });
    assert.ok(identity['1/29/0'].some(type => (type.deviceType ?? type.device_type ?? type[0]) === 0x0142), 'CASE reconnect failed after camera restart');
    if (process.env.MATTER_QA_RESULT) await writeFile(process.env.MATTER_QA_RESULT, JSON.stringify({
      controller: 'matter-server@1.5.3', commissioned: true, deviceType: 0x0142, snapshot: true,
      authenticatedWebRtc: true, packets: received, microphoneMuteAndResume: true, verifiedNightWrite: true,
      failedNightWriteRollsBack: true, stopCleanup: true, videoOnly: true, audioOnly: true, chromiumLikeTrickleRestart: true, chromiumMultipleH264Profiles: true, fabricSurvivesRestart: true, caseReconnect: true,
      testTransport: 'Loopback-only NIC and TCP routing adapter; no user fabric or physical camera',
    }, null, 2));
  } finally {
    for (const waiter of pending.values()) waiter.reject(new Error('Test is closing'));
    ws?.close(); await remote?.close(); await camera?.close().catch(() => {}); await media?.close();
    if (controller && controller.exitCode === null) {
      controller.kill('SIGTERM');
      await Promise.race([new Promise(resolve => controller.once('exit', resolve)), delay(3000)]);
      if (controller.exitCode === null) controller.kill('SIGKILL');
    }
    for (const child of jobs) child.kill('SIGTERM'); for (const socket of sockets) socket.destroy();
    await new Promise(resolve => source.close(resolve));
    NodeJsNetwork.prototype.getIpMac = getIpMac;
    NodeJsNetwork.prototype.getNetInterfaces = getNetInterfaces;
    NodeJsNetwork.prototype.connectTcp = connectTcp;
    await rm(dir, { recursive: true, force: true });
  }
});
