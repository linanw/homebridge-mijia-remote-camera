import { constants, createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGunzip } from 'node:zlib';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { x as extract, t as list } from 'tar';
import { acquireRuntimeLock } from './process-lock.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const RUNTIME_MANIFEST_SHA256 = '068698d31c8fdee428bc7743aee05dfa33940e8566f062f4972fed7aa553ba08';
const MAX_FILES = 10000;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const fail = reason => Object.assign(new Error(reason), { reason });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const safeName = name => typeof name === 'string' && name.length < 1024
  && /^[A-Za-z0-9._+@/-]+$/.test(name) && !name.startsWith('/')
  && name.split('/').every(part => part && part !== '.' && part !== '..');
const executable = name => name === 'runtime/ffmpeg' || /\/bin\/[^/]+$/.test(name)
  || /\/(?:jspawnhelper|jexec)$/.test(name);
const legalTarget = name => {
  const match = /^(runtime\/(?:java|java-musl)\/legal)\/[^/]+\/(LICENSE|ASSEMBLY_EXCEPTION|ADDITIONAL_LICENSE_INFO)$/.exec(name);
  return match ? `${match[1]}/java.base/${match[2]}` : null;
};

/** Restricts GUI imports to ordinary local paths below the trusted Homebridge storage root. */
export async function resolveRuntimeImportSource({ source, homebridgeStoragePath } = {}) {
  if (typeof source !== 'string' || !source || source.length > 4096 || /[\x00-\x1f\x7f]/.test(source)
    || typeof homebridgeStoragePath !== 'string' || !isAbsolute(homebridgeStoragePath)) throw fail('invalid_request');
  const home = resolve(homebridgeStoragePath);
  const selected = resolve(home, source);
  const name = relative(home, selected);
  if (!name || name === '..' || name.startsWith(`..${sep}`) || isAbsolute(name)) throw fail('invalid_request');
  try {
    const homeInfo = await fs.lstat(home);
    if (!homeInfo.isDirectory() || homeInfo.isSymbolicLink()) throw fail('storage_failed');
    const canonicalHome = await fs.realpath(home);
    let selectedPath = canonicalHome;
    const parts = name.split(sep);
    for (let index = 0; index < parts.length; index++) {
      selectedPath = join(selectedPath, parts[index]);
      const info = await fs.lstat(selectedPath);
      if (info.isSymbolicLink()) throw fail('invalid_request');
      if (index < parts.length - 1 && !info.isDirectory()) throw fail('invalid_request');
      if (index === parts.length - 1 && !info.isDirectory()
        && !(info.isFile() && selectedPath.endsWith('.tgz') && info.size <= MAX_ARCHIVE_BYTES)) {
        throw fail('runtime_components_invalid');
      }
    }
    // Also reject any path redirected since the ancestor checks; no source path reaches a response.
    if (await fs.realpath(selectedPath) !== selectedPath) throw fail('invalid_request');
    return selectedPath;
  } catch (error) {
    if (error.reason) throw error;
    throw fail(error.code === 'ENOENT' ? 'runtime_components_missing' : 'runtime_components_invalid');
  }
}

async function plainPath(root, name, directory = false) {
  const parts = name ? name.split('/') : [];
  let path = root;
  const base = await fs.lstat(path);
  if (!base.isDirectory() || base.isSymbolicLink()) throw fail('runtime_components_invalid');
  for (let index = 0; index < parts.length; index++) {
    path = join(path, parts[index]);
    const info = await fs.lstat(path);
    const last = index === parts.length - 1;
    if (info.isSymbolicLink() && last && !directory && legalTarget(name) && legalTarget(name) !== name) {
      const target = join(root, legalTarget(name));
      if (await fs.realpath(path) !== target || !(await fs.lstat(target)).isFile()) throw fail('runtime_components_invalid');
      return target;
    }
    if (info.isSymbolicLink() || (last && !directory ? !info.isFile() : !info.isDirectory())) {
      throw fail('runtime_components_invalid');
    }
  }
  return path;
}

async function readManifest(assetsPath, expectedManifestHash) {
  try {
    const file = await plainPath(assetsPath, 'manifest.json');
    if ((await fs.stat(file)).size > 1024 * 1024) throw fail('runtime_components_invalid');
    const bytes = await fs.readFile(file);
    if (hash(bytes) !== expectedManifestHash) throw fail('runtime_components_invalid');
    const manifest = JSON.parse(bytes.toString('utf8'));
    const files = manifest.filesSha256;
    if (!files || Array.isArray(files) || typeof files !== 'object'
      || Object.keys(files).length === 0 || Object.keys(files).length > MAX_FILES) throw fail('runtime_components_invalid');
    for (const [name, digest] of Object.entries(files)) {
      if (!safeName(name) || !/^[a-f0-9]{64}$/.test(digest)) throw fail('runtime_components_invalid');
    }
    return { bytes, files };
  } catch (error) {
    if (error.reason) throw error;
    throw fail(error.code === 'ENOENT' ? 'runtime_components_missing' : 'runtime_components_invalid');
  }
}

async function digestFile(file) {
  const digest = createHash('sha256');
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isFile()) throw fail('runtime_components_invalid');
    for await (const bytes of handle.createReadStream({ autoClose: false })) digest.update(bytes);
    return digest.digest('hex');
  } finally { await handle.close(); }
}

export async function verifyRuntimeAssets(assetsPath, { expectedManifestHash = RUNTIME_MANIFEST_SHA256 } = {}) {
  const manifest = await readManifest(assetsPath, expectedManifestHash);
  let size = 0;
  try {
    const allowed = new Set(['manifest.json', ...Object.keys(manifest.files)]);
    const walk = async (directory, prefix = '') => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const name = `${prefix}${entry.name}`;
        if (entry.isDirectory()) {
          if (![...allowed].some(file => file.startsWith(`${name}/`))) throw fail('runtime_components_invalid');
          await walk(join(directory, entry.name), `${name}/`);
        } else if ((!entry.isFile() && !(entry.isSymbolicLink() && legalTarget(name))) || !allowed.has(name)) throw fail('runtime_components_invalid');
      }
    };
    await walk(assetsPath);
    for (const [name, expected] of Object.entries(manifest.files)) {
      const file = await plainPath(assetsPath, name);
      const info = await fs.stat(file);
      size += info.size;
      if (info.size > MAX_FILE_BYTES || size > MAX_ARCHIVE_BYTES || await digestFile(file) !== expected) {
        throw fail('runtime_components_invalid');
      }
    }
  } catch (error) {
    if (error.reason) throw error;
    throw fail(error.code === 'ENOENT' ? 'runtime_components_missing' : 'runtime_components_invalid');
  }
  return manifest;
}

/** Resolves locally supplied components. The public npm package contains no runtime binaries. */
export async function resolveRuntimeAssets({ storagePath, config = {}, root = ROOT,
  expectedManifestHash = RUNTIME_MANIFEST_SHA256, glibc = process.report?.getReport()?.header?.glibcVersionRuntime } = {}) {
  let assetsPath;
  if (config.runtimeDirectory !== undefined && config.runtimeDirectory !== '') {
    if (typeof config.runtimeDirectory !== 'string' || !isAbsolute(config.runtimeDirectory)) throw fail('runtime_components_invalid');
    assetsPath = resolve(config.runtimeDirectory);
  } else {
    assetsPath = join(storagePath, 'runtime');
    try { await fs.lstat(assetsPath); }
    catch (error) {
      if (error.code !== 'ENOENT') throw fail('runtime_components_invalid');
      assetsPath = join(root, 'assets');
    }
  }
  await verifyRuntimeAssets(assetsPath, { expectedManifestHash });
  const result = { assetsPath, javaPath: join(assetsPath, 'runtime', glibc ? 'java' : 'java-musl', 'bin/java'),
    jarPath: join(assetsPath, 'micam.jar'), bridgePath: join(assetsPath, 'bridge.jar'), ffmpegPath: join(assetsPath, 'runtime/ffmpeg') };
  try {
    await fs.access(result.javaPath, constants.X_OK);
    await fs.access(result.ffmpegPath, constants.X_OK);
  } catch { throw fail('runtime_components_invalid'); }
  return result;
}

async function lockStorage(storagePath) {
  return (await acquireRuntimeLock(storagePath)).release;
}

async function unpackArchive(source, stage) {
  let entries = 0, total = 0, rejection;
  const seen = new Set();
  let parser;
  const reject = () => {
    rejection ||= fail('runtime_components_invalid');
    queueMicrotask(() => parser.abort(rejection));
    return false;
  };
  parser = list({ strict: true,
    filter: (name, entry) => {
      entries++;
      total += Number(entry.size) || 0;
      const normalized = name.endsWith('/') ? name.slice(0, -1) : name;
      if (entries > MAX_FILES || total > MAX_ARCHIVE_BYTES || entry.size > MAX_FILE_BYTES || !safeName(normalized)) return reject();
      if (!normalized.startsWith('package/assets/')) return false;
      const relative = normalized.slice('package/assets/'.length);
      if (!safeName(relative) || !['File', 'Directory'].includes(entry.type) || seen.has(relative)) return reject();
      seen.add(relative);
      return true;
    } });
  const limiter = () => {
    let expanded = 0;
    return new Transform({ transform(bytes, encoding, callback) {
      expanded += bytes.length;
      callback(expanded > MAX_ARCHIVE_BYTES ? fail('runtime_components_invalid') : null, bytes);
    } });
  };
  try { await pipeline(createReadStream(source), createGunzip(), limiter(), parser); }
  catch { throw rejection || fail('runtime_components_invalid'); }
  if (rejection) throw rejection;
  // All paths/types/sizes are validated before any archive entry touches the filesystem.
  const unpack = extract({ cwd: stage, strip: 2, strict: true, preservePaths: false, noChmod: true,
    filter: name => name.startsWith('package/assets/') });
  try { await pipeline(createReadStream(source), createGunzip(), limiter(), unpack); }
  catch { throw fail('runtime_components_invalid'); }
}

async function restoreOmittedLegalFiles(stage, expectedManifestHash) {
  const manifest = await readManifest(stage, expectedManifestHash);
  for (const [name, expected] of Object.entries(manifest.files)) {
    try { await fs.lstat(join(stage, name)); continue; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const target = legalTarget(name);
    if (!target || target === name || manifest.files[target] !== expected) continue;
    const source = await plainPath(stage, target);
    if (await digestFile(source) !== expected) throw fail('runtime_components_invalid');
    await fs.mkdir(join(stage, name, '..'), { recursive: true, mode: 0o700 });
    await fs.copyFile(source, join(stage, name), constants.COPYFILE_EXCL);
  }
}

async function copyDirectory(source, stage, expectedManifestHash) {
  const manifest = await verifyRuntimeAssets(source, { expectedManifestHash });
  for (const name of ['manifest.json', ...Object.keys(manifest.files)]) {
    const target = join(stage, name);
    await fs.mkdir(join(target, '..'), { recursive: true, mode: 0o700 });
    await fs.copyFile(await plainPath(source, name), target, constants.COPYFILE_EXCL);
  }
}

async function normalizeTree(directory, uid, gid) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) await normalizeTree(file, uid, gid);
    else if (!entry.isFile()) throw fail('runtime_components_invalid');
    if (process.getuid?.() === 0) await fs.chown(file, uid, gid);
  }
  if (process.getuid?.() === 0) await fs.chown(directory, uid, gid);
  await fs.chmod(directory, 0o700);
}

/** Imports an immutable local component bundle; it never downloads or publishes components. */
export async function importRuntimeAssets({ source, homebridgeStoragePath,
  expectedManifestHash = RUNTIME_MANIFEST_SHA256 } = {}) {
  if (typeof source !== 'string' || !isAbsolute(source) || typeof homebridgeStoragePath !== 'string'
    || !isAbsolute(homebridgeStoragePath)) throw fail('invalid_request');
  const home = resolve(homebridgeStoragePath);
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  const homeInfo = await fs.stat(home);
  const storagePath = join(home, 'mijia-remote-camera');
  await fs.mkdir(storagePath, { recursive: true, mode: 0o700 });
  const storageInfo = await fs.lstat(storagePath);
  if (!storageInfo.isDirectory() || storageInfo.isSymbolicLink()) throw fail('storage_failed');
  const uid = storageInfo.uid === 0 && homeInfo.uid !== 0 ? homeInfo.uid : storageInfo.uid;
  const gid = storageInfo.uid === 0 && homeInfo.uid !== 0 ? homeInfo.gid : storageInfo.gid;
  if (process.getuid?.() === 0) await fs.chown(storagePath, uid, gid);
  await fs.chmod(storagePath, 0o700);
  const release = await lockStorage(storagePath);
  let stage;
  const localArchive = join(storagePath, `.runtime-source-${randomUUID()}.tgz`);
  const destination = join(storagePath, 'runtime');
  try {
    stage = await fs.mkdtemp(join(storagePath, '.runtime-import-'));
    const info = await fs.lstat(source);
    if (info.isSymbolicLink()) throw fail('runtime_components_invalid');
    if (info.isDirectory()) await copyDirectory(source, stage, expectedManifestHash);
    else if (info.isFile() && info.size <= MAX_ARCHIVE_BYTES) {
      await fs.copyFile(source, localArchive, constants.COPYFILE_EXCL);
      await fs.chmod(localArchive, 0o600);
      await unpackArchive(localArchive, stage);
      await restoreOmittedLegalFiles(stage, expectedManifestHash);
    }
    else throw fail('runtime_components_invalid');
    const manifest = await verifyRuntimeAssets(stage, { expectedManifestHash });
    for (const name of ['manifest.json', ...Object.keys(manifest.files)]) {
      await fs.chmod(join(stage, name), executable(name) ? 0o700 : 0o600);
    }
    await normalizeTree(stage, uid, gid);
    try {
      const existing = await fs.lstat(destination);
      if (!existing.isDirectory() || existing.isSymbolicLink()) throw fail('runtime_components_invalid');
      await verifyRuntimeAssets(destination, { expectedManifestHash });
      return { success: true, assetsPath: destination, storagePath, alreadyInstalled: true };
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    // The existing runtime is immutable. A repeat import verifies and retains it;
    // first installation becomes visible through this single atomic rename.
    await fs.rename(stage, destination);
    return { success: true, assetsPath: destination, storagePath };
  } catch (error) {
    throw error.reason ? error : fail('runtime_components_invalid');
  } finally {
    if (stage) await fs.rm(stage, { recursive: true, force: true }).catch(() => {});
    await fs.unlink(localArchive).catch(() => {});
    await release();
  }
}
