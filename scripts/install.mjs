#!/usr/bin/env node
/**
 * 一键安装器 —— 替代「手写 YAML + wrapper + env 三件套」。
 *
 *   node scripts/install.mjs --app-id cli_xxx --app-secret xxx --chat-id oc_xxx
 *   node scripts/install.mjs --app-id ... --profile headless --dir ~/.local/bin
 *   node scripts/install.mjs --uninstall
 *
 * 它做五件事：
 *   1. 校验凭据（真调一次飞书 API，不是只看格式）
 *   2. 写密钥文件（0600）
 *   3. 写启动 wrapper（把密钥 source 进来，不让密钥进 YAML）
 *   4. 幂等修改 cordis.patch.yml（用 `- insert:` 块，已存在就更新）
 *   5. 打印下一步 + 自检命令
 *
 * 每一步都可单独重跑；--uninstall 只回滚第 3、4 步，不动密钥文件。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const isWin = process.platform === 'win32';
const HOME = os.homedir();
const DSH_HOME = process.env.DSH_HOME ?? path.join(HOME, '.dsh');

// ─────────────────────────── 参数 ───────────────────────────

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const profile = typeof args.profile === 'string' ? args.profile : 'headless';
const installDir =
  typeof args.dir === 'string' ? args.dir : path.join(HOME, '.local', 'bin');
const envFile = path.join(HOME, '.config', 'dsh', 'feishu.env');
const wrapperPath = path.join(installDir, isWin ? 'dsh-feishu-mcp.cmd' : 'dsh-feishu-mcp');
const patchPath = path.join(DSH_HOME, 'profiles', profile, 'cordis.patch.yml');

function log(msg) {
  process.stdout.write(`${msg}\n`);
}
function warn(msg) {
  process.stdout.write(`⚠️  ${msg}\n`);
}
function die(msg, code = 1) {
  process.stderr.write(`✗ ${msg}\n`);
  process.exit(code);
}

// ─────────────────────────── 1. 凭据校验 ───────────────────────────

async function verifyCredentials(appId, appSecret) {
  const url = 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    signal: AbortSignal.timeout(15000),
  });
  const json = await res.json();
  if (json.code !== 0 || !json.tenant_access_token) {
    die(`凭据无效：code=${json.code} msg=${json.msg ?? ''}`);
  }
  return json.tenant_access_token;
}

async function verifyChat(token, chatId) {
  const res = await fetch(
    `https://open.feishu.cn/open-apis/im/v1/chats/${encodeURIComponent(chatId)}`,
    { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) },
  );
  const json = await res.json();
  if (json.code !== 0) {
    warn(`默认会话校验失败（code=${json.code} msg=${json.msg}）—— 机器人可能没被拉进这个群`);
    return null;
  }
  return json.data?.name ?? '(无名)';
}

// ─────────────────────────── 2. 写文件 ───────────────────────────

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function writeEnvFile(appId, appSecret, chatId) {
  ensureDir(path.dirname(envFile));
  const lines = [
    '# dsh-feishu 凭据 —— 由 scripts/install.mjs 生成，不要提交',
    `FEISHU_APP_ID=${appId}`,
    `FEISHU_APP_SECRET=${appSecret}`,
  ];
  if (chatId) lines.push(`FEISHU_DEFAULT_CHAT_ID=${chatId}`);
  fs.writeFileSync(envFile, lines.join('\n') + '\n', { mode: 0o600 });
  try {
    fs.chmodSync(envFile, 0o600);
  } catch {
    /* Windows 上 chmod 是尽力而为 */
  }
  log(`✓ 写入密钥文件 ${envFile}（0600）`);
}

function writeWrapper() {
  ensureDir(installDir);
  const mjsPath = path.join(installDir, 'dsh-feishu-mcp.mjs');
  if (!fs.existsSync(mjsPath)) {
    warn(`没找到 ${mjsPath} —— 先把 dist-single/dsh-feishu-mcp.mjs 拷过来`);
  }

  if (isWin) {
    const content = [
      '@echo off',
      'rem dsh-feishu MCP 启动包装：凭据从 feishu.env 读，不落进任何 YAML',
      `for /f "usebackq tokens=1,* delims==" %%a in ("${envFile}") do set "%%a=%%b"`,
      `node "${mjsPath}"`,
    ].join('\r\n');
    fs.writeFileSync(wrapperPath, content + '\r\n');
  } else {
    const content = [
      '#!/usr/bin/env bash',
      '# dsh-feishu MCP 启动包装：凭据从 feishu.env 读，不落进任何 YAML',
      'set -a',
      `. "${envFile}"`,
      'set +a',
      `exec "${process.execPath}" "${mjsPath}"`,
    ].join('\n');
    fs.writeFileSync(wrapperPath, content + '\n', { mode: 0o755 });
    try {
      fs.chmodSync(wrapperPath, 0o755);
    } catch {
      /* ignore */
    }
  }
  log(`✓ 写入启动包装 ${wrapperPath}`);
}

// ─────────────────────────── 3. 改 cordis.patch.yml ───────────────────────────

// 定位只比**前缀**（设置页插件同款做法）：括注是给人看的说明，两边文案演化速度不一样，
// 整行严格比对一旦差几个字，就会把已存在的块当成不存在、再插一份进去。
const BLOCK_START_PREFIX = '# >>> dsh-feishu managed block';
const BLOCK_END_PREFIX = '# <<< dsh-feishu managed block';
const BLOCK_START = `${BLOCK_START_PREFIX} (由设置页 / scripts/install.mjs 维护，手改会被覆盖)`;
const BLOCK_END = BLOCK_END_PREFIX;

/** 按行找哨兵，返回块在原文里的字符区间（含两端哨兵行）。 */
function locateBlock(text) {
  let offset = 0;
  let start = -1;
  for (const line of text.split('\n')) {
    const marker = line.trim();
    if (start < 0) {
      if (marker.startsWith(BLOCK_START_PREFIX)) start = offset;
    } else if (marker.startsWith(BLOCK_END_PREFIX)) {
      return { start, end: offset + line.length };
    }
    offset += line.length + 1;
  }
  return null;
}

function yamlBlock() {
  // Windows 上 DSH 直接 spawn 一个 .cmd 会失败，必须走 cmd /c
  const lines = [
    BLOCK_START,
    '- insert:',
    '    - id: mcp-feishu',
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        serverName: feishu',
    '        transport: stdio',
  ];
  if (isWin) {
    lines.push('        command: cmd');
    lines.push(`        args: ['/c', ${JSON.stringify(wrapperPath)}]`);
  } else {
    lines.push(`        command: ${JSON.stringify(wrapperPath)}`);
    lines.push('        args: []');
  }
  lines.push('        toolCallTimeoutMs: 660000');
  lines.push('        failOnStartupError: false');
  lines.push(BLOCK_END);
  return lines.join('\n');
}

function patchProfile() {
  ensureDir(path.dirname(patchPath));
  let text = fs.existsSync(patchPath) ? fs.readFileSync(patchPath, 'utf8') : '';
  if (text.trim() === '') text = '[]\n';

  const bounds = locateBlock(text);

  if (bounds !== null) {
    const before = text.slice(0, bounds.start);
    const after = text.slice(bounds.end);
    text = before.trimEnd() + '\n' + yamlBlock() + after;
    log(`✓ 更新 ${patchPath} 里已有的 dsh-feishu 块`);
  } else {
    const backup = `${patchPath}.bak-feishu-${Date.now()}`;
    fs.copyFileSync(patchPath, backup);
    log(`  已备份原配置到 ${path.basename(backup)}`);

    // 空数组 `[]` 占位要拿掉，否则插不进去
    let base = text.replace(/^\s*\[\s*\]\s*$/m, '').trimEnd();
    if (base === '') base = '';
    text = (base ? base + '\n\n' : '') + yamlBlock() + '\n';
    log(`✓ 写入 ${patchPath}`);
  }
  fs.writeFileSync(patchPath, text);
}

function unpatchProfile() {
  if (!fs.existsSync(patchPath)) {
    warn(`没有 ${patchPath}，无需回滚`);
    return;
  }
  const text = fs.readFileSync(patchPath, 'utf8');
  const bounds = locateBlock(text);
  if (bounds === null) {
    warn('配置里没有 dsh-feishu 块，无需回滚');
    return;
  }
  const cleaned = (text.slice(0, bounds.start).trimEnd() + '\n' + text.slice(bounds.end))
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
  fs.writeFileSync(patchPath, cleaned === '' ? '[]\n' : cleaned + '\n');
  log(`✓ 已从 ${patchPath} 移除 dsh-feishu 块`);
}

// ─────────────────────────── 4. 自检 ───────────────────────────

function selfCheck() {
  const dshBin = isWin ? 'dsh.cmd' : 'dsh';
  const r = spawnSync(dshBin, ['--profile', profile, '--dump-config'], {
    encoding: 'utf8',
    timeout: 60000,
    shell: isWin,
  });
  if (r.error) {
    warn(`dsh --dump-config 跑不起来（${r.error.message}）—— 手动执行：dsh --profile ${profile} --dump-config | grep -A9 mcp-feishu`);
    return;
  }
  const combined = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (combined.includes('mcp-feishu')) {
    log(`✓ 配置树里已出现 mcp-feishu`);
  } else {
    warn(`配置树里没找到 mcp-feishu，检查 ${patchPath}`);
  }
  const errLine = combined
    .split('\n')
    .find(
      (l) =>
        /^\s*(dsh:|error|Error|patch:)/i.test(l) &&
        !l.includes('mcp-feishu') &&
        !l.includes('failOnStartupError'),
    );
  if (errLine) warn(`dsh 报了点什么：${errLine.trim()}`);
}

// ─────────────────────────── main ───────────────────────────

async function main() {
  log('dsh-feishu 安装器\n');

  if (args.uninstall) {
    unpatchProfile();
    if (fs.existsSync(wrapperPath)) {
      fs.rmSync(wrapperPath, { force: true });
      log(`✓ 删除 ${wrapperPath}`);
    }
    log('\n密钥文件保留（要清就手动删 ' + envFile + '）');
    return;
  }

  const appId = typeof args['app-id'] === 'string' ? args['app-id'].trim() : '';
  const appSecret = typeof args['app-secret'] === 'string' ? args['app-secret'].trim() : '';
  const chatId = typeof args['chat-id'] === 'string' ? args['chat-id'].trim() : '';

  if (!appId || !appSecret) {
    die(
      '缺参数。用法：\n' +
        '  node scripts/install.mjs --app-id cli_xxx --app-secret xxx --chat-id oc_xxx\n' +
        '  可选：--profile <名字>（默认 headless）、--dir <安装目录>、--skip-check',
    );
  }

  log(`目标 profile：${profile}`);
  log(`安装目录：${installDir}`);
  log(`配置文件：${patchPath}\n`);

  let token = null;
  if (args['skip-check']) {
    warn('跳过凭据校验（--skip-check）');
  } else {
    process.stdout.write('正在校验凭据… ');
    token = await verifyCredentials(appId, appSecret);
    log('✓');
  }

  if (chatId && token) {
    process.stdout.write('正在校验默认会话… ');
    const name = await verifyChat(token, chatId);
    log(name ? `✓ ${name}` : '（跳过）');
  }

  writeEnvFile(appId, appSecret, chatId);
  writeWrapper();
  patchProfile();

  log('\n── 自检 ──');
  selfCheck();

  log('\n完成。下一步：');
  log('  1. 重启 DSH（Web GUI 或桌面 App）');
  log(`  2. 让模型报一下工具：echo '你有哪些 mcp__feishu__ 工具？只列名字' | dsh --profile ${profile} --json -`);
  log('  3. 想验证发文件：pnpm smoke:write');
}

main().catch((err) => {
  die(err instanceof Error ? (err.stack ?? err.message) : String(err));
});
