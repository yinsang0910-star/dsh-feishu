# dsh-feishu-channel

把飞书接成 DSH 的**通道**，而不是给机器人加一个队列。

当前版本 **0.1.7**，变更明细见 [CHANGELOG.md](CHANGELOG.md)。

```
飞书群/话题
   │  (WebSocket 长连接，仍是 bot.py 在收)
   ▼
PVE 宿主 /opt/feishu-bot/bot.py        ← 只做飞书 SDK 适配：认人、白名单、危险动作审批
   │  POST /ingest  ─────────────────────────┐
   │  GET  /events (SSE)                      │
   │    ◄── event: view   卡片状态 ────────────┤
   │    ◄── event: reply  agent 的回答正文 ────┘
   ▼
agent 机 dsh-feishu-channel 插件        ← 跑在常驻的 dsh 进程内，直接持有 agent 句柄
   │  agent.followup() / agent.steer() / agent.inject()
   ▼
DSH 原生收件箱 next-turn / next-step    ← 持久、可回放、在轮次/步骤边界原子领取
   │
   ▼
同一个 agent，同一个工作区，一张会自己更新的卡片 + 一条条真实回答
```

**上行和下行是两条独立的路**：`view` 帧让卡片跟着状态变，`reply` 帧把 `assistant/message`
的正文送回群。0.1.6 及以前只有 `view`，所以会出现「卡片在、回答不在」——机器人在会话日志里
答得完完整整，群里却只看到一张写着「空闲 · 第 1 轮」的卡片。

## 为什么换掉老路径

老路径是「一条消息 spawn 一个 `dsh-task --json` 子进程」：

| 问题 | 老路径的表现 |
|---|---|
| 补充指令 | 子进程 stdin 已关，塞不进去，只能排到下一轮 |
| 排队可见性 | `bot.py` 发一句静态的 `⏳ 前面还有 N 个在跑`，之后再无更新 |
| 并发安全 | 同一目录两个人同时发 → 两个子进程改同一批文件 |
| 上下文 | 会话靠 `--session-id` 续，但进程一退就没了执行现场 |

新路径直接落在 DSH 自己的机制上：

- `agent.followup(msg)` → 排队到 **next-turn**，下一轮开头领取
- `agent.steer(msg)` → 排队到 **next-step**，下一个工具结果边界领取（在跑的 tool call 不打断）
- `agent.inject(msg)` → 只进上下文，不唤醒
- `agent.cancel(cause, { keepInbox: true })` → 中止当前轮但保留排队
- 排队位置 `agent.inbox.nextTurn.length` 是**真值**，不是估的

> 这条「只能在下一次模型调用前的工具结果边界注入」不是本项目发明的，是六个独立实现共同收敛出来的硬约束（Cursor 的 "next safe step"、Copilot SDK 的 "committed to a tool call"、OpenClaw 的 "committed plan"，反例是 OpenHands #1841 —— 工具执行中途注入会把 message history 打断，Claude API 直接 `invalid_request_error`）。DSH 的 `next-step` 收件箱就是为这件事设计的。

## 装法（2026-11-03 实机走通的这套，照着抄就行）

### 0. 前置（agent 上已经满足，核实过）

agent 机上已经有一个**常驻**的 dsh 进程，插件的意义就在于「进程内持有 agent 句柄」——headless 一次性子进程里没有 agent registry：

```bash
# agent 上实况（2026-11-03 核实）
$ pgrep -af "dsh web"
454543 node /usr/local/bin/dsh web --host 192.168.1.205 --port 8080 --no-open
```

profile 是 `~/.dsh/profiles/web`，dsh 版本 `0.2.1-rc.5`，node `v22.23.4`。
它由 **systemd user unit** 托管：`~/.config/systemd/user/dsh-web.service`（`Restart=always`）。
**直接复用这个进程**，不用另起。注意它是 web GUI 本体（端口 8080），重启会断掉桌面端正在进行的会话。

老路径按次调用的入口仍然留着：`/home/agent/.local/bin/dsh-task` → `dsh --profile headless "$@"`。

### 1. 打包 + 传（别用 scp，会卡死）

这台机器上 `scp` 对 agent 会挂住（实测两次 120s 无响应），改用 `cat >` 重定向：

```powershell
# 笔记本上
cd dsh-feishu-channel
npm pack                    # → dsh-feishu-channel-0.1.7.tgz

$env:MSYS_NO_PATHCONV=1
cmd /c "ssh -o BatchMode=yes agent ""cat > /home/agent/.dsh/profiles/web/local-packages/dsh-feishu-channel-0.1.7.tgz"" < ""dsh-feishu-channel-0.1.7.tgz"""
# 传完两边 md5sum 对一下
```

### 2. 让它被 profile 加载（用脚本，别手改）

`fix_profile.py` 做三件事：依赖指向新 tgz、`bundles` 末尾追加、给通道补 provider/model。

```bash
ssh agent 'python3 /tmp/fix_profile.py'
ssh agent 'cd /home/agent/.dsh/profiles/web && pnpm install --prefer-offline'
```

装完 `pnpm` 会报 `Packages: +4 -19`，正常：那 `-19` 是清 dangling，`@deepseek-ai/dsh-base` /
`dsh-web-app` 本来就不在 profile 的 node_modules，它们由 dsh 自身的
`/opt/node/lib/node_modules/@deepseek-ai/dsh/node_modules/` 提供。

**新增 bundle 必须重启一次 dsh web**（依赖树要重新 resolve，热加载只覆盖已加载插件的配置改动）：

```bash
# 注意整条远程命令用单引号包，否则 $(id -u) 会被本地 shell 先展开成空
ssh agent 'export XDG_RUNTIME_DIR=/run/user/1000; export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus; systemctl --user restart dsh-web'
```

⚠️ 会中断 agent 桌面端（Chromium 那个 8080 页面）正在跑的会话，挑没人用的时候做。

### 3. 配置：token + provider/model

插件的配置走 profile 的 `cordis.patch.yml`（`- id: dsh-feishu-channel` 覆盖 bundle 自带默认值）：

```yaml
- id: dsh-feishu-channel
  name: dsh-feishu-channel
  inject:
    - agents
    - agentPresets
  config:
    host: 0.0.0.0            # bot.py 在 PVE 上，跨机访问必须监听对外
    port: 8788
    token: <head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 32>
    workspaceRoot: /home/agent/work
    stateDir: /home/agent/.dsh-feishu-channel
    collaborativeSteering: true
    flushMs: 800
    # ↓ 这三行是必须的，见下
    provider: opencode-go
    model: deepseek-v4.1-flash
    reasoningEffort: high
```

> **为什么必须显式给 provider/model**：插件是用 `AgentRegistry.create()` 程序化建会话的，
> 它**不继承** profile 里 `agent-default-model` 那份「默认 agent」配置。不给就在第一轮报
> `agent "feishu-..." has no provider/model`，消息收下了但一句话都跑不出来。
> （踩过：0.1.1 就是因为这个卡住。）

### 4. bot 侧：把改动补进 PVE 上那一版

⚠️ **PVE 上跑的 `bot.py` 和笔记本上那份不是一回事**（PVE 是 2924 行的并发/图片/引用版，
笔记本是 10 月底的 1632 行快照）。别覆盖，用补丁脚本把改动重放上去：

```powershell
cd C:\Users\苏元洛\.pve600\feishu-bot
python apply_channel_patch.py bot.pve-latest.py bot.patched.py   # 13 处改动，每处断言命中 1 次
python -m py_compile bot.patched.py
```

然后把 `bot.patched.py` 传成 `/opt/feishu-bot/bot.py.new`、`channel.py` 传成 `/opt/feishu-bot/channel.py`，
远端 `py_compile` 过了再 `mv`：

```bash
ssh pve "cd /opt/feishu-bot && cp -a bot.py bot.py.bak-before-channel-\$(date +%Y%m%d-%H%M) && python3 -m py_compile bot.py.new channel.py && mv bot.py.new bot.py"
```

最后写 `config.json`（`set_channel_conf.py` 会先备份再改，只动这三个键）：

```json
{
  "channel_mode": "on",
  "channel_url": "http://192.168.1.205:8788",
  "channel_token": "<插件那串>"
}
```

`channel_mode` 是 `"off"` 时完全走老路径 —— 这就是回滚开关。

```bash
ssh pve 'systemctl restart feishu-bot && grep -E "通道" /var/log/feishu-bot/bot.log | tail -3'
# INFO 通道就绪 http://192.168.1.205:8788 sessions=0 pending=0
# INFO 通道模式已启用 ...
```

### 5. 验证

```bash
# 通道活着吗（PVE 上跨机打）
curl -s http://192.168.1.205:8788/health
# {"ok":true,"sessions":0,"pending":0}

# 端到端：ingest 两条 + 重投幂等 + 读真值（不碰真实用户会话，用 oc_channel_selftest* 这种假 chat）
ssh pve 'cd /tmp && python3 e2e3.py'
```

期望输出：第 1 条 `intent=followup`、**第 2 条 `intent=steer`**（它在跑）、第 3 条 `duplicate=true`、
`view.queue` 里能看到 `target: "next-step"`，而且收尾时 **`turn=1`** —— 两条消息在同一轮里，
这就是「插话」和「排队」的区别。

真机验收：在飞书群里说话，应该看到

1. 一条卡片立刻出现，标题是「空闲/在跑」；
2. 它跑着的时候再补一句 —— 卡片上出现「插话（下一步生效）」，**不会**再变成「排在后面」；
3. 卡片上直接有「停 / 撤回 / 清队」按钮；
4. **它说的话会以普通文本消息真的发到群里**（0.1.7 起）。这一条最容易被忽略：0.1.6 及以前
   只有卡片在动，回答全留在会话日志里没人看见。

### 7. 出站通道（回答怎么回到群里）

`assistant/message` → SSE `event: reply` → 群里一条文本。三个要点：

- **只发通道自己建的会话**：`bySession.get(session.id)` 查不到就跳过，所以 subagent / mnemon
  那些子会话的产物不会漏进群。
- **暂存兜底**：SSE 还没连上时（`binding.subscribers.size === 0`）先压进 `pendingReplies`
  （上限 20 条），`/events` 建连后补发。飞书那边不会有「消息发了但没人听」的黑洞。
- **按 message id 去重**：`sentMessageIds` 超 200 裁到 100，防同一轮事件重放造成群里重复。

宿主侧用既有的 `deliver()` 发送：超过 `max_inline_lines` 行或 4000 字自动贴成 txt 文件，
和以前一样。

```bash
# 自己验一下出站通道（不用真的发飞书消息）
curl -s -X POST http://127.0.0.1:8788/ingest \
  -H 'content-type: application/json' \
  -d '{"key":"lark:default:oc_reply_selftest","chatId":"oc_reply_selftest","openId":"ou_test",
       "text":"现在几点","name":"test","intent":"followup"}' &
curl -sN http://127.0.0.1:8788/events?key=lark:default:oc_reply_selftest
# 期望先收到 event: view，再收到 event: reply（text 是模型的回答）
```

### 6. 记忆迁移（换通道不清零）

`bot.py` 会把老通道时代这个人/这条会话的 `session_id`（`state.json` 里 `STATE["sessions"]`）
随每次 `ingest` 一起投给插件（字段 `resumeSessionId`）。插件第一次见到这个会话键时优先
`agents.resume()` 接续它；接不上（老 id 失效、profile 不兼容、cwd 变了）就自己开新会话，不报错。

所以「切到新通道」这一步，用户的历史记忆是接着的。


## 回滚

三层，任选一层：

| 层级 | 动作 | 效果 |
|---|---|---|
| 最轻 | `config.json` 里 `channel_mode: "off"` → `systemctl restart feishu-bot` | 立刻回老路径，插件留着不用 |
| 中 | profile `package.json` 里删掉那一行 | 插件不再加载，8788 端口没了 |
| 最彻底 | `rm -rf /home/agent/.dsh/plugins/dsh-feishu-channel` | 连代码一起清 |

老路径的代码一行没删，`QUEUES` / `RUNNING` / `run_dsh_once` 全在，随时能回去。

## 排障

| 现象 | 查什么 |
|---|---|
| 消息没反应，日志写「通道投递失败，退回老路径」 | agent 上 `curl 127.0.0.1:8788/health`；不通就是 dsh 进程没起或插件没加载 |
| 收下了但不回话，view 里 `error: agent "..." has no provider/model` | profile 的 `cordis.patch.yml` 里 `- id: dsh-feishu-channel` 少了 `provider` / `model`（程序化 create 不继承 `agent-default-model`） |
| 插件加载失败 `cannot set property "x" without provide` | Cordis 里 `ctx.set()` 前必须先 `provide`；本插件不再对外 set |
| 重启了服务但端口没变 | PowerShell 里远程命令必须用**单引号**包：`ssh agent 'export XDG_RUNTIME_DIR=...; systemctl --user restart dsh-web'`，双引号会让 `$(id -u)` 在本地展开成空 |
| 卡片一动不动 | `journalctl` 里看有没有 `订阅通道视图失败`；SSE 是 GET，检查 token 头 |
| 卡片一直重建 | 飞书 PATCH 有 14 天上限；日志里有 `通道卡片重建` 是正常的自愈 |
| steer 没生效 | 看 `[6]` 那段自检；running → `steer`，空闲 → `followup`，`/下一轮 xxx` 强制 followup |
| 消息重复执行 | outbox 幂等键是 `chatId:msgId`，飞书重投会被挡掉，日志里 `dup=True` |
| 换通道后记忆像丢了 | 看日志有没有 `接续老会话`；没有说明 `state.json` 里那人的 session 已经不在了，会开新会话 |
| **只有卡片、没有回答** | 0.1.6 及以前没有出站通道。升到 0.1.7，确认 `GET /events` 能收到 `event: reply`；收不到就查插件日志有没有 `session/event` 订阅报错 |
| **收下了但立刻变 idle，`error` 里有 `has no provider/model`** | resume 路径漏了 `agentOptions`（0.1.5 及以前）。老会话 `resume` 时不继承 `create` 的参数，必须显式传，否则消息石沉大海 |
| **它能说话但不会干活**（不能看图、不能跑命令、反过来教你自己去 `ls`） | 工具集没装配。`meta.agentPreset` 只是记录字段，必须在 `setup` 里 `ctx.agentPresets.mount(agentCtx, 'standard')`；resume 路径补 `select`（0.1.5 修的）。诊断：问它「你有哪些工具」，正常应该有 70 个以上 |
| **20 条并发只有 6 条成功**，报 `session "..." already exists` | 并发建会话没加锁（0.1.4 修的）。新开话题第一条就发图、或 dsh-web 刚重启时最容易触发 |

## 代码结构

```
dsh-feishu-channel/
├─ package.json          # dsh.bundle.patch 指向 cordis.patch.yml；files 白名单防打包带 tgz
├─ cordis.patch.yml      # 注册行（port / token / workspaceRoot / stateDir / provider / model）
├─ CHANGELOG.md          # 0.1.0 → 0.1.7 逐条「症状 → 根因 → 修法」
├─ 方案-DSH原生通道重构.md  # 设计文档：三通道对比、inbox 语义、业界对照
├─ lib/
│  ├─ index.js           # 插件主体：HTTP + SSE + ensureAgent(单飞) + preset mount + ingest + control + reply
│  ├─ sessionkey.js      # 会话键三级回落（话题 → 回复串 → 群）
│  ├─ store.js           # Outbox（幂等，JSONL+fsync）/ SessionState
│  └─ card.js            # 视图 → 飞书卡片（整卡替换，不造 ETA）
├─ test/selfcheck.mjs    # 34 条纯逻辑自检
├─ fix_profile.py        # 在 agent 上切 tgz 版本 + 补 provider/model（幂等）
├─ fix_resume_opts.py    # 给两处 resume 补 agentOptions（历史修复脚本，留作参考）
└─ （宿主侧）/opt/feishu-bot/
   ├─ channel.py              # 客户端：session_key / ingest / control / watch(SSE: view + reply)
   ├─ apply_channel_patch.py  # 把 13 处通道改动重放到 PVE 最新版 bot.py 上
   ├─ apply_img_fix.py        # 4 处图片/并发修复（文件名唯一化、ssh 信号量、兜底名）
   ├─ apply_reply_channel.py  # 2 处出站通道改动（on_channel_reply + watch 传参）
   ├─ verify_patch.py         # 补丁结果结构自检
   └─ e2e_channel_test.py     # 端到端实测脚本（假 chat，不碰真实会话）
```


## 自检

```bash
node test/selfcheck.mjs
# 结果：34 通过 / 0 失败
```

覆盖：会话键三级回落、sessionId 确定性派生、outbox 幂等与重启恢复、卡片不含百分比 ETA、视图带 key/rev、排队/停/撤回按钮的显隐。
