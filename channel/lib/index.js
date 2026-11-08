/**
 * dsh-feishu-channel —— 把飞书接成 DSH 的原生通道。
 *
 * 核心一句话：**不再为每条飞书消息 spawn 一个 `dsh headless` 子进程**，
 * 而是把消息投到对应 agent 的 inbox 上。这样"跑着的时候补一句"天然成立，
 * 不需要自己发明队列。
 *
 * 依据（都是 dsh-agent 自己声明的契约，行号见方案文档 §1）：
 *   - `agent.followup(msg)`  排队一条普通的下一个轮次提示词并唤醒驱动器
 *   - `agent.steer(msg)`     提交下一步输入并唤醒它（"补充指令"就是它）
 *   - `agent.inject(msg)`    只进上下文，不唤醒
 *   - `agent.send(msg, target, wakeup)`  上面三个的统一底层入口
 *   - `agent.cancel(cause, { keepInbox: true })`  中止本轮但保留排队
 *   - `agent.inbox.nextTurn / nextStep`  排队内容，直接读就是准确值
 *
 * 为什么 steer 只在"step 边界"生效不是缺陷：OpenHands #1841 证明在工具执行
 * 中途插消息会把 message history 搞坏（Claude API 直接 invalid_request_error）。
 * 全行业（Cursor 的 next safe step、Copilot SDK 的 committed tool call、
 * OpenClaw 的 committed plan）都收敛到同一个边界上。DSH 的 next-step
 * 正好就是这个缝。
 */

import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { Outbox, SessionState, BindingStore } from './store.js';
import { sessionKey, sessionIdFor } from './sessionkey.js';
import { renderView } from './card.js';

export const name = 'dsh-feishu-channel';
export const inject = ['agents', 'agentPresets'];

/** 卡片刷新硬下限：飞书卡片 PATCH 有频次限制，比这更密只会被限流 */
const MIN_FLUSH_MS = 500;
/** 卡片上最多留几条流水（再往前折叠成「前面还有 N 步」） */
const MAX_STEPS = 4;

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
function relativeHint(p, cwd) {
  const path = String(p || '');
  const base = String(cwd || '').replace(/\/+$/, '');
  if (base && path.startsWith(base + '/')) return path.slice(base.length + 1);
  return path;
}

function hintOf(name, argsJson, cwd) {
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
  v = v.replace(/\s+/g, ' ');
  // 文件路径换成相对 cwd 的写法，否则「写入 · /home/agent/work/xxx」又长又没重点
  if (name === 'read' || name === 'write' || name === 'edit' || name === 'read_image' || name === 'glob') {
    v = relativeHint(v, cwd);
  }
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
  // 思考步骤没有 callId —— 不跳过的话会被下一条 tool/result 误标成 ✅
  if (!callId) return;
  const arr = binding.steps || [];
  for (let i = arr.length - 1; i >= 0; i -= 1) {
    if (arr[i].callId === callId) {
      arr[i].ok = ok;
      return;
    }
  }
}

const DEFAULTS = {
  host: '127.0.0.1',
  port: 8788,
  token: '',
  workspaceRoot: '/home/agent/work',
  collaborativeSteering: true,
  // 卡片刷新节流：800ms 太密，群里是一张卡不停闪，用户的原话「刷新的太多」。
  // 1.8 秒一刷，照样看得见进度，但不会让人觉得卡在抖。
  flushMs: 1800,
  stateDir: join(homedir(), '.dsh-feishu-channel'),
  // 程序化 create 出来的 agent 不继承 profile 里的 agent-default-model
  // （那是给默认 agent 用的），必须显式给出，否则第一轮就报
  // 「agent has no provider/model」。留空则退回 profile 默认（适合单模型环境）。
  provider: '',
  model: '',
  reasoningEffort: '',
  // 程序化 create 出来的 agent 也不会继承 profile 的默认 preset —— 不显式指定时
  // 拿不到 tool-fs / tool-bash / read_image 这些内置工具，机器人只剩第三方插件
  // 的工具（实测：模型自报工具清单里一个文件工具都没有）。
  agentPreset: 'standard',
};

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const outbox = new Outbox(cfg.stateDir);
  const sessions = new SessionState(cfg.stateDir);
  // 落盘：dsh-web 重启后内存绑定会清零，/events 靠这份记录复活（见 reviveBinding）
  const bindingStore = new BindingStore(cfg.stateDir);

  /** @type {Map<string, object>} key → Binding */
  const bindings = new Map();
  /** @type {Map<string, object>} sessionId → Binding */
  const bySession = new Map();

  // ─────────────────────────────────────────────────────────────
  // 绑定：会话键 ↔ agent ↔ 卡片
  // ─────────────────────────────────────────────────────────────

  function bindingFor(key) {
    return bindings.get(key);
  }

  /** 程序化创建的 agent 需要显式 provider/model，否则首轮报 "has no provider/model" */
  function buildAgentOptions() {
    const o = {};
    if (cfg.provider) o.provider = String(cfg.provider);
    if (cfg.model) o.model = String(cfg.model);
    if (cfg.reasoningEffort) o.reasoningEffort = String(cfg.reasoningEffort);
    return o;
  }

  /**
   * resume 也必须带 agentOptions。
   * 0.1.5 及更早，两处 resume 都没传 —— 接续老会话时 agent 拿不到 provider/model，
   * 首轮直接抛 "has no provider/model"，消息石沉大海（用户看到的就是「发消息没反应」）。
   * 老会话头里本就没记 provider/model（headless 时代建的），所以还要校验一次，
   * 校验不过就当接不上、回落 create。
   */
  async function resumeAgent(sessionId, agentOptions) {
    const hasOpts = agentOptions && Object.keys(agentOptions).length > 0;
    const handle = await ctx.agents.resume(
      hasOpts ? { resumeSessionId: sessionId, agentOptions } : { resumeSessionId: sessionId },
    );
    const opts = (handle && handle.agent && handle.agent.options) || {};
    if (!opts.model) {
      throw new Error("会话 " + sessionId + " 没有 provider/model");
    }
    return handle;
  }

  /**
   * 同一个 key 的并发建会话只跑一次。
   * DSH 的 create() 对同 sessionId 会抛 "already exists"，连发 20 条消息时
   * 20 个请求会同时走 create，只有第一个成功、其余全失败 —— 后 14 条静默丢失。
   */
  const inflightOpens = new Map();

  async function ensureAgent(key, cwd, resumeSessionId) {
    const existing = bindings.get(key);
    if (existing) {
      if (cwd && cwd !== existing.cwd) {
        // 会话的 cwd 是持久元数据，改目录等于改身份 —— 明确拒绝，让用户 /new
        throw new Error(`会话已绑定目录 ${existing.cwd}，换目录请先 /new`);
      }
      return existing;
    }
    const running = inflightOpens.get(key);
    if (running) return running;
    const inflight = openAgent(key, cwd, resumeSessionId).finally(() => {
      inflightOpens.delete(key);
    });
    inflightOpens.set(key, inflight);
    return inflight;
  }

  async function openAgent(key, cwd, resumeSessionId) {
    const existing = bindings.get(key);
    if (existing) return existing;

    const derivedId = sessionIdFor(key);
    const agentOptions = buildAgentOptions();
    let handle = null;
    let sessionId = derivedId;

    // 迁移路径：bot.py 记着这个人/这条会话的老 session id（headless 时代建的），
    // 第一次走新通道时优先接续它 —— 用户的记忆不会因为换通道而断掉。
    // 接不上就算了（老 id 失效、profile 不兼容、cwd 变了），开新会话继续。
    if (resumeSessionId && resumeSessionId !== derivedId) {
      const liveOld = ctx.agents.get(resumeSessionId);
      if (liveOld) {
        handle = { agent: liveOld, dispose: async () => {} };
        sessionId = resumeSessionId;
      } else {
        try {
          handle = await resumeAgent(resumeSessionId, agentOptions);
          sessionId = resumeSessionId;
          ctx.logger?.info?.(`[feishu] 接续老会话 ${resumeSessionId} (key=${key})`);
        } catch (err) {
          ctx.logger?.info?.(
            `[feishu] 老会话 ${resumeSessionId} 接不上（${String(err?.message || err)}），另开新会话`,
          );
          handle = null;
        }
      }
    }

    // 先 get（本进程里已经在跑），再 resume（持久化里存在），最后 create（新会话）
    if (!handle) {
      const live = ctx.agents.get(derivedId);
      if (live) {
        handle = { agent: live, dispose: async () => {} };
      } else {
        try {
          handle = await resumeAgent(derivedId, agentOptions);
          ctx.logger?.info?.(`[feishu] resumed session ${derivedId}`);
          // 0.1.3 及更早建的会话头里没有 preset，resume 回来是裸的（只有第三方
          // 插件工具）。顺手补一次，让老会话也拿回 read_image / pwsh / tool-fs。
          const resumePreset = cfg.agentPreset || 'standard';
          try {
            if (!ctx.agentPresets.composedPreset(handle.agent.ctx)) {
              await ctx.agentPresets.select(handle.agent, resumePreset);
              ctx.logger?.info?.(`[feishu] 老会话补上 preset=${resumePreset}`);
            }
          } catch (err) {
            ctx.logger?.warn?.(
              `[feishu] 补 preset 失败（${String(err?.message || err)}），沿用现有工具集`,
            );
          }
        } catch {
          const presetId = cfg.agentPreset || 'standard';
          handle = await ctx.agents.create({
            sessionId: derivedId,
            // meta.agentPreset 只是「记在会话头上的名字」，不负责装配插件。
            // 不 mount 的话这个 agent 只拿到 profile 级的第三方插件，
            // 内置工具（tool-fs 的 read/write/edit/read_image、tool-bash、pwsh、
            // todo、web、skill…）一个都没有 —— 实测模型自报 43 个工具全是第三方，
            // 连 read_image 都没有，发 20 张图它只能让用户自己去跑 ls。
            meta: {
              cwd: cwd || cfg.workspaceRoot,
              agentPreset: presetId,
            },
            agentOptions,
            // setup 在 agent 发布前执行，观察者看不到「半装配」状态；
            // mount 把 preset 声明的那组插件装进这个 agent 的作用域。
            setup: async (agentCtx) => {
              await ctx.agentPresets.mount(agentCtx, presetId);
            },
          });
          sessionId = derivedId;
          ctx.logger?.info?.(`[feishu] created session ${derivedId} @ ${cwd || cfg.workspaceRoot} preset=${presetId}`);
        }
      }
    }

    const binding = {
      key,
      sessionId,
      cwd: cwd || cfg.workspaceRoot,
      chatId: '',
      handle,
      agent: handle.agent,
      subscribers: new Set(),
      timer: null,
      lastFlush: 0,
      // 出站通道状态：SSE 没连上时回答先存这儿，连上再补发（见 flushPendingReplies）
      pendingReplies: [],
      sentMessageIds: new Set(),
      steps: [],
    view: { key, sessionId, status: 'idle', turn: 0, queue: [], streaming: '', steps: [], error: null },
    };
    bindings.set(key, binding);
    bySession.set(sessionId, binding);
    // 建好就落盘：这样即使下一秒重启，/events 也能把这条群接回来
    persistBinding(binding, true);
    return binding;
  }

  // ─────────────────────────────────────────────────────────────
  // 事件 → 视图模型（这里不猜状态，全部读真值）
  // ─────────────────────────────────────────────────────────────

  // ─────────────────────────────────────────────────────────────
  // 绑定落盘 / 复活
  // ─────────────────────────────────────────────────────────────

  /**
   * 把复活必需的字段写盘。节流 3 秒，避免 snapshot 每次刷新都写文件。
   */
  function persistBinding(binding, force) {
    if (!binding) return;
    const now = Date.now();
    if (!force && binding._persistAt && now - binding._persistAt < 3000) return;
    binding._persistAt = now;
    try {
      bindingStore.save(binding.key, {
        sessionId: binding.sessionId,
        cwd: binding.cwd || cfg.workspaceRoot,
        chatId: binding.chatId || '',
      });
    } catch (err) {
      ctx?.logger?.warn?.(`[feishu] 绑定落盘失败 ${binding.key}: ${err?.message || err}`);
    }
  }

  /**
   * dsh-web 重启后内存绑定清零，但磁盘上还有这条群的记录 → 就地把 agent 接回来。
   *
   * 走 ensureAgent，所以优先 resume 原来那个 session（记忆不丢），
   * resume 失败才回落派生 id。返回 undefined 表示这条 key 真没记录。
   */
  async function reviveBinding(key) {
    const rec = bindingStore.get(key);
    if (!rec) return undefined;
    try {
      const binding = await ensureAgent(key, rec.cwd || cfg.workspaceRoot, rec.sessionId);
      if (rec.chatId) binding.chatId = rec.chatId;
      if (rec.sessionId) binding.view.turn = binding.view.turn || 0;
      persistBinding(binding, true);
      ctx?.logger?.info?.(`[feishu] 恢复绑定 ${key} → ${binding.sessionId}（重启后自动接回，记忆保留）`);
      return binding;
    } catch (err) {
      ctx?.logger?.warn?.(`[feishu] 恢复绑定失败 ${key}: ${err?.message || err}`);
      return undefined;
    }
  }

  function snapshot(binding) {
    const { agent } = binding;
    const inbox = agent.inbox;
    const queue = [
      ...inbox.nextTurn.map((m) => entryOf(m, 'next-turn')),
      ...inbox.nextStep.map((m) => entryOf(m, 'next-step')),
    ];
    binding.view = {
      key: binding.key,
      sessionId: binding.sessionId,
      chatId: binding.chatId || '',
      cwd: binding.cwd,
      status: agent.status, // 'idle' | 'running'
      turn: binding.view.turn,
      queue,
      queuedAhead: inbox.nextTurn.length, // 准确的"前面还有几条"，不是估的
      streaming: binding.view.streaming,
      // 工具流水：卡片上只显示最近 MAX_STEPS 条，前面折叠成计数
      steps: (binding.steps || []).slice(-MAX_STEPS),
      stepsTotal: (binding.steps || []).length,
      error: binding.view.error,
      updatedAt: Date.now(),
    };
    // chatId / turn 会随消息变化，顺手节流落盘一次（3 秒内不重复写）
    if (binding.chatId) persistBinding(binding);
    return binding.view;
  }

  function entryOf(message, target) {
    const src = message.source || {};
    const text = (message.content || [])
      .filter((b) => b && b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    return {
      id: message.id,
      target,
      author: src.openId || src.actor || 'unknown',
      name: src.name || '',
      text: text.length > 200 ? `${text.slice(0, 200)}…` : text,
      at: src.at || null,
    };
  }

  function schedulePush(binding, force = false) {
    if (binding.timer) return;
    const now = Date.now();
    const wait = force ? 0 : Math.max(MIN_FLUSH_MS - (now - binding.lastFlush), 0);
    binding.timer = setTimeout(() => {
      binding.timer = null;
      binding.lastFlush = Date.now();
      push(binding);
    }, Math.max(wait, 16));
    if (typeof binding.timer.unref === 'function') binding.timer.unref();
  }

  function push(binding) {
    const view = renderView(snapshot(binding));
    const payload = `event: view\ndata: ${JSON.stringify(view)}\n\n`;
    for (const res of binding.subscribers) {
      try {
        res.write(payload);
      } catch {
        binding.subscribers.delete(res);
      }
    }
    ctx.emit?.('feishu/view', { key: binding.key, view });
  }

  // ─────────────────────────────────────────────────────────────
  // 出站通道：agent 说的话要回到飞书群
  // ─────────────────────────────────────────────────────────────
  // 视图卡只能显示「在跑/空闲/排队」，它永远不含答案正文。
  // 答案在 session 的 assistant/message 事件里 —— 这是唯一带完整正文的地方
  // （agent/assistant-stream 的 end 帧只有 index + eventType，没有文本）。
  //
  // 走 SSE 的 event: reply，不塞进视图，理由：一条回答可能几千字，
  // 塞进卡片会被截断，也没有"消息"该有的时间线感。卡片是状态，消息是内容。
  //
  // 断线兜底：SSE 没连上时（门房重启、网络抖动）回答不能丢，
  // 所以先塞进 binding.pendingReplies，新订阅者连上时补发。
  const MAX_PENDING_REPLIES = 20;

  function pushReply(binding, text) {
    const frame = {
      key: binding.key,
      sessionId: binding.sessionId,
      chatId: binding.chatId || '',
      text,
      effort: cfg.reasoningEffort || 'auto',
      turn: binding.turn || 0,
      at: Date.now(),
    };
    const payload = `event: reply\ndata: ${JSON.stringify(frame)}\n\n`;
    if (binding.subscribers.size === 0) {
      binding.pendingReplies.push(frame);
      if (binding.pendingReplies.length > MAX_PENDING_REPLIES) binding.pendingReplies.shift();
      ctx.logger?.info?.(`[feishu] 回答暂存（SSE 未连），累计 ${binding.pendingReplies.length} 条`);
    } else {
      for (const res of binding.subscribers) {
        try {
          res.write(payload);
        } catch {
          binding.subscribers.delete(res);
        }
      }
    }
    ctx.emit?.('feishu/reply', frame);
  }

  function flushPendingReplies(binding, res) {
    if (!binding.pendingReplies.length) return;
    const pending = binding.pendingReplies.splice(0);
    for (const frame of pending) {
      try {
        res.write(`event: reply\ndata: ${JSON.stringify(frame)}\n\n`);
      } catch {
        binding.pendingReplies.push(frame);
        break;
      }
    }
    if (pending.length) ctx.logger?.info?.(`[feishu] 补发暂存回答 ${pending.length} 条`);
  }

  // 思考过程：ReasoningBlock = { type: 'reasoning', text }（dsh-llm/types.d.ts:51）
  // 只截尾部 2000 字 —— 思考常常几千字，全塞进飞书会把消息撑爆；
  // 尾部保留是因为结论性的判断一般在最后。
  function reasoningOfMessage(message) {
    const parts = (message?.content || [])
      .filter((b) => b && b.type === 'reasoning' && typeof b.text === 'string')
      .map((b) => b.text.trim())
      .filter(Boolean);
    if (parts.length === 0) return '';
    const all = parts.join('\n').trim();
    const MAX = 2000;
    return all.length > MAX ? '…（前面略）\n' + all.slice(-MAX) : all;
  }

  function textOfMessage(message) {
    return (message?.content || [])
      .filter((b) => b && b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
  }

  function bindingOfAgent(agent) {
    return bySession.get(agent?.session?.id);
  }

  // 全部 agent/* 订阅都带 { global: true }：插件挂在 root scope 上，
  // 不带 global 只能收到「当前 scope 内」的 agent（dsh-purge 订阅
  // agent/pre-step 用的也是同一写法，见 lib/index.js:478）。
  const GLOBAL = { global: true };

  // agent/status：唯一可靠的 idle ⇄ running 边界
  ctx.on('agent/status', ({ agent, status }) => {
    const b = bindingOfAgent(agent);
    if (!b) return;
    if (status === 'running') b.view.turn += 1;
    else b.view.streaming = '';
    schedulePush(b, status === 'idle');
  }, GLOBAL);

  // inbox 变化：排队区即时更新，不必等轮询
  for (const evt of ['agent/inbox/inserted', 'agent/inbox/claimed', 'agent/inbox/discarded']) {
    ctx.on(evt, ({ agent }) => {
      const b = bindingOfAgent(agent);
      if (!b) return;
      schedulePush(b);
    }, GLOBAL);
  }

  // 流式输出：这里是唯一需要"追加"而不是"重画"的地方。
  // chunk 的类型名以 dsh-llm 的 StreamChunk 为准；认不出来的 chunk 直接忽略，
  // 最坏结果只是流式区不显示，落定后的完整消息照常出现（不影响正确性）。
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    const b = bindingOfAgent(agent);
    if (!b) return;
    if (frame.type === 'start') b.view.streaming = '';
    else if (frame.type === 'chunk') {
      const c = frame.chunk;
      if (c && c.type === 'text-delta' && typeof c.text === 'string') {
        b.view.streaming += c.text;
        if (b.view.streaming.length > 4000) b.view.streaming = b.view.streaming.slice(-4000);
      }
    } else if (frame.type === 'end') {
      // 落定后交给下一条 assistant/message 的完整内容，避免残留半句
      schedulePush(b, true);
    }
    schedulePush(b);
  }, GLOBAL);

  // 出站：把 agent 的完整回答送回飞书。
  // 签名是 (session, event) —— dsh-session/lib/types/index.d.ts:64
  //   'session/event'(this: Scoped<Session>, session: Session, event: SessionEvent): void
  // 子 agent（mnemon、subagent 工具起的）走别的 session.id，bySession 找不到就跳过，
  // 不会把内部打工的话当成回答发到群里。
  ctx.on('session/event', (session, event) => {
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
        hint: hintOf(d.name, d.arguments, b.cwd),
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
    // 2026-11-08：连正文也不留了 —— 把模型的英文内心独白贴进群里，
    // 既占地方又是用户看不懂的内容。只记「想过一次」，
    // 连续思考合并成计数（×N），卡片上就不会被一串「思考 · …」占满。
    const reasoning = reasoningOfMessage(event.data?.message);
    if (reasoning && reasoning.trim()) {
      const last = (b.steps || [])[b.steps.length - 1];
      if (last && last.kind === 'think') {
        last.think = (last.think || 1) + 1;
        last.at = Date.now();
      } else {
        pushStep(b, { kind: 'think', verb: '思考', think: 1 });
      }
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
  }, GLOBAL);

  ctx.on('agent/error', ({ agent, error }) => {
    const b = bindingOfAgent(agent);
    if (!b) return;
    b.view.error = error instanceof Error ? error.message : String(error);
    schedulePush(b, true);
  }, GLOBAL);

  ctx.on('agent/disposed', ({ agent }) => {
    const b = bindingOfAgent(agent);
    if (!b) return;
    bySession.delete(b.sessionId);
    bindings.delete(b.key);
    for (const res of b.subscribers) {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
  }, GLOBAL);

  // ─────────────────────────────────────────────────────────────
  // 接单：幂等 → 选目标队列 → 投递
  // ─────────────────────────────────────────────────────────────

  /**
   * @param {object} msg
   * @param {string} msg.chatId
   * @param {string} msg.msgId        飞书 message_id（om_）
   * @param {string} [msg.threadId]   话题 ID（omt_）
   * @param {string} [msg.rootId]     回复串根消息 ID
   * @param {string} [msg.tenantKey]
   * @param {string} msg.openId       发送者
   * @param {string} [msg.name]
   * @param {string} msg.text
   * @param {'auto'|'steer'|'followup'|'inject'} [msg.intent]
   * @param {string} [msg.cwd]
   */
  async function ingest(msg) {
    const key = sessionKey(msg);
    const idem = Outbox.keyOf(msg.chatId, msg.msgId);

    // 1) 先落盘。没落盘就投递 = 崩溃时可能重复执行。
    if (!outbox.claim(idem, { key, msgId: msg.msgId, openId: msg.openId, at: Date.now() })) {
      return { ok: true, duplicate: true, key };
    }

    let binding;
    try {
      binding = await ensureAgent(key, msg.cwd, msg.resumeSessionId);
    } catch (err) {
      outbox.mark(idem, 'failed', { reason: String(err?.message || err) });
      throw err;
    }
    // 记下 chatId：bot.py 收到 view 之后要往这个会话里画卡片。
    // chatId 是复活后的关键（没它就不知道该把卡片画到哪个群），所以一变就强制落盘。
    if (msg.chatId && binding.chatId !== msg.chatId) {
      binding.chatId = msg.chatId;
      persistBinding(binding, true);
    }

    // 2) 选队列。默认 followup —— 跟 Copilot SDK / OpenClaw / Cursor 的默认一致：
    //    "随手再发一句"不该被猜成打断。
    const message = toUserMessage(msg);
    const intent = resolveIntent(binding, msg);

    try {
      if (intent === 'inject') {
        binding.agent.inject(message);
      } else if (intent === 'steer') {
        binding.agent.steer(message);
      } else {
        binding.agent.followup(message);
      }
    } catch (err) {
      outbox.mark(idem, 'failed', { reason: String(err?.message || err), intent });
      throw err;
    }

    // 3) 记账
    outbox.mark(idem, 'delivered', { intent, messageId: message.id });
    schedulePush(binding, true);
    return { ok: true, key, sessionId: binding.sessionId, intent, messageId: message.id };
  }

  function resolveIntent(binding, msg) {
    if (msg.intent && msg.intent !== 'auto') return msg.intent;
    const agent = binding.agent;
    // 跑着的时候默认 steer —— 跟 OpenClaw 的默认一致，也是这个项目的初衷：
    // 用户在群里"补一句"，本来就是要它当场吸收，而不是排到下一轮再说。
    // 安全性由 DSH 的 next-step 领取语义兜底：只在下一次模型调用前的
    // 工具结果边界插入，不会打断已在执行的工具调用。
    if (agent.status === 'running') return 'steer';
    // 空窗期（刚接单、轮次还没真正开跑）：inbox 里还有待处理项说明上一条刚落地，
    // 这时也走 steer，两条会被同一个轮次边界一起领走，而不是排成两轮。
    const busy =
      (typeof agent.inbox?.hasPending === 'function' && agent.inbox.hasPending()) ||
      (binding.view.queue || []).length > 0;
    if (busy) return 'steer';
    // 真正空闲：必须 followup，否则 next-step 项没有轮次来领取，会一直躺着
    return 'followup';
  }

  function toUserMessage(msg) {
    return {
      id: msg.msgId || `feishu-${randomUUID()}`,
      role: 'user',
      content: [{ type: 'text', text: msg.text }],
      source: {
        kind: 'feishu',
        chatId: msg.chatId,
        openId: msg.openId,
        name: msg.name || '',
        msgId: msg.msgId,
        threadId: msg.threadId || null,
        at: Date.now(),
      },
    };
  }

  // ─────────────────────────────────────────────────────────────
  // 控制面：停 / 撤回 / 换目录 / 新会话
  // ─────────────────────────────────────────────────────────────

  async function control(action) {
    const key = action.key;
    const binding = bindings.get(key);
    if (!binding) return { ok: false, reason: 'no such session' };

    switch (action.type) {
      case 'stop':
        // 关键：必须 keepInbox，否则用户排的话全被 cancel 清掉
        binding.agent.cancel({ kind: 'user' }, { keepInbox: true });
        schedulePush(binding, true);
        return { ok: true, stopped: true };

      case 'recall': {
        // 撤回一条还没被领走的排队消息
        const removed = binding.agent.inbox.remove(action.messageId);
        schedulePush(binding, true);
        return { ok: true, removed };
      }

      case 'clearQueue':
        binding.agent.inbox.clear();
        schedulePush(binding, true);
        return { ok: true };

      case 'view':
        // 返回**原始视图模型**（含 queue/status/turn），不是渲染后的卡片：
        // /queue 这类命令要读结构，卡片由 SSE 那边按 renderView 出。
        return { ok: true, view: snapshot(binding) };

      case 'new': {
        // 换一条新会话线：先停稳，再注销旧绑定；下一个消息会 create 新 session
        binding.agent.cancel({ kind: 'user' }, { keepInbox: false });
        await binding.agent.whenIdle().catch(() => {});
        await binding.handle.dispose().catch(() => {});
        bindings.delete(key);
        bySession.delete(binding.sessionId);
        sessions.patch(key, { archivedSessionId: binding.sessionId });
        return { ok: true, archived: binding.sessionId };
      }

      default:
        return { ok: false, reason: `unknown action ${action.type}` };
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 崩溃恢复：把卡在 accepted 的消息补投一次
  // ─────────────────────────────────────────────────────────────

  async function recover() {
    const pending = outbox.pending();
    if (!pending.length) return;
    ctx.logger?.info?.(`[feishu] recovering ${pending.length} pending message(s)`);
    for (const row of pending) {
      const p = row.payload || {};
      try {
        const binding = await ensureAgent(p.key, undefined);
        const message = {
          id: `${p.msgId}-recover`,
          role: 'user',
          content: [{ type: 'text', text: `[补投] 之前未确认送达的消息：${p.msgId}` }],
          source: { kind: 'feishu', openId: p.openId, msgId: p.msgId, recovered: true },
        };
        binding.agent.followup(message);
        outbox.mark(row.key, 'delivered', { recovered: true });
      } catch (err) {
        outbox.mark(row.key, 'failed', { reason: String(err?.message || err) });
      }
    }
  }

  // ─────────────────────────────────────────────────────────────
  // HTTP 接入层（bot.py / 任何 IM 前端都能调）
  // ─────────────────────────────────────────────────────────────

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, {
        ok: true,
        sessions: bindings.size,
        pending: outbox.pending().length,
      });
    }

    // 共享口令：飞书侧带 X-Channel-Token
    if (cfg.token && req.headers['x-channel-token'] !== cfg.token) {
      return json(res, 401, { ok: false, reason: 'bad token' });
    }

    if (req.method === 'POST' && url.pathname === '/ingest') {
      const body = await readJson(req);
      try {
        const out = await ingest(body);
        return json(res, 200, out);
      } catch (err) {
        return json(res, 500, { ok: false, reason: String(err?.message || err) });
      }
    }

    if (req.method === 'POST' && url.pathname === '/control') {
      const body = await readJson(req);
      try {
        return json(res, 200, await control(body));
      } catch (err) {
        return json(res, 500, { ok: false, reason: String(err?.message || err) });
      }
    }

    // SSE：bot.py 订阅视图变化，自己决定怎么画卡片
    if (req.method === 'GET' && url.pathname === '/events') {
      const key = url.searchParams.get('key') || '';
      let binding = bindings.get(key);
      if (!binding) {
        // dsh-web 重启后内存绑定没了，但磁盘上还有 → 复活再连（否则门房只能拿到 404）
        // reviveBinding 自己吞异常并返回 undefined；这里再兜一层，
        // 因为未捕获的 rejection 会让整个 dsh 进程 fatal（2026-11-04 实测踩过）
        try {
          binding = await reviveBinding(key);
        } catch (err) {
          ctx?.logger?.warn?.(`[feishu] 复活会话 ${key} 失败：${err?.message || err}`);
          binding = undefined;
        }
      }
      if (!binding) return json(res, 404, { ok: false, reason: 'no such session' });

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write('retry: 3000\n\n');
      binding.subscribers.add(res);
      res.write(`event: view\ndata: ${JSON.stringify(renderView(snapshot(binding)))}\n\n`);
      // 断线期间攒下的回答在这里补发（门房重启/SSE 抖动时不丢消息）
      flushPendingReplies(binding, res);
      const ka = setInterval(() => {
        try {
          res.write(': ka\n\n');
        } catch {
          clearInterval(ka);
        }
      }, 15000);
      if (typeof ka.unref === 'function') ka.unref();
      req.on('close', () => {
        clearInterval(ka);
        binding.subscribers.delete(res);
      });
      return undefined;
    }

    return json(res, 404, { ok: false, reason: 'not found' });
  });

  // 端口占用 / 无权限不要让整个宿主跟着挂：插件只是可选能力，
  // 起不来就退回老路径（bot.py 那边会 health 失败 → channel_mode 自动失效）。
  server.on('error', (err) => {
    ctx.logger?.warn?.(`[feishu] channel listen failed on ${cfg.host}:${cfg.port}: ${err?.message || err}`);
  });

  server.listen(cfg.port, cfg.host, () => {
    ctx.logger?.info?.(`[feishu] channel listening on http://${cfg.host}:${cfg.port}`);
  });

  // 插件卸载时收干净，否则热重载会占着端口
  ctx.effect(() => () => {
    server.close();
    for (const b of bindings.values()) {
      for (const res of b.subscribers) {
        try {
          res.end();
        } catch {
          /* ignore */
        }
      }
      if (b.timer) clearTimeout(b.timer);
    }
    bindings.clear();
    bySession.clear();
  });

  // 恢复放最后，失败不影响服务起来
  recover().catch((err) => ctx.logger?.warn?.(`[feishu] recover failed: ${err}`));

  // 注意：不要在这里 ctx.set('feishuChannel', ...)。Cordis 要求先 provide
  // 才能 set，否则插件构造直接抛 "cannot set property ... without provide"，
  // 整个插件加载失败（这就是 0.1.0 在 agent 上栽的那一跤）。
  // 需要对外暴露时，走 export const provide = ['feishuChannel']。
}

function json(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(text);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 4 * 1024 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}
