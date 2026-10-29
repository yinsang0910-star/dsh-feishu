#!/usr/bin/env node
/**
 * dsh-feishu-gateway —— 常驻长连接网关。
 *
 * 为什么需要它：
 *   MCP 是"请求-响应"模型，拿不到飞书的推送。要让 feishu_ask 的按钮真的能用、
 *   要让并发的两个提问不互相偷答案，就必须有一个常驻进程持有长连接。
 *
 * 它做什么：
 *   - 维护与飞书的 WebSocket 长连接
 *   - 收 card.action.trigger（按钮回调）→ 按 token 精确投递给对应的提问
 *   - 收 im.message.receive_v1（可选）→ 缓存最近消息，顺便兜底回答
 *   - 在 127.0.0.1:PORT 上开一个小 HTTP 接口给 MCP server 查
 *
 * ⚠️ 注意：同一飞书应用的多条长连接会**争抢事件**。这个网关和旧的 Python bot
 * （/opt/feishu-bot）同时跑会互相丢事件，切换时必须先停掉旧的。
 */

import { loadConfig } from '@dsh-feishu/core';
import * as Lark from '@larksuiteoapi/node-sdk';
import { createHttpServer } from './http.js';
import { GatewayState, type CachedMessage } from './state.js';

const VERSION = '0.1.0';

function log(msg: string, extra?: unknown): void {
  const line = extra === undefined ? msg : `${msg} ${JSON.stringify(extra)}`;
  process.stderr.write(`[feishu-gateway] ${line}\n`);
}

function textOf(msgType: string, rawContent: string): string {
  try {
    const c = JSON.parse(rawContent) as Record<string, unknown>;
    if (msgType === 'text') return String(c['text'] ?? '');
    if (msgType === 'file') return `[文件] ${String(c['file_name'] ?? '')}`;
    if (msgType === 'image') return '[图片]';
    if (msgType === 'audio') return '[语音]';
    if (msgType === 'media') return '[视频]';
    if (msgType === 'sticker') return '[表情]';
    if (msgType === 'interactive') return '[卡片]';
    return `[${msgType}]`;
  } catch {
    return `[${msgType}]`;
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const port = Number(process.env.FEISHU_GATEWAY_PORT ?? 18642);
  const host = process.env.FEISHU_GATEWAY_HOST ?? '127.0.0.1';
  // 默认也订阅消息（用于 feishu_recent 的实时上下文 + 兜底回答）；
  // 设 FEISHU_GATEWAY_EVENTS=card 则只收卡片回调。
  const eventsMode = (process.env.FEISHU_GATEWAY_EVENTS ?? 'all').toLowerCase();

  const state = new GatewayState();
  const gwToken = (process.env.FEISHU_GATEWAY_TOKEN ?? '').trim() || undefined;
  const gwDebug = process.env.FEISHU_GATEWAY_DEBUG === '1';
  const server = createHttpServer(state, log, {
    ...(gwToken ? { token: gwToken } : {}),
    ...(gwDebug ? { debug: true } : {}),
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
  log(
    `HTTP 就绪 http://${host}:${port}` +
      (gwToken
        ? ' · 已启用网关密钥'
        : ' · 未设密钥（只接受本机访问；跨机调用请设 FEISHU_GATEWAY_TOKEN）') +
      (gwDebug ? ' · 调试端点已开' : ''),
  );

  // ── 模式二：不持有长连接 ───────────────────────────────────────────
  // 已经有人持有长连接时（比如旧的 Python bot），网关只做"答案中转站"：
  // 对方收到 card.action 后 POST /answer 过来，MCP 这边 /answer 一问即得。
  // 好处：同一个飞书应用的多条长连接不会互相抢事件。
  const noWs = process.env.FEISHU_GATEWAY_NO_WS === '1';
  if (noWs) {
    log('NO_WS 模式：只开 HTTP。请让持有长连接的一方把卡片回调 POST 到 /answer');
    const shutdownHttp = (sig: string): void => {
      log(`${sig} 收到，关闭`);
      server.close();
      process.exit(0);
    };
    process.on('SIGINT', () => shutdownHttp('SIGINT'));
    process.on('SIGTERM', () => shutdownHttp('SIGTERM'));
    return;
  }

  log(`事件模式=${eventsMode}`);

  const dispatcher = new Lark.EventDispatcher({});

  // 按钮回调：{ act: 'answer' | 'approve' | 'cancel', token, answer? }
  dispatcher.register({
    'card.action.trigger': async (data: Record<string, unknown>) => {
      try {
        const event = (data['event'] ?? {}) as Record<string, unknown>;
        const action = (event['action'] ?? {}) as Record<string, unknown>;
        const value = (action['value'] ?? {}) as Record<string, unknown>;
        const operator = (event['operator'] ?? {}) as Record<string, unknown>;
        const token = String(value['token'] ?? '');
        const act = String(value['act'] ?? '');
        const byOpenId = operator['open_id'] ? String(operator['open_id']) : undefined;

        log('card.action.trigger', { token, act, by: byOpenId });

        if (token && act === 'answer') {
          const answerText = String(value['answer'] ?? '');
          const ok = state.resolveAsk(token, {
            text: answerText,
            via: 'button',
            ...(byOpenId ? { byOpenId } : {}),
          });
          log(ok ? '按钮答案已投递' : 'token 不存在或已作答', { token });
        }
        return {};
      } catch (err) {
        log('处理卡片回调失败', { err: String(err) });
        return {};
      }
    },
  });

  if (eventsMode !== 'card') {
    dispatcher.register({
      'im.message.receive_v1': async (data: Record<string, unknown>) => {
        try {
          const event = (data['event'] ?? {}) as Record<string, unknown>;
          const message = (event['message'] ?? {}) as Record<string, unknown>;
          const sender = (event['sender'] ?? {}) as Record<string, unknown>;
          const senderId = (sender['sender_id'] ?? {}) as Record<string, unknown>;

          const msgType = String(message['message_type'] ?? '');
          const cached: CachedMessage = {
            messageId: String(message['message_id'] ?? ''),
            chatId: String(message['chat_id'] ?? ''),
            msgType,
            createTime: Number(message['create_time'] ?? Date.now()),
            senderType: sender['sender_type'] ? String(sender['sender_type']) : undefined,
            text: textOf(msgType, String(message['content'] ?? '{}')),
            ...(senderId['open_id'] ? { senderOpenId: String(senderId['open_id']) } : {}),
            ...(message['thread_id'] ? { threadId: String(message['thread_id']) } : {}),
          };
          state.pushMessage(cached);
        } catch (err) {
          log('处理消息事件失败', { err: String(err) });
        }
        return {};
      },
    });
  }

  const ws = new Lark.WSClient({
    appId: config.appId,
    appSecret: config.appSecret,
    ...(config.domain ? { domain: config.domain } : {}),
  } as never);

  log(`连接飞书长连接 · app=${config.appId}`);
  // 不同版本的 SDK start 签名略有差异，这里兼容两种
  try {
    (ws as unknown as { start: (o?: unknown) => void }).start({ eventDispatcher: dispatcher });
  } catch {
    (ws as unknown as { start: () => void }).start();
  }
  log('已发起长连接；收到事件后会打印 card.action.trigger / message');

  const shutdown = (sig: string): void => {
    log(`${sig} 收到，关闭`);
    try {
      (ws as unknown as { close?: () => void }).close?.();
    } catch {
      /* ignore */
    }
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

process.on('uncaughtException', (err) => {
  log(`未捕获异常：${err.stack ?? err.message}`);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  log(`未处理 rejection：${String(reason)}`);
});

log(`启动 v${VERSION}`);
main().catch((err: unknown) => {
  log(`启动失败：${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(2);
});
