## 改了什么

<!-- 一句话说清；涉及多个包就分行列 -->

## 怎么验证

<!-- 本地跑了哪些命令；有没有在真机上验证（机器人 / agent 机 / PVE） -->

## 影响面

<!-- 影响哪些包、是否需要重新部署、是否需要迁移配置 -->

## 检查

- [ ] `pnpm typecheck` 通过
- [ ] `pnpm test` 通过
- [ ] `pnpm build` 与 `pnpm build:single` 通过
- [ ] 改了 `services/feishu-bot/bot.py`：在 PVE 上验证过真实收发，并记录了回滚用的备份文件名
- [ ] 新增 MCP 工具已在 `packages/mcp/src/tools/index.ts` 注册
- [ ] 相关文档已更新（`docs/` 与 README 索引）
- [ ] diff 里没有凭据、真实 ID 与 `.tmp/` 内容
