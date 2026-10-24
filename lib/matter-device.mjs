import { mkdir, chmod } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ServerNode, Endpoint, Environment, StorageService, Filesystem, CommissioningServer, VariableService, Logger } from '@matter/main';
import { NodeJsFilesystem, FileStorageDriver, FlatFileBlobStorageDriver } from '@matter/nodejs';
import { CameraDevice } from '@matter/main/devices/camera';
import { CameraAvStreamManagementServer } from '@matter/main/behaviors/camera-av-stream-management';
import { WebRtcTransportProviderServer } from '@matter/main/behaviors/web-rtc-transport-provider';
import { WebRtcTransportRequestorClient } from '@matter/main/behaviors/web-rtc-transport-requestor';
import { CameraAvStreamManagement } from '@matter/main/clusters/camera-av-stream-management';
import { WebRtcTransportRequestor } from '@matter/main/clusters/web-rtc-transport-requestor';
import { Status, StatusResponseError, StreamUsage, VendorId, EndpointNumber } from '@matter/main/types';
import { assertRemoteActor, hasRemoteActor, NodeSession, Invoke, DeviceCommissioner } from '@matter/main/protocol';
import { MatterPtzStepControl, MijiaPtzStepBehavior } from './matter-ptz-cluster.mjs';
import { MatterMetadataControl, MijiaMetadataBehavior } from './matter-metadata-cluster.mjs';

const LIVE = StreamUsage.LiveView;
const NIGHT = ['off', 'on', 'auto'];
const reject = (status, message) => { throw new StatusResponseError(message, status); };
const bounded = (value, fallback, min, max) => Number.isFinite(Number(value))
  ? Math.min(max, Math.max(min, Math.round(Number(value)))) : fallback;
const streamCapacity = value => Number.isInteger(value) && value >= 1 && value <= 4 ? value : 2;
const text = (value, fallback, max = 32) => Array.from(String(value || fallback)).slice(0, max).join('');
const samePeer = (a, b) => a.fabricIndex === b.fabricIndex && a.nodeId === b.nodeId;
const clone = value => structuredClone(value);

function requireOwner(item, peer, kind) {
  if (!item || !samePeer(item.owner, peer)) reject(Status.NotFound, `${kind} not found`);
  return item;
}

/** Runtime resource accounting shared by all fabrics of one camera. Not persisted encoder state. */
export class MatterCameraResources {
  constructor(maxStreams = 2) {
    this.maxStreams = streamCapacity(maxStreams);
    this.allocated = { video: new Map(), audio: new Map(), snapshot: new Map() };
    this.sessions = new Map();
    this.nextStream = 1;
    this.nextSession = 1;
  }
  reserve(kind, owner, stream) {
    const map = this.allocated[kind];
    if (!map) reject(Status.InvalidCommand, 'Unsupported stream kind');
    if (map.size >= this.maxStreams) reject(Status.ResourceExhausted, 'Encoder capacity is allocated');
    const id = this.nextStream;
    this.nextStream = this.nextStream % 65534 + 1;
    map.set(id, { owner: { ...owner }, stream: { ...clone(stream), [`${kind}StreamId`]: id, referenceCount: 0 } });
    return id;
  }
  own(kind, id, owner) { return requireOwner(this.allocated[kind]?.get(id), owner, 'Stream'); }
  deallocate(kind, id, owner) {
    const entry = this.own(kind, id, owner);
    if (entry.stream.referenceCount) reject(Status.InvalidInState, 'Stream is in use');
    this.allocated[kind].delete(id);
  }
  select(kind, request, owner) {
    const listKey = `${kind}Streams`, legacyKey = `${kind}StreamId`;
    let ids;
    if (request[listKey] !== undefined) ids = request[listKey];
    else if (request[legacyKey] !== undefined) ids = request[legacyKey] === null ? null : [request[legacyKey]];
    else return undefined;
    if (ids === null) {
      const first = [...this.allocated[kind].values()].find(entry => samePeer(entry.owner, owner));
      if (!first) reject(Status.InvalidInState, 'Allocate stream before starting a session');
      return first;
    }
    if (!Array.isArray(ids) || ids.length > 1) reject(Status.ConstraintError, 'One stream is supported');
    return ids.length ? this.own(kind, ids[0], owner) : undefined;
  }
  openSession({ owner, peerEndpointId, video, audio }) {
    if (this.sessions.size >= this.maxStreams) reject(Status.ResourceExhausted, 'Camera is already streaming');
    if (!video && !audio) reject(Status.InvalidCommand, 'An allocated media stream is required');
    for (const [kind, entry] of [['video', video], ['audio', audio]]) {
      if (!entry) continue;
      requireOwner(entry, owner, 'Stream');
      if (this.allocated[kind].get(entry.stream[`${kind}StreamId`]) !== entry) reject(Status.NotFound, 'Stream not found');
    }
    const id = this.nextSession;
    this.nextSession = this.nextSession % 65534 + 1;
    const item = { id, owner: { ...owner }, peerEndpointId, video, audio, state: 'connecting', pendingCandidates: [], ready: false,
      pendingRemoteCandidates: [], mediaCreated: false, mediaId: `${owner.fabricIndex}:${owner.nodeId}:${id}` };
    this.sessions.set(id, item);
    for (const entry of [video, audio]) if (entry) entry.stream.referenceCount++;
    return item;
  }
  session(id, owner) { return requireOwner(this.sessions.get(id), owner, 'Session'); }
  detachSession(item) {
    if (this.sessions.get(item.id) !== item || item.ending) return false;
    item.ending = true;
    clearTimeout(item.timer);
    item.pendingCandidates.length = 0;
    item.pendingRemoteCandidates.length = 0;
    this.sessions.delete(item.id);
    for (const entry of [item.video, item.audio]) if (entry) entry.stream.referenceCount = Math.max(0, entry.stream.referenceCount - 1);
    return true;
  }
  forgetFabric(fabricIndex) {
    const removed = [...this.sessions.values()].filter(item => item.owner.fabricIndex === fabricIndex);
    for (const item of removed) this.detachSession(item);
    for (const map of Object.values(this.allocated)) {
      for (const [id, entry] of map) if (entry.owner.fabricIndex === fabricIndex) map.delete(id);
    }
    return removed;
  }
  clear() {
    const removed = [...this.sessions.values()];
    for (const item of removed) this.detachSession(item);
    for (const map of Object.values(this.allocated)) map.clear();
    return removed;
  }
}

export function normalizeMatterVideoAllocation(request, { width, height, frameRate, bitRate }) {
  if (request.streamUsage !== LIVE) reject(Status.InvalidCommand, 'Only live view is supported');
  if (request.videoCodec !== 0) reject(Status.InvalidCommand, 'Only H264 is supported');
  for (const [min, max] of [[request.minFrameRate, request.maxFrameRate], [request.minBitRate, request.maxBitRate],
    [request.minResolution?.width, request.maxResolution?.width], [request.minResolution?.height, request.maxResolution?.height]]) {
    if (!Number.isFinite(min) || !Number.isFinite(max) || min < 1 || min > max) reject(Status.ConstraintError, 'Invalid allocation range');
  }
  if (request.minResolution.width > width || request.minResolution.height > height || request.minFrameRate > frameRate
    || request.minBitRate > bitRate || request.maxBitRate < 64000) reject(Status.ResourceExhausted, 'Requested stream exceeds capacity');
  if (request.watermarkEnabled || request.osdEnabled) reject(Status.InvalidCommand, 'Overlay is unsupported');
  if (!Number.isInteger(request.keyFrameInterval) || request.keyFrameInterval < 1000 || request.keyFrameInterval > 4000)
    reject(Status.ConstraintError, 'Keyframe interval is outside supported range');
  const actual = { ...clone(request), maxFrameRate: Math.min(frameRate, request.maxFrameRate),
    maxResolution: { width: Math.min(width, request.maxResolution.width) & ~1, height: Math.min(height, request.maxResolution.height) & ~1 },
    minBitRate: Math.max(64000, request.minBitRate), maxBitRate: Math.min(bitRate, request.maxBitRate) };
  if (actual.maxResolution.width < 160 || actual.maxResolution.height < 120
    || actual.maxResolution.width < request.minResolution.width || actual.maxResolution.height < request.minResolution.height)
    reject(Status.ResourceExhausted, 'Requested resolution is unsupported');
  return actual;
}

export function validateMatterTransportRequest(request) {
  if (request.streamUsage !== undefined && request.streamUsage !== LIVE) reject(Status.InvalidCommand, 'Only live view is supported');
  if (request.metadataEnabled) reject(Status.InvalidCommand, 'Metadata is unsupported');
  if (request.iceTransportPolicy && request.iceTransportPolicy !== 'all') reject(Status.InvalidCommand, 'Only LAN ICE transport is supported');
  if (request.iceServers?.length) reject(Status.InvalidCommand, 'External ICE servers are unsupported');
  if (request.webRtcSessionId != null) reject(Status.InvalidInState, 'End the existing session before renegotiating');
  if (!Number.isInteger(request.originatingEndpointId) || request.originatingEndpointId < 0 || request.originatingEndpointId > 65534)
    reject(Status.InvalidCommand, 'Requestor endpoint is required');
}

export function describeMatterSession(item) {
  return { id: item.id, peerNodeId: item.owner.nodeId, peerEndpointId: item.peerEndpointId,
    fabricIndex: item.owner.fabricIndex, streamUsage: LIVE, metadataEnabled: false,
    videoStreamId: item.video?.stream.videoStreamId ?? null, audioStreamId: item.audio?.stream.audioStreamId ?? null,
    ...(item.video ? { videoStreams: [item.video.stream.videoStreamId] } : {}),
    ...(item.audio ? { audioStreams: [item.audio.stream.audioStreamId] } : {}) };
}

/** Keep external encoder accounting atomic with Matter's own cluster-state transaction. */
export function enrollMatterSession({ resources, item, transaction, publish, start, afterRollback,
  schedule = setImmediate }) {
  let launchScheduled = false;
  const rollback = () => { resources.detachSession(item); };
  try {
    transaction.addParticipants({
      toString: () => `camera-session-create#${item.id}`,
      rollback,
      conclusion(outcome) {
        if (outcome === 'committed' && !launchScheduled) {
          launchScheduled = true;
          schedule(() => { if (resources.sessions.get(item.id) === item && !item.ending) start(); });
        } else if (outcome !== 'committed') {
          rollback();
          if (afterRollback) schedule(afterRollback);
        }
      },
    });
    publish();
  } catch (error) {
    rollback();
    // The enclosing transaction also rolls back. Restore its view immediately when synchronous validation failed.
    try { publish(); } catch {}
    throw error;
  }
}

/**
 * A real Matter Camera (0x0142), using the Matter 1.6.1 model in matter.js 0.18.
 * Matter carries authenticated signaling; media is encrypted WebRTC supplied by matter-media.
 * Pairing credentials are returned only by the explicit admin-facing pairing() method.
 */
export async function createMatterDevice({ storagePath, name, serialNumber, networkInterface, port = 5540,
  media, runtime, config = {} } = {}) {
  if (!storagePath || !media || typeof media.createSession !== 'function') throw new Error('matter_configuration_invalid');
  const width = bounded(config.width, 640, 160, 1280) & ~1;
  const height = bounded(config.height, 360, 120, 720) & ~1;
  const fps = bounded(config.frameRate, 12, 1, 30);
  const bitRate = bounded(config.bitRate, 800000, 64000, 2000000);
  const maxStreams = streamCapacity(config.maxStreams);
  const audioEnabled = config.enableAudio !== false;
  const speakerEnabled = config.enableTalkback === true;
  const nightEnabled = config.nightVision === true && typeof runtime?.setNightVision === 'function';
  const rootDir = path.join(path.resolve(storagePath), 'matter');
  await mkdir(rootDir, { recursive: true, mode: 0o700 });
  await chmod(rootDir, 0o700);
  const identifier = `camera-${createHash('sha256').update(String(serialNumber || name || 'mijia')).digest('hex').slice(0, 16)}`;
  const env = new Environment(identifier, Environment.default);
  // Matter's debug logs include decrypted commands (SDP and ICE credentials). Keep those out of Homebridge logs.
  Logger.level = 'warn';
  const vars = new VariableService(env);
  vars.addConfigStyle(clone(Environment.default.vars.vars));
  env.set(Filesystem, new NodeJsFilesystem(rootDir));
  // A separate service also avoids namespace collisions with other Matter nodes in this process.
  const storage = new StorageService(env);
  storage.registerDriver(FileStorageDriver);
  storage.defaultDriver = 'file';
  storage.registerBlobDriver(FlatFileBlobStorageDriver);
  storage.defaultBlobDriver = 'file';
  if (networkInterface) env.vars.set('mdns.networkInterface', String(networkInterface));
  env.vars.set('storage.lock', true);

  const resources = new MatterCameraResources(maxStreams), { allocated, sessions } = resources;
  let server, endpoint, closed = false, cachedCommissioned = false,
    nextControl = 1, lastError, applyingNightMode = false;
  const ptz = new MatterPtzStepControl({ runtime, onChange: state => {
    if (endpoint && !closed) return endpoint.set({ mijiaPtzStep: state });
  } });
  const metadata = new MatterMetadataControl({ runtime, onChange: async state => {
    if (!endpoint || closed) return;
    await endpoint.set({ mijiaMetadata: state });
    if (state.syncEnabled && state.available && state.snapshot.name && server) {
      // Only confirmed cloud metadata updates this advertised label. A controller's
      // direct BasicInformation.NodeLabel write never invokes a Xiaomi cloud write.
      await server.set({ basicInformation: { nodeLabel: text(state.snapshot.name, 'Mijia Camera') } });
    }
  } });
  const features = ['Video', 'Audio', 'Snapshot', ...(speakerEnabled ? ['Speaker'] : []), ...(nightEnabled ? ['NightVision'] : [])];
  const dimensions = { width, height };
  const snapshotCapabilities = [{ resolution: dimensions, maxFrameRate: 1, imageCodec: 0,
    requiresEncodedPixels: false }];

  function actor(behavior) {
    assertRemoteActor(behavior.context);
    NodeSession.assert(behavior.context.session);
    const address = behavior.context.session.peerAddress;
    return { fabricIndex: address.fabricIndex, nodeId: address.nodeId };
  }
  function live(usage) { if (usage !== LIVE) reject(Status.InvalidCommand, 'Only live view is supported'); }
  function own(map, id, owner) {
    return requireOwner(map.get(id), owner, 'Stream');
  }
  function sessionFor(behavior, id) {
    return resources.session(id, actor(behavior));
  }
  function checkRange(min, max) {
    if (!Number.isFinite(min) || !Number.isFinite(max) || min < 1 || min > max) reject(Status.ConstraintError, 'Invalid allocation range');
  }
  function validateResolution(request) {
    checkRange(request.minResolution?.width, request.maxResolution?.width);
    checkRange(request.minResolution?.height, request.maxResolution?.height);
    if (request.minResolution.width > width || request.minResolution.height > height)
      reject(Status.ResourceExhausted, 'Requested resolution exceeds capacity');
  }
  function reserve(kind, owner, stream) {
    return resources.reserve(kind, owner, stream);
  }
  function streamList(kind) { return [...allocated[kind].values()].map(item => clone(item.stream)); }
  function describeSession(item) {
    return describeMatterSession(item);
  }
  async function syncState() {
    if (!endpoint || closed) return;
    await endpoint.set({ cameraAvStreamManagement: { allocatedVideoStreams: streamList('video'),
      allocatedAudioStreams: streamList('audio'), allocatedSnapshotStreams: streamList('snapshot') },
    webRtcTransportProvider: { currentSessions: [...sessions.values()].map(describeSession) } });
  }
  function updateInBehavior(behavior, kind) {
    behavior.state[`allocated${kind[0].toUpperCase()}${kind.slice(1)}Streams`] = streamList(kind);
  }
  function beforeCommit(behavior, operation, message) {
    // $Changing is synchronous. A phase-one participant can await the hardware and reject the Matter write
    // before the attribute commits; an asynchronous $Changed observer would acknowledge failures as successes.
    const controlId = nextControl++;
    behavior.context.transaction.addParticipants({
      role: Symbol('camera-control'), toString: () => `camera-control#${controlId}`,
      async commit1() {
        try { await operation(); }
        catch { reject(Status.Failure, message); }
      },
    });
  }
  async function invokeRequestor(item, command, fields) {
    if (closed || (command !== 'end' && !sessions.has(item.id))) return;
    const peer = await server.peers.forAddress(item.owner);
    const request = Invoke({ endpoint: EndpointNumber(item.peerEndpointId), cluster: WebRtcTransportRequestor, command, fields });
    for await (const chunk of peer.interaction.invoke(request)) {
      for (const entry of chunk) {
        if (entry.kind === 'cmd-status' && entry.status !== Status.Success) throw new Error('matter_signaling_rejected');
      }
    }
  }
  async function end(item, reason = 2, notify = false, synchronize = true) {
    if (!resources.detachSession(item)) return;
    await media.closeSession(item.mediaId).catch(() => {});
    if (synchronize) await syncState().catch(() => {});
    // Stop encoders and release their references before waiting for a controller that may be offline.
    if (notify) await invokeRequestor(item, 'end', { webRtcSessionId: item.id, reason }).catch(() => {});
  }
  function fail(item, code) {
    if (sessions.get(item.id) !== item) return;
    lastError = code;
    void end(item, code === 'matter_session_timeout' ? 1 : 0, true);
  }
  function selectStream(kind, request, owner) {
    return resources.select(kind, request, owner);
  }

  class PrivateCommissioningServer extends CommissioningServer {
    // The library default writes the passcode, manual pairing code and QR to the process log.
    initiateCommissioning() {}
  }
  class MijiaPtzStepServer extends MijiaPtzStepBehavior {
    // The external shared guard rejects simultaneous actors instead of queueing movement
    // behind the cluster's state lock. Attribute publications use separate transactions.
    static lockOnInvoke = false;
    async moveStep({ direction }) {
      actor(this);
      await ptz.move(direction);
    }
  }
  class MijiaMetadataServer extends MijiaMetadataBehavior {
    static lockOnInvoke = false;
    async refreshMetadata(request) { actor(this); await metadata.refreshMetadata(request); }
    async setSyncEnabled(request) { actor(this); await metadata.setSyncEnabled(request); }
    async renameDevice(request) { actor(this); await metadata.renameDevice(request); }
    async moveDevice(request) { actor(this); await metadata.moveDevice(request); }
  }
  class MijiaAvServer extends CameraAvStreamManagementServer.with(...features) {
    async initialize() {
      // Allocations hold runtime encoder resources and do not survive a process restart.
      this.state.allocatedVideoStreams = [];
      this.state.allocatedAudioStreams = [];
      this.state.allocatedSnapshotStreams = [];
      if (!speakerEnabled && typeof media.setSpeakerMuted === 'function') await media.setSpeakerMuted(true);
      for (const [field, method] of [['microphoneMuted', 'setMicrophoneMuted'], ['microphoneVolumeLevel', 'setMicrophoneVolume'],
        ...(speakerEnabled ? [['speakerMuted', 'setSpeakerMuted'], ['speakerVolumeLevel', 'setSpeakerVolume']] : [])]) {
        if (typeof media[method] !== 'function') continue;
        await media[method](this.state[field]);
        this.reactTo(this.events[`${field}$Changing`], function (value) {
          beforeCommit(this, () => media[method](value), 'Audio control failed');
        });
      }
      if (nightEnabled) {
        this.reactTo(this.events.nightVision$Changing, function (value) {
          if (!hasRemoteActor(this.context)) return;
          if (!NIGHT[value]) reject(Status.ConstraintError, 'Invalid night vision mode');
          beforeCommit(this, async () => {
            try {
              applyingNightMode = true;
              const reply = await runtime.setNightVision(NIGHT[value]);
              if (reply?.mode !== NIGHT[value]) throw new Error('not_applied');
            } finally { applyingNightMode = false; }
          }, 'Night vision control unavailable');
        });
      }
    }
    setStreamPriorities({ streamPriorities }) {
      if (streamPriorities.length !== 1 || streamPriorities[0] !== LIVE) reject(Status.ConstraintError, 'Only live view is supported');
      this.state.streamUsagePriorities = [LIVE];
    }
    videoStreamAllocate(request) {
      const actual = normalizeMatterVideoAllocation(request, { width, height, frameRate: fps, bitRate });
      const id = reserve('video', actor(this), actual);
      updateInBehavior(this, 'video');
      return { videoStreamId: id };
    }
    videoStreamDeallocate({ videoStreamId }) {
      resources.deallocate('video', videoStreamId, actor(this)); updateInBehavior(this, 'video');
    }
    audioStreamAllocate(request) {
      live(request.streamUsage);
      if (!audioEnabled) reject(Status.InvalidInState, 'Microphone is disabled');
      if (request.audioCodec !== 0 || request.channelCount !== 1 || request.sampleRate !== 48000 || request.bitDepth !== 16
        || request.bitRate < 16000 || request.bitRate > 64000) reject(Status.ConstraintError, 'Unsupported Opus parameters');
      const id = reserve('audio', actor(this), request);
      updateInBehavior(this, 'audio'); return { audioStreamId: id };
    }
    audioStreamDeallocate({ audioStreamId }) {
      resources.deallocate('audio', audioStreamId, actor(this)); updateInBehavior(this, 'audio');
    }
    snapshotStreamAllocate(request) {
      if (request.imageCodec !== 0 || request.maxFrameRate > 1 || request.watermarkEnabled || request.osdEnabled)
        reject(Status.ConstraintError, 'Unsupported snapshot parameters');
      validateResolution(request);
      const id = reserve('snapshot', actor(this), { imageCodec: 0, frameRate: request.maxFrameRate,
        minResolution: request.minResolution, maxResolution: request.maxResolution, quality: request.quality,
        encodedPixels: false, hardwareEncoder: false });
      updateInBehavior(this, 'snapshot'); return { snapshotStreamId: id };
    }
    snapshotStreamDeallocate({ snapshotStreamId }) {
      resources.deallocate('snapshot', snapshotStreamId, actor(this)); updateInBehavior(this, 'snapshot');
    }
    async captureSnapshot({ snapshotStreamId, requestedResolution }) {
      if (snapshotStreamId !== null) own(allocated.snapshot, snapshotStreamId, actor(this));
      else actor(this);
      if (requestedResolution.width < 2 || requestedResolution.height < 2) reject(Status.ConstraintError, 'Snapshot resolution is unsupported');
      try {
        const result = await media.snapshot({ width: Math.min(width, requestedResolution.width),
          height: Math.min(height, requestedResolution.height) });
        if (!result?.data?.length || result.data.length > 1000000 || !result.width || !result.height
          || result.width > Math.min(width, requestedResolution.width) || result.height > Math.min(height, requestedResolution.height))
          reject(Status.Failure, 'Snapshot unavailable');
        return { data: result.data, imageCodec: CameraAvStreamManagement.ImageCodec.Jpeg,
          resolution: { width: result.width, height: result.height } };
      } catch { reject(Status.Failure, 'Snapshot unavailable'); }
    }
  }
  class MijiaWebRtcServer extends WebRtcTransportProviderServer {
    initialize() { this.state.currentSessions = []; }
    async create(request, isOffer) {
      const owner = actor(this);
      validateMatterTransportRequest(request);
      const video = selectStream('video', request, owner), audio = selectStream('audio', request, owner);
      if (!video && !audio) reject(Status.InvalidCommand, 'An allocated media stream is required');
      if (isOffer && (typeof request.sdp !== 'string' || request.sdp.length > 65535)) reject(Status.ConstraintError, 'Invalid SDP');
      const item = resources.openSession({ owner, peerEndpointId: request.originatingEndpointId, video, audio }), { id } = item;
      lastError = undefined;
      const startMedia = () => {
        item.timer = setTimeout(() => fail(item, 'matter_session_timeout'), 30000);
        item.timer.unref?.();
        void (async () => {
        if (closed || !sessions.has(id)) return;
        await syncState();
        if (closed || sessions.get(id) !== item || item.ending) return;
        const v = video?.stream, a = audio?.stream;
        const result = await media.createSession({ id: item.mediaId, ...(isOffer ? { offer: request.sdp } : {}),
          video: v ? { id: v.videoStreamId, codec: 'h264', width: Math.min(width, v.maxResolution.width),
            height: Math.min(height, v.maxResolution.height), frameRate: Math.min(fps, v.maxFrameRate),
            bitRate: Math.min(bitRate, v.maxBitRate), keyFrameInterval: v.keyFrameInterval } : undefined,
          audio: a ? { id: a.audioStreamId, codec: 'opus', sampleRate: 48000, channels: 1, bitRate: a.bitRate } : undefined,
          iceServers: request.iceServers, iceTransportPolicy: request.iceTransportPolicy || 'all',
          onCandidate(candidate) {
            if (!candidate?.candidate || closed || sessions.get(id) !== item) return;
            const normalized = { candidate: candidate.candidate, sdpMid: candidate.sdpMid ?? null,
              sdpmLineIndex: candidate.sdpMLineIndex ?? candidate.sdpmLineIndex ?? null };
            if (!item.ready) {
              if (item.pendingCandidates.length < 128) item.pendingCandidates.push(normalized);
            } else void invokeRequestor(item, 'iceCandidates', { webRtcSessionId: id, iceCandidates: [normalized] }).catch(() => fail(item, 'matter_signaling_failed'));
          },
          onState(state) {
            if (closed || sessions.get(id) !== item || item.ending) return;
            item.state = state;
            if (state === 'connected') {
              clearTimeout(item.timer);
              item.timer = setTimeout(() => fail(item, 'matter_session_timeout'), 60 * 60 * 1000);
              item.timer.unref?.();
            } else if (state === 'failed' || state === 'closed') void end(item, state === 'failed' ? 0 : 2, true);
          } });
        if (sessions.get(id) !== item || closed) { await media.closeSession(item.mediaId); return; }
        item.mediaCreated = true;
        while (item.pendingRemoteCandidates.length) await media.addCandidates(item.mediaId, item.pendingRemoteCandidates.splice(0, 32));
        const sdp = isOffer ? result.answer : result.offer;
        if (typeof sdp !== 'string' || !sdp.length) throw new Error('matter_signaling_failed');
        await invokeRequestor(item, isOffer ? 'answer' : 'offer', { webRtcSessionId: id, sdp });
        item.ready = true;
        if (item.pendingCandidates.length) await invokeRequestor(item, 'iceCandidates', {
          webRtcSessionId: id, iceCandidates: item.pendingCandidates.splice(0) });
        })().catch(() => fail(item, 'matter_signaling_failed'));
      };
      enrollMatterSession({ resources, item, transaction: this.context.transaction,
        publish: () => { this.state.currentSessions = [...sessions.values()].map(describeSession); },
        start: startMedia, afterRollback: () => {
          void Promise.resolve(media.closeSession(item.mediaId)).catch(() => {}).then(() => syncState()).catch(() => {});
        } });
      const response = { webRtcSessionId: id };
      if (!isOffer) response.deferredOffer = false;
      if ('videoStreamId' in request) response.videoStreamId = video?.stream.videoStreamId ?? null;
      if ('audioStreamId' in request) response.audioStreamId = audio?.stream.audioStreamId ?? null;
      return response;
    }
    solicitOffer(request) { return this.create(request, false); }
    provideOffer(request) { return this.create(request, true); }
    async provideAnswer({ webRtcSessionId, sdp }) {
      const item = sessionFor(this, webRtcSessionId);
      try { await media.provideAnswer(item.mediaId, sdp); }
      catch { reject(Status.Failure, 'Invalid WebRTC answer'); }
    }
    async provideIceCandidates({ webRtcSessionId, iceCandidates }) {
      const item = sessionFor(this, webRtcSessionId);
      if (!iceCandidates.length || iceCandidates.length > 32) reject(Status.ConstraintError, 'Invalid ICE candidates');
      const normalized = iceCandidates.map(candidate => ({ candidate: candidate.candidate,
        sdpMid: candidate.sdpMid ?? undefined, sdpMLineIndex: candidate.sdpmLineIndex ?? undefined }));
      if (!item.mediaCreated) {
        if (item.pendingRemoteCandidates.length + normalized.length > 128) reject(Status.ResourceExhausted, 'Too many pending ICE candidates');
        item.pendingRemoteCandidates.push(...normalized); return;
      }
      try { await media.addCandidates(item.mediaId, normalized); }
      catch { reject(Status.Failure, 'Invalid ICE candidate'); }
    }
    async endSession({ webRtcSessionId, reason }) {
      const item = sessionFor(this, webRtcSessionId);
      await end(item, reason, false, false);
      this.state.currentSessions = [...sessions.values()].map(describeSession);
      setImmediate(() => { void syncState().catch(() => {}); });
    }
  }

  try {
    server = await ServerNode.create(ServerNode.RootEndpoint.with(PrivateCommissioningServer), {
      id: identifier, environment: env,
      network: { port, ble: false, tcp: true,
        ...(config.listeningAddressIpv4 ? { listeningAddressIpv4: config.listeningAddressIpv4 } : {}),
        ...(config.listeningAddressIpv6 ? { listeningAddressIpv6: config.listeningAddressIpv6 } : {}) },
      basicInformation: { vendorName: 'linanw', vendorId: VendorId(0xfff1), productName: 'Mijia Remote Camera',
        productId: 0x8001, nodeLabel: text(name, 'Mijia Camera'), serialNumber: text(serialNumber, identifier),
        hardwareVersion: 1, softwareVersion: 400, softwareVersionString: '0.4.0' },
    });
    const audioCapabilities = { maxNumberOfChannels: 1, supportedCodecs: [0], supportedSampleRates: [48000], supportedBitDepths: [16] };
    endpoint = new Endpoint(CameraDevice.with(MijiaAvServer, MijiaWebRtcServer, WebRtcTransportRequestorClient, MijiaPtzStepServer, MijiaMetadataServer), {
      id: 'camera', number: EndpointNumber(1),
      mijiaPtzStep: ptz.state(),
      mijiaMetadata: metadata.state(),
      cameraAvStreamManagement: {
        maxContentBufferSize: 1000000, maxNetworkBandwidth: 5000000 * maxStreams, maxConcurrentEncoders: maxStreams,
        maxEncodedPixelRate: width * height * fps * maxStreams,
        supportedStreamUsages: [LIVE], streamUsagePriorities: [LIVE],
        videoSensorParams: { sensorWidth: width, sensorHeight: height, maxFps: fps },
        minViewportResolution: { width: 160, height: 120 }, currentFrameRate: fps,
        rateDistortionTradeOffPoints: [{ codec: 0, resolution: dimensions, minBitRate: 64000 }],
        viewport: { x1: 0, y1: 0, x2: width, y2: height },
        microphoneCapabilities: audioCapabilities, microphoneMuted: !audioEnabled,
        microphoneVolumeLevel: 100, microphoneMinLevel: 0, microphoneMaxLevel: 100,
        snapshotCapabilities,
        ...(speakerEnabled ? { speakerCapabilities: audioCapabilities, twoWayTalkSupport: 2,
          speakerMuted: false, speakerVolumeLevel: 100, speakerMinLevel: 0, speakerMaxLevel: 100 } : {}),
        ...(nightEnabled ? { nightVision: 2, nightVisionUsesInfrared: true } : {}),
      }, webRtcTransportProvider: { currentSessions: [] },
    });
    await server.add(endpoint);
    if (nightEnabled && runtime?.on) runtime.on('night-mode', nightChanged);
    server.events.commissioning.fabricsChanged.on((fabricIndex, action) => {
      if (action !== 'deleted' || closed) return;
      void (async () => {
        await Promise.allSettled([...sessions.values()].filter(item => item.owner.fabricIndex === fabricIndex)
          .map(item => end(item, 2, false)));
        resources.forgetFabric(fabricIndex);
        await syncState();
      })().catch(() => {});
    });
  } catch (error) {
    ptz.close();
    metadata.close();
    await server?.close().catch(() => {});
    throw error;
  }
  function nightChanged(reply) {
    const value = NIGHT.indexOf(reply?.mode);
    if (value < 0 || closed || applyingNightMode || endpoint.state.cameraAvStreamManagement.nightVision === value) return;
    // Backend events synchronize other controllers; avoid writing back to the camera for this local sync.
    return endpoint.act(agent => { agent.get(MijiaAvServer).state.nightVision = value; }).catch(() => {});
  }
  return {
    async start() {
      if (closed) throw new Error('matter_closed');
      await server.start();
      await ptz.refresh();
      await metadata.refresh();
      if (nightEnabled && typeof runtime?.getNightVision === 'function') {
        const value = await runtime.getNightVision().catch(() => undefined);
        if (value) await nightChanged(value);
      }
      return this.status();
    },
    status() {
      return { enabled: true, running: !closed && server.lifecycle.isOnline,
        commissioned: closed ? cachedCommissioned : !!server.state.commissioning?.commissioned,
        commissioningWindowOpen: !closed && (server.env.maybeGet(DeviceCommissioner)?.windowStatus ?? 0) !== 0,
        deviceType: 0x0142, endpoint: 1, activeSessions: sessions.size,
        videoStreams: allocated.video.size, audioStreams: allocated.audio.size, snapshotStreams: allocated.snapshot.size,
        state: closed ? 'closed' : sessions.size ? [...sessions.values()][0].state : server.lifecycle.isOnline ? 'ready' : 'stopped',
        ...(lastError ? { error: lastError } : {}) };
    },
    pairing() {
      if (closed) throw new Error('matter_closed');
      const { manualPairingCode, qrPairingCode } = server.state.commissioning.pairingCodes;
      return { manualPairingCode, qrPairingCode };
    },
    async openCommissioningWindow() {
      if (closed || !server.lifecycle.isOnline) throw new Error('matter_not_running');
      await server.act(agent => agent.get(PrivateCommissioningServer).enterCommissionableMode());
      return this.status();
    },
    async closeCommissioningWindow() {
      if (closed || !server.lifecycle.isOnline) throw new Error('matter_not_running');
      await server.env.get(DeviceCommissioner).endCommissioning();
      return this.status();
    },
    async closeSessions() {
      if (closed) return;
      await Promise.allSettled([...sessions.values()].map(item => end(item, 5, true)));
      return this.status();
    },
    refreshPtzCapabilities(options) { return ptz.refresh(options); },
    refreshMetadataState(options) { return metadata.refresh(options); },
    async close() {
      if (closed) return;
      ptz.close();
      metadata.close();
      cachedCommissioned = !!server.state.commissioning?.commissioned;
      await Promise.allSettled([...sessions.values()].map(item => end(item, 2, true)));
      closed = true;
      runtime?.off?.('night-mode', nightChanged);
      await server.close();
      resources.clear();
    },
  };
}
