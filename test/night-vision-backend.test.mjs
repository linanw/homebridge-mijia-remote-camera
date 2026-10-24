import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const java = path.join(root, 'assets/runtime/java/bin/java');
const bridge = path.join(root, 'backend/bridge.jar');
const probe = path.join(root, 'test/fixtures/night-vision-probe.jar');
const ready = process.platform === 'linux' && process.arch === 'x64'
  && [java, bridge, probe].every(file => existsSync(file));

test('night vision cloud protocol validates policy, exact property, acknowledgements, and safe failures', { skip: !ready }, () => {
  const env = { ...process.env };
  delete env.JAVA_TOOL_OPTIONS; delete env._JAVA_OPTIONS; delete env.JDK_JAVA_OPTIONS;
  const result = spawnSync(java, ['-cp', `${root}/assets/micam.jar:${bridge}:${probe}`, 'mijia.bridge.NightVisionProbe'],
    { encoding: 'utf8', timeout: 5000, env });
  assert.equal(result.status, 0, 'synthetic night vision protocol probe failed');
  assert.equal(result.stderr, '');
  const report = JSON.parse(result.stdout);
  assert.equal(report.success, true);
  assert.ok(report.checks >= 68);
  assert.ok(!result.stdout.includes('PRIVATE_TOKEN'));
});
