# 架构说明

本文回答三个问题：**为什么要有这个项目**、**代码为什么长成这样**、**现在还不能干什么**。
所有结论都以 `packages/**` 里的实际代码为准；写文档时如果和代码冲突，以代码为准并顺手改文档。

---

## 一、为什么做这个

扫描 DSH 的 MCP 生态后得到一个很直白的结论：

> 30 多个第三方 `dsh-mcp-*` 插件，本质都是「YAML 编辑器」——把某个配置文件读出来、让模型改字段、再写回去。
> 它们解决的是"让模型**碰得到**某个系统"，但没人解决"让**人**碰得到 agent"这一层。

而 agent 真正跑起来之后，最先卡住的不是工具数量，而是这三件事：

1. **它在干什么我看不见** —— 终端日志在服务器上，人不在服务器前。
2. **它要我做决定时找不到我** —— 标准 MCP 是请求-响应，工具必须立刻返回，没有"停下来等人"的原语。
3. **我给它一个文件，它接不住** —— 大量 MCP server 只会传文本，本地磁盘和 IM 之间没有桥。

飞书恰好同时具备这三件事需要的界面：手机/桌面/网页三端同步、卡片可原地刷新（不刷屏）、文件与图片是一等消息类型、群里天然支持多人围观。
所以本项目的定位不是"再包一层飞书 OpenAPI"，而是**把 IM 当成 agent 的操控台**：

- 进度 → 卡片原地刷新；
- 决策 → 阻塞式提问；
- 交付物 → 直接把本地文件甩进会话；
- 上下文 → 读最近聊天，接上人话。

和 `@larksuiteoapi/lark-mcp` 的分工也在这里：那个库覆盖 OpenAPI 的广度（几百个接口），但**不做**发送本地文件（连 `im.v1.file.create` 都没有）、不做会话上下文读取、不做阻塞式提问、不做卡片原地更新。本项目只补这四个缺口，外加把错误翻译成人能照着修的提示。

---

## 二、分层

```
┌──────────────────────────────┐
│ 飞书客户端（手机 / 桌面 / 网页）│  人在这里看进度、点按钮、回一句话、拖文件
└───────────────┬──────────────┘
                │ 人的动作：发消息 / 发文件 / 点卡片按钮
                ▼
┌──────────────────────────────┐
│ 飞书开放平台 OpenAPI          │  tenant_access_token 鉴权，/open-apis/im/...
│ （事件推送走长连接 WebSocket） │  本项目当前只用 HTTP 侧，不订阅事件
└───────────────┬──────────────┘
                │ HTTPS（Node 内置 fetch）
                ▼
┌──────────────────────────────┐
│ @yisang0910/core             │  FeishuClient（请求 / token 缓存 / 重试 / 上传下载）
│                              │  types.ts（数据契约）+ cards.ts（卡片模板）
└───────────────┬──────────────┘
                │ 方法调用（sendText / sendFile / listMessages / listMembers ...）
                ▼
┌──────────────────────────────┐
│ @yisang0910/mcp  server.ts   │  13 个工具；参数校验、错误翻译、结果拍平
│                              │  tools/{base,messages,files,context,directory}.ts
└───────────────┬──────────────┘
                │ stdio 上的 JSON-RPC（**stdout 专供协议**，日志走 stderr）
                ▼
┌──────────────────────────────┐
│ DSH（@deepseek-ai/dsh-mcp-client）│  spawn 子进程、连 server、注册成 mcp__feishu__*
└───────────────┬──────────────┘
                │ 工具调用 / 工具结果
                ▼
┌──────────────────────────────┐
│ 模型                          │  决定调哪个工具、生成什么内容
└──────────────────────────────┘
```

一个来回的时序（以"发一份报告"为例）：

```
模型 → feishu_send_file(path)
     → mcp: 校验路径/大小/后缀
     → core: /im/v1/files (multipart) 拿 file_key
     → core: /im/v1/messages 发 file 消息
     → 飞书客户端里出现文件
模型 ← "已发送文件 report.pdf（1.2 MB）message_id=om_xxx"
```

---

## 三、两个包的职责边界

### `@yisang0910/core` —— 只关心"飞书怎么调"

- **`client.ts`：`FeishuClient`**
  - 只用 Node 内置 `fetch` / `FormData` / `Blob`，不引任何 HTTP 库；
  - `tenant_access_token` 进程内缓存 + **并发去重**（`tokenInFlight`），提前 5 分钟过期；
  - 统一 `request()`，把飞书返回的 `code != 0` 变成 `FeishuApiError`（带 `code` / `path` / `method` / `missingScopes`）；
  - 业务能力：发文本/卡片、原地更新卡片、撤回、上传并发送文件与图片、拉消息历史、取单条消息、下载消息资源、列会话、列成员、机器人自身信息。
- **`types.ts`：数据契约**
  - 飞书原始 JSON → 扁平 camelCase 类型的唯一映射点（`FeishuMessage` / `FeishuChat` / `FeishuUser` ...）；
  - `FeishuApiError.isPermission` / `.missingScopes` 是"权限错误能否被翻译成可执行提示"的关键。
- **`cards.ts`：卡片模板（纯函数，无状态）**
  - `progressCard` / `resultCard` / `infoCard` / `askCard` / `approvalCard` / `chatListCard`；
  - 全部带 `config.update_multi = true`；
  - `escapeMd()` 处理 `* _ ~`，避免用户内容被 `lark_md` 吃掉。

core **不认识** MCP：它不知道工具、`ok/fail`、JSON-RPC 的存在。这样 CLI 脚本、测试、将来的插件都能直接复用同一个客户端。

### `@yisang0910/mcp` —— 只关心"模型怎么用"

- **`server.ts`**：从环境变量读配置 → 建 client → 建 `McpServer` → 注册工具 → 挂 `StdioServerTransport`。启动失败的日志写 stderr 后 `process.exit(2)`，绝不污染 stdout。
- **`tools/types.ts`**：`ToolContext`（client + config + log）和 `ok()/fail()`——所有返回都必须过这两个函数。
- **`tools/*.ts`**：按领域分文件，每个文件导出 `registerXxxTools(server, ctx)`，`tools/index.ts` 负责串起来。
  - `base.ts` 身份与信息卡；
  - `messages.ts` 文本 / 卡片 / 原地更新 / 引用回复；
  - `files.ts` 文件与图片双向通道（含 30MB / 10MB 边界与落盘去重）；
  - `context.ts` 读上下文（`feishu_recent`）与阻塞式提问（`feishu_ask`）；
  - `directory.ts` 会话与成员（`feishu_chats` / `feishu_members`）。
- 这一层做三件事：**参数校验**（zod raw shape + 越界钳制）、**错误翻译**（`FeishuApiError` → 中文可执行提示）、**结果拍平**（飞书 JSON → 模型好读的文本 + `structuredContent`）。

依赖方向是单向的：`mcp → core`。core 不反向依赖，任何时候都能单独 `pnpm --filter @yisang0910/core build`。

---

## 四、关键设计决策

### 1. 不用 lark SDK，自己写 fetch 客户端

理由：

- **零依赖**：`core` 的 `dependencies` 只有 `zod`。lark SDK 会带进一堆传递依赖，而 MCP server 是个会被 DSH 反复 spawn 的子进程，启动体积和冷启动时间是真实成本。
- **可控重试**：重试策略必须我们自己说了算——只对网络层异常重试（连接失败、超时、响应不是 JSON），**飞书返回业务错误码时立即抛出**。因为"权限不足"重试三次只是浪费配额，还会让模型误以为是网络抖动而反复调用。
- **错误码直接暴露**：SDK 往往把 `code` / `msg` 包两三层再吐出来，而我们需要的是原始 `code` 和 `msg` 里的 scope 列表——`missingScopes` 就是从 `msg` 里正则抽出来的，包一层就抽不到了。

代价：飞书新增接口时得自己补映射（`listChats` 只映射了我们用到的字段，就是这个原因）。

### 2. token 缓存必须做并发去重

`tenant_access_token` 的有效期是 2 小时，但**飞书的获取接口有频率限制**，而模型一次任务里经常并发调多个工具（发文本 + 发文件 + 列成员）。

如果每个请求各自去换 token，就会在毫秒级打出 N 次 `auth/v3/tenant_access_token/internal`，轻则变慢，重则被限流（然后整批工具全失败）。

所以 `client.ts` 里用 `tokenInFlight: Promise<string> | null` 做单飞：第一个调用者发请求，其余调用者 `await` 同一个 Promise；拿到后写 `tokenValue` + `tokenExpiresAt`，并留 5 分钟安全边界。另外还有一条兜底：遇到 `99991663` / `99991661`（token 失效）时清缓存、立刻重取、重放一次。

### 3. 卡片模板一律带 `update_multi: true`

理由很硬：飞书的 `PATCH /im/v1/messages/:id` 只对**发出时就声明可更新**的卡片生效。少了这个字段，`feishu_update_card` 会直接报错，于是"进度原地刷新"这个核心用法就不成立。

因此 `cards.ts` 的 `base()` 统一注入：

```ts
config: { wide_screen_mode: true, update_multi: true }
```

模板是纯函数、不带状态，所以同一张卡可以反复用不同内容重建再 `updateCard` 覆盖——长任务只留一个气泡。`feishu_send_card` 还会在返回里告诉模型这张卡到底能不能更新（检测 `card.config.update_multi === true`），避免模型以为能改结果改不了。

### 4. `feishu_ask` 用轮询，而不是长连接

标准 MCP 工具必须 **请求 → 立刻返回**，没有"挂起等人"的原语。要让 agent 真的停下来等人拍板，只有两条路：

- **长连接（WebSocket 事件订阅）**：能收到卡片按钮回调，实时性最好；
- **轮询**：定时去拉新消息，简单、无状态、零额外基础设施。

当前阶段选轮询，理由是**不去抢 bot 的长连接**：一个飞书应用的长连接是独占资源，谁占了就归谁。MCP server 是 DSH spawn 出来的子进程，可能同时存在多个实例（多 profile / 多项目），让它们去争同一条长连接，会把「谁的连接」这件事变成新的故障源。

所以 `feishu_ask` 的实现是：发一张带选项的卡片 → 记下 `baselineSec`（发卡前的秒级时间戳）与卡片自己的 `messageId` → 循环 `listMessages`（默认 3 秒一次），把「创建时间 ≥ 基线、不是自己发的卡片、不是机器人发的」的消息当成回答，取最早的一条返回。话题群里的回复在主容器查不到，所以额外按 `thread_id` 探一次话题容器。

**按钮只是给人看的快捷提示**：没有回调通道，点按钮不产生答案，真正的答案一定是轮询到的文本消息。这一点写进了工具 description，避免模型误以为选项按钮能当返回值。

未来接上事件订阅（长连接）之后，这套轮询可以整体删掉，`feishu_ask` 改成"发卡 → 挂起 → 回调唤醒"，工具签名不用变。

### 5. stdout 只能是 MCP 协议

MCP 的 stdio transport 把 **stdout 当成 JSON-RPC 的帧通道**，一行日志就会让客户端解析失败，表现为"工具全部消失"或连接反复重连。

因此：

- 全仓库禁止 `console.log`（要输出就走 `ctx.log` / `process.stderr.write`）；
- `server.ts` 的 `log()` 写 `process.stderr`；
- 未捕获异常、未处理 rejection、信号处理全部写 stderr；
- 启动期配置错误 → 写 stderr 后 `exit(2)`，不往 stdout 吐任何东西。

这也是为什么本项目的"日志"看起来很少：能进 stdout 的只有协议消息。

---

## 五、已知限制

都是当前实现的真实边界，不是待办清单的美化版：

1. **轮询有延迟和配额成本**：`feishu_ask` 默认 3 秒一轮、每次 1~2 个 `listMessages` 请求；等 120 秒就是约 40 轮请求。间隔调小只会更快耗配额，调大则问答延迟变高。
2. **按钮回调收不到**：没有长连接，卡片上的选项按钮点了没人接，`askCard` 的 `token` / `option` 目前拿不到任何回调。回答只能靠打字。
3. **超时会被当成错误**：`feishu_ask` 超时返回 `isError=true` 的 `fail(...)`（文案里写清了"这不是错误，只是没人回答"）。上下文协议没有"软超时"这种返回形态，这是妥协。
4. **大文件 30MB 上限**：IM 单文件 30MB、图片 10MB，超了直接在本地拦掉并给替代方案（压缩/分片/发链接）。上传本身没有做分片与断点续传。
5. **没有多实例锁**：多个 DSH 实例各 spawn 一个 server，各自缓存自己的 token（彼此不可见）；更要紧的是，同一会话里两个实例同时 `feishu_ask`，双方都会把同一条人工回复当成自己的答案——因为它们只能排除"自己发出的卡片"和"机器人身份的消息"，无法区分"另一个实例的提问"。
6. **会话列表只取一页**：`listChats` 只发一次请求（`page_size` 上限 100），没有自动翻页，机器人加入超过 100 个会话时会列不全。
7. **人数通常显示不出来**：`FeishuChat.memberCount` 字段在类型里存在，但 `listChats` 目前没有映射飞书的 `user_count`，所以 `feishu_chats` 一般不会显示"N 人"（有值才显示，没有就省略——不猜）。要确切人数请用 `feishu_members`。
8. **卡片更新是整张替换**：`feishu_update_card` 提交的是完整卡片，不是补丁；每次都覆盖，历史版本不保留。

---

## 六、想继续往下做的话

按性价比排序（仅记录方向，不代表已实现）：

1. 事件订阅（长连接）→ 干掉轮询，让按钮回调真正可用；
2. `feishu_ask` 的多实例互斥（一张"谁在提问"的锁表，或把 token 写进消息 metadata 后过滤）；
3. `listChats` / `listMembers` 的自动翻页；
4. 上传分片与断点续传，突破 30MB；
5. 群聊里的"只听不说"模式：订阅消息 → 判断是否 @ 机器人 → 自动回复。

改这些之前请先读 `docs/TOOL-CONTRACT.md`：工具签名、错误翻译、stdout 纪律这三条是硬约束。
