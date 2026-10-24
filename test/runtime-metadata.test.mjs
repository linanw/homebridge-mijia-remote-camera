import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RuntimeManager } from '../lib/runtime.mjs';
import { metadataFingerprint } from '../lib/metadata-sync.mjs';

const selected = { homeId: '202', homeOwner: '22', deviceId: '803', region: 'cn', name: '旧名', model: 'chuangmi.camera.061a01' };
const credentials = { userId: '123', ssecurity: 'PRIVATE_SECURITY', serviceToken: 'PRIVATE_TOKEN', region: 'cn' };
const snapshot = extra => ({ success: true, accountId: '123', ...selected, name: '云端新名', homeName: '家', roomId: '4', roomName: '客厅',
  rooms: [{ id: '4', name: '客厅' }, { id: '5', name: '卧室' }], private: 'PRIVATE_FIELD', ...extra });
const eventually = async check => {
  for (let attempt = 0; attempt < 100; attempt++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 2)); }
  assert.fail('fixture did not settle');
};
class Child extends EventEmitter {
  constructor() { super(); this.stdout = new PassThrough(); this.pid = 987654; this.exitCode = null; this.signalCode = null; }
  json(value) { this.stdout.write(`${JSON.stringify(value)}\n`); }
  exit() { if (this.exitCode !== null) return; this.exitCode = 0; this.emit('close', 0); }
}
async function fixture(t, handler) {
  const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), 'mijia-meta-'));
  const credentialFile = path.join(storagePath, '.micam/credentials.json');
  await fs.mkdir(path.dirname(credentialFile)); await fs.writeFile(credentialFile, JSON.stringify(credentials));
  await fs.writeFile(path.join(storagePath, 'selection.json'), JSON.stringify(selected));
  const calls = [], terminated = [];
  const runtime = new RuntimeManager({ storagePath, javaPath: 'java', jarPath: 'micam.jar', bridgePath: 'bridge.jar', choosePort: async () => 32188,
    spawn: (command, args) => {
      const child = new Child(); calls.push({ args, child });
      process.nextTick(() => handler?.(child, args)); return child;
    }, terminateProcess: async child => { if (child) { terminated.push(child); child.exit(); } } });
  t.after(async () => { await runtime.close(); await fs.rm(storagePath, { recursive: true, force: true }); });
  return { runtime, storagePath, credentialFile, calls, terminated };
}

async function ownedFixture(t, handler) {
  const value = await fixture(t, handler);
  value.runtime.metadataWriteValidated = true;
  await fs.writeFile(path.join(value.storagePath, 'selection.json'), JSON.stringify({ ...selected, homeOwner: '123' }));
  return value;
}
const guarded = runtime => {
  const status = runtime.metadataStatus();
  return { expectedIdentity: status.identity, expectedRevision: status.revision, expectedSourceEpoch: status.sourceEpoch };
};

test('metadata helper is bound to selected home, actual owner, device, account and region without exposing credentials', async t => {
  const { runtime, calls } = await fixture(t, child => { child.json(snapshot()); child.exit(); });
  const result = await runtime.refreshMetadata();
  assert.deepEqual(calls[0].args.slice(-7), ['mijia.bridge.CloudMetadata', 'get', 'cn', '202', '22', '803', '123']);
  assert.equal(result.name, '云端新名');
  assert.equal(result.roomName, '客厅');
  assert.deepEqual(result.rooms, [{ id: '4', name: '客厅' }, { id: '5', name: '卧室' }]);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  assert.equal(JSON.stringify(calls[0].args).includes('PRIVATE'), false);
  assert.equal('accountId' in result, false);
});

test('cloud rename and same-home room moves never stop video or emit selection', async t => {
  let value = snapshot();
  const { runtime, calls, terminated } = await fixture(t, (child, args) => {
    if (args.includes('mijia.bridge.CloudMetadata')) { child.json(value); child.exit(); }
    else child.json({ success: true, event: 'ready', port: 32188, codec: 'H264', videoReceived: true });
  });
  const selections = [], metadata = [];
  runtime.on('selection', value => selections.push(value)); runtime.on('metadata', value => metadata.push(value));
  await runtime.start(); const stream = runtime.child;
  await runtime.refreshMetadata();
  value = snapshot({ name: '卧室摄像头', roomId: '5', roomName: '卧室' });
  await runtime.refreshMetadata();
  assert.equal(runtime.child, stream); assert.equal(runtime.ready, true);
  assert.equal(terminated.includes(stream), false); assert.equal(selections.length, 0); assert.equal(metadata.length, 2);
  assert.equal(calls.filter(call => call.args.includes('stream')).length, 1);
  await runtime.select({ ...selected, name: '本地名称调整' });
  assert.equal(runtime.child, stream); assert.equal(selections.length, 0);
});

test('account changes and authorization cancellation cannot publish stale metadata', async t => {
  const { runtime, calls, credentialFile, terminated } = await fixture(t);
  const request = runtime.refreshMetadata(); await eventually(() => calls.length === 1);
  await fs.writeFile(credentialFile, JSON.stringify({ ...credentials, userId: '999' }));
  calls[0].child.json(snapshot()); calls[0].child.exit();
  await assert.rejects(request, { reason: 'query_cancelled' });
  assert.equal(runtime.metadataStatus().metadata, null);
  await fs.writeFile(credentialFile, JSON.stringify(credentials));
  const later = runtime.refreshMetadata(); await eventually(() => calls.length === 2);
  const paused = runtime.pause();
  await assert.rejects(later, { reason: 'query_cancelled' }); await paused;
  assert.ok(terminated.includes(calls[1].child));
  await assert.rejects(runtime.refreshMetadata(), { reason: 'auth_in_progress' });
});

test('metadata requires selected logged-in region and rejects another home response with fixed errors', async t => {
  const { runtime, credentialFile, calls } = await fixture(t, child => { child.json(snapshot({ homeOwner: 'wrong PRIVATE' })); child.exit(); });
  await fs.writeFile(credentialFile, JSON.stringify({ ...credentials, region: 'sg' }));
  await assert.rejects(runtime.refreshMetadata(), { reason: 'authentication_required' }); assert.equal(calls.length, 0);
  await fs.writeFile(credentialFile, JSON.stringify(credentials));
  await assert.rejects(runtime.refreshMetadata(), error => error.reason === 'invalid_backend_response' && !String(error).includes('PRIVATE'));
  assert.equal(runtime.metadataStatus().metadata, null);
});

test('sync preference is private, survives reload, and stale revision cannot overwrite a newer preference', async t => {
  const { runtime, storagePath } = await fixture(t, child => { child.json(snapshot()); child.exit(); });
  const metadata = await runtime.refreshMetadata();
  await runtime.setMetadataSync({ enabled: false, expectedRevision: metadata.revision });
  await assert.rejects(runtime.setMetadataSync({ enabled: true, expectedRevision: metadata.revision }), { reason: 'metadata_conflict' });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(storagePath, 'metadata-sync.json'))), { enabled: false });
  assert.equal((await fs.stat(path.join(storagePath, 'metadata-sync.json'))).mode & 0o777, 0o600);
  const reloaded = new RuntimeManager({ storagePath, javaPath: 'java', jarPath: 'micam', bridgePath: 'bridge', spawn: () => { throw Error(); } });
  assert.equal(reloaded.metadataStatus().enabled, false); await reloaded.close();
});

test('writes are gated until validation and shared-family write claims cannot elevate ownership', async t => {
  const { runtime, calls } = await fixture(t, child => { child.json(snapshot()); child.exit(); });
  await assert.rejects(runtime.updateMetadata({ operation: 'rename', name: '新名' }), { reason: 'metadata_write_unsupported' });
  assert.equal(calls.length, 0);
  await runtime.refreshMetadata(); runtime.metadataWriteValidated = true;
  assert.equal(runtime.metadataStatus().capabilities.rename, false);
  await assert.rejects(runtime.updateMetadata({ operation: 'rename', name: '新名', ...guarded(runtime) }), { reason: 'metadata_not_owner' });
  assert.equal(calls.length, 1);
});

test('explicit rename and existing-room move use one bound helper each, confirmed readback and preserve video', async t => {
  let value = snapshot({ homeOwner: '123' });
  const { runtime, calls, terminated } = await ownedFixture(t, (child, args) => {
    if (args.includes('stream')) child.json({ success: true, event: 'ready', port: 32188, codec: 'H264', videoReceived: true });
    else {
      const index = args.indexOf('mijia.bridge.CloudMetadata');
      const operation = args[index + 1];
      if (operation === 'rename64') value = { ...value, name: Buffer.from(args.at(-1), 'base64').toString('utf8'), confirmed: true };
      if (operation === 'move') value = { ...value, roomId: args.at(-1), roomName: '卧室', confirmed: true };
      child.json(value); child.exit();
    }
  });
  await runtime.start(); const stream = runtime.child;
  const first = await runtime.refreshMetadata();
  assert.equal(runtime.metadataStatus().capabilities.rename, true);
  const renamed = await runtime.updateMetadata({ operation: 'rename', name: '指定名称', ...guarded(runtime) });
  assert.equal(renamed.confirmed, true); assert.equal(renamed.name, '指定名称');
  const rename = calls.find(call => call.args.includes('rename64'));
  assert.deepEqual(rename.args.slice(-8), ['rename64', 'cn', '202', '123', '803', '123', metadataFingerprint(first), Buffer.from('指定名称', 'utf8').toString('base64')]);
  const moved = await runtime.updateMetadata({ operation: 'move', roomId: '5', ...guarded(runtime) });
  assert.equal(moved.confirmed, true); assert.equal(moved.roomId, '5');
  assert.equal(calls.filter(call => ['rename64', 'move'].some(operation => call.args.includes(operation))).length, 2);
  assert.equal(runtime.child, stream); assert.equal(terminated.includes(stream), false);
  await assert.rejects(runtime.updateMetadata({ operation: 'move', roomId: '', ...guarded(runtime) }), { reason: 'invalid_request' });
  await assert.rejects(runtime.updateMetadata({ operation: 'move', roomId: '999', ...guarded(runtime) }), { reason: 'invalid_request' });
});

test('stale identity, epoch and revision are refused before a write helper starts', async t => {
  const { runtime, calls } = await ownedFixture(t, child => { child.json(snapshot({ homeOwner: '123' })); child.exit(); });
  await runtime.refreshMetadata(); const expected = guarded(runtime);
  for (const patch of [{ expectedIdentity: '0'.repeat(64) }, { expectedSourceEpoch: '11111111-1111-4111-8111-111111111111' }, { expectedRevision: expected.expectedRevision - 1 }]) {
    await assert.rejects(runtime.updateMetadata({ operation: 'rename', name: '新名', ...expected, ...patch }), { reason: 'metadata_conflict' });
  }
  assert.equal(calls.length, 1);
});

test('in-flight metadata writes are never queued or retried and late acknowledgements after account pause are unconfirmed', async t => {
  const { runtime, calls } = await ownedFixture(t, (child, args) => {
    if (!args.includes('rename64')) { child.json(snapshot({ homeOwner: '123' })); child.exit(); }
  });
  await runtime.refreshMetadata(); const expected = guarded(runtime);
  const first = runtime.updateMetadata({ operation: 'rename', name: '待确认', ...expected });
  await eventually(() => calls.length === 2);
  await assert.rejects(runtime.updateMetadata({ operation: 'rename', name: '不能排队', ...expected }), { reason: 'metadata_busy' });
  const paused = runtime.pause();
  await assert.rejects(first, { reason: 'metadata_unconfirmed' }); await paused;
  assert.equal(calls.filter(call => call.args.includes('rename64')).length, 1);
  assert.equal(runtime.metadataStatus().metadata, null);
});

test('a helper success without explicit confirmed readback cannot update the public snapshot', async t => {
  const { runtime, calls } = await ownedFixture(t, (child, args) => {
    child.json(snapshot({ homeOwner: '123', name: args.includes('rename64') ? '不能确认' : '云端新名' })); child.exit();
  });
  await runtime.refreshMetadata();
  await assert.rejects(runtime.updateMetadata({ operation: 'rename', name: '不能确认', ...guarded(runtime) }), { reason: 'metadata_unconfirmed' });
  assert.equal(runtime.metadataStatus().metadata.name, '云端新名');
  assert.equal(calls.length, 2);
});

test('metadata rename validates 160 Unicode code units without truncating or trimming the requested value', async t => {
  let value = snapshot({ homeOwner: '123' });
  const { runtime, calls } = await ownedFixture(t, (child, args) => {
    if (args.includes('rename64')) value = { ...value, name: Buffer.from(args.at(-1), 'base64').toString('utf8'), confirmed: true };
    child.json(value); child.exit();
  });
  await runtime.refreshMetadata();
  for (const name of ['汉'.repeat(160), '🙂'.repeat(80)]) {
    assert.equal((await runtime.updateMetadata({ operation: 'rename', name, ...guarded(runtime) })).name, name);
    const encoded = calls.at(-1).args.at(-1);
    assert.equal(encoded, Buffer.from(name, 'utf8').toString('base64'));
    assert.match(encoded, /^[A-Za-z0-9+/]+={0,2}$/);
    assert.equal(Buffer.from(encoded, 'base64').toString('utf8'), name);
    assert.ok(calls.at(-1).args.every(arg => /^[\x20-\x7e]*$/.test(arg)), 'every Java argv value is ASCII');
  }
  const before = calls.length;
  for (const name of ['a'.repeat(161), '🙂'.repeat(81), ' leading', 'trailing ', '\u00a0边界', '换\n行', 'bad\ud800', '\udc00bad']) {
    await assert.rejects(runtime.updateMetadata({ operation: 'rename', name, ...guarded(runtime) }), { reason: 'invalid_request' });
  }
  assert.equal(calls.length, before);
  const settings = await runtime.setMetadataSync({ enabled: false, ...guarded(runtime) });
  assert.equal(settings.identity, runtime.metadataStatus().identity);
  assert.equal(settings.capabilities.rename, true);
});

test('a metadata write timeout is unconfirmed and never retries the cloud operation', async t => {
  let entered;
  const dispatched = new Promise(resolve => { entered = resolve; });
  const { runtime, calls, terminated } = await ownedFixture(t, (child, args) => {
    if (args.includes('rename64')) { entered(); return; }
    child.json(snapshot({ homeOwner: '123' })); child.exit();
  });
  await runtime.refreshMetadata();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const update = runtime.updateMetadata({ operation: 'rename', name: '等待超时', ...guarded(runtime) });
  update.catch(() => {});
  await dispatched;
  t.mock.timers.tick(30001);
  await assert.rejects(update, { reason: 'metadata_unconfirmed' });
  t.mock.timers.tick(120000); await Promise.resolve();
  assert.equal(calls.filter(call => call.args.includes('rename64')).length, 1);
  assert.ok(terminated.includes(calls.at(-1).child));
  assert.equal(runtime.metadataStatus().metadata.name, '云端新名');
  assert.equal(runtime.metadataStatus().lastError, 'metadata_unconfirmed');
});

test('byte-split UTF-8 metadata preserves every name, room and rename baseline beyond 16 KiB', async t => {
  const rooms = [{ id: '4', name: '客厅🙂' }, { id: '5', name: '卧室💡' },
    ...Array.from({ length: 450 }, (_, index) => ({ id: String(1000 + index), name: `房间${index} 检查中文🙂💡` }))];
  const initial = snapshot({ homeOwner: '123', name: '摄像头🙂中文', homeName: '完整家庭💡', roomName: rooms[0].name, rooms });
  let value = initial, expectedBaseline;
  const { runtime, calls } = await ownedFixture(t, (child, args) => {
    if (args.includes('rename64')) {
      assert.equal(args.at(-2), expectedBaseline);
      value = { ...value, name: Buffer.from(args.at(-1), 'base64').toString('utf8'), confirmed: true };
    }
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
    assert.ok(bytes.length > 16384);
    // Every CJK and four-byte emoji is necessarily divided across data events.
    for (let index = 0; index < bytes.length; index++) child.stdout.write(bytes.subarray(index, index + 1));
    child.exit();
  });
  const observed = await runtime.refreshMetadata();
  assert.equal(observed.name, initial.name); assert.equal(observed.homeName, initial.homeName);
  assert.equal(observed.roomName, initial.roomName); assert.equal(observed.rooms.length, rooms.length);
  for (const room of observed.rooms) assert.equal(room.name, rooms.find(original => original.id === room.id).name);
  assert.equal(JSON.stringify(observed).includes('\ufffd'), false);
  expectedBaseline = metadataFingerprint(observed);
  const requested = '字节边界改名🙂💡中文';
  const updated = await runtime.updateMetadata({ operation: 'rename', name: requested, ...guarded(runtime) });
  assert.equal(updated.name, requested); assert.equal(updated.confirmed, true);
  assert.equal(updated.rooms.length, rooms.length); assert.equal(JSON.stringify(updated).includes('\ufffd'), false);
  assert.equal(calls.filter(call => call.args.includes('rename64')).length, 1);
});

test('helper output enforces raw byte limit and rejects invalid UTF-8 without leaking partial replies', async t => {
  for (const bytes of [Buffer.concat([Buffer.from('{"success":true,"name":"'), Buffer.from([0xe6, 0xb1]), Buffer.from('"}')]),
    Buffer.concat([Buffer.from('{"success":true,"name":"'), Buffer.from([0xff]), Buffer.from('"}')]),
    Buffer.alloc(1048577, 0x61)]) {
    const { runtime, terminated } = await fixture(t, child => {
      for (let index = 0; index < bytes.length; index += 317) child.stdout.write(bytes.subarray(index, index + 317));
      child.exit();
    });
    await assert.rejects(runtime.refreshMetadata(), error => error.reason === 'invalid_backend_response' && !String(error).includes('success'));
    assert.equal(runtime.metadataStatus().metadata, null);
    if (bytes.length > 1048576) assert.equal(terminated.length, 1);
  }
});
