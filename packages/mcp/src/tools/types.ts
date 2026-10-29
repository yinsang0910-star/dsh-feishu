import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { FeishuClient, FeishuConfig } from '@dsh-feishu/core';

/** 每个工具模块拿到的运行时上下文 */
export interface ToolContext {
  client: FeishuClient;
  config: FeishuConfig;
  /** 写 stderr，绝不污染 stdout（stdout 是 MCP 协议通道） */
  log: (msg: string, extra?: unknown) => void;
}

/** 工具模块统一导出这个函数 */
export type ToolRegistrar = (server: McpServer, ctx: ToolContext) => void;

/** 工具返回的统一形态；handler 里 return ok(...) / fail(...) */
export interface ToolResult {
  [k: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export function ok(text: string, structured?: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: 'text', text }],
    ...(structured ? { structuredContent: structured } : {}),
  } as ToolResult;
}

export function fail(text: string, structured?: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: 'text', text }],
    isError: true,
    ...(structured ? { structuredContent: structured } : {}),
  } as ToolResult;
}
