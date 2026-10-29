# 长连接网关（A 阶段）

## 它解决什么

MCP 是**请求-响应**模型：工具调用了就得返回，拿不到飞书的推送。这带来两个具体毛病：

1. **`feishu_ask` 的按钮是装饰** —— 用户点了按钮，没有进程在听 `card.action.trigger`，所以只有「打字回复」这一条路能拿到答案。
2. **两个 `feishu_ask` 并发时会互相偷答案** —— 只能靠「baseline 之后的第一条非机器人消息」这种启发式匹配，先回的那句话会被两边都当成答案。

网关就是一个常驻进程，持有 WebSocket 长连接，把「按钮点了」这件事按 **token** 精确投递给对应的那次提问。

## 架构

```
飞书服务端
   │  WebSocket（长连接）
   ▼
feishu-gateway（常驻，1 个进程）
   ├─ card.action.trigger  ──► 按 token 投递答案
   ├─ im.message.receive_v1 ─► 缓存最近消息 + 唯一待答时兜底认领
   └─ HTTP 127.0.0.1:18642
            ▲
            │ /watch → /answer → /forget
            │
   feishu-mcp（每个 DSH 会话一个，短生命周期）
            │
        feishu_ask：先问网关（毫秒级），再轮询消息兜底
```

**网关没跑也不影响使用**：`gateway-client` 探测超时 800ms，探不到就走原来的纯轮询路径，只是按钮回到「装饰」状态。

## ⚠️ 切换前必须知道的冲突

**同一个飞书应用的多条长连接会争抢事件。** 网关和旧的 Python bot（`/opt/feishu-bot`）同时跑，消息事件会随机分给其中一个 —— 表现就是「有时收到、有时收不到」。

所以：

- **网关不接管生产之前，不要启动它**（本仓库交付时它就是没启动的状态）
- 真要切换，必须**先停旧 bot**

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
