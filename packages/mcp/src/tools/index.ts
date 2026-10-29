/**
 * 工具注册总入口。
 *
 * 每个模块自己声明要注册什么，这里只负责串起来；新增工具 = 新增一个文件 + 这里加一行。
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './types.js';

import { registerBaseTools } from './base.js';
import { registerMessageTools } from './messages.js';
import { registerFileTools } from './files.js';
import { registerContextTools } from './context.js';
import { registerDirectoryTools } from './directory.js';

export function registerAllTools(server: McpServer, ctx: ToolContext): void {
  registerBaseTools(server, ctx);
  registerMessageTools(server, ctx);
  registerFileTools(server, ctx);
  registerContextTools(server, ctx);
  registerDirectoryTools(server, ctx);
}
