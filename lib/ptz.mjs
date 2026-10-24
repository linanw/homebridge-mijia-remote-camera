const DIRECTIONS = ['up', 'down', 'left', 'right'];
const LABELS = { up: '云台向上', down: '云台向下', left: '云台向左', right: '云台向右' };
const SAFE_REASONS = new Set(['ptz_unsupported', 'ptz_unavailable', 'ptz_rejected', 'ptz_timeout', 'ptz_busy']);

/** Optional Home app controls for a verified, finite camera direction step. */
export async function configurePtz({ api, accessory, runtime, selection, log } = {}) {
  let capabilities;
  try { capabilities = await runtime.getPtzCapabilities(); } catch { return null; }
  if (capabilities?.supported !== true || capabilities.relativeStep !== true
    || !Array.isArray(capabilities.directions) || !DIRECTIONS.every(d => capabilities.directions.includes(d))) return null;
  const expected = selection && { deviceId: selection.deviceId, homeId: selection.homeId, homeOwner: selection.homeOwner };
  let closed = false, busy = false, lastFailure;
  const services = [];
  const hapError = reason => new api.hap.HapStatusError(reason === 'ptz_busy'
    ? api.hap.HAPStatus.RESOURCE_BUSY : api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  for (const direction of DIRECTIONS) {
    const subtype = `mijia-ptz-${direction}`;
    const service = accessory.getServiceById?.(api.hap.Service.Switch, subtype)
      || accessory.addService(api.hap.Service.Switch, LABELS[direction], subtype);
    services.push(service);
    const on = service.getCharacteristic(api.hap.Characteristic.On);
    service.updateCharacteristic(api.hap.Characteristic.On, false);
    on.onGet(() => false);
    on.onSet(async value => {
      if (value === false || value === 0) return;
      if (value !== true && value !== 1) throw hapError('ptz_rejected');
      if (closed) throw hapError('ptz_unavailable');
      if (busy) throw hapError('ptz_busy');
      busy = true;
      try {
        if (expected) {
          const current = await runtime.selected();
          if (closed || !current || Object.keys(expected).some(k => expected[k] !== current[k]))
            throw Object.assign(new Error('ptz_unavailable'), { reason: 'ptz_unavailable' });
        }
        if (closed) throw Object.assign(new Error('ptz_unavailable'), { reason: 'ptz_unavailable' });
        const result = await runtime.movePtz(direction);
        if (result?.accepted !== true || result.direction !== direction)
          throw Object.assign(new Error('ptz_rejected'), { reason: 'ptz_rejected' });
        lastFailure = undefined;
      } catch (error) {
        const reason = SAFE_REASONS.has(error?.reason) ? error.reason : 'ptz_unavailable';
        if (!closed && lastFailure !== reason) { lastFailure = reason; log?.warn?.(`云台控制未完成（${reason}）。`); }
        throw hapError(reason);
      } finally {
        busy = false;
        setImmediate(() => { if (!closed) service.updateCharacteristic(api.hap.Characteristic.On, false); });
      }
    });
  }
  return { shutdown() {
    if (closed) return;
    closed = true;
    for (const service of services) service.updateCharacteristic(api.hap.Characteristic.On, false);
  } };
}
