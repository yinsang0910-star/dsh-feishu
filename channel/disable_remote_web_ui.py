#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从 agent 的 web profile 里停用 @linxin666/dsh-remote-web-ui。

理由：这个插件给 dsh web 加了一层「设备配对」门（fence.unpaired.*），
未配对的浏览器会被挡在「此设备未配对，无法访问工作区数据」。
同时它的 relay bridge 一直在 dial failed 刷屏。

用法：
    python3 disable_remote_web_ui.py            # 干跑
    python3 disable_remote_web_ui.py --apply    # 真改
"""
import json
import shutil
import sys
from datetime import datetime
from pathlib import Path

PROFILE = Path("/home/agent/.dsh/profiles/web")
PKG = PROFILE / "package.json"
PATCH = PROFILE / "cordis.patch.yml"
PKG_NAME = "@linxin666/dsh-remote-web-ui"


def main():
    apply = "--apply" in sys.argv
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    raw = PKG.read_text(encoding="utf-8")
    data = json.loads(raw)
    changed = []

    deps = data.get("dependencies") or {}
    if PKG_NAME in deps:
        changed.append("dependencies 移除 %s=%s" % (PKG_NAME, deps[PKG_NAME]))
        deps.pop(PKG_NAME)
        data["dependencies"] = deps

    prof = (data.get("dsh") or {}).get("profile") or {}
    bundles = prof.get("bundles") or []
    kept = [b for b in bundles if b != PKG_NAME]
    if len(kept) != len(bundles):
        changed.append("bundles %d -> %d" % (len(bundles), len(kept)))
        prof["bundles"] = kept
        data.setdefault("dsh", {})["profile"] = prof

    patch_hit = False
    if PATCH.exists():
        ptxt = PATCH.read_text(encoding="utf-8")
        if "remote-web-ui" in ptxt:
            patch_hit = True
            changed.append("cordis.patch.yml 里有 remote-web-ui 行（需另处理）")

    if not changed:
        print("SKIP 已经是干净状态，无需改动")
        return

    for c in changed:
        print("  " + c)

    if not apply:
        print("\n（干跑，未写入；加 --apply 真改）")
        return

    shutil.copy2(PKG, PKG.with_suffix(".json.bak-before-drop-rwui-" + stamp))
    PKG.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print("\nOK 已写入，备份 package.json.bak-before-drop-rwui-%s" % stamp)
    if patch_hit:
        print("注意：cordis.patch.yml 里仍有 remote-web-ui 相关行，需手工确认")
    print("下一步：cd %s && pnpm install --prefer-offline" % PROFILE)


if __name__ == "__main__":
    main()
