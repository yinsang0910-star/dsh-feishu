/**
 * 网关的本地 HTTP 接口。只绑 127.0.0.1，不对外。
 *
 * MCP server 用它做两件事：
 *   1. 注册一个正在等的提问（/watch）
 *   2. 轮询答案（/answer）—— 按钮点了立刻就有，不用等飞书消息 API
 */

import http from 'node:http';
import type { GatewayState } from './state.js';

type Log = (msg: string, extra?: unknown) => void;

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

async function readBody(req: http.IncomingMessage, limit = 1024 * 512): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('请求体过大');
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('请求体不是合法 JSON');
  }
}

export function createHttpServer(state: GatewayState, log: Log): http.Server {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const route = `${req.method} ${url.pathname}`;

    void (async () => {
      try {
        if (route === 'GET /health') {
          return json(res, 200, { ok: true, ...state.stats() });
        }

        if (route === 'POST /watch') {
          const body = (await readBody(req)) as {
            token?: string;
            chatId?: string;
            question?: string;
            baselineSec?: number;
          };
          if (!body.token || !body.chatId) {
            return json(res, 400, { ok: false, error: '缺 token 或 chatId' });
          }
          const ask = state.registerAsk({
            token: body.token,
            chatId: body.chatId,
            question: body.question ?? '',
            ...(body.baselineSec !== undefined ? { baselineSec: body.baselineSec } : {}),
          });
          log('watch', { token: ask.token, chatId: ask.chatId });
          return json(res, 200, { ok: true, token: ask.token });
        }

        if (route === 'GET /answer') {
          const token = url.searchParams.get('token');
          if (!token) return json(res, 400, { ok: false, error: '缺 token' });
          const ask = state.getAsk(token);
          if (!ask) return json(res, 200, { ok: true, answered: false, known: false });
          if (ask.answered) {
            return json(res, 200, {
              ok: true,
              answered: true,
              known: true,
              text: ask.answered.text,
              via: ask.answered.via,
              ...(ask.answered.byOpenId ? { by: ask.answered.byOpenId } : {}),
            });
          }
          return json(res, 200, { ok: true, answered: false, known: true });
        }

        if (route === 'GET /pending') {
          return json(res, 200, { ok: true, asks: state.pendingList() });
        }

        if (route === 'POST /forget') {
          const body = (await readBody(req)) as { token?: string };
          if (body.token) state.dropAsk(body.token);
          return json(res, 200, { ok: true });
        }

        // 外部投递：给"已经有人持有长连接"的场景用。
        // 典型是旧的 Python bot —— 它本来就在处理 card.action，只要把 answer 转发到这里，
        // 网关就不用再抢一条长连接（同一 app 的多条连接会争抢事件）。
        if (route === 'POST /answer') {
          const body = (await readBody(req)) as {
            token?: string;
            text?: string;
            via?: 'button' | 'message';
            by?: string;
          };
          if (!body.token || body.text === undefined) {
            return json(res, 400, { ok: false, error: '缺 token 或 text' });
          }
          const accepted = state.resolveAsk(body.token, {
            text: body.text,
            via: body.via === 'message' ? 'message' : 'button',
            ...(body.by ? { byOpenId: body.by } : {}),
          });
          log('外部投递答案', { token: body.token, accepted, text: body.text.slice(0, 40) });
          return json(res, 200, { ok: true, accepted });
        }

        if (route === 'POST /push') {
          // 外部推送一条消息进缓存（给没有长连接、但想贡献上下文的一方用）
          const body = (await readBody(req)) as Record<string, unknown>;
          if (!body['chatId'] || !body['messageId']) {
            return json(res, 400, { ok: false, error: '缺 chatId 或 messageId' });
          }
          state.pushMessage({
            messageId: String(body['messageId']),
            chatId: String(body['chatId']),
            msgType: String(body['msgType'] ?? 'text'),
            createTime: Number(body['createTime'] ?? Date.now()),
            text: String(body['text'] ?? ''),
            ...(body['senderOpenId'] ? { senderOpenId: String(body['senderOpenId']) } : {}),
            ...(body['senderType'] ? { senderType: String(body['senderType']) } : {}),
          });
          return json(res, 200, { ok: true });
        }

        if (route === 'GET /recent') {
          const chatId = url.searchParams.get('chat_id') ?? '';
          const limit = Number(url.searchParams.get('limit') ?? 20);
          if (!chatId) return json(res, 400, { ok: false, error: '缺 chat_id' });
          return json(res, 200, {
            ok: true,
            messages: state.recentMessages(chatId, Number.isFinite(limit) ? limit : 20),
          });
        }

        json(res, 404, { ok: false, error: `没有这个端点：${route}` });
      } catch (err) {
        log('http handler 出错', { route, err: String(err) });
        json(res, 500, { ok: false, error: String(err) });
      }
    })();
  });
}
