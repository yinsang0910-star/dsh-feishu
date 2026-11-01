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
import type { FeishuClient, FeishuConfig } from '@yisang0910/core';
import { registerAllTools } from './tools/index.js';
import type { ToolContext } from './tools/types.js';

const VERSION = '0.1.0';

function log(msg: string, extra?: unknown): void {
  const line = extra === undefined ? msg : `${msg} ${JSON.stringify(extra)}`;
  process.stderr.write(`[dsh-feishu-mcp] ${line}\n`);
}

/**
 * 凭据缺失时不要退出。
 *
 * 客户端与目录站（Docker 启动、introspection、tools/list）都不会带凭据，
 * 启动即退出会让它们只看到「server 崩了」。这里改成照常握手，真正调用工具时
 * 再抛出可读的错误。
 */
function missingCredentials(reason: string): { config: FeishuConfig; client: FeishuClient } {
  const fail = (): never => {
    throw new Error(`飞书凭据未配置：${reason}`);
  };
  const proxy = <T extends object>(): T =>
    new Proxy({} as T, {
      get(_target, prop) {
        // 让 JSON.stringify / await 之类的通用探测安静通过，其余一律报错。
        if (typeof prop === 'symbol' || prop === 'then' || prop === 'toJSON') return undefined;
        return fail();
      },
      has: () => false,
    });
  return { config: proxy<FeishuConfig>(), client: proxy<FeishuClient>() };
}

async function main(): Promise<void> {
  let config: FeishuConfig;
  let client: FeishuClient;
  let ready = true;
  let reason = '';

  try {
    config = loadConfig();
    client = createClient();
  } catch (err) {
    reason = err instanceof Error ? err.message : String(err);
    ready = false;
    log(`配置不完整，仍会启动：${reason}`);
    ({ config, client } = missingCredentials(reason));
  }

  const ctx: ToolContext = { client, config, log };

  const server = new McpServer({ name: 'dsh-feishu', version: VERSION });
  registerAllTools(server, ctx);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  if (ready) {
    log(`ready · app=${config.appId} · default_chat=${config.defaultChatId ?? '(未设置)'}`);
  } else {
    log('ready（未配置凭据，工具调用会返回配置错误）');
  }
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
