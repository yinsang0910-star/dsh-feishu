/**
 * dsh-feishu 设置页 —— 服务端（Cordis host 半侧）入口。
 *
 * 一条具名路由 `POST /dsh-feishu/api` 收三种 op：
 *   · `status`  读 env 文件 + profile 的 patch 文件，回报当前状态（**永不回传 secret 明文**）
 *   · `test`    真调飞书 `tenant_access_token` + `im/v1/chats/{id}` 校验凭据
 *   · `save`    写 `~/.config/dsh/feishu.env`（0600，原子写）+ 幂等维护 profile
 *               `cordis.patch.yml` 里的 managed block（语义与 scripts/install.mjs 一致，
 *               但这里自己实现，不 shell 调脚本）
 *
 * 加载链路、`inject` 语义、`webServer.register` 形状、来源校验的必要性
 * 都在同目录 README 里有行号级依据：
 *   · 服务就绪门槛 → README §5.1（别把不确定的服务名塞进 inject，§5.3）
 *   · 路由注册 → README §4.1/§4.2（`ctx.effect` 包住以获得自动注销）
 *   · 来源校验 → README §3.4/§4.3（自挂路由不在 `/api` 的浏览器认证栅栏里）
 *
 * 运行期只 import `node:` 内建模块；不 import 任何第三方包。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

/** Cordis 里的插件名，用于日志/诊断。 */
export const name = 'dsh-feishu-settings'

/** 必需服务：只写确实要用、且在目标 profile 里必然存在的那个。 */
export const inject: string[] = ['webServer']

const DEFAULT_PATH = '/dsh-feishu/api'
const MAX_BODY_BYTES = 64 * 1024

/** 本包名（同时也是浏览器 bundle 的 `__ModuleLoader__` id）。 */
const PACKAGE_NAME = '@dsh-feishu/dsh-plugin'

const ENV_HEADER = '# dsh-feishu 凭据 —— 由 DSH 的飞书设置页生成，不要提交'

/** managed block 的哨兵行，与 scripts/install.mjs 用同一对文案，两边可以互相接手。 */
const BLOCK_START = '# >>> dsh-feishu managed block (由设置页 / scripts/install.mjs 维护，手改会被覆盖)'
const BLOCK_END = '# <<< dsh-feishu managed block'

/** patch 里那一行 MCP entry 的 id 与它要加载的包（install.mjs:166-167 同款）。 */
const MCP_ENTRY_ID = 'mcp-feishu'
const MCP_SERVER_NAME = 'feishu'
const MCP_CLIENT_PACKAGE = '@deepseek-ai/dsh-mcp-client'

const FEISHU_ORIGIN = 'https://open.feishu.cn'
const HTTP_TIMEOUT_MS = 15_000

const IS_WINDOWS = process.platform === 'win32'

/** env 文件里本插件负责的三个键（写入顺序固定）。 */
const ENV_ORDER = ['FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'FEISHU_DEFAULT_CHAT_ID'] as const

/* ──────────────────────────── 宿主服务的最小类型面 ──────────────────────────── */

interface WebRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}
interface WebServerLike {
  /** 重复的 (kind, path) 会抛错；返回值是注销函数。 */
  register(route: WebRoute): () => void
}
interface LoggerLike {
  info(format: string, ...args: unknown[]): void
  warn?(format: string, ...args: unknown[]): void
}
interface PluginContext {
  webServer: WebServerLike
  logger: LoggerLike
  /** 把清理函数挂到插件生命周期：禁用/热重载时自动注销。 */
  effect(execute: () => (() => void) | void, label?: string): unknown
}

/** patch 行里的 config（全部可选，默认值见 resolveTargets）。 */
interface PluginConfig {
  /** 路由路径，默认 `/dsh-feishu/api`。必须唯一（重复 (kind,path) 会抛错）。 */
  endpointPath?: string
  /** 覆盖凭据文件路径（离线测试用）。默认 `~/.config/dsh/feishu.env`。 */
  envPath?: string
  /** 目标 profile 名；不写就自动探测（见 resolveProfile）。 */
  profile?: string
  /** 目标 profile 目录；给出时优先级最高。 */
  profileDir?: string
  /** `$DSH_HOME`；默认取 env.DSH_HOME，否则 `~/.dsh`。 */
  dshHome?: string
  /** profiles 根目录；默认 `<dshHome>/profiles`。 */
  profilesRoot?: string
  /** 覆盖家目录（离线测试用）。 */
  homeDir?: string
  /** MCP 启动包装路径；默认 `~/.local/bin/dsh-feishu-mcp[.cmd]`。 */
  mcpWrapperPath?: string
}

/* ──────────────────────────── 错误 ──────────────────────────── */

/** 带 HTTP 状态码的业务错误：handler 统一映射成 JSON。 */
class ApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
    this.name = 'ApiError'
  }
}

/* ──────────────────────────── HTTP 小工具 ──────────────────────────── */

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(text)),
  })
  res.end(text)
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.length
    if (size > MAX_BODY_BYTES) throw new ApiError(413, `请求体超过 ${MAX_BODY_BYTES} 字节`)
    chunks.push(buf)
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (raw === '') return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('body must be a JSON object')
    }
    return parsed as Record<string, unknown>
  } catch (error) {
    throw new ApiError(400, `请求体不是合法 JSON：${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * 自定义具名路由不经过 `/api` 的浏览器认证栅栏（那条路由归 client-connection 独占），
 * 跨源判断必须插件自己做：回环放行，非回环要求 Origin 与 Host 同源。
 * 这段逻辑（含回环地址白名单）沿用骨架实现，所有 op 都要先过它。
 */
function trustedOrigin(req: IncomingMessage): boolean {
  const remote = req.socket.remoteAddress
  if (remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1') return true
  const host = req.headers.host
  if (host === undefined || host === '') return false
  const origin = req.headers.origin
  if (origin === undefined || origin === '' || origin === 'null') return true
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/* ──────────────────────────── 路径 / 文件 ──────────────────────────── */

function expandTilde(value: string): string {
  if (value === '~') return os.homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(os.homedir(), value.slice(2))
  return value
}

interface Targets {
  homeDir: string
  dshHome: string
  envPath: string
  profilesRoot: string
  wrapperPath: string
}

function resolveTargets(config: PluginConfig): Targets {
  const homeDir =
    typeof config.homeDir === 'string' && config.homeDir !== ''
      ? expandTilde(config.homeDir)
      : os.homedir()
  const envOverride = process.env['DSH_HOME']
  const dshHome =
    typeof config.dshHome === 'string' && config.dshHome !== ''
      ? expandTilde(config.dshHome)
      : typeof envOverride === 'string' && envOverride !== ''
        ? expandTilde(envOverride)
        : path.join(homeDir, '.dsh')
  const envPath =
    typeof config.envPath === 'string' && config.envPath !== ''
      ? expandTilde(config.envPath)
      : path.join(homeDir, '.config', 'dsh', 'feishu.env')
  const profilesRoot =
    typeof config.profilesRoot === 'string' && config.profilesRoot !== ''
      ? expandTilde(config.profilesRoot)
      : path.join(dshHome, 'profiles')
  const wrapperPath =
    typeof config.mcpWrapperPath === 'string' && config.mcpWrapperPath !== ''
      ? expandTilde(config.mcpWrapperPath)
      : path.join(homeDir, '.local', 'bin', IS_WINDOWS ? 'dsh-feishu-mcp.cmd' : 'dsh-feishu-mcp')
  return { homeDir, dshHome, envPath, profilesRoot, wrapperPath }
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
}

function readTextOrNull(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

function statOrNull(file: string): fs.Stats | null {
  try {
    return fs.statSync(file)
  } catch {
    return null
  }
}

/**
 * 原子写：先写同目录 `.tmp` 再 rename 覆盖，避免半截文件。
 * rename 失败（Windows 上目标被占用 / AV 锁）时退化为 copy + 清理临时文件。
 */
function atomicWriteFile(file: string, text: string, mode: number): void {
  ensureDir(path.dirname(file))
  const tmp = `${file}.tmp-${process.pid.toString(36)}-${Date.now().toString(36)}`
  fs.writeFileSync(tmp, text, { encoding: 'utf8', mode })
  try {
    fs.chmodSync(tmp, mode)
  } catch {
    /* Windows 上 chmod 只影响只读位，尽力而为 */
  }
  try {
    fs.renameSync(tmp, file)
  } catch (renameError) {
    try {
      fs.copyFileSync(tmp, file)
    } catch {
      fs.rmSync(tmp, { force: true })
      throw renameError
    }
    fs.rmSync(tmp, { force: true })
  }
  try {
    fs.chmodSync(file, mode)
  } catch {
    /* 同上 */
  }
}

/* ──────────────────────────── env 文件 ──────────────────────────── */

function parseEnvText(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    if (key === '') continue
    let value = trimmed.slice(eq + 1).trim()
    const quoted =
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    if (quoted) value = value.slice(1, -1)
    out.set(key, value)
  }
  return out
}

function renderEnvText(values: Map<string, string>): string {
  const lines: string[] = [ENV_HEADER]
  const handled = new Set<string>()
  for (const key of ENV_ORDER) {
    handled.add(key)
    const value = values.get(key)
    if (value !== undefined && value !== '') lines.push(`${key}=${value}`)
  }
  const rest = [...values.keys()].filter((key) => !handled.has(key)).sort()
  const extra: string[] = []
  for (const key of rest) {
    const value = values.get(key)
    if (value !== undefined && value !== '') extra.push(`${key}=${value}`)
  }
  if (extra.length > 0) lines.push('', ...extra)
  return `${lines.join('\n')}\n`
}

interface EnvSnapshot {
  path: string
  exists: boolean
  appId: string | null
  chatId: string | null
  hasSecret: boolean
  secretTail: string | null
  fileMode: string | null
  modeApplied: boolean
  values: Map<string, string>
}

function readEnvSnapshot(envPath: string): EnvSnapshot {
  const text = readTextOrNull(envPath)
  const values = text === null ? new Map<string, string>() : parseEnvText(text)
  const secret = values.get('FEISHU_APP_SECRET') ?? ''
  const stat = text === null ? null : statOrNull(envPath)
  const fileMode = stat === null ? null : (stat.mode & 0o777).toString(8)
  return {
    path: envPath,
    exists: text !== null,
    appId: values.get('FEISHU_APP_ID') ?? null,
    chatId: values.get('FEISHU_DEFAULT_CHAT_ID') ?? null,
    hasSecret: secret !== '',
    secretTail: secret.length >= 4 ? secret.slice(-4) : secret === '' ? null : `**${secret}`,
    fileMode,
    modeApplied: stat === null ? false : IS_WINDOWS ? true : (stat.mode & 0o777) === 0o600,
    values,
  }
}

/* ──────────────────────────── profile / patch ──────────────────────────── */

/** profile 名只允许出现在 profiles 根目录的一层里，挡住请求里塞进来的 `../`。 */
function validateProfileName(name: string): string | null {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return 'profile 名只能包含字母、数字、点、下划线、连字符'
  if (name === '.' || name.startsWith('..')) return 'profile 名不合法（不允许 . 或 .. 开头）'
  return null
}

function listProfiles(profilesRoot: string): string[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(profilesRoot, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => entry.name)
    .filter((entry) => entry !== 'node_modules' && !entry.startsWith('.'))
    .sort()
}

/** 这个 profile 目录里有没有任何痕迹指向本包（说明它就是"我们的" profile）。 */
function profileMentionsUs(profileDir: string): boolean {
  const pkgScopePath = path.join(profileDir, 'node_modules', ...PACKAGE_NAME.split('/'))
  if (statOrNull(pkgScopePath) !== null) return true
  const patchText = readTextOrNull(path.join(profileDir, 'cordis.patch.yml'))
  if (patchText !== null && (patchText.includes(PACKAGE_NAME) || patchText.includes(BLOCK_START))) {
    return true
  }
  const manifestText = readTextOrNull(path.join(profileDir, 'package.json'))
  if (manifestText !== null && manifestText.includes(PACKAGE_NAME)) return true
  return false
}

interface ProfileResolution {
  name: string | null
  dir: string | null
  /** 名字是从哪条线索来的，写进状态区方便排查。 */
  source: string
  candidates: string[]
}

/**
 * 当前 profile 探测（按可靠性从高到低）：
 *   1. config.profileDir / config.profile（patch 里能写死，最确定）
 *   2. env.DSH_PROFILE / env.DSH_PROFILE_NAME
 *   3. `process.argv` 里的 `--profile <name>`
 *   4. 本模块 URL 里的 `profiles/<name>/` 段（junction 安装时可能已被 realpath 化）
 *   5. `$DSH_HOME/profiles/*` 里唯一提到本包的那个；都没有时若只有一个 profile 就用它
 * 探测不出来时返回 null，让 op 报出明确原因，绝不瞎猜着写别人的配置。
 */
function resolveProfile(config: PluginConfig, targets: Targets): ProfileResolution {
  const candidates = listProfiles(targets.profilesRoot)

  if (typeof config.profileDir === 'string' && config.profileDir !== '') {
    const dir = expandTilde(config.profileDir)
    return { name: path.basename(dir), dir, source: 'config.profileDir', candidates }
  }
  if (typeof config.profile === 'string' && config.profile !== '') {
    return {
      name: config.profile,
      dir: path.join(targets.profilesRoot, config.profile),
      source: 'config.profile',
      candidates,
    }
  }

  for (const key of ['DSH_PROFILE', 'DSH_PROFILE_NAME'] as const) {
    const value = process.env[key]
    if (typeof value === 'string' && value !== '') {
      return { name: value, dir: path.join(targets.profilesRoot, value), source: `env.${key}`, candidates }
    }
  }

  const argv = process.argv
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--profile') {
      const next = argv[index + 1]
      if (typeof next === 'string' && next !== '' && !next.startsWith('-')) {
        return { name: next, dir: path.join(targets.profilesRoot, next), source: 'argv', candidates }
      }
    }
    if (typeof arg === 'string' && arg.startsWith('--profile=')) {
      const value = arg.slice('--profile='.length)
      if (value !== '') {
        return { name: value, dir: path.join(targets.profilesRoot, value), source: 'argv', candidates }
      }
    }
  }

  const moduleUrl = safeModuleUrl()
  if (moduleUrl !== null) {
    const segments = moduleUrl.split(/[\\/]+/)
    const index = segments.lastIndexOf('profiles')
    const name = index >= 0 ? segments[index + 1] : undefined
    if (typeof name === 'string' && name !== '' && name !== 'node_modules') {
      return { name, dir: path.join(targets.profilesRoot, name), source: 'module-path', candidates }
    }
  }

  const mentioned = candidates.filter((candidate) =>
    profileMentionsUs(path.join(targets.profilesRoot, candidate)),
  )
  if (mentioned.length === 1) {
    const only = mentioned[0] as string
    return { name: only, dir: path.join(targets.profilesRoot, only), source: 'scan', candidates }
  }
  if (mentioned.length === 0 && candidates.length === 1) {
    const only = candidates[0] as string
    return { name: only, dir: path.join(targets.profilesRoot, only), source: 'single', candidates }
  }
  return {
    name: null,
    dir: null,
    source: mentioned.length > 1 ? 'ambiguous' : 'unresolved',
    candidates,
  }
}

function safeModuleUrl(): string | null {
  try {
    const url = import.meta.url
    if (typeof url !== 'string' || url === '') return null
    return decodeURIComponent(url.replace(/^file:\/\/\/?/, ''))
  } catch {
    return null
  }
}

/** managed block 文本生成（结构与 install.mjs:161-183 逐行对齐）。 */
function renderManagedBlock(wrapperPath: string): string {
  const lines: string[] = [
    BLOCK_START,
    '- insert:',
    `    - id: ${MCP_ENTRY_ID}`,
    `      name: '${MCP_CLIENT_PACKAGE}'`,
    '      config:',
    `        serverName: ${MCP_SERVER_NAME}`,
    '        transport: stdio',
  ]
  if (IS_WINDOWS) {
    lines.push('        command: cmd')
    lines.push(`        args: ['/c', ${JSON.stringify(wrapperPath)}]`)
  } else {
    lines.push(`        command: ${JSON.stringify(wrapperPath)}`)
    lines.push('        args: []')
  }
  lines.push('        toolCallTimeoutMs: 660000')
  lines.push('        failOnStartupError: false')
  lines.push(BLOCK_END)
  return lines.join('\n')
}

function extractManagedBlock(text: string): string | null {
  const start = text.indexOf(BLOCK_START)
  const end = text.indexOf(BLOCK_END)
  if (start < 0 || end <= start) return null
  return text.slice(start, end + BLOCK_END.length)
}

interface PatchSnapshot {
  path: string
  exists: boolean
  hasBlock: boolean
  mcpMounted: boolean
}

function readPatchSnapshot(patchPath: string): PatchSnapshot {
  const text = readTextOrNull(patchPath)
  if (text === null) return { path: patchPath, exists: false, hasBlock: false, mcpMounted: false }
  const block = extractManagedBlock(text)
  return {
    path: patchPath,
    exists: true,
    hasBlock: block !== null,
    mcpMounted: block !== null && block.includes(`- id: ${MCP_ENTRY_ID}`),
  }
}

/**
 * 幂等写入 managed block：
 *   已有 → 原位替换；没有 → 去掉 `[]` 占位后追加；内容已经一致 → 不动文件。
 */
function applyManagedBlock(
  original: string,
  block: string,
): { text: string; mode: 'created' | 'updated' | 'unchanged' } {
  const start = original.indexOf(BLOCK_START)
  const end = original.indexOf(BLOCK_END)
  if (start >= 0 && end > start) {
    const current = original.slice(start, end + BLOCK_END.length)
    if (current === block) return { text: original, mode: 'unchanged' }
    const before = original.slice(0, start)
    const after = original.slice(end + BLOCK_END.length)
    return { text: `${before.trimEnd()}\n${block}${after}`, mode: 'updated' }
  }
  const stripped = original.replace(/^\s*\[\s*\]\s*$/m, '').trimEnd()
  return { text: stripped === '' ? `${block}\n` : `${stripped}\n\n${block}\n`, mode: 'created' }
}

/* ──────────────────────────── 飞书 API ──────────────────────────── */

interface FetchResponseLike {
  status: number
  ok: boolean
  text(): Promise<string>
}
interface FetchInitLike {
  method?: string
  headers?: Record<string, string>
  body?: string
  signal?: AbortSignal
}
type FetchLike = (url: string, init?: FetchInitLike) => Promise<FetchResponseLike>

function pickFetch(): FetchLike {
  const candidate = (globalThis as { fetch?: unknown }).fetch
  if (typeof candidate !== 'function') {
    throw new ApiError(500, '当前 Node 运行时不提供 fetch（需要 Node 18+），无法校验飞书凭据')
  }
  return candidate as FetchLike
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

interface JsonResult {
  status: number
  json: Record<string, unknown> | null
  text: string
}

async function httpJson(url: string, init: FetchInitLike): Promise<JsonResult> {
  const doFetch = pickFetch()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS)
  try {
    const response = await doFetch(url, { ...init, signal: controller.signal })
    const text = await response.text()
    let json: Record<string, unknown> | null = null
    try {
      json = asRecord(JSON.parse(text) as unknown)
    } catch {
      json = null
    }
    return { status: response.status, json, text }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new ApiError(504, `请求飞书超时（${HTTP_TIMEOUT_MS} ms）`)
    }
    throw new ApiError(
      502,
      `连不上飞书开放平台：${error instanceof Error ? error.message : String(error)}`,
    )
  } finally {
    clearTimeout(timer)
  }
}

function feishuOrigin(values: Map<string, string>): string {
  const domain = values.get('FEISHU_DOMAIN') ?? values.get('LARK_DOMAIN') ?? ''
  const trimmed = domain.trim().replace(/\/+$/, '')
  if (trimmed === '') return FEISHU_ORIGIN
  return trimmed.startsWith('http') ? trimmed : `https://${trimmed}`
}

interface TokenResult {
  token: string
  expire: number | null
}

async function fetchTenantToken(
  origin: string,
  appId: string,
  appSecret: string,
): Promise<{ ok: true; value: TokenResult } | { ok: false; code: number | null; msg: string }> {
  const result = await httpJson(`${origin}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  })
  const json = result.json
  if (json === null) {
    return { ok: false, code: null, msg: `飞书返回了非 JSON 响应（HTTP ${result.status}）` }
  }
  const token = asString(json['tenant_access_token'])
  const code = asNumber(json['code'])
  if (token === null || (code !== null && code !== 0)) {
    return {
      ok: false,
      code,
      msg: asString(json['msg']) ?? asString(json['error']) ?? '未知错误',
    }
  }
  return { ok: true, value: { token, expire: asNumber(json['expire']) } }
}

interface ChatResult {
  ok: boolean
  name: string | null
  code: number | null
  msg: string | null
}

async function fetchChatName(origin: string, token: string, chatId: string): Promise<ChatResult> {
  const result = await httpJson(
    `${origin}/open-apis/im/v1/chats/${encodeURIComponent(chatId)}`,
    { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
  )
  const json = result.json
  if (json === null) {
    return { ok: false, name: null, code: null, msg: `飞书返回了非 JSON 响应（HTTP ${result.status}）` }
  }
  const code = asNumber(json['code'])
  if (code !== null && code !== 0) {
    return { ok: false, name: null, code, msg: asString(json['msg']) ?? '未知错误' }
  }
  const data = asRecord(json['data'])
  const name = data === null ? null : asString(data['name'])
  return { ok: true, name, code: 0, msg: null }
}

/* ──────────────────────────── op 实现 ──────────────────────────── */

function statusReport(config: PluginConfig, targets: Targets): Record<string, unknown> {
  const env = readEnvSnapshot(targets.envPath)
  const resolved = resolveProfile(config, targets)
  const patchPath = resolved.dir === null ? null : path.join(resolved.dir, 'cordis.patch.yml')
  const patch = patchPath === null
    ? { path: '', exists: false, hasBlock: false, mcpMounted: false }
    : readPatchSnapshot(patchPath)
  const wrapperExists = statOrNull(targets.wrapperPath) !== null
  const hints: string[] = []

  if (!env.exists) {
    hints.push(`还没有凭据文件（${targets.envPath}）：填好下面三项后点「保存并启用」。`)
  } else if (env.appId === null || !env.hasSecret) {
    hints.push('凭据文件存在但缺 App ID 或 App Secret，请补全后再保存。')
  }
  if (resolved.name === null) {
    hints.push(
      `探测不出当前 profile（候选：${resolved.candidates.join('、') || '无'}）：请在下面手动选择目标 profile，或在 patch 的 config 里写死 profile。`,
    )
  }
  if (patch.mcpMounted) {
    hints.push('MCP 已挂进 patch：重启 DSH 后才会真正连上飞书。')
  } else if (resolved.name !== null) {
    hints.push('MCP 还没挂进 patch：点「保存并启用」会幂等写入。')
  }
  if (!wrapperExists) {
    hints.push(
      `MCP 启动包装不存在（${targets.wrapperPath}）：挂上后会起不来，先跑 node scripts/install.mjs 或把 dist-single/dsh-feishu-mcp.mjs 拷到同目录。`,
    )
  }
  if (IS_WINDOWS) {
    hints.push('Windows 上 chmod 只影响只读位，0600 由用户目录的 NTFS ACL 承担。')
  }

  return {
    ok: true,
    op: 'status',
    configured: env.exists && env.appId !== null && env.hasSecret,
    env: {
      path: env.path,
      exists: env.exists,
      appId: env.appId,
      chatId: env.chatId,
      hasSecret: env.hasSecret,
      secretTail: env.secretTail,
      fileMode: env.fileMode,
      modeApplied: env.modeApplied,
    },
    profile: {
      name: resolved.name,
      source: resolved.source,
      dir: resolved.dir,
      patchPath: patch.path === '' ? null : patch.path,
      patchExists: patch.exists,
      managedBlock: patch.hasBlock,
      mcpMounted: patch.mcpMounted,
      wrapperPath: targets.wrapperPath,
      wrapperExists,
    },
    profiles: resolved.candidates,
    dshHome: targets.dshHome,
    hints,
  }
}

interface CredentialInput {
  appId: string | null
  appSecret: string | null
  chatId: string | null
  origin: string
}

function pickString(body: Record<string, unknown>, key: string): string | null {
  const value = body[key]
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

function credentialsForTest(
  body: Record<string, unknown>,
  env: EnvSnapshot,
): CredentialInput {
  const appId = pickString(body, 'appId') ?? env.appId
  const appSecret =
    pickString(body, 'appSecret') ?? (env.hasSecret ? (env.values.get('FEISHU_APP_SECRET') ?? null) : null)
  const chatId = typeof body['chatId'] === 'string'
    ? (body['chatId'].trim() === '' ? null : body['chatId'].trim())
    : env.chatId
  return { appId, appSecret, chatId, origin: feishuOrigin(env.values) }
}

async function runTest(
  ctx: PluginContext,
  body: Record<string, unknown>,
  targets: Targets,
): Promise<Record<string, unknown>> {
  const env = readEnvSnapshot(targets.envPath)
  const credentials = credentialsForTest(body, env)

  if (credentials.appId === null) {
    return { ok: false, op: 'test', error: '缺少 App ID：表单里没填，env 文件里也没有' }
  }
  if (credentials.appSecret === null) {
    return {
      ok: false,
      op: 'test',
      error: '缺少 App Secret：表单里留空时要求 env 文件里已经存过一份',
    }
  }

  ctx.logger.info('[dsh-feishu] test · app=%s · chat=%s', credentials.appId, credentials.chatId ?? '(默认会话未设置)')

  const tokenResult = await fetchTenantToken(
    credentials.origin,
    credentials.appId,
    credentials.appSecret,
  )
  if (!tokenResult.ok) {
    return {
      ok: false,
      op: 'test',
      stage: 'credentials',
      credentialsValid: false,
      error: `凭据无效：code=${tokenResult.code ?? '未知'} msg=${tokenResult.msg}`,
      feishu: { code: tokenResult.code, msg: tokenResult.msg },
    }
  }

  if (credentials.chatId === null) {
    return {
      ok: true,
      op: 'test',
      stage: 'credentials',
      credentialsValid: true,
      chat: { requested: false, ok: false, name: null, code: null, msg: null },
      tokenExpiresInSeconds: tokenResult.value.expire,
      message: '凭据有效；默认会话还没设置（可选：填 chat_id 后再测一次）',
    }
  }

  const chat = await fetchChatName(
    credentials.origin,
    tokenResult.value.token,
    credentials.chatId,
  )
  if (!chat.ok) {
    return {
      ok: true,
      op: 'test',
      stage: 'chat',
      credentialsValid: true,
      chat: {
        requested: true,
        ok: false,
        name: null,
        code: chat.code,
        msg: chat.msg,
      },
      warning:
        chat.code === 230027 || chat.code === 230001
          ? '机器人可能没被拉进这个群'
          : '凭据有效，但这个 chat_id 查不到',
      message: `凭据有效；默认会话校验失败（code=${chat.code ?? '未知'} msg=${chat.msg ?? ''}）`,
    }
  }

  return {
    ok: true,
    op: 'test',
    stage: 'chat',
    credentialsValid: true,
    chat: { requested: true, ok: true, name: chat.name, code: 0, msg: null },
    tokenExpiresInSeconds: tokenResult.value.expire,
    message: `凭据有效；默认会话是「${chat.name ?? '(无名)'}」`,
  }
}

async function runSave(
  ctx: PluginContext,
  body: Record<string, unknown>,
  config: PluginConfig,
  targets: Targets,
): Promise<Record<string, unknown>> {
  const env = readEnvSnapshot(targets.envPath)
  const bodyAppId = pickString(body, 'appId')
  const bodySecret = pickString(body, 'appSecret')
  const appId = bodyAppId ?? env.appId
  const appSecret = bodySecret ?? (env.hasSecret ? (env.values.get('FEISHU_APP_SECRET') ?? null) : null)

  if (appId === null) {
    return { ok: false, op: 'save', error: '缺少 App ID：请填写飞书开放平台的 App ID（cli_ 开头）' }
  }
  if (appSecret === null) {
    return {
      ok: false,
      op: 'save',
      error: '缺少 App Secret：表单留空时要求 env 文件里已经存过一份',
    }
  }

  // 先解析目标，避免「env 写完了但 patch 找不到地方写」这种半成功状态。
  const overrideProfile = pickString(body, 'profile')
  if (overrideProfile !== null) {
    const problem = validateProfileName(overrideProfile)
    if (problem !== null) {
      return { ok: false, op: 'save', stage: 'resolve-profile', error: problem, profiles: listProfiles(targets.profilesRoot) }
    }
  }
  const effectiveConfig: PluginConfig =
    overrideProfile === null ? config : { ...config, profile: overrideProfile, profileDir: undefined }
  const resolved = resolveProfile(effectiveConfig, targets)
  if (resolved.dir === null) {
    return {
      ok: false,
      op: 'save',
      stage: 'resolve-profile',
      error:
        resolved.source === 'ambiguous'
          ? `检测到多个候选 profile（${resolved.candidates.join('、')}），无法确定往哪一个写 patch`
          : `找不到当前 profile 目录（profiles 根：${targets.profilesRoot}）`,
      profiles: resolved.candidates,
      hint: '在请求里带 profile 字段，或在 patch 的 config 里写死 profile。',
    }
  }

  let chatId: string | null
  if (typeof body['chatId'] === 'string') {
    const trimmed = body['chatId'].trim()
    chatId = trimmed === '' ? null : trimmed
  } else {
    chatId = env.chatId
  }

  const nextValues = new Map(env.values)
  nextValues.set('FEISHU_APP_ID', appId)
  nextValues.set('FEISHU_APP_SECRET', appSecret)
  if (chatId === null) nextValues.delete('FEISHU_DEFAULT_CHAT_ID')
  else nextValues.set('FEISHU_DEFAULT_CHAT_ID', chatId)

  const envText = renderEnvText(nextValues)
  const envCreated = !env.exists
  atomicWriteFile(targets.envPath, envText, 0o600)
  ctx.logger.info('[dsh-feishu] 已写入凭据文件 %s（0600）', targets.envPath)

  const patchPath = path.join(resolved.dir, 'cordis.patch.yml')
  const block = renderManagedBlock(targets.wrapperPath)
  const original = readTextOrNull(patchPath)
  let backup: string | null = null
  let mode: 'created' | 'updated' | 'unchanged' = 'created'

  try {
    if (original === null) {
      atomicWriteFile(patchPath, `${block}\n`, 0o644)
      mode = 'created'
    } else {
      const applied = applyManagedBlock(original, block)
      mode = applied.mode
      if (applied.mode !== 'unchanged') {
        backup = `${patchPath}.bak-feishu-${Date.now()}`
        fs.copyFileSync(patchPath, backup)
        atomicWriteFile(patchPath, applied.text, 0o644)
      }
    }
  } catch (error) {
    return {
      ok: false,
      op: 'save',
      stage: 'patch',
      error: `凭据已保存，但改 patch 失败：${error instanceof Error ? error.message : String(error)}`,
      envWritten: true,
      envPath: targets.envPath,
      patchPath,
    }
  }

  const patchSnapshot = readPatchSnapshot(patchPath)
  const warnings: string[] = []
  if (statOrNull(targets.wrapperPath) === null) {
    warnings.push(
      `MCP 启动包装不存在（${targets.wrapperPath}）：重启后 MCP 会连接失败，先跑 node scripts/install.mjs。`,
    )
  }
  if (IS_WINDOWS) {
    warnings.push('Windows 上 0600 由 NTFS ACL 承担（chmod 只影响只读位）。')
  }
  warnings.push('MCP 挂载是新加的：重启 DSH 后才会出现 mcp__feishu__* 工具。')

  ctx.logger.info('[dsh-feishu] patch %s → %s（%s）', patchPath, mode, resolved.source)

  return {
    ok: true,
    op: 'save',
    env: {
      path: targets.envPath,
      created: envCreated,
      mode: '0600',
      modeApplied: IS_WINDOWS ? true : readEnvSnapshot(targets.envPath).modeApplied,
      hasSecret: true,
      secretTail: appSecret.slice(-4),
    },
    patch: {
      path: patchPath,
      profile: resolved.name,
      source: resolved.source,
      mode,
      backup,
      managedBlock: patchSnapshot.hasBlock,
      mcpMounted: patchSnapshot.mcpMounted,
    },
    warnings,
    restartRequired: mode !== 'unchanged',
    message: mode === 'unchanged' ? '凭据已更新；patch 里那一块本来就和现在一致。' : '已保存。重启 DSH 后生效。',
  }
}

/* ──────────────────────────── 插件入口 ──────────────────────────── */

export function apply(ctx: PluginContext, config?: PluginConfig): void {
  const effective: PluginConfig = config ?? {}
  const configuredPath = effective.endpointPath
  const routePath =
    typeof configuredPath === 'string' && configuredPath.startsWith('/') ? configuredPath : DEFAULT_PATH
  const targets = resolveTargets(effective)

  ctx.logger.info('[dsh-feishu] enabled; HTTP route = %s', routePath)
  ctx.logger.info('[dsh-feishu] 凭据文件 = %s', targets.envPath)

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: routePath,
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: '只接受 POST' })
            return
          }
          if (!trustedOrigin(req)) {
            sendJson(res, 403, { ok: false, error: '跨源请求被拒绝' })
            return
          }
          try {
            const body = await readJson(req)
            const op = typeof body['op'] === 'string' ? body['op'] : ''
            ctx.logger.info('[dsh-feishu] op = %s', op === '' ? '(none)' : op)

            if (op === 'status') {
              sendJson(res, 200, statusReport(effective, targets))
              return
            }
            if (op === 'test') {
              sendJson(res, 200, await runTest(ctx, body, targets))
              return
            }
            if (op === 'save') {
              sendJson(res, 200, await runSave(ctx, body, effective, targets))
              return
            }
            throw new ApiError(400, `未知 op：${op === '' ? '(空)' : op}（只支持 status / test / save）`)
          } catch (error) {
            const status = error instanceof ApiError ? error.status : 500
            const message = error instanceof Error ? error.message : String(error)
            if (status >= 500) ctx.logger.warn?.('[dsh-feishu] %s', message)
            sendJson(res, status, { ok: false, error: message })
          }
        },
      }),
    'dsh-feishu: http route',
  )
}

/** 具名 + default 两种导出都给：Loader 两种写法都能吃。 */
export default { name, inject, apply }
