import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { Header } from 'tar';
import { spawnSync } from 'node:child_process';
import { importRuntimeAssets, resolveRuntimeAssets, verifyRuntimeAssets } from '../lib/runtime-assets.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), 'mijia-components-'));
  const assets = join(root, 'package', 'assets');
  const files = { 'micam.jar': 'micam-fixture', 'bridge.jar': 'bridge-fixture',
    'runtime/ffmpeg': '#!/bin/sh\nexit 0\n', 'runtime/java/bin/java': '#!/bin/sh\nexit 0\n',
    'runtime/java-musl/bin/java': '#!/bin/sh\nexit 0\n' };
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(join(assets, name, '..'), { recursive: true });
    await fs.writeFile(join(assets, name), content, { mode: 0o700 });
  }
  const manifest = Buffer.from(JSON.stringify({ filesSha256: Object.fromEntries(Object.entries(files).map(([name, content]) => [name, digest(content)])) }));
  await fs.writeFile(join(assets, 'manifest.json'), manifest);
  const options = { expectedManifestHash: digest(manifest) };
  return { root, assets, files, manifest, options, home: join(root, 'homebridge'), async close() { await fs.rm(root, { recursive: true, force: true }); } };
}
function archive(entries) {
  const buffers = [];
  for (const { path, content = '', type = 'File', linkpath } of entries) {
    const data = Buffer.from(content);
    const header = new Header({ path, size: data.length, type, linkpath, mode: 0o755 });
    header.encode();
    buffers.push(header.block, data);
    if (data.length % 512) buffers.push(Buffer.alloc(512 - data.length % 512));
  }
  return gzipSync(Buffer.concat([...buffers, Buffer.alloc(1024)]));
}
function validEntries(value) {
  return [{ path: 'package/assets/manifest.json', content: value.manifest },
    ...Object.entries(value.files).map(([name, content]) => ({ path: `package/assets/${name}`, content }))];
}

test('local directory import verifies components and preserves executable modes', async () => {
  const value = await fixture();
  try {
    const imported = await importRuntimeAssets({ source: value.assets, homebridgeStoragePath: value.home, ...value.options });
    assert.equal(imported.assetsPath, join(value.home, 'mijia-remote-camera/runtime'));
    assert.equal((await fs.stat(imported.assetsPath)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(join(imported.assetsPath, 'micam.jar'))).mode & 0o777, 0o600);
    assert.equal((await fs.stat(join(imported.assetsPath, 'runtime/ffmpeg'))).mode & 0o777, 0o700);
    const glibc = await resolveRuntimeAssets({ storagePath: imported.storagePath, root: value.root, glibc: '2.35', ...value.options });
    const musl = await resolveRuntimeAssets({ storagePath: imported.storagePath, root: value.root, glibc: undefined, ...value.options });
    assert.equal(glibc.javaPath, join(imported.assetsPath, 'runtime/java/bin/java'));
    // Explicit false emulates Alpine without depending on the host report.
    const alpine = await resolveRuntimeAssets({ storagePath: imported.storagePath, root: value.root, glibc: false, ...value.options });
    assert.equal(alpine.javaPath, join(imported.assetsPath, 'runtime/java-musl/bin/java'));
    assert.equal(spawnSync(glibc.javaPath).status, 0);
    assert.equal(spawnSync(musl.ffmpegPath).status, 0);
    await assert.rejects(fs.stat(join(imported.storagePath, 'runtime-owner.json')), { code: 'ENOENT' });
  } finally { await value.close(); }
});

test('tgz import uses only package/assets and preserves an existing runtime on repeat', async () => {
  const value = await fixture();
  try {
    const source = join(value.root, 'components.tgz');
    await fs.writeFile(source, archive([...validEntries(value), { path: 'package/ignored.txt', content: 'not imported' }]));
    const args = { source, homebridgeStoragePath: value.home, ...value.options };
    const first = await importRuntimeAssets(args);
    const before = await fs.stat(first.assetsPath);
    const repeated = await importRuntimeAssets(args);
    assert.equal(repeated.alreadyInstalled, true);
    assert.equal((await fs.stat(first.assetsPath)).ino, before.ino);
    assert.equal(await fs.readFile(join(first.assetsPath, 'bridge.jar'), 'utf8'), 'bridge-fixture');
    assert.deepEqual(await fs.readdir(join(value.home, 'mijia-remote-camera')), ['runtime']);
  } finally { await value.close(); }
});

test('resolution prefers imported files, supports explicit absolute location and rejects relative overrides', async () => {
  const value = await fixture();
  try {
    const storagePath = join(value.root, 'storage');
    const fallback = await resolveRuntimeAssets({ storagePath, root: join(value.root, 'package'), ...value.options });
    assert.equal(fallback.assetsPath, value.assets);
    const explicit = await resolveRuntimeAssets({ storagePath, root: value.root, config: { runtimeDirectory: value.assets }, ...value.options });
    assert.equal(explicit.assetsPath, value.assets);
    await assert.rejects(resolveRuntimeAssets({ storagePath, config: { runtimeDirectory: 'relative' } }), { reason: 'runtime_components_invalid' });
    await assert.rejects(resolveRuntimeAssets({ storagePath, root: value.root }), { reason: 'runtime_components_missing' });
    await fs.mkdir(join(storagePath, 'runtime'), { recursive: true });
    await assert.rejects(resolveRuntimeAssets({ storagePath, root: join(value.root, 'package'), ...value.options }), { reason: 'runtime_components_missing' });
  } finally { await value.close(); }
});

test('tampering, extra files, missing files and symbolic links fail component verification', async () => {
  const value = await fixture();
  try {
    await fs.writeFile(join(value.assets, 'micam.jar'), 'tampered');
    await assert.rejects(verifyRuntimeAssets(value.assets, value.options), { reason: 'runtime_components_invalid' });
    await fs.writeFile(join(value.assets, 'micam.jar'), value.files['micam.jar']);
    await fs.writeFile(join(value.assets, 'extra'), 'extra');
    await assert.rejects(verifyRuntimeAssets(value.assets, value.options), { reason: 'runtime_components_invalid' });
    await fs.unlink(join(value.assets, 'extra'));
    await fs.unlink(join(value.assets, 'bridge.jar'));
    await assert.rejects(verifyRuntimeAssets(value.assets, value.options), { reason: 'runtime_components_missing' });
    await fs.symlink(join(value.assets, 'micam.jar'), join(value.assets, 'bridge.jar'));
    await assert.rejects(verifyRuntimeAssets(value.assets, value.options), { reason: 'runtime_components_invalid' });
  } finally { await value.close(); }
});

test('unsafe tar paths, duplicate assets and linked entries are rejected without escaping staging', async () => {
  const value = await fixture();
  try {
    for (const entry of [
      { path: 'package/assets/../../escape', content: 'escape' },
      { path: '/absolute', content: 'escape' },
      { path: 'package/assets/micam.jar', content: 'duplicate' },
      { path: 'package/assets/link', type: 'SymbolicLink', linkpath: '../../escape' },
      { path: 'package/assets/link', type: 'Link', linkpath: 'package/assets/micam.jar' },
    ]) {
      const source = join(value.root, 'unsafe.tgz');
      await fs.writeFile(source, archive([...validEntries(value), entry]));
      await assert.rejects(importRuntimeAssets({ source, homebridgeStoragePath: value.home, ...value.options }), { reason: 'runtime_components_invalid' });
    }
    await assert.rejects(fs.stat(join(value.home, 'escape')), { code: 'ENOENT' });
    assert.deepEqual(await fs.readdir(join(value.home, 'mijia-remote-camera')), []);
  } finally { await value.close(); }
});

test('live runtime owner blocks import and failed import preserves the previous runtime', async () => {
  const value = await fixture();
  try {
    const args = { source: value.assets, homebridgeStoragePath: value.home, ...value.options };
    const first = await importRuntimeAssets(args);
    const owner = join(first.storagePath, 'runtime-owner.json');
    await fs.writeFile(owner, JSON.stringify({ pid: process.pid, token: 'active-runtime' }));
    await assert.rejects(importRuntimeAssets(args), { reason: 'runtime_in_use' });
    await fs.unlink(owner);
    await fs.writeFile(join(value.assets, 'micam.jar'), 'tampered');
    await assert.rejects(importRuntimeAssets(args), { reason: 'runtime_components_invalid' });
    assert.equal(await fs.readFile(join(first.assetsPath, 'micam.jar'), 'utf8'), 'micam-fixture');
    assert.deepEqual(await fs.readdir(first.storagePath), ['runtime']);
  } finally { await value.close(); }
});

test('setup CLI without source explains the required local import', () => {
  const result = spawnSync(process.execPath, ['bin/setup.mjs'], { cwd: new URL('../', import.meta.url), encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /mijia-camera-setup --from/);
});

test('only exact JRE legal links are accepted in local directories and imported as regular files', async () => {
  const value = await fixture();
  try {
    const base = 'runtime/java/legal/java.base/LICENSE';
    const linked = 'runtime/java/legal/java.desktop/LICENSE';
    value.files[base] = 'license-fixture'; value.files[linked] = 'license-fixture';
    for (const name of [base, linked]) await fs.mkdir(join(value.assets, name, '..'), { recursive: true });
    await fs.writeFile(join(value.assets, base), 'license-fixture');
    await fs.symlink('../java.base/LICENSE', join(value.assets, linked));
    const manifest = Buffer.from(JSON.stringify({ filesSha256: Object.fromEntries(Object.entries(value.files).map(([name, content]) => [name, digest(content)])) }));
    await fs.writeFile(join(value.assets, 'manifest.json'), manifest);
    const options = { expectedManifestHash: digest(manifest) };
    await verifyRuntimeAssets(value.assets, options);
    const imported = await importRuntimeAssets({ source: value.assets, homebridgeStoragePath: value.home, ...options });
    assert.equal((await fs.lstat(join(imported.assetsPath, linked))).isSymbolicLink(), false);
    assert.equal(await fs.readFile(join(imported.assetsPath, linked), 'utf8'), 'license-fixture');
    await fs.unlink(join(value.assets, linked));
    await fs.symlink(join(value.assets, 'micam.jar'), join(value.assets, linked));
    await assert.rejects(verifyRuntimeAssets(value.assets, options), { reason: 'runtime_components_invalid' });
  } finally { await value.close(); }
});

test('tgz restores npm-omitted JRE legal declarations from identical verified java.base notices', async () => {
  const value = await fixture();
  try {
    const base = 'runtime/java/legal/java.base/LICENSE';
    const omitted = 'runtime/java/legal/java.desktop/LICENSE';
    value.files[base] = 'license-fixture'; value.files[omitted] = 'license-fixture';
    value.manifest = Buffer.from(JSON.stringify({ filesSha256: Object.fromEntries(Object.entries(value.files).map(([name, content]) => [name, digest(content)])) }));
    const source = join(value.root, 'npm-components.tgz');
    await fs.writeFile(source, archive(validEntries(value).filter(entry => entry.path !== `package/assets/${omitted}`)));
    const imported = await importRuntimeAssets({ source, homebridgeStoragePath: value.home, expectedManifestHash: digest(value.manifest) });
    assert.equal(await fs.readFile(join(imported.assetsPath, omitted), 'utf8'), 'license-fixture');
    assert.equal((await fs.lstat(join(imported.assetsPath, omitted))).isSymbolicLink(), false);
  } finally { await value.close(); }
});
