import { fileURLToPath } from 'node:url';
import { RuntimeManager } from './runtime.mjs';
import { CloudControlClient } from './cloud-control.mjs';
import { BrowserLoginManager } from './auth.mjs';
import { startRpcServer } from './rpc.mjs';
import { resolveRuntimeAssets } from './runtime-assets.mjs';

const REGIONS = new Set(['cn', 'sg', 'de', 'us', 'ru', 'i2']);
const failure = (reason) => Object.assign(new Error(reason), { reason });

export async function createRuntime({ storagePath, config = {}, log }) {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw failure('unsupported_platform');
  const assets = await resolveRuntimeAssets({ storagePath, config });
  const runtime = new RuntimeManager({
    storagePath, config, log, region: config.region || 'cn',
    quality: config.quality ?? 1, cloudControl: new CloudControlClient({ storagePath }),
    metadataSyncEnabled: config.metadataSync !== false,
    // The official protocol and both owner-only operations were verified against
    // the selected camera with independent cloud readback before publication.
    metadataWriteValidated: true,
    enableAudio: config.enableAudio !== false, enableTalkback: config.enableTalkback !== false,
    javaPath: assets.javaPath, jarPath: assets.jarPath, bridgePath: fileURLToPath(new URL('../backend/bridge.jar', import.meta.url)),
  });
  runtime.ffmpegPath = assets.ffmpegPath;
  await runtime.open();
  const auth = new BrowserLoginManager({ storagePath, beforeCommit: () => runtime.pause() });
  return attachServices(runtime, auth, storagePath);
}

export async function attachServices(runtime, auth, storagePath) {
  let authorizing = false, loginId, monitor, monitorPending = false, closing = false;
  let mutations = Promise.resolve();
  const serialize = (operation) => {
    const result = mutations.then(operation, operation);
    mutations = result.catch(() => {});
    return result;
  };
  const release = async () => {
    clearInterval(monitor);
    monitor = undefined;
    await runtime.credentialsChanged();
    authorizing = false;
    loginId = undefined;
    if (!closing && runtime.selected()) runtime.start().catch(() => {});
  };
  const finalize = async () => {
    if (!authorizing || !loginId || closing) return;
    const status = auth.status(loginId);
    if (!['starting', 'waiting'].includes(status.state)) await release();
  };
  let rpc;
  try {
    rpc = await startRpcServer(storagePath, async (method, payload) => {
      if (method === 'status') {
        const status = runtime.status();
        const media = runtime.mediaDiagnostics?.();
        const matter = runtime.matterStatus?.();
        const metadata = runtime.metadataStatus?.();
        return { ...status, ...(media ? { media } : {}), ...(matter ? { matter } : {}), ...(metadata ? { metadata } : {}) };
      }
      if (method === 'metadata.status') return runtime.metadataStatus?.() ?? Promise.reject(failure('metadata_unavailable'));
      if (method === 'matter.pairing') return runtime.matterPairing?.() ?? Promise.reject(failure('matter_not_ready'));
      if (method === 'matter.openWindow') return runtime.matterOpenWindow?.() ?? Promise.reject(failure('matter_not_ready'));
      if (method === 'matter.closeWindow') return runtime.matterCloseWindow?.() ?? Promise.reject(failure('matter_not_ready'));
      if (authorizing && ['homes', 'devices', 'select', 'resume', 'night.get', 'night.set', 'ptz.capabilities', 'ptz.move', 'metadata.refresh', 'metadata.sync', 'metadata.update'].includes(method)) throw failure('auth_in_progress');
      if (method === 'metadata.refresh') return runtime.refreshMetadata({ expectedRevision: payload.expectedRevision, expectedSourceEpoch: payload.expectedSourceEpoch });
      if (method === 'metadata.sync') return runtime.setMetadataSync({ enabled: payload.enabled, expectedRevision: payload.expectedRevision, expectedSourceEpoch: payload.expectedSourceEpoch });
      if (method === 'metadata.update') return runtime.updateMetadata({ operation: payload.operation, name: payload.name, roomId: payload.roomId,
        expectedIdentity: payload.expectedIdentity, expectedSourceEpoch: payload.expectedSourceEpoch, expectedRevision: payload.expectedRevision });
      if (method === 'ptz.capabilities') return runtime.getPtzCapabilities();
      if (method === 'ptz.move') return runtime.movePtz(payload.direction);
      if (method === 'night.get') return runtime.getNightVision();
      if (method === 'night.set') return runtime.setNightVision(payload.mode);
      if (method === 'homes') return runtime.discoverHomes();
      if (method === 'devices') return runtime.discoverDevices(payload.homeId, payload.homeOwner);
      if (method === 'pause') { await runtime.pause(); return { success: true }; }
      if (method === 'resume') {
        await runtime.resume();
        return { success: true };
      }
      if (method === 'select') {
        const previous = runtime.selected();
        await runtime.select(payload);
        return { success: true, selection: runtime.selected(), restartRequired: Boolean(previous && previous.deviceId !== payload.deviceId) };
      }
      if (method === 'auth.start') {
        if (!REGIONS.has(payload.region)) throw failure('invalid_region');
        return serialize(async () => {
          clearInterval(monitor);
          loginId = undefined;
          authorizing = true;
          await runtime.pause();
          try {
            const offer = await auth.start({ region: payload.region });
            loginId = offer.loginId;
            monitor = setInterval(() => {
              if (monitorPending) return;
              monitorPending = true;
              serialize(finalize).catch(() => {}).finally(() => { monitorPending = false; });
            }, 500);
            monitor.unref();
            return offer;
          } catch (error) { await release(); throw error; }
        });
      }
      if (method === 'auth.status') return serialize(async () => {
        const status = auth.status(payload.loginId);
        await finalize();
        return status;
      });
      if (method === 'auth.cancel') return serialize(async () => {
        const status = await auth.cancel(payload.loginId);
        if (authorizing && (!payload.loginId || payload.loginId === loginId)) await release();
        return status;
      });
      throw failure('invalid_request');
    });
  } catch (error) { await runtime.close(); throw error; }
  const close = runtime.close.bind(runtime);
  let closePromise;
  runtime.close = () => closePromise ??= (async () => {
    closing = true;
    clearInterval(monitor);
    // Install the synchronous pause/cancellation barrier before auth/RPC cleanup,
    // while retaining the runtime lock until the old private socket is gone.
    let pausing;
    try { pausing = Promise.resolve(runtime.pause?.()); pausing.catch(() => {}); } catch {}
    await auth.cancel().catch(() => {});
    await rpc.close();
    await pausing?.catch(() => {});
    await close();
  })();
  runtime.startMetadataSync?.();
  return runtime;
}
