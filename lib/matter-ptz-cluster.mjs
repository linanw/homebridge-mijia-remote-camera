import { ClusterBehavior } from '@matter/main';
import { ClusterModel } from '@matter/main/model';
import { ClusterId, ClusterType, Status, StatusResponseError } from '@matter/main/types';

// Test VID matches this development Matter camera. This is a directional step extension,
// not the standard MechanicalPan/Tilt cluster and never describes angles or zoom.
export const MIJIA_PTZ_STEP_CLUSTER_ID = ClusterId(0xfff1fc01);
export const PTZ_STEP_DIRECTIONS = Object.freeze(['up', 'down', 'left', 'right']);
const fail = (status, message) => { throw new StatusResponseError(message, status); };
const field = (name, id, type, extra = {}) => ({ tag: 'field', name, id, type, conformance: 'M', ...extra });
const attribute = (name, id, type, value) => ({ tag: 'attribute', name, id, type,
  access: 'R V', conformance: 'M', default: value });

export const MijiaPtzStep = ClusterType(new ClusterModel({
  name: 'MijiaPtzStep', id: MIJIA_PTZ_STEP_CLUSTER_ID, classification: 'application', children: [
    { tag: 'attribute', name: 'ClusterRevision', id: 0xfffd, type: 'ClusterRevision', default: 1 },
    attribute('Supported', 0, 'bool', false),
    attribute('Available', 1, 'bool', false),
    attribute('Mode', 2, 'ModeEnum', 0),
    attribute('Directions', 3, 'DirectionBitmap', 0),
    { tag: 'datatype', name: 'ModeEnum', type: 'enum8', children: [field('Step', 0)] },
    { tag: 'datatype', name: 'DirectionEnum', type: 'enum8', children: PTZ_STEP_DIRECTIONS.map((name, id) =>
      field(name[0].toUpperCase() + name.slice(1), id)) },
    { tag: 'datatype', name: 'DirectionBitmap', type: 'map8', children: PTZ_STEP_DIRECTIONS.map((name, id) =>
      ({ tag: 'field', name: name[0].toUpperCase() + name.slice(1), constraint: String(id), conformance: 'M' })) },
    { tag: 'command', name: 'MoveStep', id: 0, access: 'O', conformance: 'M', direction: 'request', response: 'status',
      children: [field('Direction', 0, 'DirectionEnum', { constraint: '0 to 3' })] },
  ],
}));

export const MijiaPtzStepBehavior = ClusterBehavior.for(MijiaPtzStep);

export function normalizeMatterPtzCapabilities(value) {
  const supported = value?.supported === true && value?.relativeStep === true;
  const directions = supported && Array.isArray(value.directions)
    ? PTZ_STEP_DIRECTIONS.filter(direction => value.directions.includes(direction)) : [];
  return { supported: supported && directions.length > 0, available: supported && directions.length > 0 && value.available === true,
    mode: 0, directions: Object.fromEntries(PTZ_STEP_DIRECTIONS.map(direction => [direction, directions.includes(direction)])) };
}

/** Shared across Matter actors so simultaneous fabrics cannot queue camera movements. */
export class MatterPtzStepControl {
  constructor({ runtime, onChange } = {}) {
    this.runtime = runtime; this.onChange = onChange; this.closed = false; this.busy = false;
    this.revision = 0; this.selectionRevision = 0; this.capabilities = normalizeMatterPtzCapabilities();
    this.publication = Promise.resolve();
  }
  state() { return { ...this.capabilities, directions: { ...this.capabilities.directions },
    available: !this.closed && !this.busy && this.capabilities.available }; }
  publish() {
    // endpoint.set() transactions can acquire their locks out of invocation order. Serialize
    // publications and read the latest state when each runs so a stale busy update cannot
    // leave controllers permanently unavailable after the command has completed.
    this.publication = this.publication.then(() => this.onChange?.(this.state())).catch(() => {});
    return this.publication;
  }
  async refresh({ invalidate = false } = {}) {
    const revision = ++this.revision;
    if (invalidate) { this.selectionRevision++; this.capabilities = normalizeMatterPtzCapabilities(); this.publish(); }
    if (this.closed) return this.state();
    let value;
    try { value = await this.runtime?.getPtzCapabilities?.(); } catch {}
    if (!this.closed && revision === this.revision) {
      this.capabilities = normalizeMatterPtzCapabilities(value); await this.publish();
    }
    return this.state();
  }
  async move(direction) {
    if (!Number.isInteger(direction) || !PTZ_STEP_DIRECTIONS[direction]) fail(Status.ConstraintError, 'Invalid step direction');
    if (this.closed) fail(Status.InvalidInState, 'Direction control is closed');
    if (this.busy) fail(Status.Busy, 'Direction control is busy');
    // Set the guard before any await, including an asynchronous capability lookup.
    this.busy = true; this.publish();
    const selectionRevision = this.selectionRevision;
    try {
      await this.refresh();
      if (this.closed || selectionRevision !== this.selectionRevision) fail(Status.InvalidInState, 'Camera selection changed');
      const state = this.capabilities;
      if (!state.supported || !state.available || !state.directions[PTZ_STEP_DIRECTIONS[direction]]
        || typeof this.runtime?.movePtz !== 'function') fail(Status.InvalidInState, 'Direction step is unavailable');
      let reply;
      try { reply = await this.runtime.movePtz(PTZ_STEP_DIRECTIONS[direction]); }
      catch (error) {
        if (error?.reason === 'ptz_busy' || error?.reason === 'control_busy') fail(Status.Busy, 'Direction control is busy');
        if (['ptz_unsupported', 'ptz_unavailable', 'auth_in_progress', 'query_cancelled'].includes(error?.reason))
          fail(Status.InvalidInState, 'Direction step is unavailable');
        fail(Status.Failure, 'Direction step was not accepted');
      }
      if (this.closed || selectionRevision !== this.selectionRevision) fail(Status.InvalidInState, 'Camera selection changed');
      if (reply?.accepted !== true) fail(Status.Failure, 'Direction step was not accepted');
    } finally {
      this.busy = false;
      if (!this.closed) await this.refresh();
    }
  }
  close() {
    this.closed = true; this.revision++; this.selectionRevision++;
    this.capabilities = normalizeMatterPtzCapabilities(); this.publish();
  }
}
