/**
 * 会话键与会话 ID 的派生规则。
 *
 * 这里解决的问题：现在 bot.py 用 sess_key(open_id, cwd) 记人，人一变记忆就断了。
 * 改成「对话线」为准 —— 一条话题 / 一条回复串 / 一个群，各自是稳定的会话。
 *
 * 三级回落（照 OpenClaw 的 groupSessionScope 与 Claude Tag 的 thread 模型）：
 *   1. 话题内          lark:{tenant}:{chat}:thread:{omt_xxx}
 *   2. 群内回复串      lark:{tenant}:{chat}:msg:{om_xxx}   ← reply root 的 om_
 *   3. 整个群一条线    lark:{tenant}:{chat}
 *
 * 飞书 ID 前缀（官方文档）：话题 thread_id 为 omt_ 开头，消息 message_id 为 om_ 开头。
 * 发起话题的那条消息事件可能不带 thread_id，要回查一次，否则首轮与后续会掉进
 * 两个不同的 session。
 */

import { createHash } from 'node:crypto';

const THREAD_PREFIX = 'omt_';

/**
 * 从一条飞书消息事件里解析会话键。
 *
 * @param {object} evt
 * @param {string} [evt.tenantKey] 飞书租户键，缺省用 'default'
 * @param {string} evt.chatId      会话（群/单聊）ID，oc_ 开头
 * @param {string} [evt.threadId]  话题 ID，omt_ 开头
 * @param {string} [evt.rootId]    回复串的根消息 ID，om_ 开头
 * @param {string} [evt.scope]     强制范围：'group' | 'topic' | 'root'
 * @returns {string} 稳定的会话键
 */
export function sessionKey(evt) {
  const tenant = evt.tenantKey || 'default';
  const base = `lark:${tenant}:${evt.chatId}`;
  const scope = evt.scope || 'auto';

  if (scope === 'group') return base;

  const threadId = normThread(evt.threadId);
  if (threadId && scope !== 'root') return `${base}:thread:${threadId}`;

  const rootId = normMsg(evt.rootId);
  if (rootId && scope !== 'topic') return `${base}:msg:${rootId}`;

  return base;
}

function normThread(v) {
  if (typeof v !== 'string') return '';
  const s = v.trim();
  // 有的接口给 'omt_xxx'，有的给裸 id；统一成带前缀形态
  if (!s) return '';
  return s.startsWith(THREAD_PREFIX) ? s : `${THREAD_PREFIX}${s}`;
}

function normMsg(v) {
  if (typeof v !== 'string') return '';
  return v.trim();
}

/**
 * 会话键 → DSH 的 SessionId。
 *
 * SessionId 在 dsh-session 里是 `Branded<'SessionId'>`，运行时就是一个字符串，
 * 没有格式校验。所以这里做确定性派生：同一个会话键永远得到同一个 SessionId，
 * 进程重启后 `agents.resume({ resumeSessionId })` 就能把会话接回来，
 * 不需要额外的「键 → 会话」绑定表。
 *
 * 前缀保留可读性，方便在 web GUI 的会话列表里一眼看出是哪条飞书线。
 *
 * @param {string} key
 * @returns {string}
 */
export function sessionIdFor(key) {
  const h = createHash('sha256').update(key).digest('hex').slice(0, 24);
  return `feishu-${h}`;
}

/**
 * 老 bot.py 的 sess_key(open_id, cwd) 兼容层：用于一次性迁移旧会话映射。
 * 新代码不该再用它。
 */
export function legacySessionKey(openId, cwd) {
  return `${openId}|${cwd}`;
}
