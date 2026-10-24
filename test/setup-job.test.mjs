import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { c as createArchive } from 'tar';
import { RuntimeSetupJob } from '../lib/setup-job.mjs';
import { importRuntimeAssets } from '../lib/runtime-assets.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'mijia-setup-job-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = join(root, 'homebridge');
  const assets = join(home, 'incoming', 'assets');
  const files = { 'micam.jar': 'local-micam', 'bridge.jar': 'local-bridge',
    'runtime/ffmpeg': '#!/bin/sh\nexit 0\n', 'runtime/java/bin/java': '#!/bin/sh\nexit 0\n',
    'runtime/java/legal/java.base/LICENSE': 'local-jre-license', 'LICENSES/FFmpeg.txt': 'local-ffmpeg-license' };
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(join(assets, name, '..'), { recursive: true });
    await fs.writeFile(join(assets, name), content);
  }
  const manifest = JSON.stringify({ filesSha256: Object.fromEntries(Object.entries(files).map(([name, content]) => [name, digest(content)])) });
  await fs.writeFile(join(assets, 'manifest.json'), manifest);
  const expectedManifestHash = digest(manifest);
  const importAssets = options => importRuntimeAssets({ ...options, expectedManifestHash });
  const archive = join(home, 'local.tgz');
  await fs.writeFile(archive, 'placeholder for injected importer');
  return { root, home, assets, archive, expectedManifestHash, importAssets };
}

async function settled(job) {
  const deadline = Date.now() + 5000;
  while (job.safeStatus().state === 'running' && Date.now() < deadline) await sleep(5);
  assert.notEqual(job.safeStatus().state, 'running', 'local setup did not settle');
  return job.safeStatus();
}

test('headless GUI helper imports local components without stdin, retains licenses and reports no paths', async t => {
  const value = await fixture(t);
  const script = `
    import { RuntimeSetupJob } from './lib/setup-job.mjs';
    import { importRuntimeAssets } from './lib/runtime-assets.mjs';
    if (process.stdin.isTTY) throw new Error('test requires non-TTY stdin');
    const job = new RuntimeSetupJob({ homebridgeStoragePath: process.argv[1],
      importAssets: args => importRuntimeAssets({ ...args, expectedManifestHash: process.argv[2] }) });
    console.log(JSON.stringify(job.start({ source: 'incoming/assets' })));
    for (let i = 0; i < 500 && job.safeStatus().state === 'running'; i++) await new Promise(resolve => setTimeout(resolve, 5));
    console.log(JSON.stringify(job.safeStatus()));
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, value.home, value.expectedManifestHash],
    { cwd: new URL('../', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, '');
  assert.deepEqual(child.stdout.trim().split('\n').map(line => JSON.parse(line)), [
    { state: 'running', success: false }, { state: 'complete', success: true, alreadyInstalled: false },
  ]);
  assert.equal(await fs.readFile(join(value.home, 'mijia-remote-camera/runtime/LICENSES/FFmpeg.txt'), 'utf8'), 'local-ffmpeg-license');
  assert.equal(await fs.readFile(join(value.home, 'mijia-remote-camera/runtime/runtime/java/legal/java.base/LICENSE'), 'utf8'), 'local-jre-license');
  assert.equal(child.stdout.includes(value.root), false);
});

test('relative and absolute storage paths work and immutable repeat imports are reported', async t => {
  const value = await fixture(t);
  await createArchive({ gzip: true, cwd: join(value.home, 'incoming'), prefix: 'package/', file: value.archive }, ['assets']);
  const job = new RuntimeSetupJob({ homebridgeStoragePath: value.home, importAssets: value.importAssets });
  job.start({ source: value.archive });
  assert.deepEqual(await settled(job), { state: 'complete', success: true, alreadyInstalled: false });
  job.start({ source: 'incoming/assets' });
  assert.deepEqual(await settled(job), { state: 'complete', success: true, alreadyInstalled: true });
});

test('fixed production manifest rejects locally supplied replacement manifests', async t => {
  const value = await fixture(t);
  const job = new RuntimeSetupJob({ homebridgeStoragePath: value.home });
  job.start({ source: 'incoming/assets' });
  assert.deepEqual(await settled(job), { state: 'error', success: false, reason: 'runtime_components_invalid' });
  await assert.rejects(fs.stat(join(value.home, 'mijia-remote-camera/runtime')), { code: 'ENOENT' });
});

test('traversal, external absolute paths and symlink sources or ancestors never reach the importer', async t => {
  const value = await fixture(t);
  const outside = join(value.root, 'outside.tgz');
  await fs.writeFile(outside, 'outside');
  await fs.symlink(outside, join(value.home, 'external.tgz'));
  await fs.symlink(value.archive, join(value.home, 'internal.tgz'));
  await fs.symlink(value.root, join(value.home, 'redirect'));
  await fs.symlink(join(value.home, 'incoming'), join(value.home, 'internal-dir'));
  let calls = 0;
  const job = new RuntimeSetupJob({ homebridgeStoragePath: value.home, importAssets: async () => { calls++; } });
  for (const source of ['../outside.tgz', outside, '.', 'external.tgz', 'internal.tgz', 'redirect/outside.tgz', 'internal-dir/assets']) {
    job.start({ source });
    assert.deepEqual(await settled(job), { state: 'error', success: false, reason: 'invalid_request' });
  }
  assert.equal(calls, 0);
  assert.equal(await fs.readFile(outside, 'utf8'), 'outside');
});

test('unknown options, malformed inputs, missing files and non-tgz files have bounded responses', async t => {
  const value = await fixture(t);
  let calls = 0;
  const job = new RuntimeSetupJob({ homebridgeStoragePath: value.home, importAssets: async () => { calls++; } });
  for (const request of [undefined, null, [], {}, { source: 1 }, { source: '' }, { source: 'a\nb' },
    { source: 'x'.repeat(4097) }, { source: 'local.tgz', expectedManifestHash: value.expectedManifestHash },
    { source: 'local.tgz', homebridgeStoragePath: value.root }, { source: 'local.tgz', command: 'anything' }]) {
    assert.deepEqual(job.start(request), { state: 'error', success: false, reason: 'invalid_request' });
  }
  await fs.writeFile(join(value.home, 'notes.txt'), 'ordinary user data');
  job.start({ source: 'notes.txt' });
  assert.deepEqual(await settled(job), { state: 'error', success: false, reason: 'runtime_components_invalid' });
  job.start({ source: 'missing.tgz' });
  assert.deepEqual(await settled(job), { state: 'error', success: false, reason: 'runtime_components_missing' });
  assert.equal(calls, 0);
});

test('one inflight import snapshots its input and duplicate requests cannot replace it', async t => {
  const value = await fixture(t);
  let release, entered;
  const waiting = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  let calls = 0, observed;
  const job = new RuntimeSetupJob({ homebridgeStoragePath: value.home, importAssets: async args => {
    calls++; observed = args; entered(); await waiting; return { success: true, assetsPath: '/private/do-not-return' };
  } });
  const request = { source: 'local.tgz' };
  const first = job.start(request);
  request.source = '../outside.tgz';
  assert.deepEqual(job.start({ source: '../outside.tgz' }), first);
  await started;
  assert.equal(calls, 1);
  assert.equal(observed.source, value.archive);
  assert.deepEqual(Object.keys(observed).sort(), ['homebridgeStoragePath', 'source']);
  const snapshot = job.safeStatus(); snapshot.state = 'complete'; snapshot.path = value.root;
  assert.deepEqual(job.safeStatus(), { state: 'running', success: false });
  release();
  assert.deepEqual(await settled(job), { state: 'complete', success: true, alreadyInstalled: false });
});

test('an active runtime blocks setup without modifying its owner, account or installed runtime', async t => {
  const value = await fixture(t);
  const installed = await value.importAssets({ source: value.assets, homebridgeStoragePath: value.home });
  const ownerPath = join(installed.storagePath, 'runtime-owner.json');
  const credentialsPath = join(installed.storagePath, 'credentials.json');
  const owner = JSON.stringify({ pid: process.pid, token: 'existing-live-runtime' });
  const credentials = 'private-account-data';
  await fs.writeFile(ownerPath, owner);
  await fs.writeFile(credentialsPath, credentials);
  const before = await fs.stat(installed.assetsPath);
  const job = new RuntimeSetupJob({ homebridgeStoragePath: value.home, importAssets: value.importAssets });
  job.start({ source: 'incoming/assets' });
  assert.deepEqual(await settled(job), { state: 'error', success: false, reason: 'runtime_in_use' });
  assert.equal(await fs.readFile(ownerPath, 'utf8'), owner);
  assert.equal(await fs.readFile(credentialsPath, 'utf8'), credentials);
  assert.equal((await fs.stat(installed.assetsPath)).ino, before.ino);
  assert.deepEqual((await fs.readdir(installed.storagePath)).sort(), ['credentials.json', 'runtime', 'runtime-owner.json']);
});

test('sync and async importer failures never disclose paths, arbitrary reasons or thrown diagnostics', async t => {
  const value = await fixture(t);
  const secret = `${value.root}/credentials.json?token=private-token`;
  for (const importAssets of [
    () => { throw new Error(secret); },
    async () => { throw Object.assign(new Error(secret), { reason: secret }); },
    async () => { throw { get reason() { throw new Error(secret); } }; },
    async () => ({ success: false, reason: secret }),
    async () => { throw Object.assign(new Error(secret), { reason: 'runtime_components_invalid', stack: secret }); },
  ]) {
    const job = new RuntimeSetupJob({ homebridgeStoragePath: value.home, importAssets });
    assert.deepEqual(job.start({ source: 'local.tgz' }), { state: 'running', success: false });
    const status = await settled(job);
    assert.equal(status.state, 'error');
    assert.ok(['setup_failed', 'runtime_components_invalid'].includes(status.reason));
    assert.equal(JSON.stringify(status).includes(secret), false);
    assert.ok(JSON.stringify(status).length < 150);
  }
});
