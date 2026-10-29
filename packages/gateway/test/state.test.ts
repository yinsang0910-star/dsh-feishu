/**
 * 网关状态机单测。
 *
 * 这是整个项目逻辑最密的一块：ask 的注册/作答/清理，以及"消息兜底回答"的
 * 自动认领规则（只有恰好一个待答时才认领，否则宁可不猜）。
 * 用假时钟把 15 分钟过期窗口压成一次 setSystemTime，测试不 sleep。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GatewayState, type CachedMessage } from '../src/state.js';

const T0 = new Date('2026-01-01T00:00:00.000Z');
const SEC = 1000;
const MIN = 60 * SEC;

function msg(overrides: Partial<CachedMessage> = {}): CachedMessage {
  return {
    messageId: 'om_1',
    chatId: 'oc_a',
    msgType: 'text',
    createTime: Math.floor(Date.now() / 1000),
    text: '好的',
    senderOpenId: 'ou_human',
    ...overrides,
  };
}

let state: GatewayState;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  state = new GatewayState();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('registerAsk', () => {
  it('返回完整的待答记录，createdAt 取当前时间', () => {
    const ask = state.registerAsk({ token: 't1', chatId: 'oc_a', question: '选哪个？' });
    expect(ask.token).toBe('t1');
    expect(ask.chatId).toBe('oc_a');
    expect(ask.question).toBe('选哪个？');
    expect(ask.createdAt).toBe(T0.getTime());
    expect(ask.answered).toBeUndefined();
  });

  it('baselineSec 缺省为当前秒（用于过滤"提问之前的旧消息"）', () => {
    const ask = state.registerAsk({ token: 't1', chatId: 'oc_a', question: 'q' });
    expect(ask.baselineSec).toBe(Math.floor(T0.getTime() / 1000));
  });

  it('显式 baselineSec 原样保留', () => {
    const ask = state.registerAsk({ token: 't1', chatId: 'oc_a', question: 'q', baselineSec: 12345 });
    expect(ask.baselineSec).toBe(12345);
  });

  it('注册后能按 token 查到，并出现在 pendingList', () => {
    state.registerAsk({ token: 't1', chatId: 'oc_a', question: 'q' });
    expect(state.getAsk('t1')?.token).toBe('t1');
    expect(state.pendingList()).toEqual([
      { token: 't1', chatId: 'oc_a', ageMs: 0, answered: false },
    ]);
  });

  it('同 token 重复注册会覆盖旧记录（包括已作答状态）', () => {
    state.registerAsk({ token: 't1', chatId: 'oc_a', question: '旧问题' });
    state.resolveAsk('t1', { text: '旧答案', via: 'button' });
    const again = state.registerAsk({ token: 't1', chatId: 'oc_b', question: '新问题' });
    expect(again.question).toBe('新问题');
    expect(state.getAsk('t1')?.answered).toBeUndefined();
    expect(state.pendingList()).toHaveLength(1);
  });
});

describe('resolveAsk', () => {
  it('第一次作答返回 true 并写入答案内容', () => {
    state.registerAsk({ token: 't1', chatId: 'oc_a', question: 'q' });
    expect(
      state.resolveAsk('t1', {
        text: '选 A',
        via: 'button',
        byOpenId: 'ou_u',
        messageId: 'om_9',
      }),
    ).toBe(true);
    expect(state.getAsk('t1')?.answered).toMatchObject({
      text: '选 A',
      via: 'button',
      byOpenId: 'ou_u',
      messageId: 'om_9',
      at: T0.getTime(),
    });
  });

  it('重复作答返回 false 且不覆盖第一个答案（幂等）', () => {
    state.registerAsk({ token: 't1', chatId: 'oc_a', question: 'q' });
    expect(state.resolveAsk('t1', { text: '第一次', via: 'button' })).toBe(true);
    expect(state.resolveAsk('t1', { text: '第二次', via: 'message' })).toBe(false);
    expect(state.getAsk('t1')?.answered?.text).toBe('第一次');
    expect(state.getAsk('t1')?.answered?.via).toBe('button');
  });

  it('未知 token 返回 false（不抛错，供 HTTP 层直接回 accepted=false）', () => {
    expect(state.resolveAsk('nope', { text: 'x', via: 'button' })).toBe(false);
  });

  it('作答后 pendingList 标记 answered=true', () => {
    state.registerAsk({ token: 't1', chatId: 'oc_a', question: 'q' });
    state.resolveAsk('t1', { text: 'x', via: 'message' });
    expect(state.pendingList()[0]!.answered).toBe(true);
  });
});

describe('dropAsk / pendingList', () => {
  it('dropAsk 之后查不到，pendingList 也清空', () => {
    state.registerAsk({ token: 't1', chatId: 'oc_a', question: 'q' });
    state.dropAsk('t1');
    expect(state.getAsk('t1')).toBeUndefined();
    expect(state.pendingList()).toEqual([]);
  });

  it('dropAsk 不存在的 token 不抛错', () => {
    expect(() => state.dropAsk('nope')).not.toThrow();
  });

  it('pendingList 不泄漏问题正文（只给 token/chatId/age/answered）', () => {
    state.registerAsk({ token: 't1', chatId: 'oc_a', question: '这是机密问题' });
    const [item] = state.pendingList();
    expect(Object.keys(item!).sort()).toEqual(['ageMs', 'answered', 'chatId', 'token']);
    expect(JSON.stringify(state.pendingList())).not.toContain('这是机密问题');
  });

  it('ageMs 随时间增长', () => {
    state.registerAsk({ token: 't1', chatId: 'oc_a', question: 'q' });
    vi.setSystemTime(T0.getTime() + 5 * SEC);
    expect(state.pendingList()[0]!.ageMs).toBe(5 * SEC);
  });
});

describe('pushMessage · 消息缓存', () => {
  it('按会话过滤并保持时间顺序', () => {
    state.pushMessage(msg({ messageId: 'm1', chatId: 'oc_a', text: 'a' }));
    state.pushMessage(msg({ messageId: 'm2', chatId: 'oc_b', text: 'b' }));
    state.pushMessage(msg({ messageId: 'm3', chatId: 'oc_a', text: 'c' }));
    expect(state.recentMessages('oc_a').map((m) => m.messageId)).toEqual(['m1', 'm3']);
    expect(state.recentMessages('oc_b').map((m) => m.messageId)).toEqual(['m2']);
  });

  it('没有消息时返回空数组', () => {
    expect(state.recentMessages('oc_none')).toEqual([]);
  });

  it('limit 取最后 N 条', () => {
    for (let i = 0; i < 10; i++) state.pushMessage(msg({ messageId: `m${i}`, chatId: 'oc_a' }));
    expect(state.recentMessages('oc_a', 3).map((m) => m.messageId)).toEqual(['m7', 'm8', 'm9']);
  });

  it('默认 limit 是 20', () => {
    for (let i = 0; i < 25; i++) state.pushMessage(msg({ messageId: `m${i}`, chatId: 'oc_a' }));
    const got = state.recentMessages('oc_a');
    expect(got).toHaveLength(20);
    expect(got[19]!.messageId).toBe('m24');
  });

  it('limit=0 时返回全部（slice(-0)===slice(0)，与直觉不符，此处锁现状）', () => {
    for (let i = 0; i < 5; i++) state.pushMessage(msg({ messageId: `m${i}`, chatId: 'oc_a' }));
    expect(state.recentMessages('oc_a', 0)).toHaveLength(5);
  });

  it('总量上限 500 条，超出丢弃最旧的', () => {
    for (let i = 0; i < 505; i++) state.pushMessage(msg({ messageId: `m${i}`, chatId: 'oc_a' }));
    const got = state.recentMessages('oc_a', 1000);
    expect(got).toHaveLength(500);
    expect(got[0]!.messageId).toBe('m5');
    expect(got[499]!.messageId).toBe('m504');
  });
});

describe('pushMessage · 唯一待答的自动认领', () => {
  it('恰好一个待答时，新消息自动成为答案', () => {
    state.registerAsk({ token: 't1', chatId: 'oc_a', question: 'q', baselineSec: 100 });
    state.pushMessage(
      msg({ messageId: 'om_7', chatId: 'oc_a', createTime: 101, text: '我选 B', senderOpenId: 'ou_human' }),
    );
    const answered = state.getAsk('t1')!.answered!;
    expect(answered.text).toBe('我选 B');
    expect(answered.via).toBe('message');
    expect(answered.messageId).toBe('om_7');
    expect(answered.byOpenId).toBe('ou_human');
  });

  it('消息时间正好等于 baselineSec 也算（>= 比较）', () => {
    state.registerAsk({ token: 't1', chatId: 'oc_a', question: 'q', baselineSec: 100 });
    state.pushMessage(msg({ chatId: 'oc_a', createTime: 100, text: '卡点回复' }));
    expect(state.getAsk('t1')!.answered?.text).toBe('卡点回复');
  });

  it('同一会话有两个待答时不认领（宁可不猜）', () => {
    state.registerAsk({ token: 't1', chatId: 'oc_a', question: 'q1', baselineSec: 100 });
    state.registerAsk({ token: 't2', chatId: 'oc_a', question: 'q2', baselineSec: 100 });
    state.pushMessage(msg({ chatId: 'oc_a', createTime: 101, text: '含糊的回答' }));
    expect(state.getAsk('t1')!.answered).toBeUndefined();
    expect(state.getAsk('t2')!.answered).toBeUndefined();
  });

  it('两个待答分属不同会话时，各自会话的消息互不干扰', () => {
    state.registerAsk({ token: 't1', chatId: 'oc_a', question: 'q1', baselineSec: 100 });
    state.registerAsk({ token: 't2', chatId: 'oc_b', question: 'q2', baselineSec: 100 });
    state.pushMessage(msg({ chatId: 'oc_a', createTime: 101, text: '给 a 的答案' }));
    expect(state.getAsk('t1')!.answered?.text).toBe('给 a 的答案');
    expect(state.getAsk('t2')!.answered).toBeUndefined();
  });

  it('早于 baselineSec 的消息不算答案（旧消息不会污染新提问）', () => {
    state.registerAsk({ token: 't1', chatId: 'oc_a', question: 'q', baselineSec: 500 });
    state.pushMessage(msg({ chatId: 'oc_a', createTime: 499, text: '旧消息' }));
    expect(state.getAsk('t1')!.answered).toBeUndefined();
  });

  it('其他会话的消息不认领', () => {
    state.registerAsk({ token: 't1', chatId: 'oc_a', question: 'q', baselineSec: 100 });
    state.pushMessage(msg({ chatId: 'oc_other', createTime: 101 }));
    expect(state.getAsk('t1')!.answered).toBeUndefined();
  });

  it('已经用按钮答过的提问不会被后续消息覆盖', () => {
    state.registerAsk({ token: 't1', chatId: 'oc_a', question: 'q', baselineSec: 100 });
    state.resolveAsk('t1', { text: '按钮答案', via: 'button' });
    state.pushMessage(msg({ chatId: 'oc_a', createTime: 101, text: '后来的消息' }));
    expect(state.getAsk('t1')!.answered?.text).toBe('按钮答案');
    expect(state.getAsk('t1')!.answered?.via).toBe('button');
  });

  it('两个待答但其中一个已答时，剩下的那个可以认领', () => {
    state.registerAsk({ token: 't1', chatId: 'oc_a', question: 'q1', baselineSec: 100 });
    state.registerAsk({ token: 't2', chatId: 'oc_a', question: 'q2', baselineSec: 100 });
    state.resolveAsk('t1', { text: '按钮答了', via: 'button' });
    state.pushMessage(msg({ chatId: 'oc_a', createTime: 101, text: '消息答另一个' }));
    expect(state.getAsk('t1')!.answered?.text).toBe('按钮答了');
    expect(state.getAsk('t2')!.answered?.text).toBe('消息答另一个');
  });

  it('senderOpenId 与 chatId 相同时不认领（防自我回声的历史判断，锁现状）', () => {
    state.registerAsk({ token: 't1', chatId: 'oc_a', question: 'q', baselineSec: 100 });
    state.pushMessage(
      msg({ chatId: 'oc_a', createTime: 101, senderOpenId: 'oc_a', text: '回声' }),
    );
    expect(state.getAsk('t1')!.answered).toBeUndefined();
  });

  it('没有 senderOpenId 的消息也能认领，只是不带 byOpenId', () => {
    state.registerAsk({ token: 't1', chatId: 'oc_a', question: 'q', baselineSec: 100 });
    state.pushMessage({ messageId: 'om_x', chatId: 'oc_a', msgType: 'text', createTime: 101, text: '匿名' });
    const answered = state.getAsk('t1')!.answered!;
    expect(answered.text).toBe('匿名');
    expect('byOpenId' in answered).toBe(false);
  });
});

describe('sweep · 过期清理', () => {
  it('超过 15 分钟未作答的 ask 被清掉', () => {
    state.registerAsk({ token: 'old', chatId: 'oc_a', question: 'q' });
    vi.setSystemTime(T0.getTime() + 16 * MIN);
    state.sweep();
    expect(state.getAsk('old')).toBeUndefined();
    expect(state.pendingList()).toEqual([]);
  });

  it('刚好 15 分钟边界内（14:59）还留着', () => {
    state.registerAsk({ token: 't1', chatId: 'oc_a', question: 'q' });
    vi.setSystemTime(T0.getTime() + 15 * MIN - SEC);
    state.sweep();
    expect(state.getAsk('t1')).toBeDefined();
  });

  it('清理只删过期的，不动新鲜的', () => {
    state.registerAsk({ token: 'old', chatId: 'oc_a', question: 'q' });
    vi.setSystemTime(T0.getTime() + 10 * MIN);
    state.registerAsk({ token: 'fresh', chatId: 'oc_a', question: 'q2' });
    vi.setSystemTime(T0.getTime() + 16 * MIN);
    state.sweep();
    expect(state.getAsk('old')).toBeUndefined();
    expect(state.getAsk('fresh')).toBeDefined();
  });

  it('registerAsk 会自动触发一次 sweep', () => {
    state.registerAsk({ token: 'old', chatId: 'oc_a', question: 'q' });
    vi.setSystemTime(T0.getTime() + 20 * MIN);
    state.registerAsk({ token: 'new', chatId: 'oc_a', question: 'q2' });
    expect(state.getAsk('old')).toBeUndefined();
    expect(state.getAsk('new')).toBeDefined();
  });
});

describe('stats', () => {
  it('统计运行时长、事件数、待答数与缓存消息数', () => {
    state.registerAsk({ token: 't1', chatId: 'oc_a', question: 'q' });
    state.registerAsk({ token: 't2', chatId: 'oc_a', question: 'q2' });
    state.resolveAsk('t1', { text: 'x', via: 'button' });
    // 特意推到另一个会话，避免这条消息把还在等的 t2 自动答掉
    state.pushMessage(msg({ chatId: 'oc_other' }));

    vi.setSystemTime(T0.getTime() + 3 * SEC);
    const s = state.stats();
    expect(s.uptimeMs).toBe(3 * SEC);
    expect(s.pendingAsks).toBe(1); // t2 还在等，t1 已答
    expect(s.cachedMessages).toBe(1);
    expect(s.events).toBe(4); // 2 次注册 + 1 次作答 + 1 条消息
  });

  it('全新实例：0 待答、0 消息', () => {
    const s = state.stats();
    expect(s.pendingAsks).toBe(0);
    expect(s.cachedMessages).toBe(0);
    expect(s.events).toBe(0);
    expect(s.uptimeMs).toBe(0);
  });
});
