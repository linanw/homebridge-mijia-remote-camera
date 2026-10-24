import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createUiHandlers } from '../homebridge-ui/server.js';

const identity = 'a'.repeat(64);
const epoch = '11111111-1111-4111-8111-111111111111';
const guard = { expectedIdentity: identity, expectedSourceEpoch: epoch, expectedRevision: 7 };
const plain = value => JSON.parse(JSON.stringify(value));
const flush = async () => { for (let i = 0; i < 4; ++i) await new Promise(setImmediate); };
const pending = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function metadata(overrides = {}) {
  return { enabled: true, intervalSeconds: 60, loading: false, identity, sourceEpoch: epoch, revision: 7,
    lastSuccessAt: '2026-10-24T07:00:00.000Z', lastError: null,
    capabilities: { read: true, rename: true, move: true, syncConfig: true },
    metadata: { name: '客厅摄像头', homeName: '家', roomId: '21', roomName: '客厅',
      rooms: [{ id: '21', name: '客厅' }, { id: '22', name: '书房' }] }, ...overrides };
}

test('metadata UI routes expose only fixed operations, current-camera guards and explicit user fields', async () => {
  const calls = [];
  const routes = createUiHandlers({ async request(method, payload) { calls.push({ method, payload }); return { confirmed: true }; } });
  const injected = { ...guard, did: 'PRIVATE_DEVICE', homeId: 'PRIVATE_HOME', homeOwner: 'PRIVATE_OWNER',
    accountId: 'PRIVATE_ACCOUNT', command: '/arbitrary/write', token: 'PRIVATE_TOKEN', source: '/private' };
  await routes['/metadata/status'](injected);
  await routes['/metadata/refresh'](injected);
  await routes['/metadata/sync']({ ...injected, enabled: false });
  await routes['/metadata/update']({ ...injected, operation: 'rename', name: '书房📹' });
  await routes['/metadata/update']({ ...injected, operation: 'move', roomId: '22', name: 'ignored' });
  assert.deepEqual(calls, [
    { method: 'metadata.status', payload: {} },
    { method: 'metadata.refresh', payload: guard },
    { method: 'metadata.sync', payload: { ...guard, enabled: false } },
    { method: 'metadata.update', payload: { ...guard, operation: 'rename', name: '书房📹' } },
    { method: 'metadata.update', payload: { ...guard, operation: 'move', roomId: '22' } },
  ]);
});

test('metadata routes reject missing or malformed guards and never normalize a rejected name into a write', async () => {
  let writes = 0;
  const routes = createUiHandlers({ async request() { ++writes; return {}; } });
  const invalid = [undefined, {}, { ...guard, operation: 'delete' },
    ...['expectedIdentity', 'expectedSourceEpoch', 'expectedRevision'].map(key => {
      const value = { ...guard, operation: 'rename', name: '合法名称' }; delete value[key]; return value;
    }),
    ...[-1, 0.5, Number.MAX_SAFE_INTEGER + 1, '7', null].map(expectedRevision => ({ ...guard, expectedRevision, operation: 'rename', name: '合法名称' })),
    { ...guard, expectedIdentity: 'private', operation: 'rename', name: '合法名称' },
    { ...guard, expectedSourceEpoch: 'private', operation: 'rename', name: '合法名称' },
    ...['', ' ', ' name', 'name ', 'x'.repeat(161), '坏\n名称', '坏\u007f名称', '坏\u0085名称', '\ud800', '\udc00'].map(name => ({ ...guard, operation: 'rename', name })),
    ...['', 'room-22', '22\n', 22, null].map(roomId => ({ ...guard, operation: 'move', roomId })),
  ];
  for (const value of invalid) await assert.rejects(routes['/metadata/update'](value), error => error.requestError?.reason === 'invalid_request');
  for (const enabled of [undefined, null, 0, 'true']) await assert.rejects(routes['/metadata/sync']({ ...guard, enabled }), error => error.requestError?.reason === 'invalid_request');
  assert.equal(writes, 0);
  await routes['/metadata/update']({ ...guard, operation: 'rename', name: '📹'.repeat(80) });
  assert.equal(writes, 1, '160 UTF-16 units remain a valid UI/API name');
});

test('metadata route failures expose a bounded reason without backend commands, credentials or raw text', async () => {
  for (const reason of ['metadata_conflict', 'metadata_busy', 'metadata_unconfirmed', 'metadata_not_applied', 'metadata_not_owner', 'metadata_write_unsupported', 'PRIVATE_REASON']) {
    const routes = createUiHandlers({ async request() { throw Object.assign(Error('PRIVATE_COMMAND PRIVATE_TOKEN'), { reason, raw: 'PRIVATE_RAW' }); } });
    await assert.rejects(routes['/metadata/update']({ ...guard, operation: 'rename', name: '新名称' }), error => {
      assert.equal(error.requestError.reason, reason === 'PRIVATE_REASON' ? 'operation_failed' : reason);
      assert.doesNotMatch(JSON.stringify(error), /PRIVATE/);
      return true;
    });
  }
});

class Element {
  constructor() {
    this.value = ''; this.checked = false; this.disabled = false; this.textContent = ''; this.children = []; this.dataset = {};
    const classes = new Set();
    this.classList = { add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value),
      toggle: (value, on) => on ? classes.add(value) : classes.delete(value) };
  }
  replaceChildren() { this.children = []; this.value = ''; }
  append(child) { this.children.push(child); if (this.children.length === 1) this.value = child.value; }
  removeAttribute(name) { delete this[name]; }
}

async function screen({ initial = metadata(), request: customRequest } = {}) {
  const html = await readFile(new URL('../homebridge-ui/public/index.html', import.meta.url), 'utf8');
  const elements = new Map(), calls = [], saved = [], intervals = [];
  const get = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  for (const match of html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)) {
    get(match[1]).disabled = /\sdisabled(?:\s|>)/.test(match[0]);
    for (const name of (match[0].match(/\bclass="([^"]*)"/)?.[1] || '').split(/\s+/).filter(Boolean)) get(match[1]).classList.add(name);
  }
  get('region').value = 'cn';
  let current = initial;
  const configs = [{ platform: 'MijiaRemoteCamera', region: 'cn', quality: 3, _bridge: { port: 52000 } }];
  const homebridge = {
    hideSchemaForm() {}, async getPluginConfig() { return configs; },
    async updatePluginConfig(value) { saved.push(plain(value)); }, async savePluginConfig() {},
    async request(path, payload) {
      calls.push({ path, payload: plain(payload ?? {}) });
      const overridden = customRequest?.(path, payload, { metadata: current, setMetadata: value => { current = value; } });
      if (overridden !== undefined) return overridden;
      if (path === '/status') return { ready: true, videoReceived: true, state: 'ready', region: 'cn' };
      if (path === '/components') return { ready: true };
      if (path === '/auth/status') return { state: 'idle' };
      if (path === '/auth/start') return { loginId: 'test-login', loginUrl: 'https://account.xiaomi.com/login?ticket=PRIVATE_LINK' };
      if (path === '/metadata/status') return plain(current);
      if (path === '/metadata/sync') { current = { ...current, enabled: payload.enabled }; return plain(current); }
      if (path === '/metadata/refresh') return plain(current);
      if (path === '/metadata/update') return { confirmed: true };
      if (path === '/homes') return [{ id: '202', ownerId: '11', name: '其他家庭' }];
      if (path === '/devices') return [{ deviceId: '801', name: '其他摄像头', model: 'chuangmi.camera.061a01' }];
      if (path === '/select') return { success: true };
      return {};
    },
  };
  const context = vm.createContext({ homebridge, URL, document: { getElementById: get, createElement: () => new Element() },
    window: { addEventListener() {} }, setInterval: callback => { intervals.push(callback); return intervals.length; },
    clearInterval() {}, setTimeout: () => 1, clearTimeout() {} });
  vm.runInContext(html.match(/<script>([\s\S]*)<\/script>/)[1], context);
  await flush();
  return { get, calls, saved, configs, intervals, poll: () => get('check').onclick(), setMetadata(value) { current = value; },
    editName(value) { get('metadataName').value = value; get('metadataName').oninput(); },
    editRoom(value) { get('metadataRoom').value = value; get('metadataRoom').onchange(); },
    metadataCalls: () => calls.filter(call => call.path.startsWith('/metadata/')) };
}

test('metadata page loading only reads; owner validation capabilities control every cloud edit', async () => {
  for (const capabilities of [
    { read: true, rename: false, move: false, syncConfig: true },
    { read: true, rename: false, move: false, syncConfig: false },
  ]) {
    const ui = await screen({ initial: metadata({ capabilities }) });
    assert.deepEqual(ui.metadataCalls().map(call => call.path), ['/metadata/status']);
    assert.match(ui.get('metadataCurrent').textContent, /客厅摄像头.*客厅/);
    assert.equal(ui.get('metadataName').disabled, true);
    assert.equal(ui.get('metadataRoom').disabled, true);
    assert.equal(ui.get('metadataRename').disabled, true);
    assert.equal(ui.get('metadataMove').disabled, true);
    await ui.get('metadataRename').onclick(); await ui.get('metadataMove').onclick();
    assert.equal(ui.calls.some(call => call.path === '/metadata/update'), false);
  }
  const ui = await screen();
  assert.equal(ui.get('metadataRename').disabled, false);
  assert.equal(ui.get('metadataMove').disabled, false);
  assert.equal(ui.get('metadataRoom').children.find(option => option.value === '').disabled, true, 'unassigned is display-only');
});

test('explicit rename and move carry the captured identity, epoch and revision, without local configuration writes', async () => {
  const ui = await screen({ request(path, payload, state) {
    if (path !== '/metadata/update') return;
    const name = payload.operation === 'rename' ? payload.name : state.metadata.metadata.name;
    const roomId = payload.operation === 'move' ? payload.roomId : state.metadata.metadata.roomId;
    state.setMetadata(metadata({ revision: state.metadata.revision + 1, metadata: { ...state.metadata.metadata, name, roomId, roomName: roomId === '22' ? '书房' : '客厅' } }));
    return { confirmed: true };
  } });
  ui.editName('书房📹'); await ui.get('metadataRename').onclick();
  assert.deepEqual(ui.calls.find(call => call.path === '/metadata/update').payload, { ...guard, operation: 'rename', name: '书房📹' });
  assert.match(ui.get('metadataState').textContent, /米家回读确认/);
  assert.equal(ui.get('metadataName').value, '书房📹');
  ui.editRoom('22'); await ui.get('metadataMove').onclick();
  const writes = ui.calls.filter(call => call.path === '/metadata/update');
  assert.deepEqual(writes[1].payload, { ...guard, expectedRevision: 8, operation: 'move', roomId: '22' });
  assert.equal(ui.get('metadataRoom').value, '22');
  assert.equal(ui.saved.length, 0);
});

test('invalid cloud names are rejected in the page before any update request is sent', async () => {
  for (const name of ['', ' ', ' name', 'name ', '\tname', 'name\n', 'x'.repeat(161),
    '📹'.repeat(81), '名称\u0000', '名称\u007f', '名称\u0085', '\ud800', '\udc00']) {
    const ui = await screen();
    ui.editName(name); await ui.get('metadataRename').onclick();
    assert.equal(ui.calls.some(call => call.path === '/metadata/update'), false);
    assert.equal(ui.get('metadataName').value, name, 'validation preserves the exact draft instead of silently normalizing it');
    assert.match(ui.get('metadataState').textContent, /名称须为/);
    assert.doesNotMatch(ui.get('metadataState').textContent, /已在米家回读确认/);
    assert.equal(ui.get('metadataRefresh').disabled, false);
  }
  const ui = await screen();
  ui.editName('📹'.repeat(80)); await ui.get('metadataRename').onclick();
  assert.equal(ui.calls.filter(call => call.path === '/metadata/update').length, 1, 'the 160 UTF-16-unit boundary remains valid');
});

test('editing another draft clears an earlier confirmed-write notice without issuing another cloud request', async () => {
  const ui = await screen();
  ui.editName('已确认的名称'); await ui.get('metadataRename').onclick();
  assert.match(ui.get('metadataState').textContent, /已在米家回读确认修改/);
  ui.editName('这份草稿尚未提交');
  assert.doesNotMatch(ui.get('metadataState').textContent, /已在米家回读确认修改/);
  assert.equal(ui.get('metadataName').value, '这份草稿尚未提交');
  assert.equal(ui.calls.filter(call => call.path === '/metadata/update').length, 1);
  ui.editRoom('22');
  assert.doesNotMatch(ui.get('metadataState').textContent, /已在米家回读确认修改/);
  assert.equal(ui.calls.filter(call => call.path === '/metadata/update').length, 1);
});

test('a command acknowledgment is not confirmation; unconfirmed and failed writes preserve the draft without exposing private errors', async () => {
  for (const result of [() => ({ accepted: true }), () => ({ confirmed: false }),
    () => { throw { requestError: { reason: 'metadata_unconfirmed', raw: 'PRIVATE_TOKEN' } }; },
    () => { throw new Error('PRIVATE_COMMAND PRIVATE_TOKEN'); }]) {
    const ui = await screen({ request(path) { if (path === '/metadata/update') return Promise.resolve().then(result); } });
    ui.editName('保留的草稿'); await ui.get('metadataRename').onclick();
    assert.equal(ui.get('metadataName').value, '保留的草稿');
    assert.equal(ui.get('metadataDiscard').classList.contains('hide'), false);
    assert.doesNotMatch(ui.get('metadataState').textContent, /已在米家回读确认|PRIVATE/);
    assert.equal(ui.calls.filter(call => call.path === '/metadata/update').length, 1);
  }
});

test('outside revision, epoch or identity changes preserve a draft and require explicit discard before another write', async () => {
  for (const change of [{ revision: 8 }, { sourceEpoch: '22222222-2222-4222-8222-222222222222' }, { identity: 'b'.repeat(64) }]) {
    const ui = await screen();
    ui.editName('正在编辑的草稿');
    ui.setMetadata(metadata({ ...change, metadata: { ...metadata().metadata, name: '米家新名称' } }));
    await ui.poll();
    assert.equal(ui.get('metadataName').value, '正在编辑的草稿');
    assert.match(ui.get('metadataCurrent').textContent, /米家新名称/);
    assert.equal(ui.get('metadataRename').disabled, true);
    assert.equal(ui.get('metadataMove').disabled, true);
    assert.match(ui.get('metadataState').textContent, /资料已变化.*草稿已保留/);
    assert.equal(ui.calls.some(call => call.path === '/metadata/update'), false);
    ui.get('metadataDiscard').onclick();
    assert.equal(ui.get('metadataName').value, '米家新名称');
    assert.equal(ui.get('metadataRename').disabled, false);
    assert.equal(ui.get('metadataDiscard').classList.contains('hide'), true);
  }
});

test('cloud operations share a single in-flight slot and do not retry automatically', async () => {
  const job = pending();
  const ui = await screen({ request(path) { if (path === '/metadata/update') return job.promise; } });
  ui.editName('等待确认');
  const operation = ui.get('metadataRename').onclick();
  assert.equal(ui.get('metadataRefresh').disabled, true);
  assert.equal(ui.get('metadataMove').disabled, true);
  await ui.get('metadataMove').onclick(); await ui.get('metadataRefresh').onclick();
  ui.get('metadataEnabled').checked = false; await ui.get('metadataEnabled').onchange();
  assert.deepEqual(ui.metadataCalls().map(call => call.path), ['/metadata/status', '/metadata/update']);
  job.reject({ reason: 'metadata_unconfirmed', raw: 'PRIVATE' }); await operation;
  await ui.poll();
  assert.equal(ui.calls.filter(call => call.path === '/metadata/update').length, 1);
  assert.doesNotMatch(ui.get('metadataState').textContent, /PRIVATE|回读确认修改/);
});

test('sync settings use the full returned status and ordinary Homebridge save never writes MiJia metadata', async () => {
  const ui = await screen();
  ui.get('metadataEnabled').checked = false; await ui.get('metadataEnabled').onchange();
  assert.deepEqual(ui.calls.find(call => call.path === '/metadata/sync').payload, { ...guard, enabled: false });
  assert.equal(ui.get('metadataEnabled').checked, false);
  assert.equal(ui.get('metadataName').value, '客厅摄像头');
  assert.equal(ui.get('metadataRename').disabled, false);
  ui.get('enablePtzSwitches').checked = true; await ui.get('savePtzFeatures').onclick();
  assert.equal(ui.saved[0][0].enablePtzSwitches, true);
  assert.deepEqual(ui.saved[0][0]._bridge, ui.configs[0]._bridge);
  assert.equal(ui.saved[0][0].quality, 3);
  assert.equal(ui.calls.some(call => call.path === '/metadata/update'), false);
});

test('refresh failures and private metadata errors never report a successful cloud change', async () => {
  for (const reason of ['request_timeout', 'metadata_conflict', 'PRIVATE_BACKEND']) {
    const ui = await screen({ request(path) { if (path === '/metadata/refresh') return Promise.reject({ reason, raw: 'PRIVATE_TOKEN' }); } });
    await ui.get('metadataRefresh').onclick();
    assert.doesNotMatch(ui.get('metadataState').textContent, /PRIVATE|已在米家回读确认修改/);
    assert.equal(ui.get('metadataRefresh').disabled, false);
    assert.equal(ui.calls.filter(call => call.path === '/metadata/refresh').length, 1);
  }
  const ui = await screen({ initial: metadata({ lastError: 'PRIVATE_TOKEN' }) });
  assert.doesNotMatch(ui.get('metadataState').textContent, /PRIVATE/);
});

test('late metadata reads cannot restore a prior account, region or camera after the context changes', async () => {
  for (const transition of ['auth', 'region', 'selection']) {
    const job = pending(); let reads = 0;
    const ui = await screen({ request(path) { if (path === '/metadata/status' && ++reads === 2) return job.promise; } });
    const oldRead = ui.poll(); await flush();
    if (transition === 'auth') await ui.get('login').onclick();
    if (transition === 'region') { ui.get('region').value = 'sg'; ui.get('region').onchange(); }
    if (transition === 'selection') {
      await ui.get('load').onclick();
      ui.setMetadata(metadata({ identity: 'b'.repeat(64), metadata: { ...metadata().metadata, name: '新摄像头' } }));
      await ui.get('save').onclick();
    }
    job.resolve(metadata({ metadata: { ...metadata().metadata, name: 'PRIVATE_OLD_CAMERA' } })); await oldRead;
    assert.doesNotMatch(ui.get('metadataCurrent').textContent, /PRIVATE_OLD_CAMERA/);
    assert.doesNotMatch(ui.get('metadataName').value, /PRIVATE_OLD_CAMERA/);
    if (transition !== 'selection') assert.equal(ui.get('metadataRename').disabled, true);
    else assert.equal(ui.get('metadataName').value, '新摄像头');
  }
});

test('late sync responses cannot restore old metadata after authorization starts', async () => {
  const job = pending();
  const ui = await screen({ request(path) { if (path === '/metadata/sync') return job.promise; } });
  ui.get('metadataEnabled').checked = false;
  const sync = ui.get('metadataEnabled').onchange();
  await ui.get('login').onclick();
  job.resolve(metadata({ enabled: false, metadata: { ...metadata().metadata, name: 'PRIVATE_OLD_CAMERA' } })); await sync;
  assert.doesNotMatch(ui.get('metadataCurrent').textContent, /PRIVATE_OLD_CAMERA/);
  assert.doesNotMatch(ui.get('metadataName').value, /PRIVATE_OLD_CAMERA/);
  assert.equal(ui.get('metadataRename').disabled, true);
});

test('late write confirmations cannot mark a new account or region as successfully changed', async () => {
  for (const transition of ['auth', 'region']) {
    const job = pending();
    const ui = await screen({ request(path) { if (path === '/metadata/update') return job.promise; } });
    ui.editName('旧账号的草稿'); const write = ui.get('metadataRename').onclick();
    if (transition === 'auth') await ui.get('login').onclick();
    else { ui.get('region').value = 'sg'; ui.get('region').onchange(); }
    job.resolve({ confirmed: true }); await write;
    assert.doesNotMatch(ui.get('metadataState').textContent, /已在米家回读确认/);
    assert.doesNotMatch(ui.get('metadataName').value, /旧账号/);
    assert.equal(ui.get('metadataRename').disabled, true);
  }
});

test('a context change during post-confirmation status loading cannot leave an old success notice in the next context', async () => {
  const job = pending(); let reads = 0;
  const ui = await screen({ request(path) { if (path === '/metadata/status' && ++reads === 2) return job.promise; } });
  ui.editName('旧地区草稿');
  const write = ui.get('metadataRename').onclick(); await flush();
  ui.get('region').value = 'sg'; ui.get('region').onchange();
  job.resolve(metadata()); await write;
  ui.get('region').value = 'cn'; ui.get('region').onchange(); await ui.poll();
  assert.doesNotMatch(ui.get('metadataState').textContent, /已在米家回读确认修改/);
  assert.equal(ui.get('metadataName').value, '客厅摄像头');
});

test('an unavailable plugin clears old metadata controls and cannot expose raw status errors', async () => {
  let statuses = 0;
  const ui = await screen({ request(path) { if (path === '/status' && ++statuses > 1) return Promise.reject(Error('PRIVATE_STATUS_ERROR')); } });
  assert.equal(ui.get('metadataRename').disabled, false);
  await ui.poll();
  assert.equal(ui.get('metadataName').disabled, true);
  assert.equal(ui.get('metadataRename').disabled, true);
  assert.equal(ui.get('metadataMove').disabled, true);
  assert.equal(ui.get('metadataRefresh').disabled, true);
  assert.doesNotMatch(ui.get('metadataCurrent').textContent + ui.get('metadataState').textContent + ui.get('error').textContent, /PRIVATE/);
});
