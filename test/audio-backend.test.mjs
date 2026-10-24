import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const java = path.join(root, 'assets/runtime/java/bin/java');
const ffmpeg = path.join(root, 'assets/runtime/ffmpeg');
const bridge = path.join(root, 'backend/bridge.jar');
const probe = path.join(root, 'test/fixtures/audio-backend-probe.jar');
const ready = process.platform === 'linux' && process.arch === 'x64'
  && [java, ffmpeg, bridge, probe].every(file => existsSync(file));
const env = { ...process.env };
delete env.JAVA_TOOL_OPTIONS; delete env._JAVA_OPTIONS; delete env.JDK_JAVA_OPTIONS;

function run(binary, args, input) {
  const result = spawnSync(binary, args, { input, timeout: 12000, env, maxBuffer: 2 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr?.toString());
  return result.stdout;
}
function fixture(mode, input) {
  return run(java, ['-cp', `${root}/assets/micam.jar:${bridge}:${probe}`, 'mijia.bridge.AudioBackendProbe', mode], input);
}
function ff(args, input) { return run(ffmpeg, ['-hide_banner', '-loglevel', 'error', ...args], input); }

test('owned audio backend validates formats, bounded packets, Ogg CRC, and real MISS media header', { skip: !ready }, () => {
  assert.equal(fixture('unit').toString(), 'ok\n');
});

test('G.711 A-law decoder matches FFmpeg and encoder bounds quantization for every PCM16 value', { skip: !ready }, () => {
  const pcm = Buffer.alloc(65536 * 2);
  for (let i = 0; i < 65536; i++) pcm.writeInt16LE(i - 32768, i * 2);
  const encoded = fixture('encode', pcm);
  const reconstructed = ff(['-f', 'alaw', '-ar', '8000', '-ac', '1', '-i', 'pipe:0', '-c:a', 'pcm_s16le', '-f', 's16le', 'pipe:1'], encoded);
  assert.equal(reconstructed.length, pcm.length);
  for (let i = 0; i < 65536; i++)
    assert.ok(Math.abs(reconstructed.readInt16LE(i * 2) - (i - 32768)) <= 512, 'A-law quantization bound exceeded');
  const alaw = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  const decoded = ff(['-f', 'alaw', '-ar', '8000', '-ac', '1', '-i', 'pipe:0', '-c:a', 'pcm_s16le', '-f', 's16le', 'pipe:1'], alaw);
  assert.ok(fixture('decode', alaw).equals(decoded), 'A-law decoder reference mismatch');
  assert.ok(fixture('encode', decoded).equals(alaw), 'A-law representative round-trip mismatch');
});

test('real libopus 40ms packets survive own bounded Ogg reader/writer and decode as stereo audio', { skip: !ready }, () => {
  const ogg = ff(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=0.24', '-ac', '2',
    '-c:a', 'libopus', '-frame_duration', '40', '-f', 'ogg', 'pipe:1']);
  const reframed = fixture('ogg-copy', ogg);
  const pcm = ff(['-f', 'ogg', '-i', 'pipe:0', '-c:a', 'pcm_s16le', '-f', 's16le', 'pipe:1'], reframed);
  assert.ok(pcm.length >= 48000 * 0.24 * 2 * 2);
  assert.ok(pcm.some(byte => byte !== 0));
});

test('loopback HTTP real audio and camera speaker command/data/stop lifecycle work against synthetic UDP peer', { skip: !ready }, () => {
  assert.equal(fixture('transport').toString(), 'ok\n');
});
