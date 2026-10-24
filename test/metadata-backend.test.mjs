import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const java = path.join(root, 'assets/runtime/java/bin/java');
const jar = path.join(root, 'assets/micam.jar');
const compiler = spawnSync('javac', ['-version'], { encoding: 'utf8' });
const ready = process.platform === 'linux' && process.arch === 'x64' && existsSync(java) && existsSync(jar) && compiler.status === 0;

test('cloud metadata Java validates reads and guarded single-write rename/move with independent fake cloud fixtures', { skip: !ready }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mijia-meta-java-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = { ...process.env };
  delete env.JAVA_TOOL_OPTIONS; delete env._JAVA_OPTIONS; delete env.JDK_JAVA_OPTIONS;
  // Compile into the temporary test directory; never replace canonical backend/bridge.jar.
  const built = spawnSync('javac', ['--release', '21', '-cp', jar, '-d', directory,
    path.join(root, 'backend/CloudMetadata.java'), path.join(root, 'test/fixtures/CloudMetadataProbe.java'),
    path.join(root, 'test/fixtures/CloudMetadataWriteProbe.java'),
    path.join(root, 'test/fixtures/CloudMetadataOutputProbe.java')], { encoding: 'utf8', env, timeout: 15000 });
  assert.equal(built.status, 0, built.stderr);
  const result = spawnSync(java, ['-cp', `${jar}:${directory}`, 'mijia.bridge.CloudMetadataProbe'], { encoding: 'utf8', env, timeout: 5000 });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, '');
  const report = JSON.parse(result.stdout);
  assert.equal(report.success, true); assert.ok(report.checks >= 30);
  // Node's JSON serialization independently fixes the Java revision hash's Unicode and room ordering contract.
  const expectedFingerprint = createHash('sha256').update(JSON.stringify(['803', '202', '22', 'cn', '云端摄像头',
    '家庭', '4', '客厅', [['202', '默认'], ['4', '客厅'], ['5', '卧室']]])).digest('hex');
  const unicodeName = '摄像头'.repeat(52) + '📷📷';
  const unicodeFingerprint = createHash('sha256').update(JSON.stringify(['803', '202', '22', 'cn', unicodeName,
    '家庭', '4', '客厅', [['202', '默认'], ['4', '客厅'], ['5', '卧室']]])).digest('hex');
  const writes = spawnSync(java, ['-cp', `${jar}:${directory}`, 'mijia.bridge.CloudMetadataWriteProbe', expectedFingerprint, unicodeFingerprint],
    { encoding: 'utf8', env, timeout: 5000 });
  assert.equal(writes.status, 0, writes.stderr); assert.equal(writes.stderr, '');
  const writeReport = JSON.parse(writes.stdout);
  assert.equal(writeReport.success, true); assert.ok(writeReport.checks >= 100); assert.equal(writeReport.singleWrites, 17);
  // Exercise the actual JSON emitter under the NAS container's distinct stdout encoding.
  const emitted = spawnSync(java, ['-Dfile.encoding=UTF-8', '-Dstdout.encoding=US-ASCII', '-cp', `${jar}:${directory}`,
    'mijia.bridge.CloudMetadataOutputProbe'], { encoding: 'utf8', env, timeout: 5000 });
  assert.equal(emitted.status, 0, emitted.stderr); assert.equal(emitted.stderr, '');
  const unicodeOutput = JSON.parse(emitted.stdout);
  assert.equal(unicodeOutput.stdoutEncoding, 'US-ASCII');
  assert.equal(unicodeOutput.name, '米家摄像头📷'); assert.equal(unicodeOutput.homeName, '家庭🏡');
  assert.equal(unicodeOutput.roomName, '客厅🛋️');
  assert.deepEqual(unicodeOutput.rooms, [{ id: '4', name: '客厅🛋️' }, { id: '5', name: '卧室🛏️' }]);
  assert.equal(unicodeOutput.fingerprint, createHash('sha256').update(JSON.stringify([unicodeOutput.deviceId,
    unicodeOutput.homeId, unicodeOutput.homeOwner, unicodeOutput.region, unicodeOutput.name, unicodeOutput.homeName,
    unicodeOutput.roomId, unicodeOutput.roomName, unicodeOutput.rooms.map(room => [room.id, room.name])])).digest('hex'));
  const asciiEnv = { ...env, LANG: 'C', LC_ALL: 'C', LC_CTYPE: 'C' };
  const cliName = '新米家摄像头📷'.repeat(10);
  const cliArgs = ['rename64', 'cn', '202', '22', '803', '22', expectedFingerprint, Buffer.from(cliName).toString('base64')];
  const asciiCli = spawnSync(java, ['-Dfile.encoding=UTF-8', '-Dstdout.encoding=US-ASCII', '-cp', `${jar}:${directory}`,
    'mijia.bridge.CloudMetadataOutputProbe', ...cliArgs], { encoding: 'utf8', env: asciiEnv, timeout: 5000 });
  assert.equal(asciiCli.status, 0, asciiCli.stderr); assert.equal(asciiCli.stderr, '');
  const cliOutput = JSON.parse(asciiCli.stdout);
  assert.equal(cliOutput.nativeEncoding, 'ANSI_X3.4-1968');
  assert.equal(cliOutput.name, cliName);
  assert.equal(cliOutput.fingerprint, createHash('sha256').update(JSON.stringify([cliOutput.deviceId,
    cliOutput.homeId, cliOutput.homeOwner, cliOutput.region, cliOutput.name, cliOutput.homeName,
    cliOutput.roomId, cliOutput.roomName, cliOutput.rooms.map(room => [room.id, room.name])])).digest('hex'));
  // The real entrypoint rejects bad canonical Base64/UTF-8/name bounds before credential loading or HTTP.
  for (const encoded of ['@@', 'YQ', 'YR==', 'YQ==\n', '/w==', '7aCA', 'bmFtZQ== ',
    Buffer.from(' name').toString('base64'), Buffer.from('x'.repeat(161)).toString('base64'), 'eA=='.repeat(161)]) {
    const invalid = spawnSync(java, ['-Dstdout.encoding=US-ASCII', '-cp', `${jar}:${directory}`,
      'mijia.bridge.CloudMetadata', ...cliArgs.slice(0, 7), encoded], { encoding: 'utf8', env: asciiEnv, timeout: 5000 });
    assert.equal(invalid.status, 7, invalid.stderr); assert.equal(invalid.stderr, '');
    assert.deepEqual(JSON.parse(invalid.stdout), { success: false, reason: 'invalid_request' });
  }
  const privateHome = path.join(directory, 'private'); await mkdir(path.join(privateHome, '.micam'), { recursive: true });
  const credentials = path.join(privateHome, '.micam/credentials.json'); await writeFile(credentials, '{}');
  for (const args of [['get', 'cn', '202', '22', '803', '123'], ['set', 'cn', '202', '22', '803', '123']]) {
    const run = spawnSync(java, [`-Duser.home=${privateHome}`, '-cp', `${jar}:${directory}`, 'mijia.bridge.CloudMetadata', ...args], { encoding: 'utf8', env, timeout: 5000 });
    assert.equal(run.stderr, '');
    assert.deepEqual(JSON.parse(run.stdout), { success: false, reason: args[0] === 'get' ? 'authentication_required' : 'invalid_request' });
    assert.equal(await readFile(credentials, 'utf8'), '{}');
  }
  const fakeSession = JSON.stringify({ userId: '123', region: 'cn', ssecurity: 'fixture-security', serviceToken: 'fixture-token' });
  await writeFile(credentials, fakeSession);
  const denied = spawnSync(java, [`-Duser.home=${privateHome}`, '-cp', `${jar}:${directory}`, 'mijia.bridge.CloudMetadata',
    'rename', 'cn', '202', '22', '803', '123', expectedFingerprint, 'new'], { encoding: 'utf8', env, timeout: 5000 });
  assert.equal(denied.stderr, ''); assert.equal(denied.status, 7);
  assert.deepEqual(JSON.parse(denied.stdout), { success: false, reason: 'metadata_not_owner' });
  assert.equal(await readFile(credentials, 'utf8'), fakeSession);
  // A valid-looking synthetic session still cannot dispatch when the on-disk selected camera changed.
  const ownSession = JSON.stringify({ userId: '22', region: 'cn', ssecurity: 'fixture-security', serviceToken: 'fixture-token' });
  await writeFile(credentials, ownSession);
  const selectionFile = path.join(privateHome, 'selection.json');
  for (const selection of [null, { homeId: '202', homeOwner: '22', deviceId: '999', region: 'cn' },
    { homeId: '999', homeOwner: '22', deviceId: '803', region: 'cn' },
    { homeId: '202', homeOwner: '123', deviceId: '803', region: 'cn' },
    { homeId: '202', homeOwner: '22', deviceId: '803', region: 'sg' }]) {
    if (selection) await writeFile(selectionFile, JSON.stringify(selection));
    const changed = spawnSync(java, [`-Duser.home=${privateHome}`, '-cp', `${jar}:${directory}`, 'mijia.bridge.CloudMetadata',
      'rename', 'cn', '202', '22', '803', '22', expectedFingerprint, 'new'], { encoding: 'utf8', env, timeout: 5000 });
    assert.equal(changed.stderr, ''); assert.equal(changed.status, 7);
    assert.deepEqual(JSON.parse(changed.stdout), { success: false, reason: 'metadata_conflict' });
    assert.equal(await readFile(credentials, 'utf8'), ownSession);
  }
});
