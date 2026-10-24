import test from 'node:test';
import assert from 'node:assert/strict';
import { MetadataSync, normalizeMetadata } from '../lib/metadata-sync.mjs';

const context = { accountId: '123', key: 'private-context', deviceId: '803', homeId: '202', homeOwner: '22', region: 'cn' };
const snapshot = (extra = {}) => ({ ...context, name: '客厅摄像头', homeName: '家', roomId: '4', roomName: '客厅',
  rooms: [{ id: '4', name: '客厅', deviceIds: ['PRIVATE_OTHER_DEVICE'] }, { id: '5', name: '卧室' }],
  serviceToken: 'PRIVATE_TOKEN', ...extra });
const deferred = () => { let resolve; const promise = new Promise(accept => { resolve = accept; }); return { promise, resolve }; };

test('metadata snapshots are bound to account, region and exact home/device and expose only room names', () => {
  const result = normalizeMetadata(snapshot(), context);
  assert.deepEqual(result.rooms, [{ id: '4', name: '客厅' }, { id: '5', name: '卧室' }]);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  assert.equal('accountId' in result, false);
  for (const extra of [{ accountId: '124' }, { deviceId: '804' }, { homeId: '203' }, { homeOwner: '23' },
    { region: 'sg' }, { roomId: '6' }, { roomName: '错误房间' }, { roomId: '', roomName: '客厅' },
    { rooms: [{ id: '4', name: '客厅' }, { id: '4', name: '客厅' }] }]) {
    assert.throws(() => normalizeMetadata(snapshot(extra), context), { reason: 'invalid_backend_response' });
  }
});

test('unchanged reads retain revision; rename and room move emit metadata without changing identity', async t => {
  let value = snapshot();
  const sync = new MetadataSync({ getContext: () => context, read: async () => value });
  t.after(() => sync.close());
  const events = []; sync.on('metadata', value => events.push(value));
  const first = await sync.refresh();
  const same = await sync.refresh({ expectedRevision: first.revision });
  assert.equal(same.revision, first.revision);
  assert.ok(Date.parse(same.observedAt) > Date.parse(first.observedAt));
  assert.equal(events.length, 1);
  value = snapshot({ name: '卧室摄像头', roomId: '5', roomName: '卧室' });
  const moved = await sync.refresh();
  assert.equal(moved.deviceId, first.deviceId);
  assert.ok(moved.revision > first.revision);
  assert.equal(events.length, 2);
  moved.rooms[0].name = 'mutated';
  assert.equal(sync.status().metadata.rooms[0].name, '客厅');
  await assert.rejects(sync.refresh({ expectedRevision: first.revision }), { reason: 'metadata_conflict' });
});

test('disabling, authorization suspension and shutdown reject in-flight reads even when the transport ignores abort', async () => {
  for (const action of ['disable', 'suspend', 'close']) {
    const pending = deferred();
    let read = false;
    const sync = new MetadataSync({ getContext: () => context, read: async () => { read = true; return pending.promise; } });
    const events = []; sync.on('metadata', value => events.push(value));
    const request = sync.refresh();
    await Promise.resolve(); assert.equal(read, true);
    if (action === 'disable') sync.setEnabled(false);
    else sync[action]();
    await assert.rejects(request, { reason: 'query_cancelled' });
    pending.resolve(snapshot()); await Promise.resolve();
    assert.equal(events.length, 0);
    assert.equal(sync.status().loading, false);
    sync.close();
  }
});

test('account or selection changes discard late replies and remove the previous public snapshot', async t => {
  let active = context, value = snapshot();
  const pending = deferred();
  const sync = new MetadataSync({ getContext: () => active, read: async () => value });
  t.after(() => sync.close());
  await sync.refresh(); value = pending.promise;
  const read = sync.refresh(); await Promise.resolve();
  active = { ...context, accountId: '999', key: 'new-private-context' };
  assert.equal(sync.status().metadata, null);
  await assert.rejects(read, { reason: 'query_cancelled' });
  pending.resolve(snapshot());
});

test('bounded metadata timeout preserves safe diagnostics and later reads recover', async t => {
  let hang = true;
  const sync = new MetadataSync({ getContext: () => context, timeoutMs: 5,
    read: () => hang ? new Promise(() => {}) : snapshot() });
  t.after(() => sync.close());
  await assert.rejects(sync.refresh(), { reason: 'query_timeout' });
  assert.equal(sync.status().lastError, 'query_timeout');
  hang = false;
  assert.equal((await sync.refresh()).name, '客厅摄像头');
  assert.equal(sync.status().lastError, null);
});

test('automatic sync uses a 60 second default, can stop, and does not poll after shutdown', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let count = 0;
  const sync = new MetadataSync({ getContext: () => context, read: async () => { count++; return snapshot(); } });
  t.after(() => sync.close());
  const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  assert.equal(sync.status().intervalSeconds, 60);
  sync.start(); t.mock.timers.tick(1); await flush();
  assert.equal(count, 1);
  t.mock.timers.tick(59998); await flush(); assert.equal(count, 1);
  t.mock.timers.tick(2); await flush(); assert.equal(count, 2);
  sync.setEnabled(false); t.mock.timers.tick(120000); await flush(); assert.equal(count, 2);
  sync.setEnabled(true); t.mock.timers.tick(1); await flush(); assert.equal(count, 3);
  sync.close(); t.mock.timers.tick(120000); await flush(); assert.equal(count, 3);
});

test('an old process source epoch cannot pass revision checks after a restart', async t => {
  let reads = 0;
  const original = new MetadataSync({ getContext: () => context, read: async () => snapshot() });
  const replacement = new MetadataSync({ getContext: () => context, read: async () => { reads++; return snapshot(); } });
  t.after(() => { original.close(); replacement.close(); });
  assert.equal(original.status().revision, replacement.status().revision);
  assert.notEqual(original.status().sourceEpoch, replacement.status().sourceEpoch);
  const old = { expectedRevision: 0, expectedSourceEpoch: original.status().sourceEpoch };
  await assert.rejects(replacement.refresh(old), { reason: 'metadata_conflict' });
  assert.throws(() => replacement.setEnabled(false, old.expectedRevision, old.expectedSourceEpoch), { reason: 'metadata_conflict' });
  assert.equal(reads, 0); assert.equal(replacement.status().enabled, true);
  const value = await replacement.refresh({ expectedRevision: 0, expectedSourceEpoch: replacement.status().sourceEpoch });
  assert.equal(value.sourceEpoch, replacement.status().sourceEpoch);
});

test('a cancelled old automatic read cannot defer the immediate resume poll', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = deferred(); let reads = 0;
  const sync = new MetadataSync({ getContext: () => context, read: () => ++reads === 1 ? pending.promise : snapshot() });
  t.after(() => sync.close());
  const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
  sync.start(); t.mock.timers.tick(1); await flush(); assert.equal(reads, 1);
  sync.setEnabled(false); sync.setEnabled(true); await flush();
  t.mock.timers.tick(1); await flush(); assert.equal(reads, 2);
  pending.resolve(snapshot()); await flush();
});

test('safe metadata-state updates include unchanged successes, local sync changes and failures', async t => {
  let fail = false;
  const sync = new MetadataSync({ getContext: () => context, read: () => {
    if (fail) throw Error('PRIVATE_TOKEN'); return snapshot();
  } });
  t.after(() => sync.close());
  const states = []; sync.on('state', value => states.push(value));
  await sync.refresh(); const before = states.length;
  await sync.refresh(); assert.ok(states.length > before);
  sync.setEnabled(false); assert.equal(states.at(-1).enabled, false);
  sync.setEnabled(true); assert.equal(states.at(-1).metadata.name, '客厅摄像头');
  fail = true; await assert.rejects(sync.refresh(), { reason: 'metadata_unavailable' });
  assert.equal(states.at(-1).lastError, 'metadata_unavailable');
  assert.equal(JSON.stringify(states).includes('PRIVATE'), false);
});
