# feishu-bot — G2 Agent 的飞书长连接机器人

飞书里那个「G2 Agent / 咪咪喵喵教」就是它。跑在 PVE（192.168.1.10）的 `/opt/feishu-bot/bot.py`，
用飞书官方 `lark_oapi` **长连接**（WSClient）收消息，SSH 到 agent（192.168.1.20）执行
`dsh-task --profile headless`，把结果回飞书。

```
飞书 App ──长连接──> bot.py (PVE 200:feishu-bot.service)
                        │  ssh -i /root/.ssh/agent_rsa
                        ▼
                    dsh-task (agent 205) ──> dsh --profile headless
                        │                        └─ feishu MCP（25 工具）
                        └─ pushfile / feishu_push.py  ──> 飞书发文件
                        │
                        └─ HTTP :18642 ──> dsh-feishu-gateway（卡片问答回传）
```

## 为什么这个文件在仓库里

它之前**只存在于 PVE 上**，靠手改 + `systemctl restart`，仓库里只有一篇 `docs/BOT-INTEGRATION.md`
描述「改了什么」。也就是说：真源码没有版本历史、没有 diff、谁改的都查不到，机器一坏就全没了。

现在的关系是：**仓库是源，PVE 的 `/opt/feishu-bot/` 是运行副本**。
改代码改这里，然后用 `deploy.ps1` 推上去。

## 文件

| 文件 | 说明 |
| --- | --- |
| `bot.py` | 机器人本体（61877 字节，与 PVE 线上 md5 一致）。**唯一需要改的文件** |
| `config.example.json` | `config.json` 的模板，敏感值全部占位 |
| `config.env.example` | `config.env` 的模板（飞书 App ID / Secret） |
| `deploy.ps1` | 一键部署 / 检查 / 回滚 |

**不进仓库**（PVE 上就地维护，权限 0600）：
- `/opt/feishu-bot/config.json` — 白名单 open_id、群 chat_id、setup_token、gateway_token
- `/opt/feishu-bot/config.env` — `FEISHU_APP_ID` / `FEISHU_APP_SECRET`，由 systemd `EnvironmentFile=` 注入

## 部署

```powershell
. <你的 vmctl.ps1>    # 它负责设置 $PLINK / $HOSTKEY / $PASSWORD
cd <仓库>\services\feishu-bot

.\deploy.ps1 -Check      # 只比对：PVE 上跑的和仓库里的是不是同一份
.\deploy.ps1             # 部署：备份 → 上传 → 校验 → 重启 → 健康检查
.\deploy.ps1 -Force      # md5 相同也强制重传重启
.\deploy.ps1 -Rollback   # 回滚到上一份备份
```

部署脚本做四件事，任一步失败都不留下半坏状态：

1. **md5 比对** — 相同就跳过（`-Force` 除外）
2. **先备份** — `/root/bot-backup/bot.py.<时间戳>`，这是唯一的回滚依据
3. **上传后校验** — base64 分块传（避开 plink 命令行长度上限），落地后重算 md5，不符就不替换线上文件
4. **健康检查 + 自动回滚** — `systemctl is-active` + `pgrep` 进程数 + 最近 20 秒日志里有没有
   `Traceback|ImportError|SyntaxError`；任一不过就 `cp` 回备份并重启

> **铁律：改了 `bot.py` 就跑 `.\deploy.ps1`。** 不跑的话飞书上还是旧行为，而且你会以为改动没生效。

## 配置项（`config.json`）

| 键 | 说明 |
| --- | --- |
| `allowed_open_ids` | 白名单，只有这些 open_id 能用机器人；`/claim <setup_token>` 可自助认领并拉进群 |
| `setup_token` | 认领口令，泄露等于把机器人送人 |
| `report_hour` | 每日汇报的整点（本地时间） |
| `soft_timeout_sec` | 单任务软超时，1800 秒 |
| `max_inline_lines` | 超过这么多行才走「发文件」而不是发文本（30） |
| `agent_host` / `agent_user` / `agent_key` | SSH 目标与私钥 |
| `agent_cwd` / `agent_root` | agent 上的工作目录 |
| `dsh_cmd` | `dsh-task` 包装脚本的绝对路径 |
| `pve_host` | 留给 PVE 侧操作的地址 |
| `group_chat_id` / `report_chat_id` | 指挥群 / 汇报群（当前是同一个） |
| `gateway_url` / `gateway_token` | 卡片问答回传网关（`dsh-feishu-gateway`，agent 侧 :18642） |

## 和 MCP / gateway 的分工

- **bot.py**：飞书收发、白名单、队列、进度卡、斜杠命令。它**不直接调本仓库的 25 个 MCP 工具**——
  那是 agent 进程内部的工具。
- **`dsh-feishu-mcp`**（本仓库 `packages/mcp`）：装在 agent 的 headless profile 里，给模型用。
- **`dsh-feishu-gateway`**（`packages/gateway`）：常驻进程，只负责把卡片按钮点击精确投递给正在等回答的
  MCP 调用（`/watch` → `/answer`）。以 `FEUISHU_GATEWAY_NO_WS=1` 运行，不碰长连接，避免和 bot.py 抢事件。
- **`pushfile`**（agent 上 `~/.local/bin`）：agent 发本地文件给飞书的唯一通道，因为 `dsh --json` 只回传文本流。

## 已知缺口（有意不补）

`@larksuiteoapi/lark-mcp` 曾经并存，2026-10-30 撤掉（每轮省 6 个工具、少 109M）。
它比自研多两个能力，**都没有实现，也从未被调用过**：

- `im.v1.chat.create` — 建群
- `docx.builtin.import` — 把本地 md/docx 导入成飞书云文档（`feishu_doc_create` 只能新建并写纯内容）

真需要时再补进 `packages/mcp/src/tools/docs.ts` / `directory.ts`，接口和 scope 都已确认可用。

## 相关文档

- `docs/BOT-INTEGRATION.md` — bot.py 与网关对接的那部分改动
- `docs/GATEWAY.md` — 网关协议与部署
- `docs/ARCHITECTURE.md` — MCP / core / gateway / plugin 的分层
