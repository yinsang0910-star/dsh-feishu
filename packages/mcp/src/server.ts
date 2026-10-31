#!/usr/bin/env node
/**
 * dsh-feishu-mcp —— 把飞书变成 agent 的手和眼。
 *
 * 与 @larksuiteoapi/lark-mcp 的分工：
 *   lark-mcp   搬 OpenAPI 的广度（几百个接口），但不做文件发送、不做上下文、不做交互。
 *   dsh-feishu 补的正是这几块：发文件、读上下文、等人回答、更新卡片。
 *
 * 协议要点：
 *   - stdout 只能出 MCP JSON-RPC，任何日志必须走 stderr；
 *   - 配置全部从环境变量读，secret 不落盘。
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createClient, loadConfig } from '@yisang0910/core';
import { registerAllTools } from './tools/index.js';
import type { ToolContext } from './tools/types.js';

const VERSION = '0.1.0';

function log(msg: string, extra?: unknown): void {
  const line = extra === undefined ? msg : `${msg} ${JSON.stringify(extra)}`;
  process.stderr.write(`[dsh-feishu-mcp] ${line}\n`);
}

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    log(`配置加载失败：${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }

  const client = createClient();
  const ctx: ToolContext = { client, config, log };

  const server = new McpServer({ name: 'dsh-feishu', version: VERSION });
  registerAllTools(server, ctx);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  log(`ready · app=${config.appId} · default_chat=${config.defaultChatId ?? '(未设置)'}`);
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    log(`${sig} 收到，退出`);
    process.exit(0);
  });
}

process.on('uncaughtException', (err) => {
  log(`未捕获异常：${err.stack ?? err.message}`);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  log(`未处理的 rejection：${String(reason)}`);
});

main().catch((err: unknown) => {
  log(`启动失败：${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
