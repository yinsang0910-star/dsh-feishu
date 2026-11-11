# 变更记录

## 2026-11-11 — 飞书问答等待保护

飞书绑定的实际 agent 调用网页问答工具时明确报不支持，并要求用文字追问、结束当前轮；不代答、不批准。其他网页会话沿用原处理。增加通过 HTTP 接单建立绑定后验证真实事件处理器的回归测试。

每条都写清「症状 → 根因 → 修法」，因为这里每一个坑都是线上踩出来的，不是设想出来的。

## 0.1.15 — 2026-11-08

### 卡片：思考流水只记次数、最多 4 步、刷新降到 1.8 秒

**症状**：进度卡一格一格往下长，每格都是模型的英文内心独白（「The user asks…」「I accidentally called acp_status instead of searching…」），几步就顶满一屏；而且几乎一秒一刷。用户的原话：

> 思考过程保留的太多刷新的太多太长很占地方

**根因**：`index.js` 把 `assistant/message` 的 reasoning 原文截 90 字塞进流水（截了还是英文），`MAX_STEPS = 8` 全列，`flushMs: 800` 每 0.8 秒 PATCH 一次卡片。

**修法**：

1. 思考不贴内容，只记「想过一次」；连续思考合并成 `**思考** ×N`，一个想法不再占一行。
2. `MAX_STEPS` 8 → 4，更早的折叠成「… 前面 N 步已完成」。
3. `flushMs` 800 → 1800。

另外 `bot.py` 的 `build_reply_card` 不再把「第 N 轮 · 思考深度 high」写进 `header.subtitle`（飞书会把它拼成标题第二行，又小又挤，读起来像排版事故），挪到页脚 note。

## 0.1.12 — 2026-11-04

（含 0.1.13 / 0.1.14 两个补丁，同一个改动的打磨）

### 修复：dsh-web 一重启，卡片就停在那一秒

**症状**：用户在群里发消息，任务真的跑了、图也画出来了，但那张卡永远停在「🧠 正在处理」或者干脆停在重启那一刻的旧样子，一个字都不再更新。用户的原话：

> 你确定这个卡片已经恢复到之前我们设计的那种形式了吗，我怎么感觉没变化呢

**根因**：binding（「哪个群 → 哪个会话」）只活在内存里（`const bindings = new Map()`）。dsh-web 一重启就全清，之后门房 PVE 的 SSE 全部 404，要等用户再发一条消息才重建。这一条链路一旦断在重启那一刻，前面所有正常的工作都白干（结果到不了群里）。

更糟的是它还掩盖过一次真 bug：门房 `channel.py` 的「404 就停订阅」补丁被后来部署的旧版文件覆盖过，于是坏线程 `alive` 永远是 `true`，`watch()` 的幂等检查直接复用它 —— 任务跑完、回答到了、卡片纹丝不动。

**修法**：

1. `store.js` 新增 `BindingStore`（`stateDir/bindings.json`，写法照 `SessionState`），只存复活必需的四个字段：`sessionId` / `cwd` / `chatId` / `savedAt`
2. `index.js` 建 binding 时立即落盘；`chatId` 一变就强制落盘（没它就不知道该把卡片画到哪个群）
3. `/events` 发现内存里没有这个 key，就 `reviveBinding()` 从磁盘复活 —— 走 `ensureAgent`，所以**优先 resume 原来那个 session，记忆不丢**
4. `snapshot()` 里节流 3 秒顺手刷新一次（`turn` 会变）

**踩到的坑（值得单独记）**：

- `reviveBinding` 里我写了裸 `log(...)`，而插件里根本没有 `log` 这个函数（全项目用的是 `ctx?.logger?.info?.()`）。结果**未捕获的 rejection 让整个 dsh 进程 fatal 退出**：`dsh: fatal load failure: ReferenceError: log is not defined at reviveBinding`。0.1.13 修。
- 修完还在 `/events` 外面再包了一层 try/catch —— 复活失败只该是「这条群没救回来」，绝不能把整个 dsh 带走。0.1.14。
- `lib/*.bak-before-*` 备份文件会被 `"files": ["lib/"]` 打进 npm 包（包从 34KB 涨到 47KB）。备份必须放在 `.bak/`（`.gitignore` 已排除）。

**验证**：

```
1) ingest 建 binding → bindings.json 出现 {sessionId, cwd, chatId}
2) systemctl --user restart dsh-web → health.sessions 归 0（内存确实空了）
3) 不发任何消息，直接连 /events?key=... → 200 + view 帧（不是 404）
4) health.sessions → 1（binding 复活）
5) sessionId 与重启前一致 → 老会话的记忆还在
```
## 0.1.9 — 2026-11-04

（含 0.1.10 / 0.1.11 两个补丁，都是同一个改动的打磨）

### 新增：工具流水——服务器在干活，群聊里终于看得见了

**症状**：用户发「画图给我」，然后指着截图说：

> 你看这服务器上明明是在工作的，但是群聊里根本就不显示，然后还莫名其妙的尾部贴上全部思考和过程，又占地方又恶心人

DSH 本机的执行面板明明逐条列着 `思考 · Draw a second figure…` / `写入 · chem/gen_exam5b.py 11KB +259 -0` / `运行命令 · Render second mechanism sheet` / `读取图片 · chem/exam5_carbanion2.png`，飞书这边只有一张 `空闲 · 第 1 轮` 的空白卡。

**根因**：这个通道从来只订阅 `assistant/message`，**`tool/call` 和 `tool/result` 事件一次都没接**。而 0.1.8 为了「把思考过程显示出来」，把 `reasoning` 全文塞进了回答卡片的 `note` —— 几千字英文独白贴在回答下面，正是用户说的「又占地方又恶心人」。

**修法**：

1. 订阅 `session/event` 的 `tool/call`（`{turn, step, callId, name, arguments}`，`arguments` 是未解析的 JSON 字符串）与 `tool/result`（`{turn, step, message, error?, meta?}`），维护 `binding.steps`。
2. 工具名映射成中文动词（`read_image` → 读取图片、`write` → 写入、`bash` → 运行命令…），参数里挑最能说明意图的字段当提示（命令类优先 `description` 而不是整条 `command`）。
3. 文件路径**相对 cwd** 显示（`chem/gen_exam5b.py`，不是 `/home/agent/work/chem/gen_exam5b.py`）——DSH GUI 就是这么显示的。
4. `tool/result` 按 `callId` 回标 ✅/❌。**思考步骤没有 callId，必须跳过**，否则会被下一条结果误标成成功（0.1.10 修的）。
5. 思考降级成**一条流水**（首 90 字），**不再进回答卡片**；回答卡片只留正文。
6. 卡片布局重做：标题 `🧠 正在处理` / `💤 空闲`（**不再显示工作区路径**，它会被截成 `…/agent/work`，既不好看也没信息量），工作区降级到页脚且只留最后一段目录名。

**实测**（同一套脚本，让它「建个文件再 ls 确认」）：

```
🧠 正在处理 / 在跑 · 第 2 轮
_… 前面 3 步已完成_
**思考** · 5 more carbanion-attack templates: (2) 羧酸衍生物两次加成
**写入** · chem/gen_exam5b.py ✅
**思考** · footer line 2 has (+1C)；环氧 → 伯醇 (+2C)
**运行命令** · Render second mechanism sheet ✅
**读取图片** · chem/exam5_carbanion2.png ✅
**写入** · chem/gen_exam5b.py ✅
**运行命令** · Re-render second sheet ❌
好的，我把第 2、3、4、6、7 类也画成箭头图……
[停]
11 步 · 工作区 chem
```

回答帧也确认干净了：

```
reply 字段: ['at','chatId','effort','key','sessionId','text','turn']
reply 有 reasoning? False
```

---

## 0.1.8 — 2026-11-04

### 修复：回答排成一大坨纯文本，且把思考过程整个丢了

**症状**：用户说「你这个卡片和消息框字体什么的都做了负优化，之前弄得挺好的现在这个看起来就很乱，然后也不显示自动思考的深度也不显示思考的过程了」。

具体是两件事：

1. 0.1.7 的回答走 `deliver()` → `send(chat_id, text)`，`msg_type="text"`。飞书**纯文本消息不渲染 markdown**，`**加粗**`、`# 标题`、`- 列表` 全都变成字面字符，长回答就是一大坨灰底文本。而旁边的状态卡是 `renderView()` 产出的结构化卡片（`wide_screen_mode` + `lark_md`），两者视觉完全不在一个体系里。
2. `textOfMessage()` 只过滤 `b.type === 'text'`，`type === 'reasoning'` 的块被**整个丢掉**。DSH 的模型（deepseek-v4.1-flash，`reasoningEffort: high`）每轮都会产出思考内容，会话日志里 `grep -c reasoning` 能到几百处，但通道一个字都没往外送。

**根因**：0.1.7 只解决了「话有没有送出去」，没管「送出去长什么样」。`ReasoningBlock`（`dsh-llm/lib/types/types.d.ts:51`）是 `{ type: 'reasoning'; text: string }`，和 text 块并列在 `content` 数组里，取的时候必须显式认。

**修法**：

插件侧（`lib/index.js`）：

1. 新增 `reasoningOfMessage(message)`，拼所有 `reasoning` 块。**只保留尾部 2000 字**（前面加 `…（前面略）`）—— 思考常几千字，全塞进卡片会超飞书 30 KB 上限，而结论性判断一般在最后。
2. `event: reply` 帧加三个字段：`reasoning`、`effort`（取 `cfg.reasoningEffort`）、`turn`。
3. 仍然只在 `text` 非空时发帧 —— 纯工具调用轮次（只有 tool-call 没有正文）不发，避免群里刷屏。

宿主侧（`bot.py`）：

4. 新增 `build_reply_card(text, reasoning, effort, turn, open_id)`：`wide_screen_mode` 卡片，header 标题「回答」+ subtitle「第 N 轮 · 思考深度 high」，正文放 `lark_md` div（markdown 正常渲染），下面 `hr` 分隔，`note` 元素里放思考过程。
5. 正文超过 3000 字仍走 `deliver()`（贴 txt），否则发卡片；**发卡片失败回落纯文本，绝不丢回答**。

**实测**：

```
帧统计: Counter({'view': 7, 'reply': 1})
reply 字段: ['at', 'chatId', 'effort', 'key', 'reasoning', 'sessionId', 'text', 'turn']
  effort    : high
  turn      : 0
  text      : 亲核加成是指：带孤对电子或负电荷的亲核试剂主动进攻底物中电子云密度低的不饱和原子…
  reasoning : 用户问：用两句话说明什么是亲核加成。这是一个简单的化学概念解释题。直接回答两句话即可。…
  r 长度    : 336
```

**顺带修的一处配置坑**：profile 的 `cordis.patch.yml` 里 `inject` 只写了 `agents`，会**覆盖** bundle 自带的 `[agents, agentPresets]` —— 少了 `agentPresets` 就调不到 `ctx.agentPresets.mount()`，会话装配不出工具集（0.1.5 修的那个「空壳 agent」会以另一种形式回来）。已补成两项。

---

## 0.1.7 — 2026-11-04

### 新增：出站通道（agent 的回答终于回到飞书了）

**症状**：用户在群里发 PDF 让它报标题和 DOI，agent 在会话日志里给出了完整回答，但群里只收到一张「工作区 …/agent/work · 空闲 · 第 1 轮」的空白卡片。看起来像「机器人没干活」，实际是**它干了、也说了，但话没送出去**。

**根因**：`push(binding)` 只推 `event: view`（卡片状态快照），`session/event` 里的 `assistant/message` 从来没有被转发。也就是说这个通道做完了「进」（飞书 → agent）和「状态」（卡片），**「出」这一环根本不存在**。

**修法**：

1. 订阅 `ctx.on('session/event', ..., GLOBAL)`，只认 `event.type === 'assistant/message'`，用 `bySession.get(session.id)` 保证只发通道自己建的会话（子 agent 的产物不会漏进群）。
2. 按 `event.data.message.content` 里 `type === 'text'` 的块拼正文，走新增的 `event: reply` 帧。
3. **暂存兜底**：SSE 还没连上（`binding.subscribers.size === 0`）时先压进 `pendingReplies`（上限 20 条），`/events` 建连后由 `flushPendingReplies` 补发。
4. 去重：`sentMessageIds` 按 message id 记，超 200 裁到 100——防止同一轮里的事件重放导致群里重复。

宿主侧同步：`channel.py` 的 `Watch` 多一条 `event == "reply"` 分支交给 `on_reply`；`bot.py` 新增 `on_channel_reply`，走既有的 `deliver()`（超过 `max_inline_lines` 行或 4000 字自动贴成 txt 文件）。

**实测**：

```
event: reply
data: {"key":"lark:default:oc_replytest1","sessionId":"feishu-95ac...","chatId":"oc_replytest1",
       "text":"现在是 2026 年 11 月 4 日 11:48（北京时间）。"}
```

同时验证了暂存路径：SSE 早连时 binding 还没建（返回 `no such session`），ingest 之后再连，攒下的回答被补发。

---

## 0.1.6 — 2026-11-04

### 修复：老会话 resume 出来没有模型，消息石沉大海

**症状**：用户发消息完全没反应。`view` 显示 `status: idle`、`turn: 1`、`error` 非空，而错误内容是：

```
agent "session-ea85ec7d-..." has no provider/model: set AgentOptions.provider and
AgentOptions.model or supply both via the agent/request waterfall
```

**根因**：0.1.2 只给 `create()` 路径补了 `agentOptions`，**两处 `ctx.agents.resume({ resumeSessionId })` 都漏了**。只要 `bot.py` 把老通道时代的 `session-*` id 当 `resumeSessionId` 传过来，走的就是 resume 分支，于是拿到的 agent 没有 provider/model。

自测时用全新 chat（无 legacy sid）刚好绕开这条路，所以第一次没查出来。

**修法**：抽出 `resumeAgent(sessionId, agentOptions)`，有 options 就带上，并在 resume 之后校验 `handle.agent.options.model`，缺了主动抛错让上层回落 `create`。

---

## 0.1.5 — 2026-11-04

### 修复：新通道建出来的会话没有任何内置工具（最严重的一个）

**症状**：让它看图，它回答「`m00021` 没有原图、没有可还原图像、工具集里没有读文件能力。图片字节始终没进入上下文——这是这一轮会话的固定限制条件」。让它跑命令，它反过来教用户自己去 `ls -l`、`file`、`identify`。

核对工具清单：**43 个，全是第三方插件注册的，`read_image` / `read` / `write` / `edit` / `bash` / `glob` / `grep` 一个没有**。

**根因**：`meta.agentPreset` **只是一个记录字段，不会装配工具集**。真正的挂载点是 `AgentSetup`：

```js
setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, presetId) }
```

不调 `mount`，agent 就是个空壳——DSH 的 `preset-standard`（`config.id` 是 `standard`，不是 `preset-standard`）里那套 `tool-bash` / `tool-fs` / `tool-jobs` / `compaction` / `delegation` 全都不会生效。

**修法**：

- `create` 路径：`setup` 里 `await ctx.agentPresets.mount(agentCtx, presetId)`。
- `resume` 路径：`if (!ctx.agentPresets.composedPreset(handle.agent.ctx)) await ctx.agentPresets.select(handle.agent, presetId)`。
- `inject` 加 `'agentPresets'`。

**效果对比**（同一套 20 张图并发测试）：

| | 修之前 | 修之后 |
|---|---|---|
| 20 条并发投递成功 | 6/20 | **20/20** |
| 模型可用工具 | 43（无文件工具） | **76**（含 `read_image` 等） |
| `read_image` 真实调用次数 | 0 | **85** |
| 消息落在几个轮次 | 分散 | **turn=1，一轮全吸收** |

修完它能把 20 张测试图逐张读出来，指出编号 01–20 无缺号，算出背景色 RGB 每帧 +12/+7/+3，还自己指出第 18–20 张白字对比度掉到 2.45:1 已低于 3:1 底线，顺手生成了 `contact_sheet.png` 和 `report.md`。

> ⚠️ 换句话说：从新通道上线到 0.1.5 之前，这个机器人一直是「哑」的——它没有任何执行能力，只能说话。

---

## 0.1.4 — 2026-11-04

### 修复：并发建同一会话时互相踩，一半消息丢失

**症状**：并发 `POST /ingest` 20 次，只有 6 条返回 `{"ok":true}`，其余全是：

```json
{"ok":false,"reason":"session \"feishu-e9b0c737f47fbc99886adb0e\" already exists"}
```

**根因**：`ensureAgent` 里 `ctx.agents.get(key)` 拿不到（还没建好）→ 20 个并发请求全部涌向 `ctx.agents.create({sessionId})`，DSH 只让第一个成功，其余抛 already exists。没有按 key 的互斥。

触发条件很常见：**新开话题的第一条就发图**，或者 dsh-web 重启后内存 binding 清空。

**修法**：拆成 `ensureAgent`（单飞壳）+ `openAgent`（实际逻辑），用 `inflightOpens = new Map()` 按 key 去重，第一个建完其余 `await` 同一个 Promise 复用。

### 新增：`meta.agentPreset: 'standard'`

（当时以为这样就够了，0.1.5 才发现只是个记录字段。）

### 打包

`package.json` 加 `"files": ["lib/", "cordis.patch.yml", "README.md"]`——否则 `npm pack` 会把目录里的 `.tgz` 一起打进去，包从 20 KB 涨到 144 KB。

---

## 0.1.3 — 2026-11-03

### 新增：记忆迁移（换通道不清零）

`bot.py` 每次 `ingest` 都会带上老通道时代那个人的 `session_id`（`STATE["sessions"]` 里的 `session-*`），字段名 `resumeSessionId`。插件第一次见到某个会话键时优先 `ctx.agents.resume({ resumeSessionId })` 接续它，接不上就回落 `create` 派生新 id。

另外给 `resolveIntent()` 加了「空窗期」兜底：刚接单还没进入 `running`、或者 `inbox` 里已有待处理项时，也走 `steer`，这样两条消息会在同一个轮次边界一起被领走，不会拆成两轮。

---

## 0.1.2 — 2026-11-03

### 修复：`agent "feishu-..." has no provider/model`

**根因**：插件用 `AgentRegistry.create()` 程序化建会话，**不继承** profile 里 `agent-default-model` 那份「默认 agent」配置。必须显式给。

**修法**：`DEFAULTS` 加 `provider` / `model` / `reasoningEffort`，`buildAgentOptions()` 组装后传给 `create`。profile 的 `cordis.patch.yml` 里对应加三行。

---

## 0.1.1 — 2026-11-03

### 修复：插件加载直接失败

```
Error: cannot set property "feishuChannel" without provide at new apply (lib/index.js:514)
```

Cordis 里 `ctx.set()` 前必须先 `provide`。删掉那行对外暴露（真要暴露就 `export const provide = ['feishuChannel']`）。

---

## 0.1.0 — 2026-11-03

### 首版

- 飞书消息 → `agent.followup()` / `agent.steer()` / `agent.inject()`，落在 DSH 原生收件箱 `next-turn` / `next-step`，在轮次/步骤边界原子领取。
- 会话键三级回落：`lark:{tenant}:{chat}:thread:{omt_xxx}` → `:msg:{om_xxx}` → 群默认；`sessionId` 由 `sha256(key)[:24]` 确定性派生，不落绑定表。
- `GET /events` SSE 推 `event: view`（整卡替换，绝不造百分比 ETA），`POST /ingest` 带 outbox 幂等（键 `chatId:msgId`，JSONL + fsync）。
- `POST /control` 支持 `stop` / `recall` / `clearQueue` / `view` / `new`。
- 卡片带「停 / 撤回 / 清队」按钮。
- 34 条纯逻辑自检（`node test/selfcheck.mjs`）。
