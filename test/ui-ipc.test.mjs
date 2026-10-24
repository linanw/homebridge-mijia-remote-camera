import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRuntime } from '../lib/runtime-factory.mjs';

const assets = fileURLToPath(new URL('../assets/', import.meta.url));
const javaVariant = process.report?.getReport()?.header?.glibcVersionRuntime ? 'java' : 'java-musl';
const runtimeSkip = process.platform !== 'linux' || process.arch !== 'x64'
  ? 'The actual runtime integration requires Linux x64.'
  : !existsSync(join(assets, 'micam.jar'))
    ? 'Private assets/micam.jar is not distributed in the public source; provide the local runtime bundle to run this integration.'
    : !existsSync(join(assets, 'runtime', javaVariant, 'bin/java'))
      ? 'The private bundled Java runtime is unavailable; provide the complete local runtime bundle to run this integration.'
      : !existsSync(join(assets, 'runtime/ffmpeg'))
        ? 'Private assets/runtime/ffmpeg is unavailable; provide the complete local runtime bundle to run this integration.'
        : false;

test('actual Homebridge custom-UI child reaches the active standalone plugin over private IPC', { skip: runtimeSkip }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'mijia-ui-ipc-'));
  const runtime = await createRuntime({ storagePath: join(root, 'mijia-remote-camera'), config: {} });
  const link = join(root, 'plugin-ui-linked.js');
  await symlink(fileURLToPath(new URL('../homebridge-ui/server.js', import.meta.url)), link);
  const server = fork(link, [], {
    env: { ...process.env, HOMEBRIDGE_STORAGE_PATH: root }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  function waitFor(match) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { server.off('message', listener); reject(Error('UI IPC timeout')); }, 5000);
      function listener(value) { if (match(value)) { clearTimeout(timer); server.off('message', listener); resolve(value); } }
      server.on('message', listener);
    });
  }
  try {
    await waitFor(value => value.action === 'ready');
    const response = waitFor(value => value.action === 'response');
    server.send({ action: 'request', path: '/status', requestId: 'status-fixture', body: {} });
    const result = await response;
    assert.equal(result.payload.success, true);
    assert.equal(result.payload.data.authenticated, false);
    assert.equal(result.payload.data.selected, false);
  } finally {
    server.kill('SIGTERM');
    await new Promise(resolve => server.exitCode !== null || server.signalCode !== null ? resolve() : server.once('exit', resolve));
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});
