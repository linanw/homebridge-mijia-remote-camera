import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachServices } from '../lib/runtime-factory.mjs';
import { createRpcClient } from '../lib/rpc.mjs';

async function fixture() {
  const storage = await mkdtemp(join(tmpdir(), 'mijia-service-'));
  const runtime = {
    paused: false, closed: false, region: 'cn',
    status() { return { paused: this.paused }; },
    async pause() { this.paused = true; },
    async credentialsChanged() { this.paused = false; },
    async setRegion() { throw new Error('Region must not change before successful auth'); },
    selected() { return null; },
    async start() { if (this.paused) throw Object.assign(Error(), { reason: 'auth_in_progress' }); },
    async discoverHomes() { assert.equal(this.paused, false); return [{ id: '202' }]; },
    async close() { this.closed = true; },
  };
  const auth = {
    state: 'idle',
    async start() { this.state = 'waiting'; return { loginId: 'fixture', loginUrl: 'https://account.xiaomi.com/login?fixture' }; },
    status() { return { state: this.state, loginId: 'fixture', success: this.state === 'complete' }; },
    async cancel() { this.state = 'cancelled'; return this.status(); },
  };
  await attachServices(runtime, auth, storage);
  return { runtime, auth, client: createRpcClient(storage), async close() { await runtime.close(); await rm(storage, { recursive: true, force: true }); } };
}

test('browser authorization suspends previews and discovery until terminal state', async () => {
  const value = await fixture();
  try {
    await value.client.request('auth.start', { region: 'sg' });
    assert.equal(value.runtime.region, 'cn');
    assert.equal(value.runtime.paused, true);
    await assert.rejects(value.client.request('homes'), { reason: 'auth_in_progress' });
    await assert.rejects(value.runtime.start(), { reason: 'auth_in_progress' });
    await value.client.request('auth.status', { loginId: 'fixture' });
    assert.equal(value.runtime.paused, true);
    value.auth.state = 'complete';
    await value.client.request('auth.status', { loginId: 'fixture' });
    assert.equal(value.runtime.paused, false);
    assert.deepEqual(await value.client.request('homes'), [{ id: '202' }]);
  } finally { await value.close(); }
});

test('completed browser authorization releases suspension even when UI is closed', async () => {
  const value = await fixture();
  try {
    await value.client.request('auth.start', { region: 'cn' });
    value.auth.state = 'complete';
    await new Promise(resolve => setTimeout(resolve, 650));
    assert.equal(value.runtime.paused, false);
  } finally { await value.close(); }
});

test('cancelled authorization restores old session without changing its region', async () => {
  const value = await fixture();
  try {
    await value.client.request('auth.start', { region: 'sg' });
    await value.client.request('auth.cancel', { loginId: 'fixture' });
    assert.equal(value.runtime.paused, false);
    assert.equal(value.runtime.region, 'cn');
  } finally { await value.close(); }
});

test('status exposes live HomeKit media counters when the platform attaches its camera', async () => {
  const value = await fixture();
  try {
    assert.deepEqual(await value.client.request('status'), { paused: false });
    let requests = 0;
    value.runtime.mediaDiagnostics = () => ({ snapshot: { requests }, activeStreams: 0 });
    assert.equal((await value.client.request('status')).media.snapshot.requests, 0);
    requests++;
    assert.equal((await value.client.request('status')).media.snapshot.requests, 1);
  } finally { await value.close(); }
});

test('PTZ RPC uses only direction API and is suspended throughout account authorization', async () => {
  const value = await fixture();
  const calls = [];
  value.runtime.getPtzCapabilities = async () => ({ supported: false, available: true, directions: [], relativeStep: false, zoom: false, absolutePosition: false });
  value.runtime.movePtz = async direction => {
    calls.push(direction);
    if (!['up', 'down', 'left', 'right'].includes(direction)) throw { reason: 'invalid_request' };
    return { accepted: true, direction, movement: 'step' };
  };
  try {
    assert.equal((await value.client.request('ptz.capabilities')).available, true);
    assert.deepEqual(await value.client.request('ptz.move', { direction: 'left', command: 999, speed: 99, deviceId: 'PRIVATE_DEVICE' }), { accepted: true, direction: 'left', movement: 'step' });
    assert.deepEqual(calls, ['left']);
    await assert.rejects(value.client.request('ptz.move', { direction: 'PRIVATE_COMMAND' }), { reason: 'invalid_request' });
    await assert.rejects(value.client.request('ptz.probe', { operation: 1 }), { reason: 'invalid_request' });
    await value.client.request('auth.start', { region: 'cn' });
    await assert.rejects(value.client.request('ptz.capabilities'), { reason: 'auth_in_progress' });
    await assert.rejects(value.client.request('ptz.move', { direction: 'up' }), { reason: 'auth_in_progress' });
    assert.deepEqual(calls, ['left', 'PRIVATE_COMMAND']);
    await value.client.request('auth.cancel', { loginId: 'fixture' });
    value.runtime.movePtz = async () => { throw Object.assign(new Error('PRIVATE_TOKEN'), { reason: 'ptz_busy' }); };
    await assert.rejects(value.client.request('ptz.move', { direction: 'up' }), error => error.reason === 'ptz_busy' && !String(error).includes('PRIVATE'));
  } finally { await value.close(); }
});

test('metadata RPC exposes only selected-camera operations and suspends cloud reads during authorization', async () => {
  const value = await fixture();
  const calls = [];
  value.runtime.metadataStatus = () => ({ enabled: true, revision: 2, metadata: null });
  value.runtime.refreshMetadata = async options => { calls.push(['refresh', options]); return { name: '摄像头', revision: 3 }; };
  value.runtime.setMetadataSync = async options => { calls.push(['sync', options]); return { enabled: options.enabled }; };
  try {
    assert.equal((await value.client.request('status')).metadata.revision, 2);
    assert.equal((await value.client.request('metadata.status')).revision, 2);
    assert.equal((await value.client.request('metadata.refresh', { expectedRevision: 2, deviceId: 'OTHER' })).revision, 3);
    assert.deepEqual(calls[0], ['refresh', { expectedRevision: 2, expectedSourceEpoch: undefined }]);
    await value.client.request('metadata.sync', { enabled: false, expectedRevision: 3, accountId: 'OTHER' });
    assert.deepEqual(calls[1], ['sync', { enabled: false, expectedRevision: 3, expectedSourceEpoch: undefined }]);
    await assert.rejects(value.client.request('metadata.rename', { name: 'OTHER' }), { reason: 'invalid_request' });
    await value.client.request('auth.start', { region: 'cn' });
    await assert.rejects(value.client.request('metadata.refresh'), { reason: 'auth_in_progress' });
    await assert.rejects(value.client.request('metadata.sync', { enabled: true }), { reason: 'auth_in_progress' });
    assert.equal(calls.length, 2);
    assert.equal((await value.client.request('metadata.status')).enabled, true);
  } finally { await value.close(); }
});

test('service shutdown installs the pause barrier before asynchronous login cleanup', async () => {
  const value = await fixture();
  let release;
  value.auth.cancel = () => new Promise(resolve => { release = resolve; });
  const closing = value.runtime.close();
  assert.equal(value.runtime.paused, true);
  await assert.rejects(value.runtime.start(), { reason: 'auth_in_progress' });
  release(); await closing;
  assert.equal(value.runtime.closed, true);
  await value.close();
});
