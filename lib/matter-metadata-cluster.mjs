import { createHash } from 'node:crypto';
import { ClusterBehavior } from '@matter/main';
import { ClusterModel } from '@matter/main/model';
import { ClusterId, ClusterType, Status, StatusResponseError } from '@matter/main/types';

export const MIJIA_METADATA_CLUSTER_ID = ClusterId(0xfff1fc02);
const field = (name, id, type, extra = {}) => ({ tag: 'field', name, id, type, conformance: 'M', ...extra });
const string = (name, id, max) => field(name, id, 'string', { constraint: `max ${max}` });
const attribute = (name, id, type, value, extra = {}) => ({ tag: 'attribute', name, id, type,
  access: 'R V', conformance: 'M', default: value, ...extra });
const guards = () => [string('ExpectedIdentity', 0, 64), string('ExpectedSourceEpoch', 1, 36),
  field('ExpectedRevision', 2, 'uint64')];
const emptySnapshot = () => ({ identity: '', sourceEpoch: '', revision: 0, name: '', homeKey: '', homeName: '',
  roomId: '', roomName: '', observedAt: '' });

// Write support is advertised only after the runtime verifies its Xiaomi backend capability.
export const MijiaMetadata = ClusterType(new ClusterModel({
  name: 'MijiaMetadata', id: MIJIA_METADATA_CLUSTER_ID, classification: 'application', children: [
    { tag: 'attribute', name: 'ClusterRevision', id: 0xfffd, type: 'ClusterRevision', default: 1 },
    attribute('Snapshot', 0, 'SnapshotStruct', emptySnapshot()),
    attribute('Rooms', 1, 'list', [], { constraint: 'max 1000',
      children: [{ tag: 'field', name: 'entry', type: 'RoomStruct' }] }),
    attribute('Capabilities', 2, 'CapabilitiesStruct', { read: false, rename: false, move: false, syncConfig: false }),
    attribute('SyncEnabled', 3, 'bool', false),
    attribute('Available', 4, 'bool', false),
    attribute('Loading', 5, 'bool', false),
    attribute('LastError', 6, 'string', '', { constraint: 'max 40' }),
    { tag: 'datatype', name: 'SnapshotStruct', type: 'struct', children: [
      string('Identity', 0, 64), string('SourceEpoch', 1, 36), field('Revision', 2, 'uint64'),
      string('Name', 3, 160), string('HomeKey', 4, 64), string('HomeName', 5, 160),
      string('RoomId', 6, 30), string('RoomName', 7, 160), string('ObservedAt', 8, 32),
    ] },
    { tag: 'datatype', name: 'RoomStruct', type: 'struct', children: [string('Id', 0, 30), string('Name', 1, 160)] },
    { tag: 'datatype', name: 'CapabilitiesStruct', type: 'struct', children: [
      field('Read', 0, 'bool'), field('Rename', 1, 'bool'), field('Move', 2, 'bool'), field('SyncConfig', 3, 'bool'),
    ] },
    { tag: 'command', name: 'RefreshMetadata', id: 0, access: 'O', conformance: 'M', direction: 'request', response: 'status',
      children: guards() },
    { tag: 'command', name: 'SetSyncEnabled', id: 1, access: 'O', conformance: 'M', direction: 'request', response: 'status',
      children: [...guards(), field('Enabled', 3, 'bool')] },
    { tag: 'command', name: 'RenameDevice', id: 2, access: 'O', conformance: 'M', direction: 'request', response: 'status',
      children: [...guards(), string('Name', 3, 160)] },
    { tag: 'command', name: 'MoveDevice', id: 3, access: 'O', conformance: 'M', direction: 'request', response: 'status',
      children: [...guards(), string('RoomId', 3, 30)] },
  ],
}));

export const MijiaMetadataBehavior = ClusterBehavior.for(MijiaMetadata);

const REASONS = new Set(['authentication_required', 'session_expired', 'not_selected', 'auth_in_progress',
  'runtime_closed', 'query_cancelled', 'query_timeout', 'metadata_unavailable', 'metadata_incomplete',
  'metadata_conflict', 'metadata_busy', 'metadata_unconfirmed', 'metadata_write_unsupported', 'metadata_not_owner',
  'metadata_not_applied', 'invalid_backend_response', 'invalid_request', 'camera_not_in_home',
  'invalid_home_selection', 'home_request_failed', 'home_request_rejected', 'invalid_home_response',
  'invalid_device_response', 'device_pagination_incomplete', 'runtime_unavailable', 'storage_failed']);
const UNAVAILABLE = new Set(['authentication_required', 'session_expired', 'not_selected', 'auth_in_progress',
  'runtime_closed', 'query_cancelled', 'metadata_conflict', 'metadata_write_unsupported', 'metadata_not_owner',
  'camera_not_in_home', 'invalid_home_selection']);
const internal = Symbol('metadata-status');
const error = (status, message) => Object.assign(new StatusResponseError(message, status), { [internal]: true });
const fail = (status, message) => { throw error(status, message); };
const safeReason = value => value == null || value === '' ? '' : REASONS.has(value) ? value : 'metadata_unavailable';
const hash = value => createHash('sha256').update(value).digest('hex');
const text = (value, max) => typeof value === 'string' ? value.replace(/[\p{Cc}]/gu, ' ').trim().slice(0, max) : '';
// Matter names in this extension are bounded by UTF-8 bytes, not JavaScript code units.
// Keeping them below 256 bytes also avoids the pinned TLV encoder's prefix-width mismatch.
const validLabel = value => typeof value === 'string' && value.isWellFormed() && Buffer.byteLength(value, 'utf8') <= 160;
const revision = value => {
  if (typeof value === 'bigint') return value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
};
const epoch = value => typeof value === 'string' && value.length > 0 && value.length <= 36 && !/[\p{Cc}]/u.test(value) ? value : '';
const observation = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return '';
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value ? value : '';
};

/** A public projection with explicitly guarded commands shared by every Matter actor. */
export class MatterMetadataControl {
  constructor({ runtime, onChange } = {}) {
    this.runtime = runtime; this.onChange = onChange;
    this.closed = false; this.busy = false; this.commandLoading = false; this.generation = 0;
    this.publication = Promise.resolve(); this.cancelPending = null;
  }
  capture() {
    let selected, status = {}, lastError = '';
    try { selected = this.runtime?.selected?.(); } catch { lastError = 'metadata_unavailable'; }
    try { status = this.runtime?.metadataStatus?.() ?? {}; }
    catch (failure) { lastError = safeReason(failure?.reason) || 'metadata_unavailable'; }
    if (!status || typeof status !== 'object' || Array.isArray(status)) { status = {}; lastError = 'metadata_unavailable'; }
    let identity = '', homeKey = '';
    try {
      if (selected && typeof selected === 'object' && selected.deviceId != null && String(selected.deviceId).length) {
        identity = hash(String(selected.deviceId));
        homeKey = hash(JSON.stringify([selected.region, selected.homeOwner, selected.homeId]));
      }
    } catch { identity = ''; homeKey = ''; lastError = 'metadata_unavailable'; }
    const sourceEpoch = epoch(status.sourceEpoch), version = revision(status.revision);
    const snapshot = { ...emptySnapshot(), identity, homeKey, sourceEpoch, revision: version ?? 0 };
    const metadata = status.metadata;
    const labels = metadata && typeof metadata === 'object'
      ? [metadata.name, metadata.homeName, metadata.roomName,
        ...(Array.isArray(metadata.rooms) ? metadata.rooms.map(room => room?.name) : [])] : [];
    const incomplete = labels.some(value => typeof value === 'string' && !validLabel(value));
    if (incomplete) lastError = 'metadata_incomplete';
    const bound = Boolean(identity && sourceEpoch && version !== null && metadata && typeof metadata === 'object'
      && !Array.isArray(metadata) && ['deviceId', 'homeId', 'homeOwner', 'region'].every(key => metadata[key] === selected[key])
      && metadata.sourceEpoch === sourceEpoch && revision(metadata.revision) === version
      && ['name', 'homeName', 'roomId', 'roomName', 'observedAt'].every(key => typeof metadata[key] === 'string')
      && Array.isArray(metadata.rooms) && metadata.rooms.length <= 1000);
    // A bounded projection error does not erase the selected-home identity or the
    // time of this authoritative observation. Names and room data remain empty.
    if (bound) snapshot.observedAt = observation(metadata.observedAt);
    let matches = bound && Boolean(snapshot.observedAt) && !incomplete;
    let rooms = [];
    if (matches) {
      const seen = new Set();
      for (const room of metadata.rooms) {
        if (!room || typeof room !== 'object' || typeof room.id !== 'string' || !/^(0|[1-9][0-9]{0,29})$/.test(room.id)
          || typeof room.name !== 'string' || seen.has(room.id)) { matches = false; break; }
        seen.add(room.id); rooms.push({ id: room.id, name: text(room.name, 160) });
      }
      const room = rooms.find(room => room.id === metadata.roomId);
      if (metadata.roomId ? !room || room.name !== text(metadata.roomName, 160) : metadata.roomName !== '') matches = false;
    }
    const available = matches && !this.closed && !this.runtime?.paused && !this.runtime?.closed;
    if (available) Object.assign(snapshot, { name: text(metadata.name, 160), homeName: text(metadata.homeName, 160),
      roomId: metadata.roomId, roomName: text(metadata.roomName, 160), observedAt: text(metadata.observedAt, 32) });
    else rooms = [];
    return { identity, homeKey, sourceEpoch, revision: version,
      state: { snapshot, rooms, capabilities: { read: typeof this.runtime?.refreshMetadata === 'function',
        rename: status.capabilities?.rename === true && typeof this.runtime?.updateMetadata === 'function',
        move: status.capabilities?.move === true && typeof this.runtime?.updateMetadata === 'function',
        syncConfig: typeof this.runtime?.setMetadataSync === 'function' },
      syncEnabled: status.enabled === true, available: Boolean(available), loading: this.commandLoading || status.loading === true,
      lastError: lastError || safeReason(status.lastError) || (metadata && !matches ? 'metadata_unavailable' : '') } };
  }
  state() { return this.capture().state; }
  publish() {
    // Serialize endpoint transactions, projecting the current state when each write starts.
    // Recover a previous failure so a later safe snapshot can still replace it, but expose
    // the current failure to callers instead of acknowledging a stale endpoint value.
    this.publication = this.publication.catch(() => {}).then(() => this.onChange?.(this.state()))
      .catch(() => { throw error(Status.Failure, 'Metadata publication failed'); });
    this.publication.catch(() => {});
    return this.publication;
  }
  async refresh({ invalidate = false } = {}) {
    if (invalidate) {
      this.generation++;
      this.cancelPending?.();
    }
    await this.publish();
    return this.state();
  }
  validate(request, operation) {
    if (!request || typeof request !== 'object' || Array.isArray(request)
      || !['expectedIdentity', 'expectedSourceEpoch', 'expectedRevision'].every(key => Object.hasOwn(request, key))
      || typeof request.expectedIdentity !== 'string' || !/^[a-f0-9]{64}$/.test(request.expectedIdentity)
      || !epoch(request.expectedSourceEpoch) || revision(request.expectedRevision) === null
      || operation === 'sync' && typeof request.enabled !== 'boolean'
      || operation === 'rename' && (!validLabel(request.name) || !request.name.trim()
        || request.name !== request.name.trim() || /[\p{Cc}]/u.test(request.name))
      || operation === 'move' && (typeof request.roomId !== 'string' || !/^(0|[1-9][0-9]{0,29})$/.test(request.roomId)))
      fail(Status.ConstraintError, 'Invalid metadata request');
    return { expectedIdentity: request.expectedIdentity, expectedSourceEpoch: request.expectedSourceEpoch,
      expectedRevision: revision(request.expectedRevision) };
  }
  assertContext(expected, previous) {
    if (this.closed || this.runtime?.closed || this.runtime?.paused) fail(Status.InvalidInState, 'Metadata is unavailable');
    const current = this.capture();
    if (!current.identity || !current.sourceEpoch || current.revision === null
      || current.identity !== expected.expectedIdentity || current.sourceEpoch !== expected.expectedSourceEpoch
      || (!previous && current.revision !== expected.expectedRevision)
      || (previous && (current.homeKey !== previous.homeKey || current.revision < expected.expectedRevision)))
      fail(Status.InvalidInState, 'Metadata context changed');
    return current;
  }
  refreshMetadata(request) { return this.command('refresh', request); }
  setSyncEnabled(request) { return this.command('sync', request); }
  renameDevice(request) { return this.command('rename', request); }
  moveDevice(request) { return this.command('move', request); }
  async command(operation, request) {
    const expected = this.validate(request, operation);
    const method = operation === 'refresh' ? 'refreshMetadata' : operation === 'sync' ? 'setMetadataSync' : 'updateMetadata';
    const write = operation === 'rename' || operation === 'move';
    if (this.closed) fail(Status.InvalidInState, 'Metadata control is closed');
    if (this.busy) fail(Status.Busy, 'Metadata control is busy');
    if (typeof this.runtime?.[method] !== 'function') fail(Status.InvalidInState, 'Metadata is unavailable');
    const previous = this.assertContext(expected), generation = this.generation;
    if (write && (!previous.state.capabilities[operation] || !previous.state.available))
      fail(Status.InvalidInState, 'Metadata change is unavailable');
    if (operation === 'move' && !previous.state.rooms.some(room => room.id === request.roomId))
      fail(Status.ConstraintError, 'Invalid metadata request');
    this.busy = true; this.commandLoading = true;
    let cancel;
    const cancelled = new Promise((_, reject) => { cancel = () => reject(error(Status.InvalidInState, 'Metadata context changed')); });
    this.cancelPending = cancel;
    const target = operation === 'rename' ? request.name : request.roomId;
    try {
      // Controllers must observe Loading before any backend work, even a synchronous cache hit.
      await Promise.race([this.publish(), cancelled]);
      if (generation !== this.generation) fail(Status.InvalidInState, 'Metadata context changed');
      const ready = this.assertContext(expected);
      if (ready.homeKey !== previous.homeKey) fail(Status.InvalidInState, 'Metadata context changed');
      if (write && (!ready.state.available || !ready.state.capabilities[operation]))
        fail(Status.InvalidInState, 'Metadata change is unavailable');
      const options = write ? { ...expected, operation, ...(operation === 'rename' ? { name: target } : { roomId: target }) }
        : { expectedSourceEpoch: expected.expectedSourceEpoch, expectedRevision: expected.expectedRevision,
          ...(operation === 'sync' ? { enabled: request.enabled } : {}) };
      const reply = await Promise.race([this.runtime[method](options), cancelled]);
      this.commandLoading = false;
      if (generation !== this.generation) fail(Status.InvalidInState, 'Metadata context changed');
      const current = this.assertContext(expected, previous);
      const key = operation === 'rename' ? 'name' : 'roomId';
      if (write && (reply?.confirmed !== true || reply[key] !== target || !current.state.available
        || current.state.snapshot[key] !== target)) fail(Status.Failure, 'Metadata change was not confirmed');
    } catch (failure) {
      if (failure?.[internal]) throw failure;
      if (['metadata_busy', 'control_busy'].includes(failure?.reason)) fail(Status.Busy, 'Metadata control is busy');
      if (failure?.reason === 'invalid_request') fail(Status.ConstraintError, 'Invalid metadata request');
      if (UNAVAILABLE.has(failure?.reason)) fail(Status.InvalidInState, 'Metadata is unavailable');
      fail(Status.Failure, 'Metadata operation failed');
    } finally {
      this.commandLoading = false;
      try { if (!this.closed) await Promise.race([this.publish(), cancelled]); }
      finally {
        if (this.cancelPending === cancel) this.cancelPending = null;
        this.busy = false;
      }
    }
    if (generation !== this.generation) fail(Status.InvalidInState, 'Metadata context changed');
    const current = this.assertContext(expected, previous);
    if (write && (!current.state.available || current.state.snapshot[operation === 'rename' ? 'name' : 'roomId'] !== target))
      fail(Status.Failure, 'Metadata change was not confirmed');
  }
  close() {
    this.closed = true; this.generation++;
    this.cancelPending?.(); this.cancelPending = null;
    void this.publish();
  }
}
