/**
 * dsh-plugin-skeleton —— 服务端（Cordis host 半侧）入口。
 *
 * 加载链路：profile patch 插一行 → Loader 用 name 动态 import → `inject` 里的服务
 * 全部就绪后调用 `apply(ctx, config)` → `ctx.webServer.register` 把端点挂到宿主
 * 已有的 HTTP 服务器上。每条依据的行号都在 README 里。
 *
 * 运行期零 import（只 import 类型），不依赖任何未安装的包。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

/** Cordis 里的插件名，用于日志/诊断。 */
export const name = 'dsh-plugin-skeleton'

/** 必需服务：任一永不出现，本插件就一直 pending（不崩，也不生效）。 */
export const inject: string[] = ['webServer']

const DEFAULT_PATH = '/dsh-plugin-skeleton/api'
const MAX_BODY_BYTES = 64 * 1024

/* --- 宿主服务的最小类型面（形状照抄 @deepseek-ai/dsh-host-webserver） --- */
interface WebRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}
interface WebServerLike {
  /** 重复的 (kind, path) 会抛错；返回值是注销函数。 */
  register(route: WebRoute): () => void
}
interface PluginContext {
  webServer: WebServerLike
  logger: { info(format: string, ...args: unknown[]): void }
  /** 把清理函数挂到插件生命周期：禁用/热重载时自动注销。 */
  effect(execute: () => (() => void) | void, label?: string): unknown
}
interface PluginConfig {
  endpointPath?: string
}

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
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(buf)
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  return raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>)
}

/**
 * 自定义具名路由不经过 `/api` 的浏览器认证栅栏（那条路由归 client-connection 独占），
 * 跨源判断必须插件自己做：回环放行，非回环要求 Origin 与 Host 同源。
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

export function apply(ctx: PluginContext, config?: PluginConfig): void {
  const configured = config?.endpointPath
  const path = typeof configured === 'string' && configured.startsWith('/') ? configured : DEFAULT_PATH

  ctx.logger.info('[dsh-plugin-skeleton] enabled; HTTP route = %s', path)

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path,
        handler: async (req, res) => {
          if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' })
          if (!trustedOrigin(req)) {
            return sendJson(res, 403, { ok: false, error: 'cross-origin request rejected' })
          }
          try {
            const body = await readJson(req)
            const op = typeof body['op'] === 'string' ? body['op'] : null
            ctx.logger.info('[dsh-plugin-skeleton] op = %s', op ?? '(none)')
            sendJson(res, 200, { ok: true, plugin: name, op, echo: body, at: new Date().toISOString() })
          } catch (error) {
            sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
          }
        },
      }),
    'dsh-plugin-skeleton: http route',
  )
}

/** 具名 + default 两种导出都给：Loader 两种写法都能吃。 */
export default { name, inject, apply }
