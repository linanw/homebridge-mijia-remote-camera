import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createMatterDevice } from '../lib/matter-device.mjs';
import { createCaseController, installCaseLoopback } from './helpers/matter-case-loopback.mjs';

async function freePort() {
  const socket = createServer();
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}

test('a deadline aborts an unreachable real CASE transition and closes its sessions promptly', { timeout: 20000 }, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mijia-case-abort-'));
  const port = await freePort();
  let operationalPort;
  do { operationalPort = await freePort(); } while (operationalPort === port);
  const deadline = new AbortController();
  const loopback = installCaseLoopback({ port, operationalPort, signal: AbortSignal.any([t.signal, deadline.signal]) });
  let camera, controller, commissioning;
  try {
    camera = await createMatterDevice({ storagePath: dir, name: 'Synthetic unreachable CASE', serialNumber: 'case-abort',
      networkInterface: 'lo', port,
      media: { async createSession() {}, async closeSession() {}, setMicrophoneMuted() {}, setMicrophoneVolume() {} },
      config: { listeningAddressIpv4: '127.0.0.1', listeningAddressIpv6: '::1' } });
    await camera.start();
    controller = await createCaseController('unreachable-case-controller');
    loopback.attach(controller); await controller.start();
    const peer = await controller.peers.forDescriptor({ addresses: [{ type: 'udp', ip: '127.0.0.1', port }] });
    commissioning = peer.commission({ ...loopback.commissionOptions, pairingCode: camera.pairing().manualPairingCode,
      autoSubscribe: false, autoStateInitialize: false, onAttestationFailure: true });
    commissioning.catch(() => {});
    const started = Date.now();
    while (!loopback.counters.operationalSent) {
      assert.ok(Date.now() - started < 10000, 'PASE did not send a real operational CASE handshake');
      await delay(10, undefined, { signal: t.signal });
    }
    await delay(100, undefined, { signal: t.signal });
    assert.ok([...loopback.protocolPeers].every(peer => !peer.hasSession), 'unreachable CASE cannot establish a session');
    const abortedAt = Date.now();
    deadline.abort();
    await assert.rejects(commissioning);
    await loopback.stop();
    assert.ok(Date.now() - abortedAt < 3000, 'CASE cancellation must settle instead of retaining the 255-second reconnect');
    assert.equal(loopback.signal.aborted, true);
    assert.ok([...loopback.protocolPeers].every(peer => !peer.hasSession));
  } finally {
    await loopback.close(camera);
    await rm(dir, { recursive: true, force: true });
  }
});
