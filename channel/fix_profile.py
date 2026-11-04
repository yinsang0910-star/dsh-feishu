#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""在 agent 的 web profile 上：切到插件 0.1.6 + 给通道补 provider/model。

为什么必须显式给 provider/model：插件是用 AgentRegistry.create() 程序化建会话的，
它不继承 profile 里 `agent-default-model` 那份「默认 agent」配置，首轮就会报
`agent "..." has no provider/model`。
"""
import json
import re
import shutil

PROFILE = "/home/agent/.dsh/profiles/web"
PKG = PROFILE + "/package.json"
PATCH = PROFILE + "/cordis.patch.yml"
TGZ = "file:local-packages/dsh-feishu-channel-0.1.8.tgz"

# ── 1. package.json：依赖指向 0.1.6 ──
with open(PKG, encoding="utf-8") as f:
    pkg = json.load(f)

before = pkg.get("dependencies", {}).get("dsh-feishu-channel")
pkg.setdefault("dependencies", {})["dsh-feishu-channel"] = TGZ
pkg["dependencies"] = dict(sorted(pkg["dependencies"].items()))

bundles = pkg.get("dsh", {}).get("profile", {}).get("bundles") or []
if "dsh-feishu-channel" not in bundles:
    bundles.append("dsh-feishu-channel")
    pkg["dsh"]["profile"]["bundles"] = bundles

shutil.copy2(PKG, PKG + ".bak-before-012")
with open(PKG, "w", encoding="utf-8") as f:
    json.dump(pkg, f, ensure_ascii=False, indent=2)
    f.write("\n")
print("dependencies.dsh-feishu-channel:", before, "->", TGZ)
print("bundles 共", len(bundles), "项，末尾:", bundles[-1])

# ── 2. cordis.patch.yml：给通道补 provider / model ──
with open(PATCH, encoding="utf-8") as f:
    yml = f.read()

if not re.search(r"^- id: dsh-feishu-channel\s*$", yml, re.M):
    raise SystemExit("✗ cordis.patch.yml 里找不到 - id: dsh-feishu-channel")

if "provider: opencode-go" in yml.split("- id: dsh-feishu-channel", 1)[1]:
    print("provider 已经配过，跳过")
else:
    shutil.copy2(PATCH, PATCH + ".bak-before-012")
    anchor = "    stateDir: /home/agent/.dsh-feishu-channel"
    if anchor not in yml:
        raise SystemExit("✗ 找不到 stateDir 锚点")
    yml = yml.replace(
        anchor,
        anchor + "\n"
        "    # 插件程序化 create 的会话不继承 agent-default-model，必须显式给\n"
        "    provider: opencode-go\n"
        "    model: deepseek-v4.1-flash\n"
        "    reasoningEffort: high",
        1,
    )
    with open(PATCH, "w", encoding="utf-8") as f:
        f.write(yml)
    print("已补 provider/model/reasoningEffort")

print("\n--- cordis.patch.yml 尾部 ---")
print("\n".join(yml.rstrip().splitlines()[-16:]))
