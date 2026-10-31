/**
 * 通讯录工具：机器人能看到哪些会话、某个会话里有哪些人。
 *
 * 这一组只解决"我在哪、对面是谁"，不发任何消息：
 *  - feishu_chats   —— 列出机器人所在的会话（默认只回文本，不往聊天里发东西）
 *  - feishu_members —— 列出指定会话的成员
 *
 * 注意：
 *  - stdout 是 MCP 的 JSON-RPC 通道，本文件绝不写 stdout，要日志走 ctx.log；
 *  - 每个 handler 整体 try/catch，异常一律变成 fail(...) 返回，不向上抛；
 *  - 数据一律以飞书实际返回为准：字段没有就不显示，绝不补默认值、不猜人数。
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { FeishuApiError } from '@yisang0910/core';
import { ok, fail, type ToolContext } from './types.js';

/** 飞书 page_size 上限是 100，超过会被服务端拒绝 */
const MAX_PAGE_SIZE = 100;
/** with_members=true 时，每个群最多展示几个成员名字 */
const MEMBER_PREVIEW = 5;

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

/** 把 limit 收进 [1, MAX_PAGE_SIZE]，非法值退回默认值 */
function clampLimit(raw: number | undefined, fallback: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback;
  const n = Math.trunc(raw);
  if (n < 1) return 1;
  return n > MAX_PAGE_SIZE ? MAX_PAGE_SIZE : n;
}

/** chat_mode → 人话；未知模式返回 undefined（那就整段省略，不硬编） */
function chatModeLabel(chatMode: string | undefined): string | undefined {
  if (!chatMode) return undefined;
  if (chatMode === 'group') return '群组';
  if (chatMode === 'p2p') return '单聊';
  if (chatMode === 'topic') return '话题群';
  return undefined;
}

export function registerDirectoryTools(server: McpServer, ctx: ToolContext): void {
  // ───────────────────────── 会话列表 ─────────────────────────

  server.registerTool(
    'feishu_chats',
    {
      title: '机器人所在的会话',
      description:
        '列出机器人当前所在的所有会话（群 + 单聊），返回 chat_id 与名字，供后续发送/读历史时当 target 用。' +
        '**只返回文本，不会往飞书里发任何消息**，所以可以放心在探索阶段调用。' +
        '不确定"该往哪个群发"、或者需要 chat_id 但手上只有群名时，先调这个。' +
        '人数只在飞书真的返回了 member_count 时才显示；需要确切成员名单请改用 feishu_members。' +
        'with_members=true 会额外对每个群发一次成员请求（前 5 个名字），会话多时会明显变慢。',
      inputSchema: {
        limit: z
          .number()
          .int()
          .optional()
          .describe('最多返回多少个会话，默认 20，上限 100（超过按 100 处理）。'),
        with_members: z
          .boolean()
          .optional()
          .describe(
            '是否额外拉取每个群的成员名字（各取前 5 个），默认 false。为 true 时对每个群多发一次 listMembers 请求。',
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ limit, with_members }) => {
      try {
        const pageSize = clampLimit(limit, 20);
        const wantMembers = with_members === true;
        const chats = await ctx.client.listChats({ pageSize });

        if (!chats.length) {
          return ok(
            `机器人所在的会话（0 个）：\n` +
              `还没被拉进任何会话。请在飞书里把应用加进群，或让同事发起单聊后再试。`,
            { count: 0, chats: [] },
          );
        }

        const lines: string[] = [`机器人所在的会话（${chats.length} 个）：`];
        const structuredChats: Array<Record<string, unknown>> = [];

        for (const chat of chats) {
          const name = chat.name?.trim() || '(无名)';
          const parts = [`· ${name}`, chat.chatId];

          // member_count 只有飞书真的返回了才显示，没有就整段省略，不猜
          if (typeof chat.memberCount === 'number') {
            parts.push(`${chat.memberCount} 人`);
          }
          const modeLabel = chatModeLabel(chat.chatMode);
          const tail = modeLabel ? `（${modeLabel}）` : '';

          lines.push(parts.join('　') + tail);

          const item: Record<string, unknown> = {
            chat_id: chat.chatId,
            name: chat.name || null,
            chat_mode: chat.chatMode ?? null,
          };
          if (typeof chat.memberCount === 'number') item['member_count'] = chat.memberCount;

          // 单聊没必要再问一次成员（就俩人，其中一个还是机器人自己）
          if (wantMembers && chat.chatMode !== 'p2p') {
            try {
              const members = await ctx.client.listMembers(chat.chatId, MEMBER_PREVIEW);
              const names = members
                .map((m) => m.name?.trim() || m.openId || '(无名)')
                .filter(Boolean);
              if (names.length) {
                lines.push(`　　成员（前 ${names.length} 个）：${names.join('、')}`);
              } else {
                lines.push('　　成员（前 0 个）：(没取到成员，可能群成员列表不可见)');
              }
              item['members_preview'] = names;
            } catch (memberErr) {
              // 单个群的权限/网络问题不该毁掉整个列表
              ctx.log('feishu_chats 取成员失败', { chatId: chat.chatId });
              lines.push(`　　成员：(拉取失败：${describeError(memberErr, '取成员')})`);
              item['members_preview'] = [];
            }
          }

          structuredChats.push(item);
        }

        if (chats.length >= pageSize) {
          lines.push('');
          lines.push(
            `（只取了前 ${pageSize} 个；还有更多会话时把 limit 调大，上限 ${MAX_PAGE_SIZE}）`,
          );
        }

        return ok(lines.join('\n'), {
          count: chats.length,
          limit: pageSize,
          with_members: wantMembers,
          chats: structuredChats,
        });
      } catch (err) {
        return fail(describeError(err, '列会话'));
      }
    },
  );

  // ───────────────────────── 会话成员 ─────────────────────────

  server.registerTool(
    'feishu_members',
    {
      title: '会话成员名单',
      description:
        '列出某个会话（群/单聊）里的成员，返回名字 + open_id。' +
        '适合：确认某人在不在群里、拿到 open_id 用于 @ 或私聊、核对群规模。' +
        '不适合：只是想看有哪些群（用 feishu_chats）；想读聊天内容（用上下文相关工具）。' +
        'chat_id 不填时用 FEISHU_DEFAULT_CHAT_ID；两者都没有会直接报错说明。' +
        '只返回文本，不往飞书发消息。',
      inputSchema: {
        chat_id: z
          .string()
          .optional()
          .describe('要查成员的会话 chat_id（oc_ 开头）。不填则用默认会话 FEISHU_DEFAULT_CHAT_ID。'),
        limit: z
          .number()
          .int()
          .optional()
          .describe('最多返回多少个成员，默认 50，上限 100（超过按 100 处理）。'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ chat_id, limit }) => {
      try {
        const chatId = chat_id?.trim() || ctx.config.defaultChatId;
        if (!chatId) {
          return fail(
            '没有可查的会话：chat_id 未提供，且没有配置默认会话。' +
              '请传 chat_id（oc_ 开头），或先调用 feishu_chats 拿到一个，' +
              '也可以设置环境变量 FEISHU_DEFAULT_CHAT_ID。',
          );
        }

        const pageSize = clampLimit(limit, 50);
        const members = await ctx.client.listMembers(chatId, pageSize);

        if (!members.length) {
          return ok(`会话 ${chatId} 的成员（0 个）：\n没取到成员，可能该会话只有机器人自己，或成员列表不可见。`, {
            chat_id: chatId,
            count: 0,
            members: [],
          });
        }

        const lines: string[] = [`会话 ${chatId} 的成员（${members.length} 个）：`];
        for (const m of members) {
          const name = m.name?.trim() || '(无名)';
          lines.push(`· ${name}（${m.openId || '无 open_id'}）`);
        }
        if (members.length >= pageSize) {
          lines.push('');
          lines.push(
            `（只取了前 ${pageSize} 个；还有更多成员时把 limit 调大，上限 ${MAX_PAGE_SIZE}）`,
          );
        }

        return ok(lines.join('\n'), {
          chat_id: chatId,
          count: members.length,
          limit: pageSize,
          members: members.map((m) => ({
            open_id: m.openId || null,
            name: m.name ?? null,
          })),
        });
      } catch (err) {
        // 权限类错误单独给可执行提示：模型看到缺失 scope 才能让用户去开放平台开
        if (err instanceof FeishuApiError && err.isPermission) {
          const scopes = err.missingScopes.join(', ');
          return fail(
            `权限不足，需要在开放平台开通：${scopes || '(飞书没在错误里返回具体 scope)'}` +
              `\n（原始错误：code=${err.code} ${err.message}）`,
          );
        }
        return fail(describeError(err, '列成员'));
      }
    },
  );
}
