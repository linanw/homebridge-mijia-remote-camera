import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const java = path.join(root, 'assets/runtime/java/bin/java');
const bridge = path.join(root, 'backend/bridge.jar');
const probe = path.join(root, 'test/fixtures/ptz-backend-probe.jar');
test('MISS motor probe authenticates loopback, sends one allowlisted step, decodes encrypted ACK and rejects floods', {
  skip: ![java, bridge, probe].every(existsSync),
}, () => {
  const env = { ...process.env }; delete env.JAVA_TOOL_OPTIONS; delete env._JAVA_OPTIONS; delete env.JDK_JAVA_OPTIONS;
  const result = spawnSync(java, ['-cp', `${root}/assets/micam.jar:${bridge}:${probe}`, 'mijia.bridge.PtzBackendProbe'],
    { encoding: 'utf8', timeout: 10000, env });
  assert.equal(result.status, 0, 'synthetic PTZ protocol probe failed');
  assert.equal(result.stderr, '');
  const report = JSON.parse(result.stdout);
  assert.equal(report.success, true); assert.ok(report.checks >= 50);
  assert.doesNotMatch(result.stdout, /PRIVATE|Bearer|token/);
});
