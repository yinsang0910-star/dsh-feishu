/**
 * 网关 HTTP 路由单测：真的用 node:http 起一个服务器，用 fetch 打真实端口。
 *
 * 只测路由与协议层（状态码、返回结构、认证），不碰飞书长连接。
 * 端口用 0 让系统分配，避免和本地 18642/18699 打架。
 */

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHttpServer, type HttpOptions } from '../src/http.js';
import { GatewayState } from '../src/state.js';

let state: GatewayState;
let server: Server | undefined;
let base = '';
let logs: Array<[string, unknown]> = [];

/**
 * fetch（undici）按 fetch spec 拒绝一批「不安全端口」：6000、6665-6669、6697、
 * 10080、4045、3659 等。Windows 的动态端口范围是 1024-65535，`listen(0)` 分配到的
 * 端口迟早会撞上其中一个，这时测试报 `TypeError: fetch failed / Error: bad port`，
 * 而且换个机器/换个时刻就不复现。撞上就换一个端口重来。
 */
const FETCH_BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101,
  102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389,
  427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636,
  989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566,
  6665, 6666, 6667, 6668, 6669, 6697, 10080,
]);

async function start(opts: HttpOptions = {}): Promise<void> {
  state = new GatewayState();
  logs = [];
  for (let attempt = 0; attempt < 20; attempt++) {
    server = createHttpServer(state, (m, e) => logs.push([m, e]), opts);
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(0, '127.0.0.1', () => resolve());
    });
    const { port } = server.address() as AddressInfo;
    if (!FETCH_BLOCKED_PORTS.has(port)) {
      base = `http://127.0.0.1:${port}`;
      return;
    }
    await stop();
  }
  throw new Error('拿不到 fetch 能访问的临时端口（连续 20 次都落在黑名单上）');
}

async function stop(): Promise<void> {
  const s = server;
  if (!s) return;
  server = undefined;
  // Windows 上 keep-alive 连接会让 close() 挂住 libuv，先掐连接再关
  s.closeAllConnections?.();
  await Promise.race([
    new Promise<void>((resolve) => s.close(() => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 1000)),
  ]);
}

/** 带 token / debug 的服务器：需要先停掉默认那个 */
async function restart(opts: HttpOptions): Promise<void> {
  await stop();
  await start(opts);
}

interface Res {
  status: number;
  body: any;
}

const get = async (p: string, headers: Record<string, string> = {}): Promise<Res> => {
  const r = await fetch(`${base}${p}`, { headers });
  return { status: r.status, body: await r.json() };
};

const post = async (
  p: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Res> => {
  const r = await fetch(`${base}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};

beforeEach(async () => {
  await start();
});

afterEach(async () => {
  await stop();
});

describe('GET /health', () => {
  it('返回 ok 与运行统计，且不需要认证', async () => {
    const r = await get('/health');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      ok: true,
      authRequired: false,
      debug: false,
      pendingAsks: 0,
      cachedMessages: 0,
    });
    expect(typeof r.body.uptimeMs).toBe('number');
  });

  it('配了网关密钥时，/health 仍然免认证（供探活），但会声明 authRequired', async () => {
    await restart({ token: 's3cret' });
    const r = await get('/health');
    expect(r.status).toBe(200);
    expect(r.body.authRequired).toBe(true);
  });

  it('debug 开关会体现在 /health 里', async () => {
    await restart({ debug: true });
    expect((await get('/health')).body.debug).toBe(true);
  });
});

describe('认证', () => {
  it('配了密钥但没带 → 401，并提示怎么带', async () => {
    await restart({ token: 's3cret' });
    const r = await get('/answer?token=t1');
    expect(r.status).toBe(401);
    expect(r.body.ok).toBe(false);
    expect(r.body.error).toContain('Authorization: Bearer');
    expect(logs.some(([m]) => m === '拒绝未授权请求')).toBe(true);
  });

  it('Authorization: Bearer <token> 可以过', async () => {
    await restart({ token: 's3cret' });
    const r = await get('/answer?token=t1', { Authorization: 'Bearer s3cret' });
    expect(r.status).toBe(200);
  });

  it('X-Gateway-Token 也可以过', async () => {
    await restart({ token: 's3cret' });
    const r = await get('/answer?token=t1', { 'X-Gateway-Token': 's3cret' });
    expect(r.status).toBe(200);
  });

  it('密钥错误 → 401', async () => {
    await restart({ token: 's3cret' });
    expect((await get('/answer?token=t1', { Authorization: 'Bearer wrong' })).status).toBe(401);
  });

  it('未配密钥时本机回环可以直接访问', async () => {
    expect((await get('/answer?token=nope')).status).toBe(200);
  });
});

describe('POST /watch', () => {
  it('注册提问后返回 token，状态里能查到', async () => {
    const r = await post('/watch', { token: 't1', chatId: 'oc_a', question: '选哪个？' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, token: 't1' });
    expect(state.getAsk('t1')?.chatId).toBe('oc_a');
    expect(state.getAsk('t1')?.question).toBe('选哪个？');
    expect(logs.some(([m]) => m === 'watch')).toBe(true);
  });

  it('baselineSec 会透传，question 可省略（默认空串）', async () => {
    await post('/watch', { token: 't1', chatId: 'oc_a', baselineSec: 42 });
    expect(state.getAsk('t1')?.baselineSec).toBe(42);
    expect(state.getAsk('t1')?.question).toBe('');
  });

  it('缺 token 或 chatId → 400', async () => {
    expect((await post('/watch', { chatId: 'oc_a' })).status).toBe(400);
    expect((await post('/watch', { token: 't1' })).status).toBe(400);
    const r = await post('/watch', {});
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('token');
  });

  it('空 body 也算缺参 → 400', async () => {
    expect((await post('/watch', '')).status).toBe(400);
  });

  it('body 不是合法 JSON → 500（错误信息可读）', async () => {
    const r = await post('/watch', '{ broken');
    expect(r.status).toBe(500);
    expect(r.body.error).toContain('JSON');
  });

  it('body 超过 512KB → 500 并提示请求体过大', async () => {
    const r = await post('/watch', { token: 't', chatId: 'c', question: 'x'.repeat(600 * 1024) });
    expect(r.status).toBe(500);
    expect(r.body.error).toContain('过大');
  });

  it('方法不对（GET /watch）→ 404，不会误触发注册', async () => {
    expect((await get('/watch')).status).toBe(404);
    expect(state.pendingList()).toEqual([]);
  });
});

describe('GET /answer', () => {
  it('未注册过的 token → known=false', async () => {
    const r = await get('/answer?token=ghost');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, answered: false, known: false });
  });

  it('已注册未作答 → known=true, answered=false', async () => {
    await post('/watch', { token: 't1', chatId: 'oc_a' });
    expect((await get('/answer?token=t1')).body).toEqual({ ok: true, answered: false, known: true });
  });

  it('作答后返回文本与来源，带 by', async () => {
    await post('/watch', { token: 't1', chatId: 'oc_a' });
    state.resolveAsk('t1', { text: '选 A', via: 'button', byOpenId: 'ou_u' });
    expect((await get('/answer?token=t1')).body).toEqual({
      ok: true,
      answered: true,
      known: true,
      text: '选 A',
      via: 'button',
      by: 'ou_u',
    });
  });

  it('没有 byOpenId 时不返回 by 字段', async () => {
    await post('/watch', { token: 't1', chatId: 'oc_a' });
    state.resolveAsk('t1', { text: 'x', via: 'message' });
    expect('by' in (await get('/answer?token=t1')).body).toBe(false);
  });

  it('缺 token 参数 → 400', async () => {
    expect((await get('/answer')).status).toBe(400);
  });

  it('并发两个提问不会串答案', async () => {
    await post('/watch', { token: 'b', chatId: 'oc_a' });
    await post('/watch', { token: 'c', chatId: 'oc_a' });
    state.resolveAsk('c', { text: '给 c 的', via: 'button' });
    expect((await get('/answer?token=b')).body.answered).toBe(false);
    expect((await get('/answer?token=c')).body.text).toBe('给 c 的');
  });
});

describe('POST /answer · 外部投递', () => {
  it('投递成功 → accepted=true，随后 GET 能查到', async () => {
    await post('/watch', { token: 't1', chatId: 'oc_a' });
    const r = await post('/answer', { token: 't1', text: '好的', via: 'button', by: 'ou_u' });
    expect(r.body).toEqual({ ok: true, accepted: true });

    const got = await get('/answer?token=t1');
    expect(got.body).toMatchObject({ answered: true, text: '好的', via: 'button', by: 'ou_u' });
  });

  it('重复投递 → accepted=false，第一个答案不被覆盖（幂等）', async () => {
    await post('/watch', { token: 't1', chatId: 'oc_a' });
    await post('/answer', { token: 't1', text: '第一次' });
    const again = await post('/answer', { token: 't1', text: '第二次' });
    expect(again.body.accepted).toBe(false);
    expect((await get('/answer?token=t1')).body.text).toBe('第一次');
  });

  it('未知 token → accepted=false 但 HTTP 仍是 200', async () => {
    const r = await post('/answer', { token: 'ghost', text: 'x' });
    expect(r.status).toBe(200);
    expect(r.body.accepted).toBe(false);
  });

  it('via 非 message 时归一成 button（含缺省）', async () => {
    await post('/watch', { token: 't1', chatId: 'oc_a' });
    await post('/answer', { token: 't1', text: 'x', via: 'whatever' });
    expect((await get('/answer?token=t1')).body.via).toBe('button');
  });

  it('via=message 保留', async () => {
    await post('/watch', { token: 't1', chatId: 'oc_a' });
    await post('/answer', { token: 't1', text: 'x', via: 'message' });
    expect((await get('/answer?token=t1')).body.via).toBe('message');
  });

  it('text 为空串是合法的（表示"空回复"），只有缺字段才 400', async () => {
    await post('/watch', { token: 't1', chatId: 'oc_a' });
    expect((await post('/answer', { token: 't1', text: '' })).body.accepted).toBe(true);
    expect((await post('/answer', { token: 't1' })).status).toBe(400);
    expect((await post('/answer', { text: 'x' })).status).toBe(400);
  });
});

describe('POST /forget', () => {
  it('删掉后 GET 返回 known=false', async () => {
    await post('/watch', { token: 't1', chatId: 'oc_a' });
    expect((await post('/forget', { token: 't1' })).body).toEqual({ ok: true });
    expect((await get('/answer?token=t1')).body.known).toBe(false);
  });

  it('不带 token 也返回 ok（幂等，不报错）', async () => {
    const r = await post('/forget', {});
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
  });

  it('删不存在的 token 不报错', async () => {
    expect((await post('/forget', { token: 'ghost' })).status).toBe(200);
  });
});

describe('GET /pending', () => {
  it('默认关闭 → 404，并提示怎么开', async () => {
    const r = await get('/pending');
    expect(r.status).toBe(404);
    expect(r.body.error).toContain('FEISHU_GATEWAY_DEBUG');
  });

  it('debug 开启后返回待答列表', async () => {
    await restart({ debug: true });
    await post('/watch', { token: 't1', chatId: 'oc_a' });
    await post('/watch', { token: 't2', chatId: 'oc_b' });
    state.resolveAsk('t1', { text: 'x', via: 'button' });

    const r = await get('/pending');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.asks).toHaveLength(2);
    expect(r.body.asks.map((a: any) => [a.token, a.answered])).toEqual([
      ['t1', true],
      ['t2', false],
    ]);
  });
});

describe('POST /push + GET /recent', () => {
  it('推送消息后能在 /recent 里读到', async () => {
    const r = await post('/push', {
      messageId: 'om_1',
      chatId: 'oc_a',
      msgType: 'text',
      createTime: 123,
      text: '你好',
      senderOpenId: 'ou_u',
    });
    expect(r.body).toEqual({ ok: true });

    const recent = await get('/recent?chat_id=oc_a');
    expect(recent.body.messages).toHaveLength(1);
    expect(recent.body.messages[0]).toMatchObject({
      messageId: 'om_1',
      chatId: 'oc_a',
      text: '你好',
      createTime: 123,
      senderOpenId: 'ou_u',
    });
  });

  it('缺 chatId 或 messageId → 400', async () => {
    expect((await post('/push', { messageId: 'om_1' })).status).toBe(400);
    expect((await post('/push', { chatId: 'oc_a' })).status).toBe(400);
  });

  it('msgType/createTime/text 有默认值', async () => {
    await post('/push', { messageId: 'om_1', chatId: 'oc_a' });
    const m = (await get('/recent?chat_id=oc_a')).body.messages[0];
    expect(m.msgType).toBe('text');
    expect(m.text).toBe('');
    expect(typeof m.createTime).toBe('number');
  });

  it('推送消息会触发唯一待答的自动认领（端到端）', async () => {
    await post('/watch', { token: 't1', chatId: 'oc_a', baselineSec: 100 });
    await post('/push', { messageId: 'om_9', chatId: 'oc_a', createTime: 101, text: '选 B' });
    const a = await get('/answer?token=t1');
    expect(a.body).toMatchObject({ answered: true, text: '选 B', via: 'message' });
  });

  it('/recent 缺 chat_id → 400', async () => {
    expect((await get('/recent')).status).toBe(400);
  });

  it('/recent 的 limit 生效；非数字回退 20', async () => {
    for (let i = 0; i < 25; i++) {
      await post('/push', { messageId: `om_${i}`, chatId: 'oc_a', createTime: i, text: `m${i}` });
    }
    expect((await get('/recent?chat_id=oc_a&limit=3')).body.messages).toHaveLength(3);
    expect((await get('/recent?chat_id=oc_a&limit=abc')).body.messages).toHaveLength(20);
  });

  it('/recent 只返回指定会话的消息', async () => {
    await post('/push', { messageId: 'om_1', chatId: 'oc_a' });
    await post('/push', { messageId: 'om_2', chatId: 'oc_b' });
    expect((await get('/recent?chat_id=oc_b')).body.messages.map((m: any) => m.messageId)).toEqual([
      'om_2',
    ]);
  });
});

describe('未知路由', () => {
  it('返回 404 且带上请求的路由', async () => {
    const r = await get('/nope');
    expect(r.status).toBe(404);
    expect(r.body.ok).toBe(false);
    expect(r.body.error).toContain('GET /nope');
  });

  it('未知 POST 也是 404', async () => {
    expect((await post('/nope', {})).status).toBe(404);
  });

  it('根路径 404', async () => {
    expect((await get('/')).status).toBe(404);
  });
});
