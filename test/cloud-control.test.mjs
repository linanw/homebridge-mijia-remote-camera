import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CloudControlClient, CloudControlError } from '../lib/cloud-control.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const java = path.join(root, 'assets/runtime/java/bin/java');
const oracle = path.join(root, 'test/fixtures/cloud-signer-probe.jar');
const hasJava = [java, oracle, path.join(root, 'assets/micam.jar')].every(existsSync);
const timestamp = 0x08090a0b * 60000;
const selection = { homeId: '1', homeOwner: '2', deviceId: '3', model: 'chuangmi.camera.061a01' };
const credentials = { userId: '4', serviceToken: 'PRIVATE_FAKE_TOKEN', deviceId: 'FAKEDEVICE', ssecurity: 'AAECAwQFBgcICQoLDA0ODw==' };
const capability = { version: 2, account: '4', region: 'cn', homeId: '1', owner: '2', did: '3', model: selection.model, verifiedAt: timestamp };
const success = value => ({ code: 0, result: [{ did: '3', siid: 2, piid: 3, code: 0, ...(value === undefined ? {} : { value }) }] });
function reference(...args) {
  const env = { ...process.env }; delete env.JAVA_TOOL_OPTIONS; delete env._JAVA_OPTIONS; delete env.JDK_JAVA_OPTIONS;
  const result = spawnSync(java, ['-cp', `${root}/assets/micam.jar:${oracle}`, 'mijia.bridge.CloudSignerProbe', ...args], { encoding: 'utf8', timeout: 3000, env });
  assert.equal(result.status, 0); assert.equal(result.stderr, ''); return result.stdout.trim();
}
const encrypted = value => Buffer.from(reference('encrypt', JSON.stringify(value)), 'utf8');
function setup(options = {}) {
  const seen = [], replies = options.replies ?? [success(2)];
  const client = new CloudControlClient({ storagePath: '/synthetic', now: () => timestamp,
    randomBytes: () => Buffer.from([0,1,2,3,4,5,6,7]),
    readJson: async file => file.endsWith('credentials.json') ? (options.credentials ?? credentials) : (options.capability === null ? null : options.capability ?? capability),
    request: async request => {
      seen.push({ ...request, body: request.body.toString() });
      return options.transportReply ?? { statusCode: 200, body: encrypted(replies.shift()) };
    }, ...options.client });
  return { client, seen };
}
const reason = expected => error => error instanceof CloudControlError && error.reason === expected && !error.message.includes('PRIVATE');

test('Node RC4-drop1024, nonce, both SHA signatures and form exactly match pinned Java CloudSigner', { skip: !hasJava }, async () => {
  const { client, seen } = setup();
  assert.deepEqual(await client.getNightVision(selection, 'cn'), { mode: 'auto' });
  assert.deepEqual(Object.fromEntries(new URLSearchParams(seen[0].body)), JSON.parse(reference()));
  assert.equal(seen[0].url, 'https://api.io.mi.com/app/miotspec/prop/get');
  assert.equal(seen[0].method, 'POST'); assert.ok(seen[0].timeoutMs <= 5500);
  assert.equal(seen[0].headers['Accept-Encoding'], 'identity');
  assert.equal(seen[0].headers['MIOT-ENCRYPT-ALGORITHM'], 'ENCRYPT-RC4');
  assert.equal(seen[0].headers.Cookie, 'userId=4; serviceToken=PRIVATE_FAKE_TOKEN; yetAnotherServiceToken=PRIVATE_FAKE_TOKEN; locale=en_GB; timezone=GMT%2B03%3A00; is_daylight=0; dst_offset=0; channel=MI_APP_STORE');
  client.close();
});

test('set sends only verified night property, then independently confirms actual mode', { skip: !hasJava }, async () => {
  const { client, seen } = setup({ replies: [success(), success(0)], client: { readDatasource: 0 } });
  assert.deepEqual(await client.setNightVision(selection, 'cn', 'on'), { mode: 'on' });
  assert.equal(seen.length, 2); assert.ok(seen[0].url.endsWith('/miotspec/prop/set'));
  assert.deepEqual(JSON.parse(reference('decrypt', new URLSearchParams(seen[0].body).get('data'))), {
    params: [{ did: '3', siid: 2, piid: 3, value: 0 }],
  });
  assert.ok(seen[1].url.endsWith('/miotspec/prop/get'));
  // Readback uses datasource1 despite a read-only cache preference.
  assert.deepEqual(Object.fromEntries(new URLSearchParams(seen[1].body)), JSON.parse(reference()));
  client.close();
  const mismatch = setup({ replies: [success(), success(1)] });
  await assert.rejects(mismatch.client.setNightVision(selection, 'cn', 'on'), reason('night_vision_not_applied'));
});

test('capability identity, version, timestamps and authoritative model must all match before any request', async () => {
  const changes = [{ version: 1 }, { account: '9' }, { region: 'us' }, { homeId: '9' }, { owner: '9' },
    { did: '9' }, { model: 'chuangmi.camera.061a03' }, { verifiedAt: timestamp + 1 }, { verifiedAt: timestamp - 86400000 }, { verifiedAt: '0' }];
  for (const change of [null, ...changes]) {
    const { client, seen } = setup({ capability: change === null ? null : { ...capability, ...change } });
    await assert.rejects(client.getNightVision(selection, 'cn'), error => reason('night_vision_unavailable')(error) && error.capabilityRequired === true);
    assert.equal(seen.length, 0);
  }
  const { client, seen } = setup();
  await assert.rejects(client.getNightVision({ ...selection, model: 'untrusted.camera' }, 'cn'), reason('night_vision_unsupported'));
  assert.equal(seen.length, 0);
});

test('invalid modes and regions, missing credentials, bad base64, or header injection fail safely without a request', async () => {
  const { client, seen } = setup();
  for (const mode of [undefined, null, '', true, 0, 'ON', 'PRIVATE_ERROR'])
    await assert.rejects(client.setNightVision(selection, 'cn', mode), reason('invalid_request'));
  await assert.rejects(client.getNightVision(selection, 'example.test'), reason('invalid_request'));
  assert.equal(seen.length, 0);
  for (const change of [{ ssecurity: 'invalid!' }, { serviceToken: 'x\r\nPRIVATE_TOKEN' }, { deviceId: 'x\nPRIVATE_TOKEN' }, { userId: '' }]) {
    const invalid = setup({ credentials: { ...credentials, ...change } });
    await assert.rejects(invalid.client.getNightVision(selection, 'cn'), reason('authentication_required'));
    assert.equal(invalid.seen.length, 0);
  }
});

test('expired plaintext/encrypted sessions, device rejections and malformed replies have safe typed failures', { skip: !hasJava }, async () => {
  for (const body of [Buffer.from('{"code":3,"message":"PRIVATE_TOKEN"}'), encrypted({ code: 3, message: 'PRIVATE_TOKEN' })]) {
    const { client } = setup({ transportReply: { statusCode: 200, body } });
    await assert.rejects(client.getNightVision(selection, 'cn'), reason('session_expired'));
  }
  const replies = [
    [{ code: 1, message: 'PRIVATE_TOKEN' }, 'night_vision_rejected'],
    [{ code: 0, result: [] }, 'night_vision_unavailable'],
    [{ code: 0, result: [...success(0).result, ...success(0).result] }, 'night_vision_unavailable'],
    [{ code: 0, result: [{ did: '3', siid: 2, piid: 3, code: -70402 }] }, 'night_vision_rejected'],
    [success(3), 'night_vision_unavailable'], [success('2'), 'night_vision_unavailable'],
  ];
  for (const [reply, expected] of replies) {
    const { client } = setup({ replies: [reply] }); await assert.rejects(client.getNightVision(selection, 'cn'), reason(expected));
  }
  for (const reply of [{ statusCode: 302, body: Buffer.from('PRIVATE_TOKEN') },
    { statusCode: 200, body: Buffer.alloc(65537) }, { statusCode: 200, body: Buffer.from('!PRIVATE_TOKEN!') }]) {
    const { client } = setup({ transportReply: reply });
    await assert.rejects(client.getNightVision(selection, 'cn'), error => error instanceof CloudControlError && !error.message.includes('PRIVATE'));
  }
});

test('credentials are loaded on each call, fixed regional hosts are used, and close/cancel are safe', { skip: !hasJava }, async () => {
  let reads = 0;
  const { client, seen } = setup({ client: { readJson: async file => {
    reads++; return file.endsWith('credentials.json') ? credentials : { ...capability, region: 'sg' };
  } }, replies: [success(0), success(1)] });
  await client.getNightVision(selection, 'sg'); await client.getNightVision(selection, 'sg');
  assert.equal(reads, 4); assert.equal(seen[0].url, 'https://sg.api.io.mi.com/app/miotspec/prop/get');
  const abort = new AbortController(); abort.abort();
  await assert.rejects(client.getNightVision(selection, 'sg', { signal: abort.signal }), reason('query_cancelled'));
  client.close(); await assert.rejects(client.getNightVision(selection, 'sg'), reason('runtime_closed'));
});

test('real private-file reader rejects symlink cache and oversized credentials without network access', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mijia-cloud-control-'));
  let calls = 0;
  try {
    await mkdir(path.join(directory, '.micam'), { mode: 0o700 });
    await writeFile(path.join(directory, '.micam/credentials.json'), JSON.stringify(credentials), { mode: 0o600 });
    await writeFile(path.join(directory, 'target.json'), JSON.stringify(capability), { mode: 0o600 });
    await symlink(path.join(directory, 'target.json'), path.join(directory, '.micam/night-vision-capability.json'));
    const client = new CloudControlClient({ storagePath: directory, now: () => timestamp, request: async () => { calls++; } });
    await assert.rejects(client.getNightVision(selection, 'cn'), error => error.capabilityRequired === true);
    await writeFile(path.join(directory, '.micam/credentials.json'), ' '.repeat(16385));
    await assert.rejects(client.getNightVision(selection, 'cn'), reason('authentication_required'));
    assert.equal(calls, 0); client.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
