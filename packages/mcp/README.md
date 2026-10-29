# @dsh-feishu/mcp

把飞书接进 agent 的 MCP server（stdio，25 个工具）。

突出四件在别处拿不到的事：**把本地文件真的发进会话**、**让进度卡片原地刷新**、
**发问并阻塞等到回答**、**读会话上下文**。

```bash
node dist/server.js
```

环境变量：`FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`FEISHU_DEFAULT_CHAT_ID`。

主仓库：[yinsang0910-star/dsh-feishu](https://github.com/yinsang0910-star/dsh-feishu) · MIT