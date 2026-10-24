import { isAbsolute } from 'node:path';
import { importRuntimeAssets, resolveRuntimeImportSource } from './runtime-assets.mjs';

const REASONS = new Set(['invalid_request', 'runtime_components_missing', 'runtime_components_invalid',
  'runtime_in_use', 'storage_failed']);
const failed = reason => ({ state: 'error', success: false, reason });

/** One local-only component import, independent of the runtime and its account state. */
export class RuntimeSetupJob {
  #homebridgeStoragePath;
  #importAssets;
  #status = { state: 'idle', success: false };

  constructor({ homebridgeStoragePath, importAssets = importRuntimeAssets } = {}) {
    if (typeof homebridgeStoragePath !== 'string' || !isAbsolute(homebridgeStoragePath)
      || /[\x00-\x1f\x7f]/.test(homebridgeStoragePath) || typeof importAssets !== 'function') {
      throw Object.assign(new Error('storage_failed'), { reason: 'storage_failed' });
    }
    this.#homebridgeStoragePath = homebridgeStoragePath;
    this.#importAssets = importAssets;
  }

  start(request) {
    if (this.#status.state === 'running') return this.safeStatus();
    if (!request || typeof request !== 'object' || Array.isArray(request)
      || Object.keys(request).some(key => key !== 'source') || typeof request.source !== 'string'
      || !request.source || request.source.length > 4096 || /[\x00-\x1f\x7f]/.test(request.source)) {
      this.#status = failed('invalid_request');
      return this.safeStatus();
    }
    this.#status = { state: 'running', success: false };
    // Snapshot the only accepted user input before yielding; mutable request objects cannot change the job.
    const source = request.source;
    void Promise.resolve().then(async () => {
      const localSource = await resolveRuntimeImportSource({ source, homebridgeStoragePath: this.#homebridgeStoragePath });
      const result = await this.#importAssets({ source: localSource, homebridgeStoragePath: this.#homebridgeStoragePath });
      if (result?.success !== true) throw new Error('setup_failed');
      this.#status = { state: 'complete', success: true, alreadyInstalled: result?.alreadyInstalled === true };
    }).catch(error => {
      // Raw filesystem/import errors can contain local paths, credentials, or vendor diagnostics.
      let reason;
      try { if (REASONS.has(error?.reason)) reason = error.reason; } catch {}
      this.#status = failed(reason || 'setup_failed');
    });
    return this.safeStatus();
  }

  safeStatus() { return { ...this.#status }; }
}
