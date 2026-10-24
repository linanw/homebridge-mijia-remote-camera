import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';

const REASONS = new Set(['authentication_required', 'session_expired', 'not_selected', 'auth_in_progress',
  'runtime_closed', 'query_cancelled', 'query_timeout', 'metadata_unavailable', 'metadata_incomplete',
  'metadata_conflict', 'invalid_backend_response', 'invalid_request', 'camera_not_in_home',
  'invalid_home_selection', 'home_request_failed', 'home_request_rejected', 'invalid_home_response',
  'invalid_device_response', 'device_pagination_incomplete', 'runtime_unavailable',
  'metadata_busy', 'metadata_unconfirmed', 'metadata_write_unsupported', 'metadata_not_owner', 'metadata_not_applied']);
const fail = reason => Object.assign(new Error(REASONS.has(reason) ? reason : 'metadata_unavailable'),
  { reason: REASONS.has(reason) ? reason : 'metadata_unavailable' });
const id = value => {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,29})$/.test(value)) throw fail('invalid_backend_response');
  return value;
};
const label = value => {
  if (typeof value !== 'string' || value.length > 1024) throw fail('invalid_backend_response');
  return value.replace(/[\p{Cc}]/gu, ' ').trim().slice(0, 160);
};
const clone = value => value === null ? null : structuredClone(value);

/** Same ordered, public-field baseline consumed by the isolated Java write helper. */
export function metadataFingerprint(value) {
  return createHash('sha256').update(JSON.stringify([value.deviceId, value.homeId, value.homeOwner, value.region,
    value.name, value.homeName, value.roomId, value.roomName, value.rooms.map(room => [room.id, room.name])])).digest('hex');
}

/** Keep only public metadata after binding the response to this exact account and selection. */
export function normalizeMetadata(value, context) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.accountId !== context.accountId
    || ['deviceId', 'homeId', 'homeOwner', 'region'].some(key => value[key] !== context[key])
    || !Array.isArray(value.rooms) || value.rooms.length > 1000) throw fail('invalid_backend_response');
  const roomIds = new Set();
  const rooms = value.rooms.map(room => {
    if (!room || typeof room !== 'object' || Array.isArray(room)) throw fail('invalid_backend_response');
    const roomId = id(room.id);
    if (roomIds.has(roomId)) throw fail('invalid_backend_response');
    roomIds.add(roomId);
    return { id: roomId, name: label(room.name) };
  }).sort((a, b) => a.id.localeCompare(b.id));
  const roomId = value.roomId === '' ? '' : id(value.roomId);
  const assigned = rooms.find(room => room.id === roomId);
  if (roomId && !assigned) throw fail('invalid_backend_response');
  const roomName = label(value.roomName);
  if (roomId ? assigned.name !== roomName : roomName !== '') throw fail('invalid_backend_response');
  return { deviceId: id(value.deviceId), homeId: id(value.homeId), homeOwner: id(value.homeOwner),
    region: context.region, name: label(value.name), homeName: label(value.homeName), roomId, roomName, rooms };
}

/** Read-only polling with a revision and cancellation barrier independent of video transport. */
export class MetadataSync extends EventEmitter {
  constructor({ getContext, read, enabled = true, intervalMs = 60000, timeoutMs = 30000 } = {}) {
    super();
    this.getContext = getContext; this.read = read; this.enabled = enabled !== false;
    this.intervalMs = Number.isInteger(intervalMs) && intervalMs > 0 ? intervalMs : 60000;
    this.timeoutMs = timeoutMs;
    this.sourceEpoch = randomUUID();
    this.revision = 0; this.value = null; this.contextKey = null; this.epoch = 0;
    this.lastSuccessAt = null; this.lastError = null; this.pending = null;
    this.running = false; this.suspended = false; this.closed = false; this.timer = null;
  }
  status() {
    if (this.contextKey !== null) {
      try { if (this.getContext().key !== this.contextKey) this.invalidate(); }
      catch { this.invalidate(); }
    }
    return { enabled: this.enabled, intervalSeconds: this.intervalMs / 1000,
      loading: this.pending !== null, sourceEpoch: this.sourceEpoch, revision: this.revision, lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError, metadata: clone(this.value) };
  }
  checkRevision(expectedRevision, expectedSourceEpoch) {
    if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) throw fail('invalid_request');
    if (expectedSourceEpoch !== undefined && (typeof expectedSourceEpoch !== 'string'
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(expectedSourceEpoch))) throw fail('invalid_request');
    if (expectedSourceEpoch !== undefined && expectedSourceEpoch !== this.sourceEpoch) throw fail('metadata_conflict');
    if (expectedRevision !== undefined && expectedRevision !== this.revision) throw fail('metadata_conflict');
  }
  emitState() { this.emit('state', this.status()); }
  start() {
    if (this.closed) return;
    this.running = true; this.suspended = false; this.schedule(0);
  }
  schedule(delay = this.intervalMs) {
    clearTimeout(this.timer); this.timer = null;
    if (!this.running || !this.enabled || this.suspended || this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const request = this.refresh(), epoch = this.epoch;
      request.catch(() => {}).finally(() => {
        // A cancelled older poll cannot overwrite a new immediate resume timer.
        if (epoch === this.epoch && this.timer === null) this.schedule();
      });
    }, delay);
    this.timer.unref?.();
  }
  setEnabled(enabled, expectedRevision, expectedSourceEpoch) {
    if (this.closed) throw fail('runtime_closed');
    if (typeof enabled !== 'boolean') throw fail('invalid_request');
    this.checkRevision(expectedRevision, expectedSourceEpoch);
    if (enabled !== this.enabled) {
      this.enabled = enabled; this.revision++;
      if (this.value) this.value.revision = this.revision;
      if (!enabled) this.cancel();
    }
    this.schedule(enabled ? 0 : this.intervalMs);
    this.emitState();
    return this.status();
  }
  cancel() {
    this.epoch++;
    clearTimeout(this.timer); this.timer = null;
    this.pending?.controller.abort();
    this.pending = null;
  }
  invalidate() {
    this.cancel();
    if (this.value !== null || this.contextKey !== null) this.revision++;
    this.value = null; this.contextKey = null; this.lastSuccessAt = null; this.lastError = null;
    this.schedule();
    this.emitState();
  }
  suspend() { this.suspended = true; this.invalidate(); }
  close() { this.closed = true; this.running = false; this.invalidate(); }
  refresh(options = {}) { return this._run(options, this.read); }
  update(operation, options = {}) {
    if (this.pending) return Promise.reject(fail('metadata_busy'));
    if (options.expectedRevision === undefined || options.expectedSourceEpoch === undefined) return Promise.reject(fail('invalid_request'));
    return this._run(options, operation, true);
  }
  async _run({ expectedRevision, expectedSourceEpoch } = {}, read, mutation = false) {
    if (this.closed) throw fail('runtime_closed');
    if (this.suspended) throw fail('auth_in_progress');
    this.status(); this.checkRevision(expectedRevision, expectedSourceEpoch);
    let context;
    try { context = this.getContext(); }
    catch (error) {
      this.lastError = REASONS.has(error?.reason) ? error.reason : 'metadata_unavailable';
      this.emitState(); throw fail(this.lastError);
    }
    if (this.pending && this.pending.key === context.key) return this.pending.promise;
    this.cancel();
    const epoch = this.epoch, revision = this.revision, controller = new AbortController();
    const current = () => {
      if (this.closed || this.suspended || this.epoch !== epoch) return false;
      try { return this.getContext().key === context.key; } catch { return false; }
    };
    const valid = () => !controller.signal.aborted && current();
    const operation = async () => {
      let timer, onAbort, timedOut = false;
      try {
        if (!valid()) throw fail('query_cancelled');
        const cancelled = new Promise((_, reject) => {
          onAbort = () => reject(fail('query_cancelled'));
          controller.signal.addEventListener('abort', onAbort, { once: true });
        });
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => { timedOut = true; reject(fail('query_timeout')); controller.abort(); }, this.timeoutMs);
        });
        const reply = await Promise.race([read(context, { signal: controller.signal, guard: valid }), cancelled, timeout]);
        if (!valid()) throw fail('query_cancelled');
        if (expectedRevision !== undefined && this.revision !== revision) throw fail('metadata_conflict');
        const next = normalizeMetadata(reply, context);
        const changed = this.contextKey !== context.key || JSON.stringify(next) !== JSON.stringify(this.value &&
          Object.fromEntries(Object.entries(this.value).filter(([key]) => !['revision', 'observedAt', 'sourceEpoch'].includes(key))));
        if (changed) this.revision++;
        const observedAt = Math.max(Date.now(), this.lastSuccessAt ? Date.parse(this.lastSuccessAt) + 1 : 0);
        this.contextKey = context.key; this.lastSuccessAt = new Date(observedAt).toISOString(); this.lastError = null;
        this.value = { ...next, sourceEpoch: this.sourceEpoch, revision: this.revision, observedAt: this.lastSuccessAt };
        if (changed) this.emit('metadata', clone(this.value));
        return clone(this.value);
      } catch (error) {
        if (timedOut && current()) {
          this.lastError = mutation ? 'metadata_unconfirmed' : 'query_timeout';
          throw fail(this.lastError);
        }
        const reason = mutation && ['query_timeout', 'invalid_backend_response', 'runtime_unavailable'].includes(error?.reason)
          ? 'metadata_unconfirmed' : error?.reason;
        if (valid()) this.lastError = REASONS.has(reason) ? reason : 'metadata_unavailable';
        throw fail(valid() ? this.lastError : mutation ? 'metadata_unconfirmed' : 'query_cancelled');
      } finally {
        clearTimeout(timer); if (onAbort) controller.signal.removeEventListener('abort', onAbort);
        if (this.pending?.controller === controller) { this.pending = null; this.schedule(); this.emitState(); }
      }
    };
    // Start in a microtask so even a synchronous read failure has a tracked pending operation.
    const promise = Promise.resolve().then(operation);
    this.pending = { key: context.key, controller, promise };
    this.emitState();
    return promise;
  }
}
