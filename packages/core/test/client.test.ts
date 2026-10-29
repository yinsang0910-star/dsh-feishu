/**
 * FeishuClient 单测：全程 mock fetch，不连飞书、不需要凭据。
 *
 * 覆盖四块最容易出事的地方：
 *   1. tenant_access_token 的缓存 + 并发去重（多工具同时调用只刷一次）
 *   2. 错误码 → FeishuApiError 的翻译（含 httpStatus / path / method）
 *   3. 权限错误的 isPermission 与 missingScopes 解析
 *   4. normalizeTarget 的 id 类型推断（.text 是 oc_ / 含 @ / ou_ / 其他）
 * 另外补了重试语义、token 过期重试、mapMessage 的边界。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FeishuClient } from '../src/client.js';
import { FeishuApiError, type FeishuConfig } from '../src/types.js';

const DOMAIN = 'https://open.feishu.cn';

let fetchMock: ReturnType<typeof vi.fn>;

/** 客户端只用 res.status 和 res.json()，这里给个最小 Response 替身 */
function jsonResponse(body: unknown, status = 200): Response {
  return { status, json: async () => body } as unknown as Response;
}

function tokenOk(token = 'tok_1', expire = 7200): Response {
  return jsonResponse({ code: 0, tenant_access_token: token, expire });
}

function makeClient(overrides: Partial<FeishuConfig> = {}): FeishuClient {
  return new FeishuClient({
    appId: 'cli_test',
    appSecret: 'secret',
    domain: DOMAIN,
    maxRetries: 0,
    ...overrides,
  });
}

/** 按 URL 分流的 mock：token 端点与业务端点各走各的 */
function routeFetch(handlers: { token?: () => Response; api?: (url: string, init: any) => Response }): void {
  fetchMock.mockImplementation((url: string, init: any) =>
    Promise.resolve(
      String(url).includes('/tenant_access_token/')
        ? (handlers.token ?? (() => tokenOk()))()
        : (handlers.api ?? (() => jsonResponse({ code: 0, data: {} })))(String(url), init),
    ),
  );
}

const callUrl = (i: number): string => String(fetchMock.mock.calls[i]![0]);
const callInit = (i: number): any => fetchMock.mock.calls[i]![1];

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('构造函数', () => {
  it('domain 的尾斜杠被裁掉，缺省字段补默认值', () => {
    const c = new FeishuClient({ appId: 'a', appSecret: 'b', domain: 'https://open.larksuite.com//' });
    expect(c.config.domain).toBe('https://open.larksuite.com');
    expect(c.config.defaultReceiveIdType).toBe('chat_id');
    expect(c.config.requestTimeoutMs).toBe(30_000);
    expect(c.config.maxRetries).toBe(2);
  });

  it('不传 domain 时用飞书默认域名', () => {
    const c = new FeishuClient({ appId: 'a', appSecret: 'b' });
    expect(c.config.domain).toBe(DOMAIN);
  });
});

describe('tenant_access_token', () => {
  it('第一次请求取 token，第二次直接命中缓存', async () => {
    routeFetch({});
    const c = makeClient();
    expect(await c.token()).toBe('tok_1');
    expect(await c.token()).toBe('tok_1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('token 请求带上 app_id / app_secret，且打到正确的端点', async () => {
    routeFetch({});
    const c = makeClient();
    await c.token();
    expect(callUrl(0)).toBe(`${DOMAIN}/open-apis/auth/v3/tenant_access_token/internal`);
    expect(callInit(0).method).toBe('POST');
    expect(JSON.parse(callInit(0).body)).toEqual({ app_id: 'cli_test', app_secret: 'secret' });
  });

  it('并发调用只发一次请求（去重），三个调用方拿到同一个 token', async () => {
    let release!: (r: Response) => void;
    fetchMock.mockImplementation(() => new Promise<Response>((r) => (release = r)));

    const c = makeClient();
    const p1 = c.token();
    const p2 = c.token();
    const p3 = c.token();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    release(tokenOk('tok_shared'));
    expect(await Promise.all([p1, p2, p3])).toEqual(['tok_shared', 'tok_shared', 'tok_shared']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('缓存过期（expire=0）后下次调用会重新取', async () => {
    routeFetch({ token: () => tokenOk('tok_zero', 0) });
    const c = makeClient();
    expect(await c.token()).toBe('tok_zero');
    expect(await c.token()).toBe('tok_zero');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('expire 缺失时按 7200 秒缓存，不会每次都刷', async () => {
    routeFetch({ token: () => jsonResponse({ code: 0, tenant_access_token: 'tok_noexp' }) });
    const c = makeClient();
    await c.token();
    await c.token();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('取 token 失败抛 FeishuApiError（带 code 与端点路径）', async () => {
    routeFetch({ token: () => jsonResponse({ code: 99991672, msg: 'app 未开通' }) });
    const c = makeClient();
    const err = (await c.token().catch((e) => e)) as FeishuApiError;
    expect(err).toBeInstanceOf(FeishuApiError);
    expect(err.code).toBe(99991672);
    expect(err.path).toBe('/auth/v3/tenant_access_token/internal');
    expect(err.method).toBe('POST');
    expect(err.message).toContain('app 未开通');
  });

  it('返回体缺 tenant_access_token 也按失败处理', async () => {
    routeFetch({ token: () => jsonResponse({ code: 0 }) });
    const c = makeClient();
    await expect(c.token()).rejects.toBeInstanceOf(FeishuApiError);
  });

  it('失败不会被缓存：下次调用会重新尝试并成功', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ code: 500, msg: 'boom' }))
      .mockResolvedValueOnce(tokenOk('tok_after_fail'));
    const c = makeClient();
    await expect(c.token()).rejects.toBeInstanceOf(FeishuApiError);
    expect(await c.token()).toBe('tok_after_fail');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('request · 成功路径', () => {
  it('code=0 时返回 data，并带上 Bearer 头与查询串', async () => {
    routeFetch({ api: () => jsonResponse({ code: 0, data: { message_id: 'om_1', chat_id: 'oc_1' } }) });
    const c = makeClient();
    const data = await c.request('POST', '/im/v1/messages', {
      query: { receive_id_type: 'chat_id' },
      body: { receive_id: 'oc_1', msg_type: 'text' },
    });

    expect(data).toEqual({ message_id: 'om_1', chat_id: 'oc_1' });
    expect(callUrl(1)).toBe(`${DOMAIN}/open-apis/im/v1/messages?receive_id_type=chat_id`);
    expect(callInit(1).method).toBe('POST');
    expect(callInit(1).headers.Authorization).toBe('Bearer tok_1');
    expect(callInit(1).headers['Content-Type']).toContain('application/json');
    expect(JSON.parse(callInit(1).body)).toEqual({ receive_id: 'oc_1', msg_type: 'text' });
  });

  it('query 里的 undefined / null / 空串被丢掉，0 保留', async () => {
    routeFetch({});
    const c = makeClient();
    await c.request('GET', '/im/v1/messages', {
      query: { a: undefined, b: '', c: 0, d: 'x' },
    });
    expect(callUrl(1)).toBe(`${DOMAIN}/open-apis/im/v1/messages?c=0&d=x`);
  });

  it('没有 body 时不带 Content-Type 与 body', async () => {
    routeFetch({});
    const c = makeClient();
    await c.request('GET', '/im/v1/chats');
    expect(callInit(1).headers['Content-Type']).toBeUndefined();
    expect(callInit(1).body).toBeUndefined();
  });

  it('data 缺失时返回空对象', async () => {
    routeFetch({ api: () => jsonResponse({ code: 0 }) });
    const c = makeClient();
    expect(await c.request('GET', '/x')).toEqual({});
  });

  it('unwrap=false 时返回整个响应体', async () => {
    routeFetch({ api: () => jsonResponse({ code: 0, data: { a: 1 }, extra: 'keep' }) });
    const c = makeClient();
    expect(await c.request('GET', '/x', { unwrap: false })).toEqual({
      code: 0,
      data: { a: 1 },
      extra: 'keep',
    });
  });
});

describe('request · 错误翻译', () => {
  it('非 0 code 抛 FeishuApiError，字段齐全', async () => {
    routeFetch({ api: () => jsonResponse({ code: 230002, msg: '群不存在' }, 400) });
    const c = makeClient();
    const err = (await c.request('POST', '/im/v1/messages').catch((e) => e)) as FeishuApiError;

    expect(err).toBeInstanceOf(FeishuApiError);
    expect(err.code).toBe(230002);
    expect(err.httpStatus).toBe(400);
    expect(err.path).toBe('/im/v1/messages');
    expect(err.method).toBe('POST');
    expect(err.message).toBe('[POST /im/v1/messages] code=230002: 群不存在');
    expect(err.detail).toMatchObject({ code: 230002 });
  });

  it('msg 缺失时用 unknown error 兜底', async () => {
    routeFetch({ api: () => jsonResponse({ code: 1 }) });
    const c = makeClient();
    const err = (await c.request('GET', '/x').catch((e) => e)) as FeishuApiError;
    expect(err.message).toContain('unknown error');
  });

  it('业务错误不做重试（maxRetries=2 也只发一次）', async () => {
    routeFetch({ api: () => jsonResponse({ code: 230002, msg: 'no' }) });
    const c = makeClient({ maxRetries: 2 });
    await expect(c.request('GET', '/x')).rejects.toBeInstanceOf(FeishuApiError);
    expect(fetchMock).toHaveBeenCalledTimes(2); // 1 次 token + 1 次业务
  });
});

describe('FeishuApiError · 权限判定与 scope 解析', () => {
  const permCodes = [99991672, 69991672, 230027];

  it.each(permCodes)('code=%i 时 isPermission 为 true', (code) => {
    const err = new FeishuApiError({ code, message: 'x', path: '/p', method: 'GET' });
    expect(err.isPermission).toBe(true);
  });

  it('其他 code 不是权限错误', () => {
    for (const code of [0, 230002, 99991663, -1]) {
      expect(new FeishuApiError({ code, message: 'x', path: '/p', method: 'GET' }).isPermission).toBe(
        false,
      );
    }
  });

  it('从错误文本的方括号里解析出缺失的 scope 列表', () => {
    const err = new FeishuApiError({
      code: 99991672,
      message:
        'Access denied. One of the following scopes is required: [im:message:send_as_bot, contact:user.base:readonly]',
      path: '/im/v1/messages',
      method: 'POST',
    });
    expect(err.missingScopes).toEqual(['im:message:send_as_bot', 'contact:user.base:readonly']);
  });

  it('单个 scope 也能解析', () => {
    const err = new FeishuApiError({
      code: 99991672,
      message: 'need [im:message.group_msg]',
      path: '/p',
      method: 'GET',
    });
    expect(err.missingScopes).toEqual(['im:message.group_msg']);
  });

  it('没有方括号时返回空数组（不会误把请求路径当 scope）', () => {
    const err = new FeishuApiError({
      code: 99991672,
      message: 'permission denied',
      path: '/im/v1/messages',
      method: 'POST',
    });
    expect(err.missingScopes).toEqual([]);
  });

  it('从真实 request() 抛出的错误上也能拿到 missingScopes', async () => {
    routeFetch({
      api: () =>
        jsonResponse({ code: 99991672, msg: 'Access denied: [im:message:send_as_bot]' }),
    });
    const c = makeClient();
    const err = (await c.request('POST', '/im/v1/messages').catch((e) => e)) as FeishuApiError;
    expect(err.isPermission).toBe(true);
    expect(err.missingScopes).toEqual(['im:message:send_as_bot']);
  });
});

describe('request · 网络错误与重试', () => {
  it('网络错误重试后成功（maxRetries=1，失败一次再成功）', async () => {
    let apiCalls = 0;
    routeFetch({
      api: () => {
        apiCalls++;
        if (apiCalls === 1) throw new TypeError('fetch failed');
        return jsonResponse({ code: 0, data: { ok: true } });
      },
    });
    const c = makeClient({ maxRetries: 1 });
    expect(await c.request('GET', '/x')).toEqual({ ok: true });
    expect(apiCalls).toBe(2);
  });

  it('重试耗尽后抛 code=-1 的 FeishuApiError，message 里带原始原因', async () => {
    routeFetch({
      api: () => {
        throw new TypeError('socket hang up');
      },
    });
    const c = makeClient({ maxRetries: 0 });
    const err = (await c.request('GET', '/x').catch((e) => e)) as FeishuApiError;
    expect(err).toBeInstanceOf(FeishuApiError);
    expect(err.code).toBe(-1);
    expect(err.message).toContain('socket hang up');
    expect(err.httpStatus).toBe(200);
  });

  it('超时（AbortError）同样被翻译成 FeishuApiError，不会裸抛', async () => {
    routeFetch({
      api: () => {
        throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
      },
    });
    const c = makeClient({ maxRetries: 0, requestTimeoutMs: 1 });
    const err = (await c.request('GET', '/x').catch((e) => e)) as FeishuApiError;
    expect(err).toBeInstanceOf(FeishuApiError);
    expect(err.code).toBe(-1);
    expect(err.message).toContain('请求失败');
  });

  it('响应不是 JSON 时也走重试/兜底，不会抛 SyntaxError 出去', async () => {
    routeFetch({
      api: () => ({ status: 502, json: async () => Promise.reject(new SyntaxError('bad json')) }) as unknown as Response,
    });
    const c = makeClient({ maxRetries: 0 });
    await expect(c.request('GET', '/x')).rejects.toBeInstanceOf(FeishuApiError);
  });
});

describe('request · token 过期自动续期', () => {
  it('code=99991663 时清缓存、换新 token 并重放一次请求', async () => {
    let tokenCalls = 0;
    let apiCalls = 0;
    routeFetch({
      token: () => tokenOk(++tokenCalls === 1 ? 'tok_old' : 'tok_new'),
      api: () => {
        apiCalls++;
        return apiCalls === 1
          ? jsonResponse({ code: 99991663, msg: 'token expired' })
          : jsonResponse({ code: 0, data: { ok: 1 } });
      },
    });
    const c = makeClient({ maxRetries: 2 });
    expect(await c.request('GET', '/x')).toEqual({ ok: 1 });
    expect(tokenCalls).toBe(2);
    expect(apiCalls).toBe(2);
    // 第二次业务请求带的是新 token
    expect(callInit(3).headers.Authorization).toBe('Bearer tok_new');
  });

  it('code=99991661 也按过期处理', async () => {
    let apiCalls = 0;
    routeFetch({
      api: () => {
        apiCalls++;
        return apiCalls === 1 ? jsonResponse({ code: 99991661, msg: 'invalid token' }) : jsonResponse({ code: 0, data: {} });
      },
    });
    const c = makeClient({ maxRetries: 2 });
    await expect(c.request('GET', '/x')).resolves.toEqual({});
    expect(apiCalls).toBe(2);
  });

  it('maxRetries=0 时 token 过期仍会续期一次并成功（续期不占重试预算）', async () => {
    let apiCalls = 0;
    routeFetch({
      api: () => {
        apiCalls += 1;
        // 第一次过期，续期后第二次成功
        return apiCalls === 1
          ? jsonResponse({ code: 99991663, msg: 'token expired' })
          : jsonResponse({ code: 0, data: { ok: 1 } });
      },
    });
    const c = makeClient({ maxRetries: 0 });
    await expect(c.request('GET', '/x')).resolves.toEqual({ ok: 1 });
    expect(apiCalls).toBe(2);
  });

  it('maxRetries=0 且续期后仍然过期时，把 99991663 原样抛出而不是伪装成 -1', async () => {
    routeFetch({
      api: () => jsonResponse({ code: 99991663, msg: 'token expired' }),
    });
    const c = makeClient({ maxRetries: 0 });
    const err = (await c.request('GET', '/x').catch((e) => e)) as FeishuApiError;
    expect(err).toBeInstanceOf(FeishuApiError);
    expect(err.code).toBe(99991663);
    expect(err.message).not.toContain('undefined');
  });
});

describe('normalizeTarget · 发送目标推断', () => {
  const nt = (c: FeishuClient, target?: unknown) =>
    (c as unknown as { normalizeTarget(t?: unknown): { id: string; idType: string } }).normalizeTarget(
      target,
    );

  it('不传 target 时用默认会话与默认类型', () => {
    const c = makeClient({ defaultChatId: 'oc_default', defaultReceiveIdType: 'chat_id' });
    expect(nt(c)).toEqual({ id: 'oc_default', idType: 'chat_id' });
  });

  it('不传 target 且没有默认会话时抛 code=-2（本地错误，不发请求）', () => {
    const c = makeClient();
    let err: FeishuApiError | undefined;
    try {
      nt(c);
    } catch (e) {
      err = e as FeishuApiError;
    }
    expect(err).toBeInstanceOf(FeishuApiError);
    expect(err!.code).toBe(-2);
    expect(err!.path).toBe('(local)');
    expect(err!.message).toContain('FEISHU_DEFAULT_CHAT_ID');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('oc_ 开头 → chat_id', () => {
    expect(nt(makeClient(), 'oc_abc123')).toEqual({ id: 'oc_abc123', idType: 'chat_id' });
  });

  it('含 @ → email', () => {
    expect(nt(makeClient(), 'a@b.com')).toEqual({ id: 'a@b.com', idType: 'email' });
  });

  it('ou_ 开头 → open_id', () => {
    expect(nt(makeClient(), 'ou_xyz789')).toEqual({ id: 'ou_xyz789', idType: 'open_id' });
  });

  it('其他字符串 → 回落到默认 receiveIdType', () => {
    expect(nt(makeClient(), 'user_123')).toEqual({ id: 'user_123', idType: 'chat_id' });
    expect(nt(makeClient({ defaultReceiveIdType: 'user_id' }), 'u1')).toEqual({
      id: 'u1',
      idType: 'user_id',
    });
  });

  it('oc_ 优先于 @（推断顺序：oc_ → @ → ou_）', () => {
    expect(nt(makeClient(), 'oc_x@y.com').idType).toBe('chat_id');
  });

  it('对象形式：显式 idType 优先，缺省用默认值', () => {
    expect(nt(makeClient(), { id: 'x', idType: 'union_id' })).toEqual({ id: 'x', idType: 'union_id' });
    expect(nt(makeClient({ defaultReceiveIdType: 'email' }), { id: 'x' })).toEqual({
      id: 'x',
      idType: 'email',
    });
  });
});

describe('mapMessage · 原始消息归一化', () => {
  const mm = (c: FeishuClient, raw: Record<string, unknown>) =>
    (c as unknown as { mapMessage(r: Record<string, unknown>): Record<string, any> }).mapMessage(raw);

  const full = {
    message_id: 'om_1',
    chat_id: 'oc_1',
    msg_type: 'text',
    create_time: '1700000000000',
    update_time: '1700000001000',
    parent_id: 'om_0',
    root_id: 'om_root',
    thread_id: 'omt_1',
    deleted: true,
    body: { content: '{"text":"你好"}' },
    sender: { sender_id: { open_id: 'ou_sender' }, sender_type: 'user' },
    mentions: [{ key: '@_user_1', name: '张三', id: { open_id: 'ou_zhang' } }],
  };

  it('字段完整时全部映射到位，content 被 JSON.parse', () => {
    const m = mm(makeClient(), full);
    expect(m.messageId).toBe('om_1');
    expect(m.chatId).toBe('oc_1');
    expect(m.msgType).toBe('text');
    expect(m.rawContent).toBe('{"text":"你好"}');
    expect(m.content).toEqual({ text: '你好' });
    expect(m.createTime).toBe('1700000000000');
    expect(m.updateTime).toBe('1700000001000');
    expect(m.senderId).toBe('ou_sender');
    expect(m.senderType).toBe('user');
    expect(m.parentId).toBe('om_0');
    expect(m.rootId).toBe('om_root');
    expect(m.threadId).toBe('omt_1');
    expect(m.deleted).toBe(true);
    expect(m.mentions).toEqual([{ key: '@_user_1', name: '张三', openId: 'ou_zhang' }]);
  });

  it('空对象时不炸：字符串字段全为空串，可选字段为 undefined', () => {
    const m = mm(makeClient(), {});
    expect(m.messageId).toBe('');
    expect(m.chatId).toBe('');
    expect(m.msgType).toBe('');
    expect(m.rawContent).toBe('');
    expect(m.content).toBeUndefined();
    expect(m.senderId).toBeUndefined();
    expect(m.mentions).toBeUndefined();
    expect(m.deleted).toBe(false);
  });

  it('content 不是合法 JSON 时 content=undefined，rawContent 仍保留原文', () => {
    const m = mm(makeClient(), { body: { content: 'not json' } });
    expect(m.content).toBeUndefined();
    expect(m.rawContent).toBe('not json');
  });

  it('content 为空串时 content=undefined（不尝试解析空串）', () => {
    expect(mm(makeClient(), { body: { content: '' } }).content).toBeUndefined();
  });

  it('mentions 不是数组时忽略', () => {
    expect(mm(makeClient(), { mentions: 'nope' }).mentions).toBeUndefined();
  });

  it('mention 缺字段时补空串/undefined', () => {
    expect(mm(makeClient(), { mentions: [{}] }).mentions).toEqual([
      { key: '', name: undefined, openId: undefined },
    ]);
  });

  it('deleted 用 Boolean 强转，非布尔真值算已删除', () => {
    expect(mm(makeClient(), { deleted: 1 }).deleted).toBe(true);
    expect(mm(makeClient(), { deleted: undefined }).deleted).toBe(false);
  });
});

describe('listMessages · 通过 mock fetch 走一遍完整链路', () => {
  it('items 被逐条 mapMessage，has_more / page_token 透传', async () => {
    routeFetch({
      api: () =>
        jsonResponse({
          code: 0,
          data: {
            items: [
              {
                message_id: 'om_1',
                chat_id: 'oc_1',
                msg_type: 'text',
                create_time: '1',
                body: { content: '{"text":"a"}' },
              },
              { message_id: 'om_2', chat_id: 'oc_1', msg_type: 'image', body: { content: '' } },
            ],
            has_more: true,
            page_token: 'p2',
          },
        }),
    });
    const c = makeClient();
    const r = await c.listMessages('oc_1', { pageSize: 2, sort: 'asc', startTimeSec: 100 });

    expect(r.items).toHaveLength(2);
    expect(r.items[0]!.content).toEqual({ text: 'a' });
    expect(r.items[1]!.content).toBeUndefined();
    expect(r.hasMore).toBe(true);
    expect(r.pageToken).toBe('p2');
    expect(callUrl(1)).toContain('container_id=oc_1');
    expect(callUrl(1)).toContain('sort_type=ByCreateTimeAsc');
    expect(callUrl(1)).toContain('page_size=2');
    expect(callUrl(1)).toContain('start_time=100');
  });

  it('空结果返回空数组与 hasMore=false', async () => {
    routeFetch({ api: () => jsonResponse({ code: 0, data: {} }) });
    const r = await makeClient().listMessages('oc_1');
    expect(r.items).toEqual([]);
    expect(r.hasMore).toBe(false);
    expect(r.pageToken).toBeUndefined();
  });

  it('默认按时间倒序（最近优先）', async () => {
    routeFetch({});
    await makeClient().listMessages('oc_1');
    expect(callUrl(1)).toContain('sort_type=ByCreateTimeDesc');
  });
});

describe('getMessage', () => {
  it('有 items 时返回第一条', async () => {
    routeFetch({
      api: () => jsonResponse({ code: 0, data: { items: [{ message_id: 'om_9', chat_id: 'oc_9' }] } }),
    });
    const m = await makeClient().getMessage('om_9');
    expect(m!.messageId).toBe('om_9');
    expect(callUrl(1)).toBe(`${DOMAIN}/open-apis/im/v1/messages/om_9`);
  });

  it('items 为空时返回 null', async () => {
    routeFetch({ api: () => jsonResponse({ code: 0, data: { items: [] } }) });
    expect(await makeClient().getMessage('om_x')).toBeNull();
  });

  it('messageId 会被 URL 编码', async () => {
    routeFetch({ api: () => jsonResponse({ code: 0, data: { items: [] } }) });
    await makeClient().getMessage('a b/c');
    expect(callUrl(1)).toBe(`${DOMAIN}/open-apis/im/v1/messages/a%20b%2Fc`);
  });
});
