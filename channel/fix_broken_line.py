# -*- coding: utf-8 -*-
"""修掉 fix_resume 残留的语法错误：helper 里的模板字符串被 shell 吃掉，变成了乱码。"""
import io
import re
import sys

PATH = "lib/index.js"
s = io.open(PATH, encoding="utf-8").read()
before = s

# 找到 if (!opts.model) 那一行（内容已损坏），整行替换
lines = s.split("\n")
hit = None
for i, ln in enumerate(lines):
    if "opts.model" in ln and "throw" in ln:
        hit = i
        break
if hit is None:
    sys.exit("未找到 opts.model 行")

indent = lines[hit][: len(lines[hit]) - len(lines[hit].lstrip())]
lines[hit : hit + 1] = [
    indent + "if (!opts.model) {",
    indent + '  throw new Error("会话 " + sessionId + " 没有 provider/model");',
    indent + "}",
]
s = "\n".join(lines)
io.open(PATH, "w", encoding="utf-8", newline="\n").write(s)
print("修复第 %d 行" % (hit + 1))
print("字节: %d -> %d" % (len(before), len(s)))
print("bare resume:", s.count("ctx.agents.resume("), " resumeAgent:", s.count("await resumeAgent("))
