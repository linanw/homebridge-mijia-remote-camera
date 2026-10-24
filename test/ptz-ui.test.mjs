import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createUiHandlers } from '../homebridge-ui/server.js';

const directions = ['up', 'down', 'left', 'right'];
const capabilities = { supported: true, available: true, relativeStep: true, directions };
test('PTZ UI forwards a single validated direction without raw camera commands or IDs', async () => {
  const calls = [];
  const routes = createUiHandlers({ request: async (method, payload) => { calls.push({ method, payload }); return { accepted: true, direction: payload.direction }; } });
  await routes['/ptz/capabilities']({ did: 'PRIVATE', token: 'PRIVATE' });
  for (const direction of directions) await routes['/ptz/move']({ direction, operation: 99, duration: 30000, did: 'PRIVATE' });
  assert.deepEqual(calls, [{ method: 'ptz.capabilities', payload: {} }, ...directions.map(direction => ({ method: 'ptz.move', payload: { direction } }))]);
  for (const payload of [undefined, {}, { direction: 'UP' }, { direction: 1 }, { direction: ['up'] }, { direction: 'stop' }, { direction: 'zoom' }])
    await assert.rejects(routes['/ptz/move'](payload), e => e.requestError.reason === 'invalid_request');
  for (const reason of ['ptz_unsupported', 'ptz_unavailable', 'ptz_rejected', 'ptz_timeout', 'ptz_busy']) {
    const failed = createUiHandlers({ request: async () => { throw Object.assign(Error('PRIVATE'), { reason, raw: 'PRIVATE' }); } });
    await assert.rejects(failed['/ptz/move']({ direction: 'up' }), e => e.requestError.reason === reason && !JSON.stringify(e).includes('PRIVATE'));
  }
});

class Element {
  constructor() { this.value = ''; this.checked = false; this.disabled = false; this.textContent = ''; this.children = []; this.dataset = {}; const classes = new Set(); this.classList = { add: x => classes.add(x), remove: x => classes.delete(x), contains: x => classes.has(x), toggle: (x, on) => on ? classes.add(x) : classes.delete(x) }; }
  replaceChildren() { this.children = []; this.value = ''; }
  append(child) { this.children.push(child); if (this.children.length === 1) this.value = child.value; }
  removeAttribute(name) { delete this[name]; }
}
async function screen({ caps = capabilities, move = async direction => ({ accepted: true, direction }) } = {}) {
  const html = await readFile(new URL('../homebridge-ui/public/index.html', import.meta.url), 'utf8');
  const elements = new Map(), calls = [], intervals = [], saved = [];
  const get = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  for (const match of html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)) get(match[1]).disabled = /\sdisabled(?:\s|>)/.test(match[0]);
  get('region').value = 'cn';
  const configs = [{ platform: 'MijiaRemoteCamera', quality: 3, _bridge: { port: 52000 } }];
  const homebridge = { hideSchemaForm() {}, getPluginConfig: async () => configs, updatePluginConfig: async c => saved.push(structuredClone(c)), savePluginConfig: async () => {}, request: async (path, payload) => {
    calls.push({ path, payload });
    if (path === '/status') return { ready: true, state: 'ready', region: 'cn' };
    if (path === '/components') return { ready: true };
    if (path === '/auth/status') return { state: 'idle' };
    if (path === '/ptz/capabilities') return caps;
    if (path === '/ptz/move') return move(payload.direction);
    return { success: true };
  } };
  vm.runInNewContext(html.match(/<script>([\s\S]*)<\/script>/)[1], { homebridge, URL, document: { getElementById: get, createElement: () => new Element() }, window: { addEventListener() {} }, setInterval: f => { intervals.push(f); return intervals.length; }, clearInterval() {}, setTimeout: () => 1, clearTimeout() {} });
  await new Promise(setImmediate); await new Promise(setImmediate);
  return { get, calls, saved, configs };
}

test('direction controls require verified available capabilities and never move during page load', async () => {
  for (const caps of [{ ...capabilities, supported: false }, { ...capabilities, available: false }, { ...capabilities, relativeStep: false }]) {
    const ui = await screen({ caps });
    assert.equal(ui.get('ptzLeft').disabled, true);
    await ui.get('ptzLeft').onclick();
    assert.equal(ui.calls.some(x => x.path === '/ptz/move'), false);
  }
  const ui = await screen();
  assert.equal(ui.get('ptzLeft').disabled, false);
  assert.equal(ui.calls.some(x => x.path === '/ptz/move'), false);
  await ui.get('ptzLeft').onclick();
  assert.equal(ui.calls.filter(x => x.path === '/ptz/move').length, 1);
  assert.match(ui.get('ptzState').textContent, /接受向左单步指令/);
});

test('busy and obsolete page actions are not repeated or rendered as completed movement', async () => {
  let release;
  const ui = await screen({ move: direction => new Promise(resolve => release = () => resolve({ accepted: true, direction })) });
  const first = ui.get('ptzUp').onclick();
  assert.equal(ui.get('ptzLeft').disabled, true);
  await ui.get('ptzLeft').onclick();
  ui.get('region').value = 'sg'; ui.get('region').onchange();
  release(); await first;
  assert.equal(ui.get('ptzUp').disabled, true);
  assert.doesNotMatch(ui.get('ptzState').textContent, /接受/);
  assert.equal(ui.calls.filter(x => x.path === '/ptz/move').length, 1);
});

test('optional Home app controls preserve existing bridge configuration when saved', async () => {
  const ui = await screen();
  assert.equal(ui.get('enablePtzSwitches').checked, false);
  ui.get('enablePtzSwitches').checked = true;
  await ui.get('savePtzFeatures').onclick();
  assert.equal(ui.saved[0][0].enablePtzSwitches, true);
  assert.deepEqual(ui.saved[0][0]._bridge, ui.configs[0]._bridge);
  assert.equal(ui.saved[0][0].quality, 3);
});
