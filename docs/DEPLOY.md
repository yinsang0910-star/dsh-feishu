# 部署说明

三种部署形态，按场景选。

## 形态 A：给 DSH 用（单文件 bundle，推荐）

单文件 = 没有 node_modules，拷过去就能跑。适合要塞进另一个机器（比如 600G2 的 agent 工作站）的场景。

### 1. 打 bundle

```bash
pnpm install
pnpm build
pnpm build:single          # 产出 dist-single/dsh-feishu-mcp.mjs（约 1.4 MB）
```

### 2. 拷到目标机

```bash
scp dist-single/dsh-feishu-mcp.mjs user@host:/home/user/.local/bin/dsh-feishu-mcp.mjs
```

### 3. 写密钥文件

`~/.config/dsh/feishu.env`（`chmod 600`）：

```bash
FEISHU_APP_ID=cli_xxxxxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
FEISHU_DEFAULT_CHAT_ID=oc_xxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

### 4. 写启动包装

`~/.local/bin/dsh-feishu-mcp`（`chmod 755`）：

```bash
#!/usr/bin/env bash
set -a
. "$HOME/.config/dsh/feishu.env"
set +a
exec /path/to/node "$HOME/.local/bin/dsh-feishu-mcp.mjs"
```

**为什么要这层包装**：密钥不落进任何会被提交的 YAML；而 DSH 启动 MCP 子进程时会清洗环境（删掉名字里带 `SECRET` / `TOKEN` 的变量），包装在自己进程内 source 就不受影响。

### 5. 挂进 DSH profile

编辑 `~/.dsh/profiles/<profile>/cordis.patch.yml`，**注意必须用 `- insert:` 块**（平铺的 `- id:` 是"修改已存在的条目"，写新的会报 `patch: entry "xxx" not found`）：

```yaml
- insert:
    - id: mcp-feishu
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: feishu
        transport: stdio
        command: /home/user/.local/bin/dsh-feishu-mcp
        args: []
        toolCallTimeoutMs: 660000     # 必须 ≥ 600s：feishu_ask 最多阻塞 600 秒
        failOnStartupError: false     # MCP 起不来也不拖死 harness
```

工具会以 `mcp__feishu__feishu_send_file` 这种名字出现在模型工具表里。

### 6. 验证

```bash
# 配置能被解析吗
dsh --profile <profile> --dump-config | grep -A9 mcp-feishu

# 工具注册了吗（让模型自己报）
echo '你有哪些 mcp__feishu__ 开头的工具？只列名字。' | dsh --profile <profile> --json -
```

## 形态 B：源码方式（开发用）

```bash
git clone <repo>
pnpm install
pnpm build
FEISHU_APP_ID=... FEISHU_APP_SECRET=... node packages/mcp/dist/server.js
```

`cordis.patch.yml` 里把 `command` 改成 `node`、`args` 改成 `["/abs/path/packages/mcp/dist/server.js"]`，`env` 里直接给三个变量。

## 形态 C：其他 MCP 客户端

任何支持 stdio 的 MCP 客户端（Claude Code / Cursor / Cline …）都能用，标准配置：

```json
{
  "mcpServers": {
    "feishu": {
      "command": "node",
      "args": ["/abs/path/dist-single/dsh-feishu-mcp.mjs"],
      "env": {
        "FEISHU_APP_ID": "cli_xxx",
        "FEISHU_APP_SECRET": "xxx",
        "FEISHU_DEFAULT_CHAT_ID": "oc_xxx"
      }
    }
  }
}
```

注意 `feishu_ask` 会阻塞到 600 秒，客户端自身的工具超时要放宽。

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `FEISHU_APP_ID` | ✅ | 自建应用 App ID（也可用 `LARK_APP_ID`） |
| `FEISHU_APP_SECRET` | ✅ | App Secret（也可用 `LARK_APP_SECRET`） |
| `FEISHU_DEFAULT_CHAT_ID` | 建议 | 不显式给 `target` 时往这里发 |
| `FEISHU_DOMAIN` | — | 默认 `https://open.feishu.cn`；Lark 国际版填 `https://open.larksuite.com` |
| `FEISHU_DEFAULT_RECEIVE_ID_TYPE` | — | 默认 `chat_id`，可选 `open_id`/`email`/`user_id`/`union_id` |
| `FEISHU_CONFIG` | — | JSON 配置文件路径（env 优先） |

## 需要的飞书权限

在开放平台「权限管理」开通并**重新发布版本**后才生效：

| scope | 用途 |
|---|---|
| `im:message:send_as_bot` | 发消息 |
| `im:resource` | 上传文件 / 图片 |
| `im:chat` | 查群、群成员 |
| `im:chat:create` | 建群 |
| `im:message.group_msg` | 读群历史（`feishu_recent` / `feishu_ask` 靠它） |
| `im:message.p2p_msg:readonly` | 读单聊历史 |

缺权限时工具会返回 `FeishuApiError.isPermission`，并把飞书给的 `missingScopes` 打进错误信息 —— 照着开就行。

## 验证脚本

```bash
node scripts/smoke.mjs                     # 只读工具（安全）
node scripts/smoke.mjs --write             # 含发送（会真的发到默认会话）
node scripts/smoke.mjs --only=feishu_recent
SMOKE_SERVER=dist-single/dsh-feishu-mcp.mjs node scripts/smoke.mjs   # 测 bundle
node scripts/e2e-download.mjs              # 下载闭环（从群里拉附件）
```

`smoke.mjs` 从仓库根的 `.env` 读配置（`.env` 已在 `.gitignore` 里）。

## 排障

| 现象 | 原因 |
|---|---|
| `patch: entry "mcp-feishu" not found` | YAML 没放在 `- insert:` 之下 |
| 工具表里没有 `mcp__feishu__*` | MCP 启动失败；看 DSH stderr，或先手动跑一次 wrapper |
| 所有工具都报权限不足 | 开放平台开了权限但**没重新发布版本** |
| `feishu_ask` 总是超时 | 用户没回；或群缺 `im:message.group_msg` 读不到回复 |
| 发文件报 30MB | 飞书 IM 硬上限，改发云文档链接 |
