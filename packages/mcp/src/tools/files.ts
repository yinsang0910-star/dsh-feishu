/**
 * 文件工具：本地文件 ↔ 飞书会话的双向通道。
 *
 * 这是本项目相对 @larksuiteoapi/lark-mcp 的核心增量——那个库只会搬 OpenAPI 元数据，
 * 碰不到本地磁盘：
 *   - feishu_send_file    本地文件 → 会话（它没有）
 *   - feishu_send_image   本地图片 → 会话
 *   - feishu_download     用户的附件 → 本地（agent 才能接着用 bash 处理再发回去）
 *
 * 平台边界全部收在这一层，别让模型自己猜：
 *   - IM 单文件 30MB、单图片 10MB 的上限，超了直接给可执行的替代方案；
 *   - 图片后缀白名单，非图片引导去 feishu_send_file；
 *   - 落盘命名优先用消息自带名字，没有就用 messageId + fileKey 前缀，且自动去重不覆盖。
 */

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { FeishuApiError } from '@yisang0910/core';
import { ok, fail, type ToolContext } from './types.js';

// ───────────────────────── 平台边界常量 ─────────────────────────

/** 飞书 IM 单文件上限：30MB（文档/视频/音频另有更低上限，这里按最宽的口径拦） */
const MAX_IM_FILE_BYTES = 30 * 1024 * 1024;
/** 飞书 IM 图片上限：10MB */
const MAX_IM_IMAGE_BYTES = 10 * 1024 * 1024;
/** 图片通道支持的扩展名（飞书 /im/v1/images 只吃这几种） */
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
/** 下载落盘目录默认值，相对进程 cwd 解析 */
const DEFAULT_DOWNLOAD_DIR = './downloads';

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.html': 'text/html',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.7z': 'application/x-7z-compressed',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
};

// ───────────────────────── 小工具 ─────────────────────────

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '? B';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[idx] ?? 'B'}`;
}

/** 把任意异常翻译成一句人能照着修的话；权限错误必须给出缺失的 scope */
function describeError(err: unknown): string {
  if (err instanceof FeishuApiError) {
    if (err.isPermission) {
      return (
        `权限不足：${err.message}\n` +
        `需要在开放平台开通后重试：${err.missingScopes.join(', ') || '(错误信息里没带 scope，请到应用权限页确认 im:resource / im:message 相关权限)'}`
      );
    }
    return `飞书 API 报错：${err.message}`;
  }
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    switch (code) {
      case 'ENOENT':
        return `本地路径不存在：${err.message}`;
      case 'EACCES':
      case 'EPERM':
        return `本地文件没有访问权限：${err.message}`;
      case 'EISDIR':
        return `这是一个目录，不是文件：${err.message}`;
      default:
        return err.message;
    }
  }
  return String(err);
}

/** 后缀 → mime；猜不出来返回 undefined，不瞎编 */
function guessMime(fileName: string): string | undefined {
  const ext = path.extname(fileName).toLowerCase();
  return MIME_BY_EXT[ext];
}

/** 去掉路径成分与 Windows 非法字符，只留一个能落盘的文件名 */
function safeFileName(raw: string): string {
  const flat = raw.replace(/[\\/]+/g, '/');
  const base = path.basename(flat);
  return base
    .replace(/[<>:"|?*\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '')
    .trim();
}

/** 目标已存在时顺延成 name-1.ext / name-2.ext，绝不静默覆盖用户文件 */
async function uniquePath(destPath: string): Promise<string> {
  const dir = path.dirname(destPath);
  const ext = path.extname(destPath);
  const stem = path.basename(destPath, ext);
  let candidate = destPath;
  for (let i = 1; i <= 99; i += 1) {
    try {
      await fs.promises.access(candidate);
    } catch {
      return candidate;
    }
    candidate = path.join(dir, `${stem}-${i}${ext}`);
  }
  return path.join(dir, `${stem}-${Date.now()}${ext}`);
}

function contentObject(content: unknown): Record<string, unknown> {
  if (content && typeof content === 'object' && !Array.isArray(content)) {
    return content as Record<string, unknown>;
  }
  return {};
}

function pickString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

interface CheckedFile {
  /** path.resolve() 之后的绝对路径 */
  abs: string;
  bytes: number;
  /** 发送时显示的名字 */
  displayName: string;
}

// ───────────────────────── 注册 ─────────────────────────

export function registerFileTools(server: McpServer, ctx: ToolContext): void {
  // ═══════════════════ feishu_send_file ═══════════════════
  server.registerTool(
    'feishu_send_file',
    {
      title: '把本地文件发进会话',
      description:
        '把本地磁盘上的文件上传并发到飞书会话（文档、压缩包、日志、报表、生成的代码包都行）。' +
        '这是本项目最核心的工具：任何"我在本地做好了，给你看看"的场景都走它。' +
        '单个文件上限 30MB，超了会直接报错并给出替代方案。' +
        '要一次发多个文件，把第一个放 path，其余放 paths；' +
        'caption 非空时会先发一条纯文本说明再发文件，适合"这是刚才跑出来的结果，重点看第 3 页"。' +
        '纯图片想直接预览的改用 feishu_send_image；只是想说话不要用这个，用 feishu_send_text。',
      inputSchema: {
        target: z
          .string()
          .optional()
          .describe('发送目标：chat_id（oc_ 开头）/ open_id（ou_ 开头）/ 邮箱。不填用默认会话。'),
        path: z.string().describe('本地文件绝对路径（也接受相对路径，内部会 path.resolve）'),
        paths: z
          .array(z.string())
          .optional()
          .describe('批量发送时的其余文件路径；给了就按 path → paths 的顺序逐个发，最后汇总'),
        name: z
          .string()
          .optional()
          .describe('发送时显示的文件名；只在单文件时生效，默认取 basename'),
        caption: z
          .string()
          .optional()
          .describe('随文件发的说明文字；非空时先发一条文本消息，再发文件'),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ target, path: filePath, paths, name, caption }) => {
      try {
        // 1) 汇总待发列表：path 是主文件，paths 是追加项；去重后保持顺序
        const rawList = [filePath, ...(paths ?? [])];
        const absList: string[] = [];
        for (const raw of rawList) {
          if (typeof raw !== 'string' || !raw.trim()) continue;
          const abs = path.resolve(raw.trim());
          if (!absList.includes(abs)) absList.push(abs);
        }
        if (absList.length === 0) return fail('没有可发送的文件：path 是空的，请给一个本地文件路径。');

        // 2) 先全量体检，任何一项不合格就整批不发，避免发一半
        const entries: CheckedFile[] = [];
        const problems: string[] = [];
        for (const abs of absList) {
          let stat: fs.Stats;
          try {
            stat = await fs.promises.stat(abs);
          } catch (err) {
            problems.push(`找不到文件：${abs}（${describeError(err)}）`);
            continue;
          }
          if (!stat.isFile()) {
            problems.push(`不是普通文件（可能是目录或设备）：${abs}`);
            continue;
          }
          if (stat.size === 0) {
            problems.push(`文件是空的（0 字节）：${abs}`);
            continue;
          }
          if (stat.size > MAX_IM_FILE_BYTES) {
            problems.push(
              `${path.basename(abs)} 有 ${formatBytes(stat.size)}，超过飞书 IM 单文件 30MB 上限。` +
                `可以：① 压缩或分卷后再发；② 只发关键片段；` +
                `③ 传到飞书云文档/对象存储后，用 feishu_send_text 发链接。`,
            );
            continue;
          }
          const only = absList.length === 1 && name && name.trim() ? name.trim() : undefined;
          entries.push({
            abs,
            bytes: stat.size,
            displayName: only ? safeFileName(only) || path.basename(abs) : path.basename(abs),
          });
        }
        if (problems.length > 0) {
          return fail(`发送中止，${problems.length} 个文件不符合要求：\n- ${problems.join('\n- ')}`, {
            rejected: absList,
            problems,
          });
        }

        // 3) 先发 caption（失败不影响文件本体，但要记下来）
        let captionMessageId: string | undefined;
        let captionError: string | undefined;
        const captionText = caption?.trim();
        if (captionText) {
          try {
            const sentCaption = await ctx.client.sendText(target, captionText);
            captionMessageId = sentCaption.messageId;
          } catch (err) {
            captionError = describeError(err);
            ctx.log('caption 发送失败，继续发文件', { error: captionError });
          }
        }

        // 4) 逐个发，单个失败不影响后面的
        const sent: Array<{
          path: string;
          name: string;
          message_id: string;
          file_key: string;
          bytes: number;
        }> = [];
        const failures: string[] = [];
        for (const entry of entries) {
          try {
            const result = await ctx.client.sendFile(target, entry.abs, entry.displayName);
            sent.push({
              path: entry.abs,
              name: entry.displayName,
              message_id: result.messageId,
              file_key: result.fileKey,
              bytes: result.bytes,
            });
          } catch (err) {
            failures.push(`${entry.displayName}：${describeError(err)}`);
          }
        }

        const totalBytes = sent.reduce((sum, item) => sum + item.bytes, 0);

        // 5) 全挂：直接失败，把权限/网络原因原样带出去
        if (sent.length === 0) {
          return fail(`文件发送失败：\n- ${failures.join('\n- ')}`, {
            failures,
            caption_message_id: captionMessageId ?? null,
          });
        }

        // 6) 组装回执
        const lines: string[] =
          sent.length === 1
            ? [`已发送文件 ${sent[0]?.name ?? ''}（${formatBytes(sent[0]?.bytes ?? 0)}）`]
            : [`已发送 ${sent.length} 个文件（合计 ${formatBytes(totalBytes)}）`];
        for (const item of sent) {
          lines.push(
            sent.length === 1
              ? `message_id=${item.message_id}\nfile_key=${item.file_key}\npath=${item.path}`
              : `- ${item.name}（${formatBytes(item.bytes)}）message_id=${item.message_id}`,
          );
        }
        if (captionMessageId) lines.push(`说明文字已先发出（message_id=${captionMessageId}）`);
        if (captionError) lines.push(`注意：说明文字没发出去（${captionError}），文件本身已发出`);

        const structured = {
          count: sent.length,
          total_bytes: totalBytes,
          files: sent,
          ...(captionMessageId ? { caption_message_id: captionMessageId } : {}),
          ...(failures.length ? { failures } : {}),
        };

        if (failures.length > 0) {
          lines.push(`另有 ${failures.length} 个失败：`, ...failures.map((f) => `- ${f}`));
          return fail(lines.join('\n'), structured);
        }
        return ok(lines.join('\n'), structured);
      } catch (err) {
        return fail(`发送文件失败：${describeError(err)}`);
      }
    },
  );

  // ═══════════════════ feishu_send_image ═══════════════════
  server.registerTool(
    'feishu_send_image',
    {
      title: '把本地图片发进会话',
      description:
        '把本地图片以"图片消息"发到飞书会话，收到的人可以直接在聊天里看到缩略图、点开大图。' +
        '只在需要预览时用；要发 PDF、压缩包、代码等非图片文件请用 feishu_send_file。' +
        '支持 png / jpg / jpeg / gif / webp / bmp，单张上限 10MB。' +
        '截图、图表、设计稿的效果图都适合走这条。',
      inputSchema: {
        target: z
          .string()
          .optional()
          .describe('发送目标：chat_id（oc_ 开头）/ open_id（ou_ 开头）/ 邮箱。不填用默认会话。'),
        path: z.string().describe('本地图片路径（绝对路径或相对路径，内部会 path.resolve）'),
        caption: z
          .string()
          .optional()
          .describe('随图发的说明文字；非空时先发一条文本消息，再发图片'),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ target, path: imagePath, caption }) => {
      try {
        if (!imagePath || !imagePath.trim()) return fail('path 是空的，请给一个本地图片路径。');
        const abs = path.resolve(imagePath.trim());
        const ext = path.extname(abs).toLowerCase();

        if (!IMAGE_EXTS.has(ext)) {
          return fail(
            `${path.basename(abs)} 的后缀是 "${ext || '(无后缀)'}"，不是图片通道支持的格式。` +
              `图片通道只收 ${[...IMAGE_EXTS].join(' / ')}；` +
              `如果这确实是个文件（PDF、docx、zip 等），请改用 feishu_send_file。`,
            { path: abs, ext },
          );
        }

        let stat: fs.Stats;
        try {
          stat = await fs.promises.stat(abs);
        } catch (err) {
          return fail(`找不到图片：${abs}（${describeError(err)}）`, { path: abs });
        }
        if (!stat.isFile()) return fail(`不是普通文件（可能是目录）：${abs}`, { path: abs });
        if (stat.size === 0) return fail(`图片是空的（0 字节）：${abs}`, { path: abs });
        if (stat.size > MAX_IM_IMAGE_BYTES) {
          return fail(
            `图片有 ${formatBytes(stat.size)}，超过飞书 IM 图片 10MB 上限。` +
              `可以：① 压缩或缩放后再发；② 改用 feishu_send_file 当文件发（单文件上限 30MB）。`,
            { path: abs, bytes: stat.size },
          );
        }

        let captionMessageId: string | undefined;
        let captionError: string | undefined;
        const captionText = caption?.trim();
        if (captionText) {
          try {
            const sentCaption = await ctx.client.sendText(target, captionText);
            captionMessageId = sentCaption.messageId;
          } catch (err) {
            captionError = describeError(err);
            ctx.log('图片说明发送失败，继续发图', { error: captionError });
          }
        }

        const result = await ctx.client.sendImage(target, abs);

        const lines = [
          `已发送图片 ${path.basename(abs)}（${formatBytes(result.bytes)}）`,
          `message_id=${result.messageId}`,
          `image_key=${result.imageKey}`,
          `path=${abs}`,
        ];
        if (captionMessageId) lines.push(`说明文字已先发出（message_id=${captionMessageId}）`);
        if (captionError) lines.push(`注意：说明文字没发出去（${captionError}），图片本身已发出`);

        return ok(lines.join('\n'), {
          message_id: result.messageId,
          image_key: result.imageKey,
          bytes: result.bytes,
          path: abs,
          ...(captionMessageId ? { caption_message_id: captionMessageId } : {}),
        });
      } catch (err) {
        return fail(`发送图片失败：${describeError(err)}`);
      }
    },
  );

  // ═══════════════════ feishu_download ═══════════════════
  server.registerTool(
    'feishu_download',
    {
      title: '把用户发来的附件下载到本地',
      description:
        '下载某条飞书消息里的附件（文件或图片）到本地磁盘，返回绝对路径，之后就能用 bash/脚本处理它。' +
        '典型链路：用户发来一个 docx → 本工具下载 → 本地解析/改写 → feishu_send_file 发回。' +
        '不传 file_key 时会自动从消息 content 里取（file_key 或 image_key）；' +
        '落盘名优先用消息里自带的名字，没有就用 <messageId>_<fileKey前8位>.<后缀>，同名文件自动加 -1 后缀不覆盖。',
      inputSchema: {
        message_id: z.string().describe('消息 id（om_ 开头），从 feishu_list_messages 之类的结果里拿'),
        file_key: z
          .string()
          .optional()
          .describe('资源 key；不填则从消息 content 里自动识别 file_key / image_key'),
        dest_dir: z
          .string()
          .optional()
          .describe('落盘目录，默认 ./downloads（相对当前工作目录，内部会 path.resolve）'),
        kind: z
          .enum(['image', 'file'])
          .optional()
          .describe('资源类型，默认 file；图片消息不填时自动按 image 下载'),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ message_id, file_key, dest_dir, kind }) => {
      try {
        const messageId = message_id?.trim();
        if (!messageId) return fail('message_id 是空的，请给要下载附件的消息 id（om_ 开头）。');

        const message = await ctx.client.getMessage(messageId);
        if (!message) {
          return fail(
            `找不到消息 ${messageId}：可能 id 不对、已被撤回，或机器人不在该会话里（需要 im:message 读权限）。`,
            { message_id: messageId },
          );
        }

        const content = contentObject(message.content);
        const contentFileKey =
          pickString(content, ['file_key', 'fileKey']) ?? pickString(content, ['image_key', 'imageKey']);
        const resolvedKey = (file_key?.trim() || contentFileKey || '').trim();
        if (!resolvedKey) {
          return fail(
            `消息 ${messageId}（msg_type=${message.msgType || '未知'}）的 content 里没有 file_key / image_key，` +
              `也没有显式传 file_key。先确认这条消息真的带附件（纯文本/卡片消息没有资源可下）。`,
            { message_id: messageId, msg_type: message.msgType, content: message.content ?? null },
          );
        }

        // 类型：显式传了就用；没传就按消息形态自动判，图片消息给 image，其余给 file
        const resolvedKind: 'image' | 'file' =
          kind ?? (message.msgType === 'image' || content['image_key'] !== undefined ? 'image' : 'file');

        // 落盘名字：优先消息自带的名字，其次 <messageId>_<fileKey前8位>.<后缀>
        const rawName =
          pickString(content, ['file_name', 'fileName', 'name']) ??
          (resolvedKind === 'image' ? pickString(content, ['image_name']) : undefined);
        const hintedExt = rawName ? path.extname(rawName).toLowerCase() : '';
        const fallbackExt = hintedExt || (resolvedKind === 'image' ? '.png' : '.bin');
        const fallbackName = `${messageId}_${resolvedKey.slice(0, 8)}${fallbackExt}`;
        const baseName = (rawName && safeFileName(rawName)) || safeFileName(fallbackName) || fallbackName;

        const dir = path.resolve(dest_dir?.trim() || DEFAULT_DOWNLOAD_DIR);
        const destPath = await uniquePath(path.join(dir, baseName));

        const result = await ctx.client.downloadMessageResource(
          messageId,
          resolvedKey,
          resolvedKind,
          destPath,
        );

        const mimeType = result.mimeType ?? guessMime(result.fileName);
        const lines = [
          `已下载到本地：${result.path}`,
          `大小：${formatBytes(result.bytes)}（${result.bytes} 字节）`,
          `文件名：${result.fileName}`,
          `类型：${mimeType ?? `未知（${resolvedKind}）`}`,
          `来源：message_id=${messageId} · file_key=${resolvedKey}`,
        ];

        return ok(lines.join('\n'), {
          path: result.path,
          bytes: result.bytes,
          file_name: result.fileName,
          mime_type: mimeType ?? null,
          message_id: messageId,
          file_key: resolvedKey,
          kind: resolvedKind,
        });
      } catch (err) {
        return fail(`下载附件失败：${describeError(err)}`, { message_id });
      }
    },
  );
}
