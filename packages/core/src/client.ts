/**
 * 飞书 OpenAPI 客户端。
 *
 * 设计取舍：
 *  - 只用 Node 内置 fetch / FormData / Blob，不引第三方 HTTP 库；
 *  - tenant_access_token 进程内缓存并做并发去重（多工具同时调用只刷一次）；
 *  - 错误统一成 FeishuApiError，带 code/path/missingScopes，便于模型自我修正；
 *  - 只重试网络错误与 429/5xx，权限错误立即抛出（重试没有意义）。
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  FeishuApiError,
  type BitableField,
  type BitableRecord,
  type BitableTable,
  type BotInfo,
  type DownloadResult,
  type DriveFile,
  type FeishuCard,
  type FeishuChat,
  type FeishuConfig,
  type FeishuMessage,
  type FeishuUser,
  type ReceiveIdType,
  type SendTarget,
  type SentMessage,
  type UploadResult,
  type WikiNode,
  type WikiSpace,
} from './types.js';

const DEFAULT_DOMAIN = 'https://open.feishu.cn';
const TOKEN_SAFETY_MS = 5 * 60 * 1000;

interface RawResponse {
  code: number;
  msg: string;
  data?: Record<string, unknown>;
  [k: string]: unknown;
}

export class FeishuClient {
  readonly config: FeishuConfig;
  private tokenValue = '';
  private tokenExpiresAt = 0;
  private tokenInFlight: Promise<string> | null = null;

  constructor(config: Partial<FeishuConfig> & { appId: string; appSecret: string }) {
    const rawDomain = config.domain ?? DEFAULT_DOMAIN;
    this.config = {
      defaultReceiveIdType: 'chat_id',
      requestTimeoutMs: 30_000,
      maxRetries: 2,
      ...config,
      domain: rawDomain.replace(/\/+$/, ''),
    };
  }

  // ───────────────────────── token ─────────────────────────

  async token(): Promise<string> {
    const now = Date.now();
    if (this.tokenValue && now < this.tokenExpiresAt - TOKEN_SAFETY_MS) {
      return this.tokenValue;
    }
    if (this.tokenInFlight) return this.tokenInFlight;

    this.tokenInFlight = (async () => {
      const url = `${this.config.domain}/open-apis/auth/v3/tenant_access_token/internal`;
      const res = await this.fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          app_id: this.config.appId,
          app_secret: this.config.appSecret,
        }),
      });
      const json = (await res.json()) as {
        code?: number;
        msg?: string;
        tenant_access_token?: string;
        expire?: number;
      };
      if (json.code !== 0 || !json.tenant_access_token) {
        throw new FeishuApiError({
          code: json.code ?? -1,
          message: json.msg ?? '拿到 tenant_access_token 失败',
          path: '/auth/v3/tenant_access_token/internal',
          method: 'POST',
          detail: json,
        });
      }
      this.tokenValue = json.tenant_access_token;
      this.tokenExpiresAt = Date.now() + (json.expire ?? 7200) * 1000;
      return this.tokenValue;
    })();

    try {
      return await this.tokenInFlight;
    } finally {
      this.tokenInFlight = null;
    }
  }

  // ───────────────────────── 底层请求 ─────────────────────────

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    return fetch(url, {
      ...init,
      signal: AbortSignal.timeout(this.config.requestTimeoutMs),
    });
  }

  /** GET / POST JSON，返回 data 字段。unwrap=false 时返回整个响应体（有些接口不用 data 包装） */
  async request<T = Record<string, unknown>>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    apiPath: string,
    opts: {
      query?: Record<string, string | number | undefined>;
      body?: unknown;
      unwrap?: boolean;
    } = {},
  ): Promise<T> {
    const token = await this.token();
    let url = `${this.config.domain}/open-apis${apiPath}`;
    if (opts.query) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
      }
      const s = qs.toString();
      if (s) url += (url.includes('?') ? '&' : '?') + s;
    }

    const init: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(opts.body !== undefined
          ? { 'Content-Type': 'application/json; charset=utf-8' }
          : {}),
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    };

    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        const res = await this.fetchWithTimeout(url, init);
        const json = (await res.json()) as RawResponse;
        if (json.code === 0) {
          return (opts.unwrap === false ? json : (json.data ?? {})) as T;
        }

        // token 过期：清缓存重试一次
        if ((json.code === 99991663 || json.code === 99991661) && attempt === 0) {
          this.tokenValue = '';
          this.tokenExpiresAt = 0;
          const fresh = await this.token();
          (init.headers as Record<string, string>).Authorization = `Bearer ${fresh}`;
          continue;
        }

        throw new FeishuApiError({
          code: json.code,
          message: json.msg ?? 'unknown error',
          path: apiPath,
          method,
          httpStatus: res.status,
          detail: json,
        });
      } catch (err) {
        lastErr = err;
        if (err instanceof FeishuApiError) throw err;
        const retriable = attempt < this.config.maxRetries;
        if (!retriable) break;
        await new Promise((r) => setTimeout(r, 300 * 2 ** attempt));
      }
    }
    const message = lastErr instanceof Error ? lastErr.message : String(lastErr);
    throw new FeishuApiError({
      code: -1,
      message: `请求失败：${message}`,
      path: apiPath,
      method,
    });
  }

  /** multipart 上传，返回飞书原始 data */
  private async upload(
    apiPath: string,
    fields: Record<string, string>,
    fileField: string,
    fileName: string,
    bytes: Buffer,
  ): Promise<Record<string, unknown>> {
    const token = await this.token();
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    const blob = new Blob([new Uint8Array(bytes)]);
    form.append(fileField, blob, fileName);

    const res = await this.fetchWithTimeout(
      `${this.config.domain}/open-apis${apiPath}`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      },
    );
    const json = (await res.json()) as RawResponse;
    if (json.code !== 0) {
      throw new FeishuApiError({
        code: json.code,
        message: json.msg ?? '上传失败',
        path: apiPath,
        method: 'POST',
        httpStatus: res.status,
        detail: json,
      });
    }
    return json.data ?? {};
  }

  // ───────────────────────── 目标归一化 ─────────────────────────

  private normalizeTarget(target?: SendTarget): { id: string; idType: ReceiveIdType } {
    if (target === undefined || target === null) {
      if (!this.config.defaultChatId) {
        throw new FeishuApiError({
          code: -2,
          message:
            '没有指定发送目标，也没有配置默认会话。请传 target，或设置 FEISHU_DEFAULT_CHAT_ID。',
          path: '(local)',
          method: 'SEND',
        });
      }
      return { id: this.config.defaultChatId, idType: this.config.defaultReceiveIdType };
    }
    if (typeof target === 'string') {
      const idType: ReceiveIdType = target.startsWith('oc_')
        ? 'chat_id'
        : target.includes('@')
          ? 'email'
          : target.startsWith('ou_')
            ? 'open_id'
            : this.config.defaultReceiveIdType;
      return { id: target, idType };
    }
    return { id: target.id, idType: target.idType ?? this.config.defaultReceiveIdType };
  }

  // ───────────────────────── 发消息 ─────────────────────────

  private async createMessage(
    target: SendTarget | undefined,
    msgType: string,
    content: unknown,
  ): Promise<SentMessage> {
    const { id, idType } = this.normalizeTarget(target);
    const data = await this.request<{ message_id: string; chat_id?: string }>(
      'POST',
      '/im/v1/messages',
      {
        query: { receive_id_type: idType },
        body: { receive_id: id, msg_type: msgType, content: JSON.stringify(content) },
      },
    );
    return {
      messageId: data.message_id,
      chatId: data.chat_id ?? (idType === 'chat_id' ? id : ''),
      msgType,
    };
  }

  sendText(target: SendTarget | undefined, text: string): Promise<SentMessage> {
    return this.createMessage(target, 'text', { text });
  }

  sendCard(target: SendTarget | undefined, card: FeishuCard): Promise<SentMessage> {
    return this.createMessage(target, 'interactive', card);
  }

  /** 原地更新一张卡片（要求卡片 config.update_multi = true） */
  async updateCard(messageId: string, card: FeishuCard): Promise<void> {
    await this.request('PATCH', `/im/v1/messages/${encodeURIComponent(messageId)}`, {
      body: { content: JSON.stringify(card) },
    });
  }

  /** 撤回自己发的消息 */
  async recallMessage(messageId: string): Promise<void> {
    await this.request('DELETE', `/im/v1/messages/${encodeURIComponent(messageId)}`);
  }

  // ───────────────────────── 上传并发送 ─────────────────────────

  /** 上传任意文件到 IM（file_type=stream），返回 file_key */
  async uploadFile(filePath: string, fileName?: string): Promise<UploadResult> {
    const abs = path.resolve(filePath);
    const bytes = await fs.promises.readFile(abs);
    const name = fileName ?? path.basename(abs);
    const data = await this.upload(
      '/im/v1/files',
      { file_type: 'stream', file_name: name },
      'file',
      name,
      bytes,
    );
    return { key: String(data['file_key'] ?? ''), fileName: name, bytes: bytes.length };
  }

  /** 上传图片到 IM（image_type=message），返回 image_key */
  async uploadImage(filePath: string): Promise<UploadResult> {
    const abs = path.resolve(filePath);
    const bytes = await fs.promises.readFile(abs);
    const data = await this.upload(
      '/im/v1/images',
      { image_type: 'message' },
      'image',
      path.basename(abs),
      bytes,
    );
    return { key: String(data['image_key'] ?? ''), fileName: path.basename(abs), bytes: bytes.length };
  }

  /** 发本地文件（补上 lark-mcp 缺的那块） */
  async sendFile(
    target: SendTarget | undefined,
    filePath: string,
    fileName?: string,
  ): Promise<SentMessage & { fileKey: string; bytes: number }> {
    const up = await this.uploadFile(filePath, fileName);
    if (!up.key) {
      throw new FeishuApiError({
        code: -3,
        message: '上传成功但没有拿到 file_key',
        path: '/im/v1/files',
        method: 'POST',
      });
    }
    const sent = await this.createMessage(target, 'file', { file_key: up.key });
    return { ...sent, fileKey: up.key, bytes: up.bytes };
  }

  /** 发本地图片 */
  async sendImage(
    target: SendTarget | undefined,
    imagePath: string,
  ): Promise<SentMessage & { imageKey: string; bytes: number }> {
    const up = await this.uploadImage(imagePath);
    if (!up.key) {
      throw new FeishuApiError({
        code: -3,
        message: '上传成功但没有拿到 image_key',
        path: '/im/v1/images',
        method: 'POST',
      });
    }
    const sent = await this.createMessage(target, 'image', { image_key: up.key });
    return { ...sent, imageKey: up.key, bytes: up.bytes };
  }

  // ───────────────────────── 读消息 ─────────────────────────

  private mapMessage(raw: Record<string, unknown>): FeishuMessage {
    const body = (raw['body'] ?? {}) as Record<string, unknown>;
    const sender = (raw['sender'] ?? {}) as Record<string, unknown>;
    const senderIdObj = (sender['sender_id'] ?? {}) as Record<string, unknown>;
    const rawContent = String(body['content'] ?? '');
    let content: unknown;
    try {
      content = rawContent ? JSON.parse(rawContent) : undefined;
    } catch {
      content = undefined;
    }
    const mentions = Array.isArray(raw['mentions'])
      ? (raw['mentions'] as Array<Record<string, unknown>>).map((m) => {
          const id = (m['id'] ?? {}) as Record<string, unknown>;
          return {
            key: String(m['key'] ?? ''),
            name: m['name'] ? String(m['name']) : undefined,
            openId: id['open_id'] ? String(id['open_id']) : undefined,
          };
        })
      : undefined;

    return {
      messageId: String(raw['message_id'] ?? ''),
      chatId: String(raw['chat_id'] ?? ''),
      msgType: String(raw['msg_type'] ?? ''),
      rawContent,
      content,
      createTime: String(raw['create_time'] ?? ''),
      updateTime: raw['update_time'] ? String(raw['update_time']) : undefined,
      senderId: senderIdObj['open_id'] ? String(senderIdObj['open_id']) : undefined,
      senderType: sender['sender_type'] ? String(sender['sender_type']) : undefined,
      parentId: raw['parent_id'] ? String(raw['parent_id']) : undefined,
      rootId: raw['root_id'] ? String(raw['root_id']) : undefined,
      threadId: raw['thread_id'] ? String(raw['thread_id']) : undefined,
      deleted: Boolean(raw['deleted']),
      mentions,
    };
  }

  /**
   * 拉会话历史。sort=desc 时是"最近优先"，适合当上下文用。
   * 需要权限 im:message.group_msg（群）或 im:message.p2p_msg:readonly（单聊）。
   */
  async listMessages(
    chatId: string,
    opts: {
      pageSize?: number;
      sort?: 'asc' | 'desc';
      startTimeSec?: number;
      endTimeSec?: number;
      pageToken?: string;
    } = {},
  ): Promise<{ items: FeishuMessage[]; hasMore: boolean; pageToken?: string }> {
    const data = await this.request<{
      items?: Array<Record<string, unknown>>;
      has_more?: boolean;
      page_token?: string;
    }>('GET', '/im/v1/messages', {
      query: {
        container_id_type: 'chat',
        container_id: chatId,
        page_size: opts.pageSize ?? 20,
        sort_type: opts.sort === 'asc' ? 'ByCreateTimeAsc' : 'ByCreateTimeDesc',
        start_time: opts.startTimeSec,
        end_time: opts.endTimeSec,
        page_token: opts.pageToken,
      },
    });
    return {
      items: (data.items ?? []).map((m) => this.mapMessage(m)),
      hasMore: Boolean(data.has_more),
      pageToken: data.page_token,
    };
  }

  async getMessage(messageId: string): Promise<FeishuMessage | null> {
    const data = await this.request<{ items?: Array<Record<string, unknown>> }>(
      'GET',
      `/im/v1/messages/${encodeURIComponent(messageId)}`,
    );
    const first = data.items?.[0];
    return first ? this.mapMessage(first) : null;
  }

  // ───────────────────────── 下载资源 ─────────────────────────

  /** 下载消息内资源（用户发来的文件/图片）到本地 */
  async downloadMessageResource(
    messageId: string,
    fileKey: string,
    type: 'image' | 'file',
    destPath: string,
  ): Promise<DownloadResult> {
    const token = await this.token();
    const url =
      `${this.config.domain}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}` +
      `/resources/${encodeURIComponent(fileKey)}?type=${type}`;
    const res = await this.fetchWithTimeout(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      let detail: unknown;
      try {
        detail = await res.json();
      } catch {
        detail = await res.text().catch(() => '');
      }
      const code =
        detail && typeof detail === 'object' && 'code' in detail
          ? Number((detail as { code: unknown }).code)
          : res.status;
      const msg =
        detail && typeof detail === 'object' && 'msg' in detail
          ? String((detail as { msg: unknown }).msg)
          : `HTTP ${res.status}`;
      throw new FeishuApiError({
        code,
        message: msg,
        path: '/im/v1/messages/:id/resources/:key',
        method: 'GET',
        httpStatus: res.status,
        detail,
      });
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const abs = path.resolve(destPath);
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    await fs.promises.writeFile(abs, buf);
    return {
      path: abs,
      bytes: buf.length,
      fileName: path.basename(abs),
      mimeType: res.headers.get('content-type') ?? undefined,
    };
  }

  // ───────────────────────── 会话 ─────────────────────────

  async listChats(opts: { pageSize?: number } = {}): Promise<FeishuChat[]> {
    const data = await this.request<{ items?: Array<Record<string, unknown>> }>(
      'GET',
      '/im/v1/chats',
      { query: { page_size: opts.pageSize ?? 20 } },
    );
    return (data.items ?? []).map((c) => ({
      chatId: String(c['chat_id'] ?? ''),
      name: String(c['name'] ?? ''),
      description: c['description'] ? String(c['description']) : undefined,
      ownerId: c['owner_id'] ? String(c['owner_id']) : undefined,
      chatMode: c['chat_mode'] ? String(c['chat_mode']) : undefined,
      chatType: c['chat_type'] ? String(c['chat_type']) : undefined,
    }));
  }

  async listMembers(chatId: string, pageSize = 50): Promise<FeishuUser[]> {
    const data = await this.request<{ items?: Array<Record<string, unknown>> }>(
      'GET',
      `/im/v1/chats/${encodeURIComponent(chatId)}/members`,
      { query: { member_id_type: 'open_id', page_size: pageSize } },
    );
    return (data.items ?? []).map((m) => ({
      openId: String(m['member_id'] ?? ''),
      name: m['name'] ? String(m['name']) : undefined,
    }));
  }

  async botInfo(): Promise<BotInfo> {
    // 注意：/bot/v3/info 把 bot 放在响应顶层，不是 data 里，必须 unwrap=false
    const json = await this.request<{
      bot?: { open_id?: string; app_name?: string; avatar_url?: string };
    }>('GET', '/bot/v3/info', { unwrap: false });
    const bot = json.bot ?? {};
    return {
      openId: String(bot.open_id ?? ''),
      name: String(bot.app_name ?? ''),
      avatarUrl: bot.avatar_url ? String(bot.avatar_url) : undefined,
    };
  }

  // ═══════════════════════ 多维表格 ═══════════════════════

  async listBitableTables(appToken: string): Promise<BitableTable[]> {
    const data = await this.request<{ items?: Array<Record<string, unknown>> }>(
      'GET',
      `/bitable/v1/apps/${encodeURIComponent(appToken)}/tables`,
      { query: { page_size: 100 } },
    );
    return (data.items ?? []).map((t) => ({
      tableId: String(t['table_id'] ?? ''),
      name: String(t['name'] ?? ''),
    }));
  }

  async listBitableFields(appToken: string, tableId: string): Promise<BitableField[]> {
    const data = await this.request<{ items?: Array<Record<string, unknown>> }>(
      'GET',
      `/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/fields`,
      { query: { page_size: 100 } },
    );
    return (data.items ?? []).map((f) => ({
      fieldId: String(f['field_id'] ?? ''),
      name: String(f['field_name'] ?? ''),
      type: Number(f['type'] ?? 0),
    }));
  }

  async listBitableRecords(
    appToken: string,
    tableId: string,
    opts: { pageSize?: number; pageToken?: string; filter?: string } = {},
  ): Promise<{ items: BitableRecord[]; hasMore: boolean; pageToken?: string }> {
    const data = await this.request<{
      items?: Array<Record<string, unknown>>;
      has_more?: boolean;
      page_token?: string;
    }>(
      'GET',
      `/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records`,
      {
        query: {
          page_size: opts.pageSize ?? 50,
          page_token: opts.pageToken,
          ...(opts.filter ? { filter: opts.filter } : {}),
        },
      },
    );
    return {
      items: (data.items ?? []).map((r) => ({
        recordId: String(r['record_id'] ?? ''),
        fields: (r['fields'] ?? {}) as Record<string, unknown>,
      })),
      hasMore: Boolean(data.has_more),
      pageToken: data.page_token,
    };
  }

  async createBitableRecord(
    appToken: string,
    tableId: string,
    fields: Record<string, unknown>,
  ): Promise<BitableRecord> {
    const data = await this.request<{ record?: Record<string, unknown> }>(
      'POST',
      `/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records`,
      { body: { fields } },
    );
    const r = data.record ?? {};
    return {
      recordId: String(r['record_id'] ?? ''),
      fields: (r['fields'] ?? {}) as Record<string, unknown>,
    };
  }

  async updateBitableRecord(
    appToken: string,
    tableId: string,
    recordId: string,
    fields: Record<string, unknown>,
  ): Promise<void> {
    await this.request(
      'PUT',
      `/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records/${encodeURIComponent(recordId)}`,
      { body: { fields } },
    );
  }

  async deleteBitableRecord(appToken: string, tableId: string, recordId: string): Promise<void> {
    await this.request(
      'DELETE',
      `/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records/${encodeURIComponent(recordId)}`,
    );
  }

  // ═══════════════════════ 电子表格 ═══════════════════════

  async createSpreadsheet(title: string, folderToken?: string): Promise<{ spreadsheetToken: string }> {
    const data = await this.request<{ spreadsheet?: Record<string, unknown> }>(
      'POST',
      '/sheets/v3/spreadsheets',
      { body: { title, ...(folderToken ? { folder_token: folderToken } : {}) } },
    );
    const s = data.spreadsheet ?? {};
    return { spreadsheetToken: String(s['spreadsheet_token'] ?? '') };
  }

  async readSheetValues(
    spreadsheetToken: string,
    range: string,
  ): Promise<{ values: unknown[][]; range: string }> {
    const data = await this.request<{ valueRange?: Record<string, unknown> }>(
      'GET',
      `/sheets/v2/spreadsheets/${encodeURIComponent(spreadsheetToken)}/values/${encodeURIComponent(range)}`,
    );
    const vr = data.valueRange ?? {};
    return {
      values: (vr['values'] ?? []) as unknown[][],
      range: String(vr['range'] ?? range),
    };
  }

  // ═══════════════════════ 文档 ═══════════════════════

  /** 读文档纯文本（docx 需要 docx:document:readonly 或 docx:document） */
  async readDocumentRaw(documentId: string): Promise<string> {
    const data = await this.request<{ content?: string }>(
      'GET',
      `/docx/v1/documents/${encodeURIComponent(documentId)}/raw_content`,
      { query: { lang: 0 } },
    );
    return String(data.content ?? '');
  }

  /** 文档块结构（用于定位段落、做精细编辑） */
  async listDocumentBlocks(
    documentId: string,
    opts: { pageSize?: number; pageToken?: string } = {},
  ): Promise<{ items: Array<Record<string, unknown>>; hasMore: boolean; pageToken?: string }> {
    const data = await this.request<{
      items?: Array<Record<string, unknown>>;
      has_more?: boolean;
      page_token?: string;
    }>('GET', `/docx/v1/documents/${encodeURIComponent(documentId)}/blocks`, {
      query: { page_size: opts.pageSize ?? 100, page_token: opts.pageToken, document_revision_id: -1 },
    });
    return {
      items: data.items ?? [],
      hasMore: Boolean(data.has_more),
      pageToken: data.page_token,
    };
  }

  /** 新建文档（需要 docx:document:create） */
  async createDocument(title: string, folderToken?: string): Promise<{ documentId: string }> {
    const data = await this.request<{ document?: Record<string, unknown> }>(
      'POST',
      '/docx/v1/documents',
      { body: { title, ...(folderToken ? { folder_token: folderToken } : {}) } },
    );
    const d = data.document ?? {};
    return { documentId: String(d['document_id'] ?? '') };
  }

  // ═══════════════════════ 云空间 ═══════════════════════

  async listDriveFiles(
    folderToken = '',
    pageSize = 50,
  ): Promise<{ items: DriveFile[]; hasMore: boolean; pageToken?: string }> {
    const data = await this.request<{
      files?: Array<Record<string, unknown>>;
      has_more?: boolean;
      next_page_token?: string;
    }>('GET', '/drive/v1/files', {
      query: { folder_token: folderToken, page_size: pageSize },
    });
    return {
      items: (data.files ?? []).map((f) => ({
        token: String(f['token'] ?? ''),
        name: String(f['name'] ?? ''),
        type: String(f['type'] ?? ''),
        url: f['url'] ? String(f['url']) : undefined,
        modifiedTime: f['modified_time'] ? String(f['modified_time']) : undefined,
      })),
      hasMore: Boolean(data.has_more),
      pageToken: data.next_page_token,
    };
  }

  // ═══════════════════════ 知识库 ═══════════════════════

  async listWikiSpaces(pageSize = 50): Promise<WikiSpace[]> {
    const data = await this.request<{ items?: Array<Record<string, unknown>> }>(
      'GET',
      '/wiki/v2/spaces',
      { query: { page_size: pageSize } },
    );
    return (data.items ?? []).map((s) => ({
      spaceId: String(s['space_id'] ?? ''),
      name: String(s['name'] ?? ''),
      description: s['description'] ? String(s['description']) : undefined,
      spaceType: s['space_type'] ? String(s['space_type']) : undefined,
    }));
  }

  async getWikiNode(token: string): Promise<WikiNode> {
    const data = await this.request<{ node?: Record<string, unknown> }>(
      'GET',
      '/wiki/v2/spaces/get_node',
      { query: { token } },
    );
    const n = data.node ?? {};
    return {
      nodeToken: String(n['node_token'] ?? ''),
      objToken: String(n['obj_token'] ?? ''),
      objType: String(n['obj_type'] ?? ''),
      title: String(n['title'] ?? ''),
      spaceId: String(n['space_id'] ?? ''),
      parentNodeToken: n['parent_node_token'] ? String(n['parent_node_token']) : undefined,
    };
  }

  async listWikiNodes(spaceId: string, parentNodeToken = ''): Promise<WikiNode[]> {
    const data = await this.request<{ items?: Array<Record<string, unknown>> }>(
      'GET',
      `/wiki/v2/spaces/${encodeURIComponent(spaceId)}/nodes`,
      { query: { page_size: 50, parent_node_token: parentNodeToken } },
    );
    return (data.items ?? []).map((n) => ({
      nodeToken: String(n['node_token'] ?? ''),
      objToken: String(n['obj_token'] ?? ''),
      objType: String(n['obj_type'] ?? ''),
      title: String(n['title'] ?? ''),
      spaceId: String(n['space_id'] ?? ''),
      parentNodeToken: n['parent_node_token'] ? String(n['parent_node_token']) : undefined,
    }));
  }

  // ═══════════════════════ 通讯录 ═══════════════════════

  /** 邮箱 → open_id（需要 contact:user.id:readonly） */
  async lookupUsersByEmail(emails: string[]): Promise<FeishuUser[]> {
    const data = await this.request<{ user_list?: Array<Record<string, unknown>> }>(
      'POST',
      '/contact/v3/users/batch_get_id',
      { query: { user_id_type: 'open_id' }, body: { emails } },
    );
    return (data.user_list ?? []).map((u) => ({
      openId: String(u['user_id'] ?? ''),
      email: u['email'] ? String(u['email']) : undefined,
      name: u['name'] ? String(u['name']) : undefined,
    }));
  }

  async lookupUsersByMobile(mobiles: string[]): Promise<FeishuUser[]> {
    const data = await this.request<{ user_list?: Array<Record<string, unknown>> }>(
      'POST',
      '/contact/v3/users/batch_get_id',
      { query: { user_id_type: 'open_id' }, body: { mobiles } },
    );
    return (data.user_list ?? []).map((u) => ({
      openId: String(u['user_id'] ?? ''),
      mobile: u['mobile'] ? String(u['mobile']) : undefined,
      name: u['name'] ? String(u['name']) : undefined,
    }));
  }

  async getUser(openId: string): Promise<FeishuUser> {
    const data = await this.request<{ user?: Record<string, unknown> }>(
      'GET',
      `/contact/v3/users/${encodeURIComponent(openId)}`,
      { query: { user_id_type: 'open_id' } },
    );
    const u = data.user ?? {};
    return {
      openId: String(u['open_id'] ?? openId),
      name: u['name'] ? String(u['name']) : undefined,
      enName: u['en_name'] ? String(u['en_name']) : undefined,
      email: u['email'] ? String(u['email']) : undefined,
      mobile: u['mobile'] ? String(u['mobile']) : undefined,
    };
  }
}
