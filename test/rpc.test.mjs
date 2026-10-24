import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { startRpcServer, createRpcClient, socketPath } from '../lib/rpc.mjs';

test('private UI RPC preserves requests and redacts unexpected backend errors', async () => {
  const path = await mkdtemp(join(tmpdir(), 'mijia-rpc-'));
  const server = await startRpcServer(path, async (method, payload) => {
    if (method === 'status') return { state: 'waiting' };
    if (method === 'devices') return { devices: [{ home: payload.homeId }] };
    throw new Error('PRIVATE_TOKEN https://secret.example');
  });
  try {
    const client = createRpcClient(path);
    assert.deepEqual(await client.request('status'), { state: 'waiting' });
    assert.deepEqual(await client.request('devices', { homeId: '202' }), { devices: [{ home: '202' }] });
    await assert.rejects(client.request('homes'), { message: 'operation_failed' });
    await assert.rejects(client.request('arbitrary.execute'), { message: 'invalid_request' });
    assert.equal((await stat(join(path, 'control.sock'))).mode & 0o777, 0o600);
  } finally { await server.close(); await rm(path, { recursive: true, force: true }); }
});

test('missing plugin instance gives a fixed UI reason', async () => {
  await assert.rejects(createRpcClient('/tmp/absent-mijia-rpc-fixture').request('status'), { reason: 'plugin_not_running' });
});

test('long storage paths retain the permission-protected socket inside storage or fail safely', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mijia-rpc-long-'));
  try {
    const length = 91 - Buffer.byteLength(root) - 1;
    const storage = join(root, 'a'.repeat(length));
    assert.ok(Buffer.byteLength(join(storage, 'control.sock')) > 100);
    assert.equal(dirname(socketPath(storage)), storage);
    assert.equal(socketPath(storage), join(storage, 'c.sock'));
    const server = await startRpcServer(storage, async () => ({ success: true }));
    try {
      assert.deepEqual(await createRpcClient(storage).request('status'), { success: true });
      assert.equal((await stat(storage)).mode & 0o777, 0o700);
      assert.equal((await stat(socketPath(storage))).mode & 0o777, 0o600);
    } finally { await server.close(); }
    const overlong = join(root, 'b'.repeat(105));
    assert.throws(() => socketPath(overlong), { reason: 'rpc_start_failed' });
    await assert.rejects(startRpcServer(overlong, async () => ({})), { reason: 'rpc_start_failed' });
    await assert.rejects(createRpcClient(overlong).request('status'), { reason: 'rpc_start_failed' });
    // Byte limits also apply to multibyte names, independently of character count.
    assert.throws(() => socketPath(join(root, '米'.repeat(40))), { reason: 'rpc_start_failed' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
