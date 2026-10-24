import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { ClusterId, Status, TlvOfModel } from '@matter/main/types';
import { MatterService } from '../lib/matter-service.mjs';
import { MijiaPtzStep, MIJIA_PTZ_STEP_CLUSTER_ID, MatterPtzStepControl,
  normalizeMatterPtzCapabilities } from '../lib/matter-ptz-cluster.mjs';

const capabilities = (patch = {}) => ({ supported: true, available: true,
  directions: ['up', 'down', 'left', 'right'], relativeStep: true, zoom: false, absolutePosition: false, ...patch });
const rejectsStatus = (value, status) => assert.rejects(value, error => error.code === status || error.status === status);
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('vendor step schema has a valid manufacturer cluster ID and an exact one-byte direction TLV field', () => {
  assert.equal(MIJIA_PTZ_STEP_CLUSTER_ID, 4294048769);
  assert.equal(ClusterId.isVendorSpecific(MIJIA_PTZ_STEP_CLUSTER_ID), true);
  assert.throws(() => ClusterId(0xfff10001));
  assert.equal(MijiaPtzStep.revision, 1);
  const command = MijiaPtzStep.schema.children.find(item => item.name === 'MoveStep');
  const tlv = TlvOfModel(command);
  for (let direction = 0; direction < 4; direction++) {
    // Anonymous structure, context-0 unsigned byte, end-of-container. No angle, duration or zoom fields.
    assert.deepEqual([...tlv.encode({ direction })], [0x15, 0x24, 0, direction, 0x18]);
    assert.deepEqual(tlv.decode(tlv.encode({ direction })), { direction });
  }
  // Matter enum TLV preserves future values; the command guard below rejects values outside 0..3.
  assert.throws(() => tlv.validate({ direction: -1 }));
  assert.throws(() => tlv.validate({}));
  const attributes = MijiaPtzStep.schema.children.filter(item => item.tag === 'attribute' && item.id < 0xfff0);
  assert.deepEqual(attributes.map(item => [item.id, item.name]), [[0, 'Supported'], [1, 'Available'], [2, 'Mode'], [3, 'Directions']]);
  assert.ok(attributes.every(item => !item.access.writable));
  const bitmap = TlvOfModel(attributes[3]);
  assert.equal(bitmap.decode(bitmap.encode({ up: true, down: false, left: true, right: false })).up, true);
  assert.deepEqual([...bitmap.encode({ up: true, down: true, left: true, right: true })], [0x04, 15]);
});

test('step capability projection never invents directions or converts standard absolute/zoom features', () => {
  for (const value of [undefined, {}, capabilities({ supported: false }), capabilities({ relativeStep: false }),
    capabilities({ directions: ['zoom', 'pan', 3] })]) {
    assert.equal(normalizeMatterPtzCapabilities(value).supported, false);
    assert.equal(normalizeMatterPtzCapabilities(value).available, false);
  }
  assert.deepEqual(normalizeMatterPtzCapabilities(capabilities({ available: false, directions: ['left', 'left'] })),
    { supported: true, available: false, mode: 0, directions: { up: false, down: false, left: true, right: false } });
});

test('unsupported, unavailable and unlisted direction calls do not send a backend command', async () => {
  let moves = 0, caps = capabilities({ supported: false });
  const control = new MatterPtzStepControl({ runtime: { getPtzCapabilities: () => caps,
    movePtz: async () => { moves++; return { accepted: true }; } } });
  for (const patch of [{ supported: false }, { available: false }, { directions: ['up'] }]) {
    caps = capabilities(patch); await rejectsStatus(control.move(3), Status.InvalidInState);
  }
  for (const invalid of [-1, 4, 1.5, 'up', null]) await rejectsStatus(control.move(invalid), Status.ConstraintError);
  assert.equal(moves, 0);
  control.close();
});

test('all four direction commands await backend acceptance and concurrent actors receive Busy', async () => {
  const moves = [], accepted = defer(), entered = defer();
  const control = new MatterPtzStepControl({ runtime: { getPtzCapabilities: () => capabilities(),
    async movePtz(direction) { moves.push(direction); if (moves.length === 1) { entered.resolve(); return accepted.promise; } return { accepted: true }; } } });
  const first = control.move(0); await entered.promise;
  assert.equal(control.state().available, false);
  await rejectsStatus(control.move(1), Status.Busy);
  accepted.resolve({ accepted: true }); await first;
  for (const direction of [1, 2, 3]) await control.move(direction);
  assert.deepEqual(moves, ['up', 'down', 'left', 'right']);
  assert.equal(control.state().available, true);
  control.close();
});

test('asynchronous attribute publications finish in order and leave availability true before accepting the next step', async () => {
  let activeWrites = 0, published, completed = 0;
  const control = new MatterPtzStepControl({ runtime: { getPtzCapabilities: () => capabilities(),
    async movePtz() { return { accepted: true }; } }, async onChange(state) {
    assert.equal(activeWrites++, 0, 'Matter attribute transactions must not overlap');
    await new Promise(resolve => setTimeout(resolve, state.available ? 1 : 5));
    published = state; completed++; activeWrites--;
  } });
  await control.refresh();
  for (const direction of [0, 1, 2, 3]) {
    await control.move(direction);
    assert.equal(published.available, true, 'ACK must follow the final available publication');
    assert.equal(activeWrites, 0);
  }
  assert.ok(completed > 4); control.close(); await control.publication;
  assert.equal(published.available, false);
});

test('rejected or failed backend actions fail the Matter command without disclosing backend errors', async () => {
  for (const reply of [undefined, { accepted: false }, new Error('PRIVATE_CREDENTIAL_OR_DEVICE_ID')]) {
    const control = new MatterPtzStepControl({ runtime: { getPtzCapabilities: () => capabilities(),
      async movePtz() { if (reply instanceof Error) throw reply; return reply; } } });
    await assert.rejects(control.move(0), error => {
      assert.equal(error.code, Status.Failure); assert.doesNotMatch(error.message, /PRIVATE/); return true;
    });
    assert.equal(control.busy, false); control.close();
  }
});

test('selection invalidation and shutdown cancel pending capability lookups before sending movement', async () => {
  for (const action of ['selection', 'close']) {
    const pending = defer(); let moves = 0;
    const control = new MatterPtzStepControl({ runtime: { getPtzCapabilities: () => pending.promise,
      async movePtz() { moves++; return { accepted: true }; } } });
    const command = control.move(0);
    if (action === 'close') control.close();
    else void control.refresh({ invalidate: true });
    pending.resolve(capabilities());
    await rejectsStatus(command, Status.InvalidInState);
    assert.equal(moves, 0);
    control.close(); await rejectsStatus(control.move(0), Status.InvalidInState);
    assert.equal(control.state().available, false);
  }
});

test('late acceptance cannot acknowledge success after selection changes or close', async () => {
  for (const action of ['selection', 'close']) {
    const entered = defer(), pending = defer();
    const control = new MatterPtzStepControl({ runtime: { getPtzCapabilities: () => capabilities(),
      async movePtz() { entered.resolve(); return pending.promise; } } });
    const command = control.move(2); await entered.promise;
    if (action === 'close') control.close(); else await control.refresh({ invalidate: true });
    pending.resolve({ accepted: true }); await rejectsStatus(command, Status.InvalidInState);
    control.close();
  }
});

test('Matter service refreshes runtime capability changes and removes every callback on shutdown', async () => {
  const runtime = new EventEmitter(), calls = [];
  runtime.selected = () => undefined;
  const device = { async start() {}, async close() {}, status: () => ({ running: true }),
    async refreshPtzCapabilities(options) { calls.push(options ?? {}); }, async closeSessions() {} };
  const service = new MatterService({ runtime, config: { enableMatter: true }, storagePath: '/private/test',
    deviceFactory: async () => device, mediaFactory: async () => ({ async close() {} }) });
  try {
    await service.start();
    runtime.emit('status', { ready: false }); runtime.emit('selection'); runtime.emit('ptz-capabilities');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.length, 3); assert.equal(calls.filter(item => item.invalidate).length, 1);
    assert.equal(runtime.listenerCount('selection'), 1);
  } finally { await service.close(); }
  for (const event of ['status', 'selection', 'ptz-capabilities']) assert.equal(runtime.listenerCount(event), 0);
});
