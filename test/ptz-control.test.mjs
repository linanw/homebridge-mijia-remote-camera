import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { ptzCapabilities, validPtzDirection, requestPtzStep } from '../lib/ptz-control.mjs';

const token = 'a'.repeat(64);
async function fixture(t, handler) {
  const calls = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => { calls.push({ path: request.url, method: request.method, authorization: request.headers.authorization, body }); handler?.(request, response); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { calls, control: { port: server.address().port, token } };
}
test('only the exact verified model advertises finite directional steps without zoom or absolute position', () => {
  assert.deepEqual(ptzCapabilities('chuangmi.camera.061a01', true), { supported: true, available: true,
    directions: ['up', 'down', 'left', 'right'], relativeStep: true, zoom: false, absolutePosition: false });
  for (const model of ['chuangmi.camera.061a03', 'unknown.camera', undefined]) {
    assert.deepEqual(ptzCapabilities(model, true), { supported: false, available: true, directions: [], relativeStep: false, zoom: false, absolutePosition: false });
  }
  assert.equal(validPtzDirection('up'), true);
  for (const direction of ['stop', 'zoom', 'left;PRIVATE', '', 1, true, { direction: 'up' }]) assert.equal(validPtzDirection(direction), false);
});
test('private step client uses only authenticated loopback and returns minimal accepted fields', async t => {
  const { calls, control } = await fixture(t, (_request, response) => { response.end(JSON.stringify({ accepted: true, direction: 'left', movement: 'step', ret: 0, private: 'PRIVATE_TOKEN' })); });
  assert.deepEqual(await requestPtzStep(control, 'left'), { accepted: true, direction: 'left', movement: 'step' });
  assert.deepEqual(calls, [{ path: '/ptz/move', method: 'POST', authorization: `Bearer ${token}`, body: '{"direction":"left"}' }]);
  for (const direction of ['stop', 1, '1', 'left\nPRIVATE']) await assert.rejects(requestPtzStep(control, direction), { reason: 'invalid_request' });
  await assert.rejects(requestPtzStep({ ...control, token: 'bad\r\nPRIVATE' }, 'up'), { reason: 'invalid_request' });
  await assert.rejects(requestPtzStep({ ...control, port: 'http://PRIVATE' }, 'up'), { reason: 'invalid_request' });
  assert.equal(calls.length, 1);
});
test('private step client rejects redirects, wrong acknowledgements, raw errors and oversized replies safely', async t => {
  const replies = [
    [302, { reason: 'PRIVATE_TOKEN' }], [503, { reason: 'ptz_rejected', raw: 'PRIVATE' }],
    [200, { accepted: true, direction: 'right', movement: 'step' }], [200, { accepted: false, direction: 'left', movement: 'step' }],
    [200, 'PRIVATE'.repeat(1000)],
  ];
  const { control } = await fixture(t, (_request, response) => { const [status, value] = replies.shift(); response.writeHead(status); response.end(JSON.stringify(value)); });
  for (const reason of ['ptz_unavailable', 'ptz_rejected', 'ptz_unavailable', 'ptz_unavailable', 'ptz_unavailable']) {
    await assert.rejects(requestPtzStep(control, 'left'), error => error.reason === reason && !String(error).includes('PRIVATE'));
  }
});
test('private step client bounds stalled connections and honours cancellation without retry', async t => {
  const { calls, control } = await fixture(t);
  await assert.rejects(requestPtzStep(control, 'up', { timeoutMs: 10 }), { reason: 'ptz_timeout' });
  const abort = new AbortController();
  const pending = requestPtzStep(control, 'left', { signal: abort.signal }); abort.abort();
  await assert.rejects(pending, { reason: 'query_cancelled' });
  assert.ok(calls.length <= 2);
});
