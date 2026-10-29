#!/usr/bin/env node
/**
 * 端到端冒烟测试。
 *
 * 直接以 stdio 起 MCP server，走真实飞书 API。默认只跑只读工具；
 * 加 `--write` 才会真的往会话里发消息（会把内容发到 FEISHU_DEFAULT_CHAT_ID）。
 *
 *   node scripts/smoke.mjs                 # 只读
 *   node scripts/smoke.mjs --write         # 含发送
 *   node scripts/smoke.mjs --only=feishu_whoami
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'packages', 'mcp', 'dist', 'server.js');

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const ONLY = args.find((a) => a.startsWith('--only='))?.slice('--only='.length);

// ── 读 .env（不引 dotenv，避免多一个依赖）──
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const i = line.indexOf('=');
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

const env = { ...loadEnvFile(path.join(ROOT, '.env')), ...process.env };

if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) {
  console.error('缺少 FEISHU_APP_ID / FEISHU_APP_SECRET；先复制 .env.example 成 .env 并填好');
  process.exit(2);
}
if (!fs.existsSync(SERVER)) {
  console.error(`找不到 ${SERVER}，先跑 pnpm build`);
  process.exit(2);
}

// ── 起 server ──
const child = spawn(process.execPath, [SERVER], {
  cwd: ROOT,
  env,
  stdio: ['pipe', 'pipe', 'pipe'],
});

let buf = '';
let nextId = 1;
const pending = new Map();
const tools = [];

child.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  }
});

let stderrAll = '';
child.stderr.on('data', (d) => {
  const s = d.toString();
  stderrAll += s;
  if (process.env.SMOKE_VERBOSE) process.stderr.write(`[server] ${s}`);
});

function rpc(method, params) {
  const id = nextId++;
  const payload = { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) };
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify(payload) + '\n');
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`${method} 超时`));
      }
    }, 120_000);
  });
}

function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }) + '\n');
}

function textOf(result) {
  return (result?.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
}

const results = [];

async function callTool(name, toolArgs = {}) {
  const started = Date.now();
  try {
    const res = await rpc('tools/call', { name, arguments: toolArgs });
    const elapsed = Date.now() - started;
    const text = textOf(res);
    const bad = Boolean(res?.isError);
    results.push({ name, ok: !bad, elapsed, text });
    console.log(`${bad ? '✗' : '✓'} ${name} (${elapsed}ms)`);
    if (text) console.log(text.split('\n').map((l) => `    ${l}`).join('\n'));
    return { ok: !bad, text, res };
  } catch (err) {
    const elapsed = Date.now() - started;
    results.push({ name, ok: false, elapsed, text: String(err.message ?? err) });
    console.log(`✗ ${name} (${elapsed}ms) 抛出：${err.message ?? err}`);
    return { ok: false, text: String(err.message ?? err) };
  }
}

async function main() {
  console.log('── initialize ──');
  const init = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'smoke', version: '0.1.0' },
  });
  console.log(`server: ${init.serverInfo.name}@${init.serverInfo.version}`);
  notify('notifications/initialized');

  console.log('\n── tools/list ──');
  const list = await rpc('tools/list', {});
  for (const t of list.tools) tools.push(t.name);
  console.log(`共 ${tools.length} 个工具：`);
  for (const t of list.tools) console.log(`  · ${t.name} — ${(t.description ?? '').slice(0, 60)}`);

  const want = (n) => !ONLY || n === ONLY;
  const has = (n) => tools.includes(n);

  console.log('\n── 只读工具 ──');
  if (want('feishu_whoami') && has('feishu_whoami')) await callTool('feishu_whoami');
  else if (want('feishu_whoami')) console.log('✗ feishu_whoami 未注册');

  if (want('feishu_chats') && has('feishu_chats')) await callTool('feishu_chats', { limit: 10 });
  else if (want('feishu_chats')) console.log('✗ feishu_chats 未注册');

  if (want('feishu_recent') && has('feishu_recent')) {
    await callTool('feishu_recent', { limit: 5 });
  } else if (want('feishu_recent')) console.log('✗ feishu_recent 未注册');

  const chatId = env.FEISHU_DEFAULT_CHAT_ID;
  if (want('feishu_members') && has('feishu_members')) {
    await callTool('feishu_members', chatId ? { chat_id: chatId } : {});
  } else if (want('feishu_members')) console.log('✗ feishu_members 未注册');

  if (WRITE) {
    console.log('\n── 写工具（真的会发到会话）──');

    if (has('feishu_send_text') && want('feishu_send_text')) {
      await callTool('feishu_send_text', {
        text: `dsh-feishu 冒烟测试 · ${new Date().toISOString()}`,
      });
    }

    if (has('feishu_send_file') && want('feishu_send_file')) {
      const tmp = path.join(ROOT, '.tmp', `smoke-${Date.now()}.txt`);
      fs.mkdirSync(path.dirname(tmp), { recursive: true });
      fs.writeFileSync(tmp, `dsh-feishu 文件通道自检\n${new Date().toISOString()}\n`);
      await callTool('feishu_send_file', { path: tmp, caption: '文件通道自检（可忽略）' });
    }

    if (has('feishu_send_info_card') && want('feishu_send_info_card')) {
      await callTool('feishu_send_info_card', {
        title: '冒烟测试',
        fields: [
          { label: '工具数', value: String(tools.length) },
          { label: '时间', value: new Date().toLocaleString('zh-CN') },
        ],
        footer: '来自 dsh-feishu smoke',
      });
    }
  } else {
    console.log('\n（跳过写工具；加 --write 才会真的发消息）');
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n── 汇总 ──`);
  console.log(`执行 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
  if (failed.length) {
    console.log('失败项：');
    for (const f of failed) console.log(`  · ${f.name}: ${f.text.slice(0, 200)}`);
  }
  if (stderrAll.trim() && !process.env.SMOKE_VERBOSE) {
    const lines = stderrAll.trim().split('\n');
    console.log(`\nserver 日志（末 ${Math.min(6, lines.length)} 行）：`);
    for (const l of lines.slice(-6)) console.log(`  ${l}`);
  }

  child.kill();
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('冒烟测试崩了：', err);
  child.kill();
  process.exit(1);
});
