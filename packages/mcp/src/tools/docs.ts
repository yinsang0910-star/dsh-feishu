/**
 * 文档 / 云空间 / 知识库 / 通讯录工具。
 *
 * 这一组的定位：把"飞书里的内容从哪拿、拿到 token 之后下一步做什么"讲清楚。
 *  - feishu_drive_list   —— 云空间目录（根目录或指定文件夹）
 *  - feishu_doc_read     —— 读 docx 文档正文纯文本
 *  - feishu_doc_create   —— 新建 docx 文档
 *  - feishu_wiki_spaces  —— 知识库空间列表
 *  - feishu_wiki_node    —— 知识库节点查询 / 空间根节点列表
 *  - feishu_user_lookup  —— 邮箱 / 手机号 / open_id 查人
 *
 * 关键约定：
 *  - stdout 是 MCP 的 JSON-RPC 通道，本文件绝不写 stdout，要日志走 ctx.log；
 *  - 每个 handler 整体 try/catch，异常一律变成 fail(...)，不向上抛；
 *  - 权限错误（FeishuApiError.isPermission）必须把 missingScopes 原样吐给模型，
 *    并在文案里点明"去开放平台开通哪个 scope + 重新发布版本"，否则人不知道该干嘛；
 *  - 应用当前的权限缺口（docx:document:readonly / docx:document:create）是**真实存在**的，
 *    所以这两个工具照实现、但失败信息要能直接指导人去补权限，而不是含糊的"调用失败"。
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { FeishuApiError } from '@yisang0910/core';
import { ok, fail, type ToolContext } from './types.js';

/** 云空间 / 知识库的 page_size 上限（超过按上限处理，避免被服务端拒） */
const DRIVE_MAX_PAGE_SIZE = 200;
const WIKI_MAX_PAGE_SIZE = 50;
/** 读文档默认截断长度 */
const DEFAULT_MAX_CHARS = 20_000;

/** 飞书文档类型 → 中文名 + 图标。键就是 DriveFile.type / WikiNode.objType 的取值 */
const TYPE_LABELS: Record<string, { icon: string; label: string }> = {
  doc: { icon: '📄', label: '旧版文档' },
  docx: { icon: '📝', label: '新版文档' },
  sheet: { icon: '📊', label: '电子表格' },
  bitable: { icon: '🗂', label: '多维表格' },
  file: { icon: '📎', label: '文件' },
  folder: { icon: '📁', label: '文件夹' },
  mindnote: { icon: '🧠', label: '思维笔记' },
};

/** 类型码 → 「📝 新版文档」；未知类型如实回显，不硬猜 */
function typeLabel(type: string | undefined): string {
  const t = (type ?? '').trim();
  if (!t) return '❓ 未知类型(飞书未返回 type)';
  const hit = TYPE_LABELS[t];
  if (hit) return `${hit.icon} ${hit.label}`;
  return `❓ 未知类型(${t})`;
}

/**
 * 云空间返回的 modified_time 是 epoch 秒的字符串（如 "1793295522"），
 * 直接给模型看没意义，转成本地时间；解析不出来就原样回显，不编造时间。
 */
function formatModified(raw: string | undefined): string | undefined {
  const v = raw?.trim();
  if (!v) return undefined;
  if (!/^\d{9,13}$/.test(v)) return v;
  const ms = v.length <= 10 ? Number(v) * 1000 : Number(v);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return v;
  const p = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}`
  );
}

/** 把任意异常翻译成给模型看的中文提示；权限类带上缺失的 scope + 该去开什么 */
function describeError(err: unknown, action: string, permissionHint?: string): string {
  if (err instanceof FeishuApiError) {
    if (err.isPermission) {
      const scopes = err.missingScopes.join(', ') || '(飞书没在错误里返回具体 scope)';
      const hint = permissionHint ? `\n${permissionHint}` : '';
      return (
        `${action}失败：权限不足（code=${err.code}）。` +
        `缺少的权限：${scopes}${hint}\n` +
        `（原始错误：${err.message}）`
      );
    }
    return `${action}失败：code=${err.code} ${err.message}`;
  }
  return `${action}失败：${err instanceof Error ? err.message : String(err)}`;
}

/** 把 limit 收进 [1, max]，非法值退回默认值 */
function clampLimit(raw: number | undefined, fallback: number, max: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return Math.min(fallback, max);
  const n = Math.trunc(raw);
  if (n < 1) return 1;
  return n > max ? max : n;
}

/** 从文档块里尽量抽出可读文字。飞书块是 {block_id, block_type, text:{elements:[{text_run:{content}}]}, ...} */
function extractBlockText(block: Record<string, unknown>): string {
  const pick = (node: unknown): string => {
    if (!node || typeof node !== 'object') return '';
    const obj = node as Record<string, unknown>;
    const out: string[] = [];
    const elements = obj.elements;
    if (Array.isArray(elements)) {
      for (const el of elements) {
        if (!el || typeof el !== 'object') continue;
        const e = el as Record<string, unknown>;
        for (const key of ['text_run', 'mention_doc', 'mention_user', 'equation']) {
          const run = e[key];
          if (run && typeof run === 'object') {
            const content = (run as Record<string, unknown>).content;
            if (typeof content === 'string') out.push(content);
          }
        }
      }
    }
    return out.join('');
  };

  // 文本、标题、列表、待办、引用、代码块都挂在自己的键上
  for (const key of Object.keys(block)) {
    if (key === 'block_id' || key === 'block_type' || key === 'parent_id' || key === 'children') continue;
    const value = block[key];
    if (!value || typeof value !== 'object') continue;
    const text = pick(value);
    if (text) return text;
  }
  return '';
}

export function registerDocsTools(server: McpServer, ctx: ToolContext): void {
  // ───────────────────────── 云空间：文件列表 ─────────────────────────

  server.registerTool(
    'feishu_drive_list',
    {
      title: '列云空间文件',
      description:
        '列出云空间（我的空间）里某个文件夹下的文件，返回类型、名字、token、修改时间。' +
        '使用场景：模型只知道"有个文档/表格"，需要先找到它的 token 时；' +
        '或者要盘点某个目录里都有什么。folder_token 不填等于根目录。' +
        '返回的 token 就是下一步要用的钥匙：docx 类型的 token 传给 feishu_doc_read 读正文；' +
        'bitable 类型的 token 传给 feishu_bitable_tables 看表结构。' +
        '前置条件：应用需要有云空间读取权限（drive:drive 或 drive:drive.metadata:readonly），' +
        '且目标文件夹已共享给该应用。只读操作，不会修改云空间任何内容。',
      inputSchema: {
        folder_token: z
          .string()
          .optional()
          .describe('要列出的文件夹 token；不填或传空字符串表示根目录。子文件夹的 token 来自上一层的返回。'),
        limit: z
          .number()
          .int()
          .optional()
          .describe(`最多返回多少个条目，默认 50，上限 ${DRIVE_MAX_PAGE_SIZE}（超过按上限处理）。`),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ folder_token, limit }) => {
      try {
        const folderToken = folder_token?.trim() ?? '';
        const pageSize = clampLimit(limit, 50, DRIVE_MAX_PAGE_SIZE);
        const { items, hasMore } = await ctx.client.listDriveFiles(folderToken, pageSize);
        const where = folderToken ? `文件夹 ${folderToken}` : '根目录';

        if (!items.length) {
          return ok(
            `云空间（${where}）里没有返回任何文件。\n` +
              `可能原因：1) 该目录确实是空的；2) 文件夹没有被共享给应用；` +
              `3) folder_token 不是文件夹（可能传成了文档 token）。\n` +
              `排查：先不带 folder_token 再调一次看根目录，根目录也空基本就是应用没有云空间权限/没被共享。`,
            { count: 0, folder_token: folderToken || null, has_more: false, files: [] },
          );
        }

        const lines: string[] = [`云空间（${where}）共 ${items.length} 个条目：`];
        for (const f of items) {
          const name = f.name?.trim() || '(无名)';
          const token = f.token?.trim() || '(无 token)';
          const when = formatModified(f.modifiedTime);
          const tail = when ? `　改于 ${when}` : '';
          lines.push(`${typeLabel(f.type)}　${name}　token=${token}${tail}`);
        }

        lines.push('');
        lines.push(
          '下一步：拿到 docx 类型的 token 后，用 feishu_doc_read 读内容；' +
            '拿到 bitable 的 token 后，用 feishu_bitable_tables 看表结构。' +
            '文件夹的 token 可以再传给 feishu_drive_list 往下一层翻。',
        );
        if (hasMore) {
          lines.push(
            `（飞书说还有更多：只取了前 ${pageSize} 个，把 limit 调大或换 folder_token 细分目录）`,
          );
        }

        return ok(lines.join('\n'), {
          count: items.length,
          folder_token: folderToken || null,
          has_more: hasMore,
          files: items.map((f) => ({
            token: f.token,
            name: f.name,
            type: f.type,
            type_label: TYPE_LABELS[f.type ?? '']?.label ?? null,
            url: f.url ?? null,
            modified_time: f.modifiedTime ?? null,
          })),
        });
      } catch (err) {
        return fail(
          describeError(
            err,
            '列云空间文件',
            '需要在开放平台给应用开通云空间权限（如 drive:drive 或 drive:drive.metadata:readonly），' +
              '并把目标文件夹共享给该应用，然后重新发布版本。',
          ),
        );
      }
    },
  );

  // ───────────────────────── 文档：读正文 ─────────────────────────

  server.registerTool(
    'feishu_doc_read',
    {
      title: '读飞书文档正文',
      description:
        '读取一个 docx 文档的纯文本正文（不含图片、表格结构、评论），用于总结、摘录、问答。' +
        '使用场景：手上已有 document_id，想看文档写了什么。' +
        'document_id 从哪来：feishu_drive_list 里 docx 条目的 token；' +
        '或者知识库场景下 feishu_wiki_node 返回的 obj_token（注意是 obj_token，不是 node_token）。' +
        '前置条件（重要）：应用目前有 docs:doc，但**没有** docx:document:readonly，' +
        '读已有文档很可能返回 99991672；拿到这个错误时，需要在开放平台开通 docx:document（或只读版）' +
        '并**重新发布版本**后才生效。' +
        '不要用它读电子表格（用表格工具）或多维表格（用 feishu_bitable_* 工具）。只读，不改文档。',
      inputSchema: {
        document_id: z
          .string()
          .describe('要读的文档 token（docx 文档的 document_id），不是 URL、不是 node_token。'),
        max_chars: z
          .number()
          .int()
          .optional()
          .describe(`正文最多返回多少个字符，默认 ${DEFAULT_MAX_CHARS}；超出会截断并注明原文长度。`),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ document_id, max_chars }) => {
      try {
        const documentId = document_id.trim();
        if (!documentId) {
          return fail('document_id 不能为空。docx 文档的 token 可以从 feishu_drive_list 或 feishu_wiki_node 拿到。');
        }
        const maxChars =
          typeof max_chars === 'number' && Number.isFinite(max_chars) && max_chars >= 1
            ? Math.trunc(max_chars)
            : DEFAULT_MAX_CHARS;

        const raw = await ctx.client.readDocumentRaw(documentId);

        if (!raw.trim()) {
          return ok(
            `文档 ${documentId} 的正文是空的（飞书返回了 0 个字符）。\n` +
              `可能原因：文档确实没内容；document_id 不是 docx 文档；` +
              `或应用只有元数据权限、读不到正文。`,
            { document_id: documentId, chars: 0, truncated: false, content: '' },
          );
        }

        const total = raw.length;
        const truncated = total > maxChars;
        const content = truncated ? raw.slice(0, maxChars) : raw;

        const head = [
          `文档 ${documentId} 的正文（共 ${total} 字符${truncated ? `，已截断到前 ${maxChars}` : ''}）：`,
        ];
        if (truncated) {
          head.push(`（注意：后面还有 ${total - maxChars} 字符没显示，需要完整内容请把 max_chars 调到 ${total} 以上）`);
        }

        return ok([...head, '', content].join('\n'), {
          document_id: documentId,
          chars: total,
          returned_chars: content.length,
          truncated,
          content,
        });
      } catch (err) {
        return fail(
          describeError(
            err,
            '读文档正文',
            '应用有 docs:doc 但没有 docx:document:readonly，读已有文档会被拒。' +
              '需要在开放平台开通 docx:document（含只读权限）并**重新发布版本**，之后再用本工具。',
          ),
        );
      }
    },
  );

  // ───────────────────────── 文档：新建 ─────────────────────────

  server.registerTool(
    'feishu_doc_create',
    {
      title: '新建飞书文档',
      description:
        '在云空间里新建一个空的 docx 文档，返回 document_id，后续可用 feishu_doc_read 读回校验。' +
        '使用场景：需要把结果沉淀成一份飞书文档、并且希望它在云空间里可被同事打开时。' +
        '只建空文档，不写正文内容；需要正文请建完后再用其它编辑能力写。' +
        '前置条件（重要）：当前应用缺 docx:document:create，调用大概率返回 99991672。' +
        '真失败了不要重试、也不要换参数硬试，去开放平台开通 docx:document:create 并**重新发布版本**。' +
        'folder_token 不填等于建在应用自己的根目录（通常同事看不到，建议显式给一个已共享的文件夹）。',
      inputSchema: {
        title: z.string().describe('新文档标题（就是云空间里显示的文件名）。'),
        folder_token: z
          .string()
          .optional()
          .describe('建在哪个文件夹下；不填则建在应用根目录。token 可从 feishu_drive_list 的 folder 条目拿。'),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ title, folder_token }) => {
      try {
        const docTitle = title.trim();
        if (!docTitle) {
          return fail('title 不能为空：飞书文档需要一个标题（也就是文件名）。');
        }
        const folderToken = folder_token?.trim() || undefined;

        const created = await ctx.client.createDocument(docTitle, folderToken);
        const documentId = created.documentId;

        return ok(
          `已创建文档「${docTitle}」${folderToken ? `（位于文件夹 ${folderToken}）` : '（位于应用根目录）'}\n` +
            `document_id=${documentId || '(飞书没返回 document_id)'}\n` +
            `下一步：用 feishu_doc_read 读回验证，或把 document_id 交给写内容的能力继续编辑。`,
          {
            document_id: documentId || null,
            title: docTitle,
            folder_token: folderToken ?? null,
          },
        );
      } catch (err) {
        return fail(
          describeError(
            err,
            '新建文档',
            '当前应用缺少 docx:document:create。需要在开放平台开通该权限并**重新发布版本**，' +
              '否则每次调用都会 99991672。',
          ),
        );
      }
    },
  );

  // ───────────────────────── 知识库：空间列表 ─────────────────────────

  server.registerTool(
    'feishu_wiki_spaces',
    {
      title: '列知识库空间',
      description:
        '列出机器人能看到的飞书知识库（wiki）空间，返回 space_id 与名字。' +
        '使用场景：要按知识库找文档时，先拿空间列表，再用 feishu_wiki_node（传 space_id）列出根节点。' +
        '前置条件：应用需要被加入知识库（知识库设置 → 成员/应用），否则返回空列表——' +
        '空列表不代表接口坏了，而是这个应用还没被加入任何知识库，需要在知识库设置里添加此应用。' +
        '只读，不改知识库结构。',
      inputSchema: {
        limit: z
          .number()
          .int()
          .optional()
          .describe(`最多返回多少个空间，默认 50，上限 ${WIKI_MAX_PAGE_SIZE}（超过按上限处理）。`),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ limit }) => {
      try {
        const pageSize = clampLimit(limit, 50, WIKI_MAX_PAGE_SIZE);
        const spaces = await ctx.client.listWikiSpaces(pageSize);

        if (!spaces.length) {
          return ok(
            `知识库空间：0 个（接口正常返回，只是列表为空）。\n` +
              `这不是 bug：机器人还没被加入任何知识库，需要在知识库设置里添加此应用。\n` +
              `具体做法：打开目标知识库 → 设置 → 成员/协作者 → 添加本应用（或它所在的群），` +
              `然后用 feishu_wiki_node 传 space_id 或直接传文档链接里的 node_token 再试。\n` +
              `如果只是想找文档，也可以先用 feishu_drive_list 看云空间。`,
            { count: 0, spaces: [] },
          );
        }

        const lines: string[] = [`知识库空间共 ${spaces.length} 个：`];
        for (const s of spaces) {
          const name = s.name?.trim() || '(无名空间)';
          const type = s.spaceType?.trim();
          const desc = s.description?.trim();
          const parts = [`· ${name}　space_id=${s.spaceId || '(无)'}`];
          if (type) parts.push(`类型=${type}`);
          if (desc) parts.push(`说明=${desc}`);
          lines.push(parts.join('　'));
        }
        lines.push('');
        lines.push('下一步：把某个 space_id 传给 feishu_wiki_node 即可列出该空间的根节点。');

        return ok(lines.join('\n'), {
          count: spaces.length,
          limit: pageSize,
          spaces: spaces.map((s) => ({
            space_id: s.spaceId,
            name: s.name,
            description: s.description ?? null,
            space_type: s.spaceType ?? null,
          })),
        });
      } catch (err) {
        return fail(
          describeError(
            err,
            '列知识库空间',
            '需要在开放平台开通知识库权限（如 wiki:wiki 或 wiki:wiki:readonly），' +
              '并把应用加入对应知识库，然后重新发布版本。',
          ),
        );
      }
    },
  );

  // ───────────────────────── 知识库：节点查询 ─────────────────────────

  server.registerTool(
    'feishu_wiki_node',
    {
      title: '查知识库节点',
      description:
        '知识库节点查询：给 token 就查这个节点（node_token 或 obj_token 都行），' +
        '给 space_id 而不给 token 就列出该空间的根节点。' +
        '使用场景：从知识库链接里拿到一段 token，需要知道它对应哪篇文档/哪张表；' +
        '或者要遍历某个空间有哪些内容。' +
        '关键点：返回里的 obj_token 才是真正文档/表格的 token——读内容、读表要用 obj_token；' +
        'node_token 只用于继续在 wiki 里翻节点，传给 feishu_doc_read 会失败。' +
        '前置条件：应用需被加入该知识库并有 wiki 读权限。只读，不改节点。',
      inputSchema: {
        token: z
          .string()
          .optional()
          .describe('知识库节点的 token（node_token 或 obj_token）。给了它就直接查这一个节点。'),
        space_id: z
          .string()
          .optional()
          .describe('知识库空间 ID。只有给了 space_id 且没给 token 时，才用它列出该空间的根节点。'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ token, space_id }) => {
      try {
        const nodeToken = token?.trim() ?? '';
        const spaceId = space_id?.trim() ?? '';

        if (!nodeToken && !spaceId) {
          return fail(
            '至少给一个参数：token（查单个节点）或 space_id（列出该空间根节点）。\n' +
              '用法：feishu_wiki_node { token: "wikcn..." } 或 feishu_wiki_node { space_id: "7xxxx" }。\n' +
              '不知道 space_id 就先调 feishu_wiki_spaces。',
          );
        }

        // 有 token 优先走单节点查询（更精确）
        if (nodeToken) {
          const node = await ctx.client.getWikiNode(nodeToken);
          const note = spaceId
            ? `\n（同时给了 space_id=${spaceId}，但按优先级只按 token 查了单个节点）`
            : '';
          const lines = [
            `节点「${node.title?.trim() || '(无标题)'}」`,
            `node_token=${node.nodeToken || '(无)'}`,
            `obj_token=${node.objToken || '(无)'}　← 读内容/读表用这个`,
            `obj_type=${typeLabel(node.objType)}`,
            `space_id=${node.spaceId || '(无)'}`,
            node.parentNodeToken ? `parent_node_token=${node.parentNodeToken}` : 'parent_node_token=(根节点)',
            '',
            'WikiNode 的 objToken 才是真正文档/表格的 token：docx 文档用它调 feishu_doc_read，' +
              'bitable 用它调 feishu_bitable_tables；node_token 只用于继续翻知识库节点。',
          ];
          if (note) lines.push(note.trim());
          return ok(lines.join('\n'), {
            mode: 'node',
            node_token: node.nodeToken,
            obj_token: node.objToken,
            obj_type: node.objType,
            obj_type_label: TYPE_LABELS[node.objType ?? '']?.label ?? null,
            title: node.title,
            space_id: node.spaceId,
            parent_node_token: node.parentNodeToken ?? null,
          });
        }

        // 只有 space_id：列根节点
        const nodes = await ctx.client.listWikiNodes(spaceId, '');
        if (!nodes.length) {
          return ok(
            `空间 ${spaceId} 的根节点：0 个。\n` +
              `可能原因：空间确实为空；或应用没有被加入这个知识库（去知识库设置里添加应用），` +
              `也可能是这个 space_id 不属于当前应用可见范围。`,
            { mode: 'list', space_id: spaceId, count: 0, nodes: [] },
          );
        }

        const lines: string[] = [`空间 ${spaceId} 的根节点共 ${nodes.length} 个：`];
        for (const n of nodes) {
          const title = n.title?.trim() || '(无标题)';
          lines.push(
            `· ${title}　${typeLabel(n.objType)}　node_token=${n.nodeToken || '(无)'}　obj_token=${
              n.objToken || '(无)'
            }`,
          );
        }
        lines.push('');
        lines.push(
          '下一步：读内容用 obj_token（不是 node_token）；要往下翻子节点，把 node_token 传给 feishu_wiki_node。',
        );

        return ok(lines.join('\n'), {
          mode: 'list',
          space_id: spaceId,
          count: nodes.length,
          nodes: nodes.map((n) => ({
            node_token: n.nodeToken,
            obj_token: n.objToken,
            obj_type: n.objType,
            obj_type_label: TYPE_LABELS[n.objType ?? '']?.label ?? null,
            title: n.title,
            parent_node_token: n.parentNodeToken ?? null,
          })),
        });
      } catch (err) {
        return fail(
          describeError(
            err,
            '查知识库节点',
            '需要在开放平台开通知识库权限（如 wiki:wiki 或 wiki:wiki:readonly），' +
              '并确认应用已被加入该知识库，然后重新发布版本。',
          ),
        );
      }
    },
  );

  // ───────────────────────── 电子表格：读单元格 ─────────────────────────

  server.registerTool(
    'feishu_sheet_read',
    {
      title: '读电子表格单元格',
      description:
        '按 A1 区间读一个电子表格的值，返回二维数组（行 × 列）。' +
        '区间写法：Sheet1!A1:D20（带表名更稳），或 A1:D20（默认第一个工作表）。' +
        '读整列可以用 Sheet1!A:A。' +
        '只能读值和公式结果，读不到样式、批注、合并单元格信息。' +
        '配合 feishu_sheet_create 新建表；写入目前没有开放（飞书的写入接口要求先拿到 sheet_id，' +
        '需要先读一次拿元数据，暂未支持）。',
      inputSchema: {
        spreadsheet_token: z
          .string()
          .min(1)
          .describe('电子表格的 token（sheet 链接里 /sheets/ 后面那串）'),
        range: z
          .string()
          .min(1)
          .describe('A1 区间，如 "Sheet1!A1:D20" 或 "A1:D20"；整列写 "Sheet1!A:A"'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ spreadsheet_token, range }) => {
      try {
        const token = spreadsheet_token.trim();
        const rng = range.trim();
        const res = await ctx.client.readSheetValues(token, rng);
        const rows = Array.isArray(res.values) ? res.values : [];
        if (!rows.length) {
          return ok(`区间 ${res.range || rng} 是空的（没有任何值）。`, {
            spreadsheet_token: token,
            range: res.range || rng,
            rows: 0,
          });
        }

        const lines = [
          `区间 ${res.range || rng}：共 ${rows.length} 行`,
          '',
          ...rows.slice(0, 60).map((row, i) => {
            const cells = (Array.isArray(row) ? row : []).map((c) =>
              c === null || c === undefined ? '' : String(c),
            );
            return `${i + 1}｜${cells.join(' ｜ ')}`;
          }),
        ];
        if (rows.length > 60) lines.push(`（只列了前 60 行，共 ${rows.length} 行）`);

        return ok(lines.join('\n'), {
          spreadsheet_token: token,
          range: res.range || rng,
          rows: rows.length,
          values: rows.slice(0, 200),
        });
      } catch (err) {
        return fail(
          describeError(
            err,
            '读电子表格',
            '需要在开放平台开通表格权限（如 sheets:spreadsheet:readonly 或 sheets:spreadsheet），' +
              '并确认应用对该表格有访问权限（文档需要共享给应用或放在应用可访问的空间）。',
          ),
        );
      }
    },
  );

  // ───────────────────────── 文档：读结构化块 ─────────────────────────

  server.registerTool(
    'feishu_doc_blocks',
    {
      title: '读文档结构化块',
      description:
        '按块（block）读一篇云文档的结构：每块有 block_id、block_type 与内容。' +
        '和 feishu_doc_read 的区别：doc_read 给的是拼接好的纯文本，适合通读；' +
        'doc_blocks 保留段落/标题/表格/图片块的分块结构，适合定位「第几段」「哪个表格」' +
        '以及后续按 block_id 做精细操作。' +
        '飞书文档的块类型是数字编码（如 2=文本、3-11=各级标题、31=表格），' +
        '本工具会把能识别的文字内容抽出来，识别不了的块只给类型码。',
      inputSchema: {
        document_id: z
          .string()
          .min(1)
          .describe('文档 id（docx 链接里 /docx/ 后面那串，不是整个 URL）'),
        page_size: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe('每页块数，默认 200，最大 500'),
        max_pages: z
          .number()
          .int()
          .min(1)
          .max(10)
          .optional()
          .describe('最多翻几页，默认 3（防止超大文档一次拉爆）'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ document_id, page_size, max_pages }) => {
      try {
        const docId = document_id.trim();
        const size = page_size ?? 200;
        const pages = max_pages ?? 3;

        const items: Array<Record<string, unknown>> = [];
        let pageToken: string | undefined;
        let hasMore = false;
        for (let i = 0; i < pages; i += 1) {
          const res = await ctx.client.listDocumentBlocks(docId, {
            pageSize: size,
            pageToken,
          });
          items.push(...(res.items ?? []));
          hasMore = res.hasMore;
          pageToken = res.pageToken;
          if (!hasMore || !pageToken) break;
        }

        if (!items.length) return ok(`文档 ${docId} 没有任何块（可能是空文档）。`, { blocks: 0 });

        const lines = [`文档 ${docId}：共取到 ${items.length} 个块${hasMore ? '（还有更多页）' : ''}`, ''];
        for (const b of items.slice(0, 120)) {
          const type = Number(b.block_type ?? 0);
          const text = extractBlockText(b);
          lines.push(text ? `${type}｜${text}` : `${type}｜(无文字内容)`);
        }
        if (items.length > 120) lines.push(`（只列了前 120 块，共 ${items.length} 块）`);

        return ok(lines.join('\n'), {
          document_id: docId,
          blocks: items.length,
          has_more: hasMore,
          items: items.slice(0, 200),
        });
      } catch (err) {
        return fail(
          describeError(
            err,
            '读文档块',
            '需要在开放平台开通文档权限（如 docx:document:readonly 或 docx:document），' +
              '并确认应用对该文档有访问权限。',
          ),
        );
      }
    },
  );

  // ───────────────────────── 通讯录：查人 ─────────────────────────

  server.registerTool(
    'feishu_user_lookup',
    {
      title: '查飞书用户',
      description:
        '用邮箱、手机号或 open_id 查飞书用户，返回 open_id 与名字。' +
        '使用场景：手上只有同事邮箱/手机号，需要 open_id 才能私聊或 @ 他；' +
        '或者拿到 open_id 后想确认这人是谁。' +
        '用法优先级：给了 open_id 就查这一个人的详情（名字、邮箱、手机号最全）；' +
        '否则按 emails / mobiles 批量查（两个都给会各查一次）；都不给会直接报错说明用法。' +
        '重要：查到记录但 open_id 为空，说明该邮箱/手机号不在本企业通讯录（或不在应用可见范围内），' +
        '这不是 bug，也不能拿它当发送目标。' +
        '拿到 open_id 后可以直接作为 feishu_send_text 的 target 单聊这个人。' +
        '前置条件：应用需要通讯录权限（如 contact:user.id:readonly），且用户在应用可见范围内。只读。',
      inputSchema: {
        emails: z.array(z.string()).optional().describe('要查的邮箱列表（批量），例如 ["a@b.com"]。'),
        mobiles: z.array(z.string()).optional().describe('要查的手机号列表（批量），带不带 +86 都试一下。'),
        open_id: z
          .string()
          .optional()
          .describe('已知 open_id（ou_ 开头）时直接查单个用户详情，优先级最高，给了就不走批量查询。'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ emails, mobiles, open_id }) => {
      try {
        const openId = open_id?.trim() ?? '';

        // ── 分支一：open_id 直查详情 ──
        if (openId) {
          const user = await ctx.client.getUser(openId);
          const lines = [
            `用户：${user.name?.trim() || '(名字为空，可能是可见范围限制)'}`,
            `open_id=${user.openId || openId}`,
          ];
          if (user.enName?.trim()) lines.push(`英文名=${user.enName.trim()}`);
          if (user.email?.trim()) lines.push(`邮箱=${user.email.trim()}`);
          if (user.mobile?.trim()) lines.push(`手机号=${user.mobile.trim()}`);
          lines.push('');
          lines.push('提示：这个 open_id 可以直接作为 feishu_send_text 的 target 单聊此人。');
          return ok(lines.join('\n'), {
            mode: 'open_id',
            count: 1,
            users: [
              {
                open_id: user.openId || openId,
                name: user.name ?? null,
                en_name: user.enName ?? null,
                email: user.email ?? null,
                mobile: user.mobile ?? null,
              },
            ],
          });
        }

        const emailList = (emails ?? []).map((e) => e.trim()).filter(Boolean);
        const mobileList = (mobiles ?? []).map((m) => m.trim()).filter(Boolean);

        // ── 分支二：什么都不给 ──
        if (!emailList.length && !mobileList.length) {
          return fail(
            '没有可查的条件：emails、mobiles、open_id 三者都是空的。\n' +
              '用法示例：\n' +
              '  feishu_user_lookup { emails: ["someone@company.com"] }\n' +
              '  feishu_user_lookup { mobiles: ["13800138000"] }\n' +
              '  feishu_user_lookup { open_id: "ou_xxx" }\n' +
              '已经有 open_id 的话直接给 open_id，能拿到最全的详情。',
          );
        }

        // ── 分支三：按邮箱 / 手机号批量查 ──
        const results: Array<{
          query_type: 'email' | 'mobile';
          query: string;
          open_id: string | null;
          name: string | null;
          found_without_id: boolean;
        }> = [];
        const sections: string[] = [];
        let withId = 0;
        let withoutId = 0;

        if (emailList.length) {
          const users = await ctx.client.lookupUsersByEmail(emailList);
          sections.push(...renderBatch('邮箱', emailList, users, results, 'email'));
        }
        if (mobileList.length) {
          const users = await ctx.client.lookupUsersByMobile(mobileList);
          sections.push(
            ...renderBatch('手机号', mobileList, users, results, 'mobile'),
          );
        }

        for (const r of results) {
          if (r.open_id) withId += 1;
          else withoutId += 1;
        }

        const header = [
          `查人结果：请求 ${emailList.length + mobileList.length} 个条件，` +
            `其中 ${withId} 个拿到了 open_id，${withoutId} 个查到了但 open_id 为空。`,
        ];
        const tail = [
          '',
          '说明：open_id 为空的条目表示该邮箱/手机号查到了记录但不在本企业通讯录' +
            '（或不在应用可见范围），这不是 bug，也不能当发送目标用。',
          '提示：拿到 open_id 后可以作为 feishu_send_text 的 target 直接单聊。' +
            '如果某个邮箱完全没出现在结果里，说明飞书对该条件没有返回任何记录。',
        ];

        return ok([...header, ...sections, ...tail].join('\n'), {
          mode: 'batch',
          requested: emailList.length + mobileList.length,
          with_open_id: withId,
          without_open_id: withoutId,
          results,
        });
      } catch (err) {
        return fail(
          describeError(
            err,
            '查用户',
            '需要在开放平台开通通讯录权限（如 contact:user.id:readonly / contact:user.base:readonly），' +
              '并确认目标用户在应用可见范围内，然后重新发布版本。',
          ),
        );
      }
    },
  );

  // ───────────────────────── 电子表格：工作表清单 ─────────────────────────

  server.registerTool(
    'feishu_sheet_meta',
    {
      title: '看电子表格有哪些工作表',
      description:
        '列出表格里每个工作表的 sheet_id、标题、行列数。' +
        '写值前先看这个：飞书的写入接口要 sheet_id，而表格链接里给的是 spreadsheet_token，两者不是一回事。' +
        'feishu_sheet_write 不带 sheet 前缀时会自动取第一个工作表，所以简单场景可以跳过这一步。',
      inputSchema: {
        spreadsheet_token: z.string().min(1).describe('电子表格 token（链接里 /sheets/ 后面那串）。'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ spreadsheet_token }) => {
      try {
        const token = spreadsheet_token.trim();
        const sheets = await ctx.client.listSheetMeta(token);
        if (!sheets.length) return ok(`表格 ${token} 里没有工作表（或应用看不到）。`, { sheets: [] });
        const lines = sheets.map(
          (s, i) =>
            `${i + 1}. ${s.title}　sheet_id=${s.sheetId}　${s.rowCount} 行 × ${s.colCount} 列`,
        );
        return ok(`表格 ${token} 有 ${sheets.length} 个工作表：\n${lines.join('\n')}`, { sheets });
      } catch (err) {
        return fail(
          describeError(
            err,
            '看工作表',
            '需要在开放平台开通 sheets:spreadsheet 权限，并确认应用对该表格有访问权限。',
          ),
        );
      }
    },
  );

  // ───────────────────────── 电子表格：写值 ─────────────────────────

  server.registerTool(
    'feishu_sheet_write',
    {
      title: '往电子表格写值 / 追加行',
      description:
        '把二维数组写进表格。range 写 "Sheet1!A1:B2"（带表名）或只写 "A1:B2"（默认第一个工作表）。' +
        'mode=overwrite 覆盖区间内原有的值；mode=append 接在已有数据末尾往下追加（不覆盖）。' +
        'values 是行 × 列：[[1,"甲"],[2,"乙"]] 表示两行两列。空字符串写空格，null 会留空。' +
        '只写值，改不了样式、合并单元格、公式（写进去的字符串会被当文本）。',
      inputSchema: {
        spreadsheet_token: z.string().min(1).describe('电子表格 token。'),
        range: z.string().min(1).describe('A1 区间，如 "Sheet1!A1:B2" 或 "A1:B2"。'),
        values: z
          .array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])))
          .min(1)
          .describe('二维数组：外层是行，内层是列。'),
        mode: z
          .enum(['overwrite', 'append'])
          .optional()
          .describe('overwrite 覆盖（默认），append 追加到已有数据末尾。'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ spreadsheet_token, range, values, mode }) => {
      try {
        const token = spreadsheet_token.trim();
        let rng = range.trim();
        if (!rng.includes('!')) {
          const sheets = await ctx.client.listSheetMeta(token);
          const first = sheets[0];
          if (!first) return fail(`表格 ${token} 里没有工作表，先 feishu_sheet_meta 看一眼。`);
          rng = `${first.title}!${rng}`;
        }
        const useAppend = (mode ?? 'overwrite') === 'append';
        const res = useAppend
          ? await ctx.client.appendSheetValues(token, rng, values)
          : await ctx.client.writeSheetValues(token, rng, values);
        const rows = values.length;
        const cols = values.reduce((m, r) => Math.max(m, r.length), 0);
        ctx.log('feishu_sheet_write', { rng, rows, cols, append: useAppend });
        return ok(
          `已${useAppend ? '追加' : '写入'} ${rows} 行 × ${cols} 列到 ${res.updatedRange || rng}` +
            `（实际更新 ${res.updatedCells} 个单元格）。`,
          {
            spreadsheet_token: token,
            range: res.updatedRange || rng,
            mode: useAppend ? 'append' : 'overwrite',
            updated_cells: res.updatedCells,
          },
        );
      } catch (err) {
        return fail(
          describeError(
            err,
            '写表格',
            '需要 sheets:spreadsheet 权限，且应用对该表格有编辑权限（共享给应用或放进可访问空间）。',
          ),
        );
      }
    },
  );

  // ───────────────────────── 文档：追加正文 ─────────────────────────

  server.registerTool(
    'feishu_doc_append',
    {
      title: '往文档末尾追加正文',
      description:
        '在已有文档最后追加若干段落（每个字符串一段）。配合 feishu_doc_create 建空文档后往里写。' +
        '只能追加纯文本段落：加粗、表格、图片、标题层级这些富文本结构目前不支持。' +
        '要改文档中间的内容请用 feishu_doc_blocks 找到块再处理（尚未开放块级编辑）。',
      inputSchema: {
        document_id: z.string().min(1).describe('文档 id（docx 链接里 /docx/ 后面那串）。'),
        paragraphs: z
          .array(z.string())
          .min(1)
          .describe('要追加的段落，每个元素一段；空字符串会写成空行。'),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ document_id, paragraphs }) => {
      try {
        const id = document_id.trim();
        const res = await ctx.client.appendDocumentText(id, paragraphs);
        ctx.log('feishu_doc_append', { id, blocks: res.blocks });
        return ok(`已往文档 ${id} 末尾追加 ${res.blocks} 段。`, {
          document_id: id,
          blocks: res.blocks,
        });
      } catch (err) {
        return fail(
          describeError(
            err,
            '追加文档正文',
            '需要 docx:document 权限（写权限），且应用对该文档有编辑权限。',
          ),
        );
      }
    },
  );

  // ───────────────────────── 云空间：权限成员 ─────────────────────────

  server.registerTool(
    'feishu_permission_member',
    {
      title: '文档/文件夹的协作者（加人、看谁有权限、移除）',
      description:
        '管云文档的协作者。action=add 把一个人加进协作者（perm=view 可读 / edit 可编辑 / full_access 可管理）；' +
        'action=list 看现在有哪些人、各自什么权限；action=remove 移除一个人。' +
        'member_type=openid 时 member_id 传 open_id（ou_ 开头），先 feishu_user_lookup 拿到。' +
        '注意 token 是云文档 token，不是消息附件。',
      inputSchema: {
        action: z.enum(['add', 'list', 'remove']).describe('add 加人、list 看权限、remove 移除。'),
        token: z.string().min(1).describe('云文档/文件夹 token。'),
        type: z
          .enum(['docx', 'doc', 'sheet', 'bitable', 'file', 'folder', 'mindnote', 'slides'])
          .optional()
          .describe('资源类型，默认 docx。'),
        member_type: z
          .enum(['openid', 'openchat', 'userid', 'email', 'opendepartmentid'])
          .optional()
          .describe('action=add/remove 时用，默认 openid。'),
        member_id: z.string().optional().describe('action=add/remove 时用：对方的 open_id 等。'),
        perm: z
          .enum(['view', 'edit', 'full_access'])
          .optional()
          .describe('action=add 时的权限，默认 view。'),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ action, token, type, member_type, member_id, perm }) => {
      try {
        const tk = token.trim();
        const resType = type ?? 'docx';

        if (action === 'list') {
          const items = await ctx.client.listPermissionMembers(tk, resType);
          if (!items.length) return ok(`资源 ${tk} 目前没有协作者（只有所有者）。`, { items: [] });
          const lines = items.map(
            (it, i) => `${i + 1}. ${it.memberType} ${it.memberId}　${it.perm}`,
          );
          return ok(`资源 ${tk} 有 ${items.length} 个协作者：\n${lines.join('\n')}`, { items });
        }

        const mid = (member_id ?? '').trim();
        if (!mid) return fail(`action=${action} 需要 member_id。`);
        const mtype = member_type ?? 'openid';

        if (action === 'add') {
          const usePerm = perm ?? 'view';
          await ctx.client.addPermissionMember(tk, resType, mtype, mid, usePerm);
          return ok(`已把 ${mid} 加为 ${tk} 的协作者（${usePerm}）。`, {
            token: tk,
            member_id: mid,
            perm: usePerm,
          });
        }

        await ctx.client.deletePermissionMember(tk, resType, mid, mtype);
        return ok(`已把 ${mid} 从 ${tk} 的协作者里移除。`, { token: tk, member_id: mid });
      } catch (err) {
        return fail(
          describeError(
            err,
            '协作者管理',
            '需要 drive:drive 权限，且机器人对该文档有管理权限（full_access）。',
          ),
        );
      }
    },
  );
}

/**
 * 把一批邮箱/手机号查询结果渲染成文本行，同时把结构化数据塞进 results。
 * 单独抽出来是因为邮箱和手机号两条路径的展示逻辑完全一样。
 */
function renderBatch(
  label: '邮箱' | '手机号',
  queries: string[],
  users: Array<{ openId: string; name?: string; email?: string; mobile?: string }>,
  results: Array<{
    query_type: 'email' | 'mobile';
    query: string;
    open_id: string | null;
    name: string | null;
    found_without_id: boolean;
  }>,
  queryType: 'email' | 'mobile',
): string[] {
  const lines: string[] = [`按${label}查（请求 ${queries.length} 个，返回 ${users.length} 条）：`];

  if (!users.length) {
    lines.push(`　（飞书没有返回任何记录：这些${label}都不在本企业通讯录，或应用看不到）`);
    return lines;
  }

  for (const u of users) {
    const who = (queryType === 'email' ? u.email : u.mobile)?.trim() || '(飞书未回填原始值)';
    const name = u.name?.trim() || '(名字为空)';
    const id = u.openId?.trim() ?? '';
    if (id) {
      lines.push(`· ${who} → ${name}　open_id=${id}`);
      results.push({
        query_type: queryType,
        query: who,
        open_id: id,
        name: u.name ?? null,
        found_without_id: false,
      });
    } else {
      lines.push(
        `· ${who} → 查到了记录，但 open_id 为空（不在本企业通讯录/不可见范围），名字=${name}`,
      );
      results.push({
        query_type: queryType,
        query: who,
        open_id: null,
        name: u.name ?? null,
        found_without_id: true,
      });
    }
  }

  const missing = queries.filter(
    (q) =>
      !users.some((u) => {
        const v = (queryType === 'email' ? u.email : u.mobile)?.trim();
        return v === q;
      }),
  );
  if (missing.length) {
    lines.push(`　没查到记录的${label}：${missing.join('、')}（飞书未返回，可能是通讯录里没有这个人）`);
  }

  return lines;
}
