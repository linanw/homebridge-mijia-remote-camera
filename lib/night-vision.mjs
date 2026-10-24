const MODES = new Set(['on', 'off', 'auto']);
const MODELS = new Set(['chuangmi.camera.061a01', 'chuangmi.camera.061a03']);
const REASONS = new Set(['night_vision_unsupported', 'night_vision_unavailable', 'night_vision_rejected',
  'night_vision_not_applied', 'night_vision_timeout', 'authentication_required', 'session_expired',
  'auth_in_progress', 'not_selected', 'operation_timeout', 'query_timeout', 'runtime_closed']);
const failure = value => Object.assign(new Error('夜视控制暂不可用。'), {
  reason: REASONS.has(value?.reason ?? value) ? (value?.reason ?? value) : 'night_vision_unavailable',
});

export const supportsNightVision = model => MODELS.has(model);

/** Reads real camera policy. Registration/polling never changes that policy. */
export class NightVisionManager {
  constructor({ getMode, setMode, setModeSwitch, cacheMs = 10000, pollIntervalMs = 60000, timeoutMs = 7200,
    now = Date.now, onChange, onFailure } = {}) {
    if (typeof getMode !== 'function' || typeof setMode !== 'function') throw failure();
    this.getMode = getMode;
    this.setMode = setMode;
    this.setModeSwitch = setModeSwitch;
    this.cacheMs = cacheMs;
    this.pollIntervalMs = pollIntervalMs;
    this.timeoutMs = timeoutMs;
    this.now = now;
    this.onChange = onChange;
    this.onFailure = onFailure;
    this.mode = null;
    this.updatedAt = null;
    this.lastFailure = null;
    this.closed = false;
    this.generation = 0;
    this.readPromise = null;
    this.mutations = Promise.resolve();
  }

  status() {
    return { supported: true, mode: this.mode, enabled: this.mode === null ? null : this.mode !== 'off',
      updatedAt: this.updatedAt === null ? null : new Date(this.updatedAt).toISOString(),
      lastFailure: this.lastFailure };
  }

  async operation(fn) {
    if (this.closed) throw failure('runtime_closed');
    let timer;
    try {
      const result = await Promise.race([Promise.resolve().then(fn), new Promise((_, reject) => {
        timer = setTimeout(() => reject(failure('night_vision_timeout')), this.timeoutMs);
        timer.unref?.();
      })]);
      if (this.closed) throw failure('runtime_closed');
      if (!result || !MODES.has(result.mode)) throw failure();
      return result.mode;
    } catch (error) {
      const safe = failure(error);
      this.lastFailure = safe.reason;
      try { this.onFailure?.(safe.reason); } catch {}
      throw safe;
    } finally { clearTimeout(timer); }
  }

  accept(mode) {
    this.mode = mode;
    this.updatedAt = this.now();
    this.lastFailure = null;
    try { this.onChange?.(this.status()); } catch {}
    return this.status();
  }

  observe(mode) {
    if (this.closed || !MODES.has(mode)) return;
    ++this.generation;
    return this.accept(mode);
  }

  async get({ force = false } = {}) {
    await this.mutations;
    if (this.closed) throw failure('runtime_closed');
    if (!force && this.mode !== null && this.now() - this.updatedAt < this.cacheMs) return this.status();
    if (this.readPromise) return this.readPromise;
    const generation = this.generation;
    const pending = this.operation(() => this.getMode()).then(async mode => {
      if (generation === this.generation) return this.accept(mode);
      await this.mutations;
      if (this.closed) throw failure('runtime_closed');
      if (this.mode === null) throw failure(this.lastFailure);
      return this.status();
    });
    this.readPromise = pending;
    try { return await pending; }
    finally { if (this.readPromise === pending) this.readPromise = null; }
  }

  enqueue(fn) {
    const operation = this.mutations.then(async () => {
      if (this.closed) throw failure('runtime_closed');
      ++this.generation;
      return fn();
    });
    this.mutations = operation.catch(() => {});
    return operation;
  }

  async write(mode) {
    const confirmed = await this.operation(async () => {
      const result = await this.setMode(mode);
      if (result?.mode !== mode) throw failure('night_vision_not_applied');
      return result;
    });
    return this.accept(confirmed);
  }

  set(mode) {
    if (!MODES.has(mode)) return Promise.reject(failure('night_vision_rejected'));
    return this.enqueue(() => this.write(mode));
  }

  setEnabled(enabled) {
    if (typeof enabled !== 'boolean') return Promise.reject(failure('night_vision_rejected'));
    return this.enqueue(async () => {
      if (this.mode === null || this.now() - this.updatedAt >= this.cacheMs) {
        this.accept(await this.operation(() => this.getMode()));
      }
      // Home can repeat an On write while reading/subscribing. Keep an existing Auto policy.
      if ((this.mode !== 'off') === enabled) return this.status();
      return this.write(enabled ? 'on' : 'off');
    });
  }

  setModeEnabled(mode, enabled) {
    if (!['on', 'auto'].includes(mode) || typeof enabled !== 'boolean')
      return Promise.reject(failure('night_vision_rejected'));
    if (typeof this.setModeSwitch !== 'function') return Promise.reject(failure());
    return this.enqueue(async () => {
      const confirmed = await this.operation(async () => {
        const result = await this.setModeSwitch(mode, enabled);
        if (enabled ? result?.mode !== mode : result?.mode === mode)
          throw failure('night_vision_not_applied');
        return result;
      });
      return this.accept(confirmed);
    });
  }

  start() {
    if (this.closed || this.timer) return;
    void this.get({ force: true }).catch(() => {});
    this.timer = setInterval(() => { void this.get({ force: true }).catch(() => {}); }, this.pollIntervalMs);
    this.timer.unref?.();
  }

  shutdown() {
    this.closed = true;
    ++this.generation;
    clearInterval(this.timer);
    this.timer = null;
  }
}

/** Separate manual and automatic policy switches; neither reports the live IR-lamp state. */
export function configureNightVision({ api, accessory, runtime, model, name = '手动夜视', log,
  cacheMs, pollIntervalMs, timeoutMs } = {}) {
  if (!supportsNightVision(model)) return null;
  const controls = [
    { mode: 'on', name, subtype: 'mijia-night-vision' },
    { mode: 'auto', name: '自动夜视', subtype: 'mijia-night-vision-auto' },
  ].map(control => {
    const service = accessory.getServiceById?.(api.hap.Service.Switch, control.subtype)
      || accessory.addService(api.hap.Service.Switch, control.name, control.subtype);
    service.displayName = control.name;
    service.updateCharacteristic(api.hap.Characteristic.Name, control.name);
    if (!service.testCharacteristic(api.hap.Characteristic.ConfiguredName))
      service.addOptionalCharacteristic(api.hap.Characteristic.ConfiguredName);
    const configuredName = service.getCharacteristic(api.hap.Characteristic.ConfiguredName);
    if (typeof configuredName.value !== 'string' || !configuredName.value.trim())
      configuredName.updateValue(control.name);
    return { ...control, service, on: service.getCharacteristic(api.hap.Characteristic.On) };
  });
  let lastLoggedFailure;
  const manager = new NightVisionManager({
    getMode: () => runtime.getNightVision(),
    setMode: mode => runtime.setNightVision(mode),
    setModeSwitch: (mode, enabled) => runtime.setNightVisionSwitch(mode, enabled),
    cacheMs, pollIntervalMs, timeoutMs,
    onChange: status => {
      lastLoggedFailure = null;
      for (const control of controls)
        control.service.updateCharacteristic(api.hap.Characteristic.On, status.mode === control.mode);
    },
    onFailure: reason => {
      if (reason !== lastLoggedFailure) {
        lastLoggedFailure = reason;
        log?.warn?.(`夜视控制暂不可用（${reason}）。`);
      }
    },
  });
  const hapFailure = () => new api.hap.HapStatusError(api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  for (const control of controls) {
    control.on.onGet(async () => {
      try { return (await manager.get()).mode === control.mode; } catch { throw hapFailure(); }
    });
    control.on.onSet(async value => {
      try { await manager.setModeEnabled(control.mode, value); } catch { throw hapFailure(); }
    });
  }
  const observed = value => manager.observe(value?.mode);
  runtime.on?.('night-mode', observed);
  const shutdown = manager.shutdown.bind(manager);
  manager.shutdown = () => { runtime.off?.('night-mode', observed); shutdown(); };
  manager.start();
  return manager;
}
