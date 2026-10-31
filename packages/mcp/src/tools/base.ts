/**
 * 基础工具：告诉模型"我是谁、我在哪、我该怎么发东西"。
 * 这是全组工具的样板，其它工具文件请照着这个形状写。
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { infoCard, FeishuApiError } from '@dshfeishu/core';
import { ok, fail, type ToolContext } from './types.js';

export function registerBaseTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'feishu_whoami',
    {
      title: '我是谁 / 默认往哪发',
      description:
        '返回机器人身份（open_id、名字）与当前默认会话配置。' +
        '在发任何消息之前不确定目标会话时，先调这个。' +
        '如果 default_chat_id 为空，说明必须先指定 target 才能发送。',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        const [bot, chats] = await Promise.all([
          ctx.client.botInfo(),
          ctx.client.listChats({ pageSize: 20 }).catch(() => []),
        ]);
        const defaultChat = ctx.config.defaultChatId
          ? (chats.find((c) => c.chatId === ctx.config.defaultChatId)?.name ??
            ctx.config.defaultChatId)
          : '（未设置，发送时必须显式给 target）';

        const lines = [
          `机器人：${bot.name || '(无名)'}（${bot.openId}）`,
          `默认会话：${defaultChat}`,
          `可发送的群（前 20 个）：${
            chats.length ? chats.map((c) => c.name || c.chatId).join('、') : '（还没进任何群）'
          }`,
        ];
        return ok(lines.join('\n'), {
          bot_open_id: bot.openId,
          bot_name: bot.name,
          default_chat_id: ctx.config.defaultChatId ?? null,
          chats: chats.map((c) => ({ chat_id: c.chatId, name: c.name })),
        });
      } catch (err) {
        if (err instanceof FeishuApiError && err.isPermission) {
          return fail(
            `权限不足：${err.message}\n缺少的权限：${err.missingScopes.join(', ') || '(未解析出来)'}`,
          );
        }
        return fail(`取身份失败：${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  server.registerTool(
    'feishu_send_info_card',
    {
      title: '发一张信息卡',
      description:
        '把"标签 + 值"这类结构化信息渲染成一张飞书卡片发出去。' +
        '适合汇报状态、列出项目、展示统计；不适合长文本（那用 feishu_send_text）。',
      inputSchema: {
        target: z
          .string()
          .optional()
          .describe('发送目标：chat_id（oc_ 开头）/ open_id（ou_ 开头）/ 邮箱。不填用默认会话。'),
        title: z.string().describe('卡片标题'),
        fields: z
          .array(
            z.object({
              label: z.string().describe('字段名'),
              value: z.string().describe('字段值（纯文本，会被转义）'),
            }),
          )
          .min(1)
          .describe('要展示的键值对'),
        footer: z.string().optional().describe('卡片底部小字备注'),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ target, title, fields, footer }) => {
      try {
        const card = infoCard({ title, fields, ...(footer ? { footer } : {}) });
        const sent = await ctx.client.sendCard(target, card);
        return ok(`已发送信息卡（message_id=${sent.messageId}）`, {
          message_id: sent.messageId,
        });
      } catch (err) {
        return fail(`发送失败：${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}
