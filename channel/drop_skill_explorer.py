# -*- coding: utf-8 -*-
"""从 agent 的 web profile 里摘掉 @linxin666/dsh-client-ui-skill-explorer。

判断依据（2026-11-04）：
  @weibaohui/skills-management v0.9.3
    描述：技能市场 —— 一个页面管理本机所有 coding agent 的技能，一键收编进 DSH
          用户库；内置 6600+ 技能市场可浏览搜索安装；支持注入开销（token/字符）
          统计与排序、模型可见性治理、市场每日自动同步。
  @linxin666/dsh-client-ui-skill-explorer v0.4.14
    描述：按来源浏览已加载技能、启用/禁用、创建删除。

→ 后者是前者的真子集（浏览/开关/增删都在 skills-management 里），保留功能更全、
  且提供 token 开销统计的那个。技能本身由 skill-filesystem / tool-skill 提供，
  跟这两个 UI 插件无关，删掉不影响任何技能可用。

幂等：已经不在就跳过。
"""
import io
import json
import shutil
import sys
import time

PROFILE = "/home/agent/.dsh/profiles/web"
TARGET = "@linxin666/dsh-client-ui-skill-explorer"
PKG = PROFILE + "/package.json"
PATCH = PROFILE + "/cordis.patch.yml"
stamp = time.strftime("%Y%m%d-%H%M%S")

pkg = json.load(io.open(PKG, encoding="utf-8"))
changed = []

deps = pkg.get("dependencies") or {}
if TARGET in deps:
    del deps[TARGET]
    changed.append("dependencies")

prof = (pkg.get("dsh") or {}).get("profile") or {}
bundles = prof.get("bundles") or []
if TARGET in bundles:
    prof["bundles"] = [b for b in bundles if b != TARGET]
    changed.append("bundles(%d->%d)" % (len(bundles), len(prof["bundles"])))

if not changed:
    print("SKIP  已经不在配置里，无需改动")
else:
    shutil.copy2(PKG, PKG + ".bak-before-drop-skillexplorer-" + stamp)
    io.open(PKG, "w", encoding="utf-8", newline="\n").write(
        json.dumps(pkg, ensure_ascii=False, indent=2) + "\n"
    )
    print("OK    已从 %s 移除" % ", ".join(changed))

# profile 层如果为它写过覆盖行，一并注释掉
try:
    text = io.open(PATCH, encoding="utf-8").read()
except FileNotFoundError:
    text = ""
if "ui-skill-explorer" in text:
    shutil.copy2(PATCH, PATCH + ".bak-before-drop-skillexplorer-" + stamp)
    out = []
    for line in text.split("\n"):
        if line.strip().startswith("- id: ui-skill-explorer"):
            out.append("# 2026-11-04 与 skills-management 功能重复，已停用：" + line)
        else:
            out.append(line)
    io.open(PATCH, "w", encoding="utf-8", newline="\n").write("\n".join(out))
    print("OK    cordis.patch.yml 里的覆盖行已注释")
else:
    print("SKIP  cordis.patch.yml 里没有它的覆盖行")
