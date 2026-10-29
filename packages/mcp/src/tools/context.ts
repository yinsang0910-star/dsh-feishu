/**
 * 会话上下文工具：解决 MCP 生态几乎没人做的两件事。
 *
 *  1. feishu_recent —— 「我刚才在跟谁说话、之前聊到哪了」。
 *     模型是无状态的，每次被叫醒都不知道上文；这里用一次 listMessages 把最近
 *     几条消息拍平成模型能直接读的文本。
 *
 *  2. feishu_ask —— 「发问之后停下来等人回答」。
 *     标准 MCP 是请求-响应模型，工具调用必须立刻返回，所以"等"只能靠轮询：
 *     发一张带选项的卡片，然后在一个有时间上限的循环里反复拉新消息。
 *     注意卡片按钮的回调需要长连接（本项目没有），所以按钮只是给人看的快捷提示，
 *     真正的答案一律来自轮询到的**文本消息**。
 *
 * 约定（见 docs/TOOL-CONTRACT.md）：stdout 是 JSON-RPC 通道，绝不能往 stdout 写日志；
 * 日志一律走 ctx.log（写 stderr）。
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { askCard, FeishuApiError } from '@dsh-feishu/core';
import type { FeishuMessage, FeishuUser } from '@dsh-feishu/core';
import { ok, fail, type ToolContext } from './types.js';
import {
  gatewayHealth,
  gatewayWatch,
  gatewayAnswer,
  gatewayForget,
} from '../gateway-client.js';

// ─────────────────────────── 小工具 ───────────────────────────

/** 参数钳制：模型经常给越界值，钳比报错友好 */
function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** 飞书 create_time 是毫秒时间戳字符串；解析不出来返回 0 */
function toMs(createTime: string): number {
  const n = Number(createTime);
  if (Number.isFinite(n) && n > 0) return n;
  const parsed = Date.parse(createTime);
  return Number.isFinite(parsed) ? parsed : 0;
}

function hhmm(ms: number): string {
  if (!ms) return '--:--';
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 一行一条消息才好读；富文本/多行内容压成单行 */
function oneLine(text: string): string {
  return text.replace(/\s*\r?\n\s*/g, ' / ').replace(/\s{2,}/g, ' ').trim();
}

/** 文本里的 @_user_1 是占位符，换成真名对模型更有用 */
function withMentions(
  text: string,
  mentions?: Array<{ key: string; name?: string; openId?: string }>,
): string {
  if (!mentions?.length) return text;
  let out = text;
  for (const m of mentions) {
    if (!m.key) continue;
    out = out.split(m.key).join(`@${m.name || '某人'}`);
  }
  return out;
}

/** 富文本 content 可能是 {title,content:[[...]]}，也可能按语言包了一层 */
function flattenPost(content: unknown): string {
  let root = asRecord(content);
  if (!Array.isArray(root['content']) && typeof root['title'] !== 'string') {
    for (const key of ['zh_cn', 'en_us', 'ja_jp']) {
      const nested = asRecord(root[key]);
      if (Object.keys(nested).length) {
        root = nested;
        break;
      }
    }
  }
  const out: string[] = [];
  const title = root['title'];
  if (typeof title === 'string' && title) out.push(title);
  const blocks = root['content'];
  if (Array.isArray(blocks)) {
    for (const block of blocks) {
      if (!Array.isArray(block)) continue;
      const parts: string[] = [];
      for (const el of block) {
        const e = asRecord(el);
        const t = e['text'];
        if (typeof t === 'string') parts.push(t);
        else if (e['tag'] === 'img') parts.push('[图片]');
        else if (e['tag'] === 'media') parts.push('[视频]');
        else if (e['tag'] === 'emotion') parts.push('[表情]');
      }
      if (parts.length) out.push(parts.join(''));
    }
  }
  return out.join('\n');
}

/** 把任意 msg_type 的消息压成一句人能看的话 */
function textOf(msgType: string, content: unknown, rawContent: string): string {
  const c = asRecord(content);
  switch (msgType) {
    case 'text': {
      const t = c['text'];
      if (typeof t === 'string') return t;
      return rawContent || '[文本]';
    }
    case 'file': {
      const name = c['file_name'];
      return `[文件] ${typeof name === 'string' && name ? name : '(未命名)'}`;
    }
    case 'image':
      return '[图片]';
    case 'audio':
      return `[语音]${c['duration'] ? ` ${String(c['duration'])}ms` : ''}`;
    case 'media': {
      const name = c['file_name'];
      return `[视频]${typeof name === 'string' && name ? ` ${name}` : ''}`;
    }
    case 'sticker':
      return '[表情]';
    case 'post': {
      const flat = flattenPost(content);
      return flat || '[富文本]';
    }
    case 'interactive':
      return '[卡片]';
    case 'share_chat':
      return '[群名片]';
    case 'share_user':
      return '[个人名片]';
    case 'merge_forward':
      return '[合并转发]';
    case 'location':
      return '[位置]';
    case 'todo':
      return '[任务]';
    case 'vote':
      return '[投票]';
    case 'hongbao':
      return '[红包]';
    case 'system': {
      const t = c['text'];
      return typeof t === 'string' ? `[系统] ${t}` : '[系统消息]';
    }
    default: {
      const fallback = rawContent || '';
      return fallback ? `[${msgType || '未知'}] ${fallback.slice(0, 120)}` : `[${msgType || '未知'}]`;
    }
  }
}

/** 统一错误文案：权限错误要给出可直接去开放平台开的 scope */
function describeError(err: unknown): string {
  if (err instanceof FeishuApiError) {
    if (err.isPermission) {
      const scopes = err.missingScopes;
      const hint = scopes.length
        ? scopes.join(', ')
        : 'im:message.group_msg（群聊读消息）/ im:message.p2p_msg:readonly（单聊读消息）';
      return `权限不足：${err.message}\n需要在开放平台「权限管理」开通并重新发布版本：${hint}`;
    }
    return `飞书接口失败：${err.message}`;
  }
  return `失败：${err instanceof Error ? err.message : String(err)}`;
}

function resolveChatId(ctx: ToolContext, chatId?: string, toolName = '本工具'): string | null {
  const resolved = chatId?.trim() || ctx.config.defaultChatId?.trim() || '';
  if (!resolved) {
    ctx.log(`${toolName}: 没有 chat_id，也没有配置默认会话`);
    return null;
  }
  return resolved;
}

// ─────────────────────────── 轮询用的候选消息 ───────────────────────────

interface ReplyCandidate {
  messageId: string;
  createTimeSec: number;
  senderId: string;
  senderType: string;
  msgType: string;
  text: string;
  parentId?: string;
  threadId?: string;
}

function toCandidate(m: FeishuMessage): ReplyCandidate {
  return {
    messageId: m.messageId,
    createTimeSec: Math.floor(toMs(m.createTime) / 1000),
    senderId: m.senderId ?? '',
    senderType: m.senderType ?? '',
    msgType: m.msgType,
    text: oneLine(withMentions(textOf(m.msgType, m.content, m.rawContent), m.mentions)),
    parentId: m.parentId,
    threadId: m.threadId,
  };
}

/** 话题容器里返回的是原始 JSON（core 没暴露 thread 版 listMessages），这里自己拍平 */
function candidateFromRaw(raw: Record<string, unknown>): ReplyCandidate {
  const body = asRecord(raw['body']);
  const sender = asRecord(raw['sender']);
  const senderIdObj = asRecord(sender['sender_id']);
  const msgType = String(raw['msg_type'] ?? '');
  const rawContent = typeof body['content'] === 'string' ? body['content'] : '';
  let content: unknown;
  try {
    content = rawContent ? JSON.parse(rawContent) : undefined;
  } catch {
    content = undefined;
  }
  return {
    messageId: String(raw['message_id'] ?? ''),
    createTimeSec: Math.floor(toMs(String(raw['create_time'] ?? '')) / 1000),
    senderId: senderIdObj['open_id'] ? String(senderIdObj['open_id']) : '',
    senderType: sender['sender_type'] ? String(sender['sender_type']) : '',
    msgType,
    text: oneLine(textOf(msgType, content, rawContent)),
    parentId: raw['parent_id'] ? String(raw['parent_id']) : undefined,
    threadId: raw['thread_id'] ? String(raw['thread_id']) : undefined,
  };
}

/**
 * 是否算「这次提问的回复」。
 *
 * 用 >= baselineSec 而不是严格 >：卡片和回复可能落在同一秒（秒级时间戳），
 * 严格大于会漏掉手快的人；卡片自己由 message_id 排除，机器人自己发的由 sender 排除，
 * 所以放宽一秒不会误判。
 */
function isFreshReply(
  c: ReplyCandidate,
  baselineSec: number,
  excludeIds: Set<string>,
  botOpenId: string,
): boolean {
  if (!c.messageId) return false;
  if (excludeIds.has(c.messageId)) return false;
  if (c.createTimeSec < baselineSec) return false;
  if (botOpenId && c.senderId === botOpenId) return false;
  // 拿不到机器人 open_id 时退一步：应用身份发的一律不算人回答
  if (!botOpenId && c.senderType === 'app') return false;
  return true;
}

/** 多条新消息时取最早的一条，那才是第一句回答 */
function pickEarliest(list: ReplyCandidate[]): ReplyCandidate | null {
  let best: ReplyCandidate | null = null;
  for (const c of list) {
    if (!best || c.createTimeSec < best.createTimeSec) best = c;
  }
  return best;
}

/** 话题容器（话题群/把卡片回在话题里）里的消息，chat 容器查不到，单独补一次 */
async function listThreadCandidates(
  ctx: ToolContext,
  threadId: string,
  pageSize: number,
): Promise<ReplyCandidate[]> {
  try {
    const data = await ctx.client.request<{ items?: Array<Record<string, unknown>> }>(
      'GET',
      '/im/v1/messages',
      {
        query: {
          container_id_type: 'thread',
          container_id: threadId,
          page_size: pageSize,
          sort_type: 'ByCreateTimeDesc',
        },
      },
    );
    return (data.items ?? []).map((raw) => candidateFromRaw(raw));
  } catch (err) {
    // 权限问题必须往上抛（否则会静默变成"没人回复"）；其它错误当作这个话题读不到
    if (err instanceof FeishuApiError && err.isPermission) throw err;
    ctx.log(`读话题 ${threadId} 失败，忽略`, err);
    return [];
  }
}

// ─────────────────────────── 注册 ───────────────────────────

export function registerContextTools(server: McpServer, ctx: ToolContext): void {
  // ── 1. 会话最近消息 ──────────────────────────────────────
  server.registerTool(
    'feishu_recent',
    {
      title: '读会话最近的聊天（模型的上文）',
      description:
        '拉取某个飞书会话最近的消息，按时间正序（早→晚）拍平成文本，让模型知道「刚才聊了什么、谁在说」。' +
        '典型用法：被叫醒后、要回复之前、要接着上文改文件之前，先调一次这个再动手；' +
        '也用来确认某个人刚才发的那句话的 message_id，好配合 feishu_reply / feishu_download 用。' +
        '默认会过滤掉机器人自己发的消息（对模型是噪音），需要看自己说过什么时传 include_bot=true。' +
        'format=compact 只有「时间 发送人：内容」，适合快速读；format=full 额外带 message_id / msg_type / sender_id，' +
        '适合接下来要针对某条消息做操作。' +
        '要「发问并等人回答」不要用这个（轮询要自己写），用 feishu_ask。',
      inputSchema: {
        chat_id: z
          .string()
          .optional()
          .describe('会话 id（oc_ 开头）。不填用默认会话（FEISHU_DEFAULT_CHAT_ID）。'),
        limit: z
          .number()
          .int()
          .optional()
          .describe('取多少条，默认 15，最大 50（超了按 50 算）。'),
        since_minutes: z
          .number()
          .int()
          .optional()
          .describe('只要最近 N 分钟内的消息；不填表示不限时间。'),
        include_bot: z
          .boolean()
          .optional()
          .describe('是否保留机器人自己发的消息。默认 false（过滤掉，因为对模型是噪音）。'),
        format: z
          .enum(['compact', 'full'])
          .optional()
          .describe('compact=「[14:23] 张三：内容」（默认）；full=再带 message_id/msg_type/sender_id。'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ chat_id, limit, since_minutes, include_bot, format }) => {
      try {
        const chatId = resolveChatId(ctx, chat_id, 'feishu_recent');
        if (!chatId) {
          return fail(
            '没有指定 chat_id，也没有配置默认会话。请显式传 chat_id（oc_ 开头），' +
              '或先调 feishu_whoami 看看可用的群。',
          );
        }

        const size = clampInt(limit, 15, 1, 50);
        const sinceMin =
          typeof since_minutes === 'number' && Number.isFinite(since_minutes) && since_minutes > 0
            ? Math.trunc(since_minutes)
            : undefined;
        const cutoffMs = sinceMin ? Date.now() - sinceMin * 60_000 : undefined;
        const startTimeSec = cutoffMs ? Math.floor(cutoffMs / 1000) : undefined;
        const wantBot = include_bot === true;
        const full = format === 'full';

        // desc 拿到的是"最近优先"（倒序），下面再反转成时间正序
        const page = await ctx.client.listMessages(chatId, {
          pageSize: size,
          sort: 'desc',
          ...(startTimeSec !== undefined ? { startTimeSec } : {}),
        });

        // 发送人名字映射 + 机器人自己的 open_id；任一失败都不该拖垮主流程
        const [members, bot] = await Promise.all([
          ctx.client.listMembers(chatId).catch((err: unknown): FeishuUser[] => {
            ctx.log('listMembers 失败，发送人一律显示 unknown', err);
            return [];
          }),
          ctx.client.botInfo().catch((err: unknown) => {
            ctx.log('botInfo 失败，跳过机器人过滤', err);
            return null;
          }),
        ]);

        const nameByOpenId = new Map<string, string>();
        for (const m of members) {
          if (m.openId) nameByOpenId.set(m.openId, m.name || 'unknown');
        }
        const botOpenId = bot?.openId ?? '';
        // 机器人自己不在成员列表里，include_bot=true 时别显示成 unknown
        if (botOpenId) nameByOpenId.set(botOpenId, `${bot?.name || '机器人'}(我)`);

        let items = page.items.filter((m) => !m.deleted);
        if (!wantBot && botOpenId) items = items.filter((m) => m.senderId !== botOpenId);
        if (cutoffMs !== undefined) items = items.filter((m) => toMs(m.createTime) >= cutoffMs);
        items = [...items].reverse();

        if (!items.length) {
          const why: string[] = [];
          if (!wantBot) why.push('已过滤机器人自己发的');
          if (sinceMin) why.push(`只取最近 ${sinceMin} 分钟`);
          if (sinceMin || !wantBot) why.push('可以放宽 limit / since_minutes 或传 include_bot=true');
          return ok(`${chatId} 没有符合条件的消息（${why.join('；')}）。`, {
            chat_id: chatId,
            count: 0,
            messages: [],
          });
        }

        const rows: Array<{
          message_id: string;
          sender: string;
          time: string;
          text: string;
          msg_type: string;
        }> = [];
        const lines: string[] = [];

        for (const m of items) {
          const text = oneLine(withMentions(textOf(m.msgType, m.content, m.rawContent), m.mentions));
          const sender = m.senderId ? (nameByOpenId.get(m.senderId) ?? 'unknown') : 'unknown';
          const time = hhmm(toMs(m.createTime));
          rows.push({
            message_id: m.messageId,
            sender,
            time,
            text,
            msg_type: m.msgType,
          });
          lines.push(
            full
              ? `[${time}] ${sender}：${text}  ·  message_id=${m.messageId} msg_type=${m.msgType} sender_id=${m.senderId ?? 'unknown'}`
              : `[${time}] ${sender}：${text}`,
          );
        }

        const header = `${chatId} ${sinceMin ? `最近 ${sinceMin} 分钟内` : '最近'} ${
          rows.length
        } 条消息（时间正序，早→晚）${wantBot ? '（含机器人自己发的）' : '（已过滤机器人自己发的）'}`;

        return ok([header, ...lines].join('\n'), {
          chat_id: chatId,
          count: rows.length,
          messages: rows,
        });
      } catch (err) {
        return fail(describeError(err));
      }
    },
  );

  // ── 2. 提问并等待回答 ────────────────────────────────────
  server.registerTool(
    'feishu_ask',
    {
      title: '发问并等人回答（会阻塞）',
      description:
        '在飞书里发一张带选项的卡片问一个问题，然后等人回答，把答案拿回来。' +
        '用在真的缺关键信息、又没法自己查的时候：要用户拍板方案、要一个他没写在文档里的参数、' +
        '要确认某个动作要不要执行。' +
        '⚠️ 这个调用会阻塞（默认 120 秒，最多 600 秒），期间什么都做不了，所以**不要滥用，一次任务最多问一两个问题**；' +
        '能靠 feishu_recent 从上下文里读出来的、能自己查到的、能用合理默认值继续的，都不要问。' +
        '回答来源有两条：①点卡片上的选项按钮（需要网关在跑，毫秒级返回）；②对方直接打字回一句。' +
        '两条都走不通才会超时。返回 answered=true 时 text 就是对方的原话；answered=false 表示超时（不是报错），' +
        '此时应当按默认方案继续或换个问法，不要反复重试。',
      inputSchema: {
        question: z.string().describe('要问的一句话问题。写清「需要他决定什么」，别问开放式的为什么。'),
        options: z
          .array(z.string())
          .optional()
          .describe(
            '建议选项（最多 5 个，多余的截断），会渲染成按钮。' +
              '网关在跑时点按钮就是答案；网关不在时按钮只是提示，对方要打字回。',
          ),
        chat_id: z
          .string()
          .optional()
          .describe('发到哪个会话（oc_ 开头）。不填用默认会话。'),
        timeout_seconds: z
          .number()
          .int()
          .optional()
          .describe('最多等多少秒，默认 120，最小 10，最大 600。'),
        poll_interval_seconds: z
          .number()
          .int()
          .optional()
          .describe('轮询间隔秒数，默认 3，最小 1。间隔太小会白烧接口配额。'),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ question, options, chat_id, timeout_seconds, poll_interval_seconds }) => {
      const startedAt = Date.now();
      try {
        const chatId = resolveChatId(ctx, chat_id, 'feishu_ask');
        if (!chatId) {
          return fail(
            '没有指定 chat_id，也没有配置默认会话。feishu_ask 需要一个既能发卡片又能读消息的会话。',
          );
        }

        const timeoutSec = clampInt(timeout_seconds, 120, 10, 600);
        const pollMs = clampInt(poll_interval_seconds, 3, 1, 30) * 1000;

        const token = randomUUID().slice(0, 8);
        const cleanOptions = (options ?? [])
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
          .slice(0, 5);

        // 机器人自己的 open_id：用来把「自己发的卡片」排除在回答之外
        const bot = await ctx.client.botInfo().catch((err: unknown) => {
          ctx.log('botInfo 失败，改用 sender_type=app 兜底过滤', err);
          return null;
        });
        const botOpenId = bot?.openId ?? '';

        // 基线时间要在发卡片之前取：之后创建的消息才算回答
        const baselineSec = Math.floor(Date.now() / 1000);

        const card = askCard({
          question,
          ...(cleanOptions.length ? { options: cleanOptions } : {}),
          token,
        });
        const sent = await ctx.client.sendCard(chatId, card);
        const targetChatId = sent.chatId || chatId;
        const excludeIds = new Set<string>([sent.messageId]);

        // 网关在跑就让按钮真的能用：登记 token，按钮点下来毫秒级拿到答案
        let gwAlive = (await gatewayHealth()) !== null;
        if (gwAlive) {
          const watched = await gatewayWatch({
            token,
            chatId: targetChatId,
            question,
            baselineSec,
          });
          if (!watched) {
            // 探活能过但 watch 被拒 —— 多半是网关配了密钥而这边没带对。
            // 不能装没事，否则用户点按钮会石沉大海。
            gwAlive = false;
            ctx.log(
              `feishu_ask token=${token} 网关 watch 被拒绝（密钥不匹配？），降级为纯轮询`,
            );
          }
        }
        ctx.log(
          `feishu_ask token=${token} 已发卡片 ${sent.messageId}，` +
            `${gwAlive ? '网关在线（按钮可用）' : '网关未运行（只能靠打字回复）'}，` +
            `开始等待（上限 ${timeoutSec}s / 每 ${pollMs}ms）`,
        );

        const deadline = startedAt + timeoutSec * 1000;
        let threadId: string | null = null;
        let threadProbe = 0;

        const finish = async (): Promise<void> => {
          if (gwAlive) await gatewayForget(token);
        };

        for (;;) {
          // ⓪ 网关优先：按钮点了就在内存里，不用碰飞书消息 API
          if (gwAlive) {
            const ans = await gatewayAnswer(token);
            if (ans?.answered && ans.text !== undefined) {
              const waitedMs = Date.now() - startedAt;
              ctx.log(`feishu_ask token=${token} 网关投递回答（${ans.via}，${waitedMs}ms）`);
              await finish();
              return ok(`用户回答：${ans.text}`, {
                answered: true,
                text: ans.text,
                via: ans.via ?? 'button',
                chat_id: targetChatId,
                token,
                waited_ms: waitedMs,
                sender_id: ans.by ?? null,
                ask_message_id: sent.messageId,
              });
            }
          }

          const found: ReplyCandidate[] = [];

          // ① 会话主容器：绝大多数回复都在这里（包括「直接回在某个话题里」的父消息）
          const page = await ctx.client.listMessages(targetChatId, {
            pageSize: 10,
            sort: 'desc',
          });
          for (const m of page.items) {
            const c = toCandidate(m);
            if (isFreshReply(c, baselineSec, excludeIds, botOpenId)) found.push(c);
          }

          // ② 话题容器：卡片被回在话题里时，chat 容器查不到它，只能按 thread 查。
          //    话题群的 message.thread_id 往往要等第一条回复之后才出现，所以前几轮探一下。
          if (!threadId && threadProbe < 3) {
            threadProbe += 1;
            const self = await ctx.client.getMessage(sent.messageId).catch(() => null);
            if (self?.threadId) threadId = self.threadId;
          }
          if (threadId) {
            const threadItems = await listThreadCandidates(ctx, threadId, 10);
            for (const c of threadItems) {
              if (isFreshReply(c, baselineSec, excludeIds, botOpenId)) found.push(c);
            }
          }

          const reply = pickEarliest(found);
          if (reply) {
            const waitedMs = Date.now() - startedAt;
            ctx.log(`feishu_ask token=${token} 等到回答 ${reply.messageId}（${waitedMs}ms）`);
            await finish();
            return ok(`用户回答：${reply.text}`, {
              answered: true,
              text: reply.text,
              via: 'message',
              message_id: reply.messageId,
              chat_id: targetChatId,
              token,
              waited_ms: waitedMs,
              msg_type: reply.msgType,
              sender_id: reply.senderId || null,
              // 这一条是「回在话题里」还是主时间线，调用方可能想知道
              in_thread: Boolean(reply.parentId || reply.threadId),
              ask_message_id: sent.messageId,
            });
          }

          const remain = deadline - Date.now();
          if (remain <= 0) break;
          await sleep(Math.min(pollMs, remain));
        }

        await finish();
        // 超时：用 fail 让调用方停下重试，但文案写清「这不是炸了，是没人回答」
        const waitedMs = Date.now() - startedAt;
        return fail(
          `等待超时（${timeoutSec}s 内没人回复）。` +
            `这不是错误：卡片已经发出去了（message_id=${sent.messageId}），只是没人回答。` +
            `请按默认方案继续，或换个更具体的问题再问一次；不要连续重试同一个问题。`,
          {
            answered: false,
            waited_ms: waitedMs,
            chat_id: targetChatId,
            token,
            ask_message_id: sent.messageId,
            gateway: gwAlive,
          },
        );
      } catch (err) {
        return fail(describeError(err));
      }
    },
  );
}
