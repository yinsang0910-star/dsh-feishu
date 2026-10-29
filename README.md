# dsh-feishu

把飞书变成 DeepSeek Harness 的操作界面 —— MCP server + 官方插件。

模型在飞书里说话、发文件、读上下文、停下来等人拍板；你在飞书客户端里就能把 agent 当同事用。

---

## 核心卖点：和 `@larksuiteoapi/lark-mcp` 是互补，不是重复

`@larksuiteoapi/lark-mcp` 做的是**广度**：把飞书 OpenAPI 的几百个接口按元数据一股脑摊给模型，覆盖面极大。

但它有四个结构性缺口，而这四个恰好是「把 IM 当 agent 界面」最要紧的部分：

| 缺口 | 具体表现 | dsh-feishu 补的东西 |
| --- | --- | --- |
| **① 发本地文件** | lark-mcp 压根没有 `im.v1.file.create` / `im.v1.image.create` 这条链——它无法把本地磁盘上的文件传进会话 | `feishu_send_file` / `feishu_send_image`：本地路径 → 上传 → 发消息，一条工具搞定 |
| **② 会话上下文** | lark-mcp 给你「列消息」的原始接口，但不给「我刚才在跟谁说话、之前聊到哪了」这种能直接读的形态 | `feishu_recent`：拉最近 N 条，按时间正序拍平成 `[时间] 发送人：内容`，模型一眼能读 |
| **③ 阻塞式提问** | 标准 MCP 是请求-响应，工具必须立刻返回；lark-mcp 没有任何「等人回答」的能力 | `feishu_ask`：发一张带选项的卡片，然后轮询等人用文字回一句，把答案带回来 |
| **④ 卡片原地更新** | lark-mcp 只会「发」卡片，不会「改」卡片，进度只能靠刷屏 | `feishu_update_card`：`config.update_multi = true` 的卡片可以反复原地刷新，聊天里只留一个气泡 |

这四条加起来就是本项目的存在理由。如果你的需求是「用脚本批量调飞书 OpenAPI」，用 lark-mcp 更省事；如果你的需求是「让 agent 像个人一样在飞书里干活」，缺的正是上面这四块。

配套的还有两件小事：卡片模板（`progressCard` / `resultCard` / `askCard` / `chatListCard` 等）和统一的错误翻译（`FeishuApiError.isPermission` + `missingScopes`，权限不足时直接把该开的 scope 打给模型看）。

---

## 工具清单

共 **13** 个工具。工具名在 MCP 客户端里会带前缀，形如 `mcp__feishu__feishu_send_text`（`feishu` 是挂载时的 `serverName`）。

### 身份与卡片（`packages/mcp/src/tools/base.ts`）

| 工具 | 作用 | 关键参数 |
| --- | --- | --- |
| `feishu_whoami` | 机器人是谁、默认往哪发、能发到哪些群 | — |
| `feishu_send_info_card` | 把「标签 + 值」渲染成信息卡发出 | `title`、`fields[]`、`footer?`、`target?` |

### 发消息（`packages/mcp/src/tools/messages.ts`）

| 工具 | 作用 | 关键参数 |
| --- | --- | --- |
| `feishu_send_text` | 发一条纯文本 | `text`、`target?` |
| `feishu_send_card` | 发一张交互卡片（原样提交卡片 JSON） | `card`、`target?` |
| `feishu_update_card` | 原地更新已发出的卡片，不新增气泡 | `message_id`、`card` |
| `feishu_reply` | 引用回复某条消息 | `message_id`、`text` |

### 文件（`packages/mcp/src/tools/files.ts`）

| 工具 | 作用 | 关键参数 |
| --- | --- | --- |
| `feishu_send_file` | 本地文件发进会话（单文件上限 30MB，支持批量 + caption） | `path`、`paths?`、`name?`、`caption?`、`target?` |
| `feishu_send_image` | 本地图片发进会话（png/jpg/jpeg/gif/webp/bmp，单张 10MB） | `path`、`caption?`、`target?` |
| `feishu_download` | 把消息里的附件下载到本地，返回绝对路径 | `message_id`、`file_key?`、`dest_dir?`、`kind?` |

### 会话上下文（`packages/mcp/src/tools/context.ts`）

| 工具 | 作用 | 关键参数 |
| --- | --- | --- |
| `feishu_recent` | 读会话最近消息，时间正序，默认过滤机器人自己发的 | `chat_id?`、`limit?`、`since_minutes?`、`include_bot?`、`format?` |
| `feishu_ask` | 发问并**阻塞**等人回答。网关在跑时按钮点了就返回；否则轮询文字回复（默认 120s，上限 600s） | `question`、`options?`、`chat_id?`、`timeout_seconds?`、`poll_interval_seconds?` |

### 通讯录（`packages/mcp/src/tools/directory.ts`）

| 工具 | 作用 | 关键参数 |
| --- | --- | --- |
| `feishu_chats` | 列出机器人所在的会话（只回文本，不发消息） | `limit?`（默认 20，上限 100）、`with_members?` |
| `feishu_members` | 列出某个会话的成员（名字 + open_id） | `chat_id?`、`limit?`（默认 50，上限 100） |

### 多维表格与电子表格（`packages/mcp/src/tools/bitable.ts`）

| 工具 | 作用 | 关键参数 |
| --- | --- | --- |
| `feishu_bitable_tables` | 列出一张多维表格里的数据表 | `app_token` |
| `feishu_bitable_fields` | 字段定义 + 类型码 + 该类型该传什么形态 | `app_token`、`table_id` |
| `feishu_bitable_records` | 查记录，单元格渲染成人话，支持翻页 | `app_token`、`table_id`、`limit?`、`page_token?` |
| `feishu_bitable_add` | 新增记录 | `app_token`、`table_id`、`fields` |
| `feishu_bitable_update` | 按 `record_id` 部分更新 | `app_token`、`table_id`、`record_id`、`fields` |
| `feishu_sheet_create` | 新建电子表格，回 token + 链接 | `title`、`folder_token?` |

### 文档 / 云空间 / 知识库 / 通讯录（`packages/mcp/src/tools/docs.ts`）

| 工具 | 作用 | 关键参数 | 需要的 scope |
| --- | --- | --- | --- |
| `feishu_drive_list` | 列云空间文件，类型翻中文并提示下一步该用哪个工具 | `folder_token?`、`limit?` | `drive:drive` |
| `feishu_doc_read` | 读文档纯文本 | `document_id`、`max_chars?` | `docx:document:readonly`（**当前未开通**） |
| `feishu_doc_create` | 新建文档 | `title`、`folder_token?` | `docx:document:create`（**当前未开通**） |
| `feishu_wiki_spaces` | 列知识库空间（空列表会解释原因） | `limit?` | `wiki:wiki:readonly` |
| `feishu_wiki_node` | 查节点详情 / 列子节点 | `token?`、`space_id?` | `wiki:wiki:readonly` |
| `feishu_user_lookup` | 邮箱·手机 → open_id，或按 open_id 查详情 | `emails?`、`mobiles?`、`open_id?` | `contact:user.id:readonly` |

---

## 快速开始

### 1. 环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `FEISHU_APP_ID` | ✅ | 自建应用 App ID（`cli_` 开头） |
| `FEISHU_APP_SECRET` | ✅ | 自建应用 App Secret |
| `FEISHU_DEFAULT_CHAT_ID` | 建议 | 不显式传 `target` 时往这里发（`oc_` 开头） |
| `FEISHU_DOMAIN` | 可选 | 默认 `https://open.feishu.cn`；Lark 国际版填 `https://open.larksuite.com` |
| `FEISHU_DEFAULT_RECEIVE_ID_TYPE` | 可选 | 默认 `chat_id`，可选 `open_id` / `email` / `user_id` / `union_id` |

也兼容 `LARK_APP_ID` / `LARK_APP_SECRET` / `LARK_DEFAULT_CHAT_ID` / `LARK_DOMAIN`。
`.env.example` 里有模板；secret 只走环境变量，不落盘、不进仓库。

### 2. 安装与构建

```bash
cd D:\dsh-feishu
pnpm install
pnpm build
```

只改 MCP 包时的常用命令：

```bash
pnpm --filter @dsh-feishu/core build
pnpm --filter @dsh-feishu/mcp typecheck
pnpm --filter @dsh-feishu/mcp dev        # tsx 直跑 src/server.ts，便于调试
node scripts/smoke.mjs                   # 端到端冒烟（默认只跑只读工具）
node scripts/smoke.mjs --write           # 额外真发消息到 FEISHU_DEFAULT_CHAT_ID
```

### 3. 挂到 DSH 上

编辑你 profile 的 `cordis.patch.yml`（例如 `~/.dsh/profiles/web/cordis.patch.yml`），加一个 `mcp-client` 实例：

```yaml
- insert:
    - id: feishu
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: stdio
        serverName: feishu
        command: node
        args: ['D:/dsh-feishu/packages/mcp/dist/server.js']
        cwd: 'D:/dsh-feishu'
        # feishu_ask 会阻塞最多 600s，工具超时必须比它大
        toolCallTimeoutMs: 660000
        failOnStartupError: false
        env:
          FEISHU_APP_ID: 'cli_xxxxxxxxxxxxxxxx'
          FEISHU_APP_SECRET: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
          FEISHU_DEFAULT_CHAT_ID: 'oc_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
```

要点：

- `serverName: feishu` 决定工具前缀，模型看到的是 `mcp__feishu__feishu_chats` 这类名字；同一 DSH 里多个 MCP server 的 `serverName` 不能重。
- mcp-client 会**清空继承的环境变量**，只保留 `env` 里显式写的内容——所以飞书凭据必须写在这里，别指望 shell 里 `export` 过的值。
- 改完 patch 需要重启 DSH（或触发该 profile 重新加载）才生效。
- 想看全部工具是否都上线，启动后用一次 `feishu_whoami` 试探即可。

---

## 权限清单

在飞书开放平台「权限管理」里给自建应用开以下 scope，改完要**发布版本**才生效：

| scope | 用在哪 |
| --- | --- |
| `im:message:send_as_bot` | 所有发送类工具（文本 / 卡片 / 文件 / 图片 / 引用回复） |
| `im:resource` | `feishu_send_file`、`feishu_send_image`、`feishu_download` 的上传下载 |
| `im:chat` | `feishu_chats`、`feishu_members`（会话列表与成员列表） |
| `im:message.group_msg` | `feishu_recent`、`feishu_ask` 读群聊历史 |
| `im:message.p2p_msg:readonly` | `feishu_recent`、`feishu_ask` 读单聊历史 |

还有两件不体现在 scope 上的事：

- 机器人必须**先被拉进群**（`feishu_chats` 只列它已经加入的会话）。
- 卡片原地更新要求发卡时就带 `config.update_multi = true`，本项目的卡片模板（`@dsh-feishu/core` 的 `cards.ts`）默认都带。

如果 scope 没开对，工具不会静默失败：`FeishuApiError.isPermission` 会命中，`missingScopes` 会把飞书返回的 scope 名直接拼进错误文本，模型能据此提示你「去开哪一项」。

---

## 仓库结构

```
packages/
├── core/          @dsh-feishu/core —— 飞书 API 客户端 + 类型 + 卡片模板（零第三方 HTTP 依赖）
└── mcp/           @dsh-feishu/mcp  —— MCP server，把 core 的能力暴露成 13 个工具
docs/
├── TOOL-CONTRACT.md   写工具前必读的实现契约
└── ARCHITECTURE.md    为什么这么写、关键取舍与已知限制
scripts/
└── smoke.mjs          以 stdio 起 server、走真实 API 的冒烟脚本
```

两条硬约束（改代码前请先记住）：

1. **stdout 只能出 MCP 的 JSON-RPC**。任何 `console.log` 都会破坏协议，日志一律走 `ctx.log`（写 stderr）。
2. **每个工具 handler 整体 try/catch**，异常必须翻译成 `fail(...)` 返回，不许往上抛。

---

## 状态

版本 `0.1.0`，**实验阶段**：接口和工具名还会变，暂不保证向后兼容；生产环境使用请先自己跑一遍 `scripts/smoke.mjs` 并核对权限。

当前仓库只有 `core` + `mcp` 两个包。已知限制（轮询延迟与配额成本、按钮回调不可用、30MB 文件上限、没有多实例锁）在 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 里有详细说明。

## License

MIT
