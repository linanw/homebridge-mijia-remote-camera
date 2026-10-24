import { ControllerBehavior, Environment, MemoryBlobStorageDriver, MemoryStorageDriver, Millis,
  ServerNode, StorageService } from '@matter/main';
import { NodeJsNetwork } from '@matter/nodejs';
import { PeerSet, SessionManager } from '@matter/main/protocol';

// This pinned-SDK adapter supplies the already-known synthetic camera address to
// the new operational peer. forDescriptor() supplies it only to PASE; depending
// on mDNS to rediscover it makes CASE depend on the runner's multicast routing.
const { NodeJsUdpSocket } = await import(new URL('./net/NodeJsUdpSocket.js', import.meta.resolve('@matter/nodejs')));

export async function createCaseController(id) {
  const env = new Environment(id, Environment.default);
  env.vars.set('mdns.networkInterface', 'lo');
  const storage = new StorageService(env);
  storage.registerDriver(MemoryStorageDriver); storage.defaultDriver = 'memory';
  storage.registerBlobDriver(MemoryBlobStorageDriver); storage.defaultBlobDriver = 'memory-blob';
  return ServerNode.create(ServerNode.RootEndpoint.with(ControllerBehavior), {
    id, environment: env,
    network: { port: 0, ble: false, listeningAddressIpv4: '127.0.0.1', listeningAddressIpv6: '::1' },
    controller: { adminFabricLabel: 'Isolated CASE test' }, commissioning: { enabled: false },
  });
}

export function installCaseLoopback({ port, signal, deadlineMs = 20000, operationalPort = port }) {
  const original = {
    getIpMac: NodeJsNetwork.prototype.getIpMac,
    getNetInterfaces: NodeJsNetwork.prototype.getNetInterfaces,
    connectTcp: NodeJsNetwork.prototype.connectTcp,
    send: NodeJsUdpSocket.prototype.send,
  };
  const abort = new AbortController(), protocolPeers = new Set();
  const counters = { mdnsSuppressed: 0, unicastSent: 0, operationalSent: 0, operationalPeers: 0 };
  let controller, removePeerListener, stopping;
  const cause = new Error('Synthetic CASE test stopped');
  const stop = () => {
    abort.abort(cause);
    // Commissioning's abort option cancels PASE only. Close the operational
    // peers themselves to abort CASE and then force-close all remaining sessions.
    // disconnect() alone permits Peer.connect() to start another attempt.
    return stopping ??= (async () => {
      await Promise.allSettled([...protocolPeers].map(peer => peer.close()));
      if (controller) await controller.env.get(SessionManager).closeAllSessions();
    })();
  };
  const onAbort = () => { stop().catch(() => {}); };
  const timer = setTimeout(onAbort, deadlineMs);
  signal?.addEventListener('abort', onAbort, { once: true });

  NodeJsNetwork.prototype.getIpMac = name => name === 'lo'
    ? { mac: '02:00:00:00:00:01', ipV4: ['127.0.0.1'], ipV6: [] } : undefined;
  NodeJsNetwork.prototype.getNetInterfaces = () => [{ name: 'lo', type: 2 }];
  NodeJsNetwork.prototype.connectTcp = function (host, targetPort, options) {
    if (/^fe[89ab][0-9a-f]*:.*%lo$/i.test(host)) host = '::1';
    if (host !== '127.0.0.1' && host !== '::1') throw new Error('Non-loopback CASE test TCP address');
    return original.connectTcp.call(this, host, targetPort, options);
  };
  NodeJsUdpSocket.prototype.send = function (host, targetPort, data) {
    // No multicast packets reach the kernel: both positive tests must complete
    // real PASE, CASE and encrypted TLV with discovery unavailable.
    if (targetPort === 5353) { counters.mdnsSuppressed++; return Promise.resolve(); }
    if (host !== '127.0.0.1' && host !== '::1') throw new Error('Non-loopback CASE test UDP address');
    counters.unicastSent++;
    if (targetPort === operationalPort) counters.operationalSent++;
    return original.send.call(this, host, targetPort, data);
  };

  return {
    signal: abort.signal, counters, protocolPeers,
    commissionOptions: { abort: abort.signal, timeout: Millis(10000), caseConnectionTimeout: Millis(10000) },
    attach(node) {
      controller = node;
      const peers = node.env.get(PeerSet);
      peers.timing = { defaultConnectionTimeout: Millis(10000) };
      const pin = peer => {
        protocolPeers.add(peer); counters.operationalPeers++;
        const address = { type: 'udp', ip: '127.0.0.1', port: operationalPort };
        peer.descriptor.operationalAddress = address;
        peer.service.addresses.add(address);
        peer.service.status.isReachable = true;
        if (abort.signal.aborted) peer.close().catch(() => {});
      };
      peers.added.on(pin); removePeerListener = () => peers.added.off(pin);
      for (const peer of peers) pin(peer);
      if (signal?.aborted || abort.signal.aborted) onAbort();
    },
    async reconnect() {
      for (const peer of protocolPeers) {
        await peer.disconnect(new Error('Synthetic CASE reconnect'));
        peer.service.addresses.replace([]);
        peer.service.status.isReachable = true;
      }
    },
    stop,
    async close(camera) {
      clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
      try {
        try { await stop(); }
        finally { await controller?.close(); }
      } finally {
        try { await camera?.close(); }
        finally {
          removePeerListener?.();
          NodeJsNetwork.prototype.getIpMac = original.getIpMac;
          NodeJsNetwork.prototype.getNetInterfaces = original.getNetInterfaces;
          NodeJsNetwork.prototype.connectTcp = original.connectTcp;
          NodeJsUdpSocket.prototype.send = original.send;
        }
      }
    },
  };
}
