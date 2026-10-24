import { EventEmitter } from 'node:events';
import { spawn as spawnProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { readFileSync, existsSync, statSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { acquireRuntimeLock } from './process-lock.mjs';
import { ptzCapabilities, ptzModelSupported, validPtzDirection, requestPtzStep } from './ptz-control.mjs';
import { MetadataSync, metadataFingerprint } from './metadata-sync.mjs';

const REGIONS = new Set(['cn', 'ru', 'de', 'sg', 'us', 'i2']);
const REASONS = new Set(['not_selected', 'starting', 'ready', 'stopped', 'retrying', 'connect_timeout',
  'authentication_required', 'session_expired', 'camera_offline', 'camera_not_in_home', 'unsupported_transport',
  'invalid_request', 'invalid_home_selection', 'invalid_home_response', 'missing_home_owner', 'invalid_device_response',
  'device_pagination_incomplete', 'home_request_failed', 'home_request_rejected', 'discovery_failed',
  'backend_failed', 'connection_failed', 'no_video', 'port_in_use', 'runtime_in_use', 'runtime_closed',
  'runtime_unavailable', 'query_timeout', 'query_cancelled', 'invalid_backend_response', 'storage_failed',
  'night_vision_unsupported', 'night_vision_unavailable', 'night_vision_rejected', 'night_vision_not_applied', 'night_vision_timeout',
  'ptz_unsupported', 'ptz_unavailable', 'ptz_rejected', 'ptz_timeout', 'ptz_busy',
  'metadata_unavailable', 'metadata_incomplete', 'metadata_conflict', 'metadata_busy',
  'metadata_unconfirmed', 'metadata_write_unsupported', 'metadata_not_owner', 'metadata_not_applied']);
REASONS.add('auth_in_progress');
const TRANSIENT_CODES = new Set([0, 3, 4, 5, 6]);
const STAGES = ['device_lookup', 'provisioning', 'relay_connect', 'authentication', 'waiting_video'];

export class RuntimeError extends Error {
  constructor(reason, code) {
    const safe = REASONS.has(reason) ? reason : 'backend_failed';
    super(safe); this.name = 'RuntimeError'; this.reason = safe;
    if (Number.isInteger(code) && Math.abs(code) <= 1000000000) this.code = code;
  }
}

function identifier(value) {
  if (typeof value !== 'string' || !/^[0-9]{1,30}$/.test(value)) throw new RuntimeError('invalid_request');
  return BigInt(value).toString();
}
function label(value, fallback = '') {
  return typeof value === 'string' ? value.replace(/[\p{Cc}]/gu, ' ').trim().slice(0, 160) : fallback;
}
function readJson(file, max = 16384) {
  try {
    if (statSync(file).size > max) return null;
    const value = JSON.parse(readFileSync(file, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}
async function atomicJson(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    await fs.rename(temp, file);
  } catch { throw new RuntimeError('storage_failed'); }
  finally { await fs.unlink(temp).catch(() => {}); }
}
async function freePort() {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once('error', () => reject(new RuntimeError('port_in_use')));
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(new RuntimeError('port_in_use')) : resolve(port));
    });
  });
}
function settleAfterClose(child, milliseconds) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise(resolve => {
    const timer = setTimeout(() => { child.off('close', done); resolve(false); }, milliseconds);
    const done = () => { clearTimeout(timer); resolve(true); };
    child.once('close', done);
  });
}
async function terminate(child) {
  if (!child) return;
  const signal = kind => {
    try { process.kill(-child.pid, kind); }
    catch { try { child.kill(kind); } catch {} }
  };
  signal('SIGTERM');
  if (!await settleAfterClose(child, 5000)) signal('SIGKILL');
  await settleAfterClose(child, 1000);
}

/** The single account/transport owner used by both the platform and its custom UI. */
export class RuntimeManager extends EventEmitter {
  constructor({ storagePath, javaPath, jarPath, bridgePath, log, region = 'cn', quality = 1, enableAudio = true, enableTalkback = true, cloudControl,
    spawn = spawnProcess, choosePort = freePort, terminateProcess = terminate, retryDelays = [15000, 30000, 60000],
    connectTimeoutMs = 180000, queryTimeoutMs = 90000, ptzRequest = requestPtzStep, ptzSupported = ptzModelSupported,
    metadataSyncEnabled = true, metadataIntervalMs = 60000, metadataWriteValidated = false } = {}) {
    super();
    if (![storagePath, javaPath, jarPath, bridgePath].every(value => typeof value === 'string' && value.length)) {
      throw new RuntimeError('runtime_unavailable');
    }
    this.storagePath = path.resolve(storagePath);
    this.javaPath = javaPath; this.jarPath = jarPath; this.bridgePath = bridgePath; this.log = log;
    this.selectionFile = path.join(this.storagePath, 'selection.json');
    this.credentialsFile = path.join(this.storagePath, '.micam', 'credentials.json');
    this.lockFile = path.join(this.storagePath, 'runtime-owner.json');
    this.regionFile = path.join(this.storagePath, 'region.json');
    this.metadataSettingsFile = path.join(this.storagePath, 'metadata-sync.json');
    const stored = readJson(this.credentialsFile)?.region ?? readJson(this.regionFile)?.region ?? readJson(this.selectionFile)?.region;
    this.region = REGIONS.has(stored) ? stored : REGIONS.has(region) ? region : 'cn';
    this.quality = Number.isInteger(quality) && quality >= 0 && quality <= 3 ? quality : 1;
    this.enableAudio = enableAudio !== false;
    this.enableTalkback = this.enableAudio && enableTalkback !== false;
    this.audioInfo = null;
    this.audioSeenAt = null;
    this.cloudControl = cloudControl; this.controlRequests = new Set();
    this.metadataWriteValidated = metadataWriteValidated === true;
    this.metadataWriteBusy = false;
    this.ptzRequest = ptzRequest; this.ptzSupported = ptzSupported; this.ptzControl = null; this.ptzBusy = false; this.lastPtzAt = null;
    this.spawn = spawn; this.choosePort = choosePort; this.terminateProcess = terminateProcess;
    this.retryDelays = retryDelays; this.connectTimeoutMs = connectTimeoutMs; this.queryTimeoutMs = queryTimeoutMs;
    this.state = 'idle'; this.reason = 'stopped'; this.ready = false; this.videoReceived = false;
    this.child = null; this.helpers = new Set(); this.retryTimer = null; this.bootTimer = null;
    this.children = new Set();
    this.wantRunning = false; this.closed = false; this.paused = false; this.token = null; this.opening = null;
    this.attempt = 0; this.generation = 0; this.starting = null; this.port = null;
    this.connectionAttempt = 0; this.connectingSince = null; this.retryAt = null;
    this.lastFailure = null; this.lastFailureAt = null; this.stage = null; this.stageIndex = -1;
    this.queryChain = Promise.resolve();
    const metadataSettings = readJson(this.metadataSettingsFile);
    this.metadataSync = new MetadataSync({ getContext: () => this._metadataContext(),
      read: (context, options) => this._readMetadata(context, options), intervalMs: metadataIntervalMs,
      enabled: typeof metadataSettings?.enabled === 'boolean' ? metadataSettings.enabled : metadataSyncEnabled });
    this.metadataSync.on('metadata', value => this.emit('metadata', value));
    this.metadataSync.on('state', () => this.emit('metadata-state', this.metadataStatus()));
    this.exitHandler = () => {
      for (const child of this.children) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      }
    };
    if (spawn === spawnProcess) process.once('exit', this.exitHandler);
  }

  async open() {
    if (this.closed) throw new RuntimeError('runtime_closed');
    if (this.token) return this;
    if (this.opening) return this.opening;
    this.opening = this._open();
    try {
      const result = await this.opening;
      if (this.closed) throw new RuntimeError('runtime_closed');
      return result;
    } finally { this.opening = null; }
  }
  async _open() {
    try { await fs.mkdir(this.storagePath, { recursive: true, mode: 0o700 }); await fs.chmod(this.storagePath, 0o700); }
    catch { throw new RuntimeError('storage_failed'); }
    try {
      this.processLock = await acquireRuntimeLock(this.storagePath);
      this.token = this.processLock.token;
      return this;
    } catch (error) { throw new RuntimeError(error.reason || 'storage_failed'); }
  }

  selected() {
    const value = readJson(this.selectionFile);
    if (!value) return null;
    try {
      return { homeId: identifier(value.homeId), homeOwner: identifier(value.homeOwner), deviceId: identifier(value.deviceId),
        name: label(value.name, '米家摄像头'), model: label(value.model), region: REGIONS.has(value.region) ? value.region : this.region };
    } catch { return null; }
  }
  status() {
    const credentials = readJson(this.credentialsFile);
    const now = Date.now();
    const report = { state: this.state, reason: this.reason, ready: this.ready, videoReceived: this.videoReceived,
      region: this.region, paused: this.paused, selected: Boolean(this.selected()), authenticated: ['ssecurity', 'serviceToken', 'userId']
        .every(key => typeof credentials?.[key] === 'string' && credentials[key].trim()),
      attempt: this.connectionAttempt, stage: this.stage,
      connectingSince: this.connectingSince === null ? null : new Date(this.connectingSince).toISOString(),
      connectingElapsedSeconds: this.connectingSince === null ? 0 : Math.max(0, Math.floor((now - this.connectingSince) / 1000)),
      retryAt: this.retryAt === null ? null : new Date(this.retryAt).toISOString(),
      retryInSeconds: this.retryAt === null ? 0 : Math.max(0, Math.ceil((this.retryAt - now) / 1000)),
      lastFailure: this.lastFailure,
      lastFailureAt: this.lastFailureAt === null ? null : new Date(this.lastFailureAt).toISOString() };
    const audio = this.audioSource();
    report.audio = { enabled: this.enableAudio, received: Boolean(audio), talkbackEnabled: this.enableTalkback,
      ...(audio ? { codec: audio.codec, sampleRate: audio.sampleRate, channels: audio.channels,
        talkbackSupported: this.enableTalkback && Boolean(audio.talkUrl) } : {}) };
    if (this.ready && this.port) report.sourceUrl = `http://127.0.0.1:${this.port}/cam.ts`;
    if (Number.isInteger(this.vendor)) report.vendor = this.vendor;
    return report;
  }
  _state(state, reason, extra = {}) {
    this.state = state; this.reason = REASONS.has(reason) ? reason : 'backend_failed';
    if (state !== 'starting') { this.connectingSince = null; this.stage = null; this.stageIndex = -1; }
    if (state !== 'retrying') this.retryAt = null;
    if (state === 'retrying' || state === 'blocked') {
      this.lastFailure = this.reason; this.lastFailureAt = Date.now();
    }
    if (extra.ready === false) { this.audioInfo = null; this.audioSeenAt = null; this.ptzControl = null; }
    Object.assign(this, extra); this.emit('status', this.status());
  }
  audioSource() {
    if (!this.enableAudio || !this.ready || !this.audioInfo || !this.child
      || this.audioSeenAt === null || Date.now() - this.audioSeenAt > 20000) return undefined;
    return { ...this.audioInfo };
  }
  talkSource() {
    const audio = this.audioSource();
    if (!this.enableTalkback || !audio?.talkUrl) return undefined;
    return { url: audio.talkUrl, format: audio.talkFormat,
      sampleRate: audio.talkSampleRate, channels: audio.talkChannels, codec: audio.codec };
  }
  _resetConnectionDiagnostics() {
    this.attempt = 0; this.connectionAttempt = 0; this.connectingSince = null; this.retryAt = null;
    this.lastFailure = null; this.lastFailureAt = null; this.stage = null; this.stageIndex = -1;
    this.vendor = undefined;
  }
  async setRegion(region) {
    if (!REGIONS.has(region)) throw new RuntimeError('invalid_request');
    this.metadataSync.invalidate();
    await this.open(); await this.stop(); this.region = region;
    await atomicJson(this.regionFile, { region });
    this.metadataSync.schedule();
  }
  async select(value) {
    await this.open();
    const selected = { homeId: identifier(value?.homeId), homeOwner: identifier(value?.homeOwner), deviceId: identifier(value?.deviceId),
      name: label(value?.name, '米家摄像头'), model: label(value?.model), region: REGIONS.has(value?.region) ? value.region : this.region };
    const previous = this.selected();
    const sameCamera = previous && ['homeId', 'homeOwner', 'deviceId', 'region', 'model']
      .every(key => previous[key] === selected[key]);
    this.metadataSync.invalidate();
    if (!sameCamera) await this.stop();
    this.region = selected.region;
    await atomicJson(this.selectionFile, selected);
    this.paused = false;
    if (!sameCamera) this.emit('selection', selected);
    if (this.metadataSync.running) this.metadataSync.start();
    return selected;
  }
  async credentialsChanged() {
    this.metadataSync.invalidate();
    await this.open(); await this.stop();
    const region = readJson(this.credentialsFile)?.region;
    if (REGIONS.has(region)) this.region = region;
    this.paused = false;
    this.emit('credentials');
    if (this.metadataSync.running) this.metadataSync.start();
    return this.status();
  }

  _metadataContext() {
    if (this.closed) throw new RuntimeError('runtime_closed');
    if (this.paused) throw new RuntimeError('auth_in_progress');
    const selected = this.selected();
    if (!selected) throw new RuntimeError('not_selected');
    const credentials = readJson(this.credentialsFile);
    if (!['userId', 'ssecurity', 'serviceToken'].every(key => typeof credentials?.[key] === 'string' && credentials[key].trim())
      || !/^[0-9]{1,30}$/.test(credentials.userId) || credentials.region !== this.region
      || selected.region !== this.region) throw new RuntimeError('authentication_required');
    const accountId = identifier(credentials.userId);
    const identity = ['homeId', 'homeOwner', 'deviceId', 'region', 'model', 'name'].map(key => selected[key]);
    // Session material participates only in a private hash; no key or token is returned or logged.
    const key = createHash('sha256').update(JSON.stringify([accountId, credentials.ssecurity,
      credentials.serviceToken, credentials.region, identity])).digest('hex');
    return { ...selected, accountId, key };
  }
  _readMetadata(context, { signal, guard }) {
    const deadline = Date.now() + 30000;
    const task = () => this._query('get', [context.homeId, context.homeOwner, context.deviceId, context.accountId],
      { mainClass: 'mijia.bridge.CloudMetadata', deadline, signal, guard });
    const result = this.queryChain.then(task, task);
    this.queryChain = result.catch(() => {});
    return result;
  }
  startMetadataSync() { this.metadataSync.start(); }
  metadataStatus() {
    const status = this.metadataSync.status();
    let context;
    try { context = this._metadataContext(); } catch {}
    const selected = this.selected();
    const identity = selected ? createHash('sha256').update(selected.deviceId).digest('hex') : '';
    const writable = this.metadataWriteValidated && context && context.accountId === context.homeOwner;
    return { ...status, identity, capabilities: { read: true, rename: Boolean(writable), move: Boolean(writable), syncConfig: true } };
  }
  refreshMetadata(options) { return this.metadataSync.refresh(options); }
  async updateMetadata({ operation, name, roomId, expectedIdentity, expectedSourceEpoch, expectedRevision } = {}) {
    if (this.closed) throw new RuntimeError('runtime_closed');
    if (this.paused) throw new RuntimeError('auth_in_progress');
    if (!this.metadataWriteValidated) throw new RuntimeError('metadata_write_unsupported');
    if (!['rename', 'move'].includes(operation) || typeof expectedIdentity !== 'string' || !/^[a-f0-9]{64}$/.test(expectedIdentity)
      || expectedSourceEpoch === undefined || expectedRevision === undefined) throw new RuntimeError('invalid_request');
    if (operation === 'rename' && (typeof name !== 'string' || !name.length || name.length > 160
      || !name.isWellFormed() || /[\p{Cc}]/u.test(name) || name.trim() !== name)) throw new RuntimeError('invalid_request');
    if (operation === 'move' && (typeof roomId !== 'string' || !/^(0|[1-9][0-9]{0,29})$/.test(roomId))) throw new RuntimeError('invalid_request');
    const state = this.metadataStatus(), context = this._metadataContext();
    this.metadataSync.checkRevision(expectedRevision, expectedSourceEpoch);
    if (state.identity !== expectedIdentity) throw new RuntimeError('metadata_conflict');
    if (context.accountId !== context.homeOwner) throw new RuntimeError('metadata_not_owner');
    if (!state.metadata) throw new RuntimeError('metadata_unavailable');
    if (operation === 'move' && roomId !== '' && !state.metadata.rooms.some(room => room.id === roomId)) throw new RuntimeError('invalid_request');
    if (this.metadataWriteBusy || this.helpers.size || this.controlRequests.size || this.controlRenewal
      || this.controlVerification || state.loading) throw new RuntimeError('metadata_busy');
    this.metadataWriteBusy = true;
    const baseline = metadataFingerprint(state.metadata);
    try {
      const result = await this.metadataSync.update(async (current, { signal, guard }) => {
        if (!guard() || current.key !== context.key) throw new RuntimeError('query_cancelled');
        // The NAS JVM may decode argv through an ASCII native charset. Keep the
        // transport argument ASCII and decode UTF-8 strictly inside the helper.
        const action = operation === 'rename' ? 'rename64' : operation;
        const target = operation === 'rename' ? Buffer.from(name, 'utf8').toString('base64') : roomId;
        const reply = await this._query(action, [current.homeId, current.homeOwner, current.deviceId, current.accountId,
          baseline, target], { mainClass: 'mijia.bridge.CloudMetadata', timeoutMs: 30000, signal, guard });
        if (reply?.confirmed !== true) throw new RuntimeError('metadata_unconfirmed');
        if (operation === 'rename' ? reply.name !== name : reply.roomId !== roomId) throw new RuntimeError('metadata_not_applied');
        return reply;
      }, { expectedRevision, expectedSourceEpoch });
      return { ...result, confirmed: true };
    } catch (error) {
      if (['query_timeout', 'query_cancelled', 'invalid_backend_response', 'runtime_unavailable'].includes(error?.reason))
        throw new RuntimeError('metadata_unconfirmed');
      throw new RuntimeError(error?.reason);
    } finally { this.metadataWriteBusy = false; }
  }
  setMetadataSync({ enabled, expectedRevision, expectedSourceEpoch } = {}) {
    const task = async () => {
      if (this.closed) throw new RuntimeError('runtime_closed');
      if (this.paused) throw new RuntimeError('auth_in_progress');
      if (typeof enabled !== 'boolean') throw new RuntimeError('invalid_request');
      this.metadataSync.status(); this.metadataSync.checkRevision(expectedRevision, expectedSourceEpoch);
      await this.open();
      if (this.closed) throw new RuntimeError('runtime_closed');
      if (this.paused) throw new RuntimeError('auth_in_progress');
      this.metadataSync.checkRevision(expectedRevision, expectedSourceEpoch);
      const previous = this.metadataSync.enabled;
      this.metadataSync.setEnabled(enabled, expectedRevision, expectedSourceEpoch);
      try { await atomicJson(this.metadataSettingsFile, { enabled }); }
      catch (error) {
        if (!this.closed) this.metadataSync.setEnabled(previous);
        throw error;
      }
      if (this.closed) throw new RuntimeError('runtime_closed');
      return this.metadataStatus();
    };
    const result = (this.metadataMutation || Promise.resolve()).then(task, task);
    this.metadataMutation = result.catch(() => {});
    return result;
  }

  discoverHomes() {
    return this._queuedQuery('homes', []).then(reply => {
      if (!Array.isArray(reply.homes) || reply.homes.length > 1000) throw new RuntimeError('invalid_backend_response');
      return reply.homes.map(home => ({ id: identifier(home.id), ownerId: identifier(home.ownerId), name: label(home.name), shared: home.shared === true }));
    });
  }
  discoverDevices(homeId, homeOwner) {
    const ids = [identifier(homeId), identifier(homeOwner)];
    return this._queuedQuery('devices', ids).then(reply => {
      if (!Array.isArray(reply.devices) || reply.devices.length > 20000) throw new RuntimeError('invalid_backend_response');
      return reply.devices.map(device => ({ deviceId: identifier(device.deviceId), name: label(device.name), model: label(device.model), online: device.online === true }));
    });
  }
  getNightVision() { return this._nightVision(); }
  async getPtzCapabilities() {
    if (this.closed) throw new RuntimeError('runtime_closed');
    if (this.paused) throw new RuntimeError('auth_in_progress');
    const selected = this.selected();
    return ptzCapabilities(selected?.model, Boolean(selected && this.ready && this.child && this.ptzControl), this.ptzSupported);
  }
  async movePtz(direction) {
    if (this.metadataWriteBusy) throw new RuntimeError('metadata_busy');
    if (!validPtzDirection(direction)) throw new RuntimeError('invalid_request');
    if (this.closed) throw new RuntimeError('runtime_closed');
    if (this.paused) throw new RuntimeError('auth_in_progress');
    const selected = this.selected();
    if (!selected) throw new RuntimeError('not_selected');
    if (!this.ptzSupported(selected.model)) throw new RuntimeError('ptz_unsupported');
    if (!this.ready || !this.child || !this.ptzControl) throw new RuntimeError('ptz_unavailable');
    if (this.ptzBusy || this.lastPtzAt !== null && Date.now() - this.lastPtzAt < 1800) throw new RuntimeError('ptz_busy');
    const generation = this.generation, region = this.region, control = this.ptzControl, controller = new AbortController();
    const valid = () => !this.closed && !this.paused && !controller.signal.aborted && this.generation === generation
      && this.region === region && this.ptzControl === control
      && ['homeId', 'homeOwner', 'deviceId', 'model', 'region'].every(key => this.selected()?.[key] === selected[key]);
    let timer; this.ptzBusy = true; this.controlRequests.add(controller);
    try {
      const task = async () => {
        if (!this.cloudControl?.context) throw new RuntimeError('ptz_unavailable');
        await this.cloudControl.context(selected, region);
        if (!valid()) throw new RuntimeError('query_cancelled');
        this.lastPtzAt = Date.now();
        return this.ptzRequest(control, direction, { signal: controller.signal });
      };
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new RuntimeError('ptz_timeout')); }, 3000);
      });
      const reply = await Promise.race([task(), timeout]);
      if (!valid()) throw new RuntimeError('query_cancelled');
      if (reply?.accepted !== true || reply.direction !== direction || reply.movement !== 'step') throw new RuntimeError('ptz_unavailable');
      return { accepted: true, direction, movement: 'step' };
    } catch (error) {
      if (error?.reason === 'session_expired') this._renewControlSession();
      if (error?.capabilityRequired === true && this.ready) this._refreshControlCapability(selected, region);
      const reason = error?.reason?.startsWith('night_vision_') ? 'ptz_unavailable' : error?.reason;
      throw new RuntimeError(REASONS.has(reason) ? reason : 'ptz_unavailable');
    } finally { clearTimeout(timer); controller.abort(); this.controlRequests.delete(controller); this.ptzBusy = false; }
  }
  setNightVision(mode) {
    if (!['on', 'off', 'auto'].includes(mode)) return Promise.reject(new RuntimeError('invalid_request'));
    return this._nightVision(mode);
  }
  _nightVision(mode) {
    if (this.metadataWriteBusy) return Promise.reject(new RuntimeError('metadata_busy'));
    if (this.closed) return Promise.reject(new RuntimeError('runtime_closed'));
    if (this.paused) return Promise.reject(new RuntimeError('auth_in_progress'));
    const controller = new AbortController();
    const selected = this.selected();
    if (!selected) return Promise.reject(new RuntimeError('not_selected'));
    const deadline = Date.now() + 6500, region = this.region, generation = this.generation;
    this.controlRequests.add(controller);
    const valid = () => {
      const current = this.selected();
      return !cancelled && !controller.signal.aborted && this.region === region && this.generation === generation && current
        && ['deviceId', 'homeId', 'homeOwner', 'region'].every(key => current[key] === selected[key]);
    };
    let cancelled = false, timer;
    const task = async () => {
      if (cancelled || Date.now() >= deadline) throw new RuntimeError('query_timeout');
      if (this.closed) throw new RuntimeError('runtime_closed');
      if (this.paused) throw new RuntimeError('auth_in_progress');
      const current = this.selected();
      if (!valid()) throw new RuntimeError('query_cancelled');
      const args = [current.homeId, current.homeOwner, current.deviceId, ...(mode ? [mode] : [])];
      let reply;
      if (this.cloudControl) {
        await this.open();
        if (Date.now() >= deadline) throw new RuntimeError('query_timeout');
        if (!valid() || this.paused || this.closed) throw new RuntimeError('query_cancelled');
        try {
          reply = mode ? await this.cloudControl.setNightVision(current, region, mode, { signal: controller.signal })
            : await this.cloudControl.getNightVision(current, region, { signal: controller.signal });
        } catch (error) {
          if (error?.reason === 'session_expired') this._renewControlSession();
          else if (error?.capabilityRequired === true && this.ready) this._refreshControlCapability(current, region);
          throw error;
        }
      } else reply = await this._query(mode ? 'set' : 'get', args,
        { mainClass: 'mijia.bridge.NightVisionControl', deadline, guard: valid });
      if (!valid()) throw new RuntimeError('query_cancelled');
      if (!['on', 'off', 'auto'].includes(reply?.mode)) throw new RuntimeError('invalid_backend_response');
      this.emit('night-mode', { mode: reply.mode });
      return { mode: reply.mode };
    };
    const result = this.queryChain.then(task, task);
    this.queryChain = result.catch(() => {});
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => { cancelled = true; controller.abort(); reject(new RuntimeError('query_timeout')); }, 6500);
    });
    return Promise.race([result, timeout]).finally(() => { clearTimeout(timer); this.controlRequests.delete(controller); });
  }
  _refreshControlCapability(selected, region) {
    if (this.controlVerification || this.closed || this.paused) return;
    const guard = () => this.region === region && ['homeId', 'homeOwner', 'deviceId'].every(key => this.selected()?.[key] === selected[key]);
    const task = () => this._query('get', [selected.homeId, selected.homeOwner, selected.deviceId], {
      mainClass: 'mijia.bridge.NightVisionControl', timeoutMs: 30000, guard });
    const verification = this.queryChain.then(task, task);
    this.queryChain = verification.catch(() => {});
    this.controlVerification = verification;
    verification.catch(() => {}).finally(() => { if (this.controlVerification === verification) this.controlVerification = null; });
  }
  _renewControlSession() {
    if (this.controlRenewal || this.closed || this.paused) return;
    const task = () => this._query('homes', [], { timeoutMs: 30000 });
    const renewal = this.queryChain.then(task, task);
    this.queryChain = renewal.catch(() => {});
    this.controlRenewal = renewal;
    renewal.catch(() => {}).finally(() => { if (this.controlRenewal === renewal) this.controlRenewal = null; });
  }
  _queuedQuery(action, args) {
    const task = () => this._query(action, args);
    const result = this.queryChain.then(task, task);
    this.queryChain = result.catch(() => {});
    return result;
  }
  _javaArgs(action, args, mainClass = 'mijia.bridge.Bridge') {
    if (!['mijia.bridge.Bridge', 'mijia.bridge.NightVisionControl', 'mijia.bridge.CloudMetadata'].includes(mainClass)) throw new RuntimeError('invalid_request');
    return ['-Xmx256m', `-Duser.home=${this.storagePath}`, '-cp', `${this.jarPath}${path.delimiter}${this.bridgePath}`,
      mainClass, action, this.region, ...args];
  }
  _childOptions() {
    const env = { ...process.env };
    delete env.JAVA_TOOL_OPTIONS; delete env._JAVA_OPTIONS; delete env.JDK_JAVA_OPTIONS;
    return { cwd: this.storagePath, env, stdio: ['ignore', 'pipe', 'ignore'], detached: true };
  }
  async _query(action, args, { mainClass = 'mijia.bridge.Bridge', timeoutMs = this.queryTimeoutMs, deadline = Date.now() + timeoutMs, guard, signal } = {}) {
    if (this.metadataWriteBusy && mainClass !== 'mijia.bridge.CloudMetadata') throw new RuntimeError('metadata_busy');
    if (this.paused) throw new RuntimeError('auth_in_progress');
    await this.open();
    if (this.paused) throw new RuntimeError('auth_in_progress');
    if (this.closed) throw new RuntimeError('runtime_closed');
    if (Date.now() >= deadline) throw new RuntimeError('query_timeout');
    if (signal?.aborted || guard && !guard()) throw new RuntimeError('query_cancelled');
    if (!existsSync(this.credentialsFile)) throw new RuntimeError('authentication_required');
    return new Promise((resolve, reject) => {
      let child;
      try { child = this.spawn(this.javaPath, this._javaArgs(action, args, mainClass), this._childOptions()); }
      catch { reject(new RuntimeError('runtime_unavailable')); return; }
      this.helpers.add(child);
      this.children.add(child); child.once('close', () => this.children.delete(child));
      const chunks = [];
      let bytes = 0, done = false;
      const finish = (error, value) => {
        if (done) return; done = true; clearTimeout(timer); this.helpers.delete(child);
        signal?.removeEventListener('abort', cancel);
        error ? reject(error) : resolve(value);
      };
      const abort = async reason => {
        if (done) return; done = true; clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        try { await this.terminateProcess(child); } catch {}
        this.helpers.delete(child); reject(new RuntimeError(reason));
      };
      const timer = setTimeout(() => { void abort('query_timeout'); }, Math.max(1, deadline - Date.now()));
      const cancel = () => { void abort('query_cancelled'); };
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      child.stdout?.on('data', data => {
        if (done) return;
        let chunk;
        try { chunk = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8'); }
        catch { void abort('invalid_backend_response'); return; }
        bytes += chunk.length;
        if (bytes > 1048576) { void abort('invalid_backend_response'); return; }
        chunks.push(chunk);
      });
      child.once('error', () => finish(new RuntimeError('runtime_unavailable')));
      child.once('close', code => {
        if (done) return;
        let reply;
        try {
          // A multibyte name or room may straddle any stdout chunk. Decode only
          // after every byte has arrived, rejecting truncated or invalid UTF-8.
          const output = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes));
          reply = JSON.parse(output.trim());
        }
        catch { finish(new RuntimeError('invalid_backend_response')); return; }
        if (!reply || typeof reply !== 'object' || Array.isArray(reply)) { finish(new RuntimeError('invalid_backend_response')); return; }
        if (code !== 0 || reply.success !== true) { finish(new RuntimeError(reply.reason, reply.code)); return; }
        finish(null, reply);
      });
    });
  }

  async start() {
    if (this.paused) throw new RuntimeError('auth_in_progress');
    await this.open();
    if (this.paused) throw new RuntimeError('auth_in_progress');
    if (this.ready && this.child) return `http://127.0.0.1:${this.port}/cam.ts`;
    if (this.starting) return this.starting;
    const selection = this.selected();
    if (!selection) { this._state('idle', 'not_selected', { ready: false }); throw new RuntimeError('not_selected'); }
    this.wantRunning = true;
    clearTimeout(this.retryTimer); this.retryTimer = null;
    const generation = ++this.generation;
    this.audioInfo = null; this.audioSeenAt = null;
    this.connectionAttempt++; this.connectingSince = Date.now(); this.stage = null; this.stageIndex = -1;
    this._state('starting', 'starting', { ready: false, videoReceived: false, vendor: undefined });
    const promise = this._start(selection, generation);
    this.starting = promise;
    try { return await promise; }
    finally { if (this.starting === promise) this.starting = null; }
  }
  async _start(selection, generation) {
    try { this.port = await this.choosePort(); }
    catch { this._state('blocked', 'port_in_use'); throw new RuntimeError('port_in_use'); }
    if (!this.wantRunning || generation !== this.generation) throw new RuntimeError('stopped');
    const args = this._javaArgs('stream', [selection.homeId, selection.homeOwner, selection.deviceId, String(this.port), String(this.quality), this.enableAudio ? '1' : '0']);
    return new Promise((resolve, reject) => {
      let child;
      try { child = this.spawn(this.javaPath, args, this._childOptions()); }
      catch { this._state('blocked', 'runtime_unavailable'); reject(new RuntimeError('runtime_unavailable')); return; }
      this.child = child;
      this.children.add(child); child.once('close', () => this.children.delete(child));
      let buffer = '', settled = false, eventFailure = null, timedOut = false, readyAt = null;
      const fail = reason => { if (!settled) { settled = true; reject(new RuntimeError(reason)); } };
      const bootTimer = setTimeout(() => { timedOut = true; void this.terminateProcess(child); }, this.connectTimeoutMs);
      this.bootTimer = bootTimer;
      child.stdout?.on('data', data => {
        buffer += data.toString('utf8');
        if (Buffer.byteLength(buffer) > 16384) { eventFailure = 'invalid_backend_response'; void this.terminateProcess(child); return; }
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          let value;
          try { value = JSON.parse(line); } catch { eventFailure = 'invalid_backend_response'; continue; }
          if (generation !== this.generation || !this.wantRunning) continue;
          if (value?.success === false) {
            eventFailure = REASONS.has(value.reason) ? value.reason : 'backend_failed';
            if (Number.isInteger(value.vendor) && value.vendor >= 0 && value.vendor <= 100) this.vendor = value.vendor;
          } else if (value?.event === 'control_ready' && value.success === true
            && Number.isInteger(value.controlPort) && value.controlPort >= 1024 && value.controlPort <= 65535
            && typeof value.controlToken === 'string' && /^[a-f0-9]{64}$/.test(value.controlToken)) {
            this.ptzControl = { port: value.controlPort, token: value.controlToken };
          } else if (value?.event === 'control_unavailable' && value.success === true) {
            this.ptzControl = null;
          } else if (value?.event === 'audio_ready' && value.success === true && this.enableAudio
            && Number.isInteger(value.audioPort) && value.audioPort >= 1024 && value.audioPort <= 65535
            && ['PCMA', 'OPUS'].includes(value.audioCodec) && [8000, 16000, 48000].includes(value.sampleRate)
            && [1, 2].includes(value.channels)) {
            const format = value.audioCodec === 'PCMA' ? 'wav' : 'ogg';
            const base = `http://127.0.0.1:${value.audioPort}`;
            this.audioInfo = { url: `${base}/audio.${format}`, format,
              codec: value.audioCodec, sampleRate: value.sampleRate, channels: value.channels };
            if ((value.audioCodec === 'PCMA' && value.talkFormat === 's16le' && value.talkPath === '/talk.pcm'
                && value.talkSampleRate === 8000 && value.talkChannels === 1)
              || (value.audioCodec === 'OPUS' && value.talkFormat === 'ogg' && value.talkPath === '/talk.ogg'
                && value.talkSampleRate === 48000 && value.talkChannels === 2)) {
              Object.assign(this.audioInfo, { talkUrl: `${base}${value.talkPath}`, talkFormat: value.talkFormat,
                talkSampleRate: value.talkSampleRate, talkChannels: value.talkChannels });
            }
            this.audioSeenAt = Date.now();
            this.emit('status', this.status());
          } else if (value?.event === 'audio_status' && value.success === true && this.enableAudio) {
            if (value.audioReceived === true && this.audioInfo) this.audioSeenAt = Date.now();
            else if (value.audioReceived === false) this.audioSeenAt = null;
          } else if (value?.event === 'progress' && value.success === true && this.state === 'starting') {
            const index = STAGES.indexOf(value.stage);
            if (index >= 0 && index >= this.stageIndex) {
              this.stage = value.stage; this.stageIndex = index;
              if (Number.isInteger(value.vendor) && value.vendor >= 0 && value.vendor <= 100) this.vendor = value.vendor;
              this.emit('status', this.status());
            }
          } else if (value?.event === 'ready' && value.success === true && value.videoReceived === true
            && value.port === this.port && ['H264', 'H265'].includes(value.codec)) {
            clearTimeout(bootTimer); if (this.bootTimer === bootTimer) this.bootTimer = null;
            readyAt = Date.now();
            this._state('ready', 'ready', { ready: true, videoReceived: true });
            if (!settled) { settled = true; resolve(`http://127.0.0.1:${this.port}/cam.ts`); }
          }
        }
      });
      child.once('error', () => {
        if (generation !== this.generation) { fail('stopped'); return; }
        eventFailure = 'runtime_unavailable';
        this._state('blocked', 'runtime_unavailable', { ready: false }); fail('runtime_unavailable');
      });
      child.once('close', code => {
        clearTimeout(bootTimer); if (this.bootTimer === bootTimer) this.bootTimer = null;
        if (this.child === child) this.child = null;
        if (generation !== this.generation || !this.wantRunning) { fail('stopped'); return; }
        const reason = timedOut ? 'connect_timeout' : eventFailure ?? ({ 1: 'unsupported_transport', 2: 'authentication_required', 4: 'camera_offline', 5: 'no_video', 6: 'port_in_use', 7: 'home_request_failed' }[code] ?? 'connection_failed');
        this.ready = false; fail(reason);
        if (timedOut || TRANSIENT_CODES.has(code)) {
          if (readyAt !== null && Date.now() - readyAt >= 60000) this.attempt = 0;
          const delay = this.retryDelays[Math.min(this.attempt++, this.retryDelays.length - 1)];
          this.retryAt = Date.now() + delay;
          this.retryTimer = setTimeout(() => { this.retryTimer = null; this.retryAt = null; if (this.wantRunning && !this.closed) void this.start().catch(() => {}); }, delay);
          this._state('retrying', reason, { ready: false });
        } else this._state('blocked', reason, { ready: false });
      });
    });
  }
  async ensureReady({ timeoutMs = 3000 } = {}) {
    if (this.paused) throw new RuntimeError('auth_in_progress');
    if (this.ready && this.child) return `http://127.0.0.1:${this.port}/cam.ts`;
    if (this.state === 'blocked') throw new RuntimeError(this.reason);
    let ready, cleanup = () => {};
    if (this.state === 'retrying' && this.retryTimer) {
      // HomeKit requests may wait for the existing retry, but cannot shorten its backoff.
      const generation = this.generation;
      ready = new Promise((resolve, reject) => {
        const status = () => {
          if (this.paused) reject(new RuntimeError('auth_in_progress'));
          else if (this.ready && this.child) resolve(`http://127.0.0.1:${this.port}/cam.ts`);
          else if (this.state === 'blocked' || (this.state === 'retrying' && generation !== this.generation)) reject(new RuntimeError(this.reason));
          else if (!this.wantRunning || this.closed) reject(new RuntimeError('stopped'));
        };
        this.on('status', status);
        cleanup = () => this.off('status', status);
      });
    } else ready = this.start();
    let timer;
    try {
      return await Promise.race([ready, new Promise((_, reject) => { timer = setTimeout(() => reject(new RuntimeError('starting')), Math.min(Math.max(timeoutMs, 1), this.connectTimeoutMs)); })]);
    } finally { clearTimeout(timer); cleanup(); }
  }
  async stop() {
    this.wantRunning = false; this.generation++;
    this.ptzControl = null;
    for (const controller of this.controlRequests) controller.abort();
    this.controlRequests.clear();
    clearTimeout(this.retryTimer); clearTimeout(this.bootTimer); this.retryTimer = null; this.bootTimer = null;
    const child = this.child; this.child = null;
    const helpers = [...this.helpers];
    await Promise.all([this.terminateProcess(child), ...helpers.map(helper => this.terminateProcess(helper))]);
    this.starting = null;
    this._resetConnectionDiagnostics();
    this._state('stopped', 'stopped', { ready: false, videoReceived: false });
  }
  async pause() {
    // Synchronous barrier precedes every await, including any in stop().
    this.paused = true;
    this.metadataSync.suspend();
    await this.stop();
    this._state('paused', 'auth_in_progress', { ready: false });
    return this.status();
  }
  async resume() {
    await this.open(); this.paused = false;
    if (this.metadataSync.running) this.metadataSync.start();
    this._state('idle', 'stopped', { ready: false });
    return this.status();
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.metadataSync.close();
    await this.opening?.catch(() => {});
    await this.metadataMutation?.catch(() => {});
    try { await this.stop(); }
    finally {
      await this.processLock?.release();
      this.processLock = null; this.token = null;
      this.cloudControl?.close?.();
      process.off('exit', this.exitHandler);
    }
  }
}
