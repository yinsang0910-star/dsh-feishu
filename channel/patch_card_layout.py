# -*- coding: utf-8 -*-
"""
card.js 补丁：把卡片从「工作区 XXX + 一堆字」改成「状态 + 工具流水」。

用户三条原话：
  「现在的卡片很丑，满是文字，没有排版」
  「当用户说画图给我之后没有立马接续上工作进度，也不显示正在做什么正在调用什么工具」
  「信息头显示工作区就算了，还根本就显示不全……工作头的信息显示成工作区是完全没有必要的」

改动：
  C1  标题不再显示工作区（改成 🧠 正在处理 / 💤 空闲），工作区降级到末尾 note 且只留 basename
  C2  新增工具流水区（最近几行，动词 + 提示 + ✅/❌）
  C3  流式尾部缩短（600 字），并加「正在输出」小标题
  C4  末尾加 note：工作区 basename + 步数
"""
import io
import sys

SRC = r"C:\Users\苏元洛\.pve600\dsh-feishu-channel\lib\card.js"
DST = r"C:\Users\苏元洛\.pve600\dsh-feishu-channel\lib\card.js.new"

s = io.open(SRC, encoding="utf-8").read()


def rep(old, new, why):
    global s
    n = s.count(old)
    if n != 1:
        print("!! [%s] 锚点命中 %d 次，中止" % (why, n))
        sys.exit(1)
    s = s.replace(old, new, 1)
    print("OK " + why)


# ── C2：流水渲染函数插在 queuedLine 之前 ───────────────────────────────
rep(
    "function queuedLine(q, i) {",
    """/** 工具流水一行：`**动词** · 提示 ✅` —— 照 DSH GUI 那个执行面板的写法 */
function stepLine(st) {
  const mark = st.ok === true ? ' ✅' : st.ok === false ? ' ❌' : '';
  const hint = st.hint ? ` · ${escapeMd(st.hint)}` : '';
  return `**${escapeMd(st.verb || '步骤')}**${hint}${mark}`;
}

function queuedLine(q, i) {""",
    "C2 stepLine",
)

# ── C1+C2+C3+C4：renderView 主体 ─────────────────────────────────────
OLD = """  // 流式正文：截尾部，别把整段塞进卡片（飞书卡片 JSON 有大小上限）
  if (view.streaming) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: tail(view.streaming, 1200) },
    });
  }"""

NEW = """  // 工具流水：这是「服务器明明在干活、群里却看不见」的正面修复。
  // 只显示最近几条，前面的折叠成一行计数（卡片大小有上限）。
  const steps = view.steps || [];
  const total = view.stepsTotal || steps.length;
  if (steps.length) {
    elements.push({ tag: 'hr' });
    const rows = [];
    if (total > steps.length) rows.push(`_… 前面 ${total - steps.length} 步已完成_`);
    for (const st of steps) rows.push(stepLine(st));
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: rows.join('\\n') } });
  } else if (phase === 'running') {
    elements.push({ tag: 'hr' });
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: '_正在想…_' } });
  }

  // 流式正文：只留尾部，别把整段塞进卡片（飞书卡片 JSON 有大小上限）
  if (view.streaming) {
    elements.push({ tag: 'hr' });
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: tail(view.streaming, 600) } });
  }"""
rep(OLD, NEW, "C2/C3 流水区 + 流式缩短")

# ── C1：标题不显示工作区 ─────────────────────────────────────────────
rep(
    """    header: {
      title: { tag: 'plain_text', content: `工作区 ${shortCwd(view.cwd)}` },
      subtitle: { tag: 'plain_text', content: titleBits.join(' · ') },
      template: PHASE_TEMPLATE[phase],
    },
    elements,
  };""",
    """    header: {
      // 标题只说「在干什么」。工作区路径放标题里会被截成「…/agent/work」，
      // 既不好看也没信息量，降级到结尾 note 且只留最后一段目录名。
      title: { tag: 'plain_text', content: phase === 'running' ? '🧠 正在处理' : '💤 空闲' },
      subtitle: { tag: 'plain_text', content: titleBits.join(' · ') },
      template: PHASE_TEMPLATE[phase],
    },
    elements,
  };""",
    "C1 标题去掉工作区",
)

# ── C4：末尾加 note（工作区 basename + 步数） ─────────────────────────
rep(
    """  if (buttons.length) {
    elements.push({ tag: 'action', actions: buttons });
  }""",
    """  if (buttons.length) {
    elements.push({ tag: 'action', actions: buttons });
  }

  // 页脚：真有人想知道在哪个目录、跑了几步，放这里，一行说完。
  const foot = [];
  if (view.stepsTotal) foot.push(`${view.stepsTotal} 步`);
  const ws = String(view.cwd || '').split('/').filter(Boolean).pop();
  if (ws) foot.push(`工作区 ${ws}`);
  if (foot.length) {
    elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: foot.join(' · ') }] });
  }""",
    "C4 页脚 note",
)

io.open(DST, "w", encoding="utf-8", newline="\n").write(s)
print("")
print("已写出 %s（%d 字符）" % (DST, len(s)))
