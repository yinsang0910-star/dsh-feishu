/**
 * 共享类型契约。
 *
 * 所有包（core / mcp / plugin）都以本文件为准；改动这里等于改公共 API，
 * 必须同步 README 与 docs/TOOLS.md。
 */

// ─────────────────────────── 配置 ───────────────────────────

export interface FeishuConfig {
  /** 自建应用 App ID */
  appId: string;
  /** 自建应用 App Secret */
  appSecret: string;
  /** 开放平台域名，飞书 https://open.feishu.cn，Lark https://open.larksuite.com */
  domain: string;
  /** 默认会话：工具没显式指定 target 时往这里发 */
  defaultChatId?: string;
  /** 默认接收方 id 类型，默认 chat_id */
  defaultReceiveIdType: ReceiveIdType;
  /** 单次 API 请求超时（毫秒），默认 30000 */
  requestTimeoutMs: number;
  /** 失败重试次数（仅网络错误与 5xx/429），默认 2 */
  maxRetries: number;
}

export type ReceiveIdType = 'chat_id' | 'open_id' | 'email' | 'user_id' | 'union_id';

/** 发送目标：可以是一个 chat_id 字符串，也可以是显式的接收方 */
export type SendTarget =
  | string
  | {
      id: string;
      idType?: ReceiveIdType;
    };

// ─────────────────────────── 飞书对象 ───────────────────────────

export interface FeishuMessage {
  messageId: string;
  chatId: string;
  msgType: string;
  /** 原始 content（JSON 字符串，飞书就是返回字符串） */
  rawContent: string;
  /** 解析后的 content；解析失败为 undefined */
  content?: unknown;
  createTime: string;
  updateTime?: string;
  senderId?: string;
  senderType?: string;
  parentId?: string;
  rootId?: string;
  threadId?: string;
  deleted?: boolean;
  mentions?: Array<{ key: string; name?: string; openId?: string }>;
}

export interface FeishuChat {
  chatId: string;
  name: string;
  description?: string;
  ownerId?: string;
  chatMode?: 'group' | 'p2p' | 'topic' | string;
  chatType?: 'private' | 'public' | string;
  memberCount?: number;
}

export interface FeishuUser {
  openId: string;
  name?: string;
  enName?: string;
  email?: string;
  mobile?: string;
}

export interface BotInfo {
  openId: string;
  name: string;
  avatarUrl?: string;
}

// ─────────────────────────── 卡片 ───────────────────────────

/** 飞书交互卡片就是一个 JSON 结构，这里不约束内部形态 */
export type FeishuCard = Record<string, unknown>;

export interface CardActionResult {
  messageId: string;
}

// ─────────────────────────── 结果 ───────────────────────────

export interface SentMessage {
  messageId: string;
  chatId: string;
  msgType: string;
}

export interface UploadResult {
  /** 上传后的 file_key 或 image_key */
  key: string;
  fileName: string;
  bytes: number;
}

export interface DownloadResult {
  /** 落盘绝对路径 */
  path: string;
  bytes: number;
  fileName: string;
  mimeType?: string;
}

/** 等待用户回复的结果 */
export interface WaitReplyResult {
  /** true=匹配到回复；false=超时 */
  ok: boolean;
  message?: FeishuMessage;
  /** 回复文本（若是 text 消息） */
  text?: string;
  /** 超时时间（毫秒） */
  waitedMs: number;
}

// ─────────────────────────── 错误 ───────────────────────────

/** 飞书 API 返回非 0 code 时抛出 */
export class FeishuApiError extends Error {
  readonly code: number;
  readonly httpStatus: number;
  readonly path: string;
  readonly method: string;
  readonly detail?: unknown;

  constructor(args: {
    code: number;
    message: string;
    path: string;
    method: string;
    httpStatus?: number;
    detail?: unknown;
  }) {
    super(`[${args.method} ${args.path}] code=${args.code}: ${args.message}`);
    this.name = 'FeishuApiError';
    this.code = args.code;
    this.httpStatus = args.httpStatus ?? 200;
    this.path = args.path;
    this.method = args.method;
    this.detail = args.detail;
  }

  /** 权限不足（69991672 / 99991672 / 230027）时给出可执行的修复建议 */
  get isPermission(): boolean {
    return this.code === 99991672 || this.code === 69991672 || this.code === 230027;
  }

  /** 从错误信息里抽出需要的 scope，便于人直接去开放平台开 */
  get missingScopes(): string[] {
    const msg = this.message;
    const m = msg.match(/\[\s*([a-z0-9_.:,\s]+)\]/i);
    if (!m || !m[1]) return [];
    return m[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
}
