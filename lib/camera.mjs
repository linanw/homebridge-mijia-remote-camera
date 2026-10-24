import { spawn } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { isIP } from 'node:net';
import { request as httpRequest } from 'node:http';

const MEDIA_REASONS = new Set(['media_unavailable', 'closed', 'source_not_ready', 'source_timeout', 'source_invalid',
  'snapshot_busy', 'snapshot_timeout', 'snapshot_too_large', 'snapshot_invalid', 'ffmpeg_missing', 'ffmpeg_permission',
  'ffmpeg_spawn', 'ffmpeg_exit', 'ffmpeg_cpu_unsupported', 'input_timeout', 'input_unavailable', 'input_invalid',
  'decode_failed', 'encoder_unavailable', 'encode_failed', 'udp_unreachable', 'udp_in_use', 'udp_error',
  'invalid_prepare', 'invalid_stream', 'start_timeout', 'prepare_timeout', 'receiver_timeout', 'stream_stopped', 'stream_reset',
  'audio_source_unavailable', 'audio_source_invalid', 'audio_negotiation_invalid', 'audio_timeout', 'audio_muted',
  'talkback_unavailable', 'talkback_invalid', 'talkback_timeout', 'talkback_overflow', 'talkback_muted']);
const SIGNALS = new Set(['SIGTERM', 'SIGKILL', 'SIGILL', 'SIGABRT', 'SIGSEGV', 'SIGBUS', 'SIGFPE']);
const EVENTS = new Set(['snapshot_requested', 'snapshot_success', 'snapshot_failure', 'stream_prepared',
  'stream_start', 'stream_first_frame', 'stream_failure', 'stream_stop', 'stream_rtcp_first',
  'audio_start', 'audio_first_frame', 'audio_failure', 'audio_stop', 'talkback_start', 'talkback_first_frame', 'talkback_failure', 'talkback_stop']);
const safeReason = (value, fallback = 'media_unavailable') => MEDIA_REASONS.has(value) ? value : fallback;
const safeExit = value => Number.isInteger(value) && value >= 0 && value <= 65535 ? value : null;
const safeSignal = value => SIGNALS.has(value) ? value : null;
const error = (reason, code, signal) => Object.assign(new Error('摄像头暂不可用，请在插件设置中检查米家连接。'),
  { reason: safeReason(reason), exitCode: safeExit(code), signal: safeSignal(signal) });
const elapsed = started => Math.max(0, Math.floor(performance.now() - started));
function spawnReason(failure) {
  return ({ ENOENT: 'ffmpeg_missing', EACCES: 'ffmpeg_permission', EPERM: 'ffmpeg_permission' })[failure?.code] || 'ffmpeg_spawn';
}
function stderrClassifier() {
  let tail = Buffer.alloc(0), reason;
  const patterns = [
    [/Unknown encoder|Encoder .*not found/i, 'encoder_unavailable'],
    [/Permission denied/i, 'ffmpeg_permission'],
    [/Connection timed out|Operation timed out/i, 'input_timeout'],
    [/Connection refused|Server returned [45]\d\d|HTTP error [45]\d\d/i, 'input_unavailable'],
    [/Error while decoding|Invalid NAL|Error parsing NAL/i, 'decode_failed'],
    [/Invalid data found|Could not find codec parameters|could not find.*codec/i, 'input_invalid'],
    [/Error while opening encoder|Error initializing.*encoder|Error setting.*profile/i, 'encode_failed'],
    [/Network is unreachable|No route to host/i, 'udp_unreachable'],
    [/Address already in use/i, 'udp_in_use'],
  ];
  return {
    consume(chunk) {
      const bytes = Buffer.isBuffer(chunk) ? chunk.subarray(-8192) : Buffer.from(String(chunk).slice(-8192)).subarray(-8192);
      tail = Buffer.concat([tail, bytes]).subarray(-8192);
      const value = tail.toString('utf8');
      for (const [pattern, category] of patterns) if (pattern.test(value)) { reason = category; break; }
    },
    failure(code, signal) { return signal === 'SIGILL' ? 'ffmpeg_cpu_unsupported' : reason || 'ffmpeg_exit'; },
    clear() { tail = Buffer.alloc(0); },
  };
}
const once = callback => {
  let called = false;
  return (...args) => { if (!called) { called = true; callback(...args); } };
};
function number(value, fallback, min, max) {
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}
function safeSource(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.search || url.hash || url.pathname !== '/cam.ts'
      || !/^\d+$/.test(url.port) || +url.port < 1024 || +url.port > 65535) throw error('source_invalid');
    return url.href;
  } catch { throw error('source_invalid'); }
}
function sourceArgs(source) {
  return ['-hide_banner', '-nostdin', '-loglevel', 'error', '-rw_timeout', '8000000',
    '-analyzeduration', '1500000', '-probesize', '2000000', '-f', 'mpegts', '-i', source];
}
function safeAudioSource(value, talk = false) {
  try {
    const url = new URL(value?.url);
    const formats = talk ? { '/talk.pcm': 's16le', '/talk.ogg': 'ogg' } : { '/audio.wav': 'wav', '/audio.ogg': 'ogg' };
    const format = formats[url.pathname];
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.search || url.hash || !format
      || !/^\d+$/.test(url.port) || +url.port < 1024 || +url.port > 65535
      || (value.format && value.format !== format)
      || ![8000, 16000, 24000, 48000].includes(value.sampleRate)
      || ![1, 2].includes(value.channels)) throw 0;
    if (talk && ((format === 's16le' && (value.sampleRate !== 8000 || value.channels !== 1))
      || (format === 'ogg' && (value.sampleRate !== 48000 || value.channels !== 2)))) throw 0;
    return { url: url.href, format, sampleRate: value.sampleRate, channels: value.channels };
  } catch { throw error(talk ? 'talkback_invalid' : 'audio_source_invalid'); }
}
function resize(width, height) {
  return `scale=${width}:${height}:force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2`;
}

/** Native Homebridge/HAP streaming delegate. All transport keys remain in memory. */
export class MijiaCameraDelegate {
  constructor({ api, log, runtime, config = {}, ffmpegPath, spawnProcess = spawn, onMediaEvent,
    startDeadlineMs = 7500, snapshotTimeoutMs = 10000, audioCompatibility = true }) {
    this.api = api;
    this.audioCompatibility = audioCompatibility === true;
    this.audioEnabled = this.audioCompatibility && config.enableAudio !== false;
    this.talkbackEnabled = this.audioEnabled && config.enableTalkback !== false && typeof runtime.talkSource === 'function';
    this.microphoneMuted = !this.audioEnabled;
    this.microphoneVolume = 100;
    this.speakerMuted = false;
    this.speakerVolume = 100;
    this.log = log;
    this.runtime = runtime;
    this.ffmpegPath = ffmpegPath || config.ffmpegPath || 'ffmpeg';
    this.spawnProcess = spawnProcess;
    this.onMediaEvent = typeof onMediaEvent === 'function' ? onMediaEvent : undefined;
    this.startDeadlineMs = number(startDeadlineMs, 7500, 1, 7500);
    this.snapshotTimeoutMs = number(snapshotTimeoutMs, 10000, 1, 10000);
    this.media = {
      snapshot: { requests: 0, successes: 0, failures: 0, lastRequestedAt: null, lastCompletedAt: null,
        lastElapsedMs: null, lastBytes: 0, lastFailure: null, lastFailureAt: null },
      stream: { prepared: 0, starts: 0, firstFrames: 0, failures: 0, stops: 0, rtcpPackets: 0,
        lastPreparedAt: null, lastStartedAt: null, lastFirstFrameAt: null, lastStoppedAt: null,
        lastRtcpAt: null, lastFailure: null, lastFailureAt: null },
      audio: { enabled: this.audioEnabled, state: this.audioEnabled ? 'waiting' : 'disabled', sourceReceived: false,
        starts: 0, firstFrames: 0, failures: 0, rtcpPackets: 0, lastFailure: null, lastEventAt: null },
      talkback: { enabled: this.talkbackEnabled, state: this.talkbackEnabled ? 'idle' : 'disabled',
        starts: 0, decodedBytes: 0, failures: 0, lastFailure: null, lastEventAt: null },
      lastEvent: null,
    };
    this.limits = {
      width: number(config.maxWidth, 640, 160, 1920),
      height: number(config.maxHeight, 360, 120, 1080),
      fps: number(config.maxFPS, 12, 1, 30),
      bitrate: number(config.maxBitrate, 700, 100, 4000),
    };
    this.sessions = new Map();
    this.jobs = new Set();
    this.snapshots = new Map();
    this.closed = false;
    // Audio packets are forwarded only from a validated, loopback-only camera source.
    this.controller = new api.hap.CameraController({
      cameraStreamCount: 1,
      delegate: this,
      streamingOptions: {
        supportedCryptoSuites: [0],
        ...(this.audioCompatibility ? { audio: { twoWayAudio: this.talkbackEnabled, codecs: [{ type: 'AAC-eld', samplerate: 16 }] } } : {}),
        video: {
          codec: { profiles: [0, 1, 2], levels: [0, 1, 2] },
          resolutions: [[320, 180, 30], [320, 240, 15], [320, 240, 30],
            [480, 270, 30], [480, 360, 30], [640, 360, 30], [640, 480, 30], [1280, 720, 30]],
        },
      },
    });
    this.controller.on?.('microphone-change', (muted, volume) => this.updateMicrophone(muted, volume));
    this.controller.on?.('speaker-change', (muted, volume) => this.updateSpeaker(muted, volume));
  }

  mediaEvent(type, details = {}) {
    if (!EVENTS.has(type)) return;
    const value = { type, at: new Date().toISOString() };
    for (const key of ['width', 'height', 'bytes', 'elapsedMs', 'rtcpPackets']) {
      if (Number.isSafeInteger(details[key]) && details[key] >= 0) value[key] = details[key];
    }
    if (MEDIA_REASONS.has(details.reason)) value.reason = details.reason;
    if (safeExit(details.exitCode) !== null) value.exitCode = details.exitCode;
    if (safeSignal(details.signal)) value.signal = details.signal;
    if (typeof details.cached === 'boolean') value.cached = details.cached;
    const snapshot = this.media.snapshot, stream = this.media.stream;
    const increment = (object, key) => { object[key] = Math.min(Number.MAX_SAFE_INTEGER, object[key] + 1); };
    if (type === 'snapshot_requested') { increment(snapshot, 'requests'); snapshot.lastRequestedAt = value.at; }
    if (type === 'snapshot_success' || type === 'snapshot_failure') {
      increment(snapshot, type === 'snapshot_success' ? 'successes' : 'failures');
      snapshot.lastCompletedAt = value.at; snapshot.lastElapsedMs = value.elapsedMs ?? null;
      snapshot.lastBytes = type === 'snapshot_success' ? value.bytes ?? 0 : 0;
      if (type === 'snapshot_failure') { snapshot.lastFailure = value.reason ?? 'media_unavailable'; snapshot.lastFailureAt = value.at; }
    }
    const transitions = { stream_prepared: ['prepared', 'lastPreparedAt'], stream_start: ['starts', 'lastStartedAt'],
      stream_first_frame: ['firstFrames', 'lastFirstFrameAt'], stream_stop: ['stops', 'lastStoppedAt'] };
    if (transitions[type]) { const [count, timestamp] = transitions[type]; increment(stream, count); stream[timestamp] = value.at; }
    if (type === 'stream_failure') { increment(stream, 'failures'); stream.lastFailure = value.reason ?? 'media_unavailable'; stream.lastFailureAt = value.at; }
    for (const [prefix, state] of [['audio', this.media.audio], ['talkback', this.media.talkback]]) {
      if (!type.startsWith(`${prefix}_`)) continue;
      state.lastEventAt = value.at;
      if (type === `${prefix}_start`) { increment(state, 'starts'); state.state = 'starting'; }
      if (type === `${prefix}_first_frame`) { if (prefix === 'audio') increment(state, 'firstFrames'); state.state = 'streaming'; }
      if (type === `${prefix}_failure`) { increment(state, 'failures'); state.lastFailure = value.reason ?? 'media_unavailable'; state.state = 'unavailable'; }
      if (type === `${prefix}_stop`) state.state = prefix === 'audio' ? (this.microphoneMuted ? 'muted' : 'waiting') : 'idle';
    }
    this.media.lastEvent = Object.freeze(value);
    try { Promise.resolve(this.onMediaEvent?.({ ...value })).catch(() => {}); } catch {}
  }

  getMediaDiagnostics() {
    const session = this.sessions.values().next().value;
    return { snapshot: { ...this.media.snapshot }, stream: { ...this.media.stream, state: session?.state || 'idle' },
      audio: { ...this.media.audio, muted: this.microphoneMuted }, talkback: { ...this.media.talkback, muted: this.speakerMuted },
      activeStreams: this.sessions.size, activeJobs: this.jobs.size,
      lastEvent: this.media.lastEvent ? { ...this.media.lastEvent } : null };
  }

  async source() {
    if (this.closed) throw error('closed');
    let timer;
    try {
      const source = await Promise.race([
        this.runtime.ensureReady({ timeoutMs: 3000 }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(error('source_timeout')), 3200); timer.unref(); }),
      ]);
      if (this.closed) throw error('closed');
      return safeSource(source);
    } catch (failure) {
      throw error(safeReason(failure?.reason, 'source_not_ready'));
    } finally { clearTimeout(timer); }
  }

  handleSnapshotRequest(request, callback) {
    const width = Math.min(number(request.width, 320, 2, 4096), this.limits.width);
    const height = Math.min(number(request.height, 180, 2, 4096), this.limits.height);
    const started = performance.now();
    this.mediaEvent('snapshot_requested', { width, height });
    const done = once((failure, buffer, cached = false) => {
      this.mediaEvent(failure ? 'snapshot_failure' : 'snapshot_success', { width, height, elapsedMs: elapsed(started), cached,
        ...(failure ? { reason: safeReason(failure?.reason), exitCode: failure?.exitCode, signal: failure?.signal } : { bytes: buffer.length }) });
      callback(failure ? error(failure?.reason) : undefined, buffer);
    });
    const key = `${width}x${height}`;
    const existing = this.snapshots.get(key);
    if (existing && existing.expires > Date.now()) {
      existing.promise.then(buffer => done(undefined, buffer, existing.expires !== Infinity), failure => done(failure));
      return;
    }
    for (const [cachedKey, entry] of this.snapshots) {
      if (entry.expires <= Date.now()) { clearTimeout(entry.timer); this.snapshots.delete(cachedKey); }
    }
    if ([...this.snapshots.values()].filter(entry => entry.expires === Infinity).length >= 2) {
      done(error('snapshot_busy')); return;
    }
    if (this.snapshots.size >= 4) {
      const staleKey = [...this.snapshots].find(([, entry]) => entry.expires !== Infinity)?.[0];
      if (staleKey !== undefined) {
        clearTimeout(this.snapshots.get(staleKey).timer);
        this.snapshots.delete(staleKey);
      }
    }
    const promise = this.snapshot(width, height);
    const entry = { promise, expires: Infinity };
    this.snapshots.set(key, entry);
    promise.then(() => {
      entry.expires = Date.now() + 3000;
      entry.timer = setTimeout(() => {
        if (this.snapshots.get(key) === entry) this.snapshots.delete(key);
      }, 3000);
      entry.timer.unref();
    }, () => { if (this.snapshots.get(key) === entry) this.snapshots.delete(key); });
    promise.then(buffer => done(undefined, buffer), failure => done(failure));
  }

  async snapshot(width, height) {
    const source = await this.source();
    return new Promise((resolve, reject) => {
      let process;
      let output = Buffer.alloc(0);
      let timer;
      const diagnostic = stderrClassifier();
      const finish = once((failure, buffer) => {
        clearTimeout(timer);
        diagnostic.clear();
        if (process) this.jobs.delete(process);
        failure ? reject(failure) : resolve(buffer);
      });
      try {
        process = this.spawnProcess(this.ffmpegPath, [
          ...sourceArgs(source), '-map', '0:v:0', '-an', '-sn', '-dn',
          '-vf', resize(width, height), '-frames:v', '1', '-threads', '1',
          '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1',
        ], { stdio: ['ignore', 'pipe', 'pipe'] });
        this.jobs.add(process);
        process.stderr?.on('data', data => diagnostic.consume(data));
        process.stdout.on('data', data => {
          if (output.length + data.length > 8 * 1024 * 1024) {
            finish(error('snapshot_too_large'));
            this.kill(process);
          } else output = Buffer.concat([output, data]);
        });
        process.once('error', failure => finish(error(spawnReason(failure))));
        process.once('close', (code, signal) => {
          const jpeg = code === 0 && output.length > 4 && output[0] === 0xff && output[1] === 0xd8;
          finish(jpeg ? undefined : error(code === 0 ? 'snapshot_invalid' : diagnostic.failure(code, signal), code, signal), output);
        });
        timer = setTimeout(() => { finish(error('snapshot_timeout')); this.kill(process); }, this.snapshotTimeoutMs);
        timer.unref();
      } catch (failure) { finish(error(spawnReason(failure))); }
    });
  }

  prepareStream(request, callback) {
    const done = once(callback);
    const source = request.video, audio = request.audio;
    const validAudio = !this.audioCompatibility || (audio && Number.isInteger(audio.port) && audio.port >= 1 && audio.port <= 65535
      && audio.srtpCryptoSuite === 0 && Buffer.isBuffer(audio.srtp_key) && audio.srtp_key.length === 16
      && Buffer.isBuffer(audio.srtp_salt) && audio.srtp_salt.length === 14);
    if (this.closed || typeof request.sessionID !== 'string' || request.sessionID.length > 128
      || this.sessions.size >= 1 || this.sessions.has(request.sessionID)
      || ![4, 6].includes(isIP(request.targetAddress))
      || (request.addressVersion === 'ipv6') !== (isIP(request.targetAddress) === 6)
      || !validAudio || !source || !Number.isInteger(source.port) || source.port < 1 || source.port > 65535
      || source.srtpCryptoSuite !== 0 || !Buffer.isBuffer(source.srtp_key) || source.srtp_key.length !== 16
      || !Buffer.isBuffer(source.srtp_salt) || source.srtp_salt.length !== 14) {
      this.mediaEvent('stream_failure', { reason: 'invalid_prepare' });
      done(error('invalid_prepare'));
      return;
    }
    let socket, audioSocket;
    try {
      const family = request.addressVersion === 'ipv6' ? 'udp6' : 'udp4';
      socket = createSocket(family);
      if (this.audioCompatibility) audioSocket = createSocket(family);
    } catch {
      try { socket?.close(); } catch {}
      this.mediaEvent('stream_failure', { reason: 'udp_error' }); done(error('udp_error')); return;
    }
    const session = {
      id: request.sessionID, socket, audioSocket, finishPrepare: done, address: request.targetAddress, port: source.port,
      crypto: Buffer.concat([source.srtp_key, source.srtp_salt]),
      key: Buffer.from(source.srtp_key), salt: Buffer.from(source.srtp_salt),
      ssrc: this.api.hap.CameraController.generateSynchronisationSource(), state: 'prepared',
      rtcpPackets: 0,
      ...(audioSocket ? { audioKey: Buffer.from(audio.srtp_key), audioSalt: Buffer.from(audio.srtp_salt), audioPort: audio.port,
        audioCrypto: Buffer.concat([audio.srtp_key, audio.srtp_salt]),
        audioSsrc: this.api.hap.CameraController.generateSynchronisationSource() } : {}),
    };
    this.sessions.set(session.id, session);
    const socketError = () => { this.failStream(session, 'udp_error'); done(error('udp_error')); };
    socket.on('error', socketError);
    audioSocket?.on('error', socketError);
    socket.on('message', (_buffer, remote) => {
      if (session.state === 'active' && remote.address === session.address) {
        session.rtcpPackets = Math.min(Number.MAX_SAFE_INTEGER, session.rtcpPackets + 1);
        this.media.stream.rtcpPackets = Math.min(Number.MAX_SAFE_INTEGER, this.media.stream.rtcpPackets + 1);
        this.media.stream.lastRtcpAt = new Date().toISOString();
        if (session.rtcpPackets === 1) this.mediaEvent('stream_rtcp_first', { rtcpPackets: 1 });
        this.keepAlive(session);
      }
    });
    audioSocket?.on('message', (buffer, remote) => {
      if (session.state !== 'active' || remote.address !== session.address || buffer.length < 8 || (buffer[0] >>> 6) !== 2) return;
      if (buffer[1] >= 192 && buffer[1] <= 223) {
        this.media.audio.rtcpPackets = Math.min(Number.MAX_SAFE_INTEGER, this.media.audio.rtcpPackets + 1);
        this.keepAlive(session);
      } else if (this.talkbackEnabled && !this.speakerMuted && buffer.length >= 12 && buffer.length <= 4096
        && (buffer[1] & 0x7f) === (session.audioRequest?.pt ?? 110)) {
        this.receiveTalkback(session, buffer);
      }
    });
    let bindings = audioSocket ? 2 : 1;
    const bound = () => {
      if (--bindings > 0) return;
      if (!this.sessions.has(session.id) || this.closed) { this.stopStream(session.id); done(error()); return; }
      session.timer = setTimeout(() => this.expire(session.id), 15000);
      session.timer.unref();
      this.mediaEvent('stream_prepared');
      done(undefined, { video: {
        port: socket.address().port, ssrc: session.ssrc,
        srtp_key: Buffer.from(session.key), srtp_salt: Buffer.from(session.salt),
      }, ...(audioSocket ? { audio: { port: audioSocket.address().port, ssrc: session.audioSsrc,
        srtp_key: Buffer.from(session.audioKey), srtp_salt: Buffer.from(session.audioSalt) } } : {}) });
    };
    try { socket.bind(0, bound); audioSocket?.bind(0, bound); }
    catch { socketError(); }
  }

  handleStreamRequest(request, callback) {
    const done = once(callback);
    if (request.type === 'stop') { this.stopStream(request.sessionID); done(); return; }
    if (request.type === 'reconfigure') {
      this.sessions.has(request.sessionID) ? done() : done(error());
      return;
    }
    if (request.type !== 'start') { this.mediaEvent('stream_failure', { reason: 'invalid_stream' }); done(error('invalid_stream')); return; }
    this.startStream(request, done).catch(() => {
      const session = this.sessions.get(request.sessionID);
      if (session) this.failStream(session, 'media_unavailable');
      done(error());
    });
  }

  failStream(session, reason, details = {}) {
    if (this.sessions.get(session.id) !== session) return;
    const safe = safeReason(reason);
    this.mediaEvent('stream_failure', { ...details, reason: safe,
      ...(session.started === undefined ? {} : { elapsedMs: elapsed(session.started) }) });
    this.stopStream(session.id, safe);
    session.finishStart?.(error(safe));
    try { this.controller.forceStopStreamingSession(session.id); } catch {}
  }

  async startStream(request, callback) {
    const session = this.sessions.get(request.sessionID);
    const done = once(callback);
    if (!session || session.state !== 'prepared') {
      this.mediaEvent('stream_failure', { reason: 'invalid_stream' }); done(error('invalid_stream')); return;
    }
    session.state = 'starting';
    session.started = performance.now();
    session.deadline = session.started + this.startDeadlineMs;
    session.finishStart = done;
    clearTimeout(session.timer);
    session.timer = setTimeout(() => this.failStream(session, 'start_timeout'), this.startDeadlineMs);
    session.timer.unref();
    this.mediaEvent('stream_start');
    let source;
    try { source = await this.source(); }
    catch (failure) { this.failStream(session, safeReason(failure?.reason, 'source_not_ready')); return; }
    if (this.sessions.get(session.id) !== session || this.closed) { done(error('stream_stopped')); return; }
    if (performance.now() >= session.deadline) { this.failStream(session, 'start_timeout'); return; }
    const video = request.video || {};
    session.audioRequest = request.audio;
    const width = Math.min(number(video.width, 640, 2, 4096), this.limits.width);
    const height = Math.min(number(video.height, 360, 2, 4096), this.limits.height);
    const fps = Math.min(number(video.fps, this.limits.fps, 1, 60), this.limits.fps);
    const bitrate = Math.min(number(video.max_bit_rate, this.limits.bitrate, 1, 10000), this.limits.bitrate);
    const payload = number(video.pt, 99, 96, 127);
    const mtu = Math.min(number(video.mtu, 1316, 376, 9000), 1316);
    const address = isIP(session.address) === 6 ? `[${session.address}]` : session.address;
    const target = `srtp://${address}:${session.port}?rtcpport=${session.port}&pkt_size=${mtu}`;
    const args = [...sourceArgs(source), '-map', '0:v:0', '-an', '-sn', '-dn',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-profile:v', ['baseline', 'main', 'high'][video.profile] || 'baseline',
      '-level:v', ['3.1', '3.2', '4.0'][video.level] || '3.1', '-preset', 'ultrafast', '-tune', 'zerolatency',
      '-threads', '2', '-vf', resize(width, height), '-r', String(fps),
      '-b:v', `${bitrate}k`, '-maxrate', `${bitrate}k`, '-bufsize', `${bitrate * 2}k`,
      '-payload_type', String(payload), '-ssrc', String(session.ssrc), '-f', 'rtp',
      '-srtp_out_suite', 'AES_CM_128_HMAC_SHA1_80', '-srtp_out_params', session.crypto.toString('base64'),
      '-progress', 'pipe:1', '-nostats', target];
    let process;
    const diagnostic = stderrClassifier();
    let progress = '';
    try {
      process = this.spawnProcess(this.ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      session.process = process;
      this.jobs.add(process);
      process.stderr?.on('data', data => diagnostic.consume(data));
      process.stdout.on('data', data => {
        if (this.sessions.get(session.id) !== session || session.state !== 'starting') return;
        if (performance.now() >= session.deadline) { this.failStream(session, 'start_timeout'); return; }
        const bytes = Buffer.isBuffer(data) ? data.subarray(-8192) : Buffer.from(String(data).slice(-8192)).subarray(-8192);
        progress += bytes.toString('utf8');
        if (progress.length > 16384) { this.failStream(session, 'media_unavailable'); return; }
        let newline;
        while ((newline = progress.indexOf('\n')) >= 0) {
          const line = progress.slice(0, newline).trim(); progress = progress.slice(newline + 1);
          if (/^frame=\s*[1-9]\d*$/.test(line)) {
            session.state = 'active'; progress = '';
            this.mediaEvent('stream_first_frame', { elapsedMs: elapsed(session.started) });
            this.keepAlive(session);
            if (this.audioEnabled) void this.startAudio(session);
            done();
            break;
          }
        }
      });
      process.once('error', failure => this.failStream(session, spawnReason(failure)));
      process.once('close', (code, signal) => {
        this.jobs.delete(process);
        if (this.sessions.get(session.id) === session) {
          this.failStream(session, diagnostic.failure(code, signal), { exitCode: code, signal });
        }
        diagnostic.clear();
      });
    } catch (failure) { this.failStream(session, spawnReason(failure)); }
  }

  updateMicrophone(muted, volume) {
    this.microphoneMuted = muted === true || !this.audioEnabled;
    this.microphoneVolume = number(volume, this.microphoneVolume, 0, 100);
    for (const session of this.sessions.values()) {
      const process = session.audioProcess;
      if (process?.stdin?.writable && !process.stdin.destroyed && process.stdin.writableLength < 4096) {
        // Keep the SRTP sequence number and rollover counter intact while changing volume.
        // This private stdin receives only a fixed filter command with our bounded numeric value.
        try {
          process.stdin.write(`cvolume -1 volume ${this.microphoneMuted ? 0 : this.microphoneVolume / 100}\n`);
          if (!this.microphoneMuted) this.media.audio.state = session.audioHasFrame ? 'streaming' : 'starting';
          continue;
        } catch {}
      }
      this.stopAudio(session);
      if (session.state === 'active' && !this.microphoneMuted) void this.startAudio(session);
    }
    if (this.microphoneMuted) this.media.audio.state = this.audioEnabled ? 'muted' : 'disabled';
  }

  updateSpeaker(muted, volume) {
    this.speakerMuted = muted === true;
    this.speakerVolume = number(volume, this.speakerVolume, 0, 100);
    for (const session of this.sessions.values()) this.stopTalkback(session);
    if (this.speakerMuted && this.talkbackEnabled) this.media.talkback.state = 'muted';
  }

  scheduleAudio(session) {
    clearTimeout(session.audioPoll);
    if (this.sessions.get(session.id) !== session || session.state !== 'active' || this.microphoneMuted || !this.audioEnabled) return;
    session.audioPoll = setTimeout(() => { session.audioPoll = undefined; void this.startAudio(session); }, 2000);
    session.audioPoll.unref();
  }

  async startAudio(session) {
    if (this.sessions.get(session.id) !== session || session.state !== 'active' || this.microphoneMuted || !this.audioEnabled
      || session.audioProcess || session.audioStarting) return;
    if (typeof this.runtime.audioSource !== 'function') { this.media.audio.state = 'unavailable'; this.media.audio.lastFailure = 'audio_source_unavailable'; return; }
    const starting = Symbol('audio-start');
    session.audioStarting = starting;
    const generation = session.audioGeneration || 0;
    try {
      const value = await this.runtime.audioSource();
      if (this.sessions.get(session.id) !== session || session.state !== 'active' || this.microphoneMuted || (session.audioGeneration || 0) !== generation) return;
      if (!value) { this.media.audio.state = 'waiting'; this.scheduleAudio(session); return; }
      const source = safeAudioSource(value), audio = session.audioRequest;
      this.media.audio.sourceReceived = true;
      if (!session.audioCrypto || !audio || audio.codec !== 'AAC-eld' || audio.sample_rate !== 16 || audio.channel !== 1
        || !Number.isInteger(audio.pt) || audio.pt < 96 || audio.pt > 127) throw error('audio_negotiation_invalid');
      const address = isIP(session.address) === 6 ? `[${session.address}]` : session.address;
      const target = `srtp://${address}:${session.audioPort}?rtcpport=${session.audioPort}&pkt_size=188`;
      const args = ['-hide_banner', '-stdin', '-loglevel', 'error', '-rw_timeout', '8000000',
        '-analyzeduration', '0', '-probesize', '32768', '-f', source.format, '-i', source.url,
        '-map', '0:a:0', '-vn', '-sn', '-dn', '-c:a', 'libfdk_aac', '-profile:a', 'aac_eld',
        '-frame_length', '480', '-flags', '+global_header', '-ar', '16000', '-ac', '1',
        '-af', `volume=${this.microphoneVolume / 100}`, '-b:a', `${number(audio.max_bit_rate, 24, 8, 128)}k`,
        '-payload_type', String(audio.pt), '-ssrc', String(session.audioSsrc), '-f', 'rtp',
        '-srtp_out_suite', 'AES_CM_128_HMAC_SHA1_80', '-srtp_out_params', session.audioCrypto.toString('base64'),
        '-progress', 'pipe:1', '-nostats', target];
      const process = this.spawnProcess(this.ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      session.audioProcess = process; session.audioHasFrame = false; this.jobs.add(process); this.mediaEvent('audio_start');
      const diagnostic = stderrClassifier(); let progress = '', first = false;
      const failed = (reason, code, signal) => {
        if (session.audioProcess !== process) return;
        this.stopAudio(session); this.mediaEvent('audio_failure', { reason, exitCode: code, signal }); this.scheduleAudio(session);
      };
      process.stdin?.on('error', () => failed('ffmpeg_exit'));
      process.stderr?.on('data', bytes => diagnostic.consume(bytes));
      process.stdout?.on('data', bytes => {
        if (session.audioProcess !== process || first) return;
        progress += bytes.toString('utf8');
        if (progress.length > 16384) { failed('audio_timeout'); return; }
        let newline;
        while ((newline = progress.indexOf('\n')) >= 0) {
          const line = progress.slice(0, newline).trim(); progress = progress.slice(newline + 1);
          if (/^out_time_us=[1-9]\d*$/.test(line)) {
            first = true; session.audioHasFrame = true; clearTimeout(session.audioBootTimer); this.mediaEvent('audio_first_frame');
            if (this.microphoneMuted) this.media.audio.state = 'muted';
            break;
          }
        }
      });
      process.once('error', failure => failed(spawnReason(failure)));
      process.once('close', (code, signal) => {
        this.jobs.delete(process); failed(diagnostic.failure(code, signal), code, signal); diagnostic.clear();
      });
      session.audioBootTimer = setTimeout(() => failed('audio_timeout'), 10000); session.audioBootTimer.unref();
    } catch (failure) {
      if (this.sessions.get(session.id) === session && (session.audioGeneration || 0) === generation && !this.microphoneMuted) {
        this.mediaEvent('audio_failure', { reason: safeReason(failure?.reason, 'audio_source_unavailable') }); this.scheduleAudio(session);
      }
    } finally { if (session.audioStarting === starting) session.audioStarting = false; }
  }

  stopAudio(session) {
    session.audioGeneration = (session.audioGeneration || 0) + 1;
    session.audioStarting = false;
    clearTimeout(session.audioPoll); clearTimeout(session.audioBootTimer);
    session.audioPoll = undefined; session.audioBootTimer = undefined;
    const process = session.audioProcess; session.audioProcess = undefined;
    if (process) { this.kill(process); this.jobs.delete(process); this.mediaEvent('audio_stop'); }
  }

  receiveTalkback(session, bytes) {
    if (!this.talkbackEnabled || this.speakerMuted || this.sessions.get(session.id) !== session) return;
    if (!session.talkback) {
      const talk = { queue: [], queuedBytes: 0, starting: true, closed: false };
      session.talkback = talk;
      void this.startTalkback(session, talk);
    }
    const talk = session.talkback;
    if (!talk || talk.closed) return;
    clearTimeout(talk.idleTimer);
    talk.idleTimer = setTimeout(() => this.stopTalkback(session), 2000); talk.idleTimer.unref();
    if (talk.ready && talk.forwarder) {
      talk.forwarder.send(bytes, talk.port, '127.0.0.1', failure => { if (failure) this.failTalkback(session, talk, 'udp_error'); });
    } else if (talk.queuedBytes + bytes.length <= 64 * 1024) {
      const packet = Buffer.from(bytes); talk.queue.push(packet); talk.queuedBytes += packet.length;
    } else this.failTalkback(session, talk, 'talkback_overflow');
  }

  async startTalkback(session, talk) {
    let reservation;
    try {
      const value = await this.runtime.talkSource();
      if (talk.closed || session.talkback !== talk || this.sessions.get(session.id) !== session) return;
      if (!value) throw error('talkback_unavailable');
      const source = safeAudioSource(value, true);
      reservation = createSocket('udp4');
      await new Promise((resolve, reject) => { reservation.once('error', () => reject(error('udp_error'))); reservation.bind(0, '127.0.0.1', resolve); });
      talk.port = reservation.address().port;
      await new Promise(resolve => reservation.close(resolve)); reservation = undefined;
      if (talk.closed || session.talkback !== talk) return;
      const audio = session.audioRequest;
      if (!audio || audio.codec !== 'AAC-eld' || audio.sample_rate !== 16 || audio.channel !== 1) throw error('audio_negotiation_invalid');
      const sdp = Buffer.from(`v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=Camera talkback\r\nc=IN IP4 127.0.0.1\r\nt=0 0\r\nm=audio ${talk.port} RTP/SAVP ${audio.pt}\r\na=rtpmap:${audio.pt} MPEG4-GENERIC/16000/1\r\na=rtcp-mux\r\na=fmtp:${audio.pt} profile-level-id=1;mode=AAC-hbr;sizelength=13;indexlength=3;indexdeltalength=3;config=F8F0212C00BC00\r\na=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:${session.audioCrypto.toString('base64')}\r\n`);
      const output = source.format === 's16le' ? ['-c:a', 'pcm_s16le', '-ar', '8000', '-ac', '1', '-f', 's16le']
        : ['-c:a', 'libopus', '-application', 'lowdelay', '-frame_duration', '40', '-ar', '48000', '-ac', '2', '-f', 'ogg', '-page_duration', '40000'];
      const process = this.spawnProcess(this.ffmpegPath, ['-hide_banner', '-nostdin', '-loglevel', 'error',
        '-protocol_whitelist', 'file,pipe,udp,rtp,crypto', '-f', 'sdp', '-c:a', 'libfdk_aac', '-i', 'pipe:0',
        '-map', '0:a:0', '-vn', '-sn', '-dn', '-af', `volume=${this.speakerVolume / 100}`,
        ...output, 'pipe:1'], { stdio: ['pipe', 'pipe', 'pipe'] });
      talk.process = process; this.jobs.add(process);
      const diagnostic = stderrClassifier(); let first = false;
      const post = httpRequest(source.url, { method: 'POST', headers: { 'Content-Type': source.format === 'ogg' ? 'audio/ogg' : 'application/octet-stream' } }, response => {
        if (response.statusCode !== 200) this.failTalkback(session, talk, 'talkback_unavailable'); response.resume();
      });
      talk.post = post;
      post.on('error', () => this.failTalkback(session, talk, 'talkback_unavailable'));
      post.setTimeout(10000, () => this.failTalkback(session, talk, 'talkback_timeout'));
      process.stdin?.on('error', () => {});
      process.stderr?.on('data', bytes => diagnostic.consume(bytes));
      process.stdout?.on('data', bytes => {
        if (talk.closed || session.talkback !== talk) return;
        if (!first) { first = true; clearTimeout(talk.bootTimer); this.mediaEvent('talkback_first_frame'); }
        this.media.talkback.decodedBytes = Math.min(Number.MAX_SAFE_INTEGER, this.media.talkback.decodedBytes + bytes.length);
        if (post.writableLength > 256 * 1024) { this.failTalkback(session, talk, 'talkback_overflow'); return; }
        if (!post.write(bytes)) { process.stdout.pause(); post.once('drain', () => { if (!talk.closed) process.stdout.resume(); }); }
      });
      process.once('error', failure => this.failTalkback(session, talk, spawnReason(failure)));
      process.once('close', (code, signal) => {
        this.jobs.delete(process);
        if (!talk.closed) this.failTalkback(session, talk, diagnostic.failure(code, signal)); diagnostic.clear();
      });
      process.stdin.end(sdp, () => sdp.fill(0));
      talk.forwarder = createSocket('udp4');
      talk.forwarder.on('error', () => this.failTalkback(session, talk, 'udp_error'));
      this.mediaEvent('talkback_start');
      talk.bootTimer = setTimeout(() => this.failTalkback(session, talk, 'talkback_timeout'), 10000); talk.bootTimer.unref();
      talk.readyTimer = setTimeout(() => {
        if (talk.closed || session.talkback !== talk) return;
        talk.ready = true;
        for (const bytes of talk.queue) talk.forwarder.send(bytes, talk.port, '127.0.0.1', failure => {
          bytes.fill(0); if (failure) this.failTalkback(session, talk, 'udp_error');
        });
        talk.queue.length = 0; talk.queuedBytes = 0;
      }, 200); talk.readyTimer.unref();
    } catch (failure) { this.failTalkback(session, talk, safeReason(failure?.reason, 'talkback_unavailable')); }
    finally { try { reservation?.close(); } catch {} }
  }

  failTalkback(session, talk, reason) {
    if (session.talkback !== talk || talk.closed) return;
    this.stopTalkback(session); this.mediaEvent('talkback_failure', { reason });
  }

  stopTalkback(session) {
    const talk = session.talkback; session.talkback = undefined;
    if (!talk) return;
    talk.closed = true; clearTimeout(talk.idleTimer); clearTimeout(talk.readyTimer); clearTimeout(talk.bootTimer);
    for (const packet of talk.queue) packet.fill(0);
    talk.queue.length = 0; talk.queuedBytes = 0;
    try { talk.forwarder?.close(); } catch {}
    this.kill(talk.process); if (talk.process) this.jobs.delete(talk.process);
    talk.post?.end();
    const post = talk.post;
    if (post) { const timer = setTimeout(() => post.destroy(), 1000); timer.unref(); post.once('close', () => clearTimeout(timer)); }
    this.mediaEvent('talkback_stop');
  }

  keepAlive(session) {
    clearTimeout(session.timer);
    session.timer = setTimeout(() => this.expire(session.id), 30000);
    session.timer.unref();
  }

  expire(id) {
    const session = this.sessions.get(id);
    if (session) this.failStream(session, session.state === 'prepared' ? 'prepare_timeout' : 'receiver_timeout');
  }

  kill(process) {
    if (!process || process.exitCode !== null || process.signalCode) return;
    try { process.kill('SIGTERM'); } catch {}
    const timer = setTimeout(() => { try { process.kill('SIGKILL'); } catch {} }, 2000);
    timer.unref();
    process.once('close', () => clearTimeout(timer));
  }

  stopStream(id, reason = 'stream_stopped') {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    const starting = session.state === 'starting';
    session.state = 'stopped';
    clearTimeout(session.timer);
    this.stopAudio(session); this.stopTalkback(session);
    try { session.socket.close(); } catch {}
    try { session.audioSocket?.close(); } catch {}
    this.kill(session.process);
    if (session.process) this.jobs.delete(session.process);
    session.crypto.fill(0); session.key.fill(0); session.salt.fill(0);
    session.audioKey?.fill(0); session.audioSalt?.fill(0);
    session.audioCrypto?.fill(0);
    this.mediaEvent('stream_stop', { reason: safeReason(reason), rtcpPackets: session.rtcpPackets });
    session.finishPrepare?.(error(reason));
    if (starting) session.finishStart?.(error(reason));
  }

  reset() {
    for (const id of [...this.sessions.keys()]) this.stopStream(id, 'stream_reset');
    for (const process of this.jobs) this.kill(process);
    this.jobs.clear();
    for (const entry of this.snapshots.values()) clearTimeout(entry.timer);
    this.snapshots.clear();
  }

  resume() {
    this.reset();
    this.closed = false;
  }

  shutdown() {
    this.closed = true;
    this.reset();
  }
}
