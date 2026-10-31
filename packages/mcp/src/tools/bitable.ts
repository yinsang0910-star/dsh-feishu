/**
 * 多维表格（bitable / Base）+ 电子表格（sheets）工具。
 *
 * 这一组解决"读得懂表、写得进表"：
 *  - feishu_bitable_tables   —— 一张 Base 里有哪些数据表（拿 table_id）
 *  - feishu_bitable_fields   —— 某张表的字段定义 + 类型码 + 写入形态（决定 fields 该怎么写）
 *  - feishu_bitable_records  —— 查记录（带 record_id，后面改/删要用）
 *  - feishu_bitable_add      —— 新增记录
 *  - feishu_bitable_update   —— 更新记录
 *  - feishu_sheet_create     —— 新建一张电子表格
 *
 * 约定（见 docs/TOOL-CONTRACT.md）：
 *  - stdout 是 MCP 的 JSON-RPC 通道，本文件绝不写 stdout，要日志走 ctx.log；
 *  - 每个 handler 整体 try/catch，异常一律变成 fail(...)，不向上抛；
 *  - 权限错误必须把 err.missingScopes 原样给模型，否则用户不知道去开放平台开什么；
 *  - 数据以飞书实际返回为准：没返回就不显示，不补默认值、不猜字段。
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { FeishuApiError } from '@yisang0910/core';
import { ok, fail, type ToolContext } from './types.js';

// ───────────────────────── 常量 ─────────────────────────

/** bitable 查询记录接口的单页上限（飞书服务端硬限制） */
const MAX_RECORD_PAGE = 500;
/** 不传 limit 时的默认页大小 */
const DEFAULT_RECORD_LIMIT = 50;

interface FieldTypeMeta {
  /** 类型码对应的中文名 */
  label: string;
  /** 写记录时这个字段该传什么形态的值 */
  form: string;
}

/**
 * 飞书多维表格字段类型码 → 中文名 + 写入形态。
 * 模型拿到 feishu_bitable_fields 的结果后，靠这张表决定 fields 里每个键传什么。
 */
const FIELD_TYPES: Record<number, FieldTypeMeta> = {
  1: { label: '文本', form: '字符串，如 "张三"' },
  2: { label: '数字', form: '数字（number），如 42 / 3.14' },
  3: { label: '单选', form: '选项名字符串（必须已存在于该字段的选项里），如 "进行中"' },
  4: { label: '多选', form: '选项名字符串数组，如 ["A", "B"]' },
  5: { label: '日期', form: '毫秒时间戳（number），如 1700000000000' },
  7: { label: '复选框', form: '布尔值 true / false' },
  11: { label: '人员', form: '数组，如 [{"id": "ou_xxx"}]（id 用 open_id/user_id）' },
  13: { label: '电话', form: '字符串，如 "13800000000"' },
  15: { label: '超链接', form: '对象 {"link": "https://...", "text": "显示文字"}' },
  17: { label: '附件', form: '数组，如 [{"file_token": "box_xxx"}]（先上传附件拿 token）' },
  18: { label: '单向关联', form: '被关联记录的 record_id 字符串数组，如 ["recxxx"]' },
  20: { label: '公式', form: '只读，写入会被忽略' },
  21: { label: '双向关联', form: '被关联记录的 record_id 字符串数组，如 ["recxxx"]' },
  22: { label: '地理位置', form: '对象 {"location": "经度,纬度", "pname": "省", "cityname": "市"} 等' },
  23: { label: '群组', form: '字符串数组（群组 open_chat_id 或群组 id）' },
  1001: { label: '创建时间', form: '只读，写入会被忽略' },
  1002: { label: '最后更新时间', form: '只读，写入会被忽略' },
  1003: { label: '创建人', form: '只读，写入会被忽略' },
  1004: { label: '修改人', form: '只读，写入会被忽略' },
  1005: { label: '自动编号', form: '只读，写入会被忽略' },
};

// ───────────────────────── 小工具 ─────────────────────────

/** 把任意异常翻译成一句人能照着修的话；权限错误必须给出缺失的 scope */
function describeError(err: unknown, action: string): string {
  if (err instanceof FeishuApiError) {
    if (err.isPermission) {
      return (
        `${action}失败：权限不足，需要在开放平台给应用开通权限：` +
        `${err.missingScopes.join(', ') || '(飞书没在错误里返回具体 scope，请到应用权限页确认 bitable:app 相关权限)'}` +
        `\n（原始错误：code=${err.code} ${err.message}）`
      );
    }
    return `${action}失败：code=${err.code} ${err.message}`;
  }
  return `${action}失败：${err instanceof Error ? err.message : String(err)}`;
}

/** 类型码查表；未知类型码老实说不知道，不硬编成"文本" */
function fieldTypeMeta(type: number): FieldTypeMeta {
  const meta = FIELD_TYPES[type];
  if (meta) return meta;
  return {
    label: `未收录的类型码 ${type}`,
    form: '飞书原始 JSON 形态；写入前建议先用本工具的返回值确认字段名，再小批量试写一条',
  };
}

/** 把 limit 收进 [1, MAX_RECORD_PAGE]，非法值退回默认值 */
function clampPageSize(raw: number | undefined): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_RECORD_LIMIT;
  const n = Math.trunc(raw);
  if (n < 1) return 1;
  return n > MAX_RECORD_PAGE ? MAX_RECORD_PAGE : n;
}

/** 有界 JSON 预览，避免一个畸形单元格把整段输出撑爆 */
function safeJson(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    if (typeof text !== 'string') return String(value);
    return text.length > 300 ? `${text.slice(0, 300)}…` : text;
  } catch {
    return '(无法序列化)';
  }
}

/**
 * 单元格值 → 人话。
 * 飞书一个格子的真实形态五花八门：文本段数组、人员对象数组、附件数组、超链接对象……
 * 这里只做"能读懂"的展开，不改造数据本身。
 */
function renderCell(value: unknown): string {
  if (value === null || value === undefined) return '（空）';
  if (typeof value === 'string') return value.trim() ? value : '（空字符串）';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '（非法数字）';
  if (typeof value === 'boolean') return value ? 'true' : 'false';

  if (Array.isArray(value)) {
    const parts = value.map(renderCell).filter((s) => s !== '（空）' && s !== '（空字符串）');
    return parts.length ? parts.join('、') : '（空）';
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;

    // 文本段 / 公式 / 电话 / 超链接：{"type":"text","text":"...","link":"..."}
    const text = obj['text'];
    if (typeof text === 'string') {
      const link = obj['link'];
      if (typeof link === 'string' && link && link !== text) return `${text}（${link}）`;
      return text || '（空字符串）';
    }
    // 人员 / 附件 / 选项：{"name":"张三"}
    const name = obj['name'];
    if (typeof name === 'string' && name) return name;
    // 人员 / 关联：{"id":"ou_xxx"} / {"record_ids":[...]}
    const id = obj['id'];
    if (typeof id === 'string' && id) return id;
    const recordIds = obj['record_ids'];
    if (Array.isArray(recordIds)) return renderCell(recordIds);
    // 超链接兜底
    const link = obj['link'];
    if (typeof link === 'string' && link) return link;
    // 位置：{"location":"120.1,30.2","address":"..."}
    const address = obj['address'];
    if (typeof address === 'string' && address) return address;
    // 兜底层：{value: [...]} 这类包装
    if ('value' in obj) return renderCell(obj['value']);
    return `（对象）${safeJson(obj)}`;
  }

  return String(value);
}

/** 一条记录的字段 → 缩进好的多行文本；字段名原样保留（写入时要按它当 key） */
function renderRecordFields(fields: Record<string, unknown>): string[] {
  const keys = Object.keys(fields);
  if (!keys.length) return ['　（这条记录没有任何字段值）'];
  return keys.map((key) => `　${key}：${renderCell(fields[key])}`);
}

// ───────────────────────── 注册 ─────────────────────────

export function registerBitableTools(server: McpServer, ctx: ToolContext): void {
  // ───────────────────────── 1. 数据表列表 ─────────────────────────

  server.registerTool(
    'feishu_bitable_tables',
    {
      title: '多维表格里的数据表',
      description:
        '列出一张飞书多维表格（Base）里包含哪些数据表，返回每张表的 table_id 与表名。' +
        '**这是所有 bitable 操作的入口**：后续查字段、查记录、加记录都要 table_id，' +
        '而 table_id 只能从这里拿到（用户一般只给 app_token 或一条 Base 链接）。' +
        'app_token 就是 Base 链接里 /base/ 后面那一串（如 HMr9bcTJcabU8KsD6UGcwVWln9e）。' +
        '只返回文本，不修改任何数据，可放心在探索阶段调用。' +
        '不适合：已有 table_id 只是要看字段（用 feishu_bitable_fields）；要看记录内容（用 feishu_bitable_records）。',
      inputSchema: {
        app_token: z
          .string()
          .min(1)
          .describe('多维表格的 app_token（Base 链接里 /base/ 后面那串，形如 HMr9bcTJcabU8KsD6UGcwVWln9e）'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ app_token }) => {
      try {
        const appToken = app_token.trim();
        const tables = await ctx.client.listBitableTables(appToken);

        if (!tables.length) {
          return ok(
            `多维表格 ${appToken} 里的数据表（0 个）：\n` +
              `没有取到任何数据表。常见原因：app_token 不对、应用没被加进这张 Base（或没给文档授权），` +
              `或者这张 Base 里确实还没有数据表。`,
            { app_token: appToken, count: 0, tables: [] },
          );
        }

        const lines: string[] = [`多维表格 ${appToken} 里的数据表（${tables.length} 个）：`];
        for (const table of tables) {
          const name = table.name?.trim() || '(无名表)';
          lines.push(`· ${name}　table_id=${table.tableId || '(飞书没返回 table_id)'}`);
        }
        lines.push('');
        lines.push(
          '下一步：拿 table_id 调 feishu_bitable_fields 看字段（决定加记录时 fields 怎么写），' +
            '或调 feishu_bitable_records 看现有记录。',
        );

        return ok(lines.join('\n'), {
          app_token: appToken,
          count: tables.length,
          tables: tables.map((t) => ({ table_id: t.tableId, name: t.name || null })),
        });
      } catch (err) {
        return fail(describeError(err, '列数据表'));
      }
    },
  );

  // ───────────────────────── 2. 字段定义 ─────────────────────────

  server.registerTool(
    'feishu_bitable_fields',
    {
      title: '数据表的字段定义',
      description:
        '列出某个数据表的全部字段：字段名、field_id、**类型码 + 中文类型名**，以及这个字段写入时该传的值形态。' +
        '**新增/更新记录之前先调这个**：飞书不同字段类型吃的 JSON 形态完全不同' +
        '（文本传字符串、日期传毫秒时间戳、人员传 [{"id":"ou_xxx"}]、附件传 [{"file_token":"box_xxx"}]），' +
        '先看类型码再写 fields，能避免 1254001 / 1254045 之类的字段校验报错。' +
        '字段名就是 feishu_bitable_add / feishu_bitable_update 里 fields 的 key，必须一字不差。' +
        '只返回文本，不修改数据。',
      inputSchema: {
        app_token: z.string().min(1).describe('多维表格的 app_token（Base 链接里 /base/ 后面那串）'),
        table_id: z
          .string()
          .min(1)
          .describe('数据表 id（形如 tbliz1PrMZkp1DSN）。不知道就先调 feishu_bitable_tables。'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ app_token, table_id }) => {
      try {
        const appToken = app_token.trim();
        const tableId = table_id.trim();
        const fields = await ctx.client.listBitableFields(appToken, tableId);

        if (!fields.length) {
          return ok(
            `表 ${tableId} 的字段（0 个）：\n` +
              `没有取到任何字段。常见原因：table_id 不对、表刚建还没加列，或应用没有这张 Base 的读权限。`,
            { app_token: appToken, table_id: tableId, count: 0, fields: [] },
          );
        }

        const lines: string[] = [`表 ${tableId} 的字段（${fields.length} 个）：`];
        const structured: Array<Record<string, unknown>> = [];

        for (const field of fields) {
          const meta = fieldTypeMeta(field.type);
          const name = field.name?.trim() || '(无名字段)';
          lines.push(`· ${name}　类型 ${field.type}（${meta.label}）　field_id=${field.fieldId || '(无)'}`);
          lines.push(`　　写入形态：${meta.form}`);
          structured.push({
            field_id: field.fieldId,
            name: field.name,
            type: field.type,
            type_label: meta.label,
            value_form: meta.form,
          });
        }

        lines.push('');
        lines.push('类型码对照（1=文本 2=数字 3=单选 4=多选 5=日期 7=复选框 11=人员 13=电话');
        lines.push('15=超链接 17=附件 18=单向关联 20=公式 21=双向关联 22=地理位置 23=群组');
        lines.push('1001=创建时间 1002=最后更新时间 1003=创建人 1004=修改人 1005=自动编号）');
        lines.push('');
        lines.push(
          '加记录时 fields 的 key 用上面的字段名（不是 field_id）：' +
            '如 {"名称":"周报","状态":"进行中","截止日期":1700000000000}。' +
            '1001~1005 与公式字段是只读的，别往里写。',
        );

        return ok(lines.join('\n'), {
          app_token: appToken,
          table_id: tableId,
          count: fields.length,
          fields: structured,
          type_legend: FIELD_TYPES,
        });
      } catch (err) {
        return fail(describeError(err, '列字段'));
      }
    },
  );

  // ───────────────────────── 3. 查询记录 ─────────────────────────

  server.registerTool(
    'feishu_bitable_records',
    {
      title: '查询多维表格记录',
      description:
        '读取某个数据表里的记录，每条都带 record_id，并把字段值展开成人话（人员显示名字、附件显示文件名、' +
        '多选用顿号连接、日期显示原始毫秒值）。' +
        '适合：核对数据、找要改的那条记录（先查到 record_id 再 update）、给用户汇报表里有什么。' +
        'record_id 是更新记录的唯一凭据，所以查询结果里一定会带上。' +
        'limit 默认 50、最大 500；has_more=true 时把返回的 page_token 传回来继续翻页。' +
        '只返回文本，不修改数据。',
      inputSchema: {
        app_token: z.string().min(1).describe('多维表格的 app_token（Base 链接里 /base/ 后面那串）'),
        table_id: z
          .string()
          .min(1)
          .describe('数据表 id（形如 tbliz1PrMZkp1DSN）。不知道就先调 feishu_bitable_tables。'),
        limit: z
          .number()
          .int()
          .optional()
          .describe(
            `本页最多返回多少条记录，默认 ${DEFAULT_RECORD_LIMIT}，上限 ${MAX_RECORD_PAGE}（超过按 ${MAX_RECORD_PAGE} 处理）。`,
          ),
        page_token: z
          .string()
          .optional()
          .describe('翻页令牌：上一次返回 has_more=true 时给出的 page_token，原样传回来取下一页。'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ app_token, table_id, limit, page_token }) => {
      try {
        const appToken = app_token.trim();
        const tableId = table_id.trim();
        const pageSize = clampPageSize(limit);
        const pageToken = page_token?.trim();

        const result = await ctx.client.listBitableRecords(appToken, tableId, {
          pageSize,
          ...(pageToken ? { pageToken } : {}),
        });

        if (!result.items.length) {
          const tail = pageToken ? `（page_token=${pageToken} 这一页为空）` : '';
          return ok(`表 ${tableId} 的记录（0 条）${tail}：\n表里没有记录，或这一页已经翻到底了。`, {
            app_token: appToken,
            table_id: tableId,
            count: 0,
            has_more: result.hasMore,
            page_token: result.pageToken ?? null,
            records: [],
          });
        }

        const lines: string[] = [
          `表 ${tableId} 的记录（本页 ${result.items.length} 条${result.hasMore ? '，还有更多' : '，已到底'}）：`,
        ];
        const structured: Array<Record<string, unknown>> = [];

        result.items.forEach((record, index) => {
          lines.push(`${index + 1}. record_id=${record.recordId || '(飞书没返回 record_id)'}`);
          lines.push(...renderRecordFields(record.fields ?? {}));
          structured.push({
            record_id: record.recordId,
            fields: record.fields ?? {},
          });
        });

        if (result.hasMore) {
          lines.push('');
          lines.push(
            `（还有更多记录：把 page_token="${result.pageToken ?? ''}" 一起传回来继续翻页）` +
              '—— 没有 page_token 时把 limit 调大再查。',
          );
        } else if (result.items.length >= pageSize) {
          lines.push('');
          lines.push(`（本页取满 ${pageSize} 条且已到底；要更多就调大 limit，上限 ${MAX_RECORD_PAGE}）`);
        }

        return ok(lines.join('\n'), {
          app_token: appToken,
          table_id: tableId,
          count: result.items.length,
          limit: pageSize,
          has_more: result.hasMore,
          page_token: result.pageToken ?? null,
          records: structured,
        });
      } catch (err) {
        return fail(describeError(err, '查记录'));
      }
    },
  );

  // ───────────────────────── 4. 新增记录 ─────────────────────────

  server.registerTool(
    'feishu_bitable_add',
    {
      title: '新增多维表格记录',
      description:
        '往某个数据表里新增一条记录，返回 record_id（后续更新要用）。' +
        '**这是写操作，会真的改用户的表**：不确定字段名和类型时，先调 feishu_bitable_fields 看定义、' +
        'feishu_bitable_records 看现有数据的写法，别凭猜写。' +
        'fields 的 key 必须是字段名（不是 field_id），值形态要匹配字段类型：' +
        '文本传字符串、数字传数字、日期传毫秒时间戳、单选传选项字符串、' +
        '多选/人员/附件/关联传数组。' +
        '适合：把对话里的结论、待办、采集到的数据落进表。不适合：批量导入几百条（逐条调用会很慢）。',
      inputSchema: {
        app_token: z.string().min(1).describe('多维表格的 app_token（Base 链接里 /base/ 后面那串）'),
        table_id: z.string().min(1).describe('要写入的数据表 id（形如 tbliz1PrMZkp1DSN）'),
        fields: z
          .record(z.string(), z.unknown())
          .describe(
            '字段名 → 值。key 用字段名（不是 field_id），值形态必须匹配字段类型：' +
              '文本传字符串（"张三"）、数字传数字（42）、日期传毫秒时间戳（1700000000000）、' +
              '单选传选项字符串（"进行中"）、多选传字符串数组（["A","B"]）、' +
              '人员传 [{"id":"ou_xxx"}]、附件传 [{"file_token":"box_xxx"}]、复选框传 true/false。' +
              '只写想设值的字段，没写的字段保持空。',
          ),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ app_token, table_id, fields }) => {
      try {
        const appToken = app_token.trim();
        const tableId = table_id.trim();
        const keys = Object.keys(fields ?? {});
        if (!keys.length) {
          return fail(
            'fields 是空的，没有可写的内容。' +
              '请先调 feishu_bitable_fields 拿到字段名，再按「字段名 → 值」传至少一个键。',
          );
        }

        const record = await ctx.client.createBitableRecord(appToken, tableId, fields);
        const lines: string[] = [
          `已新增记录（record_id=${record.recordId || '(飞书没返回 record_id)'}），表 ${tableId}：`,
        ];
        lines.push(...renderRecordFields(record.fields ?? {}));
        lines.push('');
        lines.push('要改这条记录时用 record_id 调 feishu_bitable_update。');

        return ok(lines.join('\n'), {
          app_token: appToken,
          table_id: tableId,
          record_id: record.recordId,
          fields: record.fields ?? {},
          written_keys: keys,
        });
      } catch (err) {
        return fail(describeError(err, '新增记录'));
      }
    },
  );

  // ───────────────────────── 5. 更新记录 ─────────────────────────

  server.registerTool(
    'feishu_bitable_update',
    {
      title: '更新多维表格记录',
      description:
        '按 record_id 更新某条记录的部分字段（只覆盖 fields 里出现的字段，其余字段不动）。' +
        '**写操作，会真的改用户的表**：record_id 必须先通过 feishu_bitable_records 查到，别自己编。' +
        '值形态的规矩和 feishu_bitable_add 一样：文本传字符串、数字传数字、日期传毫秒时间戳、' +
        '单选传选项字符串、多选/人员/附件/关联传数组。' +
        '适合：修正一条错数据、推进状态、补填附件。不适合：整表批量改（逐条调用）。',
      inputSchema: {
        app_token: z.string().min(1).describe('多维表格的 app_token（Base 链接里 /base/ 后面那串）'),
        table_id: z.string().min(1).describe('记录所在的数据表 id（形如 tbliz1PrMZkp1DSN）'),
        record_id: z
          .string()
          .min(1)
          .describe('要更新的记录 id（rec 开头，形如 recxxxxxxxx）。先用 feishu_bitable_records 查出来。'),
        fields: z
          .record(z.string(), z.unknown())
          .describe(
            '要改的字段名 → 新值；未出现的字段保持原值。' +
              '形如 {"状态":"已完成","完成日期":1700000000000}。' +
              '值形态必须匹配字段类型（文本字符串、数字数字、日期毫秒时间戳、单选选项字符串、' +
              '多选/人员/附件数组）。',
          ),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ app_token, table_id, record_id, fields }) => {
      try {
        const appToken = app_token.trim();
        const tableId = table_id.trim();
        const recordId = record_id.trim();
        const keys = Object.keys(fields ?? {});
        if (!keys.length) {
          return fail(
            'fields 是空的，没有任何字段会被更新。' +
              '请至少传一个要改的字段名（key 必须是字段名，不是 field_id）。',
          );
        }

        await ctx.client.updateBitableRecord(appToken, tableId, recordId, fields);

        const lines = [
          `已更新记录（record_id=${recordId}），表 ${tableId}：`,
          `　改动的字段：${keys.join('、')}`,
          '',
          '注意：飞书的更新接口不回传整条记录，想确认结果请再调一次 feishu_bitable_records 查看。',
        ];

        return ok(lines.join('\n'), {
          app_token: appToken,
          table_id: tableId,
          record_id: recordId,
          updated_keys: keys,
        });
      } catch (err) {
        return fail(describeError(err, '更新记录'));
      }
    },
  );

  // ───────────────────────── 6. 新建电子表格 ─────────────────────────

  server.registerTool(
    'feishu_sheet_create',
    {
      title: '新建电子表格',
      description:
        '在飞书云空间里新建一张空的电子表格（Sheets），返回 spreadsheet_token 与可分享的链接。' +
        '**写操作，会在用户的云文档里真的建一个文件**。' +
        '适合：用户要"建个表记录一下"这类从零开始的场景。' +
        '不适合：已经有表格只是要写数据（应该拿现有 spreadsheet_token 去读写，而不是新建）。' +
        'folder_token 不填就建在"我的空间"根目录；要建进某个文件夹，先用云空间相关工具拿到文件夹 token。' +
        '建完可以接着用 feishu_send_text 把链接发给用户。',
      inputSchema: {
        title: z
          .string()
          .min(1)
          .describe('电子表格文件名（用户看到的名字），如 "2026 Q1 周报汇总"。不用带 .xlsx 后缀。'),
        folder_token: z
          .string()
          .optional()
          .describe('目标文件夹 token（形如 fldcnxxxx）。不填则建在云空间"我的空间"根目录。'),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ title, folder_token }) => {
      try {
        const name = title.trim();
        const folderToken = folder_token?.trim();
        const created = await ctx.client.createSpreadsheet(
          name,
          folderToken ? folderToken : undefined,
        );
        const token = created.spreadsheetToken;
        const url = token ? `https://feishu.cn/sheets/${token}` : '';

        const lines = [
          `已新建电子表格「${name}」`,
          `spreadsheet_token=${token || '(飞书没返回 token)'}`,
        ];
        if (url) {
          lines.push(`链接（按你所在租户的域名替换前缀即可）：${url}`);
        }
        if (folderToken) {
          lines.push(`所在文件夹：${folderToken}`);
        } else {
          lines.push('位置：云空间「我的空间」根目录');
        }
        lines.push('');
        lines.push(
          '下一步：可以用 feishu_send_text 把这个链接发给用户；' +
            '要把链接发得好看点也可以用 feishu_send_info_card。',
        );

        return ok(lines.join('\n'), {
          title: name,
          spreadsheet_token: token,
          url: url || null,
          folder_token: folderToken ?? null,
        });
      } catch (err) {
        return fail(describeError(err, '新建电子表格'));
      }
    },
  );
}
