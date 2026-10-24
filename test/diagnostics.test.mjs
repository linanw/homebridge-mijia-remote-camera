import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { safeDiagnostics } from '../lib/diagnostics.mjs';
import { startRpcServer } from '../lib/rpc.mjs';
import { MijiaCameraDelegate } from '../lib/camera.mjs';

test('shareable diagnostics discard endpoints, credentials, device identifiers and unknown error strings', () => {
  const result = safeDiagnostics({ state: 'starting', reason: 'starting', stage: 'relay_connect', ready: false,
    vendor: 4, attempt: 2, connectingElapsedSeconds: 32, lastFailure: 'connect_timeout',
    lastFailureAt: '2026-10-23T08:00:00.000Z', userId: 'PRIVATE_USER', deviceId: 'PRIVATE_DID',
    sourceUrl: 'http://127.0.0.1/private', passToken: 'PRIVATE_PASS', credentials: { secret: 'PRIVATE_KEY' } });
  assert.equal(result.stage, 'relay_connect');
  assert.equal(result.lastFailure, 'connect_timeout');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|sourceUrl|credentials|userId|deviceId/);
  assert.deepEqual(safeDiagnostics({ state: 'PRIVATE', reason: 'PRIVATE', stage: 'PRIVATE', lastFailure: 'PRIVATE', vendor: 999 }), {});
});

test('media diagnostics retain the real camera producer schema, including zero requests and typed failures', () => {
  const camera = new MijiaCameraDelegate({ api: { hap: { CameraController: class {} } }, runtime: {} });
  const idle = camera.getMediaDiagnostics();
  assert.equal(idle.snapshot.requests, 0);
  assert.equal(idle.stream.starts, 0);
  assert.deepEqual(safeDiagnostics({ media: idle }).media, idle);
  camera.mediaEvent('snapshot_requested', { width: 320, height: 180 });
  camera.mediaEvent('snapshot_success', { width: 320, height: 180, bytes: 9107, elapsedMs: 2825, cached: false });
  camera.mediaEvent('stream_prepared');
  camera.mediaEvent('stream_start');
  camera.mediaEvent('stream_failure', { reason: 'ffmpeg_cpu_unsupported', exitCode: 1, signal: 'SIGILL', elapsedMs: 8 });
  const failed = camera.getMediaDiagnostics();
  assert.deepEqual(safeDiagnostics({ media: failed }).media, failed);
  assert.equal(failed.snapshot.successes, 1);
  assert.equal(failed.stream.lastFailure, 'ffmpeg_cpu_unsupported');
  assert.equal(failed.lastEvent.signal, 'SIGILL');
  camera.shutdown();
});

test('nested media reports drop transport keys, raw errors and endpoints while preserving useful counters', () => {
  const at = '2026-10-23T12:00:00.000Z';
  const report = safeDiagnostics({ media: {
    activeStreams: 1, activeJobs: 2, sessionID: 'PRIVATE_SESSION', deviceId: 'PRIVATE_DID',
    snapshot: { requests: 4, successes: 3, lastElapsedMs: 2825, lastBytes: 9107, lastFailure: null,
      lastCompletedAt: at, sourceUrl: 'http://PRIVATE_SOURCE/cam.ts', credentials: { passToken: 'PRIVATE_TOKEN' } },
    stream: { starts: 1, firstFrames: 0, state: 'starting', lastFailure: 'udp_unreachable',
      lastFailureAt: at, srtp_key: 'PRIVATE_KEY', srtp_salt: 'PRIVATE_SALT', address: 'PRIVATE_IP' },
    lastEvent: { type: 'stream_failure', at, reason: 'udp_unreachable', exitCode: 1, signal: 'SIGTERM',
      width: 640, height: 360, bytes: 0, elapsedMs: 75, rtcpPackets: 0, cached: false,
      message: 'PRIVATE_RAW_ERROR', command: ['PRIVATE_COMMAND'], endpoint: { url: 'PRIVATE_URL' } },
  } });
  assert.deepEqual(report.media, {
    activeStreams: 1, activeJobs: 2,
    snapshot: { requests: 4, successes: 3, lastBytes: 9107, lastCompletedAt: at, lastFailure: null, lastElapsedMs: 2825 },
    stream: { starts: 1, firstFrames: 0, lastFailureAt: at, lastFailure: 'udp_unreachable', state: 'starting' },
    lastEvent: { type: 'stream_failure', at, width: 640, height: 360, bytes: 0, elapsedMs: 75,
      rtcpPackets: 0, reason: 'udp_unreachable', exitCode: 1, signal: 'SIGTERM', cached: false },
  });
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE|sourceUrl|credentials|sessionID|deviceId|srtp_|address|command|endpoint|message/);
});

test('media reports reject malformed field types and unknown free-form event values', () => {
  assert.deepEqual(safeDiagnostics(null), {});
  assert.deepEqual(safeDiagnostics({ media: 'PRIVATE_MEDIA' }), {});
  assert.deepEqual(safeDiagnostics({ media: [] }), {});
  assert.deepEqual(safeDiagnostics({ media: {
    activeStreams: -1, activeJobs: Infinity,
    snapshot: { requests: 'PRIVATE_COUNT', failures: 0.5, lastElapsedMs: {}, lastBytes: Number.MAX_SAFE_INTEGER + 1,
      lastFailure: 'PRIVATE_ERROR', lastRequestedAt: 'http://PRIVATE_TIMESTAMP' },
    stream: { starts: NaN, state: 'PRIVATE_STATE', lastFailure: { reason: 'PRIVATE_NESTED' } },
    lastEvent: { type: 'PRIVATE_EVENT', at: '2026-10-23T12:00:00.000Z', reason: 'source_not_ready' },
  } }), {});
  assert.deepEqual(safeDiagnostics({ media: { lastEvent: { type: 'snapshot_success', at: null, bytes: 100 } } }), {});
  assert.deepEqual(safeDiagnostics({ media: { lastEvent: { type: 'snapshot_failure', at: '2026-10-23T12:00:00.000Z',
    reason: 'PRIVATE_ERROR', signal: 'PRIVATE_SIGNAL', exitCode: 65536, cached: 'PRIVATE_BOOL', width: {}, height: -1 } } }),
  { media: { lastEvent: { type: 'snapshot_failure', at: '2026-10-23T12:00:00.000Z' } } });
});

test('installed diagnosis command reads the private IPC without including the raw source URL', async t => {
  const home = await mkdtemp(join(tmpdir(), 'mijia-diagnose-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const rpc = await startRpcServer(join(home, 'mijia-remote-camera'), async () => ({
    state: 'starting', reason: 'starting', authenticated: true, selected: true, ready: false,
    sourceUrl: 'PRIVATE_SOURCE', stage: 'authentication',
    media: { snapshot: { requests: 0, lastFailure: null }, stream: { starts: 0, state: 'idle' },
      activeStreams: 0, activeJobs: 0, lastEvent: null, key: 'PRIVATE_MEDIA_KEY' },
  }));
  t.after(() => rpc.close());
  const child = spawn(process.execPath, ['bin/diagnose.mjs', '--storage', home], {
    cwd: new URL('../', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  assert.equal(await new Promise(resolve => child.once('close', resolve)), 0, stderr);
  assert.equal(JSON.parse(stdout).stage, 'authentication');
  assert.equal(JSON.parse(stdout).media.snapshot.requests, 0);
  assert.equal(JSON.parse(stdout).media.stream.state, 'idle');
  assert.doesNotMatch(stdout, /PRIVATE/);
});


test('audio and talkback share only typed states and counters, never URLs or RTP secrets', () => {
  const at = '2026-10-23T12:00:00.000Z';
  const report = safeDiagnostics({audio:{enabled:true,received:true,talkbackEnabled:true,talkbackSupported:true,
    codec:'PCMA',sampleRate:8000,channels:1,url:'PRIVATE_SOURCE',talkUrl:'PRIVATE_TALK'}, media:{
    audio:{enabled:true,state:'streaming',sourceReceived:true,starts:1,firstFrames:1,failures:0,rtcpPackets:0,
      lastFailure:null,lastEventAt:at,muted:false,key:'PRIVATE_KEY'},
    talkback:{enabled:true,state:'idle',starts:0,decodedBytes:0,failures:0,lastFailure:null,lastEventAt:null,
      muted:false,url:'PRIVATE_URL'},lastEvent:{type:'talkback_failure',at,reason:'talkback_timeout',raw:'PRIVATE_ERROR'}}});
  assert.equal(report.audio.received,true);
  assert.equal(report.media.audio.firstFrames,1);
  assert.equal(report.media.talkback.decodedBytes,0);
  assert.equal(report.media.lastEvent.reason,'talkback_timeout');
  assert.doesNotMatch(JSON.stringify(report),/PRIVATE|url|key|raw/);
});
