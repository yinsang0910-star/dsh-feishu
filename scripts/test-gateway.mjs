#!/usr/bin/env node
/**
 * 网关核心逻辑单测（不连飞书长连接）。
 *
 * 只起 HTTP 层 + 直接操作 state，验证：
 *   watch → 按钮回调投递 → answer 能查到
 *   token 不同的两个提问不会互相串答案
 *   消息兜底只在"恰好一个待答"时生效
 *   超时/forget 行为
 */

import { createHttpServer } from '../packages/gateway/dist/http.js';
import { GatewayState } from '../packages/gateway/dist/state.js';

const PORT = 18699;
const BASE = `http://127.0.0.1:${PORT}`;
const state = new GatewayState();
const logs = [];
const server = createHttpServer(state, (m, e) => logs.push([m, e]));

await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`✓ ${name}`);
  } else {
    fail++;
    console.log(`✗ ${name}${detail ? ` — ${JSON.stringify(detail)}` : ''}`);
  }
}

const get = async (p) => (await fetch(`${BASE}${p}`)).json();
const post = async (p, body) =>
  (
    await fetch(`${BASE}${p}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  ).json();

// 1. health
const h = await get('/health');
check('health 返回 ok 且有 pendingAsks', h.ok === true && h.pendingAsks === 0, h);

// 2. watch + answer（未作答）
await post('/watch', { token: 'aaa111', chatId: 'oc_x', question: '选哪个？', baselineSec: 100 });
let a = await get('/answer?token=aaa111');
check('watch 后未作答', a.known === true && a.answered === false, a);

// 3. 按钮投递（模拟 card.action.trigger 的核心调用）
state.resolveAsk('aaa111', { text: '选 A', via: 'button', byOpenId: 'ou_user' });
a = await get('/answer?token=aaa111');
check('按钮投递后能查到答案', a.answered === true && a.text === '选 A' && a.via === 'button', a);

// 4. 并发两个 ask 不串答案
await post('/watch', { token: 'bbb222', chatId: 'oc_x', question: '问题二', baselineSec: 200 });
await post('/watch', { token: 'ccc333', chatId: 'oc_x', question: '问题三', baselineSec: 200 });
state.resolveAsk('ccc333', { text: '给 ccc 的答案', via: 'button' });
const b = await get('/answer?token=bbb222');
const c = await get('/answer?token=ccc333');
check('并发时 bbb 没被 ccc 的答案污染', b.answered === false, b);
check('并发时 ccc 拿到自己的答案', c.answered === true && c.text === '给 ccc 的答案', c);

// 5. 消息兜底：只剩一个待答时，新消息自动认领
await post('/watch', { token: 'ddd444', chatId: 'oc_y', question: '单问', baselineSec: 300 });
state.pushMessage({
  messageId: 'om_1',
  chatId: 'oc_y',
  msgType: 'text',
  createTime: 301,
  senderOpenId: 'ou_human',
  text: '我选 B',
});
const d = await get('/answer?token=ddd444');
check('消息兜底自动认领', d.answered === true && d.text === '我选 B' && d.via === 'message', d);

// 6. 多个待答时消息不自动认领（避免张冠李戴）
await post('/watch', { token: 'eee555', chatId: 'oc_z', question: 'q1', baselineSec: 400 });
await post('/watch', { token: 'fff666', chatId: 'oc_z', question: 'q2', baselineSec: 400 });
state.pushMessage({
  messageId: 'om_2',
  chatId: 'oc_z',
  msgType: 'text',
  createTime: 401,
  senderOpenId: 'ou_human',
  text: '含糊的回答',
});
const e1 = await get('/answer?token=eee555');
const f1 = await get('/answer?token=fff666');
check('两个待答时消息不自动认领', e1.answered === false && f1.answered === false, { e1, f1 });

// 7. 早于 baseline 的消息不算
await post('/watch', { token: 'ggg777', chatId: 'oc_w', question: 'q', baselineSec: 500 });
state.pushMessage({
  messageId: 'om_3',
  chatId: 'oc_w',
  msgType: 'text',
  createTime: 499,
  senderOpenId: 'ou_human',
  text: '旧消息',
});
const g = await get('/answer?token=ggg777');
check('早于 baseline 的消息不算答案', g.answered === false, g);

// 8. forget
await post('/forget', { token: 'ggg777' });
const g2 = await get('/answer?token=ggg777');
check('forget 后查不到', g2.known === false, g2);

// 9. recent
const r = await get('/recent?chat_id=oc_y&limit=10');
check('recent 能返回缓存消息', r.ok === true && r.messages.length === 1, r);

// 10. 404
const nf = await get('/nope');
check('未知端点返回 404 结构', nf.ok === false, nf);

// 注意：Windows 上 server.close() 与活跃 keep-alive 连接会撞 libuv 断言
// （Assertion failed: handle->flags & UV_HANDLE_CLOSING）。先掐断所有连接再关，
// 然后等一拍让 libuv 收干净。
console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (logs.length) console.log('网关日志：', logs.slice(0, 3));
server.closeAllConnections?.();
server.close();
setTimeout(() => process.exit(fail ? 1 : 0), 150);
