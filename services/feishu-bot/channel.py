"""飞书 ↔ DSH 原生通道的客户端（跑在 PVE 宿主）。

### 为什么要有这一层

原来的模型是：飞书来一条消息 → bot 入自己的 deque → spawn 一个
`dsh-task --json` 子进程 → 读完退出。后果：

* 同一个目录两个人同时发指令 = 两个子进程改同一批文件；
* 跑着的时候补一句，只能"排在后面"，因为子进程的 stdin 已经关了，没有注入口；
* 用户看到的是 `bot.py` 里那句静态的 `⏳ 前面还有 N 个在跑`，之后再也不更新。

新模型：bot 只做"飞书 SDK 的适配层"，真正的接单交给 agent 机上的
`dsh-feishu-channel` 插件。插件直接持有 DSH 的 agent 句柄，把消息投到
`next-turn` / `next-step` 这两个持久收件箱上 —— 于是"补充指令"天然成立，
排队位置也变成可以直接读的真值（`inbox.nextTurn.length`）。

### 这个文件负责什么

* `session_key()` —— 与插件侧 `lib/sessionkey.js` **必须逐字一致**的会话键派生
* `ingest()`     —— POST /ingest，幂等由插件侧 outbox 保证
* `control()`    —— POST /control（停 / 撤回 / 清队 / 新建）
* `Watch`        —— 订阅 /events 的 SSE 流，把视图快照喂给卡片渲染

### 兼容性

不改动原有 `bot.py` 的任何行为，只是多了一条 `channel_mode` 分支。
`channel_mode = "off"` 时完全走老路径，可随时回滚。
"""

from __future__ import annotations

import json
import logging
import threading
import urllib.error
import urllib.parse
import urllib.request

log = logging.getLogger("channel")

DEFAULT_TIMEOUT = 45   # 插件忙的时候 20 秒不够，超时会误判成「没接单」


# ─────────────────────────── 会话键 ───────────────────────────

THREAD_PREFIX = "omt_"


def _norm_thread(v) -> str:
    s = (v or "").strip()
    if not s:
        return ""
    return s if s.startswith(THREAD_PREFIX) else THREAD_PREFIX + s


def session_key(chat_id, thread_id="", root_id="", tenant_key="default", scope="auto") -> str:
    """与 lib/sessionkey.js 的 sessionKey() 逐字对应。

    三级回落：
      1. 话题内       lark:{tenant}:{chat}:thread:{omt_xxx}
      2. 回复串内     lark:{tenant}:{chat}:msg:{om_xxx}
      3. 整个群       lark:{tenant}:{chat}
    """
    tenant = tenant_key or "default"
    base = "lark:%s:%s" % (tenant, chat_id)
    if scope == "group":
        return base
    tid = _norm_thread(thread_id)
    if tid and scope != "root":
        return "%s:thread:%s" % (base, tid)
    rid = (root_id or "").strip()
    if rid and scope != "topic":
        return "%s:msg:%s" % (base, rid)
    return base


# ─────────────────────────── 客户端 ───────────────────────────


class ChannelError(RuntimeError):
    pass


class Channel:
    def __init__(self, url: str, token: str, timeout: int = DEFAULT_TIMEOUT):
        self.url = (url or "").rstrip("/")
        self.token = token or ""
        self.timeout = timeout or DEFAULT_TIMEOUT
        self._watches: dict[str, "Watch"] = {}
        self._lock = threading.Lock()

    # ── 基础 HTTP ──

    def _post(self, path: str, payload: dict) -> dict:
        if not self.url:
            raise ChannelError("channel_url 没配")
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(
            self.url + path,
            data=body,
            method="POST",
            headers={
                "Content-Type": "application/json; charset=utf-8",
                "X-Channel-Token": self.token,
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                return json.loads(r.read().decode("utf-8") or "{}")
        except urllib.error.HTTPError as e:
            detail = ""
            try:
                detail = e.read().decode("utf-8", "replace")[:400]
            except Exception:
                pass
            raise ChannelError("HTTP %s %s %s" % (e.code, path, detail)) from e
        except Exception as e:
            raise ChannelError("%s %s: %s" % (type(e).__name__, path, e)) from e

    # ── 接单 ──

    def ingest(
        self,
        *,
        open_id: str,
        chat_id: str,
        text: str,
        cwd: str = "",
        msg_id: str = "",
        thread_id: str = "",
        root_id: str = "",
        tenant_key: str = "default",
        name: str = "",
        intent: str = "auto",
        session_id: str = "",
    ) -> dict:
        return self._post(
            "/ingest",
            {
                "openId": open_id,
                "chatId": chat_id,
                "text": text,
                "cwd": cwd or None,
                "msgId": msg_id,
                "threadId": thread_id or None,
                "rootId": root_id or None,
                "tenantKey": tenant_key or "default",
                "name": name or "",
                "intent": intent or "auto",
                # 老通道时代这个人的 session id：插件会优先接续它，
                # 换通道不至于把记忆清零。接不上插件自己开新会话。
                "resumeSessionId": session_id or "",
            },
        )

    def control(self, key: str, type_: str, **kw) -> dict:
        payload = {"key": key, "type": type_}
        payload.update(kw)
        return self._post("/control", payload)

    def health(self) -> dict:
        try:
            req = urllib.request.Request(self.url + "/health")
            with urllib.request.urlopen(req, timeout=5) as r:
                return json.loads(r.read().decode("utf-8") or "{}")
        except Exception as e:
            return {"ok": False, "reason": str(e)}

    # ── 订阅 ──

    def watch(self, key: str, on_view, on_reply=None) -> "Watch":
        """同一个 key 只保留一条 SSE 连接。

        两条通道共用一个连接：
          - `event: view`  → on_view，卡片状态（在跑/空闲/排队）
          - `event: reply` → on_reply，agent 的回答正文（要发到群里）
        """
        with self._lock:
            w = self._watches.get(key)
            if w and w.alive:
                w.on_view = on_view
                if on_reply is not None:
                    w.on_reply = on_reply
                return w
            w = Watch(self, key, on_view, on_reply)
            self._watches[key] = w
            w.start()
            return w

    def unwatch(self, key: str):
        with self._lock:
            w = self._watches.pop(key, None)
        if w:
            w.stop()

    def stop_all(self):
        with self._lock:
            ws = list(self._watches.values())
            self._watches.clear()
        for w in ws:
            w.stop()


class Watch(threading.Thread):
    """订阅 /events 的 SSE 流。

    SSE 格式：`event: view\\ndata: {json}\\n\\n`，另有 `: ka` 心跳注释行。
    断线后按 1s → 2s → 4s（上限 15s）退避重连，因为插件重启很常见。
    """

    def __init__(self, ch: Channel, key: str, on_view, on_reply=None):
        super().__init__(daemon=True, name="sse-%s" % key[-12:])
        self.ch = ch
        self.key = key
        self.on_view = on_view
        self.on_reply = on_reply
        self.alive = True
        self._stop = threading.Event()

    def stop(self):
        self.alive = False
        self._stop.set()

    def run(self):
        backoff = 1.0
        while self.alive and not self._stop.is_set():
            try:
                self._pump()
                backoff = 1.0
            except urllib.error.HTTPError as e:
                # 404 = 插件侧没有这个 binding：dsh-web 重启把内存态清空了，或者会话被 /new
                # 换掉。必须让线程退出，否则它会一直 404 重连，而 Channel.watch() 看到
                # alive=True 就复用这条坏连接 —— 新消息照样能跑，但卡片再也不会更新。
                if e.code == 404:
                    log.info("会话 %s 在插件侧已不存在，停止订阅（下次发消息自动重连）", self.key)
                    self.alive = False
                    return
                if not self.alive:
                    return
                log.info("SSE 断开（%s），%.0fs 后重连", e, backoff)
                if self._stop.wait(backoff):
                    return
                backoff = min(backoff * 2, 15.0)
            except Exception as e:
                if not self.alive:
                    return
                log.info("SSE 断开（%s），%.0fs 后重连", e, backoff)
                if self._stop.wait(backoff):
                    return
                backoff = min(backoff * 2, 15.0)

    def _pump(self):
        url = "%s/events?key=%s" % (self.ch.url, urllib.parse.quote(self.key, safe=""))
        req = urllib.request.Request(url, headers={"X-Channel-Token": self.ch.token})
        with urllib.request.urlopen(req, timeout=None) as r:
            buf = b""
            while self.alive:
                chunk = r.read(1)
                if not chunk:
                    raise ChannelError("stream closed")
                buf += chunk
                if not buf.endswith(b"\n\n"):
                    continue
                block, buf = buf, b""
                event, data = _parse_sse(block.decode("utf-8", "replace"))
                if event == "view" and data:
                    try:
                        self.on_view(json.loads(data))
                    except Exception:
                        log.exception("on_view 回调炸了")
                elif event == "reply" and data:
                    # 这是 agent 说的话，不是状态 —— 必须真的发到群里，
                    # 否则用户在飞书看到的只有一张"空闲·第1轮"的空白卡片。
                    if not self.on_reply:
                        continue
                    try:
                        self.on_reply(json.loads(data))
                    except Exception:
                        log.exception("on_reply 回调炸了")
        return None


def _parse_sse(block: str):
    event = "message"
    data_lines = []
    for line in block.split("\n"):
        line = line.rstrip("\r")
        if not line or line.startswith(":"):
            continue
        if line.startswith("event:"):
            event = line[6:].strip()
        elif line.startswith("data:"):
            data_lines.append(line[5:].lstrip())
    return event, "\n".join(data_lines)


# ─────────────────────────── 便捷单例 ───────────────────────────

_INSTANCE = None


def init(conf: dict) -> "Channel | None":
    """从 bot 的 CONF 里取配置，建一个全局实例。channel_mode != on 时返回 None。"""
    global _INSTANCE
    mode = str(conf.get("channel_mode") or "off").lower()
    if mode != "on":
        log.info("channel_mode=%s，走老路径", mode)
        _INSTANCE = None
        return None
    url = conf.get("channel_url") or ""
    if not url:
        log.warning("channel_mode=on 但没配 channel_url，退回老路径")
        _INSTANCE = None
        return None
    _INSTANCE = Channel(url, conf.get("channel_token") or "")
    h = _INSTANCE.health()
    if h.get("ok"):
        log.info("通道就绪 %s sessions=%s pending=%s", url, h.get("sessions"), h.get("pending"))
    else:
        log.warning("通道不通（%s）：%s —— 消息会退回老路径", url, h.get("reason"))
        _INSTANCE = None
    return _INSTANCE


def get() -> "Channel | None":
    return _INSTANCE
