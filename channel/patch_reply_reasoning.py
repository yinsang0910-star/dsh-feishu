#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""给 dsh-feishu-channel 的出站通道补上「思考过程」。

用户反馈：0.1.7 之后飞书里看不到思考深度、看不到思考过程了。

原因：pushReply 只转发 message.content 里 type==='text' 的块，
type==='reasoning' 的块（模型思考）被整个丢掉。

这个脚本改三处，每处断言锚点唯一：
  R1  新增 reasoningOfMessage()
  R2  pushReply 增加 reasoning / effort 两个字段
  R3  session/event 订阅里把 reasoning 一并取出并传下去
"""
import sys

SRC = sys.argv[1] if len(sys.argv) > 1 else 'lib/index.js'
DST = sys.argv[2] if len(sys.argv) > 2 else 'lib/index.js.new'

text = open(SRC, encoding='utf-8').read()
orig_len = len(text)


def sub(anchor, replacement, tag):
    global text
    n = text.count(anchor)
    if n != 1:
        raise SystemExit('%s: 锚点命中 %d 次（应该恰好 1 次），中止' % (tag, n))
    text = text.replace(anchor, replacement, 1)
    print('  %s  OK' % tag)


# ── R1：新增 reasoningOfMessage ────────────────────────────────
ANCHOR1 = """  function textOfMessage(message) {"""
REPL1 = """  // 思考过程：ReasoningBlock = { type: 'reasoning', text }（dsh-llm/types.d.ts:51）
  // 只截尾部 2000 字 —— 思考常常几千字，全塞进飞书会把消息撑爆；
  // 尾部保留是因为结论性的判断一般在最后。
  function reasoningOfMessage(message) {
    const parts = (message?.content || [])
      .filter((b) => b && b.type === 'reasoning' && typeof b.text === 'string')
      .map((b) => b.text.trim())
      .filter(Boolean);
    if (parts.length === 0) return '';
    const all = parts.join('\\n').trim();
    const MAX = 2000;
    return all.length > MAX ? '…（前面略）\\n' + all.slice(-MAX) : all;
  }

  function textOfMessage(message) {"""
sub(ANCHOR1, REPL1, 'R1 reasoningOfMessage')


# ── R2：pushReply 带 reasoning / effort ───────────────────────
ANCHOR2 = """  function pushReply(binding, text) {
    const frame = {
      key: binding.key,
      sessionId: binding.sessionId,
      chatId: binding.chatId || '',
      text,
      at: Date.now(),
    };"""
REPL2 = """  function pushReply(binding, text, reasoning) {
    const frame = {
      key: binding.key,
      sessionId: binding.sessionId,
      chatId: binding.chatId || '',
      text,
      // 思考过程与深度：飞书那边做成折叠区，不占正文空间
      reasoning: reasoning || '',
      effort: cfg.reasoningEffort || 'auto',
      turn: binding.turn || 0,
      at: Date.now(),
    };"""
sub(ANCHOR2, REPL2, 'R2 pushReply frame')


# ── R3：订阅里取出 reasoning 并传下去 ──────────────────────────
ANCHOR3 = """    const text = textOfMessage(event.data?.message);
    if (!text) return; // 纯工具调用的消息没有正文，不发"""
REPL3 = """    const text = textOfMessage(event.data?.message);
    const reasoning = reasoningOfMessage(event.data?.message);
    // 只有思考没有正文（纯工具调用的那一轮）就不发，避免刷屏；
    // 正文和思考都有时才把思考一并带上。
    if (!text) return;"""
sub(ANCHOR3, REPL3, 'R3 取 reasoning')

ANCHOR4 = """    pushReply(b, text);"""
REPL4 = """    pushReply(b, text, reasoning);"""
sub(ANCHOR4, REPL4, 'R4 传参')

open(DST, 'w', encoding='utf-8').write(text)
print('')
print('完成：%d → %d 字符' % (orig_len, len(text)))
print('输出：%s' % DST)
