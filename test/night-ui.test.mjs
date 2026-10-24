import assert from 'node:assert/strict';
import test from 'node:test';
import { createUiHandlers } from '../homebridge-ui/server.js';

test('night UI routes forward only a read request or an explicit validated camera policy', async () => {
  const calls = [];
  const routes = createUiHandlers({ request: async (method, payload) => { calls.push({ method, payload }); return { mode: payload.mode || 'auto' }; } });
  assert.deepEqual(await routes['/night/get']({ mode: 'on', did: 'PRIVATE_DEVICE' }), { mode: 'auto' });
  for (const mode of ['on', 'off', 'auto']) assert.deepEqual(await routes['/night/set']({ mode, did: 'PRIVATE_DEVICE', command: 'PRIVATE_COMMAND' }), { mode });
  assert.deepEqual(calls, [{ method: 'night.get', payload: {} },
    { method: 'night.set', payload: { mode: 'on' } }, { method: 'night.set', payload: { mode: 'off' } }, { method: 'night.set', payload: { mode: 'auto' } }]);
  for (const payload of [undefined, {}, { mode: true }, { mode: 0 }, { mode: ['on'] }, { mode: 'toggle' }, { mode: ' on' }]) {
    await assert.rejects(routes['/night/set'](payload), error => error.requestError.reason === 'invalid_request');
  }
  assert.equal(calls.length, 4);
});

test('night UI routes preserve safe failure reasons and omit raw cloud or credential details', async () => {
  for (const reason of ['night_vision_unsupported', 'night_vision_unavailable', 'night_vision_rejected',
    'night_vision_not_applied', 'night_vision_timeout', 'authentication_required', 'query_timeout']) {
    const routes = createUiHandlers({ request: async () => { throw Object.assign(new Error('PRIVATE_TOKEN http://private.invalid'), { reason, raw: 'PRIVATE_CLOUD' }); } });
    for (const path of ['/night/get', '/night/set']) {
      await assert.rejects(routes[path]({ mode: 'off' }), error => {
        assert.equal(error.message, 'request_failed');
        assert.equal(error.requestError.reason, reason);
        assert.doesNotMatch(JSON.stringify(error), /PRIVATE|http:/);
        return true;
      });
    }
  }
  const routes = createUiHandlers({ request: async () => { throw new Error('PRIVATE_TOKEN'); } });
  await assert.rejects(routes['/night/get'](), error => error.requestError.reason === 'operation_failed' && !JSON.stringify(error).includes('PRIVATE'));
});
