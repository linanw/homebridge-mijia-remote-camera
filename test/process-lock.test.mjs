import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { acquireRuntimeLock } from '../lib/process-lock.mjs';

const moduleUrl = new URL('../lib/process-lock.mjs', import.meta.url).href;
const childSource = `
  import { acquireRuntimeLock } from ${JSON.stringify(moduleUrl)};
  const timeout = setTimeout(() => process.exit(90), 12000);
  let lock;
  process.on('message', async message => {
    if (message.type === 'go') {
      try {
        lock = await acquireRuntimeLock(message.directory);
        process.send({ type: 'locked', token: lock.token, pid: process.pid });
      } catch (error) {
        process.send({ type: 'failed', reason: error.reason }, () => process.exit(0));
      }
    } else if (message.type === 'release') {
      await lock.release();
      clearTimeout(timeout);
      process.send({ type: 'released' }, () => process.exit(0));
    }
  });
  process.send({ type: 'ready' });
`;

function probe(t, { uid, gid, moduleUrl: customModuleUrl, cwd } = {}) {
  const source = customModuleUrl ? childSource.replace(JSON.stringify(moduleUrl), JSON.stringify(customModuleUrl)) : childSource;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    uid, gid, cwd,
  });
  let stderr = '';
  const messages = [];
  const waits = new Set();
  let exit;
  child.stderr.on('data', bytes => { stderr = `${stderr}${bytes}`.slice(-4000); });
  child.on('message', message => {
    const pending = [...waits].find(wait => wait.types.includes(message.type));
    if (pending) { waits.delete(pending); clearTimeout(pending.timer); pending.resolve(message); }
    else messages.push(message);
  });
  const fail = error => {
    for (const wait of waits) { clearTimeout(wait.timer); wait.reject(error); }
    waits.clear();
  };
  child.on('error', fail);
  child.on('exit', (code, signal) => {
    exit = { code, signal };
    fail(new Error(`Lock child exited: ${JSON.stringify(exit)} ${stderr}`));
  });
  t.after(async () => {
    if (exit) return;
    const closed = once(child, 'exit');
    child.kill('SIGKILL');
    await closed;
  });
  return {
    child,
    send(message) { child.send(message); },
    message(...types) {
      const index = messages.findIndex(message => types.includes(message.type));
      if (index !== -1) return Promise.resolve(messages.splice(index, 1)[0]);
      if (exit) return Promise.reject(new Error(`Lock child exited: ${JSON.stringify(exit)} ${stderr}`));
      return new Promise((resolve, reject) => {
        const wait = { types, resolve, reject };
        wait.timer = setTimeout(() => { waits.delete(wait); reject(new Error(`Timed out waiting for ${types.join('/')} ${stderr}`)); }, 8000);
        waits.add(wait);
      });
    },
    async kill() {
      if (exit) return;
      const closed = once(child, 'exit');
      child.kill('SIGKILL');
      await closed;
    },
  };
}

async function directory(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'mijia-process-lock-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('two real processes racing from one stale owner acquire only one lock', { skip: process.platform !== 'linux' }, async t => {
  const root = await directory(t);
  const storage = join(root, 'storage');
  await fs.mkdir(storage);
  await fs.writeFile(join(storage, 'runtime-owner.json'), JSON.stringify({ pid: 2147483647, token: 'stale-owner', start: '1' }));
  const contenders = [probe(t), probe(t)];
  await Promise.all(contenders.map(child => child.message('ready')));
  const responses = contenders.map(child => child.message('locked', 'failed'));
  for (const child of contenders) child.send({ type: 'go', directory: storage });
  const results = await Promise.all(responses);
  assert.deepEqual(results.map(result => result.type).sort(), ['failed', 'locked']);
  assert.equal(results.find(result => result.type === 'failed').reason, 'runtime_in_use');
  const winner = results.findIndex(result => result.type === 'locked');
  const ownerFile = join(storage, 'runtime-owner.json');
  assert.equal(JSON.parse(await fs.readFile(ownerFile, 'utf8')).pid, contenders[winner].child.pid);
  assert.equal((await fs.stat(ownerFile)).mode & 0o777, 0o600);
  const released = contenders[winner].message('released');
  contenders[winner].send({ type: 'release' });
  await released;
  await assert.rejects(fs.stat(ownerFile), { code: 'ENOENT' });
});

test('SIGKILL releases kernel ownership and a new process reclaims its stale owner file', { skip: process.platform !== 'linux' }, async t => {
  const storage = await directory(t);
  const first = probe(t);
  await first.message('ready');
  first.send({ type: 'go', directory: storage });
  const original = await first.message('locked');
  await first.kill();
  assert.equal(JSON.parse(await fs.readFile(join(storage, 'runtime-owner.json'), 'utf8')).token, original.token);
  const next = probe(t);
  await next.message('ready');
  next.send({ type: 'go', directory: storage });
  const replacement = await next.message('locked', 'failed');
  assert.equal(replacement.type, 'locked');
  assert.notEqual(replacement.token, original.token);
  const released = next.message('released');
  next.send({ type: 'release' });
  await released;
});

test('different storage directories can be owned by different processes concurrently', { skip: process.platform !== 'linux' }, async t => {
  const root = await directory(t);
  const stores = [join(root, 'one'), join(root, 'two')];
  await Promise.all(stores.map(store => fs.mkdir(store)));
  const children = [probe(t), probe(t)];
  await Promise.all(children.map(child => child.message('ready')));
  const responses = children.map(child => child.message('locked', 'failed'));
  children.forEach((child, index) => child.send({ type: 'go', directory: stores[index] }));
  const results = await Promise.all(responses);
  assert.deepEqual(results.map(result => result.type), ['locked', 'locked']);
  assert.notEqual(results[0].token, results[1].token);
  const releases = children.map(child => child.message('released'));
  children.forEach(child => child.send({ type: 'release' }));
  await Promise.all(releases);
});

test('a parent-directory symlink aliases the same inode and cannot bypass ownership', { skip: process.platform !== 'linux' }, async t => {
  const root = await directory(t);
  const storage = join(root, 'real', 'storage');
  await fs.mkdir(storage, { recursive: true });
  await fs.symlink(join(root, 'real'), join(root, 'alias'));
  const owner = await acquireRuntimeLock(storage);
  t.after(() => owner.release());
  await assert.rejects(acquireRuntimeLock(join(root, 'alias', 'storage')), { reason: 'runtime_in_use' });
});

test('release removes only its own owner token and is idempotent', { skip: process.platform !== 'linux' }, async t => {
  const storage = await directory(t);
  const lock = await acquireRuntimeLock(storage);
  const ownerFile = join(storage, 'runtime-owner.json');
  await fs.writeFile(ownerFile, JSON.stringify({ pid: 2147483647, token: 'replacement-owner', start: '1' }));
  await lock.release();
  await lock.release();
  assert.equal(JSON.parse(await fs.readFile(ownerFile, 'utf8')).token, 'replacement-owner');
  const next = await acquireRuntimeLock(storage);
  assert.notEqual(next.token, lock.token);
  await next.release();
  await assert.rejects(fs.stat(ownerFile), { code: 'ENOENT' });
});

test('legacy PID-only ownership is preserved and a reused PID start stamp is reclaimed', { skip: process.platform !== 'linux' }, async t => {
  const storage = await directory(t);
  const ownerFile = join(storage, 'runtime-owner.json');
  const stat = await fs.readFile(`/proc/${process.pid}/stat`, 'utf8');
  const start = stat.slice(stat.lastIndexOf(') ') + 2).split(' ')[19];
  const legacy = { pid: process.pid, token: 'legacy-owner', start };
  await fs.writeFile(ownerFile, JSON.stringify(legacy));
  await assert.rejects(acquireRuntimeLock(storage), { reason: 'runtime_in_use' });
  assert.deepEqual(JSON.parse(await fs.readFile(ownerFile, 'utf8')), legacy);
  await fs.writeFile(ownerFile, JSON.stringify({ ...legacy, start: 'not-this-process-start' }));
  const replacement = await acquireRuntimeLock(storage);
  assert.notEqual(replacement.token, legacy.token);
  await replacement.release();
});

test('a recent incomplete legacy owner is retained until the stale-write grace period passes', { skip: process.platform !== 'linux' }, async t => {
  const storage = await directory(t);
  const ownerFile = join(storage, 'runtime-owner.json');
  await fs.writeFile(ownerFile, '{');
  await assert.rejects(acquireRuntimeLock(storage), { reason: 'runtime_in_use' });
  assert.equal(await fs.readFile(ownerFile, 'utf8'), '{');
  const past = new Date(Date.now() - 20000);
  await fs.utimes(ownerFile, past, past);
  const lock = await acquireRuntimeLock(storage);
  assert.equal(JSON.parse(await fs.readFile(ownerFile, 'utf8')).token, lock.token);
  await lock.release();
});

test('root-created private owner follows storage ownership and remains reclaimable by its nonroot user after SIGKILL', {
  skip: process.platform !== 'linux' || process.getuid?.() !== 0,
}, async t => {
  const root = await directory(t);
  const uid = 65534, gid = 65534;
  // Copy the standard-library-only module so the nonroot child does not need access to the checkout.
  const modulePath = join(root, 'process-lock.mjs');
  await fs.copyFile(new URL('../lib/process-lock.mjs', import.meta.url), modulePath);
  await fs.chmod(modulePath, 0o600);
  await fs.chown(modulePath, uid, gid);
  await fs.chown(root, uid, gid);
  const storage = join(root, 'storage');
  await fs.mkdir(storage, { mode: 0o700 });
  await fs.chown(storage, uid, gid);
  const options = { moduleUrl: pathToFileURL(modulePath).href, cwd: root };
  const privileged = probe(t, options);
  await privileged.message('ready');
  privileged.send({ type: 'go', directory: storage });
  const original = await privileged.message('locked', 'failed');
  assert.equal(original.type, 'locked');
  const ownerFile = join(storage, 'runtime-owner.json');
  const owner = await fs.stat(ownerFile);
  assert.equal(owner.uid, uid);
  assert.equal(owner.gid, gid);
  assert.equal(owner.mode & 0o777, 0o600);
  await privileged.kill();
  const unprivileged = probe(t, { ...options, uid, gid });
  await unprivileged.message('ready');
  unprivileged.send({ type: 'go', directory: storage });
  const recovered = await unprivileged.message('locked', 'failed');
  assert.equal(recovered.type, 'locked');
  assert.notEqual(recovered.token, original.token);
  const replacement = await fs.stat(ownerFile);
  assert.equal(replacement.uid, uid);
  assert.equal(replacement.gid, gid);
  assert.equal(replacement.mode & 0o777, 0o600);
  const released = unprivileged.message('released');
  unprivileged.send({ type: 'release' });
  await released;
  await assert.rejects(fs.stat(ownerFile), { code: 'ENOENT' });
});
