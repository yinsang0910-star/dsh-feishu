# 长连接网关（A 阶段）

## 它解决什么

MCP 是**请求-响应**模型：工具调用了就得返回，拿不到飞书的推送。这带来两个具体毛病：

1. **`feishu_ask` 的按钮是装饰** —— 用户点了按钮，没有进程在听 `card.action.trigger`，所以只有「打字回复」这一条路能拿到答案。
2. **两个 `feishu_ask` 并发时会互相偷答案** —— 只能靠「baseline 之后的第一条非机器人消息」这种启发式匹配，先回的那句话会被两边都当成答案。

网关就是一个常驻进程，持有 WebSocket 长连接，把「按钮点了」这件事按 **token** 精确投递给对应的那次提问。

## 两种运行模式

### 模式一：NO_WS（推荐，也是当前生产用的）

`FEISHU_GATEWAY_NO_WS=1` —— 网关**不持有长连接**，只开着 HTTP，当「答案中转站」。

适用场景：**已经有别的东西持有长连接**。在 600G2 这套里就是 `/opt/feishu-bot` 的 Python bot —— 它本来就在处理 `card.action.trigger`（用于审批按钮），只要让它把 `answer` 类型的按钮转发过来即可：

```python
# bot.py 的 on_card_action 里
ask_token = str(val.get("token") or "")
if act == "answer" and ask_token:
    r = gateway_post("/answer", {
        "token": ask_token,
        "text": str(val.get("answer") or ""),
        "via": "button",
        "by": by,
    })
    if r and r.get("accepted"):
        mark_ask_answered(ev.context.open_message_id, answer_text, by)  # 卡片改成「已回答」
```

**好处**：同一个飞书应用的多条长连接会争抢事件，这样只保留一条，零冲突。生产环境实测通过（2026-10-30）。

### 模式二：自持长连接

不带 `FEISHU_GATEWAY_NO_WS` 时，网关自己连 WebSocket，订阅 `card.action.trigger` 和（可选）`im.message.receive_v1`。

适用场景：没有别人持有长连接。**这时必须先停掉旧 bot**，否则事件会被两边争抢。

## ⚠️ 两模式不能混

- 模式二和旧 bot 同时跑 → 事件随机丢失
- 模式一 + bot 转发 → 正确用法

## 架构（模式一）

```
飞书服务端
   │  WebSocket（只有 bot.py 这一条）
   ▼
feishu-bot（Python，PVE）
   ├─ 消息 → DSH（原有职责不变）
   └─ card.action.trigger
        ├─ 审批按钮 → 自己处理
        └─ answer 按钮 → POST http://<agent>:18642/answer
                              │
                              ▼
                    feishu-gateway（NO_WS，agent 上）
                              ▲
                              │ /watch → /answer → /forget
                              │
                       feishu-mcp（每个 DSH 会话一个）
                              │
                       feishu_ask：先问网关（毫秒级），再轮询消息兜底
```

**网关没跑也不影响使用**：`gateway-client` 探测超时 800ms，探不到就走原来的纯轮询路径，只是按钮回到「装饰」状态。

## 切换步骤

### 1. 打包

```bash
pnpm build:single
pnpm exec esbuild packages/gateway/src/index.ts \
  --bundle --platform=node --format=esm --target=node20 \
  --outfile=dist-single/dsh-feishu-gateway.mjs \
  --external:bufferutil --external:utf-8-validate
```

产出约 6 MB（含飞书 SDK + protobuf）。

### 2. 部署到目标机

```bash
scp dist-single/dsh-feishu-gateway.mjs user@host:~/.local/bin/dsh-feishu-gateway.mjs
```

### 3. 写 systemd unit

`/etc/systemd/system/dsh-feishu-gateway.service`：

```ini
[Unit]
Description=DSH Feishu Gateway (WebSocket long connection)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=agent
EnvironmentFile=/home/agent/.config/dsh/feishu.env
Environment=FEISHU_GATEWAY_PORT=18642
Environment=FEISHU_GATEWAY_EVENTS=all
ExecStart=/opt/node/bin/node /home/agent/.local/bin/dsh-feishu-gateway.mjs
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

### 4. 停旧 bot、起网关（顺序不能反）

```bash
systemctl stop feishu-bot
systemctl disable feishu-bot          # 确认不再需要它了再执行
systemctl daemon-reload
systemctl enable --now dsh-feishu-gateway
systemctl status dsh-feishu-gateway
```

### 5. 验证

```bash
curl -s http://127.0.0.1:18642/health
# {"ok":true,"uptimeMs":...,"events":0,"pendingAsks":0,"cachedMessages":0}

journalctl -u dsh-feishu-gateway -f
# 然后在飞书里点一下任何卡片的按钮，应该看到 card.action.trigger 日志
```

再让模型跑一次 `feishu_ask`，点按钮 —— 应该秒回，而不是等到超时。

### 6. 回滚

```bash
systemctl disable --now dsh-feishu-gateway
systemctl enable --now feishu-bot
```

MCP 侧不用改：探不到网关会自动降级。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `FEISHU_GATEWAY_PORT` | `18642` | 本地 HTTP 端口 |
| `FEISHU_GATEWAY_HOST` | `127.0.0.1` | 绑定地址，别改成 `0.0.0.0` |
| `FEISHU_GATEWAY_EVENTS` | `all` | `all` = 卡片回调 + 消息事件；`card` = 只收卡片回调 |
| `FEISHU_GATEWAY_URL` | `http://127.0.0.1:18642` | **MCP 侧**用它找网关 |

`FEISHU_GATEWAY_EVENTS=card` 能少一点事件争抢，但**不能完全避免**（长连接本身还是多连）。

## HTTP 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | `{ok, uptimeMs, events, pendingAsks, cachedMessages}` |
| POST | `/watch` | `{token, chatId, question, baselineSec?}` 登记一个待答提问 |
| GET | `/answer?token=` | `{answered, known, text?, via?, by?}` |
| POST | `/forget` | `{token}` 主动清掉 |
| GET | `/recent?chat_id=&limit=` | 网关缓存的消息（比拉 API 快，且不受读权限限制） |

## 还没做的

- **没有持久化**：进程重启，待答提问和消息缓存全丢（设计如此：这里存的是"正在进行的事"，不是账本）。
- **没有多实例保护**：两个网关同时跑会互相抢连接。用 systemd 的 single-instance 语义保证只有一个。
- **`/recent` 的缓存只有内存里最近 500 条**，且重启即空。

## 测试

```bash
node scripts/test-gateway.mjs
```

11 项：health、watch/answer、**并发两问不串答案**、消息兜底只在唯一待答时生效、早于 baseline 不算、forget、recent、404。全部不连飞书，只测 HTTP 层 + state。
