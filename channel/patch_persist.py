#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把「群 → 会话」的绑定落盘，dsh-web 重启后自动接回。

背景：插件把 binding 只放内存（`const bindings = new Map()`），dsh-web 一重启就全清。
之后 PVE 门房的 SSE 全部 404，直到用户再发一条消息才重建 —— 这就是「卡片停在重启那一刻」的根因。

做法：
  1) store.js 加 BindingStore（stateDir/bindings.json，写法照 SessionState）
  2) index.js 建实例
  3) 建 binding 时落盘 / snapshot 时节流刷新 / /events 发现内存没有就从磁盘复活

用法：
  python patch_persist.py <插件目录> [--dry-run]
"""
import re
import shutil
import sys
import time

STORE_CLASS = '''

/**
 * 「群 → 会话」的持久绑定。
 *
 * 为什么需要：binding 只活在内存里，dsh-web 一重启就全清，之后门房的 SSE 全部 404、
 * 卡片停在重启那一刻，要等用户再发一条才重建。落盘之后 /events 能就地复活。
 *
 * 只存复活必需的四个字段；steps/replies/订阅者这些是运行时状态，重启后重建即可。
 */
export class BindingStore {
  constructor(dir) {
    this.dir = dir;
    this.path = join(dir, 'bindings.json');
    mkdirSync(dir, { recursive: true });
    /** @type {Record<string, object>} */
    this.data = {};
    if (existsSync(this.path)) {
      try {
        this.data = JSON.parse(readFileSync(this.path, 'utf8')) || {};
      } catch {
        this.data = {};
      }
    }
  }

  get(key) {
    return this.data[key];
  }

  keys() {
    return Object.keys(this.data);
  }

  save(key, fields) {
    this.data[key] = { ...(this.data[key] || {}), ...fields, savedAt: Date.now() };
    this.flush();
    return this.data[key];
  }

  delete(key) {
    delete this.data[key];
    this.flush();
  }

  flush() {
    writeFileSync(this.path, `${JSON.stringify(this.data, null, 2)}\\n`, 'utf8');
  }
}
'''


def fail(msg):
    print('FAIL ' + msg)
    sys.exit(1)


def main():
    if len(sys.argv) < 2:
        fail('用法: python patch_persist.py <插件目录> [--dry-run]')
    root = sys.argv[1].rstrip('\\/')
    dry = '--dry-run' in sys.argv

    stamp = time.strftime('%Y%m%d-%H%M%S')

    # ── store.js：加 BindingStore ────────────────────────────────
    sp = root + '/lib/store.js'
    with open(sp, 'r', encoding='utf-8') as f:
        s = f.read()

    if 'export class BindingStore' in s:
        print('SKIP store.js 已有 BindingStore')
    else:
        if s.count('export class SessionState') != 1:
            fail('store.js 找不到唯一的 SessionState')
        # 插在 SessionState 之前（同一套 import：join/mkdirSync/existsSync/readFileSync/writeFileSync）
        anchor = 'export class SessionState'
        s = s.replace(anchor, STORE_CLASS.strip() + '\n\n' + anchor, 1)
        if not dry:
            shutil.copy2(sp, sp + '.bak-before-persist-' + stamp)
            with open(sp, 'w', encoding='utf-8') as f:
                f.write(s)
        print('OK store.js 加 BindingStore（%d 字符）' % len(s))

    # ── index.js ────────────────────────────────────────────────
    ip = root + '/lib/index.js'
    with open(ip, 'r', encoding='utf-8') as f:
        s = f.read()
    orig = len(s)

    # P1 import
    a1 = "import { Outbox, SessionState } from './store.js';"
    if 'BindingStore' in s.split('\n')[0:60].__str__():
        print('SKIP index.js 已 import BindingStore')
    else:
        if s.count(a1) != 1:
            fail('index.js 找不到唯一的 store import')
        s = s.replace(a1, "import { Outbox, SessionState, BindingStore } from './store.js';", 1)
        print('OK P1 import BindingStore')

    # P2 实例化
    a2 = '  const sessions = new SessionState(cfg.stateDir);'
    if 'const bindingStore = new BindingStore' in s:
        print('SKIP index.js 已有 bindingStore')
    else:
        if s.count(a2) != 1:
            fail('index.js 找不到唯一的 SessionState 实例化')
        s = s.replace(
            a2,
            a2 + '\n  // 落盘：dsh-web 重启后内存绑定会清零，/events 靠这份记录复活（见 reviveBinding）\n'
                 '  const bindingStore = new BindingStore(cfg.stateDir);',
            1,
        )
        print('OK P2 建 bindingStore')

    # P3a 新增两个函数（插在 snapshot 定义之前）
    a3 = '  function snapshot(binding) {'
    if 'function reviveBinding(' in s:
        print('SKIP index.js 已有 reviveBinding')
    else:
        if s.count(a3) != 1:
            fail('index.js 找不到唯一的 snapshot 定义')
        funcs = '''  // ─────────────────────────────────────────────────────────────
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
      log(`绑定落盘失败 ${binding.key}: ${err?.message || err}`);
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
      log(`恢复绑定 ${key} → ${binding.sessionId}（重启后自动接回，记忆保留）`);
      return binding;
    } catch (err) {
      log(`恢复绑定失败 ${key}: ${err?.message || err}`);
      return undefined;
    }
  }

'''
        s = s.replace(a3, funcs + a3, 1)
        print('OK P3a 加 persistBinding / reviveBinding')

    # P3b 建 binding 后立即落盘
    a4 = '    bindings.set(key, binding);\n    bySession.set(sessionId, binding);'
    if a4 not in s:
        fail('index.js 找不到 bindings.set + bySession.set 这对')
    if 'persistBinding(binding, true);' in s.split('function reviveBinding')[0]:
        print('SKIP 已有建 binding 后落盘')
    else:
        s = s.replace(
            a4,
            a4 + '\n    // 建好就落盘：这样即使下一秒重启，/events 也能把这条群接回来\n'
                 '    persistBinding(binding, true);',
            1,
        )
        print('OK P3b 建 binding 后落盘')

    # P3c snapshot 末尾节流刷新（chatId / turn 会变）
    a5 = '''      steps: (binding.steps || []).slice(-MAX_STEPS),
      stepsTotal: (binding.steps || []).length,
    };'''
    if a5 in s:
        s = s.replace(
            a5,
            a5 + '\n    if (binding.chatId) persistBinding(binding);',
            1,
        )
        print('OK P3c snapshot 节流落盘')
    else:
        print('SKIP P3c 没找到 snapshot 的 steps 段（不影响主功能）')

    # P3d /events 复活
    a6 = """      const key = url.searchParams.get('key') || '';
      const binding = bindings.get(key);
      if (!binding) return json(res, 404, { ok: false, reason: 'no such session' });"""
    if 'binding = await reviveBinding(key)' in s:
        print('SKIP /events 已支持复活')
    else:
        if s.count(a6) != 1:
            fail('/events 的 binding 查找片段对不上')
        s = s.replace(
            a6,
            """      const key = url.searchParams.get('key') || '';
      let binding = bindings.get(key);
      if (!binding) {
        // dsh-web 重启后内存绑定没了，但磁盘上还有 → 复活再连（否则门房只能拿到 404）
        binding = await reviveBinding(key);
      }
      if (!binding) return json(res, 404, { ok: false, reason: 'no such session' });""",
            1,
        )
        print('OK P3d /events 支持复活')

    if not dry:
        shutil.copy2(ip, ip + '.bak-before-persist-' + stamp)
        with open(ip, 'w', encoding='utf-8') as f:
            f.write(s)
    print('OK index.js %d → %d 字符' % (orig, len(s)))

    # 0.1.12
    pp = root + '/package.json'
    with open(pp, 'r', encoding='utf-8') as f:
        pj = f.read()
    m = re.search(r'"version":\s*"([^"]+)"', pj)
    cur = m.group(1) if m else ''
    if cur == '0.1.12':
        print('SKIP package.json 已是 0.1.12')
    else:
        pj2 = re.sub(r'("version":\s*")[^"]+(")', r'\g<1>0.1.12\2', pj, count=1)
        if not dry:
            shutil.copy2(pp, pp + '.bak-before-persist-' + stamp)
            with open(pp, 'w', encoding='utf-8') as f:
                f.write(pj2)
        print('OK package.json %s → 0.1.12' % cur)

    print('DONE')


if __name__ == '__main__':
    main()
