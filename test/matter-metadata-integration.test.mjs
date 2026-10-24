import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { ControllerBehavior, Environment, MemoryBlobStorageDriver, MemoryStorageDriver, ServerNode, StorageService } from '@matter/main';
import { NodeJsNetwork } from '@matter/nodejs';
import { Invoke, Read, Write } from '@matter/main/protocol';
import { Status } from '@matter/main/types';
import { BasicInformation } from '@matter/main/clusters/basic-information';
import { createMatterDevice } from '../lib/matter-device.mjs';
import { MijiaMetadata, MatterMetadataControl } from '../lib/matter-metadata-cluster.mjs';

async function freePort() {
  const socket = createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve)); return port;
}

// Real PASE, CASE and encrypted TLV on loopback, synthetic Xiaomi metadata only.
test('camera metadata cluster publishes typed snapshots and guarded explicit commands over CASE', { timeout: 30000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mijia-meta-case-'));
  const getIpMac = NodeJsNetwork.prototype.getIpMac, getNetInterfaces = NodeJsNetwork.prototype.getNetInterfaces;
  const connectTcp = NodeJsNetwork.prototype.connectTcp;
  NodeJsNetwork.prototype.getIpMac = function (name) {
    const result = getIpMac.call(this, name);
    return result && name === 'lo' ? { ...result, mac: '02:00:00:00:00:01', ipV6: [] } : result;
  };
  NodeJsNetwork.prototype.getNetInterfaces = () => [{ name: 'lo', type: 2 }];
  NodeJsNetwork.prototype.connectTcp = function (host, port, options) {
    return connectTcp.call(this, /^fe[89ab][0-9a-f]*:.*%lo$/i.test(host) ? '::1' : host, port, options);
  };
  let camera, controller, peer, mutations = 0, refreshes = 0;
  const selected = { deviceId: '803', homeId: '202', homeOwner: '123', region: 'cn' };
  const identity = createHash('sha256').update(selected.deviceId).digest('hex');
  const sourceEpoch = randomUUID();
  const status = { sourceEpoch, revision: 1, enabled: true, loading: false, lastError: null,
    capabilities: { read: true, rename: false, move: false, syncConfig: true },
    metadata: { ...selected, sourceEpoch, revision: 1, name: '云端摄像头', homeName: '家', roomId: '4', roomName: '客厅',
      observedAt: new Date().toISOString(), rooms: [{ id: '4', name: '客厅' }, { id: '5', name: '卧室' }] } };
  const runtime = { selected: () => selected, metadataStatus: () => structuredClone(status),
    async refreshMetadata() { refreshes++; return structuredClone(status.metadata); },
    async setMetadataSync({ enabled }) { status.enabled = enabled; status.revision++; status.metadata.revision = status.revision; return structuredClone(status); },
    async updateMetadata({ operation, name, roomId }) {
      mutations++; status.revision++; status.metadata.revision = status.revision;
      if (operation === 'rename') status.metadata.name = name;
      else { status.metadata.roomId = roomId; status.metadata.roomName = '卧室'; }
      return { ...structuredClone(status.metadata), confirmed: true };
    } };
  try {
    const port = await freePort();
    camera = await createMatterDevice({ storagePath: dir, name: 'Synthetic metadata', serialNumber: 'metadata-case',
      networkInterface: 'lo', port, runtime, media: { async createSession() {}, async closeSession() {}, setMicrophoneMuted() {}, setMicrophoneVolume() {} },
      config: { listeningAddressIpv4: '127.0.0.1', listeningAddressIpv6: '::1' } });
    await camera.start();
    const env = new Environment('metadata-controller', Environment.default);
    env.vars.set('mdns.networkInterface', 'lo');
    const storage = new StorageService(env);
    storage.registerDriver(MemoryStorageDriver); storage.defaultDriver = 'memory';
    storage.registerBlobDriver(MemoryBlobStorageDriver); storage.defaultBlobDriver = 'memory-blob';
    controller = await ServerNode.create(ServerNode.RootEndpoint.with(ControllerBehavior), {
      id: 'metadata-controller', environment: env, network: { port: 0, ble: false, listeningAddressIpv4: '127.0.0.1', listeningAddressIpv6: '::1' },
      controller: { adminFabricLabel: 'Isolated metadata test' }, commissioning: { enabled: false },
    });
    await controller.start();
    peer = await controller.peers.forDescriptor({ addresses: [{ type: 'udp', ip: '127.0.0.1', port }] });
    await peer.commission({ pairingCode: camera.pairing().manualPairingCode, autoSubscribe: false, autoStateInitialize: false, onAttestationFailure: true });
    async function read() {
      const result = {};
      for await (const chunk of peer.interaction.read({ ...Read(Read.Attribute({ endpoint: 1, cluster: MijiaMetadata })), includeKnownVersions: true })) {
        for await (const item of chunk) if (item.kind === 'attr-value') result[item.path.attributeId] = item.value;
      }
      return result;
    }
    async function invoke(command, extra = {}) {
      const request = Invoke({ endpoint: 1, cluster: MijiaMetadata, command, fields: {
        expectedIdentity: identity, expectedSourceEpoch: sourceEpoch, expectedRevision: status.revision, ...extra } });
      request.batchDuration = false;
      for await (const chunk of peer.interaction.invoke(request)) for (const item of chunk) if (item.kind === 'cmd-status') return item.status;
      assert.fail('No metadata status');
    }
    async function nodeLabel() {
      for await (const chunk of peer.interaction.read({ ...Read(Read.Attribute({ endpoint: 0, cluster: BasicInformation,
        attributes: ['nodeLabel'] })), includeKnownVersions: true })) {
        for await (const item of chunk) if (item.kind === 'attr-value') return item.value;
      }
    }
    const initial = await read();
    assert.equal(initial[0][0], identity); assert.equal(initial[0][1], sourceEpoch);
    assert.equal(initial[0][3], '云端摄像头'); assert.equal(initial[0][7], '客厅');
    assert.equal(initial[1].length, 2); assert.equal(initial[2][1], false); assert.equal(initial[4], true);
    assert.equal(await nodeLabel(), '云端摄像头');
    assert.deepEqual(initial[0xfff9], [0, 1, 2, 3]);
    const originalRooms = status.metadata.rooms;
    status.metadata.rooms = [...originalRooms, ...Array.from({ length: 120 }, (_, index) => ({
      id: String(1000 + index), name: `房间${index} ${'资料'.repeat(8)}` }))];
    await camera.refreshMetadataState();
    assert.equal((await read())[1].length, 122, 'room lists survive actual interaction-model report chunking');
    status.metadata.rooms = originalRooms; await camera.refreshMetadataState();
    assert.equal(JSON.stringify(initial).includes(`"${selected.deviceId}"`), false);
    const denied = await peer.interaction.write(Write(Write.Attribute({ endpoint: 1, cluster: MijiaMetadata,
      attributes: 'snapshot', value: new MatterMetadataControl({ runtime }).state().snapshot })));
    assert.equal(denied[0].status, Status.UnsupportedWrite);
    assert.equal(await invoke('refreshMetadata'), Status.Success); assert.equal(refreshes, 1);
    assert.equal(await invoke('renameDevice', { name: '不应写回' }), Status.InvalidInState); assert.equal(mutations, 0);
    assert.equal(await invoke('setSyncEnabled', { enabled: false }), Status.Success);
    assert.equal((await read())[3], false);
    // A standard root NodeLabel write is local Matter state and has no cloud-write handler.
    const label = await peer.interaction.write(Write(Write.Attribute({ endpoint: 0, cluster: BasicInformation, attributes: 'nodeLabel', value: 'Controller alias' })));
    assert.equal(label[0].status, Status.Success); assert.equal(mutations, 0);
    status.capabilities.rename = status.capabilities.move = true;
    await camera.refreshMetadataState();
    assert.equal(await invoke('renameDevice', { name: '已确认新名' }), Status.Success);
    assert.equal(await invoke('moveDevice', { roomId: '5' }), Status.Success);
    const changed = await read();
    assert.equal(changed[0][3], '已确认新名'); assert.equal(changed[0][7], '卧室'); assert.equal(mutations, 2);
    assert.equal(await nodeLabel(), 'Controller alias', 'disabled automatic sync preserves a controller label');
    assert.equal(await invoke('setSyncEnabled', { enabled: true }), Status.Success);
    assert.equal(await nodeLabel(), '已确认新名', 'reenabling sync applies the existing confirmed cloud snapshot');
    assert.equal(await invoke('refreshMetadata', { expectedSourceEpoch: randomUUID() }), Status.InvalidInState);
    assert.equal(refreshes, 1);
  } finally {
    try { await peer?.decommission(); } catch {}
    await controller?.close(); await camera?.close();
    NodeJsNetwork.prototype.getIpMac = getIpMac; NodeJsNetwork.prototype.getNetInterfaces = getNetInterfaces;
    NodeJsNetwork.prototype.connectTcp = connectTcp;
    await rm(dir, { recursive: true, force: true });
  }
});
