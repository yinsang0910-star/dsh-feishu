# -*- coding: utf-8 -*-
"""给 lib/index.js 的两处 resume 调用补上 agentOptions。

背景（2026-11-04）：
0.1.5 及更早，两处 `ctx.agents.resume({ resumeSessionId })` 都没传 agentOptions。
接续老会话（headless 时代建的 session-* id）时 agent 拿不到 provider/model，
首轮直接抛 `has no provider/model: set AgentOptions.provider and AgentOptions.model`，
消息石沉大海 —— 用户看到的就是「飞书发消息没反应」。

四处改动：
  R1 插入 resumeAgent() helper（带 agentOptions + model 校验）
  R2 迁移路径的裸 resume → resumeAgent(resumeSessionId, agentOptions)
  R3 主路径的裸 resume → resumeAgent(derivedId, agentOptions)
每处 count==1 断言，对不上直接退出不写文件。
"""
import io
import sys

PATH = sys.argv[1] if len(sys.argv) > 1 else "lib/index.js"
src = io.open(PATH, encoding="utf-8").read()
orig = src

ANCHOR = "  /**\n   * 同一个 key 的并发建会话只跑一次。\n"
HELPER = """  /**
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

"""

if src.count(ANCHOR) != 1:
    sys.exit("R1 anchor 未唯一命中: %d" % src.count(ANCHOR))
src = src.replace(ANCHOR, HELPER + ANCHOR)

PAIRS = [
    (
        "handle = await ctx.agents.resume({ resumeSessionId });",
        "handle = await resumeAgent(resumeSessionId, agentOptions);",
    ),
    (
        "handle = await ctx.agents.resume({ resumeSessionId: derivedId });",
        "handle = await resumeAgent(derivedId, agentOptions);",
    ),
]
for i, (old, new) in enumerate(PAIRS, start=2):
    if src.count(old) != 1:
        sys.exit("R%d anchor 未唯一命中: %d -> %s" % (i, src.count(old), old))
    src = src.replace(old, new)

io.open(PATH, "w", encoding="utf-8", newline="\n").write(src)
print("OK  %d -> %d 字节" % (len(orig), len(src)))
print("剩余 ctx.agents.resume( 直接调用:", src.count("ctx.agents.resume("))
