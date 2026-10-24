#!/usr/bin/env node
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createRpcClient } from '../lib/rpc.mjs';
import { safeDiagnostics } from '../lib/diagnostics.mjs';

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--storage' || !args[1] || args[1].startsWith('--'))) {
  console.error('用法: mijia-camera-diagnose --storage <Homebridge 数据目录>');
  process.exitCode = 2;
} else {
  const storage = resolve(args[1] || process.env.HOMEBRIDGE_STORAGE_PATH || process.env.UIX_STORAGE_PATH || join(homedir(), '.homebridge'));
  try {
    const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    const state = await createRpcClient(join(storage, 'mijia-remote-camera')).request('status', {});
    console.log(JSON.stringify({ pluginVersion: metadata.version, ...safeDiagnostics(state) }, null, 2));
  } catch {
    console.error('无法读取运行状态。请确认 Homebridge 已启动，且 --storage 指向其实际数据目录。');
    process.exitCode = 1;
  }
}
