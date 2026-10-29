#!/usr/bin/env node
/**
 * 端到端闭环验证：群里真有文件 → 下载到本地 → 校验落盘。
 * 这是"用户发文件给 agent 处理"这条链路的实证。
 *
 *   node scripts/e2e-download.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '../packages/core/dist/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const i = line.indexOf('=');
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[line.slice(0, i).trim()] = v;
  }
  return out;
}

const env = { ...loadEnvFile(path.join(ROOT, '.env')), ...process.env };
const chatId = env.FEISHU_DEFAULT_CHAT_ID;
if (!chatId) {
  console.error('缺少 FEISHU_DEFAULT_CHAT_ID');
  process.exit(2);
}

const client = createClient(env);

const { items } = await client.listMessages(chatId, { pageSize: 15, sort: 'desc' });
console.log(`拉到 ${items.length} 条消息：`);
for (const m of items) {
  const c = (m.content ?? {}) || {};
  const name = c.file_name ?? c.fileName ?? c.image_key ?? c.file_key ?? '';
  console.log(`  [${m.msgType}] ${String(name).slice(0, 46)}  mid=${m.messageId}`);
}

const target = items.find((m) => m.msgType === 'file' || m.msgType === 'image');
if (!target) {
  console.log('\n没有找到可下载的附件消息，跳过下载测试');
  process.exit(0);
}

const content = (target.content ?? {}) || {};
const fileKey = content.file_key ?? content.fileKey;
const imageKey = content.image_key ?? content.imageKey;
const kind = target.msgType === 'image' ? 'image' : 'file';
const key = kind === 'image' ? imageKey : fileKey;

if (!key) {
  console.error('消息里有附件标记但取不到 key：', JSON.stringify(content).slice(0, 200));
  process.exit(1);
}

const destDir = path.join(ROOT, '.tmp', 'downloads');
const dest = path.join(destDir, `e2e-${Date.now()}-${String(content.file_name ?? 'download.bin')}`);

console.log(`\n下载 ${kind} key=${key.slice(0, 24)}…`);
const res = await client.downloadMessageResource(target.messageId, key, kind, dest);

console.log(`✓ 落盘：${res.path}`);
console.log(`  字节：${res.bytes}`);
console.log(`  mime：${res.mimeType ?? '(未知)'}`);

const stat = fs.statSync(res.path);
if (stat.size !== res.bytes || stat.size === 0) {
  console.error('✗ 落盘大小不符');
  process.exit(1);
}
const head = fs.readFileSync(res.path).subarray(0, 8);
console.log(`  头 8 字节：${head.toString('hex')}`);

// zip 的文件头是 50 4B，docx 也是（zip 容器）
const magic = head.toString('hex').toUpperCase();
const known =
  magic.startsWith('504B') ? 'ZIP/DOCX/XLSX 容器' :
  magic.startsWith('89504E47') ? 'PNG' :
  magic.startsWith('FFD8') ? 'JPEG' :
  magic.startsWith('25504446') ? 'PDF' :
  '(未知类型)';
console.log(`  识别：${known}`);

fs.rmSync(res.path, { force: true });
console.log('\n✓ 闭环验证通过（临时文件已清理）');
