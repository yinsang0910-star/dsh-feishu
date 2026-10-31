# 机器人的指令与「换脑子」

在飞书里发 `/help` 或 `/指令`，机器人回一张**卡片**——按用途分了五组，能点的按钮直接点。
这份文档是它的完整版：每条指令干什么、换模型/换思考强度是怎么落地的、出错怎么退。

## 一句话

默认 `deepseek-v4.1-flash` + `reasoningEffort: auto`（每条任务按内容自动定档）；随时 `/模型` `/思考` 换，
换之前会**真跑一次**验证，不认就自动退回原样，不会把机器人搞成哑巴。

这是**全局设置**——机器人的「脑子」只有一份，谁换都是换同一份，换完所有人的下一个任务都用新的。
想要每人一套，得在 `sess_key` 那层按人存模型，目前没做。

## 指令表

### 换脑子

| 指令 | 作用 |
| --- | --- |
| `/模型` | 回一张卡，4 个常用模型带一句人话说明，点按钮即换 |
| `/模型 列表` | 可用模型全表：单价、上下文长度、能不能看图（禁用的不列） |
| `/模型 <名字>` | 直接换，例如 `/模型 deepseek-v4.1-flash`；名字不在清单里会拒绝并给相近建议 |
| `/思考` | 回一张卡，五档按钮：`auto` / `off` / `low` / `high` / `max` |
| `/思考 <档>` | 官方档位名，也认 `自动/auto`、`关/off`、`低/low`、`高/high`、`最高/max` |

### 看状态

| 指令 | 作用 |
| --- | --- |
| `/状态` | 在跑什么、排队几个、上次结果、群里要不要 @、**当前用的什么脑子** |
| `/排队` | 排了哪些活 |
| `/清队` | 清空队列 |
| `/额度` | 模型用量还剩多少 |

### 管记忆与项目

| 指令 | 作用 |
| --- | --- |
| `/项目` | 列出工作区，`/cd <名字>` 切过去 |
| `/新` | 清空这个人在这台机器上的会话记忆，从头开始 |

### 群里 / 身份

| 指令 | 作用 |
| --- | --- |
| `/要@` | 群里恢复成必须 @ 才响应 |
| `/免@` | 群里不用 @（默认） |
| `/whoami` `/name` | 看自己是谁、改称呼 |
| `/claim <口令>` | 白名单认领，之后才使唤得动 |
| `/allow` `/deny` | 管理员增减白名单 |

### 其余口语

`停` / `继续` 中止或延长任务；危险动作会弹审批卡；`/help` 再看一遍。

## 换模型是怎么落地的

`dsh` 的 headless 调用（`dsh-task`）本身没有 `--model` 参数，真正生效的是启动器上的
**额外 patch 层**：

```bash
dsh --profile headless --patch <overlay.yml> --json -
```

overlay 只覆盖一个 entry：

```yaml
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: opencode-go
    model: deepseek-v4.1-flash
    reasoningEffort: high
```

机器人把 overlay 写在 agent 机的 `~/.cache/feishu/model-override-<档>.yml`（配置项
`model_override_path` 是基准名，四档各一份），每次起任务时按这条任务实际用的档位挑一份拼进
`dsh_argv`。**一档一份文件**是因为同时可能跑几条任务，共用一份会互相覆盖。

**不动 profile 的 `cordis.patch.yml`**——那份是所有调用共用的，改了会影响别的用途，也没法按人区分。

`--patch` 必须排在 `--json` 之前，否则被当成任务参数吞掉。

## auto 自动挡

`reasoningEffort: auto` 不是 DSH 的档位，是机器人自己加的：起任务时按这条任务的样子现挑一档。

| 判据 | 落到的档 |
| --- | --- |
| 含「仔细 / 彻底 / 审查 / 重构 / 权衡 / 根因 / 批改 / 复盘」等词 | `max` |
| 任务超过 1200 字 | `max` |
| 任务 ≤ 15 字 | `low` |
| 含「翻译 / 改成 / 查一下 / 回答」等词且 ≤ 60 字 | `low` |
| 其余 | `high` |

判定结果和理由会写在进度卡脚注上，例如 `reasoningEffort auto → max（提到「仔细」）`，
不会黑箱。判据在 `bot.py` 的 `_DEEP_HINTS` / `_LIGHT_HINTS` / `decide_effort()` 里，改词表即可。
`/思考 auto` 切换，`/思考 high` 之类切回固定档。

## 验证与退回

换一次要做三件事，任何一步失败都退回原样：

1. 写 `config.json`（`model` / `reasoning_effort`）
2. 把 overlay 原子写到 agent 机（`cat > x.tmp` 再 `mv`，四档一起写）
3. **真跑一次**最短任务：`dsh-task --patch <overlay> --json '回答一个字：好'`
   （选 `auto` 时用 `high` 那份当代表档验证模型本身可用）

第 3 步认这些信号：

| 信号 | 含义 | 处理 |
| --- | --- | --- |
| `"type":"final"` | 跑通了 | 保留 |
| `UNSUPPORTED_REASONING_EFFORT` | 这个模型不支持这一档 | 退回，回你「这个模型不支持 reasoningEffort『X』」 |
| `MISSING_CREDENTIAL` / `INVALID_CREDENTIAL` | 凭据用不了 | 退回 |
| 其它 | 没出结果 | 退回，附最后一行输出 |

**额外一道闸**：`dsh` 遇到不认识的模型名不报错，会**静默回落到能用的那个**，
所以「试跑成功」证明不了名字对。换模型前会先拿 agent 上那份模型清单核对 id，
名字不在清单里直接拒绝——否则配置里会留下一个假名字，之后所有任务都在偷偷用别的模型。

## 思考强度的实测档位

清单里声明的档位不可信，下面这张表是在 agent 机上逐个组合真跑出来的：

| 模型 | off | minimal | low | medium | high | xhigh | max |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `deepseek-v4.1-flash` | ✗ | ✗ | ✓ | ✗ | ✓ | ✗ | ✓ |
| `deepseek-v4-pro`（已禁用） | ✓ | ✗ | ✗ | ✗ | ✓ | ✗ | ✓ |

`agent-default-model` 的 schema 只枚举 `off/low/high/max` 这四个，所以机器人只在这四档
（外加自造的 `auto`）里选。其它模型没逐个测；选到不支持的组合时，第 3 步会拦住并告诉你哪一档不支持。

**禁用的模型**：`bot.py` 里的 `BLOCKED_MODELS = ("deepseek-v4-pro",)`。它比 flash 贵一倍多、
默认也用不上，留着容易被误点。`/模型 列表` 不列它，`/模型 deepseek-v4-pro` 会被直接拒绝。
要放回来，把这一行改空即可。

## 模型清单从哪来

不写死在代码里。每次从 agent 上**正在用的那份** pi-ai 目录读：

```
/opt/node/lib/node_modules/@deepseek-ai/dsh/node_modules/@earendil-works/pi-ai/dist/providers/data/opencode-go.json
```

解析出 `id / 名称 / 单价 / 上下文 / 是否支持图片`，缓存 10 分钟。
DSH 升级换了模型目录，机器人跟着变，不用改代码。

## 卡片按钮

卡片按钮走 `p2_card_action_trigger`。点一下 → 机器人立刻回响应（飞书要求 3 秒内），
然后**后台线程**做真验证（十几秒），成功就原地刷新那张卡，失败单独发一条说明。
不在回调里同步跑，否则飞书会判超时。

## 回滚

只改配置：

```bash
# PVE
python3 - <<'PY'
import json; p='/opt/feishu-bot/config.json'
c=json.load(open(p)); c['model']='deepseek-v4.1-flash'; c['reasoning_effort']='auto'
json.dump(c,open(p,'w'),ensure_ascii=False,indent=2)
PY
systemctl restart feishu-bot.service
```

整份回滚（第二轮之前的版本）：

```bash
cp -p /opt/feishu-bot/bot.py.bak-before-effort-v2-20261031-2205 /opt/feishu-bot/bot.py
systemctl restart feishu-bot.service
```

agent 机上那四份 overlay 留着不影响其它用途（只有机器人起任务时才带上它）；
想彻底清掉就 `rm ~/.cache/feishu/model-override-*.yml`，并把 `config.json` 里的
`model` / `reasoning_effort` 删掉——两个都没了，`dsh_argv` 就不再拼 `--patch`，
回到 profile 自己的默认模型。
