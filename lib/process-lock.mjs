import { createServer } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { constants, readFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';

const fail = reason => Object.assign(new Error(reason), { reason });

function processStart(pid) {
  try {
    const value = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return value.slice(value.lastIndexOf(') ') + 2).split(' ')[19];
  } catch { return null; }
}

function ownerAlive(owner) {
  if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid < 1) return false;
  try { process.kill(owner.pid, 0); }
  catch (error) { return error.code === 'EPERM'; }
  const start = processStart(owner.pid);
  return !start || !owner.start || start === owner.start;
}

async function readOwner(file) {
  let handle;
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || info.size > 16384) throw fail('runtime_in_use');
    let owner;
    try {
      const parsed = JSON.parse(await handle.readFile('utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) owner = parsed;
    } catch {}
    return { owner, recent: Date.now() - info.mtimeMs < 10000 };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error.reason || error.code === 'ELOOP') throw fail('runtime_in_use');
    throw fail('storage_failed');
  } finally { await handle?.close().catch(() => {}); }
}

/** Kernel ownership precedes compatibility-file inspection, including stale-file reclamation. */
export async function acquireRuntimeLock(storagePath) {
  if (process.platform !== 'linux') throw fail('storage_failed');
  let identity, uid, gid;
  try {
    const info = await fs.stat(storagePath, { bigint: true });
    if (!info.isDirectory()) throw new Error();
    identity = `${info.dev}:${info.ino}`;
    uid = Number(info.uid); gid = Number(info.gid);
  } catch { throw fail('storage_failed'); }
  const name = `\0mijia-runtime-${createHash('sha256').update(identity).digest('hex')}`;
  const server = createServer(connection => connection.destroy());
  // An accepted connection never extends the owner's lifetime or receives data.
  server.on('error', () => {});
  try {
    await new Promise((resolve, reject) => {
      const failed = error => { server.off('listening', ready); reject(error); };
      const ready = () => { server.off('error', failed); resolve(); };
      server.once('error', failed);
      server.once('listening', ready);
      server.listen(name);
    });
  } catch (error) {
    throw fail(error.code === 'EADDRINUSE' ? 'runtime_in_use' : 'storage_failed');
  }
  server.unref();
  const closeServer = () => new Promise(resolve => server.close(() => resolve()));
  const token = randomUUID();
  const file = join(storagePath, 'runtime-owner.json');
  let handle, created = false;
  const removeOwnFile = async () => {
    try { if ((await readOwner(file))?.owner?.token === token) await fs.unlink(file); } catch {}
  };
  try {
    const previous = await readOwner(file);
    if (previous) {
      // Keep compatibility with an older plugin that only owns the PID file.
      if (ownerAlive(previous.owner) || (!previous.owner && previous.recent)) throw fail('runtime_in_use');
      await fs.unlink(file);
    }
    handle = await fs.open(file, 'wx', 0o600);
    created = true;
    // A root setup command must leave crash-recovery metadata readable by Homebridge.
    if (process.getuid?.() === 0) await handle.chown(uid, gid);
    await handle.writeFile(JSON.stringify({ token, pid: process.pid, start: processStart(process.pid) }));
    await handle.close();
    handle = undefined;
  } catch (error) {
    await handle?.close().catch(() => {});
    if (created) await removeOwnFile();
    await closeServer();
    throw error.reason ? error : fail(error.code === 'EEXIST' ? 'runtime_in_use' : 'storage_failed');
  }
  let releasing;
  return { token, release: () => releasing ??= (async () => {
    try { await removeOwnFile(); }
    finally { await closeServer(); }
  })() };
}
