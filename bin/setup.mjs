#!/usr/bin/env node
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { importRuntimeAssets } from '../lib/runtime-assets.mjs';

const usage = '用法: mijia-camera-setup --from <已有的本地 .tgz 或 assets 目录> --storage <Homebridge 数据目录>\n例如: mijia-camera-setup --from /homebridge/homebridge-mijia-remote-camera-0.1.0.tgz --storage /homebridge';
const values = {};
let valid = true;
for (let index = 2; index < process.argv.length; index++) {
  const key = process.argv[index];
  if (!['--from', '--storage'].includes(key) || !process.argv[index + 1] || process.argv[index + 1].startsWith('--') || values[key]) { valid = false; break; }
  values[key] = process.argv[++index];
}
if (!valid || !values['--from']) {
  console.error(usage);
  process.exitCode = 2;
} else {
  try {
    await importRuntimeAssets({ source: resolve(values['--from']),
      homebridgeStoragePath: resolve(values['--storage'] || process.env.UIX_STORAGE_PATH || process.env.HOMEBRIDGE_STORAGE_PATH || `${homedir()}/.homebridge`) });
    console.log('运行组件已从本地导入并完成校验。请重启 Homebridge，然后打开插件设置登录米家。');
  } catch (error) {
    const messages = { runtime_in_use: 'Homebridge 正在使用此插件。请先停用插件并重启 Homebridge，再重新导入。',
      runtime_components_missing: '本地安装包缺少运行组件。', runtime_components_invalid: '组件校验失败，请使用此前提供的完整安装包。',
      storage_failed: '无法写入 Homebridge 数据目录，请检查目录和运行用户。' };
    console.error(messages[error.reason] || '导入失败，请检查本地安装包路径和 Homebridge 数据目录。');
    process.exitCode = 1;
  }
}
