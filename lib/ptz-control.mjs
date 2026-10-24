import { request as httpRequest } from 'node:http';

const DIRECTIONS = ['up', 'down', 'left', 'right'];
// This exact model's four directions and self-stopping single-step behavior were physically verified.
const VERIFIED_MODELS = new Set(['chuangmi.camera.061a01']);
const REASONS = new Set(['invalid_request', 'ptz_unsupported', 'ptz_unavailable', 'ptz_rejected', 'ptz_timeout', 'ptz_busy', 'query_cancelled']);
const failure = reason => Object.assign(new Error(REASONS.has(reason) ? reason : 'ptz_unavailable'), {
  reason: REASONS.has(reason) ? reason : 'ptz_unavailable',
});
export const validPtzDirection = value => DIRECTIONS.includes(value);
export const ptzModelSupported = model => VERIFIED_MODELS.has(model);
export function ptzCapabilities(model, available = false, supports = ptzModelSupported) {
  const supported = supports(model) === true;
  return { supported, available: available === true, directions: supported ? [...DIRECTIONS] : [],
    relativeStep: supported, zoom: false, absolutePosition: false };
}

/** Authenticated loopback only. Public callers cannot provide endpoints, operation IDs, speed or duration. */
export function requestPtzStep(control, direction, { signal, timeoutMs = 2600, request = httpRequest } = {}) {
  if (!validPtzDirection(direction) || !Number.isInteger(control?.port) || control.port < 1024 || control.port > 65535
    || typeof control?.token !== 'string' || !/^[a-f0-9]{64}$/.test(control.token)) return Promise.reject(failure('invalid_request'));
  return new Promise((resolve, reject) => {
    let child, response, timer, done = false, size = 0;
    const chunks = [];
    const finish = (error, value) => {
      if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', cancelled);
      for (const chunk of chunks) chunk.fill(0);
      error ? reject(error) : resolve(value);
    };
    const cancel = reason => { child?.destroy(); response?.destroy(); finish(failure(reason)); };
    const cancelled = () => cancel('query_cancelled');
    if (signal?.aborted) { finish(failure('query_cancelled')); return; }
    try {
      const body = JSON.stringify({ direction });
      child = request({ hostname: '127.0.0.1', port: control.port, path: '/ptz/move', method: 'POST',
        headers: { Authorization: `Bearer ${control.token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, incoming => {
        response = incoming;
        incoming.on('data', chunk => {
          if (done) return;
          size += chunk.length;
          if (size > 2048) { cancel('ptz_unavailable'); return; }
          chunks.push(chunk);
        });
        incoming.once('error', () => finish(failure('ptz_unavailable')));
        incoming.once('end', () => {
          let value;
          try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { finish(failure('ptz_unavailable')); return; }
          if (incoming.statusCode !== 200) { finish(failure(value?.reason)); return; }
          if (value?.accepted !== true || value.direction !== direction || value.movement !== 'step') { finish(failure('ptz_unavailable')); return; }
          finish(null, { accepted: true, direction, movement: 'step' });
        });
      });
      child.once('error', () => finish(failure('ptz_unavailable')));
      signal?.addEventListener('abort', cancelled, { once: true });
      timer = setTimeout(() => cancel('ptz_timeout'), Math.max(1, Math.min(3000, timeoutMs)));
      child.end(body);
    } catch { cancel('ptz_unavailable'); }
  });
}
