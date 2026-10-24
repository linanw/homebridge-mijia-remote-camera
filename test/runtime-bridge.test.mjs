import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const java = path.join(root, 'assets/runtime/java/bin/java');
const bridge = path.join(root, 'backend/bridge.jar');
const ready = process.platform === 'linux' && process.arch === 'x64' && existsSync(java) && existsSync(bridge);

async function run(t, args) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mijia-bridge-qa-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.mkdir(path.join(directory, '.micam'));
  // No password/token/session exists, so the helper cannot issue an auth request.
  const credentials = path.join(directory, '.micam/credentials.json');
  await fs.writeFile(credentials, '{}');
  const env = { ...process.env };
  delete env.JAVA_TOOL_OPTIONS; delete env._JAVA_OPTIONS; delete env.JDK_JAVA_OPTIONS;
  const child = spawn(java, [`-Duser.home=${directory}`, '-cp', `${root}/assets/micam.jar:${bridge}`, 'mijia.bridge.Bridge', ...args],
    { stdio: ['ignore', 'pipe', 'pipe'], env });
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => { stdout += bytes; });
  child.stderr.on('data', bytes => { stderr += bytes; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  clearTimeout(timer);
  assert.equal(stderr, '');
  assert.equal(await fs.readFile(credentials, 'utf8'), '{}');
  return { code, reply: JSON.parse(stdout) };
}

test('own bridge with local Java returns a typed auth requirement without touching empty credentials', { skip: !ready }, async t => {
  const value = await run(t, ['homes', 'cn']);
  assert.equal(value.code, 2);
  assert.deepEqual(value.reply, { success: false, reason: 'authentication_required' });
});

test('Bridge validates arity, region and IDs before attempting credentials or network', { skip: !ready }, async t => {
  for (const args of [['other', 'cn'], ['homes', 'bad'], ['devices', 'cn', 'bad_PRIVATE', '22']]) {
    const value = await run(t, args);
    assert.equal(value.code, 7);
    assert.deepEqual(value.reply, { success: false, reason: 'invalid_request' });
  }
});

test('Bridge accepts exact IDs above signed long range without requiring /data', { skip: !ready }, async t => {
  const value = await run(t, ['devices', 'cn', '9223372036854775808', '22']);
  assert.equal(value.code, 2);
  assert.equal(value.reply.reason, 'authentication_required');
});

test('stream validation also fails safely before networking when no credentials exist', { skip: !ready }, async t => {
  const value = await run(t, ['stream', 'cn', '11', '22', '33', '19991', '1']);
  assert.equal(value.code, 2);
  assert.deepEqual(value.reply, { success: false, reason: 'authentication_required' });
});
