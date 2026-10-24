import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { ClusterId, Status, StatusResponseError, TlvOfModel } from '@matter/main/types';
import { MIJIA_METADATA_CLUSTER_ID, MijiaMetadata, MijiaMetadataBehavior,
  MatterMetadataControl } from '../lib/matter-metadata-cluster.mjs';

const sourceEpoch = '12345678-1234-4234-8234-123456789abc';
const selection = { deviceId: '8934823423478234', homeId: '9323452345234', homeOwner: '8234523452345', region: 'cn', name: '旧名' };
const hash = value => createHash('sha256').update(value).digest('hex');
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const rejectsStatus = (promise, status) => assert.rejects(promise, error => {
  assert.equal(error.code, status); assert.doesNotMatch(error.message, /PRIVATE|8934823423478234|9323452345234/); return true;
});
const request = (control, extra = {}) => {
  const value = control.state().snapshot;
  return { expectedIdentity: value.identity, expectedSourceEpoch: value.sourceEpoch, expectedRevision: value.revision, ...extra };
};
function fixture({ onChange, empty = false } = {}) {
  const calls = [];
  const runtime = { paused: false, closed: false, selection: { ...selection },
    root: { sourceEpoch, revision: empty ? 0 : 7, enabled: true, loading: false, lastError: null, metadata: null },
    selected() { return structuredClone(this.selection); },
    metadataStatus() { return structuredClone(this.root); },
    snapshot(extra = {}) {
      return { ...this.selection, sourceEpoch: this.root.sourceEpoch, revision: this.root.revision,
        name: '入口摄像头', homeName: '家庭', roomId: '4', roomName: '客厅', observedAt: '2026-10-24T10:00:00.000Z',
        accountId: 'PRIVATE_ACCOUNT', serviceToken: 'PRIVATE_TOKEN',
        rooms: [{ id: '4', name: '客厅', dids: ['PRIVATE_OTHER_DEVICE'] }, { id: '5', name: '卧室' }], ...extra };
    },
    async refreshMetadata(options) {
      calls.push(['refresh', options]); this.root.revision++;
      this.root.metadata = this.snapshot({ name: '云端新名' }); return structuredClone(this.root.metadata);
    },
    async setMetadataSync(options) {
      calls.push(['sync', options]); this.root.revision++; this.root.enabled = options.enabled;
      if (this.root.metadata) this.root.metadata.revision = this.root.revision;
      return this.metadataStatus();
    },
    async updateMetadata(options) {
      calls.push(['update', options]); this.root.revision++;
      this.root.metadata = this.snapshot(options.operation === 'rename' ? { name: options.name }
        : { roomId: options.roomId, roomName: options.roomId === '4' ? '客厅' : '卧室' });
      return { ...structuredClone(this.root.metadata), confirmed: true };
    },
  };
  if (!empty) runtime.root.metadata = runtime.snapshot();
  return { runtime, calls, control: new MatterMetadataControl({ runtime, onChange }) };
}

test('metadata schema fixes vendor ID, revision, read-only attributes, struct fields and guarded commands', () => {
  assert.equal(MIJIA_METADATA_CLUSTER_ID, 0xfff1fc02);
  assert.equal(ClusterId.isVendorSpecific(MIJIA_METADATA_CLUSTER_ID), true);
  assert.equal(MijiaMetadata.revision, 1); assert.ok(MijiaMetadataBehavior);
  const children = MijiaMetadata.schema.children;
  const attributes = children.filter(item => item.tag === 'attribute' && item.id < 0xfff0);
  assert.deepEqual(attributes.map(item => [item.id, item.name]), [[0, 'Snapshot'], [1, 'Rooms'], [2, 'Capabilities'],
    [3, 'SyncEnabled'], [4, 'Available'], [5, 'Loading'], [6, 'LastError']]);
  assert.ok(attributes.every(item => item.access.readable && !item.access.writable));
  assert.deepEqual(Object.keys(MijiaMetadata.commands), ['refreshMetadata', 'setSyncEnabled', 'renameDevice', 'moveDevice']);
  const commands = children.filter(item => item.tag === 'command');
  assert.deepEqual(commands.map(item => [item.id, item.name, item.response]), [[0, 'RefreshMetadata', 'status'], [1, 'SetSyncEnabled', 'status'],
    [2, 'RenameDevice', 'status'], [3, 'MoveDevice', 'status']]);
  for (const command of commands) {
    assert.deepEqual(command.children.map(item => [item.id, item.name]), [[0, 'ExpectedIdentity'], [1, 'ExpectedSourceEpoch'],
      [2, 'ExpectedRevision'], ...(command.id > 0 ? [[3, ['Enabled', 'Name', 'RoomId'][command.id - 1]]] : [])]);
    const tlv = TlvOfModel(command);
    const value = { expectedIdentity: 'a'.repeat(64), expectedSourceEpoch: sourceEpoch, expectedRevision: 4294967296,
      ...(command.id === 1 ? { enabled: true } : command.id === 2 ? { name: '摄像头' } : command.id === 3 ? { roomId: '5' } : {}) };
    assert.deepEqual(tlv.decode(tlv.encode(value)), { ...value, expectedRevision: 4294967296n });
    for (const key of Object.keys(value)) { const absent = { ...value }; delete absent[key]; assert.throws(() => tlv.validate(absent)); }
    assert.throws(() => tlv.validate({ ...value, expectedIdentity: 'a'.repeat(65) }));
    assert.throws(() => tlv.validate({ ...value, expectedSourceEpoch: 'a'.repeat(37) }));
    assert.throws(() => tlv.validate({ ...value, expectedRevision: -1 }));
    if (command.id === 2) assert.throws(() => tlv.validate({ ...value, name: 'a'.repeat(161) }));
    if (command.id === 3) {
      assert.throws(() => tlv.validate({ ...value, roomId: 'a'.repeat(31) }));
      assert.equal(tlv.decode(tlv.encode({ ...value, roomId: '' })).roomId, '', 'empty is wire-valid but not an allowed write');
    }
  }
  const snapshotStruct = children.find(item => item.name === 'SnapshotStruct');
  assert.deepEqual(snapshotStruct.children.map(item => [item.id, item.name]), [[0, 'Identity'], [1, 'SourceEpoch'], [2, 'Revision'],
    [3, 'Name'], [4, 'HomeKey'], [5, 'HomeName'], [6, 'RoomId'], [7, 'RoomName'], [8, 'ObservedAt']]);
});

test('nested snapshot and room-list TLV preserve Unicode and enforce every length bound', () => {
  const { control } = fixture(), state = control.state();
  for (const attribute of MijiaMetadata.schema.children.filter(item => item.tag === 'attribute' && item.id < 0xfff0)) {
    const key = attribute.name[0].toLowerCase() + attribute.name.slice(1), tlv = TlvOfModel(attribute);
    tlv.validate(state[key]); assert.deepEqual(tlv.decode(tlv.encode(state[key])), state[key]);
  }
  const snapshot = TlvOfModel(MijiaMetadata.schema.children.find(item => item.name === 'Snapshot'));
  for (const [key, limit] of Object.entries({ identity: 64, sourceEpoch: 36, name: 160, homeKey: 64,
    homeName: 160, roomId: 30, roomName: 160, observedAt: 32 })) {
    assert.throws(() => snapshot.validate({ ...state.snapshot, [key]: 'a'.repeat(limit + 1) }), key);
  }
  const rooms = TlvOfModel(MijiaMetadata.schema.children.find(item => item.name === 'Rooms'));
  assert.throws(() => rooms.validate([{ id: '4'.repeat(31), name: '房间' }]));
  assert.throws(() => rooms.validate([{ id: '4', name: '房'.repeat(161) }]));
  assert.throws(() => rooms.validate(Array.from({ length: 1001 }, () => ({ id: '4', name: '房间' }))));
  const lastError = TlvOfModel(MijiaMetadata.schema.children.find(item => item.name === 'LastError'));
  assert.throws(() => lastError.validate('x'.repeat(41)));
  control.close();
});

test('Matter source labels obey 160 UTF-8 bytes and malformed Unicode never reaches attribute encoding', async () => {
  const nameTlv = TlvOfModel(MijiaMetadata.schema.children.find(item => item.name === 'Snapshot'));
  const valid = ['a'.repeat(160), '界'.repeat(53) + 'a', '😀'.repeat(40)];
  for (const name of valid) {
    assert.equal(Buffer.byteLength(name), 160);
    const { runtime, control } = fixture(); runtime.root.metadata.name = name;
    const state = control.state(); assert.equal(state.available, true); assert.equal(state.snapshot.name, name);
    assert.deepEqual(nameTlv.decode(nameTlv.encode(state.snapshot)), state.snapshot);
    control.close();
  }
  const invalid = ['a'.repeat(161), '界'.repeat(53) + 'ab', '界'.repeat(85), '界'.repeat(86),
    '😀'.repeat(40) + 'a', '\ud800', '\udc00', 'valid\ud800tail'];
  assert.equal(Buffer.byteLength(invalid[2]), 255); assert.equal(Buffer.byteLength(invalid[3]), 258);
  for (const value of invalid) {
    for (const field of ['name', 'homeName', 'roomName', 'roomEntryName']) {
      let published;
      const { runtime, control } = fixture({ onChange: state => { published = state; } });
      const original = request(control);
      if (field === 'roomEntryName') runtime.root.metadata.rooms[0].name = value;
      else runtime.root.metadata[field] = value;
      await control.refresh();
      assert.equal(published.available, false, `${field} must not emit an unsafe string`);
      assert.equal(published.lastError, 'metadata_incomplete'); assert.deepEqual(published.rooms, []);
      assert.equal(published.snapshot.name, ''); assert.equal(published.snapshot.homeName, '');
      assert.equal(published.snapshot.homeKey, createHash('sha256').update(JSON.stringify([
        runtime.selection.region, runtime.selection.homeOwner, runtime.selection.homeId])).digest('hex'));
      assert.equal(published.snapshot.roomId, ''); assert.equal(published.snapshot.roomName, '');
      assert.equal(published.snapshot.observedAt, runtime.root.metadata.observedAt);
      assert.equal(published.snapshot.identity, original.expectedIdentity);
      assert.equal(published.snapshot.sourceEpoch, original.expectedSourceEpoch);
      assert.equal(published.snapshot.revision, original.expectedRevision);
      assert.deepEqual(nameTlv.decode(nameTlv.encode(published.snapshot)), published.snapshot);
      control.close(); await control.publication;
    }
  }
});

test('rename enforces UTF-8 bytes and scalar Unicode before any backend call', async () => {
  const { runtime, calls, control } = fixture();
  runtime.root.capabilities = { rename: true, move: true };
  for (const name of ['界'.repeat(53) + 'a', '😀'.repeat(40)]) {
    assert.equal(Buffer.byteLength(name), 160);
    await control.renameDevice(request(control, { name }));
    assert.equal(control.state().snapshot.name, name);
  }
  assert.equal(calls.length, 2);
  for (const name of ['a'.repeat(161), '界'.repeat(53) + 'ab', '界'.repeat(85), '界'.repeat(86),
    '😀'.repeat(40) + 'a', '\ud800', '\udc00', 'a\ud800b'])
    await rejectsStatus(control.renameDevice(request(control, { name })), Status.ConstraintError);
  assert.equal(calls.length, 2, 'invalid names must never be encoded or dispatched');
  control.close();
});

test('projection exposes only hashes and labels; write capabilities default to unavailable', async () => {
  const { runtime, calls, control } = fixture();
  const value = control.state();
  assert.equal(value.snapshot.identity, hash(String(selection.deviceId)));
  assert.equal(value.snapshot.homeKey, hash(JSON.stringify([selection.region, selection.homeOwner, selection.homeId])));
  assert.equal(value.snapshot.sourceEpoch, sourceEpoch); assert.equal(value.snapshot.revision, 7);
  assert.equal(value.available, true); assert.equal(value.syncEnabled, true);
  assert.deepEqual(value.capabilities, { read: true, rename: false, move: false, syncConfig: true });
  assert.deepEqual(value.rooms, [{ id: '4', name: '客厅' }, { id: '5', name: '卧室' }]);
  const encoded = JSON.stringify(value);
  for (const secret of ['PRIVATE', selection.deviceId, selection.homeId, selection.homeOwner, 'accountId', 'deviceId']) assert.equal(encoded.includes(secret), false);
  value.rooms[0].name = 'changed'; value.snapshot.name = 'changed';
  assert.equal(control.state().rooms[0].name, '客厅');
  await control.refresh(); assert.equal(calls.length, 0, 'publishing must never read the cloud');
  for (const key of ['paused', 'closed']) { runtime[key] = true; assert.equal(control.state().available, false); runtime[key] = false; }
  runtime.root.loading = true; assert.equal(control.state().loading, true);
  delete runtime.refreshMetadata; delete runtime.setMetadataSync;
  assert.deepEqual(control.state().capabilities, { read: false, rename: false, move: false, syncConfig: false });
  control.close();
});

test('an empty snapshot provides identity, epoch and revision for the first guarded refresh', async () => {
  const { runtime, calls, control } = fixture({ empty: true });
  const before = control.state();
  assert.equal(before.available, false); assert.equal(before.snapshot.name, ''); assert.equal(before.snapshot.revision, 0);
  assert.equal(before.snapshot.identity.length, 64); assert.equal(before.snapshot.sourceEpoch, sourceEpoch);
  await control.refreshMetadata(request(control, { expectedRevision: 0n }));
  assert.deepEqual(calls, [['refresh', { expectedSourceEpoch: sourceEpoch, expectedRevision: 0 }]]);
  assert.equal(control.state().available, true); assert.equal(control.state().snapshot.name, '云端新名');
  assert.equal(control.state().snapshot.revision, runtime.root.revision);
  control.close();
});

test('every command requires all three guards and safely converts only exact uint64 revisions', async () => {
  const { runtime, calls, control } = fixture();
  runtime.root.capabilities = { rename: true, move: true };
  for (const method of ['refreshMetadata', 'setSyncEnabled', 'renameDevice', 'moveDevice']) {
    const valid = request(control, { enabled: false, name: '新名称', roomId: '5' });
    for (const key of ['expectedIdentity', 'expectedSourceEpoch', 'expectedRevision']) {
      const invalid = { ...valid }; delete invalid[key]; await rejectsStatus(control[method](invalid), Status.ConstraintError);
    }
    for (const value of [-1, 1.5, '7', Number.MAX_SAFE_INTEGER + 1, -1n, BigInt(Number.MAX_SAFE_INTEGER) + 1n])
      await rejectsStatus(control[method]({ ...valid, expectedRevision: value }), Status.ConstraintError);
    for (const patch of [{ expectedIdentity: 'a'.repeat(64) }, { expectedSourceEpoch: 'different-process' }, { expectedRevision: 6 }])
      await rejectsStatus(control[method]({ ...valid, ...patch }), Status.InvalidInState);
  }
  await rejectsStatus(control.setSyncEnabled(request(control)), Status.ConstraintError);
  await rejectsStatus(control.setSyncEnabled(request(control, { enabled: 'false' })), Status.ConstraintError);
  assert.equal(calls.length, 0);
  await control.setSyncEnabled(request(control, { expectedRevision: 7n, enabled: false }));
  assert.deepEqual(calls[0], ['sync', { expectedSourceEpoch: sourceEpoch, expectedRevision: 7, enabled: false }]);
  assert.equal(control.state().syncEnabled, false);
  control.close();
});

test('write commands require verified runtime capabilities and can move only to an existing room', async () => {
  const { runtime, calls, control } = fixture();
  for (const method of ['renameDevice', 'moveDevice'])
    await rejectsStatus(control[method](request(control, { name: '新名称', roomId: '5' })), Status.InvalidInState);
  assert.equal(calls.length, 0);
  runtime.root.capabilities = { rename: true, move: false };
  assert.equal(control.state().capabilities.rename, true); assert.equal(control.state().capabilities.move, false);
  await rejectsStatus(control.moveDevice(request(control, { roomId: '5' })), Status.InvalidInState);
  runtime.root.capabilities.move = true;
  for (const roomId of ['', ' ', '0005', 'not-a-room', '6', selection.homeId])
    await rejectsStatus(control.moveDevice(request(control, { roomId })), Status.ConstraintError);
  for (const name of ['', ' ', '  新名称  ', 'a'.repeat(161), 'name\u0000private', undefined])
    await rejectsStatus(control.renameDevice(request(control, { name })), Status.ConstraintError);
  assert.equal(calls.length, 0);
  delete runtime.updateMetadata;
  assert.equal(control.state().capabilities.rename, false); assert.equal(control.state().capabilities.move, false);
  await rejectsStatus(control.renameDevice(request(control, { name: '新名称' })), Status.InvalidInState);
  control.close();
});

test('explicit rename and room move await confirmed matching snapshots and preserve stable identity', async () => {
  let published;
  const { runtime, calls, control } = fixture({ onChange: value => { published = value; } });
  runtime.root.capabilities = { rename: true, move: true };
  const original = request(control);
  await control.renameDevice({ ...original, expectedRevision: 7n, name: '新名称' });
  assert.deepEqual(calls[0], ['update', { ...original, operation: 'rename', name: '新名称' }]);
  assert.equal(published.snapshot.name, '新名称'); assert.equal(published.snapshot.identity, original.expectedIdentity);
  const moved = request(control, { roomId: '5' });
  await control.moveDevice(moved);
  assert.deepEqual(calls[1], ['update', { expectedIdentity: moved.expectedIdentity, expectedSourceEpoch: moved.expectedSourceEpoch,
    expectedRevision: moved.expectedRevision, operation: 'move', roomId: '5' }]);
  assert.equal(published.snapshot.roomId, '5'); assert.equal(published.snapshot.roomName, '卧室');
  assert.equal(published.snapshot.identity, original.expectedIdentity); assert.equal(control.busy, false);
  control.close(); await control.publication;
});

test('a write cannot acknowledge without confirmed:true, a matching reply, and matching latest public metadata', async () => {
  for (const operation of ['rename', 'move']) {
    for (const failure of ['missing', 'rejected', 'wrong-reply', 'stale-snapshot']) {
      const { runtime, control } = fixture();
      runtime.root.capabilities = { rename: true, move: true };
      const key = operation === 'rename' ? 'name' : 'roomId', target = operation === 'rename' ? '新名称' : '5';
      runtime.updateMetadata = async () => {
        if (failure !== 'stale-snapshot') {
          runtime.root.revision++; runtime.root.metadata = runtime.snapshot({ [key]: target, ...(operation === 'move' ? { roomName: '卧室' } : {}) });
        }
        if (failure === 'missing') return { [key]: target };
        return { confirmed: failure !== 'rejected', [key]: failure === 'wrong-reply' ? 'wrong' : target };
      };
      await rejectsStatus(control[operation === 'rename' ? 'renameDevice' : 'moveDevice'](request(control, { [key]: target })), Status.Failure);
      assert.equal(control.busy, false); control.close();
    }
  }
});

test('all four commands share one busy guard and cannot queue backend work', async () => {
  const entered = defer(), pending = defer();
  const { runtime, calls, control } = fixture();
  runtime.root.capabilities = { rename: true, move: true };
  runtime.refreshMetadata = async options => { calls.push(['refresh', options]); entered.resolve(); return pending.promise; };
  const first = control.refreshMetadata(request(control)); await entered.promise;
  await rejectsStatus(control.setSyncEnabled(request(control, { enabled: false })), Status.Busy);
  await rejectsStatus(control.refreshMetadata(request(control)), Status.Busy);
  await rejectsStatus(control.renameDevice(request(control, { name: '新名称' })), Status.Busy);
  await rejectsStatus(control.moveDevice(request(control, { roomId: '5' })), Status.Busy);
  assert.equal(calls.length, 1); assert.equal(control.busy, true);
  pending.resolve(); await first; assert.equal(control.busy, false);
  control.close();
});

test('late completion cannot acknowledge a different camera, home, process or authorization state', async () => {
  for (const change of ['camera', 'home', 'source', 'paused', 'closed', 'invalidate']) {
    const pending = defer(), entered = defer();
    const { runtime, control } = fixture();
    runtime.refreshMetadata = async () => { entered.resolve(); return pending.promise; };
    const operation = control.refreshMetadata(request(control)); await entered.promise;
    if (change === 'camera') runtime.selection.deviceId = '111';
    else if (change === 'home') runtime.selection.homeId = '111';
    else if (change === 'source') runtime.root.sourceEpoch = '87654321-4321-4321-8321-cba987654321';
    else if (change === 'invalidate') await control.refresh({ invalidate: true });
    else runtime[change] = true;
    pending.resolve(); await rejectsStatus(operation, Status.InvalidInState);
    assert.equal(control.busy, false); control.close();
  }
});

test('close cancels pending confirmation immediately and rejects every later command', async () => {
  for (const method of ['refreshMetadata', 'setSyncEnabled', 'renameDevice', 'moveDevice']) {
    const pending = defer(), entered = defer();
    const { runtime, control } = fixture();
    runtime.root.capabilities = { rename: true, move: true };
    runtime[method === 'refreshMetadata' ? 'refreshMetadata' : method === 'setSyncEnabled' ? 'setMetadataSync' : 'updateMetadata'] = async () => { entered.resolve(); return pending.promise; };
    const value = request(control, { enabled: false, name: '新名称', roomId: '5' });
    const operation = control[method](value); await entered.promise;
    control.close(); await rejectsStatus(operation, Status.InvalidInState);
    assert.equal(control.state().available, false); assert.equal(control.busy, false);
    pending.resolve(); await Promise.resolve();
    await rejectsStatus(control[method](value), Status.InvalidInState);
  }
});

test('shutdown and selection changes also invalidate an ACK waiting for its final attribute publication', async () => {
  for (const change of ['close', 'selection']) {
    const entered = defer(), pending = defer();
    let writes = 0;
    const { runtime, control } = fixture({ async onChange() { if (++writes === 2) { entered.resolve(); await pending.promise; } } });
    const operation = control.refreshMetadata(request(control));
    await entered.promise; await Promise.resolve();
    assert.equal(control.busy, true, 'the final publication remains part of the command');
    if (change === 'close') {
      control.close(); await rejectsStatus(operation, Status.InvalidInState);
    } else {
      runtime.selection.homeId = '111'; pending.resolve(); await rejectsStatus(operation, Status.InvalidInState);
    }
    pending.resolve(); await control.publication; control.close();
  }
});

test('backend errors and diagnostics use fixed safe Matter status and reason text', async () => {
  for (const [reason, status] of [[undefined, Status.Failure], ['storage_failed', Status.Failure],
    ['metadata_conflict', Status.InvalidInState], ['auth_in_progress', Status.InvalidInState], ['invalid_request', Status.ConstraintError]]) {
    const { runtime, control } = fixture();
    runtime.refreshMetadata = async () => { throw Object.assign(new Error('PRIVATE_TOKEN_RAW_RESPONSE'), { reason }); };
    await rejectsStatus(control.refreshMetadata(request(control)), status);
    assert.equal(control.busy, false);
    runtime.root.lastError = 'PRIVATE_BACKEND_ERROR'; assert.equal(control.state().lastError, 'metadata_unavailable');
    runtime.root.lastError = 'query_timeout'; assert.equal(control.state().lastError, 'query_timeout');
    control.close();
  }
  const { runtime, control } = fixture();
  runtime.refreshMetadata = async () => { throw new StatusResponseError('PRIVATE_STATUS_MESSAGE', Status.ConstraintError); };
  await rejectsStatus(control.refreshMetadata(request(control)), Status.Failure);
  runtime.metadataStatus = () => { throw new Error('PRIVATE_STATUS_GETTER'); };
  assert.equal(control.state().lastError, 'metadata_unavailable'); assert.equal(control.state().available, false);
  control.close();
});

test('publications are serialized and each queued transaction reads the latest snapshot', async () => {
  const entered = defer(), pending = defer();
  let active = 0, count = 0, published;
  const { runtime, calls, control } = fixture({ async onChange(state) {
    assert.equal(active++, 0); count++;
    if (count === 1) { entered.resolve(); await pending.promise; }
    published = state; active--;
  } });
  const first = control.refresh(); await entered.promise;
  runtime.root.revision++; runtime.root.metadata = runtime.snapshot({ name: '最新名称', roomId: '5', roomName: '卧室' });
  const next = control.refresh(); pending.resolve(); await Promise.all([first, next]);
  assert.equal(active, 0); assert.equal(published.snapshot.name, '最新名称'); assert.equal(published.snapshot.roomId, '5');
  assert.equal(calls.length, 0);
  const identity = published.snapshot.identity, homeKey = published.snapshot.homeKey;
  await control.refreshMetadata(request(control));
  assert.equal(published.snapshot.name, '云端新名'); assert.equal(published.snapshot.identity, identity); assert.equal(published.snapshot.homeKey, homeKey);
  control.close(); await control.publication; assert.equal(published.available, false);
});

test('attribute publication failures remain visible and cannot produce successful Matter acknowledgements', async () => {
  let broken = true, published;
  const { calls, control } = fixture({ onChange: state => {
    if (broken) throw new Error('PRIVATE_ENDPOINT_PUBLICATION');
    published = state;
  } });
  await rejectsStatus(control.refresh(), Status.Failure);
  await rejectsStatus(control.refreshMetadata(request(control)), Status.Failure);
  assert.equal(calls.length, 0, 'a failed Loading publication must prevent backend work');
  broken = false; await control.refreshMetadata(request(control));
  assert.equal(published.snapshot.name, '云端新名'); assert.equal(published.available, true);
  control.close(); await control.publication;
});

test('command ACK follows Loading=true, authoritative readback and final Loading=false with new observedAt', async () => {
  const states = [], trace = [];
  const { runtime, control } = fixture({ async onChange(state) {
    states.push(state); trace.push(state.loading ? 'loading' : 'idle');
    await Promise.resolve();
  } });
  const initialObservedAt = control.state().snapshot.observedAt;
  runtime.refreshMetadata = async () => {
    assert.equal(states.at(-1).loading, true, 'backend work starts only after Loading=true was published');
    trace.push('backend'); runtime.root.revision++;
    runtime.root.metadata = runtime.snapshot({ observedAt: '2026-10-24T10:00:00.001Z' });
    return runtime.root.metadata;
  };
  await control.refreshMetadata(request(control)); trace.push('ack');
  assert.deepEqual(trace, ['loading', 'backend', 'idle', 'ack']);
  assert.equal(states.at(-1).loading, false); assert.equal(control.busy, false);
  assert.notEqual(states.at(-1).snapshot.observedAt, initialObservedAt);
  assert.equal(states.at(-1).snapshot.observedAt, runtime.root.metadata.observedAt);
  control.close(); await control.publication;
});

test('a changed guard during the initial Loading publication prevents backend dispatch', async () => {
  const entered = defer(), pending = defer();
  const { runtime, calls, control } = fixture({ async onChange(state) {
    if (state.loading) { entered.resolve(); await pending.promise; }
  } });
  const operation = control.refreshMetadata(request(control)); await entered.promise;
  runtime.root.revision++; runtime.root.metadata.revision++;
  pending.resolve(); await rejectsStatus(operation, Status.InvalidInState);
  assert.equal(calls.length, 0); assert.equal(control.state().loading, false);
  control.close(); await control.publication;
});
