import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { safeDiagnostics } from '../lib/diagnostics.mjs';

class Element {
  constructor() {
    this.value = ''; this.checked = false; this.disabled = false; this.textContent = ''; this.children = []; this.dataset = {};
    const values = new Set();
    this.classList = { add: value => values.add(value), remove: value => values.delete(value),
      contains: value => values.has(value), toggle: (value, enabled) => enabled ? values.add(value) : values.delete(value) };
  }
  replaceChildren() { this.children = []; this.value = ''; }
  append(value) { this.children.push(value); if (this.children.length === 1) this.value = value.value; }
  removeAttribute(name) { delete this[name]; }
}

async function ui({ restartRequired = false, runtime = { state: 'idle', ready: false, region: 'cn' }, clipboard,
  components = { ready: true }, statusError, configs = [{ platform: 'MijiaRemoteCamera', region: 'cn' }],
  nightGet = async () => ({ mode: 'auto' }), nightSet = async payload => ({ mode: payload.mode }) } = {}) {
  const html = await readFile(new URL('../homebridge-ui/public/index.html', import.meta.url), 'utf8');
  const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
  const elements = new Map();
  const get = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  for (const match of html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)) {
    const element = get(match[1]);
    element.disabled = /\sdisabled(?:\s|>)/.test(match[0]);
    for (const value of (match[0].match(/\bclass="([^"]*)"/)?.[1] || '').split(/\s+/).filter(Boolean)) element.classList.add(value);
  }
  get('region').value = 'cn';
  get('nightMode').value = 'auto';
  const intervals = [];
  const methods = [];
  const savedConfigs = [];
  let saveCalls = 0;
  let now = Date.UTC(2026, 9, 23, 12, 0, 0);
  class ClockDate extends Date { static now() { return now; } }
  const homebridge = {
    hideSchemaForm() {}, getPluginConfig: async () => configs,
    updatePluginConfig: async value => savedConfigs.push(JSON.parse(JSON.stringify(value))),
    savePluginConfig: async () => { ++saveCalls; },
    request: async (method, payload) => {
      methods.push({ method, payload });
      if (method === '/components') return components;
      if (method === '/status') { if (statusError) throw statusError; return runtime; }
      if (method === '/auth/status') return { state: 'idle' };
      if (method === '/auth/start') return { loginId: 'test-login', loginUrl: 'https://account.xiaomi.com/login?ticket=PRIVATE_UI', expiresIn: 30 };
      if (method === '/homes') return [{ id: '202', ownerId: '11', name: '异地家庭', shared: false }];
      if (method === '/devices') return [{ deviceId: '801', name: '摄像头', model: 'chuangmi.camera.061a01', online: true }];
      if (method === '/select') return { success: true, restartRequired };
      if (method === '/night/get') return nightGet(payload);
      if (method === '/night/set') return nightSet(payload);
      return { success: true };
    },
  };
  const context = vm.createContext({ homebridge, URL, Date: ClockDate,
    ...(clipboard === undefined ? {} : { navigator: { clipboard } }), document: { getElementById: get, createElement: () => new Element() },
    window: { addEventListener() {} }, setInterval: fn => { intervals.push(fn); return intervals.length; },
    setTimeout: () => 1, clearTimeout() {}, clearInterval() {} });
  vm.runInContext(script, context);
  await new Promise(setImmediate); await new Promise(setImmediate);
  return { get, intervals, methods, savedConfigs, saveCalls: () => saveCalls, advance(seconds) { now += seconds * 1000; } };
}

test('background runtime polling cannot re-enable login controls during browser authorization', async () => {
  const screen = await ui();
  await screen.get('login').onclick();
  assert.equal(screen.get('login').disabled, true);
  assert.equal(screen.get('load').disabled, true);
  await screen.intervals[0]();
  assert.equal(screen.get('login').disabled, true);
  assert.equal(screen.get('load').disabled, true);
  assert.equal(screen.get('cancel').classList.contains('hide'), false);
});

test('switching an already-published camera explains the required Homebridge restart', async () => {
  const screen = await ui({ restartRequired: true });
  await screen.get('load').onclick();
  assert.equal(screen.get('save').disabled, false);
  await screen.get('save').onclick();
  assert.match(screen.get('selectionState').textContent, /重启 Homebridge/);
  const selection = screen.methods.find(call => call.method === '/select').payload;
  assert.equal(selection.homeId, '202');
  assert.equal(selection.homeOwner, '11');
  assert.equal(selection.deviceId, '801');
});

test('real runtime protocol failures are translated without raw backend details', async () => {
  const screen = await ui({ runtime: { state: 'blocked', reason: 'unsupported_transport', ready: false } });
  assert.match(screen.get('runtimeText').textContent, /协议尚不支持/);
});

test('changing region cannot display old-region homes under the new region selector', async () => {
  const screen = await ui();
  screen.get('region').value = 'sg';
  screen.get('region').onchange();
  assert.equal(screen.get('load').disabled, true);
  assert.equal(screen.get('login').disabled, false);
  await screen.intervals[0]();
  assert.equal(screen.get('load').disabled, true);
  assert.match(screen.get('authState').textContent, /切换地区/);
  screen.get('region').value = 'cn';
  screen.get('region').onchange();
  assert.equal(screen.get('load').disabled, false);
});

test('connection stages, attempt number and elapsed time update while previous failures remain available', async () => {
  const runtime = { state: 'starting', reason: 'starting', stage: 'relay_connect', attempt: 2,
    connectingElapsedSeconds: 42, ready: false, videoReceived: false,
    lastFailure: 'connection_failed', lastFailureAt: '2026-10-23T11:59:00.000Z' };
  const screen = await ui({ runtime });
  assert.match(screen.get('runtimeText').textContent, /连接远程中继/);
  assert.match(screen.get('connectionDetail').textContent, /第 2 次.*已等待 42 秒/);
  assert.match(screen.get('connectionDetail').textContent, /上次连接.*远程连接未能建立/);
  screen.advance(3); screen.intervals[1]();
  assert.match(screen.get('connectionDetail').textContent, /已等待 45 秒/);
  runtime.stage = 'waiting_video'; runtime.connectingElapsedSeconds = 46;
  await screen.intervals[0]();
  assert.match(screen.get('runtimeText').textContent, /首个关键帧/);
  const report = JSON.parse(screen.get('diagnosticsReport').textContent);
  assert.equal(report.stage, 'waiting_video');
  assert.equal(report.lastFailure, 'connection_failed');
  assert.equal(report.lastFailureAt, '2026-10-23T11:59:00.000Z');
});

test('retry countdown takes precedence over failure text and counts down between status polls', async () => {
  const runtime = { state: 'retrying', reason: 'connection_failed', attempt: 2, retryInSeconds: 17,
    lastFailure: 'connection_failed', ready: false, videoReceived: true };
  const screen = await ui({ runtime });
  assert.match(screen.get('runtimeText').textContent, /17 秒后重试/);
  assert.equal(screen.get('runtimeStatus').dataset.live, 'false');
  screen.advance(7); screen.intervals[1]();
  assert.match(screen.get('runtimeText').textContent, /10 秒后重试/);
  screen.advance(10); screen.intervals[1]();
  assert.match(screen.get('runtimeText').textContent, /即将重试/);
  Object.assign(runtime, { state: 'starting', reason: 'starting', stage: 'authentication', attempt: 3, connectingElapsedSeconds: 1 });
  await screen.intervals[0]();
  assert.match(screen.get('runtimeText').textContent, /验证摄像头会话/);
  assert.match(screen.get('connectionDetail').textContent, /第 3 次.*已等待 1 秒/);
});

test('video is reported live only when ready and an actual video receipt are both confirmed', async () => {
  const runtime = { state: 'ready', reason: 'ready', ready: true, videoReceived: false };
  const screen = await ui({ runtime });
  assert.match(screen.get('runtimeText').textContent, /等待摄像头首帧/);
  assert.equal(screen.get('runtimeStatus').dataset.live, 'false');
  runtime.videoReceived = true;
  await screen.intervals[0]();
  assert.match(screen.get('runtimeText').textContent, /已收到摄像头视频/);
  assert.equal(screen.get('runtimeStatus').dataset.live, 'true');
  runtime.ready = false;
  await screen.intervals[0]();
  assert.equal(screen.get('runtimeStatus').dataset.live, 'false');
});

test('copied diagnostics match the safe report and omit device, source and authentication details', async () => {
  const runtime = { state: 'blocked', reason: 'connection_failed', ready: false, videoReceived: false,
    region: 'cn', attempt: 3, vendor: 4, lastFailure: 'connection_failed', lastFailureAt: '2026-10-23T11:59:00.000Z',
    deviceId: 'PRIVATE_DEVICE', homeId: 'PRIVATE_HOME', sourceUrl: 'http://127.0.0.1:1234/cam.ts?PRIVATE_URL',
    passToken: 'PRIVATE_TOKEN', serviceToken: 'PRIVATE_SESSION', lastError: 'PRIVATE_EXCEPTION', nested: { secret: 'PRIVATE_NESTED' },
    media: { snapshot: { requests: 4, successes: 3, lastBytes: 9107, lastElapsedMs: 2825,
      sourceUrl: 'PRIVATE_MEDIA_URL', passToken: 'PRIVATE_MEDIA_TOKEN', error: { text: 'PRIVATE_MEDIA_ERROR' } },
      stream: { starts: 1, state: 'starting', lastFailure: 'udp_unreachable', srtp_key: 'PRIVATE_SRTP_KEY' },
      lastEvent: { type: 'stream_failure', at: '2026-10-23T12:00:00.000Z', reason: 'udp_unreachable',
        exitCode: 1, signal: 'SIGTERM', command: ['PRIVATE_COMMAND'], endpoint: 'PRIVATE_ENDPOINT' } } };
  let copied;
  const screen = await ui({ runtime, clipboard: { async writeText(text) { copied = text; } } });
  assert.match(screen.get('runtimeText').textContent, /远程连接未能建立/);
  assert.deepEqual(JSON.parse(screen.get('diagnosticsReport').textContent), safeDiagnostics(runtime));
  assert.match(screen.get('mediaDetail').textContent, /快照 4 次.*直播 1 次/);
  await screen.get('copyDiagnostics').onclick();
  assert.equal(copied, screen.get('diagnosticsReport').textContent);
  assert.doesNotMatch(copied, /PRIVATE_|deviceId|homeId|sourceUrl|passToken|serviceToken|lastError|nested/);
  assert.match(screen.get('diagnosticsHint').textContent, /已复制/);
});

test('camera source readiness does not imply HomeKit has requested a snapshot or live stream', async () => {
  const runtime = { state: 'ready', reason: 'ready', ready: true, videoReceived: true,
    media: { snapshot: { requests: 0, successes: 0 }, stream: { starts: 0, firstFrames: 0, state: 'idle' }, lastEvent: null } };
  const screen = await ui({ runtime });
  assert.equal(screen.get('runtimeStatus').dataset.live, 'true');
  assert.match(screen.get('runtimeText').textContent, /已收到摄像头视频/);
  assert.match(screen.get('mediaDetail').textContent, /快照 0 次.*直播 0 次/);
  runtime.media.snapshot.requests = 1;
  runtime.media.snapshot.successes = 1;
  runtime.media.stream.starts = 1;
  runtime.media.stream.firstFrames = 1;
  runtime.media.stream.state = 'active';
  await screen.intervals[0]();
  assert.match(screen.get('mediaDetail').textContent, /快照 1 次.*直播 1 次/);
  assert.equal(JSON.parse(screen.get('diagnosticsReport').textContent).media.stream.state, 'active');
});

test('unknown nested media values are absent from both visible counts and copied diagnostics', async () => {
  const runtime = { state: 'ready', ready: true, videoReceived: true, media: {
    snapshot: { requests: 'PRIVATE_REQUESTS', lastElapsedMs: 'PRIVATE_ELAPSED' },
    stream: { starts: -1, state: 'PRIVATE_STATE' },
    lastEvent: { type: 'PRIVATE_EVENT', at: '2026-10-23T12:00:00.000Z', error: 'PRIVATE_ERROR' },
  } };
  let copied;
  const screen = await ui({ runtime, clipboard: { async writeText(text) { copied = text; } } });
  assert.equal(screen.get('mediaDetail').textContent, '');
  await screen.get('copyDiagnostics').onclick();
  assert.deepEqual(JSON.parse(copied), safeDiagnostics(runtime));
  assert.doesNotMatch(copied, /PRIVATE|media/);
});

test('clipboard absence has a manual-copy fallback without disturbing connection status', async () => {
  const screen = await ui({ runtime: { state: 'starting', stage: 'device_lookup', ready: false } });
  await screen.get('copyDiagnostics').onclick();
  assert.match(screen.get('diagnosticsHint').textContent, /手动选中.*复制/);
  assert.match(screen.get('runtimeText').textContent, /核对摄像头/);
  assert.equal(screen.get('error').textContent, '');
});

test('missing local components preserve the import instructions and disabled login controls', async () => {
  const screen = await ui({ components: { ready: false }, statusError: { reason: 'plugin_not_running' } });
  assert.equal(screen.get('components').classList.contains('hide'), false);
  assert.equal(screen.get('bootstrap').classList.contains('hide'), false);
  assert.equal(screen.get('login').disabled, true);
  assert.equal(screen.get('load').disabled, true);
});


test('camera audio receipt and two-way capability render only confirmed runtime metadata', async () => {
  const runtime={ready:true,videoReceived:true,audio:{enabled:true,received:false,talkbackEnabled:true}};
  const screen=await ui({runtime});
  assert.match(screen.get('audioDetail').textContent,/等待摄像头声音/);
  Object.assign(runtime.audio,{received:true,talkbackSupported:true,codec:'PCMA',sampleRate:8000,channels:1});
  await screen.intervals[0]();
  assert.match(screen.get('audioDetail').textContent,/已收到真实摄像头声音.*双向对讲/);
  assert.deepEqual(JSON.parse(screen.get('diagnosticsReport').textContent),safeDiagnostics(runtime));
});

test('night vision controls remain disabled until an explicit read confirms the real camera mode', async () => {
  const screen = await ui({ nightGet: async () => ({ mode: 'off' }) });
  assert.equal(screen.get('nightMode').disabled, true);
  assert.equal(screen.get('nightSave').disabled, true);
  assert.equal(screen.methods.some(call => call.method.startsWith('/night/')), false);
  await screen.intervals[0]();
  assert.equal(screen.methods.some(call => call.method.startsWith('/night/')), false);
  await screen.get('nightRead').onclick();
  assert.equal(screen.get('nightMode').value, 'off');
  assert.equal(screen.get('nightMode').disabled, false);
  assert.equal(screen.get('nightSave').disabled, false);
  assert.match(screen.get('nightState').textContent, /摄像头已确认：关闭/);
  assert.deepEqual(screen.methods.filter(call => call.method.startsWith('/night/')).map(call => call.method), ['/night/get']);
});

test('night mode writes send only the chosen policy and show the actual confirmed result', async () => {
  const screen = await ui({ nightGet: async () => ({ mode: 'auto' }), nightSet: async () => ({ mode: 'on', raw: 'PRIVATE_TOKEN' }) });
  await screen.get('nightRead').onclick();
  screen.get('nightMode').value = 'on';
  await screen.get('nightSave').onclick();
  const writes = screen.methods.filter(call => call.method === '/night/set');
  assert.equal(writes.length, 1);
  assert.equal(JSON.stringify(writes[0].payload), '{"mode":"on"}');
  assert.equal(screen.get('nightMode').value, 'on');
  assert.match(screen.get('nightState').textContent, /摄像头已确认：开启/);
  assert.doesNotMatch(screen.get('nightState').textContent, /PRIVATE/);
});

test('failed or malformed first reads preserve disabled night controls and never expose raw errors', async () => {
  for (const nightGet of [async () => { throw { requestError: { reason: 'night_vision_unsupported', raw: 'PRIVATE_TOKEN' } }; },
    async () => ({ mode: 'PRIVATE_TOKEN' }), async () => { throw new Error('PRIVATE_TOKEN'); }]) {
    const screen = await ui({ nightGet });
    await screen.get('nightRead').onclick();
    assert.equal(screen.get('nightMode').disabled, true);
    assert.equal(screen.get('nightSave').disabled, true);
    assert.equal(screen.get('nightRead').disabled, false);
    assert.doesNotMatch(screen.get('nightState').textContent, /PRIVATE/);
    assert.equal(screen.methods.some(call => call.method === '/night/set'), false);
  }
});

test('an unconfirmed write requires a fresh read and cannot leave an optimistic enabled mode control', async () => {
  const screen = await ui({ nightSet: async () => { throw { reason: 'night_vision_not_applied', raw: 'PRIVATE_TOKEN' }; } });
  await screen.get('nightRead').onclick();
  screen.get('nightMode').value = 'off';
  await screen.get('nightSave').onclick();
  assert.match(screen.get('nightState').textContent, /尚未确认新模式/);
  assert.equal(screen.get('nightMode').disabled, true);
  assert.equal(screen.get('nightSave').disabled, true);
  await screen.get('nightRead').onclick();
  assert.equal(screen.get('nightMode').value, 'auto');
  assert.equal(screen.get('nightSave').disabled, false);
});

test('camera selection, account and region changes require a new night-mode read', async () => {
  for (const context of ['camera', 'account', 'region']) {
    const screen = await ui();
    await screen.get('nightRead').onclick();
    assert.equal(screen.get('nightMode').disabled, false);
    if (context === 'camera') { await screen.get('load').onclick(); await screen.get('save').onclick(); }
    if (context === 'account') await screen.get('login').onclick();
    if (context === 'region') { screen.get('region').value = 'sg'; screen.get('region').onchange(); }
    assert.equal(screen.get('nightMode').disabled, true);
    assert.equal(screen.get('nightSave').disabled, true);
    assert.match(screen.get('nightState').textContent, /读取摄像头实际模式后可修改/);
  }
});

test('a delayed old-context night response cannot re-enable controls after a region change', async () => {
  let release;
  const screen = await ui({ nightGet: () => new Promise(resolve => { release = resolve; }) });
  const pending = screen.get('nightRead').onclick();
  assert.equal(screen.get('nightMode').disabled, true);
  assert.equal(screen.get('nightRead').disabled, true);
  screen.get('region').value = 'sg'; screen.get('region').onchange();
  release({ mode: 'on' }); await pending;
  assert.equal(screen.get('nightMode').disabled, true);
  assert.equal(screen.get('nightSave').disabled, true);
  assert.match(screen.get('nightState').textContent, /读取摄像头实际模式后可修改/);
});

test('feature configuration preserves bridge identity, advanced settings and additional plugin entries', async () => {
  const configs = [{ platform: 'MijiaRemoteCamera', region: 'sg', name: '摄像头子桥',
    _bridge: { username: '0E:11:22:33:44:55', port: 52012 }, quality: 0, runtimeDirectory: '/components',
    videoConfig: { maxWidth: 1920 }, enableAudio: false, enableTalkback: false, enableNightVision: true },
  { platform: 'MijiaRemoteCamera', name: '第二配置', _bridge: { port: 52013 } }];
  const original = JSON.parse(JSON.stringify(configs));
  const screen = await ui({ configs });
  assert.equal(screen.get('enableAudio').checked, false);
  assert.equal(screen.get('enableTalkback').disabled, true);
  screen.get('enableAudio').checked = true; screen.get('enableAudio').onchange();
  assert.equal(screen.get('enableTalkback').disabled, false);
  screen.get('enableTalkback').checked = true;
  screen.get('enableNightVision').checked = false;
  screen.get('enablePtzSwitches').checked = true;
  await screen.get('saveFeatures').onclick();
  assert.equal(screen.saveCalls(), 1);
  assert.deepEqual(screen.savedConfigs, [[{ ...original[0], enableAudio: true, enableTalkback: true, enableNightVision: false, enablePtzSwitches: true }, original[1]]]);
  assert.deepEqual(configs, original);
  assert.match(screen.get('featureState').textContent, /重启摄像头子桥/);
  assert.equal(screen.methods.some(call => call.method === '/night/set'), false);
});
