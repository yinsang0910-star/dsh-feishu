# 机器人收图片/文件（2026-10-31 改造记录）

## 症状

群里/私聊发一张图，机器人回：

```
目前只认文本消息（收到 image）。
```

日志里能看到消息确实到了（`recv type=image`），只是被这一行挡掉。

## 两个真原因

1. **bot.py 自己挡的**。`handle_inner` 里有一句 `if msg_type != "text": ... return`，
   除了文本以外全部丢弃。
2. **DSH headless CLI 没有附件参数**。`dsh --profile headless` 只吃 `--json`、
   `--session-id`、`-`（stdin），没有任何 `--image/--file`；而且 DSH 的文件沙箱默认
   `workspace-write`，**只放行工作目录内的路径**（`dsh-base` 的 `permission` entry，
   `DSH_PERMISSION_MODE` 兜底 `workspace-write`）。所以附件不能塞 `/tmp` 或 `~/.cache`。

飞书侧不需要额外权限：`im:resource:read`（`im:resource`）就够，
`GET /open-apis/im/v1/messages/{message_id}/resources/{file_key}?type=image|file`
实测返回 200 / `image/jpeg` / 548832 字节。

## 通的链路

```
飞书事件（只有 image_key / file_key，没有字节）
  → bot: GET .../resources/{key}?type=image|file        # tenant_access_token
  → bot: base64 过 ssh 写到 <cwd>/.feishu-inbox/img-<时间>.jpg
  → bot: 任务描述里给相对路径 + 「先用 read_image 打开看清，不要猜」
  → dsh(headless) 用内置 read_image 工具真的读图（多模态模型能看）
  → 结论照常回卡片
```

关键点：**给 agent 的是相对工作目录的路径**（`.feishu-inbox/img-xxx.jpg`），
因为沙箱只认 cwd 内的文件；同时文件名用 `img-<YYYYmmdd-HHMMSS>` 而不是 `attach-1.jpg`。

## 群聊里的图片

飞书的图片消息带不了 @（mention 只能出现在文本消息里）。群聊现在默认**免 @**
（`group_require_mention: false`，见 [BOT-GROUP-MODE.md](BOT-GROUP-MODE.md)），
所以图片跟文字一样直接处理。只有把模式切回 `/要@` 时，才需要「先收着」：

| 场景 | 免 @（默认） | `/要@` 之后 |
|---|---|---|
| 私聊发图 | 直接处理 | 直接处理 |
| 群里发图 | **直接处理**（默认指令：说清看到什么、再问怎么处理） | 先按「人 + 会话」收着，回「📎 收到了：图片。15 分钟内 @我 说要拿它干什么」，**不起任务** |
| 群里发图后补一句（免 @ 直接说 / 要 @ 时 @ 一句） | 那句话是同一会话里的新任务，上下文里已经有这张图 | 把收着的图挂到这句话上，一起交给 DSH |
| 收着超过 15 分钟 | —（不启用） | 自动过期丢弃（`STASH_TTL = 900`） |

stash 存在 `state.json` 的 `stashed` 里，key 是 `"<chat_id>|<open_id>"`，每人每群一份。

## 配置项

`bot.py` 的 `DEFAULTS` 新增三条（可写进 `/opt/feishu-bot/config.json` 覆盖）：

```python
"attachment_dir": ".feishu-inbox",   # 相对工作目录，必须在 cwd 内
"max_attachment_mb": 20,
"group_require_mention": False,      # 群里不用 @ 也响应
```

## 顺带修掉的一个真 bug

`dsh_argv` 里原来是 `cd %s 2>/dev/null`，**没加引号**。工作目录名带空格时
（`/home/agent/work/negative film`）`cd` 会失败且被 `2>/dev/null` 吃掉：

```bash
$ cd /tmp; cd /home/agent/work/negative film 2>/dev/null; echo $PWD
/tmp          # 没进去，也没人报错
```

于是 dsh 其实跑在 `$HOME`，附件（落在 `<cwd>/.feishu-inbox`）根本读不到。
现在改成 `cd <quoted-cwd> 2>/dev/null || cd <quoted-agent_root>`。

副作用：修好之后，**老会话会被一次性重置**——dsh 报
`session "..." was recorded in "/home/agent", not "/home/agent/work/negative film"`，
bot 的既有重试逻辑会清掉 session 重开一个，之后就一直是对的。

## 怎么验（不刷屏）

把发送动作换成本地记录，其余全真：

```bash
# 在 PVE 上
/opt/feishu-bot/venv/bin/python /root/test-image-flow2.py
```

三个场景都跑过（2026-10-31 20:47）：

- 私聊图片 → 卡片标题「看这张图」，20 秒后模型真的读出了内容：
  「有机化学练习/试卷照片，标题 Predict the major product in each of the following
  reactions (5×4=20)，(a)–(d) 四道烯烃加成，卷面有手写答案，(c) 涂改较多」
- 群里图片 → 只回 `📎 收到了：图片。15 分钟内 @我 说要拿它干什么`
- 群里 @ 一句 → 挂上同一张图，卡片标题变成用户那句「这张图里是什么？一句话说清」，
  8 秒答完

## 回滚

```bash
# PVE 上
cp -p /opt/feishu-bot/bot.py.bak-before-image-20261031-204347 /opt/feishu-bot/bot.py
systemctl restart feishu-bot
```

回滚后图片消息回到「目前只认文本消息」，文本任务不受影响。

## 已知边界

- 富文本消息（`post`）里内嵌的图还没取（截图一般是 `image`，影响小）。
- 引用（reply）某条图片消息再 @ 我，暂时不会去取被引用的那张图。
- 一次只处理一个附件；连发多张只挂最后一张（stash 会覆盖）。
- 20MB 以上直接拒，不落盘。
- 文件类不只是图片：`file` / `media` / `audio` 都走同一条路，落盘后让 agent 自己打开。
