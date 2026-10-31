# @yisang0910/gateway

常驻小服务：把飞书卡片按钮的点击，精确投递给正在等回答的那次 `feishu_ask`。

默认 `NO_WS=1`，**不持有长连接**——长连接留给机器人，避免同一个应用的多条连接互抢事件。

```bash
FEISHU_GATEWAY_TOKEN=xxx node dist/index.js
```

接口：`/health` `/watch` `/answer` `/forget` `/recent`。

主仓库：[yinsang0910-star/dsh-feishu](https://github.com/yinsang0910-star/dsh-feishu) · MIT