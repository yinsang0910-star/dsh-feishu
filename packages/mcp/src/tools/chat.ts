/**
 * 群与消息管理工具：撤回、转发、置顶、改群、建群/解散、群文件清单、删云文档。
 *
 * 这些是「把已经发出去的东西收回来 / 挪走 / 换个地方」的能力，
 * 跟 messages.ts（往外发）、files.ts（传本地文件）分开。
 *
 * 注意：
 *  - stdout 是 MCP 的 JSON-RPC 通道，本文件绝不写 stdout，要日志走 ctx.log；
 *  - 每个 handler 整体 try/catch，异常一律变成 fail(...) 返回，不向上抛。
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { FeishuApiError } from '@yisang0910/core';
import { ok, fail, type ToolContext } from './types.js';

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

const chatIdSchema = z.string().describe('群 id（oc_ 开头）。');

export function registerChatTools(server: McpServer, ctx: ToolContext): void {
  // ───────────────────────── 撤回 / 转发 / 置顶 ─────────────────────────

  server.registerTool(
    'feishu_recall',
    {
      title: '撤回一条消息',
      description:
        '撤回机器人自己发出去的消息（飞书只允许撤回 24 小时内的、且只能撤回自己发的）。' +
        '也用于「删掉群里那个旧文件」——文件是挂在消息上的，删了消息文件就一起没了。' +
        '不是自己发的消息会失败，这不是权限问题而是飞书规则。',
      inputSchema: {
        message_id: z.string().describe('要撤回的消息 id（om_ 开头）。'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ message_id }) => {
      try {
        if (!message_id.trim()) return fail('message_id 为空：请给出要撤回的消息 id。');
        await ctx.client.recallMessage(message_id.trim());
        ctx.log('feishu_recall 完成', { message_id });
        return ok(`已撤回消息 ${message_id}`, { message_id });
      } catch (err) {
        return fail(describeError(err, '撤回'));
      }
    },
  );

  server.registerTool(
    'feishu_forward',
    {
      title: '转发一条消息到别的会话',
      description:
        '把某条消息原样转发到另一个群或某个人（不经过改写，卡片/图片/文件都保持原样）。' +
        '适合：把结果同步给另一个群、把用户发的图转给负责人。',
      inputSchema: {
        message_id: z.string().describe('要转发的消息 id（om_ 开头）。'),
        to: z.string().describe('转发目标：chat_id（oc_）或 open_id（ou_）。'),
        to_type: z
          .enum(['chat_id', 'open_id', 'email'])
          .optional()
          .describe('目标类型，默认 chat_id。'),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ message_id, to, to_type }) => {
      try {
        const sent = await ctx.client.forwardMessage(message_id.trim(), to.trim(), to_type ?? 'chat_id');
        return ok(`已转发（新消息=${sent.messageId || '(未返回 id)'}）`, {
          message_id: sent.messageId,
          chat_id: sent.chatId,
        });
      } catch (err) {
        return fail(describeError(err, '转发'));
      }
    },
  );

  server.registerTool(
    'feishu_pin',
    {
      title: '置顶 / 取消置顶一条消息',
      description:
        '把一条消息钉在群顶部（公告性质的关键结论），或取消置顶。' +
        '适合：把最终结论、规范文件、长期有效的清单钉住。',
      inputSchema: {
        message_id: z.string().describe('消息 id（om_ 开头）。'),
        unpin: z.boolean().optional().describe('true 表示取消置顶，默认 false（置顶）。'),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ message_id, unpin }) => {
      try {
        if (unpin) {
          await ctx.client.unpinMessage(message_id.trim());
          return ok(`已取消置顶 ${message_id}`, { message_id, pinned: false });
        }
        await ctx.client.pinMessage(message_id.trim());
        return ok(`已置顶 ${message_id}`, { message_id, pinned: true });
      } catch (err) {
        return fail(describeError(err, unpin ? '取消置顶' : '置顶'));
      }
    },
  );

  // ───────────────────────── 群本身 ─────────────────────────

  server.registerTool(
    'feishu_chat_update',
    {
      title: '改群信息（群名 / 描述 / 谁能拉人）',
      description:
        '改群名、群描述，或调整「谁能邀请成员 / 谁能分享群名片 / 谁能 @所有人」。' +
        '只传要改的字段，其它保持不动。',
      inputSchema: {
        chat_id: chatIdSchema,
        name: z.string().optional().describe('新群名。'),
        description: z.string().optional().describe('新群描述。'),
        add_member_permission: z
          .enum(['all_members', 'only_owner'])
          .optional()
          .describe('谁能拉人进群。'),
        share_card_permission: z
          .enum(['allowed', 'not_allowed'])
          .optional()
          .describe('群成员能否分享群名片。'),
        at_all_permission: z
          .enum(['all_members', 'only_owner'])
          .optional()
          .describe('谁能 @所有人。'),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ chat_id, name, description, add_member_permission, share_card_permission, at_all_permission }) => {
      try {
        await ctx.client.updateChat(chat_id.trim(), {
          ...(name !== undefined ? { name } : {}),
          ...(description !== undefined ? { description } : {}),
          ...(add_member_permission ? { addMemberPermission: add_member_permission } : {}),
          ...(share_card_permission ? { shareCardPermission: share_card_permission } : {}),
          ...(at_all_permission ? { atAllPermission: at_all_permission } : {}),
        });
        return ok(`已更新群 ${chat_id}`, { chat_id });
      } catch (err) {
        return fail(describeError(err, '改群信息'));
      }
    },
  );

  server.registerTool(
    'feishu_chat_create',
    {
      title: '建一个群',
      description:
        '新建群并把指定的人拉进来。机器人建完就是群主，后续能改群名、发消息、置顶。' +
        '成员要用 open_id（ou_ 开头）；不确定 id 先用 feishu_user_lookup 查。',
      inputSchema: {
        name: z.string().describe('群名。'),
        description: z.string().optional().describe('群描述。'),
        member_open_ids: z
          .array(z.string())
          .optional()
          .describe('初始成员 open_id 列表（ou_ 开头）。可以不传，建空群。'),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ name, description, member_open_ids }) => {
      try {
        const { chatId } = await ctx.client.createChat(name, description ?? '', member_open_ids ?? []);
        return ok(`已建群「${name}」（${chatId}）`, { chat_id: chatId });
      } catch (err) {
        return fail(describeError(err, '建群'));
      }
    },
  );

  server.registerTool(
    'feishu_chat_dissolve',
    {
      title: '解散一个群',
      description:
        '解散群。**不可撤销**：群和群里的消息都会消失，机器人必须是群主。' +
        '执行前先跟人确认一遍群名和群 id。',
      inputSchema: {
        chat_id: chatIdSchema,
        confirm: z
          .string()
          .describe('把群名原样抄一遍作为确认（防止手滑删错群）。'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ chat_id, confirm }) => {
      try {
        const chats = await ctx.client.listChats({ pageSize: 100 });
        const target = chats.find((c) => c.chatId === chat_id.trim());
        if (!target) return fail(`没找到群 ${chat_id}：机器人可能不在这个群里。`);
        if ((target.name ?? '') !== confirm.trim()) {
          return fail(
            `确认不匹配：群 ${chat_id} 的名字是「${target.name}」，你写的是「${confirm}」。` +
              `要解散请把群名原样抄一遍。`,
          );
        }
        await ctx.client.dissolveChat(chat_id.trim());
        return ok(`已解散群「${target.name}」（${chat_id}）`, { chat_id, name: target.name });
      } catch (err) {
        return fail(describeError(err, '解散群'));
      }
    },
  );

  // ───────────────────────── 群文件 ─────────────────────────

  server.registerTool(
    'feishu_chat_files',
    {
      title: '列群里发过的文件',
      description:
        '列出群里发过的文件（对应飞书群聊顶部的「文件」标签页），带消息 id、文件名、大小、发送时间。' +
        '飞书没有独立的「群文件列表」接口，文件是挂在消息上的，所以这里翻最近的群消息再筛出来。' +
        '要删某个文件：拿这里的 message_id 去调 feishu_recall。',
      inputSchema: {
        chat_id: chatIdSchema,
        keyword: z.string().optional().describe('只留文件名含这个词的（模糊匹配）。'),
        pages: z.number().int().min(1).max(20).optional().describe('翻多少页消息，默认 3。'),
        page_size: z.number().int().min(1).max(50).optional().describe('每页条数，默认 50。'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ chat_id, keyword, pages, page_size }) => {
      try {
        const files = await ctx.client.listChatFiles(chat_id.trim(), {
          ...(keyword ? { keyword } : {}),
          ...(pages ? { pages } : {}),
          ...(page_size ? { pageSize: page_size } : {}),
        });
        if (!files.length) {
          return ok(
            `最近这些消息里没找到${keyword ? `含「${keyword}」的` : ''}文件。` +
              `（只翻了最近 ${pages ?? 3} 页；文件更早的话把 pages 调大。）`,
            { chat_id, files: [] },
          );
        }
        const lines = files.map((f, i) => {
          const when = new Date(Number(f.createTime) || 0).toISOString().slice(0, 16).replace('T', ' ');
          const size = f.bytes ? `${(f.bytes / 1024).toFixed(0)}KB` : '?';
          return `${i + 1}. ${f.fileName || '(无名)'} · ${size} · ${when} · ${f.messageId}`;
        });
        return ok(
          `群里最近有 ${files.length} 个文件：\n${lines.join('\n')}\n\n` +
            `要删其中某个，用它的 message_id 调 feishu_recall。`,
          { chat_id, files },
        );
      } catch (err) {
        return fail(describeError(err, '列群文件'));
      }
    },
  );

  server.registerTool(
    'feishu_file_delete',
    {
      title: '删云空间里的文件（不是群消息附件）',
      description:
        '删除云空间（我的空间/共享空间）里的文件、文档、表格、多维表格或空文件夹。' +
        '**注意**：群聊里发的文件是消息附件，那个用 feishu_recall 删消息；' +
        '这里的 file_token 是云文档体系里的 token（来自 feishu_drive_list），两者不通用。',
      inputSchema: {
        file_token: z.string().describe('云空间文件的 token（来自 feishu_drive_list）。'),
        type: z
          .enum(['file', 'docx', 'doc', 'sheet', 'bitable', 'folder', 'mindnote', 'slides'])
          .optional()
          .describe('文件类型，默认 file。文件夹要删必须先清空。'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ file_token, type }) => {
      try {
        await ctx.client.deleteDriveFile(file_token.trim(), type ?? 'file');
        return ok(`已删除云空间文件 ${file_token}`, { file_token, type: type ?? 'file' });
      } catch (err) {
        return fail(describeError(err, '删文件'));
      }
    },
  );

  // ───────────────────────── 表情回应 ─────────────────────────

  server.registerTool(
    'feishu_reaction',
    {
      title: '给消息加表情回应 / 查看 / 撤掉',
      description:
        '表情回应是飞书里最轻的「我看到了 / 收到 / 干完了」信号，不占聊天版面。' +
        'action=add 加一个（emoji_type 用飞书的表情名，如 SMILE、THUMBSUP、DONE、OK、HEART）；' +
        'action=list 看这条消息上有谁回应了什么（返回 reaction_id，撤掉时要用）；' +
        'action=remove 撤掉一个（只能撤机器人自己加的）。',
      inputSchema: {
        action: z.enum(['add', 'list', 'remove']).describe('add 加、list 看、remove 撤。'),
        message_id: z.string().describe('消息 id（om_ 开头）。'),
        emoji_type: z
          .string()
          .optional()
          .describe('action=add 必填，飞书表情名，如 SMILE / THUMBSUP / DONE / OK / HEART。'),
        reaction_id: z
          .string()
          .optional()
          .describe('action=remove 必填，来自 action=list 返回的 reaction_id。'),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ action, message_id, emoji_type, reaction_id }) => {
      try {
        const mid = message_id.trim();
        if (!mid) return fail('message_id 为空。');

        if (action === 'add') {
          const emoji = (emoji_type ?? '').trim().toUpperCase();
          if (!emoji) return fail('action=add 需要 emoji_type，例如 SMILE。');
          const r = await ctx.client.addReaction(mid, emoji);
          ctx.log('feishu_reaction add', { mid, emoji });
          return ok(`已给消息 ${mid} 加上 ${emoji} 回应。`, { reaction_id: r.reactionId });
        }

        if (action === 'list') {
          const items = await ctx.client.listReactions(mid);
          if (!items.length) return ok(`消息 ${mid} 上还没有任何表情回应。`, { items: [] });
          const lines = items.map(
            (it, i) => `${i + 1}. ${it.emojiType}　by ${it.operator}　(${it.reactionId})`,
          );
          return ok(`消息 ${mid} 上有 ${items.length} 个回应：\n${lines.join('\n')}`, { items });
        }

        const rid = (reaction_id ?? '').trim();
        if (!rid) return fail('action=remove 需要 reaction_id（先用 action=list 查）。');
        await ctx.client.deleteReaction(mid, rid);
        return ok(`已撤掉消息 ${mid} 上的回应 ${rid}。`, { reaction_id: rid });
      } catch (err) {
        return fail(describeError(err, '表情回应'));
      }
    },
  );

  // ───────────────────────── 合并转发 ─────────────────────────

  server.registerTool(
    'feishu_merge_forward',
    {
      title: '把多条消息合并成一份记录转发',
      description:
        '把 2~50 条消息打包成一张「会话记录」卡片发到别处，适合「把这段讨论转给另一个人看」。' +
        '和 feishu_forward 的区别：forward 是一条一条转，merge_forward 是合成一份带来源的摘要。',
      inputSchema: {
        message_ids: z
          .array(z.string())
          .min(2)
          .max(50)
          .describe('要合并的消息 id 列表（om_ 开头），2~50 条。'),
        receive_id: z.string().describe('发到哪里：chat_id（oc_ 开头）或 open_id（ou_ 开头）。'),
        receive_id_type: z
          .enum(['chat_id', 'open_id', 'email'])
          .optional()
          .describe('receive_id 的类型，默认 chat_id。'),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ message_ids, receive_id, receive_id_type }) => {
      try {
        const ids = message_ids.map((x) => x.trim()).filter(Boolean);
        if (ids.length < 2) return fail('至少给两条消息 id。');
        const sent = await ctx.client.mergeForward(ids, receive_id.trim(), receive_id_type ?? 'chat_id');
        ctx.log('feishu_merge_forward', { count: ids.length });
        return ok(`已把 ${ids.length} 条消息合并转发到 ${receive_id}（新消息 ${sent.messageId}）。`, {
          message_id: sent.messageId,
          count: ids.length,
        });
      } catch (err) {
        return fail(describeError(err, '合并转发'));
      }
    },
  );

  // ───────────────────────── 群公告 ─────────────────────────

  server.registerTool(
    'feishu_chat_announcement',
    {
      title: '读 / 改群公告',
      description:
        '群公告是群顶部那条所有人都能看到的说明。action=get 读现有内容；' +
        'action=set 改写（mode=replace 整段替换，mode=append 接在末尾）。' +
        '改公告需要机器人是群主或管理员。',
      inputSchema: {
        action: z.enum(['get', 'set']).describe('get 读、set 写。'),
        chat_id: chatIdSchema,
        content: z.string().optional().describe('action=set 必填，新公告正文（支持纯文本与换行）。'),
        mode: z
          .enum(['replace', 'append'])
          .optional()
          .describe('action=set 时用：replace 整段替换（默认），append 接在末尾。'),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ action, chat_id, content, mode }) => {
      try {
        const cid = chat_id.trim();
        if (action === 'get') {
          const a = await ctx.client.getChatAnnouncement(cid);
          if (!a.content.trim()) return ok(`群 ${cid} 现在没有公告。`, { content: '' });
          return ok(`群 ${cid} 的公告：\n\n${a.content}`, { content: a.content });
        }
        const text = (content ?? '').trim();
        if (!text) return fail('action=set 需要 content。');
        const useMode = mode ?? 'replace';
        await ctx.client.setChatAnnouncement(cid, text, useMode);
        return ok(
          `已${useMode === 'append' ? '追加' : '更新'}群 ${cid} 的公告（${text.length} 字）。`,
          { chat_id: cid, mode: useMode },
        );
      } catch (err) {
        return fail(describeError(err, '群公告'));
      }
    },
  );
}
