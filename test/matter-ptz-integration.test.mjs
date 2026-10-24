import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { createCaseController, installCaseLoopback } from './helpers/matter-case-loopback.mjs';
import { Invoke, Read, Write } from '@matter/main/protocol';
import { Status } from '@matter/main/types';
import { Descriptor } from '@matter/main/clusters/descriptor';
import { createMatterDevice } from '../lib/matter-device.mjs';
import { MijiaPtzStep, MIJIA_PTZ_STEP_CLUSTER_ID } from '../lib/matter-ptz-cluster.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function boundedWait(promise, message) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), 2000); })]); }
  finally { clearTimeout(timer); }
}
async function freePort() {
  const socket = createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve)); return port;
}

// Uses real PASE, CASE, encrypted interaction requests and TLV, only on loopback.
// The backend is synthetic; this test never moves a real camera or contacts an existing fabric.
test('vendor direction steps are discovered and invoked over real commissioned CASE', { timeout: 30000 }, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mijia-step-case-'));
  const port = await freePort();
  const loopback = installCaseLoopback({ port, signal: t.signal });
  let camera, controller, peer;
  let caps = { supported: false, available: false, relativeStep: true, directions: ['up', 'down', 'left', 'right'] };
  let rejectBackend = false, hold;
  const moves = [];
  const runtime = { getPtzCapabilities: () => caps, async movePtz(direction) {
    moves.push(direction); if (hold) { hold.entered.resolve(); await hold.accept.promise; }
    if (rejectBackend) throw new Error('PRIVATE_CAMERA_CREDENTIAL');
    return { accepted: true };
  } };
  try {
    camera = await createMatterDevice({ storagePath: dir, name: 'Synthetic direction QA', serialNumber: 'step-case',
      networkInterface: 'lo', port, runtime,
      media: { async createSession() {}, async closeSession() {}, setMicrophoneMuted() {}, setMicrophoneVolume() {} },
      config: { listeningAddressIpv4: '127.0.0.1', listeningAddressIpv6: '::1' } });
    await camera.start();
    controller = await createCaseController('step-controller');
    loopback.attach(controller);
    await controller.start();
    peer = await controller.peers.forDescriptor({ addresses: [{ type: 'udp', ip: '127.0.0.1', port }] });
    await peer.commission({ ...loopback.commissionOptions, pairingCode: camera.pairing().manualPairingCode,
      autoSubscribe: false, autoStateInitialize: false, onAttestationFailure: true });
    async function read() {
      const result = {};
      const request = { ...Read(Read.Attribute({ endpoint: 1, cluster: MijiaPtzStep })), includeKnownVersions: true, abort: loopback.signal };
      for await (const chunk of peer.interaction.read(request)) {
        for await (const item of chunk) {
          if (item.kind === 'attr-value') result[item.path.attributeId] = item.value;
          else if (item.kind === 'attr-status') result[`status${item.path.attributeId}`] = item.status;
        }
      }
      return result;
    }
    async function invoke(direction) {
      const request = Invoke({ endpoint: 1, cluster: MijiaPtzStep, command: 'moveStep', fields: { direction } });
      // This client metadata is set on the built request; Invoke.Definition does not copy it.
      request.batchDuration = false; request.abort = loopback.signal;
      for await (const chunk of peer.interaction.invoke(request)) {
        for (const item of chunk) if (item.kind === 'cmd-status') return item.status;
      }
      assert.fail('No IM status received');
    }
    assert.ok(loopback.counters.operationalPeers > 0);
    await loopback.reconnect();
    const initial = await read();
    assert.equal(initial[0], false); assert.equal(initial[1], false); assert.equal(initial[2], 0); assert.equal(initial[3], 0);
    assert.ok(initial[0xfffb].includes(3), 'vendor attributes are published');
    assert.ok(initial[0xfff9].includes(0), 'MoveStep is in AcceptedCommandList');
    let serverList;
    for await (const chunk of peer.interaction.read({ ...Read(Read.Attribute({ endpoint: 1, cluster: Descriptor,
      attributes: ['serverList'] })), includeKnownVersions: true, abort: loopback.signal })) {
      for await (const item of chunk) if (item.kind === 'attr-value') serverList = item.value;
    }
    assert.ok(serverList.includes(MIJIA_PTZ_STEP_CLUSTER_ID));
    assert.equal(serverList.includes(0x0552), false, 'direction steps must not claim standard mechanical PTZ');
    const writeStatus = await peer.interaction.write({ ...Write(Write.Attribute({ endpoint: 1,
      cluster: MijiaPtzStep, attributes: 'supported', value: true })), abort: loopback.signal });
    assert.equal(writeStatus[0].status, Status.UnsupportedWrite);
    assert.equal(await invoke(0), Status.InvalidInState); assert.equal(moves.length, 0);
    caps = { ...caps, supported: true, available: true };
    await camera.refreshPtzCapabilities();
    for (let i = 0; i < 50 && (await read())[1] !== true; i++) await delay(10);
    const active = await read();
    assert.equal(active[0], true, `Vendor capability read: ${JSON.stringify(active)}`); assert.equal(active[1], true); assert.equal(active[3], 15);
    for (const direction of [0, 1, 2, 3]) assert.equal(await invoke(direction), Status.Success);
    assert.deepEqual(moves, ['up', 'down', 'left', 'right']);
    assert.equal((await read())[1], true, 'capability availability is restored after repeated commands');
    await delay(25);
    assert.equal((await read())[1], true, 'a late busy publication must not overwrite the idle state');
    assert.equal(await invoke(4), Status.ConstraintError); assert.equal(moves.length, 4);
    hold = { entered: defer(), accept: defer() };
    const pending = invoke(0); pending.catch(() => {});
    await boundedWait(hold.entered.promise, 'Held step did not enter backend');
    assert.equal(await boundedWait(invoke(1), 'Concurrent step did not return Busy'), Status.Busy);
    assert.equal(moves.length, 5);
    hold.accept.resolve(); assert.equal(await pending, Status.Success); hold = undefined;
    rejectBackend = true;
    assert.equal(await invoke(2), Status.Failure); rejectBackend = false;
    caps = { ...caps, available: false };
    await camera.refreshPtzCapabilities();
    assert.equal(await invoke(0), Status.InvalidInState); assert.equal(moves.length, 6);
    assert.equal(MIJIA_PTZ_STEP_CLUSTER_ID, 4294048769);
    assert.ok(loopback.counters.mdnsSuppressed > 0, 'mDNS is unavailable throughout this real CASE test');
    assert.ok(loopback.counters.unicastSent > 0);
  } finally {
    hold?.accept.resolve();
    await loopback.close(camera);
    await rm(dir, { recursive: true, force: true });
  }
});
