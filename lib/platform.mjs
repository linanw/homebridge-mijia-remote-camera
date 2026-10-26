import { createHash } from 'node:crypto';
import path from 'node:path';
import { MijiaCameraDelegate } from './camera.mjs';
import { configureNightVision } from './night-vision.mjs';
import { configurePtz } from './ptz.mjs';
import { MatterService } from './matter-service.mjs';

export const PLUGIN_NAME = '@linanw/homebridge-mijia-remote-camera';
export const PLATFORM_NAME = 'MijiaRemoteCamera';
// Keep accessories paired by the earlier local package stable after the npm scope change.
const ACCESSORY_UUID_NAMESPACE = 'homebridge-mijia-remote-camera';
const numeric = value => typeof value === 'string' && /^[0-9]{1,30}$/.test(value);
const label = value => typeof value === 'string' && value.trim()
  ? value.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 64).trim() : '米家摄像头';

export class MijiaRemoteCameraPlatform {
  constructor(log, config, api, { runtimeFactory, delegateFactory, matterServiceFactory } = {}) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.runtimeFactory = runtimeFactory;
    this.delegateFactory = delegateFactory || (options => new MijiaCameraDelegate(options));
    this.matterServiceFactory = matterServiceFactory || (options => new MatterService(options));
    this.refreshQueue = Promise.resolve();
    this.stopping = false;
    api.on('didFinishLaunching', () => {
      this.launchPromise = this.launch().catch(error => {
        if (['runtime_components_missing', 'runtime_components_invalid'].includes(error?.reason)) {
          log.error('米家运行组件尚未导入或校验失败。请在插件设置中导入本地组件，详见安装说明。');
        } else log.error('米家摄像头初始化失败，请在插件设置中检查连接。');
      });
    });
    api.on('shutdown', () => {
      void this.shutdown().catch(() => log.error('米家摄像头停止时有资源未能正常释放。'));
    });
  }

  configureAccessory() {
    // This plugin publishes cameras as external accessories, not bridge cache entries.
  }

  async launch() {
    const factory = this.runtimeFactory || (await import('./runtime-factory.mjs')).createRuntime;
    this.runtime = await factory({
      storagePath: path.join(this.api.user.storagePath(), 'mijia-remote-camera'),
      config: this.config, log: this.log,
    });
    this.runtime.mediaDiagnostics = () => this.delegate?.getMediaDiagnostics?.();
    this.runtime.matterStatus = () => this.matter?.status?.() ?? { enabled: this.config.enableMatter === true,
      running: false, state: this.config.enableMatter === true ? 'stopped' : 'disabled' };
    const matterOperation = method => async () => {
      if (!this.matter) throw Object.assign(new Error('matter_not_ready'), { reason: 'matter_not_ready' });
      return this.matter[method]();
    };
    this.runtime.matterPairing = matterOperation('pairing');
    this.runtime.matterOpenWindow = matterOperation('openCommissioningWindow');
    this.runtime.matterCloseWindow = matterOperation('closeCommissioningWindow');
    if (this.stopping) { await this.runtime.stop(); await this.runtime.close?.(); return; }
    this.selectionListener = () => {
      this.refreshQueue = this.refreshQueue.then(() => this.refresh()).catch(() => {
        this.log.error('米家摄像头选择未能生效，请重新打开插件设置。');
      });
    };
    this.runtime.on?.('selection', this.selectionListener);
    this.metadataListener = value => {
      try { this.applyMetadata(value); }
      catch { this.log.warn('摄像头名称暂未更新，稍后会自动重试。'); }
    };
    this.runtime.on?.('metadata', this.metadataListener);
    this.metadataStateListener = () => this.metadataListener(this.runtime.metadataStatus?.()?.metadata);
    this.runtime.on?.('metadata-state', this.metadataStateListener);
    await this.refresh();
  }

  async refresh() {
    if (this.stopping) return;
    const selected = await this.runtime.selected();
    if (this.stopping) return;
    if (!selected || !numeric(selected.deviceId) || !numeric(selected.homeId) || !numeric(selected.homeOwner)) {
      this.delegate?.shutdown();
      this.nightVision?.shutdown?.();
      this.ptz?.shutdown?.();
      await this.matter?.close?.();
      this.log.info('请打开插件设置，登录米家并选择家庭和摄像头。');
      return;
    }
    if (this.deviceId && this.deviceId !== selected.deviceId) {
      this.delegate?.shutdown();
      this.nightVision?.shutdown?.();
      this.ptz?.shutdown?.();
      await this.matter?.close?.();
      this.log.info('已保存新的摄像头选择，请重启 Homebridge 使配件变更生效。');
      return;
    }
    const warm = this.runtime.start?.();
    Promise.resolve(warm).catch(() => this.log.warn('米家远程连接尚未就绪，请在插件设置中查看状态。'));
    if (this.deviceId === selected.deviceId) {
      if (this.delegate?.resume) this.delegate.resume();
      else this.delegate?.reset();
      return;
    }
    const uuid = this.api.hap.uuid.generate(`${ACCESSORY_UUID_NAMESPACE}:${selected.deviceId}`);
    const name = label(this.config.cameraName || selected.name);
    const accessory = new this.api.platformAccessory(name, uuid, this.api.hap.Categories.CAMERA);
    const opaqueId = createHash('sha256').update(selected.deviceId).digest('hex').slice(0, 16);
    accessory.getService(this.api.hap.Service.AccessoryInformation)
      ?.setCharacteristic(this.api.hap.Characteristic.Manufacturer, 'Xiaomi')
      .setCharacteristic(this.api.hap.Characteristic.Model, label(selected.model || '米家远程摄像头'))
      .setCharacteristic(this.api.hap.Characteristic.SerialNumber, `MiCam-${opaqueId}`)
      .setCharacteristic(this.api.hap.Characteristic.FirmwareRevision, '0.4.4');
    this.delegate = this.delegateFactory({ api: this.api, log: this.log, runtime: this.runtime,
      config: this.config, ffmpegPath: this.runtime.ffmpegPath });
    accessory.configureController(this.delegate.controller);
    if (this.delegate.audioCompatibility) this.delegate.controller.setMicrophoneMuted(this.config.enableAudio === false);
    if (this.delegate.talkbackEnabled) this.delegate.controller.setSpeakerMuted(false);
    if (this.config.enableNightVision !== false) this.nightVision = configureNightVision({ api: this.api,
      accessory, runtime: this.runtime, model: selected.model, name: '手动夜视', log: this.log });
    if (this.config.enablePtzSwitches === true) this.ptz = await configurePtz({ api: this.api,
      accessory, runtime: this.runtime, selection: selected, log: this.log });
    if (this.stopping) { this.ptz?.shutdown?.(); this.nightVision?.shutdown?.(); this.delegate?.shutdown(); return; }
    this.api.publishExternalAccessories(PLUGIN_NAME, [accessory]);
    this.accessory = accessory;
    this.deviceId = selected.deviceId;
    this.applyMetadata(this.runtime.metadataStatus?.()?.metadata);
    this.log.info('米家摄像头已发布，请在 Apple 家庭中添加此配件。');
    this.matter = this.matterServiceFactory({ runtime: this.runtime, delegate: this.delegate, config: this.config,
      storagePath: path.join(this.api.user.storagePath(), 'mijia-remote-camera'), name,
      serialNumber: `MiCam-${opaqueId}` });
    this.matterStart = Promise.resolve().then(() => this.stopping ? undefined : this.matter.start()).catch(() => {
      this.log.warn('Matter 摄像头未能启动，请在插件设置中查看 Matter 状态。');
    });
  }

  applyMetadata(value) {
    if (this.stopping || !this.accessory || !value || value.deviceId !== this.deviceId
      || this.runtime.metadataStatus?.()?.enabled === false) return;
    const selected = this.runtime.selected?.();
    if (!selected || ['deviceId', 'homeId', 'homeOwner', 'region'].some(key => selected[key] !== value[key])) return;
    let name = '';
    for (const character of label(value.name)) {
      if (Buffer.byteLength(name + character) > 64) break;
      name += character;
    }
    if (!name) return;
    this.accessory.displayName = name;
    if (this.api.hap.Characteristic.Name) {
      this.accessory.getService(this.api.hap.Service.AccessoryInformation)
        ?.setCharacteristic(this.api.hap.Characteristic.Name, name);
    }
    // HomeKit room assignments and controller aliases are not accessory-side HAP data.
    this.metadata = value;
  }

  async shutdown() {
    if (this.stopping) return;
    this.stopping = true;
    this.delegate?.shutdown();
    this.nightVision?.shutdown?.();
    this.ptz?.shutdown?.();
    this.runtime?.off?.('selection', this.selectionListener);
    this.runtime?.off?.('metadata', this.metadataListener);
    this.runtime?.off?.('metadata-state', this.metadataStateListener);
    await Promise.allSettled([this.matter?.close?.(), this.runtime?.stop?.()]);
    await this.runtime?.close?.();
  }
}
