/**
 * 自检：不依赖 DSH 运行时，只验证纯逻辑。
 * 跑法：node test/selfcheck.mjs
 *
 * 验证目标（都是方案里最容易写错的地方）：
 *   1. 会话键三级回落
 *   2. sessionId 确定性派生
 *   3. outbox 幂等：同一 msgId 第二次必须返回 false
 *   4. 落盘后能被重新读出来（崩溃恢复的前提）
 *   5. 卡片视图：排队数是真值、没有百分比 ETA
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sessionKey, sessionIdFor } from '../lib/sessionkey.js';
import { Outbox, SessionState } from '../lib/store.js';
import { renderView } from '../lib/card.js';

let pass = 0;
let fail = 0;

function check(label, cond, extra) {
  if (cond) {
    pass += 1;
    console.log(`  ok   ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ''}`);
  }
}

function eq(label, actual, expected) {
  check(label, actual === expected, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

console.log('\n[1] 会话键三级回落');
eq('群默认', sessionKey({ chatId: 'oc_1' }), 'lark:default:oc_1');
eq('话题优先', sessionKey({ chatId: 'oc_1', threadId: 'omt_abc' }), 'lark:default:oc_1:thread:omt_abc');
eq('话题裸 id 补前缀', sessionKey({ chatId: 'oc_1', threadId: 'abc' }), 'lark:default:oc_1:thread:omt_abc');
eq('无话题时用 reply root', sessionKey({ chatId: 'oc_1', rootId: 'om_root' }), 'lark:default:oc_1:msg:om_root');
eq('话题优先于 root', sessionKey({ chatId: 'oc_1', threadId: 'omt_a', rootId: 'om_r' }), 'lark:default:oc_1:thread:omt_a');
eq('强制 group 忽略 thread', sessionKey({ chatId: 'oc_1', threadId: 'omt_a', scope: 'group' }), 'lark:default:oc_1');
eq('租户参与', sessionKey({ tenantKey: 't2', chatId: 'oc_1' }), 'lark:t2:oc_1');

console.log('\n[2] sessionId 确定性');
const a = sessionIdFor('lark:default:oc_1');
const b = sessionIdFor('lark:default:oc_1');
const c = sessionIdFor('lark:default:oc_2');
check('同键同 id', a === b, `${a} vs ${b}`);
check('异键异 id', a !== c, `${a} vs ${c}`);
check('形如 feishu-<hex>', /^feishu-[0-9a-f]{24}$/.test(a), a);

console.log('\n[3] outbox 幂等 + 落盘');
const dir = mkdtempSync(join(tmpdir(), 'feishu-ch-'));
try {
  const k = Outbox.keyOf('oc_1', 'om_msg1');
  const box = new Outbox(dir);
  check('首次 claim 为真', box.claim(k, { key: 'lark:default:oc_1', msgId: 'om_msg1' }) === true);
  check('未交付前重投为真（允许重试）', box.claim(k, { key: 'lark:default:oc_1' }) === true);
  box.mark(k, 'delivered', { intent: 'followup' });
  check('已交付后重投为假（幂等生效）', box.claim(k, { key: 'lark:default:oc_1' }) === false);

  const k2 = Outbox.keyOf('oc_1', 'om_msg2');
  box.claim(k2, { key: 'lark:default:oc_1', msgId: 'om_msg2' });
  check('pending 抓出未确认的行', box.pending().length === 1 && box.pending()[0].key === k2);

  // 模拟进程重启：新实例从同一目录读回
  const box2 = new Outbox(dir);
  check('重启后已交付的仍是 delivered', box2.get(k)?.state === 'delivered', JSON.stringify(box2.get(k)));
  check('重启后 pending 仍存在', box2.pending().length === 1);
  check('重启后重复投递仍被拦', box2.claim(k, {}) === false);

  console.log('\n[4] SessionState');
  const ss = new SessionState(dir);
  ss.patch('lark:default:oc_1', { cardMsgId: 'om_card' });
  const ss2 = new SessionState(dir);
  check('持久化读回', ss2.get('lark:default:oc_1')?.cardMsgId === 'om_card');

  console.log('\n[5] 卡片视图');
  const view = {
    key: 'lark:default:oc_1',
    sessionId: a,
    cwd: '/home/agent/work/proj',
    status: 'running',
    turn: 3,
    queuedAhead: 2,
    queue: [
      { id: 'm1', target: 'next-turn', author: 'ou_aaaaaa', name: '喵喵', text: '把这个函数改成异步' },
      { id: 'm2', target: 'next-step', author: 'ou_bbbbbb', name: 'G2', text: '别动 config 目录' },
    ],
    streaming: '正在读取 src/index.ts…',
    error: null,
    updatedAt: 1767000000000,
  };
  const out = renderView(view);
  const dump = JSON.stringify(out.card);
  check('卡片可多次更新', out.card.config.update_multi === true);
  check('标题带排队数', dump.includes('排队 2'), dump.slice(0, 200));
  check('不出现百分比/ETA', !/%|预计|ETA|剩余/.test(dump));
  check('插话被标注', dump.includes('插话·下一步生效'));
  check('运行中有「停」按钮', dump.includes('"act":"stop"'));
  check('排队时有撤回按钮', dump.includes('"act":"recall"'));
  check('回退纯文本不为空', typeof out.text === 'string' && out.text.includes('喵喵'));

  // 这两条是 bot.py 的前提：它靠 key 找卡片，靠 chatId 决定发到哪个会话。
  check('视图带回 key', out.key === 'lark:default:oc_1', String(out.key));
  check('视图带回 rev', typeof out.rev === 'number');

  const idle = renderView({ ...view, status: 'idle', queue: [], queuedAhead: 0, streaming: '' });
  check('空闲时无「停」按钮', !JSON.stringify(idle.card).includes('"act":"stop"'));

  console.log('\n[6] 会话键与排队默认值');
  const sk1 = sessionKey({ chatId: 'oc_1', tenantKey: 't1', threadId: 'omt_abc' });
  check('话题优先', sk1 === 'lark:t1:oc_1:thread:omt_abc', sk1);
  const sk2 = sessionKey({ chatId: 'oc_1', tenantKey: 't1', rootId: 'om_root' });
  check('回复串回落', sk2 === 'lark:t1:oc_1:msg:om_root', sk2);
  const sk3 = sessionKey({ chatId: 'oc_1', tenantKey: 't1' });
  check('群默认', sk3 === 'lark:t1:oc_1', sk3);
  const sk4 = sessionKey({ chatId: 'oc_1', threadId: 'abc' });
  check('不带前缀的 thread 自动补 omt_', sk4 === 'lark:default:oc_1:thread:omt_abc', sk4);
  check('会话 id 稳定', sessionIdFor(sk3) === sessionIdFor(sk3));
  check('会话 id 带前缀', sessionIdFor(sk3).startsWith('feishu-'));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
