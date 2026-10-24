import { createHash } from 'node:crypto';
import path from 'node:path';

import { safeMatterStatus } from './matter-diagnostics.mjs';
export { safeMatterStatus } from './matter-diagnostics.mjs';
const REASONS = new Set(['matter_disabled', 'matter_not_ready', 'matter_start_failed', 'matter_port_in_use',
  'matter_configuration_invalid', 'matter_pairing_unavailable', 'matter_window_failed', 'matter_closed']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const bounded = (value, fallback, min, max) => Number.isInteger(value) && value >= min && value <= max ? value : fallback;
const failure = reason => Object.assign(new Error(REASONS.has(reason) ? reason : 'matter_start_failed'), {
  reason: REASONS.has(reason) ? reason : 'matter_start_failed',
});

/** Optional Matter endpoint. Its failure never prevents the existing HomeKit accessory from starting. */
export class MatterService {
  constructor({ runtime, delegate, config = {}, storagePath, name, serialNumber, deviceFactory, mediaFactory } = {}) {
    this.runtime = runtime; this.delegate = delegate; this.config = config;
    this.storagePath = storagePath; this.name = name; this.serialNumber = serialNumber;
    this.deviceFactory = deviceFactory; this.mediaFactory = mediaFactory;
    this.enabled = config.enableMatter === true; this.state = this.enabled ? 'stopped' : 'disabled';
    this.reason = this.enabled ? undefined : 'matter_disabled'; this.closed = false;
  }
  status() {
    let raw = {}, media;
    try { raw = this.device?.status?.() ?? {}; } catch {}
    try { media = this.media?.status?.(); } catch {}
    return safeMatterStatus({ ...raw, enabled: this.enabled, running: this.state === 'ready' && raw.running === true,
      state: this.state, reason: this.reason, media });
  }
  start() {
    if (this.closed) return Promise.reject(failure('matter_closed'));
    if (!this.enabled) return Promise.resolve(this.status());
    if (this.starting) return this.starting;
    if (this.state === 'ready') return Promise.resolve(this.status());
    this.starting = this._start().finally(() => { this.starting = undefined; });
    return this.starting;
  }
  async _start() {
    this.state = 'starting'; this.reason = undefined;
    try {
      const port = this.config.matterPort ?? 5540;
      const networkInterface = this.config.matterInterface ?? 'eth0';
      if (!Number.isInteger(port) || port < 1024 || port > 65535 || typeof networkInterface !== 'string'
        || !/^[A-Za-z0-9_.:-]{1,40}$/.test(networkInterface) || typeof this.storagePath !== 'string')
        throw failure('matter_configuration_invalid');
      const maxStreams = bounded(this.config.matterMaxStreams, 2, 1, 4);
      const createMedia = this.mediaFactory ?? (await import('./matter-media.mjs')).createMatterMedia;
      if (this.closed) throw failure('matter_closed');
      this.media = await createMedia({ runtime: this.runtime, ffmpegPath: this.runtime.ffmpegPath,
        config: { ...this.config, maxStreams }, snapshotDelegate: this.delegate });
      const createDevice = this.deviceFactory ?? (await import('./matter-device.mjs')).createMatterDevice;
      if (this.closed) throw failure('matter_closed');
      const selected = this.runtime.selected?.();
      const serialNumber = this.serialNumber || `MiCam-${createHash('sha256').update(String(selected?.deviceId || '')).digest('hex').slice(0, 16)}`;
      this.device = await createDevice({ storagePath: path.resolve(this.storagePath), name: this.name,
        serialNumber, networkInterface, port, runtime: this.runtime, media: this.media,
        config: { width: bounded(this.config.maxWidth, 640, 160, 1280) & ~1,
          height: bounded(this.config.maxHeight, 360, 120, 720) & ~1,
          frameRate: bounded(this.config.maxFPS, 12, 1, 25),
          bitRate: bounded(this.config.maxBitrate, 700, 100, 2000) * 1000,
          maxStreams, enableAudio: this.config.enableAudio !== false,
          enableTalkback: this.config.enableAudio !== false && this.config.enableTalkback !== false,
          nightVision: this.config.enableNightVision !== false
            && ['chuangmi.camera.061a01', 'chuangmi.camera.061a03'].includes(selected?.model) } });
      if (this.closed) throw failure('matter_closed');
      await this.device.start();
      if (this.closed) throw failure('matter_closed');
      this.state = 'ready';
      this.statusListener = value => {
        if (value?.ready !== true) void Promise.resolve().then(() => this.device?.closeSessions?.()).catch(() => {});
        void Promise.resolve().then(() => this.device?.refreshPtzCapabilities?.()).catch(() => {});
        void Promise.resolve().then(() => this.device?.refreshMetadataState?.()).catch(() => {});
      };
      this.selectionListener = () => {
        try { void Promise.resolve(this.device?.refreshPtzCapabilities?.({ invalidate: true })).catch(() => {}); } catch {}
        void Promise.resolve().then(() => this.device?.refreshMetadataState?.({ invalidate: true })).catch(() => {});
      };
      this.ptzListener = () => {
        void Promise.resolve().then(() => this.device?.refreshPtzCapabilities?.()).catch(() => {});
      };
      this.runtime.on?.('status', this.statusListener);
      this.runtime.on?.('selection', this.selectionListener);
      this.runtime.on?.('ptz-capabilities', this.ptzListener);
      this.metadataListener = () => {
        void Promise.resolve().then(() => this.device?.refreshMetadataState?.()).catch(() => {});
      };
      this.runtime.on?.('metadata-state', this.metadataListener);
      this.metadataCredentialsListener = () => {
        void Promise.resolve().then(() => this.device?.refreshMetadataState?.({ invalidate: true })).catch(() => {});
      };
      this.runtime.on?.('credentials', this.metadataCredentialsListener);
      return this.status();
    } catch (error) {
      await this._release();
      this.device = this.media = undefined;
      const reason = REASONS.has(error?.reason) ? error.reason
        : error?.code === 'EADDRINUSE' ? 'matter_port_in_use' : 'matter_start_failed';
      this.state = this.closed ? 'stopped' : 'failed'; this.reason = reason;
      throw failure(reason);
    }
  }
  pairing() {
    if (!this.enabled) throw failure('matter_disabled');
    if (this.closed || this.state !== 'ready' || !this.device) throw failure('matter_not_ready');
    const value = this.device.pairing();
    if (!object(value) || typeof value.manualPairingCode !== 'string' || !/^(?:\d{11}|\d{21})$/.test(value.manualPairingCode)
      || typeof value.qrPairingCode !== 'string' || !/^MT:[0-9A-Z.:-]{10,250}$/.test(value.qrPairingCode))
      throw failure('matter_pairing_unavailable');
    return { manualPairingCode: value.manualPairingCode, qrPairingCode: value.qrPairingCode };
  }
  async openCommissioningWindow() {
    if (!this.enabled) throw failure('matter_disabled');
    if (this.closed || this.state !== 'ready' || !this.device) throw failure('matter_not_ready');
    try { await this.device.openCommissioningWindow(); return this.status(); }
    catch { throw failure('matter_window_failed'); }
  }
  async closeCommissioningWindow() {
    if (!this.enabled) throw failure('matter_disabled');
    if (this.closed || this.state !== 'ready' || !this.device?.closeCommissioningWindow) throw failure('matter_not_ready');
    try { await this.device.closeCommissioningWindow(); return this.status(); }
    catch { throw failure('matter_window_failed'); }
  }
  async _release() {
    if (this.statusListener) this.runtime.off?.('status', this.statusListener);
    if (this.selectionListener) this.runtime.off?.('selection', this.selectionListener);
    if (this.ptzListener) this.runtime.off?.('ptz-capabilities', this.ptzListener);
    if (this.metadataListener) {
      this.runtime.off?.('metadata-state', this.metadataListener);
    }
    if (this.metadataCredentialsListener) this.runtime.off?.('credentials', this.metadataCredentialsListener);
    this.statusListener = this.selectionListener = this.ptzListener = this.metadataListener = this.metadataCredentialsListener = undefined;
    for (const value of [this.device, this.media]) { try { await value?.close?.(); } catch {} }
  }
  close() {
    if (this.closing) return this.closing;
    this.closed = true;
    return this.closing = (async () => {
      await this.starting?.catch(() => {});
      await this._release();
      this.device = this.media = undefined; this.state = 'stopped';
    })();
  }
}
