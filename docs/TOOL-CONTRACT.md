# 工具实现契约（写代码前必读）

本文件是 `packages/mcp/src/tools/*.ts` 的实现规范。所有工具必须严格遵循，否则集成时会炸。

## 项目是什么

`dsh-feishu` 把飞书做成一等公民的操作界面。它由两部分组成：

- `@yisang0910/core` —— 飞书 API 客户端 + 类型 + 卡片模板（已实现，只管用）
- `@yisang0910/mcp` —— MCP server，把这些能力暴露成模型可调用的工具（本目录）

**与 `@larksuiteoapi/lark-mcp` 的分工**：那个搬 OpenAPI 的广度（几百个接口），但**不做**文件发送、不做会话上下文、不做交互等待、不做卡片更新。本项目的价值就在这几个缺口。

## 文件结构（不要新建目录）

```
packages/mcp/src/
├── server.ts            # 入口，已完成，不要改
└── tools/
    ├── index.ts         # 注册汇总，已完成，不要改
    ├── types.ts         # ToolContext / ok / fail，已完成，不要改
    ├── base.ts          # 样板工具（feishu_whoami / feishu_send_info_card）
    ├── messages.ts      # ← 你负责的
    ├── files.ts         # ← 你负责的
    ├── context.ts       # ← 你负责的
    └── directory.ts     # ← 你负责的
```

## 每个文件必须导出

```ts
export function registerXxxTools(server: McpServer, ctx: ToolContext): void
```

函数名已在 `tools/index.ts` 里写死，对不上就编译失败。

## registerTool 的确切签名

SDK 版本 `@modelcontextprotocol/sdk@1.32.2`。`server.tool()` 已废弃，**只能用 `registerTool`**：

```ts
server.registerTool(
  'feishu_send_text',                    // 工具名，snake_case，feishu_ 前缀
  {
    title: '发一条文本',                   // 人类可读标题
    description: '...',                   // 给模型看的说明，写清「什么时候用、什么时候别用」
    inputSchema: {                        // zod raw shape（不是 z.object()）
      target: z.string().optional().describe('...'),
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  async ({ target }) => {                 // 参数已按 inputSchema 类型化
    return ok('结果文本', { structured: 1 });
  },
);
```

`inputSchema` 是 **raw shape**：`{ a: z.string() }`，**不要**写成 `z.object({...})`。

## 返回

只用 `./types.js` 里的两个函数，不要手写 content 数组：

```ts
import { ok, fail, type ToolContext } from './types.js';

return ok('已发送（message_id=om_xxx）', { message_id: 'om_xxx' });  // 成功
return fail('发送失败：...');                                       // 失败（isError=true）
```

## 硬性要求

1. **绝不许 `console.log`**。stdout 是 MCP 的 JSON-RPC 通道，写了就会破坏协议。要日志用 `ctx.log(...)`（它写 stderr）。
2. **错误必须被捕获**。每个 handler 整体包 `try/catch`，catch 里返回 `fail()`，不要往上抛。
3. **权限错误要给可执行的提示**。`FeishuApiError` 有 `isPermission` 和 `missingScopes`：

   ```ts
   if (err instanceof FeishuApiError && err.isPermission) {
     return fail(`权限不足，需要在开放平台开通：${err.missingScopes.join(', ')}`);
   }
   ```

4. **description 用中文，且写清使用场景**。模型靠它决定调不调。反例：`"发送消息"`。正例：`"发一条纯文本到指定会话。适合结论、提示、短回复；超过 30 行或需要排版时改用 feishu_send_card。"`
5. **文件路径一律 `path.resolve()`**，不要拼接字符串。
6. **不要新增依赖**。可用：`node:*`、`zod`、`@yisang0910/core`、`@modelcontextprotocol/sdk`。
7. **不要改** `server.ts` / `tools/index.ts` / `tools/types.ts` / `packages/core/**`。需要新能力就在自己的文件里本地实现，或直接用 `ctx.client` 已有的方法。
8. **TypeScript 严格模式**：`strict: true` + `noUncheckedIndexedAccess: true`。数组下标取值要判空。

## 可用的 client 方法（`ctx.client`）

```ts
// 发
sendText(target, text): Promise<{ messageId, chatId, msgType }>
sendCard(target, card): Promise<{ messageId, chatId, msgType }>
updateCard(messageId, card): Promise<void>
recallMessage(messageId): Promise<void>
sendFile(target, filePath, fileName?): Promise<{ messageId, fileKey, bytes, ... }>
sendImage(target, imagePath): Promise<{ messageId, imageKey, bytes, ... }>
uploadFile(filePath, fileName?): Promise<{ key, fileName, bytes }>
uploadImage(filePath): Promise<{ key, fileName, bytes }>

// 读
listMessages(chatId, { pageSize?, sort?, startTimeSec?, endTimeSec?, pageToken? })
  : Promise<{ items: FeishuMessage[], hasMore, pageToken? }>
getMessage(messageId): Promise<FeishuMessage | null>

// 资源
downloadMessageResource(messageId, fileKey, 'image'|'file', destPath): Promise<DownloadResult>

// 会话
listChats({ pageSize? }): Promise<FeishuChat[]>
listMembers(chatId, pageSize?): Promise<FeishuUser[]>
botInfo(): Promise<BotInfo>
```

`target` 类型是 `SendTarget = string | { id, idType? }`，传 `undefined` 时用 `ctx.config.defaultChatId`。

## 卡片模板（`@yisang0910/core` 已提供）

```ts
progressCard({ task, steps, visibleSteps?, footer?, title?, tone? })
resultCard({ ok, body, footer?, title? })
infoCard({ title, fields: [{label, value}], footer?, tone? })
askCard({ question, options?, token, footer? })
approvalCard({ title, detail, token, footer? })
chatListCard({ chats: [{chatId, name, memberCount?}], footer? })
escapeMd(str)
FeishuApiError
```

所有卡片都带 `config.update_multi = true`，可以用 `updateCard` 原地刷新。

## 验证

改完必须自己跑：

```bash
cd D:\dsh-feishu
pnpm --filter @yisang0910/core build
pnpm --filter @yisang0910/mcp typecheck
```

`typecheck` 零错误才算完成。**不要跑 `pnpm install`**（依赖已装好）。
