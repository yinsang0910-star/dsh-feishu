# -*- coding: utf-8 -*-
"""
0.1.8 → 0.1.9：把 DSH GUI 那套「工具流水」搬进飞书卡片。

用户原话：
  「这服务器上明明是在工作的，但是群聊里根本就不显示，然后还莫名其妙的
    尾部贴上全部思考和过程，又占地方又恶心人」

改动（每处 count == 1）：
  S1  加常量 MAX_STEPS / TOOL_VERB / verbOf / hintOf / pushStep / markStep
  S2  binding 初始化加 steps: []
  S3  snapshot() 的 view 加 steps
  S4  session/event 订阅：先认 tool/call 与 tool/result，再认 assistant/message
  S5  assistant/message 的 reasoning 改成「一条思考步骤」，不再塞 reply 尾部
  S6  pushReply 去掉 reasoning 参数
"""
import io
import sys

SRC = r"C:\Users\苏元洛\.pve600\dsh-feishu-channel\lib\index.js"
DST = r"C:\Users\苏元洛\.pve600\dsh-feishu-channel\lib\index.js.new"

s = io.open(SRC, encoding="utf-8").read()


def rep(old, new, why):
    global s
    n = s.count(old)
    if n != 1:
        print("!! [%s] 锚点命中 %d 次，中止" % (why, n))
        sys.exit(1)
    s = s.replace(old, new, 1)
    print("OK " + why)


# ── S1：常量 + 工具流水辅助函数 ────────────────────────────────────────
rep(
    "const MIN_FLUSH_MS = 500;",
    """const MIN_FLUSH_MS = 500;
/** 卡片上最多留几条流水（再往前折叠成「前面还有 N 步」） */
const MAX_STEPS = 8;

/** 工具名 → 中文动词。没收录的回落成「调用 <name>」。 */
const TOOL_VERB = {
  read_image: '读取图片',
  read: '读取',
  write: '写入',
  edit: '编辑',
  glob: '查找文件',
  grep: '搜索内容',
  bash: '运行命令',
  pwsh: '运行命令',
  todo_write: '更新清单',
  web_search: '搜索网页',
  web_fetch: '读取网页',
  skill: '加载技能',
  subagent: '派子任务',
  ask_user_question: '询问用户',
};

function verbOf(name) {
  return TOOL_VERB[name] || ('调用 ' + name);
}

/** 从原始 arguments 字符串里挑一个最能说明「在干什么」的字段，截断。 */
function hintOf(name, argsJson) {
  let a = {};
  try {
    a = JSON.parse(argsJson || '{}') || {};
  } catch {
    a = {};
  }
  // 命令类优先 description（模型自己写的一句话），比整条 command 好读
  const order =
    name === 'bash' || name === 'pwsh'
      ? ['description', 'command']
      : ['file_path', 'path', 'pattern', 'query', 'url', 'description', 'command', 'text'];
  let v = '';
  for (const k of order) {
    if (typeof a[k] === 'string' && a[k].trim()) {
      v = a[k].trim();
      break;
    }
  }
  if (!v) {
    // 兜底：第一个字符串型参数
    for (const k of Object.keys(a)) {
      if (typeof a[k] === 'string' && a[k].trim()) {
        v = a[k].trim();
        break;
      }
    }
  }
  v = v.replace(/\\s+/g, ' ');
  return v.length > 72 ? v.slice(0, 72) + '…' : v;
}

/** 压一条流水进去。kind: 'tool' | 'think' */
function pushStep(binding, step) {
  const arr = binding.steps || (binding.steps = []);
  arr.push({ at: Date.now(), ok: null, ...step });
  if (arr.length > 40) arr.splice(0, arr.length - 40);
}

/** tool/result 回来时，把同 callId 那条标成成功/失败。 */
function markStep(binding, callId, ok) {
  const arr = binding.steps || [];
  for (let i = arr.length - 1; i >= 0; i -= 1) {
    if (arr[i].callId === callId) {
      arr[i].ok = ok;
      return;
    }
  }
}""",
    "S1 常量与工具流水函数",
)

# ── S2：binding 初始化加 steps ─────────────────────────────────────────
rep(
    "    view: { key, sessionId, status: 'idle', turn: 0, queue: [], streaming: '', error: null },",
    """    steps: [],
    view: { key, sessionId, status: 'idle', turn: 0, queue: [], streaming: '', steps: [], error: null },""",
    "S2 binding.steps",
)

# ── S3：snapshot 带出 steps ───────────────────────────────────────────
rep(
    "      streaming: binding.view.streaming,\n      error: binding.view.error,",
    """      streaming: binding.view.streaming,
      // 工具流水：卡片上只显示最近 MAX_STEPS 条，前面折叠成计数
      steps: (binding.steps || []).slice(-MAX_STEPS),
      stepsTotal: (binding.steps || []).length,
      error: binding.view.error,""",
    "S3 snapshot.steps",
)

# ── S4+S5：session/event 订阅整体替换 ─────────────────────────────────
OLD_SUB = """  ctx.on('session/event', (session, event) => {
    const b = bySession.get(session?.id);
    if (!b) return;
    if (!event || event.type !== 'assistant/message') return;
    const text = textOfMessage(event.data?.message);
    const reasoning = reasoningOfMessage(event.data?.message);
    // 只有思考没有正文（纯工具调用的那一轮）就不发，避免刷屏；
    // 正文和思考都有时才把思考一并带上。
    if (!text) return;
    const msgId = event.data?.message?.id;
    // 同一条消息可能因为投影刷新被重复投递，按 message id 去重
    if (msgId && b.sentMessageIds.has(msgId)) return;
    if (msgId) b.sentMessageIds.add(msgId);
    if (b.sentMessageIds.size > 200) {
      b.sentMessageIds = new Set([...b.sentMessageIds].slice(-100));
    }
    pushReply(b, text, reasoning);
    schedulePush(b, true); // 顺带把卡片刷成最新状态（可能是空闲）
  }, GLOBAL);"""

NEW_SUB = """  ctx.on('session/event', (session, event) => {
    const b = bySession.get(session?.id);
    if (!b) return;
    if (!event) return;

    // ── 工具流水：这是「服务器明明在干活、群里却看不见」的正面修复 ──
    // 'tool/call'   { turn, step, callId, name, arguments }  arguments 是未解析的 JSON 字符串
    // 'tool/result' { turn, step, message, error?, meta? }
    // 定义见 dsh-session/lib/types/types.d.ts:355 与 :375
    if (event.type === 'tool/call') {
      const d = event.data || {};
      pushStep(b, {
        kind: 'tool',
        callId: d.callId,
        verb: verbOf(d.name),
        hint: hintOf(d.name, d.arguments),
      });
      schedulePush(b, true);
      return;
    }
    if (event.type === 'tool/result') {
      const d = event.data || {};
      markStep(b, d.callId, !(d.message && d.message.isError));
      schedulePush(b);
      return;
    }

    if (event.type !== 'assistant/message') return;
    const text = textOfMessage(event.data?.message);

    // 思考只作为「一条流水」，绝不整段贴进回答卡片。
    // 用户的评价：「莫名其妙的尾部贴上全部思考和过程，又占地方又恶心人」。
    const reasoning = reasoningOfMessage(event.data?.message);
    if (reasoning) {
      const one = reasoning.replace(/\\s+/g, ' ').trim();
      if (one) pushStep(b, { kind: 'think', verb: '思考', hint: one.length > 90 ? one.slice(0, 90) + '…' : one });
    }

    // 只有思考没有正文（纯工具调用的那一轮）就不发回答，避免刷屏。
    if (!text) {
      schedulePush(b);
      return;
    }
    const msgId = event.data?.message?.id;
    // 同一条消息可能因为投影刷新被重复投递，按 message id 去重
    if (msgId && b.sentMessageIds.has(msgId)) return;
    if (msgId) b.sentMessageIds.add(msgId);
    if (b.sentMessageIds.size > 200) {
      b.sentMessageIds = new Set([...b.sentMessageIds].slice(-100));
    }
    pushReply(b, text);
    schedulePush(b, true); // 顺带把卡片刷成最新状态（可能是空闲）
  }, GLOBAL);"""

rep(OLD_SUB, NEW_SUB, "S4/S5 事件订阅与思考降级")

# ── S6：pushReply 去掉 reasoning 全文 ─────────────────────────────────
rep(
    "  function pushReply(binding, text, reasoning) {",
    "  function pushReply(binding, text) {",
    "S6a pushReply 签名",
)
# 删掉 frame 里的 reasoning 行（连同它上面那行注释）
import re as _re

_m = _re.search(r"\n[ \t]*//[^\n]*\n[ \t]*reasoning: reasoning \|\| '',", s)
if not _m:
    _m2 = _re.search(r"\n[ \t]*reasoning: reasoning \|\| '',", s)
    if not _m2:
        print("!! [S6b] 找不到 reasoning 行，中止")
        sys.exit(1)
    s = s[: _m2.start()] + s[_m2.end() :]
    print("OK S6b 删除 reasoning 行（无注释）")
else:
    s = s[: _m.start()] + s[_m.end() :]
    print("OK S6b 删除 reasoning 行（连带注释）")

# ── S7：flushPendingReplies 里不再有 reasoning 字段要处理（确认） ──
print("S7 跳过（flushPendingReplies 原样转发 frame，无需改）")

io.open(DST, "w", encoding="utf-8", newline="\n").write(s)
print("")
print("已写出 %s（%d 字符）" % (DST, len(s)))
