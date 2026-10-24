import assert from 'node:assert/strict';
import test from 'node:test';
import { Status, StreamUsage, TlvOfModel } from '@matter/main/types';
import { WebRtcTransportDefinitions } from '@matter/main/clusters/web-rtc-transport-definitions';
import { MatterCameraResources, normalizeMatterVideoAllocation, validateMatterTransportRequest,
  describeMatterSession, enrollMatterSession } from '../lib/matter-device.mjs';

const owner = { fabricIndex: 1, nodeId: 11n };
const otherNode = { fabricIndex: 1, nodeId: 12n };
const otherFabric = { fabricIndex: 2, nodeId: 11n };
const limits = { width: 640, height: 360, frameRate: 12, bitRate: 800000 };
const allocation = (patch = {}) => ({ streamUsage: StreamUsage.LiveView, videoCodec: 0, minFrameRate: 1, maxFrameRate: 30,
  minResolution: { width: 160, height: 120 }, maxResolution: { width: 1280, height: 720 },
  minBitRate: 10000, maxBitRate: 2000000, keyFrameInterval: 1000, ...patch });
const throwsStatus = (fn, status) => assert.throws(fn, error => error.code === status || error.status === status);

test('stream and session ownership requires both fabric and node, including legacy automatic selection', () => {
  const resources = new MatterCameraResources();
  const id = resources.reserve('video', owner, normalizeMatterVideoAllocation(allocation(), limits));
  const entry = resources.own('video', id, { ...owner });
  assert.equal(resources.select('video', { videoStreamId: id }, owner), entry);
  assert.equal(resources.select('video', { videoStreams: [id] }, owner), entry);
  assert.equal(resources.select('video', { videoStreamId: null }, owner), entry);
  for (const stranger of [otherNode, otherFabric]) {
    throwsStatus(() => resources.own('video', id, stranger), Status.NotFound);
    throwsStatus(() => resources.select('video', { videoStreams: [id] }, stranger), Status.NotFound);
    throwsStatus(() => resources.select('video', { videoStreamId: null }, stranger), Status.InvalidInState);
    throwsStatus(() => resources.deallocate('video', id, stranger), Status.NotFound);
  }
  const session = resources.openSession({ owner, peerEndpointId: 1, video: entry });
  assert.equal(resources.session(session.id, { ...owner }), session);
  for (const stranger of [otherNode, otherFabric]) {
    throwsStatus(() => resources.session(session.id, stranger), Status.NotFound);
  }
  throwsStatus(() => resources.session(session.id + 1, owner), Status.NotFound);
  assert.equal(resources.detachSession({ ...session }), false, 'a copied session cannot release a live session');
  assert.equal(resources.sessions.size, 1);
  assert.equal(entry.stream.referenceCount, 1);
});

test('capacity and reference counts prevent another stream or deallocation while media uses it', () => {
  const resources = new MatterCameraResources(1);
  const input = allocation(), videoId = resources.reserve('video', owner, input);
  input.minResolution.width = 9999;
  const video = resources.own('video', videoId, owner);
  assert.equal(video.stream.minResolution.width, 160, 'allocation does not retain mutable request data');
  throwsStatus(() => resources.reserve('video', owner, allocation()), Status.ResourceExhausted);
  throwsStatus(() => resources.reserve('video', otherFabric, allocation()), Status.ResourceExhausted);
  const audioId = resources.reserve('audio', owner, { audioCodec: 0 });
  const audio = resources.own('audio', audioId, owner);
  const session = resources.openSession({ owner, peerEndpointId: 1, video, audio });
  assert.equal(video.stream.referenceCount, 1);
  assert.equal(audio.stream.referenceCount, 1);
  throwsStatus(() => resources.openSession({ owner, peerEndpointId: 1, video }), Status.ResourceExhausted);
  throwsStatus(() => resources.deallocate('video', videoId, owner), Status.InvalidInState);
  assert.equal(resources.detachSession(session), true);
  assert.equal(resources.detachSession(session), false, 'cleanup is idempotent');
  assert.equal(video.stream.referenceCount, 0);
  assert.equal(audio.stream.referenceCount, 0);
  resources.deallocate('video', videoId, owner);
  assert.equal(resources.allocated.video.size, 0);
  assert.ok(resources.reserve('video', otherFabric, allocation()) > 0);
});

test('revision 2 empty stream lists disable that medium and override revision 1 fields', () => {
  const resources = new MatterCameraResources();
  const id = resources.reserve('video', owner, allocation());
  assert.equal(resources.select('video', {}, owner), undefined);
  assert.equal(resources.select('video', { videoStreams: [], videoStreamId: id }, owner), undefined);
  throwsStatus(() => resources.select('video', { videoStreams: [id, id] }, owner), Status.ConstraintError);
  throwsStatus(() => resources.select('video', { videoStreams: [id + 1] }, owner), Status.NotFound);
  throwsStatus(() => resources.openSession({ owner, peerEndpointId: 1 }), Status.InvalidCommand);
  const foreign = new MatterCameraResources(), foreignId = foreign.reserve('video', owner, allocation());
  throwsStatus(() => resources.openSession({ owner, peerEndpointId: 1, video: foreign.own('video', foreignId, owner) }), Status.NotFound);
});

test('video allocation reports the actual encoding envelope and rejects impossible or unsupported requests', () => {
  const input = allocation(), actual = normalizeMatterVideoAllocation(input, limits);
  assert.equal(actual.maxFrameRate, 12);
  assert.deepEqual(actual.maxResolution, { width: 640, height: 360 });
  assert.equal(actual.minBitRate, 64000);
  assert.equal(actual.maxBitRate, 800000);
  assert.deepEqual(input.maxResolution, { width: 1280, height: 720 });
  for (const patch of [{ videoCodec: 1 }, { streamUsage: 1 }, { watermarkEnabled: true }, { osdEnabled: true }]) {
    throwsStatus(() => normalizeMatterVideoAllocation(allocation(patch), limits), Status.InvalidCommand);
  }
  for (const patch of [{ minFrameRate: 20 }, { minResolution: { width: 1280, height: 720 } },
    { maxBitRate: 32000 }, { minBitRate: 900000 }, { minResolution: { width: 161, height: 121 }, maxResolution: { width: 161, height: 121 } }]) {
    throwsStatus(() => normalizeMatterVideoAllocation(allocation(patch), limits), Status.ResourceExhausted);
  }
  for (const patch of [{ minFrameRate: 31 }, { minBitRate: 0 }, { keyFrameInterval: 0 }, { keyFrameInterval: 5000 },
    { minResolution: { width: 160, height: 480 }, maxResolution: { width: 640, height: 360 } }]) {
    throwsStatus(() => normalizeMatterVideoAllocation(allocation(patch), limits), Status.ConstraintError);
  }
});

test('transport rejects relay, external ICE, recording, metadata and unsupported re-offers', () => {
  const valid = { webRtcSessionId: null, originatingEndpointId: 1, streamUsage: StreamUsage.LiveView };
  assert.doesNotThrow(() => validateMatterTransportRequest({ ...valid, iceServers: [], iceTransportPolicy: 'all' }));
  for (const patch of [{ iceTransportPolicy: 'relay' }, { iceTransportPolicy: 'bogus' },
    { iceServers: [{ urls: ['stun:example.invalid'] }] }, { metadataEnabled: true },
    { streamUsage: 1 }, { originatingEndpointId: -1 }, { originatingEndpointId: 65535 }, { originatingEndpointId: undefined }]) {
    throwsStatus(() => validateMatterTransportRequest({ ...valid, ...patch }), Status.InvalidCommand);
  }
  throwsStatus(() => validateMatterTransportRequest({ ...valid, webRtcSessionId: 1 }), Status.InvalidInState);
});

test('fabric deletion cancels its sessions and streams while retaining another fabric', () => {
  const resources = new MatterCameraResources(2);
  const v1 = resources.reserve('video', owner, allocation()), v2 = resources.reserve('video', otherFabric, allocation());
  const first = resources.openSession({ owner, peerEndpointId: 1, video: resources.own('video', v1, owner) });
  const second = resources.openSession({ owner: otherFabric, peerEndpointId: 1, video: resources.own('video', v2, otherFabric) });
  first.timer = setTimeout(() => assert.fail('deleted fabric timer ran'), 1000);
  const removed = resources.forgetFabric(owner.fabricIndex);
  assert.deepEqual(removed, [first]);
  assert.equal(first.timer._destroyed, true);
  assert.equal(first.video.stream.referenceCount, 0);
  throwsStatus(() => resources.session(first.id, owner), Status.NotFound);
  assert.equal(resources.session(second.id, otherFabric), second);
  assert.equal(resources.allocated.video.size, 1);
  assert.equal(resources.own('video', v2, otherFabric).stream.referenceCount, 1);
  assert.deepEqual(resources.forgetFabric(owner.fabricIndex), []);
  resources.clear();
});

test('shutdown releases all timer and reference accounting and remains idempotent', () => {
  const resources = new MatterCameraResources();
  const id = resources.reserve('video', owner, allocation()), video = resources.own('video', id, owner);
  const session = resources.openSession({ owner, peerEndpointId: 1, video });
  session.timer = setTimeout(() => assert.fail('shutdown timer ran'), 1000);
  assert.deepEqual(resources.clear(), [session]);
  assert.equal(session.timer._destroyed, true);
  assert.equal(video.stream.referenceCount, 0);
  assert.equal(resources.sessions.size, 0);
  for (const streams of Object.values(resources.allocated)) assert.equal(streams.size, 0);
  assert.deepEqual(resources.clear(), []);
});

test('single-medium sessions satisfy the real Matter schema by omitting absent optional stream lists', () => {
  const schema = TlvOfModel(WebRtcTransportDefinitions.schema.children.find(child => child.name === 'WebRTCSessionStruct'));
  for (const kind of ['video', 'audio']) {
    const resources = new MatterCameraResources(), id = resources.reserve(kind, owner, {});
    const session = resources.openSession({ owner, peerEndpointId: 1, [kind]: resources.own(kind, id, owner) });
    const description = describeMatterSession(session), absent = kind === 'video' ? 'audioStreams' : 'videoStreams';
    assert.equal(absent in description, false);
    assert.doesNotThrow(() => schema.validate(description));
    assert.throws(() => schema.validate({ ...description, [absent]: [] }), /length|minimum|lower|less|min|bound/i,
      'regression proof: present empty lists violate the actual Matter constraint');
    resources.clear();
  }
});

test('synchronous publication failure releases external session references before returning an error', () => {
  const resources = new MatterCameraResources(), id = resources.reserve('video', owner, {});
  const video = resources.own('video', id, owner), item = resources.openSession({ owner, peerEndpointId: 1, video });
  const participants = [], scheduled = []; let starts = 0, publicationCalls = 0;
  const transaction = { addParticipants(value) { participants.push(value); } };
  assert.throws(() => enrollMatterSession({ resources, item, transaction,
    publish() { if (++publicationCalls === 1) throw new Error('injected schema rejection'); },
    start() { starts++; }, schedule(fn) { scheduled.push(fn); } }), /injected schema rejection/);
  assert.equal(resources.sessions.size, 0);
  assert.equal(video.stream.referenceCount, 0);
  assert.equal(publicationCalls, 2, 'the transaction view is restored after detaching the failed session');
  participants[0].rollback(); participants[0].conclusion('rolled back');
  for (const action of scheduled) action();
  assert.equal(starts, 0);
  assert.equal(item.timer, undefined);
});

test('transaction rollback or inconsistent commit never starts media and frees the reserved session', () => {
  for (const outcome of ['rolled back', 'inconsistent']) {
    const resources = new MatterCameraResources(), id = resources.reserve('video', owner, {});
    const video = resources.own('video', id, owner), item = resources.openSession({ owner, peerEndpointId: 1, video });
    const participants = [], scheduled = []; let starts = 0, restores = 0;
    enrollMatterSession({ resources, item, transaction: { addParticipants(value) { participants.push(value); } },
      publish() {}, start() { starts++; }, afterRollback() { restores++; }, schedule(fn) { scheduled.push(fn); } });
    assert.equal(starts, 0, 'an accepted handler must wait for transaction commit before creating media');
    if (outcome === 'rolled back') participants[0].rollback();
    participants[0].conclusion(outcome);
    for (const action of scheduled) action();
    assert.equal(resources.sessions.size, 0);
    assert.equal(video.stream.referenceCount, 0);
    assert.equal(starts, 0);
    assert.equal(restores, 1);
    assert.equal(item.timer, undefined);
  }
});

test('committed session starts once after finalization and queued kickoff is cancelled by shutdown', () => {
  for (const shutdownFirst of [false, true]) {
    const resources = new MatterCameraResources(), id = resources.reserve('video', owner, {});
    const item = resources.openSession({ owner, peerEndpointId: 1, video: resources.own('video', id, owner) });
    let participant, starts = 0; const scheduled = [];
    enrollMatterSession({ resources, item, transaction: { addParticipants(value) { participant = value; } },
      publish() {}, start() { starts++; }, schedule(fn) { scheduled.push(fn); } });
    assert.equal(starts, 0);
    participant.conclusion('committed');
    participant.conclusion('committed');
    assert.equal(starts, 0);
    if (shutdownFirst) resources.clear();
    for (const action of scheduled) action();
    assert.equal(starts, shutdownFirst ? 0 : 1);
    resources.clear();
  }
});

test('default two-viewer capacity isolates owners and reuses a released slot without interrupting the survivor', () => {
  const resources = new MatterCameraResources();
  const a = resources.reserve('video', owner, allocation()), b = resources.reserve('video', otherNode, allocation());
  const firstVideo = resources.own('video', a, owner), secondVideo = resources.own('video', b, otherNode);
  const first = resources.openSession({ owner, peerEndpointId: 1, video: firstVideo });
  const second = resources.openSession({ owner: otherNode, peerEndpointId: 2, video: secondVideo });
  assert.equal(resources.sessions.size, 2);
  throwsStatus(() => resources.reserve('video', otherFabric, allocation()), Status.ResourceExhausted);
  throwsStatus(() => resources.openSession({ owner, peerEndpointId: 3, video: firstVideo }), Status.ResourceExhausted);
  throwsStatus(() => resources.session(second.id, owner), Status.NotFound);
  throwsStatus(() => resources.deallocate('video', b, owner), Status.NotFound);
  resources.detachSession(first); resources.deallocate('video', a, owner);
  assert.equal(resources.session(second.id, otherNode), second);
  assert.equal(secondVideo.stream.referenceCount, 1);
  const c = resources.reserve('video', otherFabric, allocation());
  const third = resources.openSession({ owner: otherFabric, peerEndpointId: 3, video: resources.own('video', c, otherFabric) });
  assert.equal(resources.sessions.size, 2); assert.notEqual(third.id, second.id);
  assert.deepEqual(resources.forgetFabric(otherFabric.fabricIndex), [third]);
  assert.equal(resources.session(second.id, otherNode), second);
  resources.clear(); assert.equal(secondVideo.stream.referenceCount, 0);
});

test('two sessions sharing one owner allocation keep it referenced until both independent sessions end', () => {
  const resources = new MatterCameraResources(), id = resources.reserve('video', owner, allocation());
  const video = resources.own('video', id, owner);
  const first = resources.openSession({ owner, peerEndpointId: 1, video });
  const second = resources.openSession({ owner, peerEndpointId: 2, video });
  assert.equal(video.stream.referenceCount, 2);
  resources.detachSession(first); assert.equal(video.stream.referenceCount, 1);
  throwsStatus(() => resources.deallocate('video', id, owner), Status.InvalidInState);
  assert.equal(resources.detachSession(first), false); assert.equal(video.stream.referenceCount, 1);
  resources.detachSession(second); assert.equal(video.stream.referenceCount, 0);
  resources.deallocate('video', id, owner); assert.equal(resources.allocated.video.size, 0);
});
