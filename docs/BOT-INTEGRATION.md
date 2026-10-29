# 接入现有的 Python bot（600G2 实测记录）

本文记录 2026-10-30 那次改造里，**`/opt/feishu-bot/bot.py` 改了什么**。
那个文件不在本仓库（它在 PVE 宿主上），所以改动留痕在这里，便于回滚和复现。

## 为什么改

`feishu_ask` 的按钮原先只是装饰。原因不是「没有长连接」——**长连接一直有**，就是 bot.py 自己。它注册了 `card.action.trigger` 用于审批按钮，只是没有处理 `answer` 这种类型。

所以不需要停 bot、不需要网关抢长连接，只要让 bot 把 `answer` 转发出去。

## 三处改动

### 1. 配置项

`DEFAULTS` 里加一条：

```python
    "gateway_url": "http://192.168.1.205:18642",
```

同时写进了 `/opt/feishu-bot/config.json`，便于不改代码就调整。

### 2. 转发函数

```python
def gateway_post(path, body, timeout=3):
    """把卡片按钮的答案转给 dsh-feishu 网关（可选组件，失败只记日志）。"""
    base = (CONF.get("gateway_url") or "").rstrip("/")
    if not base:
        return None
    try:
        req = urllib.request.Request(base + path, method="POST")
        req.add_header("Content-Type", "application/json; charset=utf-8")
        with urllib.request.urlopen(
            req, data=json.dumps(body, ensure_ascii=False).encode(), timeout=timeout
        ) as r:
            return json.loads(r.read().decode())
    except Exception as e:
        log.warning("网关投递失败 %s: %s", path, e)
        return None
```

### 3. `on_card_action` 里分流

原来只处理 `{act: approve|cancel, tok}`（审批）。现在多认一种：

```python
        ask_token = str(val.get("token") or "")   # 注意字段名是 token，不是 tok
        if act == "answer" and ask_token:
            answer_text = str(val.get("answer") or "")
            payload = {"token": ask_token, "text": answer_text, "via": "button"}
            if by:
                payload["by"] = by
            r = gateway_post("/answer", payload)
            accepted = bool(r and r.get("accepted"))

            if mid:  # ev.context.open_message_id
                if accepted:
                    mark_ask_answered(mid, answer_text, by)   # 卡片改成「✅ 已回答」
                else:
                    log.info("token %s 已作答，忽略重复点击", ask_token)
            return _build_card_response()
```

配套新增 `mark_ask_answered(message_id, answer_text, by_open_id)`：用 `PatchMessageRequest` 把卡片刷成绿色「✅ 已回答」，避免用户连点之后以为没反应。

## 为什么卡片按钮的字段名不一样

- 审批卡（本仓库旧代码）：`{act: "approve", tok: "1234"}`
- 提问卡（`@dsh-feishu/core` 的 `askCard`）：`{act: "answer", token: "7e121b6a", answer: "确认发车"}`

两者不通用，`on_card_action` 里得分别读。合并成一种会更干净，但会牵动审批流程，没在这次动。

## 回滚

```bash
# PVE 上
ls /root/bot-backup/                       # 有改造前的时间戳快照
cp /root/bot-backup/bot.py.<时间戳> /opt/feishu-bot/bot.py
systemctl restart feishu-bot
```

回滚后 `feishu_ask` 的按钮回到「装饰」状态（点不动），打字回复仍然可用 —— 因为 MCP 侧的轮询兜底一直在。

## 实测记录（2026-10-30 02:04）

```
[feishu-gateway] watch {"token":"7e121b6a","chatId":"oc_7c2899..."}
[feishu-gateway] 外部投递答案 {"token":"7e121b6a","accepted":true,"text":"确认发车"}
[feishu-gateway] 外部投递答案 {"token":"7e121b6a","accepted":false,"text":"再等等"}
[feishu-gateway] 外部投递答案 {"token":"7e121b6a","accepted":false,"text":"确认发车"}
```

MCP 侧：

```
[dsh-feishu-mcp] feishu_ask token=7e121b6a 已发卡片 om_x100b610ce69af0a4cd12225b31ea933，网关在线（按钮可用）
[dsh-feishu-mcp] feishu_ask token=7e121b6a 网关投递回答（button，21880ms）
```

模型拿到 `用户回答：确认发车` 并正常收尾。

日志里那 4 次 `accepted=false` 是用户连点导致的 —— 幂等保护正确拒绝了重复投递，但也说明当时缺「点击反馈」，所以补了 `mark_ask_answered`。

## 部署位置速查

| 组件 | 位置 | 托管方式 |
|---|---|---|
| bot.py | PVE `192.168.1.200:/opt/feishu-bot/bot.py` | `systemctl status feishu-bot` |
| gateway | agent `192.168.1.205:~/dsh-feishu-gateway/gateway.mjs` | `systemctl --user status dsh-feishu-gateway`（Linger 已开） |
| gateway 依赖 | agent `~/dsh-feishu-gateway/node_modules`（`@larksuiteoapi/node-sdk`） | npm |
| MCP bundle | agent `~/.local/bin/dsh-feishu-mcp.mjs` + wrapper `dsh-feishu-mcp` | DSH 按需拉起 |
| 密钥 | agent `~/.config/dsh/feishu.env`（0600） | systemd EnvironmentFile |
