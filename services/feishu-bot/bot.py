#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""飞书门房 —— 600 G2 的语音遥控器（长连接，无需公网 IP）

它自己几乎不干活：听懂的那一半全部转给 agent 工作站上的 DSH，
机器人只负责认人、记会话、报进度、把危险动作用按钮拦一下。

12 条决策的落点：
  ① 语义任务一律转 DSH；只有 /agent /pve /status 这类显式命令才直连执行
  ② 白名单：config.json → allowed_open_ids（空白名单 = 只广播 open_id，不执行）
  ③ 群聊默认不用 @ 也响应（group_require_mention=true 时恢复成必须 @）；私聊更不用
  ④ 每人一份独立 DSH 会话：state.json → sessions[open_id]
  ⑤ 三段进度：先「收到」→ 工具调用阶段进展 → 最终结果
  ⑥ 群聊与私聊都支持
  ⑦ 命中危险模式 → 先发带「批准 / 取消」按钮的卡片，批准后才执行
  ⑧ 不设花费上限；每天 report_hour 点推额度与用量日报
  ⑨ 群里非命令消息统一先交给 DSH 一家
  ⑩ 信息不足时在群里反问一个具体候选（DSH 首行 CLARIFY: …）
  ⑪ 30 分钟软上限：到点问「还在跑，要继续吗」，回「继续」再给 30 分钟
  ⑫ 结果超过 max_inline_lines 行（或 4000 字）就贴成文件发到群里
  ⑬ 图片/文件消息：取回字节落到工作目录 .feishu-inbox，让 agent 自己用 read_image 看；
     群里的图片消息带不了 @，所以先收着（15 分钟），等他 @ 一句再挂上去

配置：/opt/feishu-bot/config.json   状态：/opt/feishu-bot/state.json
账本：/opt/feishu-bot/ledger.jsonl（每任务一行，日报从这儿算）
"""

import base64
import collections
import io
import json
import logging
import os
import re
import shlex
import subprocess
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path

import lark_oapi as lark
from lark_oapi.api.im.v1 import (
    CreateFileRequest,
    CreateFileRequestBody,
    CreateMessageRequest,
    CreateMessageRequestBody,
    DeleteMessageRequest,
    PatchMessageRequest,
    PatchMessageRequestBody,
    P2ImMessageReceiveV1,
)

APP_ID = os.environ.get("FEISHU_APP_ID", "").strip()
APP_SECRET = os.environ.get("FEISHU_APP_SECRET", "").strip()

BASE = Path(__file__).resolve().parent
LOG_DIR = Path(os.environ.get("BOT_LOG_DIR", "/var/log/feishu-bot"))
LOG_DIR.mkdir(parents=True, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    handlers=[
        logging.FileHandler(LOG_DIR / "bot.log", encoding="utf-8"),
        logging.StreamHandler(),
    ],
)
log = logging.getLogger("feishu-bot")

CONF_PATH = BASE / "config.json"
STATE_PATH = BASE / "state.json"
LEDGER_PATH = BASE / "ledger.jsonl"

DEFAULTS = {
    "allowed_open_ids": [],
    "setup_token": "",
    "report_hour": 8,
    "soft_timeout_sec": 1800,
    "max_inline_lines": 30,
    # 附件（图片/文件）落点：相对工作目录。DSH 的文件沙箱默认 workspace-write，
    # 只放行工作目录内的路径，所以附件必须落在 cwd 里，不能塞 /tmp 或 ~/.cache。
    "attachment_dir": ".feishu-inbox",
    "max_attachment_mb": 20,
    # 群里要不要 @ 才响应：false = 群里直接说话就行（图片消息本来就带不了 @）。
    # 随时可用 /要@ /免@ 切换，会写回 config.json。
    "group_require_mention": False,
    # 模型与思考强度：写在这里而不是改 agent 上的 profile，--patch 单次生效、随时可退。
    # model 留空 = 用 profile 自己的默认；reasoning_effort 取 auto/off/low/high/max
    # （auto = 每条任务按内容现算一档，进度卡上写明挑了哪档）。
    "model": "deepseek-v4.1-flash",
    "reasoning_effort": "auto",
    "model_override_path": "/home/agent/.cache/feishu/model-override.yml",
    "agent_host": "192.168.1.100",
    "agent_user": "agent",
    "agent_key": "/root/.ssh/agent_rsa",
    "agent_cwd": "/home/agent/work",
    "agent_root": "/home/agent/work",
    "dsh_cmd": "/home/agent/.local/bin/dsh-task",
    "pve_host": "127.0.0.1",
    "pve_label": "",          # /status 里怎么称呼这台机器；留空则显示 "PVE"
    "report_chat_id": "",
    "usage_url": "https://opencode.ai/zen/go/v1/usage",
    "usage_key_file": "/home/agent/.config/dsh/opencode-go.env",
    # dsh-feishu 网关（可选）。它自己不持有长连接，只做「按钮答案中转站」：
    # 我们收到 card.action 后把 answer POST 过去，MCP 那边的 feishu_ask 就能秒回。
    "gateway_url": "http://192.168.1.100:18642",
    "gateway_token": "",
}

_LOCK = threading.RLock()

INFO = """直接说要做什么就行，我会转给 agent 工作站上的 DSH（每人一份独立记忆）。
要文件就直接说「把 XX 的 Word 发我」——它会真的把文件传过来。

换脑子：
/模型    现在用哪个模型，按钮直接换（/模型 列表 看全部）
/思考    reasoningEffort：auto / off / low / high / max

看状态：
/状态    在跑什么、排队几个、用的什么脑子
/排队    排了哪些活；/清队 清空
/额度    模型用量还剩多少

管记忆与项目：
/项目    看看有哪些工作区，可以切过去（/cd 名字）
/新      清空我这份记忆，从头开始（话题换了就用它）

群里不用 @：直接说话就行，发图也一样（/要@ 可改回必须 @）

其余口语就能办：
停 / 继续            中止或延长正在跑的任务
危险动作            我会发卡片问你要不要放行，点按钮即可
/help                再看一遍这段（发的是卡片，按钮能直接点）"""

DANGER = [
    r"\brm\s+-[a-zA-Z]*[rf]", r"\bmkfs(\.\w+)?\b", r"\bdd\b[^\n]*\bof=",
    r"\bshutdown\b", r"\breboot\b", r"\bpoweroff\b", r"\bhalt\b",
    r"\bsystemctl\s+(stop|disable|mask|restart)\b",
    r"\bqm\s+(destroy|stop|shutdown|reset)\b", r"\bpct\s+destroy\b",
    r"\bzfs\s+destroy\b", r"\bvzdump\b[^\n]*--remove",
    r"\btruncate\b", r"\bchmod\s+-R\s+777\s+/", r">\s*/etc/",
    r"\bgit\s+push\b[^\n]*--force", r"\buserdel\b", r"\bpasswd\b",
    r"\biptables\s+-F", r"\bcrontab\s+-r", r"\bkill\s+-9\s+1\b",
    r"\bfdisk\b", r"\bwipefs\b", r"\bparted\b",
]
DANGER_RE = re.compile("|".join(DANGER), re.I)


# ─────────────────────────── 配置 / 状态 ───────────────────────────

def _read_json(path, fallback):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return fallback
    except Exception:
        log.exception("读取 %s 失败，用默认值", path)
        return fallback


def _write_json(path, data):
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, path)


def load_conf():
    conf = dict(DEFAULTS)
    conf.update(_read_json(CONF_PATH, {}))
    return conf


CONF = load_conf()


def load_state():
    st = _read_json(STATE_PATH, {})
    st.setdefault("sessions", {})
    st.setdefault("users", {})
    st.setdefault("cwd", {})
    st.setdefault("last_group_chat_id", "")
    st.setdefault("last_chat_id", "")
    st.setdefault("last_report_date", "")
    st.setdefault("last", {})
    return st


STATE = load_state()


def save_state():
    with _LOCK:
        _write_json(STATE_PATH, STATE)


def save_conf():
    with _LOCK:
        _write_json(CONF_PATH, CONF)


def reload_conf():
    global CONF
    CONF = load_conf()
    return CONF


def who_name(open_id):
    u = STATE["users"].get(open_id) or {}
    return u.get("name") or ("…" + open_id[-6:] if open_id else "未知")


# ─────────────────────────── 飞书通道 ───────────────────────────

client = lark.Client.builder().app_id(APP_ID).app_secret(APP_SECRET).build()

BOT_OPEN_ID = ""


def _http_json(url, headers=None, body=None):
    req = urllib.request.Request(url, method="POST" if body else "GET")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        req.add_header("Content-Type", "application/json; charset=utf-8")
    with urllib.request.urlopen(req, data=data, timeout=20) as r:
        return json.loads(r.read().decode("utf-8"))


def gateway_post(path, body, timeout=3):
    """把卡片按钮的答案转给 dsh-feishu 网关（可选组件，失败只记日志）。

    网关不持有长连接——长连接还是我们这条，所以两边不会抢事件。
    """
    base = (CONF.get("gateway_url") or "").rstrip("/")
    if not base:
        return None
    try:
        req = urllib.request.Request(base + path, method="POST")
        req.add_header("Content-Type", "application/json; charset=utf-8")
        gw_token = (CONF.get("gateway_token") or "").strip()
        if gw_token:
            req.add_header("Authorization", "Bearer " + gw_token)
        with urllib.request.urlopen(
            req, data=json.dumps(body, ensure_ascii=False).encode(), timeout=timeout
        ) as r:
            return json.loads(r.read().decode())
    except Exception as e:
        log.warning("网关投递失败 %s: %s", path, e)
        return None


def fetch_bot_open_id():
    """长连接模式下也要知道自己的 open_id，才能判断群里是不是 @ 了我。"""
    global BOT_OPEN_ID
    try:
        tok = _http_json(
            "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
            body={"app_id": APP_ID, "app_secret": APP_SECRET},
        ).get("tenant_access_token", "")
        info = _http_json(
            "https://open.feishu.cn/open-apis/bot/v3/info",
            headers={"Authorization": "Bearer " + tok},
        )
        BOT_OPEN_ID = (info.get("bot") or {}).get("open_id", "") or ""
        log.info("bot open_id=%s name=%s", BOT_OPEN_ID, (info.get("bot") or {}).get("app_name"))
    except Exception:
        log.exception("取 bot 自身 open_id 失败，改为「任意 @ 即响应」")


def _tenant_token():
    try:
        return _http_json(
            "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
            body={"app_id": APP_ID, "app_secret": APP_SECRET},
        ).get("tenant_access_token", "")
    except Exception:
        log.exception("取 tenant_access_token 失败")
        return ""


def join_group(open_id):
    """认领成功后把这个人拉进固定的指挥群（config.json 的 group_chat_id）。"""
    chat = (CONF.get("group_chat_id") or "").strip()
    if not chat or not open_id:
        return False
    tok = _tenant_token()
    if not tok:
        return False
    try:
        r = _http_json(
            "https://open.feishu.cn/open-apis/im/v1/chats/%s/members?member_id_type=open_id" % chat,
            headers={"Authorization": "Bearer " + tok},
            body={"id_list": [open_id]},
        )
        if r.get("code") == 0:
            log.info("已把 %s 拉进群 %s", open_id, chat)
            return True
        log.warning("拉群失败 open_id=%s code=%s msg=%s", open_id, r.get("code"), r.get("msg"))
    except Exception:
        log.exception("拉群异常 open_id=%s", open_id)
    return False


def send(chat_id, text, msg_type="text"):
    body = (
        CreateMessageRequestBody.builder()
        .receive_id(chat_id)
        .msg_type(msg_type)
        .content(json.dumps({"text": text}, ensure_ascii=False) if msg_type == "text" else text)
        .build()
    )
    req = CreateMessageRequest.builder().receive_id_type("chat_id").request_body(body).build()
    try:
        resp = client.im.v1.message.create(req)
    except Exception:
        log.exception("send 异常 chat=%s", chat_id)
        return False
    if not resp.success():
        log.error("send failed: code=%s msg=%s chat=%s", resp.code, resp.msg, chat_id)
        return False
    return True


def send_card(chat_id, card):
    return send(chat_id, json.dumps(card, ensure_ascii=False), msg_type="interactive")


def card_create(chat_id, card):
    """发一张卡片，把 message_id 拿回来——后面靠它原地刷新，不再刷屏。"""
    body = (
        CreateMessageRequestBody.builder()
        .receive_id(chat_id)
        .msg_type("interactive")
        .content(json.dumps(card, ensure_ascii=False))
        .build()
    )
    req = CreateMessageRequest.builder().receive_id_type("chat_id").request_body(body).build()
    try:
        resp = client.im.v1.message.create(req)
    except Exception:
        log.exception("card_create 异常 chat=%s", chat_id)
        return ""
    if not resp.success():
        log.error("card_create failed code=%s msg=%s", resp.code, resp.msg)
        return ""
    mid = getattr(resp.data, "message_id", "") if resp.data else ""
    return mid or ""


def card_patch(message_id, card):
    """原地改写一张卡片。update_multi 卡片才支持。"""
    if not message_id:
        return False
    try:
        body = (
            PatchMessageRequestBody.builder()
            .content(json.dumps(card, ensure_ascii=False))
            .build()
        )
        resp = client.im.v1.message.patch(
            PatchMessageRequest.builder().message_id(message_id).request_body(body).build()
        )
    except Exception:
        log.exception("card_patch 异常 mid=%s", message_id)
        return False
    if not resp.success():
        log.warning("card_patch failed code=%s msg=%s mid=%s", resp.code, resp.msg, message_id)
        return False
    return True


def card_delete(message_id):
    if not message_id:
        return False
    try:
        return client.im.v1.message.delete(
            DeleteMessageRequest.builder().message_id(message_id).build()
        ).success()
    except Exception:
        log.exception("card_delete 异常")
        return False


def send_file(chat_id, filename, data: bytes):
    """贴成文件发群里。缺 im:resource:upload 权限时返回 (False, 原因)。"""
    try:
        body = (
            CreateFileRequestBody.builder()
            .file_type("stream")
            .file_name(filename)
            .file(io.BytesIO(data))
            .build()
        )
        resp = client.im.v1.file.create(
            CreateFileRequest.builder().request_body(body).build()
        )
    except Exception as e:
        log.exception("file.create 异常")
        return False, "上传异常：%s" % e
    if not resp.success():
        log.error("file.create failed code=%s msg=%s", resp.code, resp.msg)
        if resp.code == 99991672:
            return False, "应用缺 im:resource:upload 权限（去开放平台开通后重启 bot）"
        return False, "上传失败 code=%s %s" % (resp.code, resp.msg)
    key = resp.data.file_key
    body2 = (
        CreateMessageRequestBody.builder()
        .receive_id(chat_id)
        .msg_type("file")
        .content(json.dumps({"file_key": key}))
        .build()
    )
    req2 = CreateMessageRequest.builder().receive_id_type("chat_id").request_body(body2).build()
    r2 = client.im.v1.message.create(req2)
    if not r2.success():
        log.error("发文件消息失败 code=%s msg=%s", r2.code, r2.msg)
        return False, "文件发出失败 code=%s" % r2.code
    return True, ""


def deliver(chat_id, text, title="结果"):
    """⑫ 超过 max_inline_lines 行或 4000 字 → 贴成文件。"""
    lines = text.count("\n") + 1
    limit_lines = int(CONF["max_inline_lines"])
    if lines <= limit_lines and len(text) <= 4000:
        return send(chat_id, text)
    name = "%s-%s.txt" % (title, datetime.now().strftime("%Y%m%d-%H%M%S"))
    ok, why = send_file(chat_id, name, text.encode("utf-8"))
    if ok:
        send(chat_id, "（%d 行，已贴成文件 %s）" % (lines, name))
        return True
    head = "\n".join(text.splitlines()[:limit_lines])
    send(
        chat_id,
        "（%d 行，本该贴成文件，但%s；先给前 %d 行）\n%s\n…"
        % (lines, why, limit_lines, head),
    )
    return False


# ─────────────────────── 收附件（图片 / 文件） ───────────────────────
#
# 飞书消息里的图片/文件不在事件体里，只有一个 image_key / file_key，
# 得再用 tenant_access_token 去 /im/v1/messages/{mid}/resources/{key} 取字节。
# 取回来之后落进 agent 的工作目录（沙箱只认 cwd 内），最后把相对路径写进任务描述，
# 让 agent 自己用 read_image / 读写工具去看——headless CLI 没有 --image 参数。

ATTACH_TYPES = ("image", "file", "media", "audio")
STASH_TTL = 900           # 群里先收着的图，10 分钟内 @ 一句还能挂上


def _guess_ext(data: bytes) -> str:
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if data[:3] == b"\xff\xd8\xff":
        return "jpg"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    if data[:4] == b"%PDF":
        return "pdf"
    if data[:2] == b"PK":
        return "zip"
    return "bin"


def fetch_resource(message_id, file_key, rtype, timeout=120):
    """按 message_id + key 把附件取回字节流。rtype 只有 image / file 两种。"""
    tok = _tenant_token()
    if not tok:
        return None, "取 tenant_access_token 失败（看 config.env 里的应用凭证）"
    url = ("https://open.feishu.cn/open-apis/im/v1/messages/%s/resources/%s?type=%s"
           % (message_id, file_key, rtype))
    try:
        req = urllib.request.Request(url, headers={"Authorization": "Bearer " + tok})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read(), ""
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = e.read()[:300].decode("utf-8", "replace")
        except Exception:
            pass
        return None, "HTTP %s %s" % (e.code, detail)
    except Exception as e:
        return None, str(e)


def push_attachment(cwd, filename, data):
    """把附件写到 agent 的工作目录里。字节以 base64 过 ssh，避免二进制走文本管道的坑。"""
    sub = (CONF.get("attachment_dir") or ".feishu-inbox").strip("/")
    target = "%s/%s" % (cwd.rstrip("/"), sub)
    path = "%s/%s" % (target, filename)
    cmd = ("mkdir -p %s && base64 -d > %s && stat -c '%%s' %s"
           % (shlex.quote(target), shlex.quote(path), shlex.quote(path)))
    code, out = run_remote(
        CONF["agent_host"], CONF["agent_user"], CONF["agent_key"],
        cmd, timeout=180, stdin_text=base64.b64encode(data).decode("ascii"),
    )
    if code != 0:
        return "", "写不进工作站（exit=%d）：%s" % (code, out[:200])
    log.info("附件已落到 %s（%s 字节）", path, out.strip())
    return path, ""


def parse_attachment(msg):
    """把 image / file / media / audio 消息归一成同一份描述。"""
    try:
        content = json.loads(msg.content or "{}")
    except Exception:
        content = {}
    mt = msg.message_type
    if mt == "image":
        key = content.get("image_key") or ""
        if not key:
            return None
        return {"kind": "image", "rtype": "image", "key": key, "name": ""}
    if mt in ("file", "media", "audio"):
        key = content.get("file_key") or ""
        if not key:
            return None
        name = (content.get("file_name") or "").strip() or (
            "%s-%s" % (mt, datetime.now().strftime("%Y%m%d-%H%M%S")))
        return {"kind": "file", "rtype": "file", "key": key, "name": name}
    return None


def stash_attachment(chat_id, open_id, msg, att):
    """群里图片消息带不了 @，先按「人+会话」存着，等下一条 @ 的话挂上去。"""
    with _LOCK:
        st = STATE.setdefault("stashed", {})
        now = time.time()
        for k in [k for k, v in st.items() if now - (v.get("ts") or 0) > STASH_TTL]:
            st.pop(k, None)
        st["%s|%s" % (chat_id, open_id)] = {
            "key": att["key"], "rtype": att["rtype"], "name": att.get("name") or "",
            "mid": msg.message_id, "ts": now,
        }
        save_state()


def take_stashed(chat_id, open_id):
    with _LOCK:
        st = STATE.get("stashed") or {}
        item = st.pop("%s|%s" % (chat_id, open_id), None)
        if not item:
            return None
        if time.time() - (item.get("ts") or 0) > STASH_TTL:
            return None
        save_state()
        return item


def materialize_attachment(chat_id, open_id, message_id, att, caption):
    """取回附件 → 落到工作区 → 返回 (任务描述, 进度卡上给人看的一行)。
    失败时已经回过用户，返回 (None, None)。"""
    cwd = cur_cwd(open_id)
    data, err = fetch_resource(message_id, att["key"], att["rtype"])
    if data is None:
        send(chat_id, "附件没取下来：%s" % err)
        log.warning("取附件失败 mid=%s key=%s err=%s", message_id, att["key"], err)
        return None, None

    limit_mb = int(CONF.get("max_attachment_mb") or 20)
    if len(data) > limit_mb * 1024 * 1024:
        send(chat_id, "这个有 %d MB，超过 %d MB 上限，先没动它。"
                      % (len(data) // (1024 * 1024), limit_mb))
        return None, None
    if not data:
        send(chat_id, "附件是空的（0 字节），没什么可处理的。")
        return None, None

    name = att.get("name") or ""
    if "." not in name.rsplit("/", 1)[-1]:
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        stem = name or ("img-%s" % stamp if att["kind"] == "image" else "file-%s" % stamp)
        name = "%s.%s" % (stem, _guess_ext(data))
    name = re.sub(r"[^\w.\-]+", "_", name)[-80:] or "attach.bin"

    path, err = push_attachment(cwd, name, data)
    if not path:
        send(chat_id, "附件存到工作站失败：%s" % err)
        return None, None

    rel = path[len(cwd.rstrip("/")) + 1:] if path.startswith(cwd.rstrip("/") + "/") else path
    kb = max(1, len(data) // 1024)
    head = (caption or "").strip()
    if att["kind"] == "image":
        line = ("【用户发来一张图片，已存到工作目录】%s（相对 %s，%d KB）\n"
                "先真的用 read_image 打开它看清内容，不要凭文件名或上下文猜。" % (rel, cwd, kb))
        default_label = "看这张图"
    else:
        line = ("【用户发来一个文件，已存到工作目录】%s（相对 %s，%d KB）\n"
                "先打开看一眼是什么，原件保留不要删。" % (rel, cwd, kb))
        default_label = "看文件 %s" % name
    if head:
        return "%s\n他附言：%s" % (line, head), head
    return (line + "\n他没写别的要求：先用两三句话说清你看到的是什么，再问他要怎么处理。",
            default_label)


# ─────────────────────────── agent 通道 ───────────────────────────

def ssh_argv(host, user, key):
    if host in ("127.0.0.1", "localhost"):
        return ["bash", "-lc"]
    return [
        "ssh", "-i", key,
        "-o", "BatchMode=yes",
        "-o", "StrictHostKeyChecking=accept-new",
        "-o", "ConnectTimeout=8",
        "%s@%s" % (user, host),
    ]


def run_remote(host, user, key, command, timeout=180, stdin_text=None):
    argv = ssh_argv(host, user, key) + [command]
    try:
        p = subprocess.run(
            argv,
            input=stdin_text,
            capture_output=True,
            text=True,
            timeout=timeout,
            errors="replace",
        )
        out = (p.stdout or "") + (p.stderr or "")
        return p.returncode, out.strip() or "(no output, exit=%d)" % p.returncode
    except subprocess.TimeoutExpired:
        return 124, "(超时 %ds)" % timeout
    except Exception as e:
        return 1, "(执行失败: %s)" % e


def run_agent(command, timeout=180):
    return run_remote(
        CONF["agent_host"], CONF["agent_user"], CONF["agent_key"], command, timeout
    )


def run_pve(command, timeout=180):
    return run_remote(CONF["pve_host"], "root", "", command, timeout)


def task_brief(open_id):
    """「我刚才让它干的事怎么样了」——比机器概况更常被问到的那个。"""
    cur = RUNNING.get(open_id)
    q = QUEUES.get(open_id) or collections.deque()
    lines = []
    if cur:
        lines.append("▶ 正在跑：%s" % (cur.text or "")[:56])
        lines.append("  已用 %s · 第 %d 步 · 工作区 %s"
                     % (_dur(_seconds_of(cur)), max(cur.tool_n, 0),
                        cur.cwd.rstrip("/").rsplit("/", 1)[-1] or cur.cwd))
    else:
        lines.append("现在没在跑。")
    if q:
        lines.append("⏳ 排队 %d 个：" % len(q))
        for i, it in enumerate(list(q)[:5], 1):
            lines.append("  %d) %s" % (i, (it.get("text") or "")[:40]))
        if len(q) > 5:
            lines.append("  …还有 %d 个" % (len(q) - 5))
    last = (STATE.get("last") or {}).get(open_id)
    if last:
        icon = "✅" if last.get("ok") else "⛔"
        lines.append("")
        lines.append("%s 上次（%s，用时 %s 秒）：%s"
                     % (icon, last.get("ts"), int(last.get("dur") or 0),
                        (last.get("task") or "")[:40]))
        if last.get("body"):
            lines.append("   %s" % last["body"][:100].replace("\n", " "))
    return "\n".join(lines)


def do_status():
    a = run_pve("date '+%F %T'; uptime | sed 's/^ *//'; free -m | sed -n 2p; df -h / | tail -1")
    b = run_agent(
        "date '+%F %T'; uptime | sed 's/^ *//'; free -m | sed -n 2p; "
        "df -h / /home/agent/work 2>/dev/null | tail -n +2; "
        "systemctl is-active dsh-web 2>/dev/null | sed 's/^/dsh-web: /'"
    )
    return "【PVE 宿主 %s】\n%s\n\n【agent 工作站 %s】\n%s" % (
        CONF.get("pve_label") or "PVE",
        a[1],
        CONF.get("agent_host") or "agent",
        b[1],
    )


# ─────────────────────────── 危险动作审批 ───────────────────────────

PENDING = {}  # tok -> {open_id, chat_id, kind, payload, created}
APPROVAL_TTL = 600


def is_dangerous(text):
    m = DANGER_RE.search(text or "")
    return m.group(0) if m else ""


def make_tok():
    return "%04x" % (int(time.time() * 1000) & 0xFFFF)


def approval_card(tok, title, detail):
    return {
        "config": {"wide_screen_mode": True},
        "header": {
            "template": "orange",
            "title": {"tag": "plain_text", "content": "需要批准：" + title},
        },
        "elements": [
            {"tag": "div", "text": {"tag": "plain_text", "content": detail[:1200]}},
            {
                "tag": "action",
                "actions": [
                    {
                        "tag": "button",
                        "text": {"tag": "plain_text", "content": "批准"},
                        "type": "primary",
                        "value": {"act": "approve", "token": tok},
                    },
                    {
                        "tag": "button",
                        "text": {"tag": "plain_text", "content": "取消"},
                        "type": "danger",
                        "value": {"act": "cancel", "token": tok},
                    },
                ],
            },
            {
                "tag": "note",
                "elements": [
                    {
                        "tag": "plain_text",
                        "content": "也可以直接回文字：批 %s 或 拒 %s（10 分钟内有效）" % (tok, tok),
                    }
                ],
            },
        ],
    }


def ask_approval(open_id, chat_id, kind, payload, title, detail):
    tok = make_tok()
    PENDING[tok] = {
        "open_id": open_id,
        "chat_id": chat_id,
        "kind": kind,
        "payload": payload,
        "created": time.time(),
    }
    send_card(chat_id, approval_card(tok, title, detail))
    log.info("待批准 tok=%s kind=%s by=%s", tok, kind, open_id)


def sweep_approvals():
    now = time.time()
    for tok in [t for t, v in PENDING.items() if now - v["created"] > APPROVAL_TTL]:
        PENDING.pop(tok, None)


def resolve_approval(tok, act, by_open_id=""):
    item = PENDING.pop(tok, None)
    if not item:
        return False, "编号 %s 已失效（可能已处理或超过 10 分钟）" % tok
    if by_open_id and item["open_id"] != by_open_id and by_open_id not in CONF["allowed_open_ids"]:
        PENDING[tok] = item
        return False, "这个编号不是发给你的"
    chat_id = item["chat_id"]
    if act == "cancel":
        send(chat_id, "已取消：%s" % item["payload"].get("label", ""))
        return True, ""
    if item["kind"] == "shell":
        target, command = item["payload"]["target"], item["payload"]["command"]
        send(chat_id, "▶ 已批准，在 %s 执行：%s" % (target, command))
        code, out = run_agent(command) if target == "agent" else run_pve(command)
        deliver(chat_id, "✔ %s 完成（exit=%d）\n%s" % (target, code, out))
    elif item["kind"] == "dsh":
        pending_task(item["open_id"], chat_id, item["payload"]["text"], approved=True)
    return True, ""


# ─────────────────────────── DSH 驱动 ───────────────────────────

PROMPT_TMPL = (
    "你是「600 G2」的执行助手，正在通过飞书和 {who} 对话。工作目录 {cwd}。\n"
    "如果这句话信息不足，无法确定要做什么：整条回答只输出一行，以「CLARIFY: 」开头，"
    "后面接一个最可能的候选问句（例如：你是要重启 dsh-web 还是整机？），不要执行任何动作。\n"
    "如果信息足够：直接把事做完，最后给出简短结论（不超过 20 行）。\n"
    "调用工具时，description 字段用中文写、不超过 12 个字（它会显示在用户的进度卡上）。\n\n"
    "【交付文件】要交付 docx/pdf/图片/表格/压缩包这类文件时：\n"
    "  1) 先把文件做好、落在工作目录里；\n"
    "  2) 直接执行 pushfile <文件绝对路径> \"<一句话说明>\"（已在 PATH 里，不要去找它）\n"
    "     —— 会把文件发到当前飞书会话，chat_id 不用你管；\n"
    "  3) 回复里只写「已发送：文件名（大小）」这样的结论。\n"
    "不要用工作区路径代替文件（用户拿不到），也不要把整篇内容粘贴出来代替文件。\n"
    "pushfile 支持多个文件：pushfile a.docx b.pdf \"作业打包\"。\n\n"
    "【飞书能力】你还有一个飞书 MCP，工具名以 mcp__lark__ 开头：\n"
    "  mcp__lark__im_v1_chat_list         列机器人所在的群\n"
    "  mcp__lark__im_v1_chatMembers_get   读群成员（谁在群里、他们的 open_id）\n"
    "  mcp__lark__im_v1_chat_create       建群\n"
    "  mcp__lark__im_v1_message_create    往指定会话发消息/卡片\n"
    "  mcp__lark__docx_v1_document_rawContent  读云文档纯文本\n"
    "  mcp__lark__docx_builtin_import     把本地文件导入成飞书云文档\n"
    "注意：MCP 没有上传文件的工具，要发本地文件一律用 pushfile；\n"
    "     也读不了群历史消息（应用没这个权限），别去试。\n\n"
    "【图片与文件】他发来的图片/文件已经落到工作目录里（默认 .feishu-inbox/ 下），"
    "消息里给的是相对路径。图片必须用 read_image 真的打开看（能看图，别凭文件名猜），"
    "文件用读写工具打开；原件保留，不要删。\n"
    "用户消息：{text}"
)

RUNNING = {}   # open_id -> Task
QUEUES = {}    # open_id -> deque(dict)  排队等当前任务跑完


def cur_cwd(open_id):
    return STATE["cwd"].get(open_id) or CONF["agent_cwd"]


def sess_key(open_id, cwd):
    """会话按「人 + 项目目录」分开存：切项目 = 换一份记忆，不会互相污染。"""
    return "%s|%s" % (open_id, cwd)


class Task(object):
    def __init__(self, open_id, chat_id, text, session_id=None, approved=False, cwd=None,
                 label=None):
        self.open_id = open_id
        self.chat_id = chat_id
        self.text = text
        self.label = label or text   # 进度卡标题：给人看的一句，别把带路径的技术前缀糊上去
        self.session_id = session_id
        self.approved = approved
        self.cwd = cwd or cur_cwd(open_id)
        self.key = sess_key(open_id, self.cwd)
        self.proc = None
        self.started = time.time()
        self.deadline = self.started + int(CONF["soft_timeout_sec"])
        self.asked = False
        self.extend = threading.Event()
        self.done = threading.Event()
        self.cancelled = False
        self.steps = 0
        self.in_tok = 0
        self.out_tok = 0
        self.cache_tok = 0
        self.progress_sent = 0
        self.last_progress = 0.0
        # ⑤ 进度卡：一条消息，原地刷新
        self.card_id = ""
        self.steps_log = []          # [{"n","verb","hint","t"}]
        self.tool_n = 0
        self.last_patch = 0.0
        self.patch_lock = threading.Lock()
        self.phase = "running"       # running / done / failed / cancelled

    def kill(self):
        self.cancelled = True
        p = self.proc
        if p and p.poll() is None:
            try:
                p.kill()
            except Exception:
                log.exception("kill 失败")


# ─────────────────── 模型 / 思考强度（可切换） ───────────────────
#
# 这两项本进程不消费，是写给 agent 上的 DSH 的：dsh 启动时用 --patch 叠一层覆盖，
# 把 agent-default-model 的 model / reasoningEffort 换掉。不直接改 profile 的
# cordis.patch.yml，因为那份是 agent 机上所有 headless 调用共用的；--patch 只影响
# 这一次任务，随时能退。

# agent-default-model 的 schema 只认这四档（实测 deepseek-v4.1-flash 只吃 low/high/max）。
# 显示一律用官方档位名，不加自造说法；auto 是本机器人加的伪档，起任务时按任务内容现算。
EFFORTS = ("auto", "off", "low", "high", "max")
FIXED_EFFORTS = ("off", "low", "high", "max")
EFFORT_NOTE = {
    "auto": "按任务自动定档",
    "off": "关闭思考",
    "low": "低",
    "high": "高",
    "max": "最高",
}

# 先禁用掉不再使用的模型：v4-pro 贵且默认不用，留着容易被误点。
BLOCKED_MODELS = ("deepseek-v4-pro",)

# 目录真源：agent 上那份 pi-ai 自带的模型清单。用 glob 兜住版本路径变化。
_CATALOG_GLOB = (
    "/opt/node/lib/node_modules/@deepseek-ai/dsh/node_modules/"
    "@earendil-works/pi-ai/dist/providers/data/opencode-go.json"
)
_CATALOG_CACHE = {"at": 0.0, "rows": []}
_CATALOG_TTL = 600

# 卡片上默认摆出来的几个（都是实测能跑的），其余走「看全部」。
MODEL_PICKS = [
    ("deepseek-v4.1-flash", "默认，日常够用"),
    ("glm-5.3-flash", "同价位替补"),
    ("claude-haiku-5-5", "长文/看图稳"),
    ("gpt-6-luna", "另一种口味"),
]

# ── auto 档的打分器 ─────────────────────────────────────────────
# 抄的是 LiteLLM 的 ComplexityRouter（litellm/router_strategy/complexity_router）：
# 不靠「命中一个词就定档」，而是七个维度各自给 -1/0/+1 分，按权重加权求和，再用阈值切档。
# 权重和阈值沿用它的默认值（那是在真实流量上调过的），只把词表换成中文、把长度门槛按
# 中文信息密度调小。它原来还带一个 LLM 分类器兜灰区，我们不用——多一次调用换不来准确性，
# 反而给每条任务加两秒延迟。
_EFFORT_WEIGHTS = {
    "length": 0.10,
    "code": 0.30,
    "reasoning": 0.25,
    "technical": 0.25,
    "simple": 0.05,
    "multiStep": 0.05,
    "questions": 0.06,
}
# 三档（low / high / max）两条切线。LiteLLM 四档用 0.15 / 0.35 / 0.60，那是英文长 prompt 的
# 分布；中文短句命中少、分数普遍压在 0.3 以下，直接照搬会把复杂活也判成 low，所以切线按
# 中文语料的实际分布下调到 0.05 / 0.20。
_EFFORT_CUTS = {"low_high": 0.05, "high_max": 0.20}
# 中文一个字大约就是一个 token，所以比 LiteLLM 的 15 / 400 收紧；超过 long 直接判最高档。
_EFFORT_LEN = {"short": 15, "long": 800}

_KW_CODE = (
    "代码", "函数", "报错", "异常", "接口", "部署", "编译", "脚本", "仓库", "提交",
    "合并", "分支", "依赖", "日志", "配置", "数据库", "查询", "索引", "重构", "算法",
    "实现", "单元测试", "调试", "报错信息", "文件", "目录", "环境变量", "版本",
    "function", "refactor", "deploy", "docker", "kubernetes", "sql", "python",
    "javascript", "typescript", "endpoint", "debug", "traceback", "stack trace",
    "segfault", "migration",
)
_KW_REASONING = (
    "仔细", "彻底", "深入", "严谨", "证明", "推导", "论证", "为什么", "根因", "权衡",
    "取舍", "评估", "分析", "推理", "分步骤", "一步一步", "思路", "排查", "定位",
    "复盘", "审查", "审计", "设计", "架构", "批改", "基准", "对比", "比较",
    "tradeoff", "trade-off", "root cause", "prove", "derive", "step by step",
    "compare", "analyze", "analyse", "why",
)
_KW_TECHNICAL = (
    "并发", "并行", "线程", "内存", "性能", "延迟", "吞吐", "协议", "加密", "鉴权",
    "认证", "分布式", "微服务", "扩展性", "一致性", "事务", "缓存", "队列", "调度",
    "容器", "集群", "网络", "磁盘", "内核", "运行时", "带宽", "负载",
    "concurrency", "latency", "throughput", "scalability", "consistency", "cache",
)
_KW_SIMPLE = (
    "是什么", "什么是", "多少", "几个", "翻译", "改成", "格式化", "润色", "查一下",
    "列一下", "列举", "回答", "念一下", "转成", "换成", "你好", "谢谢", "在吗", "随便",
)
_MULTI_STEP_RE = re.compile(r"首先|然后|接着|之后|最后|第一步|步骤|依次|同时|以及|并且")


def _kw_hits(text, words):
    return [w for w in words if w in text]


def _effort_score(text):
    """七个维度打分加权求和，返回 (分数, 各维度命中数)。"""
    t = (text or "").strip()
    n = len(t)
    hits = {}

    # 1. 长度：太短往下压，太长往上抬，中间不给分
    if n < _EFFORT_LEN["short"]:
        dims = {"length": -1.0}
    elif n > _EFFORT_LEN["long"]:
        dims = {"length": 1.0}
    else:
        dims = {"length": 0.0}

    # 2. 代码痕迹
    c = _kw_hits(t, _KW_CODE)
    hits["code"] = len(c)
    dims["code"] = 1.0 if len(c) >= 2 else (0.5 if c else 0.0)

    # 3. 推理词
    r = _kw_hits(t, _KW_REASONING)
    hits["reasoning"] = len(r)
    dims["reasoning"] = 1.0 if len(r) >= 2 else (0.7 if r else 0.0)

    # 4. 技术术语。LiteLLM 要命中 2 个才给分（英文技术词太泛），中文这几个词（并发、加密、
    #    分布式）本身指向性就强，命中一个也该算，只是给得少一点。
    g = _kw_hits(t, _KW_TECHNICAL)
    hits["technical"] = len(g)
    if len(g) >= 4:
        dims["technical"] = 1.0
    elif len(g) >= 2:
        dims["technical"] = 0.6
    else:
        dims["technical"] = 0.3 if g else 0.0

    # 5. 轻活信号（反向）。只在没有任何硬信号时才生效：一句话里既有「报错」又有
    #    「是什么原因」，那是要诊断，不是要查字典，不能被轻活标记拉回去。
    s = _kw_hits(t, _KW_SIMPLE)
    hits["simple"] = len(s)
    dims["simple"] = -1.0 if (s and not (c or r or g)) else 0.0
    hits["simpleApplied"] = bool(dims["simple"])

    # 6. 多步
    m = _MULTI_STEP_RE.search(t)
    hits["multiStep"] = 1 if m else 0
    dims["multiStep"] = 0.5 if m else 0.0

    # 7. 问句堆叠
    q = t.count("?") + t.count("？")
    hits["questions"] = q
    dims["questions"] = 0.5 if q > 3 else 0.0

    score = round(sum(dims[k] * _EFFORT_WEIGHTS[k] for k in dims), 4)
    return score, hits


def _effort_why(score, hits, text):
    """把打分结果翻成一句人话，塞进进度卡脚注。"""
    n = len(text or "")
    bits = []
    if hits.get("reasoning"):
        bits.append("推理×%d" % hits["reasoning"])
    if hits.get("code"):
        bits.append("代码×%d" % hits["code"])
    if hits.get("technical"):
        bits.append("术语×%d" % hits["technical"])
    if hits.get("multiStep"):
        bits.append("多步")
    if hits.get("questions", 0) > 3:
        bits.append("%d 个问句" % hits["questions"])
    if hits.get("simpleApplied"):
        bits.append("轻活")
    if n > _EFFORT_LEN["long"]:
        bits.append("%d 字偏长" % n)
    elif n < _EFFORT_LEN["short"]:
        bits.append("只有 %d 字" % n)
    if not bits:
        bits.append("没明显信号")
    return "分 %+.2f · %s" % (score, " ".join(bits))


def decide_effort(text):
    """auto 档：按这条任务的样子挑一个官方档位，返回 (档位, 一句理由)。"""
    t = (text or "").strip()
    n = len(t)
    score, hits = _effort_score(t)
    # 硬规则一：超长任务直接最高档（LiteLLM 也有这种按大小独立升级的门，不参与加权）
    if n > _EFFORT_LEN["long"]:
        return "max", "分 %+.2f · %d 字，太长了" % (score, n)
    # 硬规则二：带附件（图片/文件）的活至少从 high 起步——看东西本身就要琢磨
    attach = ".feishu-inbox" in t
    if score < _EFFORT_CUTS["low_high"]:
        eff = "high" if attach else "low"
    elif score < _EFFORT_CUTS["high_max"]:
        eff = "high"
    else:
        eff = "max"
    # LiteLLM 的 reasoning override：明确要求推理的词出现两次以上，就算总分不高也抬到最高档
    if hits.get("reasoning", 0) >= 2 and score >= _EFFORT_CUTS["low_high"]:
        eff = "max"
    why = _effort_why(score, hits, t)
    if attach and eff == "high" and score < _EFFORT_CUTS["low_high"]:
        why += " · 带附件"
    return eff, why


def _catalog_script():
    return (
        "python3 - <<'PY'\n"
        "import json, glob\n"
        "ps = glob.glob('%s')\n"
        "if not ps:\n"
        "    print('NOFILE'); raise SystemExit\n"
        "d = json.load(open(ps[0]))\n"
        "for api, ms in d.items():\n"
        "    for k, v in ms.items():\n"
        "        c = v.get('cost') or {}\n"
        "        print('|'.join([\n"
        "            str(v.get('id') or ''), str(v.get('name') or ''), str(api),\n"
        "            str(v.get('contextWindow') or ''),\n"
        "            '1' if 'image' in (v.get('input') or []) else '0',\n"
        "            str(c.get('input') if c.get('input') is not None else ''),\n"
        "            str(c.get('output') if c.get('output') is not None else ''),\n"
        "        ]))\n"
        "PY" % _CATALOG_GLOB
    )


def fetch_models(force=False):
    """从 agent 上正在用的那份清单读模型，别在代码里抄一份会过期的。"""
    now = time.time()
    if not force and _CATALOG_CACHE["rows"] and now - _CATALOG_CACHE["at"] < _CATALOG_TTL:
        return _CATALOG_CACHE["rows"]
    code, out = run_agent(_catalog_script(), timeout=60)
    rows = []
    if code == 0 and "NOFILE" not in out:
        for ln in out.splitlines():
            p = ln.split("|")
            if len(p) == 7 and p[0]:
                rows.append({
                    "id": p[0], "name": p[1], "api": p[2], "ctx": p[3],
                    "img": p[4] == "1", "in": p[5], "out": p[6],
                })
    if rows:
        _CATALOG_CACHE["rows"] = rows
        _CATALOG_CACHE["at"] = now
    return rows or _CATALOG_CACHE["rows"]


def _model_label(mid):
    for r in fetch_models():
        if r["id"] == mid:
            return r["name"] or mid
    return mid


def resolve_effort(task):
    """这条任务实际用哪一档；auto 就现算，结果记在 task 上给进度卡用。"""
    cur = (CONF.get("reasoning_effort") or "").strip() or "high"
    if cur != "auto":
        task.effort_used = cur
        task.effort_why = ""
        return cur
    eff, why = decide_effort(task.text)
    task.effort_used = eff
    task.effort_why = why
    return eff


def override_path(effort):
    """每个档位一份 overlay：同时跑几条任务也不会互相覆盖。"""
    base = (CONF.get("model_override_path") or "").strip()
    if not base:
        return ""
    d, _, f = base.rpartition("/")
    stem = f[:-4] if f.endswith(".yml") else f
    name = "%s-%s.yml" % (stem, effort)
    return ("%s/%s" % (d, name)) if d else name


def _override_body(model, effort):
    body = (
        "- id: agent-default-model\n"
        "  name: \"@deepseek-ai/dsh-agent-default-model\"\n"
        "  config:\n"
        "    provider: opencode-go\n"
    )
    if model:
        body += "    model: %s\n" % model
    if effort:
        body += "    reasoningEffort: %s\n" % effort
    return body


def push_model_override():
    """当前模型 × 四个官方档位各写一份 patch，起任务时按实际档位挑一份叠上去。"""
    base = (CONF.get("model_override_path") or "").strip()
    if not base:
        return False
    model = (CONF.get("model") or "").strip()
    effort = (CONF.get("reasoning_effort") or "").strip()
    if not model and not effort:
        paths = [shlex.quote(base)] + [shlex.quote(override_path(e)) for e in FIXED_EFFORTS]
        run_agent("rm -f %s" % " ".join(p for p in paths if p), timeout=20)
        return True
    parts = []
    for e in FIXED_EFFORTS:
        p = override_path(e)
        if not p:
            return False
        q = shlex.quote(p)
        parts.append(
            "mkdir -p \"$(dirname %s)\"; cat > %s.tmp <<'YML'\n%sYML\nmv %s.tmp %s"
            % (q, q, _override_body(model, e), q, q)
        )
    code, out = run_agent(" && ".join(parts) + " && echo OK", timeout=60)
    ok = "OK" in out
    log.info("模型覆盖写入 %s-<档>.yml: model=%s effort=%s ok=%s", base, model, effort, ok)
    return ok


def verify_choice(effort=None, timeout=150):
    """真跑一次最短任务，确认这个「模型+档位」组合 provider 认。"""
    effort = (effort or CONF.get("reasoning_effort") or "").strip()
    if effort in ("", "auto"):
        effort = "high"          # auto 用一个代表档验证模型本身可用
    path = override_path(effort)
    if not path:
        return True, ""
    cmd = "cd %s; %s --patch %s --json '回答一个字：好'" % (
        shlex.quote(CONF["agent_root"]), CONF["dsh_cmd"], shlex.quote(path)
    )
    code, out = run_agent(cmd, timeout=timeout)
    if "UNSUPPORTED_REASONING_EFFORT" in out:
        m = re.search(r'does not support reasoning effort "([^"]+)"', out)
        return False, "这个模型不支持 reasoningEffort「%s」" % (m.group(1) if m else effort)
    if "MISSING_CREDENTIAL" in out or "INVALID_CREDENTIAL" in out:
        return False, "这个模型当前凭据用不了"
    if re.search(r'"type":"final"', out):
        return True, ""
    tail = " ".join(out.strip().splitlines()[-1:])[:160]
    return False, tail or "试跑没出结果"


def apply_choice(model=None, effort=None):
    """改一项或两项：先落 patch，再真跑一次；不认就退回原样。返回 (ok, 说明)。"""
    old_model = CONF.get("model")
    old_effort = CONF.get("reasoning_effort")
    if model is not None:
        if model in BLOCKED_MODELS:
            return False, "%s 已禁用，当前只用 %s。" % (
                model, CONF.get("model") or "deepseek-v4.1-flash")
        # dsh 遇到不认识的模型名不报错，会静默回落到能用的那个，
        # 所以「试跑成功」证明不了名字对——先拿清单核对一遍。
        known = {r["id"] for r in fetch_models()}
        if known and model not in known:
            near = sorted(k for k in known if model.lower() in k.lower())[:5]
            return False, "没有这个模型：%s%s" % (
                model,
                ("\n相近的：" + "、".join(near)) if near else "\n发 /模型 列表 看全部。",
            )
    if effort is not None and effort not in EFFORTS:
        return False, "reasoningEffort 只有 %s 这几档。" % " / ".join(EFFORTS)
    if model is not None:
        CONF["model"] = model
    if effort is not None:
        CONF["reasoning_effort"] = effort
    save_conf()
    if not push_model_override():
        CONF["model"], CONF["reasoning_effort"] = old_model, old_effort
        save_conf()
        push_model_override()
        return False, "写不进 agent 机上的配置，已退回原样。"
    ok, why = verify_choice(effort=effort or CONF.get("reasoning_effort"))
    if not ok:
        CONF["model"], CONF["reasoning_effort"] = old_model, old_effort
        save_conf()
        push_model_override()
        return False, "%s，已经退回 %s / %s。" % (
            why,
            _model_label(old_model or "") if old_model else "默认模型",
            old_effort or "默认档",
        )
    return True, ""


def _effort_line():
    e = (CONF.get("reasoning_effort") or "").strip()
    if not e:
        return "跟 profile 默认走"
    if e == "auto":
        return "auto（按任务自动定档）"
    return e


def effort_card():
    cur = CONF.get("reasoning_effort") or ""
    btns = []
    for e in EFFORTS:
        label = ("✓ " if e == cur else "") + e
        btns.append({
            "tag": "button",
            "text": {"tag": "plain_text", "content": label},
            "type": "primary" if e == cur else "default",
            "value": {"act": "set_effort", "v": e},
        })
    return {
        "config": {"wide_screen_mode": True, "update_multi": True},
        "header": {
            "template": "indigo",
            "title": {"tag": "plain_text", "content": "reasoningEffort"},
        },
        "elements": [
            {"tag": "div", "text": {"tag": "lark_md",
                                    "content": "现在是 **%s**（`%s`）。" % (_effort_line(), cur or "未设")}},
            {"tag": "div", "text": {"tag": "lark_md",
                                    "content": "官方四档：`off` 关闭思考，`low` / `high` / `max` 深度递增。\n"
                                               "`auto` 由机器人按这条任务的样子现挑一档，进度卡上会写明挑了哪档、为什么。\n"
                                               "不同模型支持的档不一样，切了跑不动我会自动退回并告诉你。"}},
            {"tag": "action", "actions": btns},
            {"tag": "note", "elements": [{"tag": "plain_text",
                                          "content": "也可以直接发：/思考 max"}]},
        ],
    }


def model_card():
    cur = CONF.get("model") or ""
    known = {r["id"]: r for r in fetch_models()}
    lines = ["现在是 **%s**" % (_model_label(cur) if cur else "（跟 profile 默认走）")]
    if cur in known:
        r = known[cur]
        bits = []
        if r["in"] not in ("", "None"):
            bits.append("$%s/$%s 每百万 token" % (r["in"], r["out"]))
        if r["ctx"]:
            bits.append("上下文 %s" % _fmt_ctx(r["ctx"]))
        if r["img"]:
            bits.append("能看图")
        if bits:
            lines.append("　" + " · ".join(bits))
    btns = []
    for mid, why in MODEL_PICKS:
        if mid == cur:
            continue
        btns.append({
            "tag": "button",
            "text": {"tag": "plain_text", "content": mid},
            "type": "default",
            "value": {"act": "set_model", "v": mid},
        })
    els = [
        {"tag": "div", "text": {"tag": "lark_md", "content": "\n".join(lines)}},
        {"tag": "div", "text": {"tag": "lark_md", "content": "**换个模型**"}},
        {"tag": "action", "actions": btns[:3]},
    ]
    if len(btns) > 3:
        els.append({"tag": "action", "actions": btns[3:]})
    els.append({
        "tag": "action",
        "actions": [{
            "tag": "button",
            "text": {"tag": "plain_text", "content": "看全部 %d 个" % len(known)},
            "type": "default",
            "value": {"act": "model_all"},
        }],
    })
    els.append({"tag": "note", "elements": [{"tag": "plain_text",
                                             "content": "也可以直接发：/模型 deepseek-v4.1-flash"}]})
    return {
        "config": {"wide_screen_mode": True, "update_multi": True},
        "header": {"template": "blue", "title": {"tag": "plain_text", "content": "模型"}},
        "elements": els,
    }


def _fmt_ctx(v):
    try:
        n = int(v)
    except Exception:
        return str(v)
    if n >= 1000000:
        return "%.1fM" % (n / 1000000.0)
    return "%dk" % (n // 1000)


def models_text():
    rows = fetch_models(force=True)
    if not rows:
        return "读不到模型清单（agent 上找不到 pi-ai 的目录文件）。"
    cur = CONF.get("model") or ""
    usable = [r for r in rows if r["id"] not in BLOCKED_MODELS]
    lines = ["可用模型（%d 个，已排除禁用的 %s）："
             % (len(usable), "、".join(BLOCKED_MODELS) or "无")]
    for r in sorted(usable, key=lambda x: (float(x["in"] or 0) if x["in"] not in ("", "None") else 0)):
        mark = "▶" if r["id"] == cur else " "
        cost = "$%s/$%s" % (r["in"], r["out"]) if r["in"] not in ("", "None") else "免费"
        lines.append("%s %-30s %-9s %s%s" % (
            mark, r["id"], cost, _fmt_ctx(r["ctx"]), " 可看图" if r["img"] else ""))
    lines.append("")
    lines.append("切换：/模型 <名字>")
    return "\n".join(lines)


def help_card():
    def block(title, rows):
        return {"tag": "div", "text": {"tag": "lark_md",
                                       "content": "**%s**\n%s" % (title, "\n".join(rows))}}

    els = [
        {"tag": "div", "text": {"tag": "lark_md",
                                "content": "直接说要做什么就行，我转给 agent 工作站上的 DSH（每人一份独立记忆）。"
                                           "要文件就说「把 XX 的 Word 发我」，它会真的传过来。"}},
        block("换脑子", [
            "`/模型` 看现在用哪个，按钮直接换",
            "`/思考` reasoningEffort：`auto` / `off` / `low` / `high` / `max`",
        ]),
        block("看状态", [
            "`/状态` 在跑什么、排队几个、机器负载",
            "`/排队` 排了哪些活　`/清队` 清空",
            "`/额度` 模型用量还剩多少",
        ]),
        block("管记忆与项目", [
            "`/项目` 有哪些工作区　`/cd 名字` 切过去",
            "`/新` 清空我这份记忆，从头开始",
        ]),
        block("管群", [
            "`/免@` 群里不用 @ 就响应（现在这样）",
            "`/要@` 改回必须 @",
        ]),
        block("其它", [
            "停 / 继续　中止或延长正在跑的任务",
            "`/whoami` 我的 open_id 和当前项目　`/name 名字` 让我怎么叫你",
            "危险动作会发卡片问你要不要放行，点按钮即可",
        ]),
    ]
    return {
        "config": {"wide_screen_mode": True, "update_multi": True},
        "header": {"template": "turquoise", "title": {"tag": "plain_text", "content": "能干什么"}},
        "elements": els,
    }


def dsh_argv(task):
    # FEISHU_CHAT_ID 透给 agent 上的 pushfile —— agent 自己不知道要往哪个会话发文件。
    # 同时写一份兜底文件：万一 dsh 的 bash 工具没继承环境变量，pushfile 还能读到。
    cmd = (
        "cd %s 2>/dev/null || cd %s; "
        "export PATH=\"$HOME/.local/bin:$PATH\"; "
        "export FEISHU_CHAT_ID=%s; "
        "mkdir -p ~/.cache/feishu 2>/dev/null && echo %s > ~/.cache/feishu/chat_id 2>/dev/null; "
        "exec %s"
        % (
            shlex.quote(task.cwd), shlex.quote(CONF["agent_root"]),
            shlex.quote(task.chat_id),
            shlex.quote(task.chat_id),
            CONF["dsh_cmd"],
        )
    )
    # 模型/思考强度走单次 patch 覆盖：改的是这一趟，不碰 profile 本体。
    # auto 档在 start_task 里已算成具体档位（task.effort_used），这里按档挑对应那份 overlay。
    effort = getattr(task, "effort_used", None) or (CONF.get("reasoning_effort") or "").strip()
    if effort == "auto":
        effort = "high"
    patch_path = override_path(effort) if effort else ""
    if patch_path:
        cmd += " --patch %s" % shlex.quote(patch_path)
    cmd += " --json"
    if task.session_id:
        cmd += " --session-id %s" % task.session_id
    cmd += " -"
    return ssh_argv(CONF["agent_host"], CONF["agent_user"], CONF["agent_key"]) + [cmd]


PHASE_VERB = {
    "bash": "执行", "shell": "执行", "terminal": "执行",
    "read": "读文件", "write": "写文件", "edit": "改文件",
    "glob": "找文件", "grep": "查内容", "ls": "看目录",
    "web_fetch": "抓网页", "web_search": "搜网页", "fetch": "抓网页",
    "todo_write": "理步骤", "todo": "理步骤",
    "skill": "调技能", "subagent": "派子任务", "task": "派子任务",
    "browser": "开浏览器", "pushfile": "发文件",
}

_ZH = re.compile(r"[\u4e00-\u9fff]")


def _human_step(tool, inp):
    """工具名 + 原始命令对用户零信息量，翻成一句人话。"""
    verb = PHASE_VERB.get(str(tool or "").lower(), "处理")
    hint = ""
    for k in ("description", "path", "file_path", "pattern", "query", "url", "command"):
        v = (inp or {}).get(k)
        if isinstance(v, str) and v.strip():
            v = " ".join(v.split())[:48]
            hint = v + ("…" if len(v) >= 48 else "")
            break
    if hint and not _ZH.search(hint):      # 英文上下文对用户没意义，丢掉
        hint = ""
    return verb, hint


def _dur(sec):
    sec = max(0, int(sec))
    if sec < 60:
        return "%d 秒" % sec
    if sec < 3600:
        return "%d 分 %d 秒" % (sec // 60, sec % 60)
    return "%d 小时 %d 分" % (sec // 3600, (sec % 3600) // 60)


def _esc(s):
    """lark_md 里的 markdown 标记会把用户内容吃掉，简单转义。"""
    return (s or "").replace("\\", "\\\\").replace("*", "\\*").replace("_", "\\_").replace("~", "\\~")


def _seconds_of(task):
    return time.time() - task.started


def build_progress_card(task):
    """整块进度卡：标题 + 任务 + 最近几步 + 脚注。永远只有这一条消息。"""
    total = len(task.steps_log)
    tail = task.steps_log[-5:]
    rows = []
    if total > len(tail):
        rows.append("_… 前面 %d 步已完成_" % (total - len(tail)))
    for s in tail:
        line = "· **%s**" % _esc(s["verb"])
        if s.get("hint"):
            line += " %s" % _esc(s["hint"])
        rows.append(line)
    if not rows:
        rows.append("_正在想…_")
    head = (getattr(task, "label", None) or task.text or "").replace("\n", " ")[:70]
    # auto 档要让人看得见判成了哪一档、为什么——不然「自动」等于黑箱
    auto_note = ""
    if (CONF.get("reasoning_effort") or "") == "auto":
        used = getattr(task, "effort_used", "") or ""
        why = getattr(task, "effort_why", "") or ""
        if used:
            auto_note = "　·　reasoningEffort auto → %s（%s）" % (used, why or "常规任务")
    return {
        "config": {"wide_screen_mode": True, "update_multi": True},
        "header": {
            "template": "blue",
            "title": {"tag": "plain_text", "content": "🧠 正在处理"},
        },
        "elements": [
            {"tag": "div", "text": {"tag": "lark_md", "content": "**%s**" % _esc(head)}},
            {"tag": "hr"},
            {"tag": "div", "text": {"tag": "lark_md", "content": "\n".join(rows)}},
            {
                "tag": "note",
                "elements": [{
                    "tag": "plain_text",
                    "content": "已用 %s · 第 %d 步 · %s%s"
                               % (_dur(_seconds_of(task)), max(total, 1),
                                  task.cwd.rstrip("/").rsplit("/", 1)[-1] or task.cwd,
                                  auto_note),
                }],
            },
        ],
    }


def build_final_card(task, ok, body, note=""):
    """跑完了，同一张卡改成结果，不另发一条。"""
    if ok and task.phase == "cancelled":
        ok, note = False, note or "已中止"
    icon, title, tpl = ("✅ 完成", 1, "green") if ok else ("⛔ 没成", 0, "red")
    els = []
    if body:
        els.append({"tag": "div", "text": {"tag": "lark_md", "content": body[:3200]}})
    if note:
        els.append({"tag": "div", "text": {"tag": "lark_md", "content": "_%s_" % _esc(note)}})
    if not els:
        els.append({"tag": "div", "text": {"tag": "lark_md", "content": "_没有输出_"}})
    els.append({
        "tag": "note",
        "elements": [{
            "tag": "plain_text",
            "content": "用时 %s · %d 步 · %d 轮 · 工作区 %s"
                       % (_dur(_seconds_of(task)), max(task.steps, 0), len(task.steps_log),
                          task.cwd.rstrip("/").rsplit("/", 1)[-1] or task.cwd),
        }],
    })
    return {
        "config": {"wide_screen_mode": True, "update_multi": True},
        "header": {"template": tpl, "title": {"tag": "plain_text", "content": icon}},
        "elements": els,
    }


def refresh_progress(task, force=False):
    """节流刷新：2 秒内最多改一次卡片，避免打飞书限频。"""
    if not task.card_id:
        return
    now = time.time()
    with task.patch_lock:
        if not force and now - task.last_patch < 2.0:
            return
        task.last_patch = now
    card_patch(task.card_id, build_progress_card(task))


def progress(task, tool, inp):
    task.tool_n += 1
    verb, hint = _human_step(tool, inp)
    task.steps_log.append({"n": task.tool_n, "verb": verb, "hint": hint, "t": time.time()})
    if len(task.steps_log) > 60:
        del task.steps_log[:-60]
    refresh_progress(task)


def run_dsh_once(task):
    """跑一轮 dsh，返回 (final_text, session_id, exit_code, stderr, retry_needed)。"""
    argv = dsh_argv(task)
    prompt = PROMPT_TMPL.format(
        who=who_name(task.open_id), cwd=task.cwd, text=task.text
    )
    log.info("dsh start open_id=%s session=%s", task.open_id, task.session_id)
    p = subprocess.Popen(
        argv,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
        errors="replace",
    )
    task.proc = p
    try:
        p.stdin.write(prompt)
        p.stdin.close()
    except Exception:
        log.exception("写 stdin 失败")

    final_text = ""
    sid = ""
    try:
        for line in p.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                ev = json.loads(line)
            except Exception:
                continue
            t = ev.get("type")
            if t == "session":
                sid = ev.get("sessionId") or sid
                if sid and sid != task.session_id:
                    task.session_id = sid
                    STATE["sessions"][task.key] = sid
                    save_state()
            elif t == "tool_call":
                progress(task, ev.get("tool"), ev.get("input") or {})
            elif t == "status" and ev.get("phase") == "step_end":
                u = ev.get("usage") or {}
                task.steps += 1
                task.in_tok += int(u.get("inputTokens") or 0)
                task.out_tok += int(u.get("outputTokens") or 0)
                task.cache_tok += int(u.get("cacheReadTokens") or 0)
            elif t == "final":
                final_text = ev.get("text") or ""
    finally:
        try:
            stderr = p.stderr.read()
        except Exception:
            stderr = ""
        code = p.wait()

    retry = False
    if code != 0 and task.session_id and re.search(
        r"session|not found|unknown id|ENOENT", stderr or "", re.I
    ):
        retry = True
        log.warning("会话 %s 不可用，清掉后重试一轮：%s", task.session_id, (stderr or "")[:200])
        STATE["sessions"].pop(task.key, None)
        save_state()
        task.session_id = None
    return final_text, sid, code, stderr, retry


def worker(task):
    """跑完一个任务后，把这个人队列里的下一个顶上来。"""
    try:
        worker_body(task)
    except Exception:
        log.exception("worker_body 抛出未捕获异常")
    finally:
        RUNNING.pop(task.open_id, None)
        drain_queue(task.open_id)


def drain_queue(open_id):
    q = QUEUES.get(open_id)
    if not q:
        return
    nxt = q.popleft()
    log.info("队列继续 open_id=%s 剩 %d 个", open_id, len(q))
    start_task(open_id, nxt["chat_id"], nxt["text"], nxt["cwd"], nxt.get("approved", False),
               nxt.get("label"))


def worker_body(task):
    RUNNING[task.open_id] = task
    threading.Thread(target=watchdog, args=(task,), daemon=True).start()
    started = time.time()
    ok = False
    final = ""
    note = ""
    try:
        final, sid, code, stderr, retry = run_dsh_once(task)
        if retry and not task.cancelled:
            final, sid, code, stderr, retry = run_dsh_once(task)
        if task.cancelled:
            note = "（已中止）"
        elif code != 0 and not final:
            ok = False
            note = "（agent 侧退出码 %d）\n%s" % (code, (stderr or "").strip()[-1200:])
        else:
            ok = True
    except Exception as e:
        log.exception("worker 异常")
        note = "（内部错误：%s）" % e
    finally:
        task.done.set()

    dur = time.time() - started
    entry = {
        "ts": datetime.now().isoformat(timespec="seconds"),
        "date": datetime.now().strftime("%Y-%m-%d"),
        "open_id": task.open_id,
        "name": who_name(task.open_id),
        "chat_id": task.chat_id,
        "session": task.session_id or "",
        "ok": bool(ok),
        "cancelled": bool(task.cancelled),
        "dur": round(dur, 1),
        "steps": task.steps,
        "in_tok": task.in_tok,
        "out_tok": task.out_tok,
        "cache_tok": task.cache_tok,
        "task": task.text[:300],
    }
    try:
        with LEDGER_PATH.open("a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except Exception:
        log.exception("写账本失败")

    body = (final or "").strip()
    # 「刚才那件事怎么样了」要能答上来：只留一句结论
    STATE.setdefault("last", {})[task.open_id] = {
        "ts": datetime.now().strftime("%m-%d %H:%M"),
        "ok": bool(ok),
        "task": (task.text or "")[:60],
        "body": (body or note or "")[:120].replace("\n", " "),
        "dur": round(dur, 0),
    }
    save_state()
    if body.startswith("CLARIFY:"):
        # ⑩ 反问一个具体候选：直接把进度卡变成问句，不另发一条
        q = body[len("CLARIFY:"):].strip()
        task.phase = "clarify"
        card = {
            "config": {"wide_screen_mode": True, "update_multi": True},
            "header": {"template": "orange",
                       "title": {"tag": "plain_text", "content": "❓ 想确认一下"}},
            "elements": [
                {"tag": "div", "text": {"tag": "lark_md", "content": _esc(q)}},
                {"tag": "note", "elements": [{"tag": "plain_text",
                                              "content": "直接回一句就行 · 已用 %s" % _dur(_seconds_of(task))}]},
            ],
        }
        if not (task.card_id and card_patch(task.card_id, card)):
            send(task.chat_id, q)
        return

    if not body:
        body = note or "（没有拿到回答）"
    elif note:
        body = body + "\n\n" + note
    task.phase = "cancelled" if task.cancelled else ("done" if ok else "failed")

    # ⑤ 结果回填同一张卡；太长才走老的「贴成文件」路径
    lines = body.count("\n") + 1
    if task.card_id and lines <= int(CONF["max_inline_lines"]) and len(body) <= 3000:
        if card_patch(task.card_id, build_final_card(task, ok, body)):
            return
    deliver(task.chat_id, body, title="结果")


def watchdog(task):
    while not task.done.wait(2):
        now = time.time()
        # 让卡片上的「已用时」自己往前走，用户随时瞄一眼就知道还活着
        if now - task.last_patch >= 15 and task.card_id:
            refresh_progress(task, force=True)
        if task.extend.is_set():
            task.extend.clear()
            task.deadline = now + int(CONF["soft_timeout_sec"])
            task.asked = False
            continue
        if now < task.deadline:
            continue
        if not task.asked:
            task.asked = True
            task.deadline = now + int(CONF["soft_timeout_sec"])
            send(
                task.chat_id,
                "还在跑（已 %.0f 分钟）…要继续吗？回「继续」再给 %d 分钟，回「停」立刻中止。"
                % ((now - task.started) / 60, int(CONF["soft_timeout_sec"]) // 60),
            )
        else:
            send(task.chat_id, "已 %.0f 分钟没等到确认，先停下这个任务。" % ((now - task.started) / 60))
            task.kill()
            return


def start_task(open_id, chat_id, text, cwd=None, approved=False, label=None):
    cwd = cwd or cur_cwd(open_id)
    sid = STATE["sessions"].get(sess_key(open_id, cwd))
    task = Task(open_id, chat_id, text, sid, approved, cwd, label)
    resolve_effort(task)          # auto 档在这里定成具体档位，进度卡上会写明
    # ⑤ 一条进度卡，原地刷新 —— 不再「收到」+ 8 条「· bash: …」刷屏
    task.card_id = card_create(chat_id, build_progress_card(task)) or ""
    log.info("task start open_id=%s card=%s cwd=%s effort=%s(%s)",
             open_id, task.card_id, cwd, getattr(task, "effort_used", ""),
             getattr(task, "effort_why", ""))
    threading.Thread(target=worker, args=(task,), daemon=True).start()


def pending_task(open_id, chat_id, text, session_id=None, approved=False, label=None):
    hit = is_dangerous(text)
    if hit and not approved:
        ask_approval(
            open_id, chat_id, "dsh", {"text": text, "label": text[:60]},
            "这句话里有危险动作「%s」" % hit, text[:1200],
        )
        return
    cwd = cur_cwd(open_id)
    q = QUEUES.setdefault(open_id, collections.deque())
    busy = open_id in RUNNING
    if busy or q:
        # 一个人同时只跑一个，后面的排成先来先跑
        q.append({"text": text, "chat_id": chat_id, "cwd": cwd, "approved": approved,
                  "label": label})
        ahead = len(q) + (1 if busy else 0)
        send(chat_id, "⏳ 前面还有 %d 个在跑，这个排上队了，完了自动接上。" % ahead)
        log.info("入队 open_id=%s pos=%d", open_id, ahead)
        return
    start_task(open_id, chat_id, text, cwd, approved, label)


# ─────────────────────────── 额度 / 日报 ───────────────────────────

def fetch_usage():
    """额度是网关的实时数据，密钥只在 agent 上（唯一定义处），所以从 agent 上查。"""
    cmd = (
        "set -a; . %s 2>/dev/null; set +a; "
        "curl -sS --max-time 15 -H \"Authorization: Bearer $OPENCODE_GO_API_KEY\" "
        "-H \"x-opencode-session: $(cat /proc/sys/kernel/random/uuid)\" '%s'"
        % (CONF["usage_key_file"], CONF["usage_url"])
    )
    code, out = run_agent(cmd, timeout=30)
    try:
        return json.loads(out)
    except Exception:
        log.warning("取额度失败: %s", out[:200])
        return None


def usage_lines():
    data = fetch_usage()
    if not data:
        return ["额度：取不到（agent 不可达或 key 失效）"]
    u = (data.get("usage") or {})
    label = {"rolling": "滚动窗口", "weekly": "本周", "monthly": "本月"}
    out = []
    for k in ("rolling", "weekly", "monthly"):
        v = u.get(k) or {}
        if not v:
            continue
        reset = v.get("resetsAt") or ""
        try:
            reset = (datetime.fromisoformat(reset.replace("Z", "+00:00"))
                     .astimezone().strftime("%m-%d %H:%M"))
        except Exception:
            pass
        out.append("  %s %s%%（%s 重置）" % (label.get(k, k), v.get("percent"), reset))
    return ["额度（opencode go 实时）："] + (out or ["  （无数据）"])


def ledger_for(day):
    rows = []
    try:
        with LEDGER_PATH.open(encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    r = json.loads(line)
                except Exception:
                    continue
                if r.get("date") == day:
                    rows.append(r)
    except FileNotFoundError:
        pass
    return rows


def daily_report(day=None):
    day = day or datetime.now().strftime("%Y-%m-%d")
    rows = ledger_for(day)
    ok = sum(1 for r in rows if r.get("ok"))
    tin = sum(r.get("in_tok") or 0 for r in rows)
    tout = sum(r.get("out_tok") or 0 for r in rows)
    tcache = sum(r.get("cache_tok") or 0 for r in rows)
    by = {}
    for r in rows:
        n = r.get("name") or who_name(r.get("open_id"))
        by[n] = by.get(n, 0) + 1
    lines = ["【600 G2 日报 %s】" % day, ""]
    lines += usage_lines()
    lines.append("")
    lines.append("今日用量：")
    lines.append("  任务 %d 次，成功 %d 次" % (len(rows), ok))
    lines.append("  输入 %d tok / 输出 %d tok / 命中缓存 %d tok" % (tin, tout, tcache))
    if by:
        lines.append("  分人：" + "；".join("%s %d 次" % (k, v) for k, v in by.items()))
    if not rows:
        lines.append("  （今天还没人用它）")
    return "\n".join(lines)


def report_loop():
    while True:
        try:
            now = datetime.now()
            hour = int(CONF["report_hour"])
            today = now.strftime("%Y-%m-%d")
            if now.hour >= hour and STATE.get("last_report_date") != today:
                chat_id = (CONF.get("report_chat_id") or STATE.get("last_group_chat_id")
                           or STATE.get("last_chat_id") or "")
                if chat_id:
                    send(chat_id, daily_report(today))
                    STATE["last_report_date"] = today
                    save_state()
                    log.info("已推日报 %s -> %s", today, chat_id)
                else:
                    log.info("到点了但还没有任何会话地址（先随便说句话）")
            sweep_approvals()
        except Exception:
            log.exception("report_loop")
        time.sleep(60)


# ─────────────────────────── 消息路由 ───────────────────────────

def allowed(open_id):
    return open_id in (CONF.get("allowed_open_ids") or [])


def mentioned_bot(msg):
    for m in (getattr(msg, "mentions", None) or []):
        try:
            if BOT_OPEN_ID and m.id and m.id.open_id == BOT_OPEN_ID:
                return True
        except Exception:
            continue
    return False


SEEN = {}          # message_id -> 首次处理时间戳，用于飞书重投去重
SEEN_LOCK = threading.Lock()


def _seen_before(message_id: str) -> bool:
    """飞书在 3 秒内没收到 ack 会重投同一条消息，这里按 message_id 去重。"""
    if not message_id:
        return False
    now = time.time()
    with SEEN_LOCK:
        for k, ts in list(SEEN.items()):
            if now - ts > 600:
                SEEN.pop(k, None)
        if message_id in SEEN:
            return True
        SEEN[message_id] = now
        return False


def handle(data: P2ImMessageReceiveV1):
    """飞书事件入口：立刻返回让 SDK 先 ack，真正的活丢到线程里干，避免超时重投。"""
    try:
        mid = data.event.message.message_id
    except Exception:
        mid = ""
    if _seen_before(mid):
        log.info("重投的消息 %s，跳过", mid)
        return
    threading.Thread(target=_handle_guarded, args=(data,), daemon=True).start()


def _handle_guarded(data: P2ImMessageReceiveV1):
    try:
        handle_inner(data)
    except Exception:
        log.exception("处理消息时炸了")


def handle_inner(data: P2ImMessageReceiveV1):
    try:
        msg = data.event.message
        chat_id = msg.chat_id
        chat_type = getattr(msg, "chat_type", "") or ""
        sender = data.event.sender.sender_id.open_id
        msg_type = msg.message_type
        log.info("recv type=%s chat=%s chat_type=%s sender=%s", msg_type, chat_id, chat_type, sender)

        if chat_type in ("group", "topic"):
            STATE["last_group_chat_id"] = chat_id
            if sender not in STATE["users"]:
                STATE["users"][sender] = {"first_seen": datetime.now().isoformat(timespec="seconds")}
            save_state()

        att = None
        if msg_type == "text":
            text = (json.loads(msg.content).get("text") or "").strip()
        elif msg_type in ATTACH_TYPES:
            att = parse_attachment(msg)
            text = ""
            log.info("attachment type=%s name=%s", msg_type, (att or {}).get("name"))
            if not att:
                if chat_type not in ("group", "topic"):
                    send(chat_id, "这条 %s 消息里没带附件 key，取不到东西。" % msg_type)
                log.info("附件消息没带 key，忽略 type=%s", msg_type)
                return
        else:
            # 群里免 @ 之后，别人发个表情包/合并转发不该收到任何提示
            if chat_type not in ("group", "topic"):
                send(chat_id, "这个我暂时接不住（%s）。发文字、图片、文件都行。" % msg_type)
            log.info("不支持的 msg_type=%s，忽略", msg_type)
            return

        raw = text
        text = re.sub(r"@_user_\d+", "", text).strip()
        log.info("text=%r", text)

        # 群里发图带不了 @：只有「必须 @」的模式才需要先收着等他 @ 一句；
        # 免 @ 模式下图片直接处理（他补的那句话会落进同一个会话，上下文还在）
        if (att and chat_type in ("group", "topic") and not mentioned_bot(msg)
                and CONF.get("group_require_mention")):
            if allowed(sender):
                stash_attachment(chat_id, sender, msg, att)
                send(chat_id, "📎 收到了：%s。15 分钟内 @我 说要拿它干什么，"
                              "我就一起处理。" % ("图片" if att["kind"] == "image" else "文件"))
                log.info("群里附件先收着 sender=%s kind=%s", sender, att["kind"])
            return

        STATE["last_chat_id"] = chat_id

        # ③ 群里要不要 @：默认不要（group_require_mention=false → 直接说话就行）
        if chat_type in ("group", "topic") and CONF.get("group_require_mention"):
            if not mentioned_bot(msg):
                log.info("群消息没 @ 我，忽略")
                return
            if BOT_OPEN_ID == "" and "@_user_" not in raw:
                log.info("群消息没有 @ 占位符，忽略")
                return

        # 上一条先收着的图/文件，挂到这句话上（群里发图 @ 不了我，只能事后 @ 一句）
        if msg_type == "text" and not att and text and not text.startswith("/") and allowed(sender):
            st = take_stashed(chat_id, sender)
            if st:
                att = {
                    "kind": "image" if st["rtype"] == "image" else "file",
                    "rtype": st["rtype"], "key": st["key"],
                    "name": st.get("name") or "", "_mid": st.get("mid") or "",
                }
                log.info("挂上待处理附件 key=%s kind=%s", st["key"], att["kind"])

        # 还没 @ 出文字（只 @ 了一下）→ 给提示
        if not text and not att:
            send(chat_id, "在。直接说要做什么就行（看 /help）。")
            return

        # ② 白名单：先放行自助开通，再拒绝外人
        m = re.match(r"^/claim\s+(\S+)$", text)
        if m:
            tok = (CONF.get("setup_token") or "").strip()
            if not tok:
                send(chat_id, "管理员还没设 setup_token，认领通道没开。")
            elif m.group(1) != tok:
                send(chat_id, "口令不对。")
                log.warning("claim 口令错误 sender=%s", sender)
            else:
                wl = CONF.setdefault("allowed_open_ids", [])
                if sender not in wl:
                    wl.append(sender)
                    save_conf()
                    log.info("claim 成功 sender=%s 白名单共 %d 人", sender, len(wl))
                send(chat_id, "认领成功，你在白名单里了（白名单共 %d 人）。\n"
                              "现在直接说话我就转给 DSH。先试一句：/status" % len(wl))
                if join_group(sender):
                    send(chat_id, "顺手把你拉进「G2 指挥群」了，群里直接说话就行（要 @ 也行）。")
            return

        m = re.match(r"^/(allow|deny)\s+(\S+)$", text)
        if m:
            if not allowed(sender):
                send(chat_id, "只有白名单里的人能改白名单。")
                return
            act, target = m.group(1), m.group(2).strip()
            wl = CONF.setdefault("allowed_open_ids", [])
            if act == "allow":
                if target in wl:
                    send(chat_id, "%s 已经在白名单里。" % target)
                else:
                    wl.append(target)
                    save_conf()
                    send(chat_id, "已加入 %s（白名单共 %d 人）。" % (target, len(wl)))
            else:
                if target not in wl:
                    send(chat_id, "%s 本来就不在白名单里。" % target)
                else:
                    wl.remove(target)
                    save_conf()
                    send(chat_id, "已移出 %s（白名单共 %d 人）。" % (target, len(wl)))
            return

        if not allowed(sender):
            if chat_type in ("group", "topic"):
                # 群里免 @ 之后，旁人的正常聊天不该收到任何提示
                log.info("群里白名单外的 sender=%s，静默忽略", sender)
                return
            wl = CONF.get("allowed_open_ids") or []
            if not wl:
                send(
                    chat_id,
                    "白名单还是空的，谁都先不给执行。\n你的 open_id：%s\n"
                    "开通方式：把这条发给我 —— /claim <管理口令>\n"
                    "（口令由我当面/另外渠道给你，别贴群里。）" % sender,
                )
            else:
                send(chat_id, "你在白名单外（open_id：%s），找管理员加一下：\n"
                              "/allow %s" % (sender, sender))
            return

        if sender not in STATE["users"]:
            STATE["users"][sender] = {"first_seen": datetime.now().isoformat(timespec="seconds")}
            save_state()

        # 附件：取回字节 → 落进工作目录 → 把路径写进任务描述（沙箱只认 cwd 内的文件）
        label = None
        if att:
            text, label = materialize_attachment(
                chat_id, sender, att.get("_mid") or msg.message_id, att, text
            )
            if text is None:
                return
            raw = text

        # 继续 / 停：先给正在跑的任务
        if text in ("继续", "/继续", "/continue"):
            t = RUNNING.get(sender)
            if t:
                t.extend.set()
                send(chat_id, "收到，继续等。")
            else:
                send(chat_id, "现在没有在跑的任务。")
            return
        if text in ("停", "/stop", "/停", "中止", "取消"):
            t = RUNNING.get(sender)
            if t:
                t.kill()
                q = QUEUES.get(sender)
                tail = "（队列里还有 %d 个，会继续跑；/清队 可清空）" % len(q) if q else ""
                send(chat_id, "已发中止信号。" + tail)
            else:
                send(chat_id, "现在没有在跑的任务。")
            return

        m = re.match(r"^(?:/批|批|/approve)\s*(\w+)$", text) or re.match(r"^(?:/拒|拒|/reject)\s*(\w+)$", text)
        if m:
            act = "approve" if text[0] in "/批" else "cancel"
            ok, why = resolve_approval(m.group(1), act, sender)
            if not ok:
                send(chat_id, why)
            return

        if text in ("/help", "help", "帮助", "/?", "/指令", "/h"):
            if not card_create(chat_id, help_card()):
                send(chat_id, INFO)
            return

        if text in ("/模型", "/model"):
            card_create(chat_id, model_card())
            return

        m = re.match(r"^/(?:模型|model)\s+(.+)$", text, re.S)
        if m:
            want = m.group(1).strip()
            if want in ("列表", "全部", "list", "all"):
                deliver(chat_id, models_text())
                return
            known = {r["id"]: r for r in fetch_models()}
            if known and want not in known:
                near = [k for k in known if want.lower() in k.lower()][:6]
                send(chat_id, "没有这个模型：%s%s" % (
                    want, "\n相近的：\n" + "\n".join(near) if near else "\n发 /模型 看列表。"))
                return
            send(chat_id, "试一下 %s …" % want)
            ok, why = apply_choice(model=want)
            if ok:
                card_create(chat_id, model_card())
            else:
                send(chat_id, why)
            return

        if text in ("/思考", "/effort", "/思考强度"):
            card_create(chat_id, effort_card())
            return

        m = re.match(r"^/(?:思考|effort)\s+(.+)$", text, re.S)
        if m:
            want = m.group(1).strip().lower()
            alias = {"自动": "auto", "auto": "auto", "自动挡": "auto",
                     "关": "off", "关闭": "off", "off": "off",
                     "低": "low", "low": "low",
                     "高": "high", "high": "high",
                     "最高": "max", "max": "max"}
            want = alias.get(want, want)
            if want not in EFFORTS:
                send(chat_id, "reasoningEffort 只有 %s 这几档。" % " / ".join(EFFORTS))
                return
            send(chat_id, "试一下 %s …" % want)
            ok, why = apply_choice(effort=want)
            if ok:
                card_create(chat_id, effort_card())
            else:
                send(chat_id, why)
            return

        if text in ("/whoami", "/id", "whoami"):
            cwd = cur_cwd(sender)
            send(
                chat_id,
                "你的 open_id：%s\n名字：%s\n白名单：%s\n当前项目：%s\n会话：%s"
                % (
                    sender,
                    who_name(sender),
                    "在" if allowed(sender) else "不在",
                    cwd,
                    STATE["sessions"].get(sess_key(sender, cwd), "（还没建）"),
                ),
            )
            return

        m = re.match(r"^/name\s+(.+)$", text, re.S)
        if m:
            STATE["users"].setdefault(sender, {})["name"] = m.group(1).strip()[:24]
            save_state()
            send(chat_id, "好，以后日报里叫你 %s。" % who_name(sender))
            return

        m = re.match(r"^/(mention|要@|免@)\s*(on|off|开|关)?$", text)
        if m:
            cur = bool(CONF.get("group_require_mention"))
            val = (m.group(2) or "").strip().lower()
            if val in ("on", "开"):
                cur = True
            elif val in ("off", "关"):
                cur = False
            else:
                cur = not cur
            CONF["group_require_mention"] = cur
            save_conf()
            if cur:
                send(chat_id, "好，群里以后要 @ 我才干活。"
                              "图片消息带不了 @，会先收着，等你 @ 一句再挂上去。")
            else:
                send(chat_id, "好，群里不用 @ 了，直接说话就行（发图也一样）。")
            return

        if text in ("/status", "/状态"):
            mode = "要 @ 才响应" if CONF.get("group_require_mention") else "不用 @ 也响应"
            cur_model = CONF.get("model") or ""
            head = (
                task_brief(sender)
                + "\n群里：%s（/要@ /免@ 切换）" % mode
                + "\n脑子：%s · %s（/模型 /思考 换）" % (
                    _model_label(cur_model) if cur_model else "跟 profile 默认走",
                    _effort_line(),
                )
                + "\n\n"
            )
            send(chat_id, head + do_status())
            return

        if text in ("/ls", "/projects", "/项目"):
            root = CONF["agent_root"]
            code, out = run_agent(
                "root=%s; for d in \"$root\"/*/; do [ -d \"$d\" ] || continue; "
                "n=$(basename \"$d\"); sz=$(du -sh \"$d\" 2>/dev/null | cut -f1); "
                "fc=$(find \"$d\" -type f 2>/dev/null | wc -l); echo \"$n|$sz|$fc\"; done"
                % shlex.quote(root),
                timeout=90,
            )
            if code != 0:
                send(chat_id, "列不出来（exit=%d）：%s" % (code, out[:400]))
                return
            here = cur_cwd(sender)
            lines = ["agent 上的项目（%s）：" % root]
            rows = [ln.split("|") for ln in out.splitlines() if ln.count("|") == 2]
            if not rows:
                lines.append("  （一个都没有）")
            for n, sz, fc in sorted(rows):
                if n in ("lost+found",):
                    continue
                mark = "▶" if here.rstrip("/").endswith("/" + n) else " "
                lines.append("%s %s  %s  %s 个文件" % (mark, n, sz, fc.strip()))
            lines.append("")
            lines.append("当前：%s" % here)
            lines.append("切换：/cd <项目名>；每个项目各有一份 DSH 记忆。")
            deliver(chat_id, "\n".join(lines))
            return

        m = re.match(r"^/cd\s+(.+)$", text, re.S)
        if m:
            name = m.group(1).strip().strip("\"'").rstrip("/")
            base = CONF["agent_root"].rstrip("/")
            target = name if name.startswith("/") else base + "/" + name
            code, out = run_agent(
                "test -d %s && echo OK || echo NO" % shlex.quote(target), timeout=25
            )
            if "OK" not in out:
                send(chat_id, "没有这个目录：%s\n先 /ls 看一眼。" % target)
                return
            STATE["cwd"][sender] = target
            save_state()
            sid = STATE["sessions"].get(sess_key(sender, target))
            send(chat_id, "切到「%s」。%s" % (
                target.rstrip("/").rsplit("/", 1)[-1],
                "这个项目有旧记忆，接着用。" if sid else "这个目录下第一句话会新开记忆。"))
            log.info("cd open_id=%s -> %s", sender, target)
            return

        if text in ("/queue", "/q", "/排队"):
            q = QUEUES.get(sender) or collections.deque()
            cur = RUNNING.get(sender)
            lines = []
            if cur:
                lines.append("正在跑：%s（%s）" % (
                    cur.text[:60], cur.cwd.rstrip("/").rsplit("/", 1)[-1]))
            else:
                lines.append("当前没有在跑的任务。")
            if q:
                lines.append("排队 %d 个：" % len(q))
                for i, it in enumerate(list(q)[:10], 1):
                    lines.append("  %d) %s" % (i, it["text"][:50]))
                if len(q) > 10:
                    lines.append("  …还有 %d 个" % (len(q) - 10))
            else:
                lines.append("队列是空的。")
            send(chat_id, "\n".join(lines))
            return

        if text in ("/清队", "/clearq", "/clearqueue"):
            q = QUEUES.get(sender)
            n = len(q) if q else 0
            if q:
                q.clear()
            send(chat_id, "已清掉 %d 个排队任务。" % n if n else "队列本来就是空的。")
            return

        if text in ("/new", "/reset", "/重置", "/新"):
            keys = [k for k in list(STATE["sessions"]) if k == sender or k.startswith(sender + "|")]
            for k in keys:
                STATE["sessions"].pop(k, None)
            save_state()
            send(chat_id, "记忆清空了（%d 份），下一条从头开始。" % len(keys))
            return

        if text in ("/cost", "/额度"):
            send(chat_id, "\n".join(usage_lines()))
            return

        m = re.match(r"^/(agent|pve)\s+(.+)$", text, re.S)
        if m:
            target, command = m.group(1), m.group(2).strip()
            hit = is_dangerous(command)
            if hit:
                if target == "agent":
                    ask_approval(sender, chat_id, "shell",
                                 {"target": target, "command": command, "label": command[:60]},
                                 "在 %s 上执行含「%s」的命令" % (target, hit), command)
                else:
                    ask_approval(sender, chat_id, "shell",
                                 {"target": target, "command": command, "label": command[:60]},
                                 "在 %s 上执行含「%s」的命令" % (target, hit), command)
                return
            send(chat_id, "▶ 在 %s 执行：%s" % (target, command))
            t0 = time.time()
            code, out = run_agent(command) if target == "agent" else run_pve(command)
            deliver(chat_id, "✔ %s 完成（%.1fs，exit=%d）\n%s" % (target, time.time() - t0, code, out))
            return

        # 不认得的斜杠命令不要当成任务丢给 DSH（它会把 /xxx 当普通文字瞎猜）
        if re.match(r"^/[A-Za-z\u4e00-\u9fff]+$", text) and len(text) <= 12:
            send(chat_id, "没这个命令：%s\n看看 /help，或者直接说要做什么。" % text)
            return

        # ⑨⑩ 其余全部交给 DSH（群里也先给 DSH 一家）
        pending_task(sender, chat_id, text, label=label)

    except Exception as e:
        log.exception("handle error")
        try:
            send(data.event.message.chat_id, "内部错误：%s" % e)
        except Exception:
            pass


def mark_ask_answered(message_id, answer_text, by_open_id=""):
    """用户点了提问卡的按钮之后，把那张卡改成「已回答」，别让它停在可点状态。"""
    if not message_id:
        return
    card = {
        "config": {"wide_screen_mode": True, "update_multi": True},
        "header": {
            "template": "green",
            "title": {"tag": "plain_text", "content": "✅ 已回答"},
        },
        "elements": [
            {"tag": "div", "text": {"tag": "lark_md", "content": "**%s**" % answer_text[:300]}},
            {
                "tag": "note",
                "elements": [
                    {"tag": "plain_text", "content": "由 %s 选择 · %s"
                     % (by_open_id[-8:] if by_open_id else "某人", datetime.now().strftime("%H:%M:%S"))}
                ],
            },
        ],
    }
    try:
        body = (
            PatchMessageRequestBody.builder()
            .content(json.dumps(card, ensure_ascii=False))
            .build()
        )
        r = client.im.v1.message.patch(
            PatchMessageRequest.builder().message_id(message_id).request_body(body).build()
        )
        if not r.success():
            log.warning("更新提问卡片失败 code=%s msg=%s", r.code, r.msg)
    except Exception:
        log.exception("更新提问卡片异常")


def _do_switch(act, value, chat_id, message_id):
    """卡片按钮里的切换动作：真跑一次验证，成功就原地刷新那张卡。"""
    try:
        if act == "model_all":
            if chat_id:
                deliver(chat_id, models_text())
            return
        if act == "set_model":
            if not value:
                return
            ok, why = apply_choice(model=value)
            card = model_card()
        else:
            if value not in EFFORTS:
                if chat_id:
                    send(chat_id, "reasoningEffort 只有 %s 这几档。" % " / ".join(EFFORTS))
                return
            ok, why = apply_choice(effort=value)
            card = effort_card()
        if not chat_id:
            return
        if ok:
            if message_id:
                card_patch(message_id, card)
            else:
                card_create(chat_id, card)
        else:
            send(chat_id, why)
    except Exception:
        log.exception("切换模型/思考强度失败 act=%s v=%s", act, value)


def on_card_action(data):
    """卡片按钮回调（长连接）。

    两类按钮：
      - 审批卡：value={act: approve|cancel, tok}
      - dsh-feishu 的提问卡：value={act: 'answer', token, answer}
        后者转给网关，让 MCP 那边阻塞中的 feishu_ask 立刻拿到答案。
    """
    try:
        ev = data.event
        val = (ev.action.value or {}) if getattr(ev, "action", None) else {}
        # 统一用 token 字段；tok 是历史命名的兼容读法（10 分钟内已发出的旧卡片还在）
        tok = str(val.get("token") or val.get("tok") or "")
        act = str(val.get("act") or "")
        by = ""
        try:
            by = ev.operator.open_id
        except Exception:
            pass

        # dsh-feishu 提问卡：转发即可，本进程不需要理解语义
        ask_token = str(val.get("token") or "")
        if act == "answer" and ask_token:
            answer_text = str(val.get("answer") or "")
            payload = {"token": ask_token, "text": answer_text, "via": "button"}
            if by:
                payload["by"] = by
            r = gateway_post("/answer", payload)
            accepted = bool(r and r.get("accepted"))
            log.info("按钮答案已转发 token=%s accepted=%s", ask_token, accepted)

            # 给点反馈：接受了的就把卡片改成「已回答」，重复点也不至于让人以为没反应
            try:
                ctx_obj = getattr(ev, "context", None)
                mid = getattr(ctx_obj, "open_message_id", "") if ctx_obj else ""
                if mid:
                    if accepted:
                        mark_ask_answered(mid, answer_text, by)
                    else:
                        log.info("token %s 已作答，忽略重复点击", ask_token)
            except Exception:
                log.exception("处理提问卡反馈失败")
            return _build_card_response()

        # 模型 / 思考强度卡片：切换要真跑一次验证（十几秒），别堵住回调的 3 秒窗口
        if act in ("set_model", "set_effort", "model_all"):
            ctx_obj = getattr(ev, "context", None)
            chat_id = getattr(ctx_obj, "open_chat_id", "") if ctx_obj else ""
            mid = getattr(ctx_obj, "open_message_id", "") if ctx_obj else ""
            threading.Thread(
                target=_do_switch,
                args=(act, str(val.get("v") or ""), chat_id, mid),
                daemon=True,
            ).start()
            return _build_card_response()

        if tok and act:
            resolve_approval(tok, act, by)
    except Exception:
        log.exception("card action")
    return _build_card_response()


def _build_card_response():
    try:
        from lark_oapi.event.callback.model.p2_card_action_trigger import (
            P2CardActionTriggerResponse,
        )

        return P2CardActionTriggerResponse({})
    except Exception:
        log.exception("构造卡片回调响应失败")
        return None


def main():
    if not APP_ID or not APP_SECRET:
        raise SystemExit("缺少 FEISHU_APP_ID / FEISHU_APP_SECRET")
    log.info("starting, app_id=%s conf=%s", APP_ID, json.dumps(
        {k: v for k, v in CONF.items() if k != "allowed_open_ids"} | {"whitelist": len(CONF.get("allowed_open_ids") or [])},
        ensure_ascii=False,
    ))
    fetch_bot_open_id()
    # 启动时把「当前模型 × 四档」四份 overlay 铺好，之后每条任务只是挑一份用
    try:
        push_model_override()
    except Exception:
        log.exception("启动时写模型覆盖失败，先按 profile 默认跑")
    threading.Thread(target=report_loop, daemon=True).start()

    builder = lark.EventDispatcherHandler.builder("", "").register_p2_im_message_receive_v1(handle)
    try:
        builder = builder.register_p2_card_action_trigger(on_card_action)
        log.info("卡片按钮回调已注册")
    except Exception:
        log.exception("卡片回调注册失败，只能走文字「批/拒」")
    handler = builder.build()

    ws = lark.ws.Client(APP_ID, APP_SECRET, event_handler=handler, log_level=lark.LogLevel.INFO)
    ws.start()


if __name__ == "__main__":
    main()
