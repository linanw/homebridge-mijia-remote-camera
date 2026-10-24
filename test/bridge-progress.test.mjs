import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const java = path.join(root, 'assets/runtime/java/bin/java');
const bridge = path.join(root, 'backend/bridge.jar');
const probe = path.join(root, 'test/fixtures/bridge-probe.jar');
const ready = process.platform === 'linux' && process.arch === 'x64'
  && [java, bridge, probe].every(file => existsSync(file));

function run(mode) {
  const env = { ...process.env };
  delete env.JAVA_TOOL_OPTIONS; delete env._JAVA_OPTIONS; delete env.JDK_JAVA_OPTIONS;
  const result = spawnSync(java, ['-cp', `${root}/assets/micam.jar:${bridge}:${probe}`, 'mijia.bridge.BridgeProbe', mode],
    { encoding: 'utf8', timeout: 5000, env });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  return result.stdout.trim().split('\n').map(line => JSON.parse(line));
}

test('bridge progress emits only the fixed safe stages and optional integer vendor', { skip: !ready }, () => {
  assert.deepEqual(run('progress'), [
    { success: true, event: 'progress', stage: 'device_lookup' },
    { success: true, event: 'progress', stage: 'provisioning' },
    { success: true, event: 'progress', stage: 'relay_connect', vendor: 4 },
    { success: true, event: 'progress', stage: 'authentication', vendor: 4 },
    { success: true, event: 'progress', stage: 'waiting_video', vendor: 4 },
  ]);
});

test('no incoming video expires after ten seconds, including after a received keyframe', { skip: !ready }, () => {
  for (const mode of ['empty', 'afterkey', 'audio']) assert.deepEqual(run(mode), [{ success: false, reason: 'no_video' }]);
});

test('continuous non-keyframe traffic cannot extend the fifteen-second first-keyframe deadline', { skip: !ready }, () => {
  for (const mode of ['nonkey', 'latekey']) assert.deepEqual(run(mode), [{ success: false, reason: 'no_video' }]);
});

test('timely initial keyframe and continuing video remain valid beyond the initial deadline', { skip: !ready }, () => {
  assert.deepEqual(run('timely'), [{ success: true }]);
});
