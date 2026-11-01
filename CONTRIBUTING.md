# 参与开发

提 issue 或 PR 之前，先读这一页。

## 环境

- Node.js ≥ 22.13（`node:sqlite` 需要），pnpm 11+
- Python 3.10+（只用于 `services/feishu-bot`，它不依赖本仓库的 TypeScript 包）
- 一台能 SSH 到的 Linux 机器（跑 agent 与机器人），本机可以是 Windows / macOS / Linux

```bash
pnpm install
pnpm build:core     # 其余包类型检查依赖 core 的 dist
pnpm typecheck
pnpm test
pnpm build
```

## 目录

| 路径 | 作用 |
| --- | --- |
| `packages/core` | 飞书 OpenAPI 客户端与类型，无副作用 |
| `packages/mcp` | stdio MCP server，36 个工具 |
| `packages/dsh-plugin` | DSH 插件：设置页向导、自检、profile patch |
| `packages/gateway` | 卡片回调网关 |
| `services/feishu-bot` | 长连接机器人（Python） |
| `services/agent-workspace` | agent 机上的安装脚本 |
| `docs` | 逐篇说明，README 只做索引 |

## 提交前

```bash
pnpm typecheck && pnpm test && pnpm build && pnpm build:single
```

- CI 会跑同样的步骤，外加 `scripts/test-gateway.mjs` 与打包冒烟。本地全绿再推。
- 改了 `packages/core` 的公开接口，`pnpm build:core` 之后要确认 `packages/mcp` 仍能通过类型检查。
- 改了 `services/feishu-bot/bot.py`，至少跑一次 `python -m py_compile`，并在 PVE 上验证一次真实收发（见 `docs/DEPLOY.md`）。

## 约定

- 提交信息用 `feat:` / `fix:` / `docs:` / `chore:` / `test:` 前缀，一句话说清做了什么。
- 新增 MCP 工具必须在 `packages/mcp/src/tools/index.ts` 注册，否则 `tools/list` 里看不到；工具名统一 `feishu_` 前缀，描述用中文、不超过 12 字。
- 破坏性工具（删除、解散、撤回）要在 schema 里要求 `confirm`，并在 `docs/MCP-TOOLS.md` 标 ⚠️。
- 文档改完检查相对链接有效；README 只保留索引与最短路径，细节写进 `docs/`。
- 不要提交 `.tmp/`、`__pycache__/`、`.publish/`、任何凭据文件（`.env`、`config.env`、`feishu.env`）。

## 安全相关

App Secret、open_id、设备授权二维码都属于敏感信息，不要贴进 issue、截图或提交历史。详见 [SECURITY.md](SECURITY.md)。
