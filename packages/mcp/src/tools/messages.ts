/**
 * 消息工具：发文本、发卡片、原地刷卡片、引用回复。
 *
 * 这一组只解决"把东西发到飞书"这件事，不碰文件（见 files.ts）、
 * 不碰会话历史（见 context.ts）、不碰通讯录（见 directory.ts）。
 *
 * 注意：
 *  - stdout 是 MCP 的 JSON-RPC 通道，本文件绝不写 stdout，要日志走 ctx.log；
 *  - 每个 handler 整体 try/catch，异常一律变成 fail(...) 返回，不向上抛。
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { FeishuApiError, type FeishuCard } from '@dsh-feishu/core';
import { ok, fail, type ToolContext } from './types.js';

/** 把任意异常翻译成给模型看的中文提示；权限类错误带上缺失的 scope */
function describeError(err: unknown, action: string): string {
  if (err instanceof FeishuApiError) {
    if (err.isPermission) {
      const scopes = err.missingScopes.join(', ') || '(飞书没在错误里返回具体 scope)';
      return (
        `${action}失败：权限不足，需要在开放平台给应用开通权限：${scopes}\n` +
        `（原始错误：code=${err.code} ${err.message}）`
      );
    }
    return `${action}失败：code=${err.code} ${err.message}`;
  }
  return `${action}失败：${err instanceof Error ? err.message : String(err)}`;
}

/** target 参数在所有发送类工具里长得一样，description 也复用 */
const targetSchema = z
  .string()
  .optional()
  .describe(
    '发送目标：chat_id（oc_ 开头）/ open_id（ou_ 开头）/ 邮箱。不填则发到默认会话（需已配置 FEISHU_DEFAULT_CHAT_ID，否则会报错）。',
  );

/** 最小可用卡片示例，直接进 description，让模型知道卡片长什么样 */
const CARD_EXAMPLE = JSON.stringify(
  {
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: '构建结果' },
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: '**状态**：通过\n**耗时**：42s' } },
      { tag: 'hr' },
      { tag: 'note', elements: [{ tag: 'plain_text', content: '由 dsh-feishu 发送' }] },
    ],
  },
  null,
  2,
);

export function registerMessageTools(server: McpServer, ctx: ToolContext): void {
  // ───────────────────────── 纯文本 ─────────────────────────

  server.registerTool(
    'feishu_send_text',
    {
      title: '发一条纯文本',
      description:
        '往指定会话发一条纯文本消息。适合短结论、一句话提示、快速确认、临时回复。' +
        '不适合：超过约 30 行的长内容、需要排版/表格/多段落层级的内容 —— 那些改用 feishu_send_card（卡片能分块、加分隔线、加备注，可读得多）。' +
        '也不适合需要后续原地刷新的场景：文本发出去就改不了，要更新请用卡片 + feishu_update_card。',
      inputSchema: {
        target: targetSchema,
        text: z.string().describe('消息正文，纯文本。支持换行，但不支持 markdown 渲染（会被原样当字面量显示）。'),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ target, text }) => {
      try {
        if (!text.trim()) {
          return fail('文本为空：text 不能是空白字符串，请给出真正要发的内容。');
        }
        const sent = await ctx.client.sendText(target, text);
        return ok(
          `已发送文本（message_id=${sent.messageId}${sent.chatId ? `，chat_id=${sent.chatId}` : ''}）`,
          { message_id: sent.messageId, chat_id: sent.chatId, msg_type: sent.msgType },
        );
      } catch (err) {
        return fail(describeError(err, '发送文本'));
      }
    },
  );

  // ───────────────────────── 卡片 ─────────────────────────

  server.registerTool(
    'feishu_send_card',
    {
      title: '发一张交互卡片',
      description:
        '发一张飞书交互卡片（JSON 卡片结构，原样提交，不做模板加工）。' +
        '适合：需要排版的内容（分块、分隔线、备注脚注）、要展示多字段状态、以及**之后需要原地刷新**的那类消息。' +
        '不适合：只有一两句话的短提示（用 feishu_send_text 更直接）。' +
        '想让卡片后续可被 feishu_update_card 更新，必须在卡片里写 config.update_multi = true。' +
        `最小可用卡片示例：${CARD_EXAMPLE}`,
      inputSchema: {
        target: targetSchema,
        card: z
          .record(z.string(), z.unknown())
          .describe(
            '完整卡片 JSON 对象（不要字符串化）。至少要 config / header / elements 三段；elements 里每项要有 tag。' +
              '建议带上 "config": { "wide_screen_mode": true, "update_multi": true }，这样以后能原地更新。',
          ),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ target, card }) => {
      try {
        if (!card || typeof card !== 'object' || Array.isArray(card)) {
          return fail('card 必须是卡片 JSON 对象（形如 { config, header, elements }），不能是数组或空值。');
        }
        const sent = await ctx.client.sendCard(target, card as FeishuCard);
        const updatable = (card as { config?: { update_multi?: unknown } }).config?.update_multi === true;
        return ok(
          `已发送卡片（message_id=${sent.messageId}）` +
            (updatable
              ? '，该卡片可被 feishu_update_card 原地更新。'
              : '，但卡片没有 config.update_multi = true，之后无法原地更新 —— 要更新就得重发一张。'),
          {
            message_id: sent.messageId,
            chat_id: sent.chatId,
            msg_type: sent.msgType,
            updatable,
          },
        );
      } catch (err) {
        return fail(describeError(err, '发送卡片'));
      }
    },
  );

  // ───────────────────────── 原地更新卡片 ─────────────────────────

  server.registerTool(
    'feishu_update_card',
    {
      title: '原地更新已发出的卡片',
      description:
        '把已发出的卡片整张替换成新内容，聊天里不新增消息气泡 —— 这是"不刷屏"的关键手段。' +
        '典型用法：先发一张进度卡，之后反复 update 同一个 message_id 推进进度 / 换成结果卡。' +
        '限制：只有发出时带 config.update_multi = true 的卡片才能更新，否则飞书会报错；也不能更新别人发的消息，只能用自己发出的 message_id。' +
        '不适合：想让用户看到历史过程的每一步（每次都会覆盖，只留最新一版）；需要保留每步记录就用 feishu_send_text 逐条追加。',
      inputSchema: {
        message_id: z
          .string()
          .describe('要更新的卡片消息 id（om_ 开头），来自 feishu_send_card 的返回值，必须是本应用发的卡片消息。'),
        card: z
          .record(z.string(), z.unknown())
          .describe(
            '新的完整卡片 JSON（整张替换，不是补丁）。结构同 feishu_send_card；建议保留 config.update_multi = true 以便继续更新。',
          ),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ message_id, card }) => {
      try {
        if (!message_id.trim()) {
          return fail('message_id 为空：请给出 feishu_send_card 返回的卡片消息 id。');
        }
        if (!card || typeof card !== 'object' || Array.isArray(card)) {
          return fail('card 必须是卡片 JSON 对象（整张卡片），不能是数组或空值。');
        }
        await ctx.client.updateCard(message_id, card as FeishuCard);
        return ok(`已原地更新卡片（message_id=${message_id}），没有新增消息。`, {
          message_id,
          updated: true,
        });
      } catch (err) {
        const base = describeError(err, '更新卡片');
        return fail(
          `${base}\n排查顺序：1) 该消息是否是本应用发的卡片（文本/图片消息不能这么改）；` +
            '2) 发卡时卡片里是否有 config.update_multi = true；3) message_id 是否拼错。',
        );
      }
    },
  );

  // ───────────────────────── 引用回复 ─────────────────────────

  server.registerTool(
    'feishu_reply',
    {
      title: '引用回复某条消息',
      description:
        '在会话里对某条消息做引用回复（飞书会把它挂在原消息下面）。' +
        '适合：用户点名提问、需要保留"回的是哪一条"的上下文、在刷屏群里避免歧义。' +
        '不适合：只是想发一条新消息（用 feishu_send_text）；需要排版或要后续刷新（用卡片相关工具，回复接口只发纯文本）。',
      inputSchema: {
        message_id: z
          .string()
          .describe('被回复的那条消息 id（om_ 开头）。注意这是"原消息"，不是回复本身。'),
        text: z.string().describe('回复正文，纯文本。'),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ message_id, text }) => {
      try {
        if (!message_id.trim()) {
          return fail('message_id 为空：请给出要引用的原消息 id（om_ 开头）。');
        }
        if (!text.trim()) {
          return fail('文本为空：text 不能是空白字符串，请给出真正要回复的内容。');
        }
        const data = await ctx.client.request<{
          message_id?: string;
          chat_id?: string;
          msg_type?: string;
        }>('POST', `/im/v1/messages/${encodeURIComponent(message_id)}/reply`, {
          body: { content: JSON.stringify({ text }), msg_type: 'text' },
        });
        const repliedId = data.message_id ?? '';
        ctx.log('feishu_reply 完成', { parent: message_id, replied: repliedId });
        return ok(`已引用回复（原消息=${message_id}，新消息=${repliedId || '(未返回 id)'}）`, {
          parent_message_id: message_id,
          message_id: repliedId,
          chat_id: data.chat_id ?? null,
          msg_type: data.msg_type ?? 'text',
        });
      } catch (err) {
        return fail(describeError(err, '引用回复'));
      }
    },
  );
}
