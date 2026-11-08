/**
 * 视图模型 → 飞书交互卡片。
 *
 * 两条硬规矩（都是照平台文档的坑写的）：
 *
 * 1. **一张常驻卡片，整卡替换。** 不要每来一条消息就 send 一条新的 —— 那正是
 *    现在"只弹一句排队"的毛病。飞书卡片支持对已发送卡片做 PATCH 更新，
 *    整卡替换是幂等的，重发同一份内容不会产生副作用。Slack 那边同理
 *    （`chat.update` 传 blocks 更新不产生 edited 标记）；飞书侧等价物是
 *    `PATCH /open-apis/im/v1/message-card/*`，且**发送后 14 天内可更新**。
 *
 * 2. **不造 ETA 百分比。** OpenClaw 的进度卡文档明确写了 "never invent
 *    percentages"，只报实测的已完成/总数。这里就只报：
 *      - 当前阶段（空闲 / 思考中 / 执行中）
 *      - 前面还有几条（inbox.nextTurn.length，真值）
 *      - 这是第几轮（turn 计数，真值）
 *    ETA 这种东西在多用户队列里天然不可靠（OpenClaw 的 queueAhead 文档都明说
 *    "不代表最终准入顺序"）。
 */

const PHASE_TEXT = {
  idle: '空闲',
  running: '在跑',
};

const PHASE_TEMPLATE = {
  idle: 'grey',
  running: 'blue',
};

/**
 * @param {object} view 由 index.js 的 snapshot() 产出
 * @returns {{ card: object, text: string, rev: number }}
 */
export function renderView(view) {
  const phase = view.status === 'running' ? 'running' : 'idle';
  const queue = view.queue || [];
  const ahead = view.queuedAhead ?? queue.filter((q) => q.target === 'next-turn').length;

  // 标题已经写了「空闲 / 正在处理」，副标题别再重复一遍，只说排队与轮次
  const titleBits = [];
  if (ahead > 0) titleBits.push(`排队 ${ahead}`);
  if (view.turn > 0) titleBits.push(`第 ${view.turn} 轮`);

  const elements = [];

  // 排队区：只列真在等的东西，且标明它等的是哪个边界
  if (queue.length) {
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: queue.map((q, i) => queuedLine(q, i)).join('\n'),
      },
    });
  } else if (phase === 'running') {
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: '_队列空，正在处理当前这轮_ ' },
    });
  }

  // 工具流水：这是「服务器明明在干活、群里却看不见」的正面修复。
  // 只显示最近几条，前面的折叠成一行计数（卡片大小有上限）。
  const steps = view.steps || [];
  const total = view.stepsTotal || steps.length;
  if (steps.length && phase === 'running') {
    elements.push({ tag: 'hr' });
    const rows = [];
    if (total > steps.length) rows.push(`_… 前面 ${total - steps.length} 步已完成_`);
    for (const st of steps) rows.push(stepLine(st));
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: rows.join('\n') } });
  } else if (steps.length && phase === 'idle') {
    // 空闲了还把上一轮的流水挂在「💤 空闲」下面，状态和内容互相打架 ——
    // 只留一句计数，想看细节等下一轮跑起来时它会重新铺开。
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: `_上一轮 ${total} 步，已经跑完了_` },
    });
  } else if (phase === 'running') {
    elements.push({ tag: 'hr' });
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: '_正在想…_' } });
  }

  // 流式正文：只留尾部，别把整段塞进卡片（飞书卡片 JSON 有大小上限）
  if (view.streaming) {
    elements.push({ tag: 'hr' });
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: tail(view.streaming, 600) } });
  }

  if (view.error) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: `**出错**：${escapeMd(tail(view.error, 400))}` },
    });
  }

  // 操作区：停 / 撤最后一条 / 看队列
  elements.push({ tag: 'hr' });
  const buttons = [];
  if (phase === 'running') {
    buttons.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '停' },
      type: 'danger',
      value: { act: 'stop', key: view.key },
    });
  }
  if (queue.length) {
    buttons.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '撤回最后一条' },
      type: 'default',
      value: { act: 'recall', key: view.key, messageId: queue[queue.length - 1].id },
    });
    buttons.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '清空队列' },
      type: 'default',
      value: { act: 'clearQueue', key: view.key },
    });
  }
  if (buttons.length) {
    elements.push({ tag: 'action', actions: buttons });
  }

  // 页脚：真有人想知道在哪个目录、跑了几步，放这里，一行说完。
  const foot = [];
  if (view.stepsTotal) foot.push(`${view.stepsTotal} 步`);
  const ws = String(view.cwd || '').split('/').filter(Boolean).pop();
  if (ws) foot.push(ws);
  if (foot.length) {
    elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: foot.join(' · ') }] });
  }

  const card = {
    config: {
      wide_screen_mode: true,
      // update_multi 必须为 true，否则这张卡只能 patch 一次
      update_multi: true,
    },
    header: {
      // 标题只说「在干什么」。工作区路径放标题里会被截成「…/agent/work」，
      // 既不好看也没信息量，降级到结尾 note 且只留最后一段目录名。
      title: { tag: 'plain_text', content: phase === 'running' ? '🧠 正在处理' : '💤 空闲' },
      subtitle: { tag: 'plain_text', content: titleBits.join(' · ') },
      template: PHASE_TEMPLATE[phase],
    },
    elements,
  };

  const text = plainText(view, titleBits, queue);
  // key 必须带出去：bot.py 靠它把同一条会话的所有快照 patch 到同一张卡片上。
  return { key: view.key, chatId: view.chatId, card, text, rev: view.updatedAt || Date.now() };
}

/** 工具流水一行：`**动词** · 提示 ✅` —— 照 DSH GUI 那个执行面板的写法 */
function stepLine(st) {
  // 思考不显示内容，只显示「想过几次」：模型的内心独白贴进群里没人看得懂，
  // 又长又占地方（用户原话：「思考过程保留的太多…很占地方」）。
  if (st.kind === 'think') {
    const n = Number(st.think) || 1;
    return n > 1 ? `**思考** ×${n}` : '**思考**';
  }
  const mark = st.ok === true ? ' ✅' : st.ok === false ? ' ❌' : '';
  // hint 里是文件路径/命令，不该整体转义（\_ 在飞书里会显示成下划线但容易看错），
  // 只挡掉会破坏 lark_md 结构的 * 和 [
  const hint = st.hint ? ` · ${String(st.hint).replace(/([*[])/g, '\\$1')}` : '';
  return `**${escapeMd(st.verb || '步骤')}**${hint}${mark}`;
}

function queuedLine(q, i) {
  const who = q.name || (q.author ? q.author.slice(-6) : '某人');
  const where = q.target === 'next-step' ? '（插话·下一步生效）' : '';
  return `${i + 1}. **${escapeMd(who)}**：${escapeMd(firstLine(q.text))}${where}`;
}

function firstLine(s) {
  const t = (s || '').replace(/\s+/g, ' ').trim();
  return t.length > 80 ? `${t.slice(0, 80)}…` : t;
}

function tail(s, n) {
  const t = s || '';
  return t.length > n ? `…${t.slice(-n)}` : t;
}

function shortCwd(cwd) {
  if (!cwd) return 'workspace';
  const parts = String(cwd).split('/').filter(Boolean);
  return parts.length <= 2 ? String(cwd) : `…/${parts.slice(-2).join('/')}`;
}

function escapeMd(s) {
  return String(s || '').replace(/([*_`~[\]])/g, '\\$1');
}

/** 纯文本回退（通知栏、搜索、无障碍都靠它） */
function plainText(view, titleBits, queue) {
  const lines = [`[${titleBits.join(' · ')}]`];
  if (queue.length) {
    queue.forEach((q, i) => lines.push(`${i + 1}. ${q.name || q.author}: ${firstLine(q.text)}`));
  }
  if (view.error) lines.push(`出错: ${firstLine(view.error)}`);
  return lines.join('\n');
}
