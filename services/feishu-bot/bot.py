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
import uuid
import collections
import io
import json
import logging
import os
import re
import shlex
import subprocess
import sys
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

# 通道客户端（同目录 channel.py）：把消息投给 agent 机上 dsh-feishu-channel
# 插件的原生存件箱。文件不在 / 插件没开时，channel_mod 为 None，全走老路径。
sys.path.insert(0, str(Path(__file__).resolve().parent))
try:
    import channel as channel_mod  # noqa: E402
except Exception:  # pragma: no cover - 缺文件不影响老路径
    channel_mod = None

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
    # 同时能跑几个人的任务。同一个人永远串行（会话要连续），不同的人各自并行；
    # 总并发受限于 agent 机的内存和模型额度，超了就排队。
    "max_concurrent": 3,
    # 模型与思考强度：写在这里而不是改 agent 上的 profile，--patch 单次生效、随时可退。
    # model 留空 = 用 profile 自己的默认；reasoning_effort 取 auto/off/low/high/max
    # （auto = 每条任务按内容现算一档，进度卡上写明挑了哪档）。
    "model": "deepseek-v4.1-flash",
    "reasoning_effort": "auto",
    "model_override_path": "/home/agent/.cache/feishu/model-override.yml",
    "agent_host": "192.168.1.205",
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
    "gateway_url": "http://192.168.1.205:18642",
    "gateway_token": "",
    # 飞书原生通道（dsh-feishu-channel 插件）：把消息投进常驻 agent 的原生
    # 收件箱（next-turn / next-step），而不是每条消息 spawn 一个 dsh-task。
    # off = 完全走老路径（回滚开关）；插件不可达时也会自动退回老路径，消息不丢。

    "channel_url": "http://192.168.1.205:8788",
    "channel_token": "",
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

跑着的时候还能补一句（仅通道模式；/状态 里的「跑法」写着当前是哪种）：
  直接说话 = 插话，下一步就生效    /下一轮 xxx = 排到下一轮再说
  /备注 xxx = 只补背景不打断       卡片上直接有 停 / 撤回 / 清队 按钮
/额度    模型用量还剩多少

管记忆与项目：
/work    当前工作区是哪个目录、多少文件、有没有记忆
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
    st.setdefault("channel_watch_keys", [])
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
BOT_NAME = ""            # 机器人自己叫什么（"G2 Agent"），用来认手打的 @


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
        global BOT_NAME
        BOT_NAME = (info.get("bot") or {}).get("app_name", "") or ""
        log.info("bot open_id=%s name=%s", BOT_OPEN_ID, BOT_NAME)
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


def send(chat_id, text, msg_type="text", at=None):
    """at 传 open_id 就在正文前 @ 他。

    群里常年静音，不 @ 等于没回——飞书只对 @ 和回复给通知，所以凡是「回某个人」
    的地方都要带 at。机器人自己的日报之类主动推送就别带。
    """
    if at and msg_type == "text":
        text = '<at user_id="%s"></at> %s' % (at, text)
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


def deliver(chat_id, text, title="结果", at=None):
    """⑫ 超过 max_inline_lines 行或 4000 字 → 贴成文件。"""
    lines = text.count("\n") + 1
    limit_lines = int(CONF["max_inline_lines"])
    if lines <= limit_lines and len(text) <= 4000:
        return send(chat_id, text, at=at)
    name = "%s-%s.txt" % (title, datetime.now().strftime("%Y%m%d-%H%M%S"))
    ok, why = send_file(chat_id, name, text.encode("utf-8"))
    if ok:
        send(chat_id, "（%d 行，已贴成文件 %s）" % (lines, name), at=at)
        return True
    head = "\n".join(text.splitlines()[:limit_lines])
    send(
        chat_id,
        "（%d 行，本该贴成文件，但%s；先给前 %d 行）\n%s\n…"
        % (lines, why, limit_lines, head),
        at=at,
    )
    return False


# ─────────────────────── 收附件（图片 / 文件） ───────────────────────
#
# 飞书消息里的图片/文件不在事件体里，只有一个 image_key / file_key，
# 得再用 tenant_access_token 去 /im/v1/messages/{mid}/resources/{key} 取字节。
# 取回来之后落进 agent 的工作目录（沙箱只认 cwd 内），最后把相对路径写进任务描述，
# 让 agent 自己用 read_image / 读写工具去看——headless CLI 没有 --image 参数。

ATTACH_TYPES = ("image", "file", "media", "audio")
STASH_TTL = 900           # 群里先收着的图，15 分钟内 @ 一句还能挂上


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


# ssh 到 agent 的每次附件传输都是一条独立连接，sshd 默认 MaxStartups 10:30:100 ——
# 未认证连接超过 10 条开始随机丢弃，20 张图同时冲进去实测约 15% 被
# "kex_exchange_identification: Connection reset by peer" 拒掉。限到 4 条并发。
_PUSH_SEM = threading.BoundedSemaphore(4)


def push_attachment(cwd, filename, data):
    """把附件写到 agent 的工作目录里。字节以 base64 过 ssh，避免二进制走文本管道的坑。"""
    sub = (CONF.get("attachment_dir") or ".feishu-inbox").strip("/")
    target = "%s/%s" % (cwd.rstrip("/"), sub)
    path = "%s/%s" % (target, filename)
    cmd = ("mkdir -p %s && base64 -d > %s && stat -c '%%s' %s"
           % (shlex.quote(target), shlex.quote(path), shlex.quote(path)))
    payload = base64.b64encode(data).decode("ascii")
    code, out = 1, ""
    for attempt in range(1, 4):
        _PUSH_SEM.acquire()
        try:
            code, out = run_remote(
                CONF["agent_host"], CONF["agent_user"], CONF["agent_key"],
                cmd, timeout=180, stdin_text=payload,
            )
        finally:
            _PUSH_SEM.release()
        if code == 0:
            break
        # MaxStartups 是随机丢弃，重试大概率就过了
        log.warning("附件写入第 %d 次失败（exit=%d）：%s", attempt, code, out[:120])
        time.sleep(1.2 * attempt)
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
        name = (content.get("file_name") or "").strip() or mt
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
        # 时间戳只到秒，连发时同一秒内的图会拿到同一个名字、后到覆盖先到
        # （实测 20 张并发只落地 2 个文件）。名字本身就带的（如 screenshot.png）
        # 重复发也会撞，所以一律追加随机后缀。
        base = name or ("img" if att["kind"] == "image" else "file")
        stem = "%s-%s-%s" % (base, stamp, uuid.uuid4().hex[:6])
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


# ─────────────────── 引用/回复：把「这个」还原出来 ───────────────────

def fetch_message(message_id):
    """按 message_id 取一条消息本体。用来还原「他回复的那条」。"""
    tok = _tenant_token()
    if not tok:
        return None, "取 tenant_access_token 失败"
    url = "https://open.feishu.cn/open-apis/im/v1/messages/%s" % message_id
    try:
        req = urllib.request.Request(url, headers={"Authorization": "Bearer " + tok})
        with urllib.request.urlopen(req, timeout=20) as r:
            data = json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = e.read()[:300].decode("utf-8", "replace")
        except Exception:
            pass
        return None, "HTTP %s %s" % (e.code, detail)
    except Exception as e:
        return None, str(e)
    items = (data.get("data") or {}).get("items") or []
    return (items[0] if items else None), ""


def _flatten_post(content):
    """富文本（post）消息 → 纯文本。形状也不稳定，一律先判类型再钻。"""
    if not isinstance(content, dict):
        return ""
    out = []
    title = content.get("title")
    if isinstance(title, str) and title.strip():
        out.append(title.strip())
    for para in content.get("content") or []:
        seg = []
        for node in para or []:
            if not isinstance(node, dict):
                continue
            tag = node.get("tag")
            if tag in ("text", "a", "at"):
                seg.append(node.get("text") or node.get("href") or "")
            elif tag == "img":
                seg.append("[图片]")
            elif tag == "code_block":
                seg.append(node.get("text") or "")
        if seg:
            out.append("".join(seg))
    return "\n".join(out).strip()


def _card_texts(node, out, depth=0):
    """把卡片里任意层级的文字都刨出来。

    卡片元素形状不固定：div 带 text、note 带 elements、column_set 带 columns、
    columns 里又是 elements……按字段硬猜一定会在某个真实卡片上炸（'list' object
    has no attribute 'get'），所以这里只认「是不是 dict/list」再往下钻。
    """
    if depth > 8:
        return
    if isinstance(node, str):
        if node.strip():
            out.append(node.strip())
        return
    if isinstance(node, list):
        for it in node:
            _card_texts(it, out, depth + 1)
        return
    if not isinstance(node, dict):
        return
    txt = node.get("content")
    if isinstance(txt, str) and txt.strip():
        out.append(txt.strip())
    for key in ("text", "header", "elements", "columns", "fields", "title", "items"):
        if key not in node:
            continue
        val = node[key]
        # 同一个键在两种卡片格式里含义不同：标准卡片 {"text":{"content":…}}，
        # 简易卡片 {"tag":"text","text":"正文"} 直接就是字符串。
        if isinstance(val, str):
            if val.strip():
                out.append(val.strip())
        else:
            _card_texts(val, out, depth + 1)


def _flatten_card(content):
    """卡片消息 → 纯文本（就是机器人自己发过的那张结果卡）。"""
    if not isinstance(content, dict):
        return ""
    out = []
    _card_texts(content.get("title"), out)
    _card_texts(content.get("header"), out)
    _card_texts(content.get("elements"), out)
    # 去重但保序：header 里的标题常常和第一段重复
    seen = set()
    uniq = []
    for t in out:
        if t in seen:
            continue
        seen.add(t)
        uniq.append(t)
    return "\n".join(uniq).strip()


def resolve_quote(chat_id, open_id, parent_id):
    """把「他引用的那条消息」还原成任务描述的一部分。

    飞书事件只带 parent_id，内容要再查一次；图片还得单独下载落盘，否则模型只看到
    「你重新做这个」，压根不知道「这个」是什么，只能接着当前上下文瞎猜。
    返回 (附加说明, 附件描述或 None)。
    """
    item, err = fetch_message(parent_id)
    if not item:
        log.info("取被引用消息失败 mid=%s err=%s", parent_id, err)
        # 取不到是谁发的，就当「在回别人的消息」——保守一点，别插嘴。
        return "", None, UNKNOWN_SENDER

    mt = item.get("msg_type") or ""
    try:
        content = json.loads((item.get("body") or {}).get("content") or "{}")
    except Exception:
        content = {}
    by_oid = ((item.get("sender") or {}).get("id")) or ""
    parent_sender = by_oid
    by = who_name(by_oid) if by_oid else ""
    if by.startswith("…"):
        by = "别人"          # 还没记住名字，别把 open_id 尾巴露在提示里
    who = "（%s 发的）" % by if by else ""

    # 引用里带图/文件：当成这次任务的附件，跟直接发图走同一条路
    if mt == "image":
        key = content.get("image_key") or ""
        if key:
            return ("【他引用了%s的一条图片消息，下面这张就是】\n\n【他这句话】" % who,
                    {"kind": "image", "rtype": "image", "key": key, "name": "",
                     "_mid": parent_id}, parent_sender)
        return "【他引用了一条图片消息，但取不到图】\n\n【他这句话】", None, parent_sender
    if mt in ("file", "media", "audio"):
        key = content.get("file_key") or ""
        name = (content.get("file_name") or "").strip()
        if key:
            return ("【他引用了%s的一个文件，下面这个就是】\n\n【他这句话】" % who,
                    {"kind": "file", "rtype": "file", "key": key, "name": name,
                     "_mid": parent_id}, parent_sender)
        return "【他引用了一个文件消息，但取不到文件】\n\n【他这句话】", None, parent_sender

    if mt == "text":
        body = (content.get("text") or "").strip()
    elif mt == "post":
        body = _flatten_post(content)
    elif mt == "interactive":
        body = _flatten_card(content)
    elif mt == "sticker":
        body = "[表情包]"
    else:
        body = "[一条 %s 消息]" % mt
    body = body[:1200]
    if not body:
        return "", None, parent_sender
    return "【他引用了%s的这条消息】\n%s\n\n【他这句话】\n" % (who, body), None, parent_sender


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
                        _short_cwd(cur.cwd)))
    else:
        lines.append("现在没在跑。")
    busy = _running_count()
    if busy:
        lines.append("（全局 %d 路在跑，上限 %d）"
                     % (busy, int(CONF.get("max_concurrent") or 3)))
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


def _recent_deliver(limit=5):
    """列 work/deliver 下最近交付的几个文件。

    交付物统一放这里的好处是「刚做出来的东西在哪」不用问 —— /状态 直接能看到，
    用户也不用在项目目录里翻。
    """
    d = (CONF.get("agent_root") or "/home/agent/work").rstrip("/") + "/deliver"
    code, out = run_agent(
        'd=%s; [ -d "$d" ] || exit 0; '
        'ls -t "$d" 2>/dev/null | head -n %d | while read -r f; do '
        'sz=$(du -h "$d/$f" 2>/dev/null | cut -f1); echo "$f|$sz"; done'
        % (shlex.quote(d), int(limit)),
        timeout=40,
    )
    if code != 0:
        return []
    rows = []
    for ln in (out or "").splitlines():
        if "|" in ln:
            name, sz = ln.split("|", 1)
            if name.strip():
                rows.append((name.strip(), sz.strip()))
    return rows


def do_status():
    a = run_pve("date '+%F %T'; uptime | sed 's/^ *//'; free -m | sed -n 2p; df -h / | tail -1")
    b = run_agent(
        "date '+%F %T'; uptime | sed 's/^ *//'; free -m | sed -n 2p; "
        "df -h / /home/agent/work 2>/dev/null | tail -n +2; "
        "systemctl is-active dsh-web 2>/dev/null | sed 's/^/dsh-web: /'"
    )
    mode = "通道模式（能中途插话，卡片由插件画）" if channel_on() else "老路径（一句一张卡，不能插话）"
    try:
        recent = _recent_deliver()
    except Exception:
        recent = []
    if recent:
        tail = "\n\n最近交付（%s/deliver）：\n%s" % (
            (CONF.get("agent_root") or "").rstrip("/"),
            "\n".join("  %s　%s" % (n, s) for n, s in recent),
        )
    else:
        tail = "\n\n最近交付：deliver 目录还是空的（让它做点东西就会出现在这里）。"
    return "【PVE 宿主 %s】\n%s\n\n【agent 工作站 %s】\n%s\n\n跑法：%s%s" % (
        CONF.get("pve_label") or "PVE",
        a[1],
        CONF.get("agent_host") or "agent",
        b[1],
        mode,
        tail,
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
    "如果他明确让你停手、别管、不用你做（「你别乱搞」「这不是你要管的」「停下」「别弄了」）："
    "只回一句「好，停了」，不辩解、不继续执行、不反问。\n"
    "如果信息足够：直接把事做完，最后给出简短结论（不超过 20 行）。\n"
    "调用工具时，description 字段用中文写、不超过 12 个字（它会显示在用户的进度卡上）。\n\n"
    "【交付文件】要交付 docx/pdf/图片/表格/压缩包这类文件时：\n"
    "  1) 先把文件做好、落在工作目录里；\n"
    "  2) 直接执行 pushfile <文件绝对路径> \"<一句话说明>\"（已在 PATH 里，不要去找它）\n"
    "     —— 会把文件发到当前飞书会话，chat_id 不用你管；\n"
    "  3) 回复里只写「已发送：文件名（大小）」这样的结论。\n"
    "不要用工作区路径代替文件（用户拿不到），也不要把整篇内容粘贴出来代替文件。\n"
    "pushfile 支持多个文件：pushfile a.docx b.pdf \"作业打包\"。\n\n"
    "【飞书能力】你有一个飞书 MCP，工具名以 mcp__feishu__ 开头（共 43 个）。常用的：\n"
    "  feishu_recent            读最近消息（图片/文件消息也在里面）\n"
    "  feishu_chats / members   列机器人所在的群 / 读群成员\n"
    "  feishu_send_text / send_card / send_file / send_image / reply   往外发\n"
    "  feishu_recall            撤回自己发的消息；删群里的旧文件也靠它（文件挂在消息上）\n"
    "  feishu_chat_files        列群里的文件（飞书没有群文件列表接口，它是翻消息筛出来的，\n"
    "                           返回 message_id，可以直接接着 feishu_recall 删）\n"
    "  feishu_forward / pin / merge_forward     转发、置顶、把多条合并成一份记录转发\n"
    "  feishu_reaction          给消息加表情回应（最轻的「收到」），也能看谁回应了什么\n"
    "  feishu_chat_announcement 读/改群公告（要群主或管理员）\n"
    "  feishu_chat_update / create / dissolve   改群名和权限、建群、解散群\n"
    "  feishu_file_delete       删云空间里的文件（参数是 file_token，不是消息的 file_key）\n"
    "  feishu_bitable_*         多维表格：列表/字段/记录/新增/更新/删除\n"
    "  feishu_sheet_create / read / meta / write  电子表格：新建、按区间读值、看工作表、写值/追加行\n"
    "  feishu_doc_read / doc_blocks / doc_create / doc_append  文档：读正文、读分块、新建、往末尾追加段落\n"
    "  feishu_permission_member 云文档协作者：加人/看权限/移除\n"
    "  feishu_wiki_spaces / wiki_node           知识库\n"
    "  feishu_user_lookup       邮箱/手机号查 open_id\n"
    "不确定自己有没有某个能力时，先看工具清单再回答，别直接说「我没有接口」；\n"
    "要发本地文件一律用 pushfile，MCP 传不了本地文件。\n\n"
    "【交付物放哪】要给他的文件一律先写到 work 根目录下的 deliver/（不存在就 mkdir -p），"
    "文件名用他一眼能看懂的中文名，然后 pushfile 那个绝对路径。"
    "别把成品丢在项目目录深处——他要的是「刚做出来的东西在哪」，不是自己去翻。\n\n"
    "【图片与文件】他发来的图片/文件已经落到工作目录里（默认 .feishu-inbox/ 下），"
    "消息里给的是相对路径。图片必须用 read_image 真的打开看（能看图，别凭文件名猜），"
    "文件用读写工具打开；原件保留，不要删。\n"
    "用户消息：{text}"
)

RUNNING = {}   # open_id -> Task
QUEUES = {}    # open_id -> deque(dict)  同一个人排队（会话要连续，不能并行）
# 跨用户并行：不同的人各跑各的，互不挡。一个人仍然串行——同一份 session 两个进程同时写
# 会打架，所以「同人排队、跨人并行」，总并发由 max_concurrent 兜住（agent 机不是无限的）。
_ACTIVE = [0]
_ACTIVE_LOCK = threading.Lock()


def _acquire_slot():
    with _ACTIVE_LOCK:
        if _ACTIVE[0] >= int(CONF.get("max_concurrent") or 3):
            return False
        _ACTIVE[0] += 1
        return True


def _release_slot():
    with _ACTIVE_LOCK:
        _ACTIVE[0] = max(0, _ACTIVE[0] - 1)


def _at_for(chat_id, open_id):
    """私聊不用 @（本来就有通知），群里才 @ 他。"""
    types_ = STATE.get("chat_types") or {}
    return open_id if types_.get(chat_id) in ("group", "topic") else None


def _running_count():
    with _ACTIVE_LOCK:
        return _ACTIVE[0]


def cur_cwd(open_id):
    return STATE["cwd"].get(open_id) or CONF["agent_cwd"]


def _short_cwd(cwd):
    """工作区显示：去掉 agent_root 前缀，保留层级。

    根目录显示 work，子目录显示 work/negative film —— 一眼能看出是哪个目录，
    比只留最后一段（negative film）清楚，也不会像绝对路径那样把脚注撑爆。
    """
    root = (CONF.get("agent_root") or "").rstrip("/")
    p = (cwd or "").rstrip("/")
    if not p:
        return "?"
    name = root.rsplit("/", 1)[-1] or root
    if root and p == root:
        return name
    if root and p.startswith(root + "/"):
        return name + p[len(root):]
    return p


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

# 口语版「停手」。命中且句子很短时，不派给 agent——派下去它就会真的「处理」一遍，
# 既插嘴又白烧一次额度。宁可少接一句，也不要乱做。
STOP_WORDS = (
    "别乱搞", "不要乱搞", "别弄了", "别做了", "不用做了", "别管了", "不用你管",
    "这不是你要管的", "不是让你做", "没让你做", "停手", "停下",
)

# 引用了某条消息但查不出是谁发的（消息太老、被删、id 无效）时用这个哨兵，
# 让「这句是在跟别人说话」的判定走保守分支。
UNKNOWN_SENDER = "?"

# agent 自己交代「我这轮没有工具」时的特征句。命中就在回答后面补一句怎么办：
# 用户不该为了「它为什么啥都干不了」去翻日志。
_NO_TOOL_HINTS = (
    "工具链出问题", "工具链出问题了", "工具没加载", "工具注册表退化",
    "没有文件系统执行能力", "没有飞书发送通道", "没有执行能力",
    "需要重启一下 G2", "重启一下会话",
)

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
        {"tag": "action", "actions": [
            {"tag": "button", "text": {"tag": "plain_text", "content": "看全部模型"},
             "type": "default", "value": {"act": "model_all"}},
            {"tag": "button", "text": {"tag": "plain_text", "content": "换思考档"},
             "type": "primary", "value": {"act": "open_effort"}},
        ]},
    ]
    return {
        "config": {"wide_screen_mode": True, "update_multi": True},
        "header": {"template": "turquoise", "title": {"tag": "plain_text", "content": "能干什么"}},
        "elements": els,
    }




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


def _at_el(open_id):
    """卡片里 @ 人：飞书卡片 markdown 用 <at id=open_id></at>（和文本消息的写法不同）。"""
    if not open_id:
        return None
    return {"tag": "div", "text": {"tag": "lark_md", "content": "<at id=%s></at>" % open_id}}






















# ─────────────────────────── 通道模式（新路径） ───────────────────────────
#
# 老路径：每条消息 spawn 一个 `dsh-task --json` 子进程 → stdin 一关就再也塞不进去，
#         所以"补充指令"只能排队，队列只活在这个 bot 的内存里，卡片也只有一张静态文本。
# 新路径：把消息投给 agent 机上 dsh-feishu-channel 插件的原生存件箱
#         （next-turn / next-step），由 DSH 自己在轮次边界和 step 边界领取。
#         排队位置、流式文本、轮次号全部读真值，不再是估的。
#
# 2026-11-07：老路径已删除。以前这里是「两条路并存，由 CONF["channel_mode"] 控制，
# 插件不可达时自动退回老路径」——那个开关本身就是个陷阱：它能被静默关掉，
# 关掉之后群里看到的卡片突然退回旧模板，而修新通道的人完全不会知道。
# 现在只有一条路：通道不通就如实报错，不假装还有备胎。

# 只发一个 @ 时，接他上一条说过的话（飞书里很常见：先打字，再补一个 @）
_LAST_MSG = {}          # "chat_id|open_id" -> {"text": str, "ts": float}
_LAST_MSG_TTL = 60      # 秒；超过这个时间就不接了，免得接到风马牛不相及的话

CHANNEL_CARDS = {}          # session key -> 卡片 message_id
_CHANNEL_CARDS_LOCK = threading.Lock()
_CHANNEL_FAILS = {}         # session key -> 连续 PATCH 失败次数
_CHANNEL_RECEIPTS = {}      # (session key, message id) -> receipt reservation
_CHANNEL_GENERATIONS = {}  # session key -> latest receipt reservation

# /插话 = 下一步生效（steer）；/下一轮 = 排到下一轮（followup）；
# /备注 = 只补背景不唤醒（inject）。不写「排队」做别名 —— /排队 是查队列。
INTENT_ALIAS = {
    "steer": "steer", "插话": "steer", "插入": "steer",
    "followup": "followup", "下一轮": "followup",
    "inject": "inject", "背景": "inject", "备注": "inject",
}


def channel_on():
    """通道可用吗（插件装了、客户端拿到了）。

    2026-11-07：老路径已删除，这里不再看 channel_mode ——
    留着那个开关只会让人以为还有第二条路可走。
    插件不在、或者还没握手成功，才算不可用。
    """
    if not channel_mod:
        return False
    return channel_mod.get() is not None


def channel_key_of(msg, chat_id=""):
    """从飞书消息对象算会话键（与插件侧 sessionkey.js 一致）。"""
    if not channel_mod:
        return ""
    thread_id = getattr(msg, "thread_id", "") or ""
    root_id = getattr(msg, "root_id", "") or ""
    tenant = getattr(msg, "tenant_key", "") or "default"
    cid = chat_id or getattr(msg, "chat_id", "") or ""
    return channel_mod.session_key(cid, thread_id, root_id, tenant)


def on_channel_view(view):
    """插件的视图快照 → 一张会自己更新的卡片。

    更新最近一次接单的状态卡；卡片过期或被删后重建。
    """
    if not isinstance(view, dict):
        return
    key = view.get("key") or ""
    chat_id = view.get("chatId") or ""
    card = view.get("card")
    if not key or not card or not chat_id:
        return
    with _CHANNEL_CARDS_LOCK:
        mid = CHANNEL_CARDS.get(key)
        fails = _CHANNEL_FAILS.get(key, 0)
        generation = _CHANNEL_GENERATIONS.get(key)
    if mid and card_patch(mid, card):
        with _CHANNEL_CARDS_LOCK:
            if CHANNEL_CARDS.get(key) == mid and _CHANNEL_GENERATIONS.get(key) == generation:
                _CHANNEL_FAILS[key] = 0
        return
    # 只有连续失败够多次才重建，避免 PATCH 抖动把群里刷成一片新卡片
    with _CHANNEL_CARDS_LOCK:
        if CHANNEL_CARDS.get(key) != mid or _CHANNEL_GENERATIONS.get(key) != generation:
            return
        _CHANNEL_FAILS[key] = fails + 1
        rebuild = (not mid) or fails >= 2
    if not rebuild:
        return
    new_mid = card_create(chat_id, card)
    if new_mid:
        with _CHANNEL_CARDS_LOCK:
            if CHANNEL_CARDS.get(key) != mid or _CHANNEL_GENERATIONS.get(key) != generation:
                return
            CHANNEL_CARDS[key] = new_mid
            _CHANNEL_FAILS[key] = 0
        if mid:
            log.info("通道卡片重建 key=%s %s → %s", key, mid, new_mid)


_MD_LINK = re.compile(r"\[([^\]\n]{1,120})\]\(([^)\s]{1,300})\)")


def _fix_md_links(text):
    """把「点了没反应」的相对路径链接降级成行内代码。

    飞书 lark_md 支持 `[文字](url)`，但对相对路径会照样渲染成可点链接 ——
    点下去什么也不发生，正文还被长路径撑开。只放行真正的 URL。
    """

    def sub(m):
        label, target = m.group(1), m.group(2)
        if re.match(r"^(https?://|mailto:)", target, re.I):
            return m.group(0)
        # 相对路径：留文字，路径本身用代码块显示（看得出是文件，不假装能点）
        if label.strip() == target.strip() or not label.strip():
            return "`%s`" % target
        return "%s（`%s`）" % (label, target)

    return _MD_LINK.sub(sub, text or "")


def build_reply_card(text, reasoning="", effort="auto", turn=0, open_id=""):
    """把 agent 的回答做成卡片。

    为什么必须是卡片：text 类型消息里 `**加粗**`、`# 标题` 这些 markdown 是不渲染的，
    长回答就是一大坨灰底纯文本；卡片用 lark_md 才按 markdown 排版。
    思考过程放 note（小字灰色），不抢正文的位置。
    """
    elements = []
    if open_id:
        elements.append({
            "tag": "div",
            "text": {"tag": "lark_md", "content": "<at id=%s></at>" % open_id},
        })
    elements.append({
        "tag": "div",
        "text": {"tag": "lark_md", "content": _fix_md_links(text)},
    })
    # 思考全文不贴进回答卡片。用户原话：
    #   「莫名其妙的尾部贴上全部思考和过程，又占地方又恶心人」
    # 它已经在状态卡的工具流水里逐条显示（思考 · xxx），这里只留正文。

    bits = []
    if turn:
        bits.append("第 %d 轮" % turn)
    if effort and effort not in ("auto", ""):
        bits.append("思考深度 %s" % effort)

    card = {
        "config": {"wide_screen_mode": True, "update_multi": True},
        "header": {
            "title": {"tag": "plain_text", "content": "✅ 回答"},
            "template": "blue",
        },
        "elements": elements,
    }
    if bits:
        # 「第 N 轮 · 思考深度 high」不进 header.subtitle：飞书会把它拼成标题第二行，
        # 又小又挤，读起来像排版事故（用户评价：「回复卡片…丑」）。放页脚 note。
        card["elements"].append({
            "tag": "note",
            "elements": [{"tag": "plain_text", "content": " · ".join(bits)}],
        })
    return card


def on_channel_reply(frame):
    """agent 的回答正文 → 发到群里。

    视图卡只是状态（在跑 / 空闲 / 排了几个），它永远不含答案。答案走这条：
    插件在 assistant/message 落定后推 `event: reply`，SSE 线程交给这里。
    长回答交给 deliver —— 超过 max_inline_lines 行就自动贴成 txt 文件。
    """
    if not isinstance(frame, dict):
        return
    chat_id = frame.get("chatId") or ""
    text = (frame.get("text") or "").strip()
    if not chat_id or not text:
        return
    open_id = frame.get("openId") or ""
    reasoning = (frame.get("reasoning") or "").strip()
    effort = frame.get("effort") or "auto"
    turn = frame.get("turn") or 0
    # agent 偶尔会「工具没加载全」——它嘴上说没有执行能力 / 没有发送通道，
    # 然后交一份什么都干不了的答复。用户看到的是「它坏了」却说不出怎么办。
    # 这里补一句人话，并给出唯一的自救动作（重开一份会话）。
    if any(w in text for w in _NO_TOOL_HINTS):
        text += (
            "\n\n（这一轮 agent 的工具没加载全，不是你的用法问题。"
            "工作站进程已经重启过；再遇到就发 /new 重开一份会话，工具会重新注册。）"
        )
    try:
        # 卡片有大小上限（约 30 KB），正文太长就别塞了，退回「贴成文件」
        if len(text) > 3000:
            deliver(chat_id, text, title="回答", at=(open_id or None))
        else:
            card = build_reply_card(text, reasoning, effort, turn, open_id)
            if not send_card(chat_id, card):
                # 卡片发失败（比如 markdown 里有非法结构）就退回纯文本，别让回答丢掉
                log.warning("卡片投递失败，退回纯文本 chat=%s", chat_id)
                deliver(chat_id, text, title="回答", at=(open_id or None))
        log.info(
            "通道回答已投递 chat=%s len=%d reasoning=%d effort=%s",
            chat_id, len(text), len(reasoning), effort,
        )
    except Exception:
        log.exception("通道回答投递失败 chat=%s", chat_id)


def watch_channel(key):
    if not channel_on() or not key:
        return
    try:
        with _LOCK:
            keys = STATE.setdefault("channel_watch_keys", [])
            if key not in keys:
                keys.append(key)
                try:
                    _write_json(STATE_PATH, STATE)
                except OSError:
                    keys.remove(key)
                    log.exception("订阅记录保存失败，仍尝试接收回答")
        channel_mod.get().watch(key, on_channel_view, on_channel_reply)
    except Exception:
        log.exception("订阅通道视图失败 key=%s", key)


def reply_undelivered(open_id, chat_id, err):
    """消息没送到 agent 时，必须回一句人话。

    以前这里只写一行 log，用户在飞书那头什么也看不到 —— 表现就是
    「AI 不理我」，而且他再发一遍很可能撞同一个错。
    """
    why = str(err or "").strip()
    if "已绑定目录" in why:
        tip = "这个会话绑在别的目录上，发 /new 开一份新的就能接着用"
    elif "Connection refused" in why or "URLError" in why:
        tip = "工作站那边的通道没起来，稍等一下再发，或者发 /状态 看看"
    else:
        tip = "再发一次通常就好；一直这样就发 /状态 看看"
    try:
        send(chat_id, "⚠️ 这条没送到 agent（%s）。%s" % (why[:120] or "未知原因", tip),
             at=_at_for(chat_id, open_id))
    except Exception:
        log.exception("连「没送到」都回不了 chat=%s", chat_id)


def ack_channel_message(key, chat_id, result, message_id="", recovered=False):
    """Put receipt/progress next to this instruction, not on an old chat card."""
    if not result.get("ok") or (result.get("duplicate") and not recovered):
        return
    reservation = object()
    receipt_key = (key, message_id)
    with _CHANNEL_CARDS_LOCK:
        if message_id and receipt_key in _CHANNEL_RECEIPTS:
            return
        if message_id:
            _CHANNEL_RECEIPTS[receipt_key] = reservation
            if len(_CHANNEL_RECEIPTS) > 1000:
                del _CHANNEL_RECEIPTS[next(iter(_CHANNEL_RECEIPTS))]
        _CHANNEL_GENERATIONS[key] = reservation
    intent = result.get("intent") or "followup"
    text = {
        "steer": "补充已收到，会在下一步处理。",
        "inject": "上下文已收到；不启动新任务。",
    }.get(intent, "已收到；排队和执行进度会在这里更新。")
    card = {
        "config": {"wide_screen_mode": True, "update_multi": True},
        "header": {"title": {"tag": "plain_text", "content": "已接收"}, "template": "blue"},
        "elements": [{"tag": "div", "text": {"tag": "lark_md", "content": text}}],
    }
    # Do not hold the shared lock over a network call.
    try:
        mid = card_create(chat_id, card)
        if mid:
            with _CHANNEL_CARDS_LOCK:
                if _CHANNEL_GENERATIONS.get(key) == reservation:
                    CHANNEL_CARDS[key] = mid
                    _CHANNEL_FAILS[key] = 0
            return
    except Exception:
        log.exception("接单卡片发送异常，尝试文字确认")
    try:
        if send(chat_id, text):
            return
    except Exception:
        log.exception("接单确认失败，任务已接收，继续订阅回答")
    with _CHANNEL_CARDS_LOCK:
        if _CHANNEL_RECEIPTS.get(receipt_key) is reservation:
            _CHANNEL_RECEIPTS.pop(receipt_key, None)


def send_via_channel(open_id, chat_id, text, msg):
    """投给插件。返回 True = 已接单（包括重复投递），False = 请走老路径。"""
    if not channel_on():
        return False
    ch = channel_mod.get()

    intent = "auto"
    body = text
    m = re.match(r"^/(\S+)\s*(.*)$", text, re.S)
    if m and m.group(1) in INTENT_ALIAS:
        intent = INTENT_ALIAS[m.group(1)]
        body = (m.group(2) or "").strip()
        if not body:
            send(chat_id, "`/%s` 后面要跟内容。" % m.group(1), at=_at_for(chat_id, open_id))
            return True

    thread_id = getattr(msg, "thread_id", "") or ""
    root_id = getattr(msg, "root_id", "") or ""
    tenant = getattr(msg, "tenant_key", "") or "default"
    mid = getattr(msg, "message_id", "") or ""
    cwd = cur_cwd(open_id)
    # 老通道时代这个人的记忆（headless 建的 session）：交给插件优先接续，
    # 换通道不清零记忆。接不上插件会自己开新的，不会报错。
    legacy_sid = STATE["sessions"].get(sess_key(open_id, cwd)) or ""

    def _ingest(use_cwd=True):
        return ch.ingest(
            open_id=open_id, chat_id=chat_id, text=body,
            cwd=(cwd if use_cwd else ""),
            msg_id=mid, thread_id=thread_id, root_id=root_id,
            tenant_key=tenant, name=who_name(open_id), intent=intent,
            session_id=legacy_sid,
        )

    recovered = False
    try:
        r = _ingest()
    except Exception as e:
        # 「会话已绑定目录」不是错误，是状态不同步：这个人的 /cd 记录停在 A，
        # 而会话是在 B 建的。插件拒绝换目录是对的，bot 这边降级成「不指定」
        # 就行 —— 让插件沿用它自己绑定的目录，话不至于丢掉。
        if "已绑定目录" in str(e):
            log.info("目录记录与会话不一致（%s），改成沿用会话自己的目录", e)
            try:
                r = _ingest(use_cwd=False)
                key = r.get("key") or channel_mod.session_key(
                    chat_id, thread_id, root_id, tenant)
                watch_channel(key)
                ack_channel_message(key, chat_id, r, mid)
                log.info("通道接单（沿用会话目录） key=%s intent=%s dup=%s",
                         key, r.get("intent"), bool(r.get("duplicate")))
                return True
            except Exception as e2:
                log.warning("沿用会话目录仍失败：%s", e2)
                reply_undelivered(open_id, chat_id, e2)
                return True
        # 超时不等于没接单：插件可能已经收下，只是回执慢。
        # 它按 msgId 幂等（重复投递回 duplicate=True），所以用同一个 msgId
        # 重投一次是安全的 —— 第一次真成功就拿到 duplicate，第一次真失败就补上。
        # 不这么做的话，退回老路径会和插件已接的单撞成两张卡。
        log.warning("通道投递异常（%s），用同一 msgId 重投一次", e)
        try:
            r = _ingest()
            recovered = True
            if r.get("duplicate") and intent != "auto":
                r = {**r, "intent": intent}
        except Exception as e2:
            log.warning("通道重投仍失败：%s", e2)
            reply_undelivered(open_id, chat_id, e2)
            return True

    key = r.get("key") or channel_mod.session_key(chat_id, thread_id, root_id, tenant)
    watch_channel(key)
    ack_channel_message(key, chat_id, r, mid, recovered=recovered)
    log.info(
        "通道接单 key=%s intent=%s dup=%s msg=%s",
        key, r.get("intent"), bool(r.get("duplicate")), mid,
    )
    return True


def channel_stop(open_id, chat_id, msg):
    """让插件侧中止当前轮但保留已排队的话；成功返回 True。"""
    if not channel_on():
        return False
    try:
        r = channel_mod.get().control(channel_key_of(msg, chat_id), "stop")
    except Exception as e:
        log.warning("通道 stop 失败：%s", e)
        return False
    if not r.get("ok"):
        log.info("通道 stop 没打中：%s", r.get("reason"))
        return False
    send(chat_id, "已让 agent 收尾中止（排队的话保留着，随时能接着跑）。",
         at=_at_for(chat_id, open_id))
    return True


def start_channel():
    """接上通道并恢复回复订阅，重启后不必等用户再发一句。"""
    if not channel_mod:
        log.info("通道模块没装（channel.py 不在），走老路径")
        return
    ch = channel_mod.init(CONF)
    if not ch:
        return
    for key in list(STATE.get("channel_watch_keys", [])):
        watch_channel(key)
    h = ch.health()
    if not h.get("ok"):
        log.warning("通道启动健康检查失败（%s）：%s", ch.url, h.get("reason"))
    else:
        log.info(
            "通道模式已启用 %s sessions=%s pending=%s",
            ch.url, h.get("sessions"), h.get("pending"),
        )




def pending_task(open_id, chat_id, text, session_id=None, approved=False, label=None, msg=None):
    hit = is_dangerous(text)
    if hit and not approved:
        ask_approval(
            open_id, chat_id, "dsh", {"text": text, "label": text[:60]},
            "这句话里有危险动作「%s」" % hit, text[:1200],
        )
        return
    # 通道模式：投给常驻 agent 的原生存件箱，成功就不再 spawn 子进程。
    # 这段放在危险动作审批之后 —— 审批永远由本进程把关，插件不参与。
    # msg 可以是 None：危险动作审批通过后重投（bot.py:1047）手上只有文本，
    # 没有原始消息对象。send_via_channel 里所有 getattr 都有默认值，
    # msgId 空就让插件用 uuid 兜底，不会重复投递。
    if send_via_channel(open_id, chat_id, text, msg):
        return
    # 2026-11-07：老路径（spawn dsh-task 子进程）已删除。
    # 通道不通就是不通，如实说，别再假装还有备胎 ——
    # 那条备胎路上没有思考过程、没有工具流水、补话只能排队，
    # 而且它会把「服务器在干活」和「群里什么都不显示」拆成两件互不相干的事。
    log.warning("通道不可用，消息没投出去 open_id=%s", open_id)
    send(chat_id,
         "\u26a0\ufe0f 通道没连上（agent 机上的 dsh-web 或插件不在），这条没投出去。\n"
         "发 /status 看细节；服务器恢复后把这句话再发一次就行。",
         at=_at_for(chat_id, open_id))


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


def _mention_ids(msg):
    """消息里被 @ 到的人（open_id 列表），取不到就算空。"""
    out = []
    for m in (getattr(msg, "mentions", None) or []):
        oid = ""
        try:
            mid = getattr(m, "id", None)
            if mid is not None:
                oid = getattr(mid, "open_id", "") or ""
        except Exception:
            oid = ""
        if not oid and isinstance(m, dict):
            oid = ((m.get("id") or {}).get("open_id")) or ""
        if oid:
            out.append(oid)
    return out


def _is_me(sender_id):
    """这条消息是不是机器人自己发的。

    机器人发的消息 sender 是应用（cli_…），不是 open_id（ou_…），
    所以两个都得认——否则「用户回复我的结果卡」会被当成「回复别人的消息」。
    """
    if not sender_id:
        return False
    return sender_id == BOT_OPEN_ID or (APP_ID and sender_id == APP_ID)


def _chatter_reason(msg, parent_sender):
    """群里这句是在跟别人说话，还是在使唤机器人？返回原因（空串=该接）。

    免 @ 之后机器人会听到群里每一句话。两个人互相接话、@ 别人的话，
    它插嘴只会碍事——只在「回它的话」「@ 它」「谁也没指向」这三种情况下才接。
    """
    if _is_me(parent_sender):
        return ""                       # 在回我的消息，那是给我看的
    if parent_sender:
        return "回复的是别人的消息"
    others = [o for o in _mention_ids(msg) if not _is_me(o)]
    if others:
        return "@的是别人"
    return ""


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

        is_group = chat_type in ("group", "topic")
        STATE.setdefault("chat_types", {})[chat_id] = chat_type

        def reply(t, **kw):
            """回复这条消息的发起人。群里一律 @ 他——群常年静音，不 @ 等于没回。"""
            kw.setdefault("at", sender if is_group else None)
            return send(chat_id, t, **kw)

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
                    reply("这条 %s 消息里没带附件 key，取不到东西。" % msg_type)
                log.info("附件消息没带 key，忽略 type=%s", msg_type)
                return
        else:
            # 群里免 @ 之后，别人发个表情包/合并转发不该收到任何提示
            if chat_type not in ("group", "topic"):
                reply("这个我暂时接不住（%s）。发文字、图片、文件都行。" % msg_type)
            log.info("不支持的 msg_type=%s，忽略", msg_type)
            return

        raw = text
        text = re.sub(r"@_user_\d+", "", text)
        # 飞书 @ 组件给的是占位符，但有人直接手打「@G2 Agent」——一并去掉
        if BOT_NAME:
            text = text.replace("@" + BOT_NAME, "")
        text = text.strip()
        # 去掉之后只剩 @ 和空白，就等于「只 @ 了一下，没打字」
        if not re.sub(r"[@\s]", "", text):
            text = ""
        log.info("text=%r", text)
        # 记住这句人话，等下有人只发一个 @ 时能接上
        if text and msg_type == "text" and not text.startswith("/"):
            _LAST_MSG["%s|%s" % (chat_id, sender)] = {"text": text, "ts": time.time()}

        # 群里发图带不了 @：只有「必须 @」的模式才需要先收着等他 @ 一句；
        # 免 @ 模式下图片直接处理（他补的那句话会落进同一个会话，上下文还在）
        if (att and chat_type in ("group", "topic") and not mentioned_bot(msg)
                and CONF.get("group_require_mention")):
            if allowed(sender):
                stash_attachment(chat_id, sender, msg, att)
                reply("📎 收到了：%s。15 分钟内 @我 说要拿它干什么，"
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

        # 引用/回复某条消息：飞书事件只给 parent_id，内容得再查一次。
        # 不还原的话，「你重新做这个」里的「这个」模型根本看不见——它只会接着当前上下文瞎猜。
        quote_note = ""
        parent_sender = ""
        pid = (getattr(msg, "parent_id", "") or "").strip()
        if pid and pid != (getattr(msg, "message_id", "") or ""):
            quote_note, qatt, parent_sender = resolve_quote(chat_id, sender, pid)
            if qatt and not att:
                att = qatt
            log.info("引用了 mid=%s 还原出 %d 字%s", pid, len(quote_note),
                     " + 附件" if qatt else "")

        # 群里免 @ 之后能听到每一句话，但别人互相接话时不该插嘴。
        # 判定：回的是我的消息 / @ 了我 / 谁也没指向 → 接；回复别人 / @ 别人 → 不接。
        if chat_type in ("group", "topic") and not mentioned_bot(msg):
            why = _chatter_reason(msg, parent_sender)
            if why:
                log.info("这句像是对别人说的（%s），不接", why)
                return

        # 只 @ 了一下没打字：接他上一条说过的话；实在没有才提示
        if not text and not att and not quote_note:
            prev = _LAST_MSG.get("%s|%s" % (chat_id, sender)) or {}
            if prev and time.time() - float(prev.get("ts") or 0) <= _LAST_MSG_TTL:
                # 那句话已经在跑了（典型：先发正文、再补一个 @）就别再跑一遍
                if RUNNING.get(sender) or QUEUES.get(sender):
                    reply("这句已经在跑了，等它出来。")
                    return
                text = prev["text"]
                log.info("只发了个 @，接上他上一条：%r", text[:60])
            else:
                reply("在。直接说要做什么就行（看 /help）。")
                return

        # ② 白名单：先放行自助开通，再拒绝外人
        m = re.match(r"^/claim\s+(\S+)$", text)
        if m:
            tok = (CONF.get("setup_token") or "").strip()
            if not tok:
                reply("管理员还没设 setup_token，认领通道没开。")
            elif m.group(1) != tok:
                reply("口令不对。")
                log.warning("claim 口令错误 sender=%s", sender)
            else:
                wl = CONF.setdefault("allowed_open_ids", [])
                if sender not in wl:
                    wl.append(sender)
                    save_conf()
                    log.info("claim 成功 sender=%s 白名单共 %d 人", sender, len(wl))
                reply("认领成功，你在白名单里了（白名单共 %d 人）。\n"
                              "现在直接说话我就转给 DSH。先试一句：/status" % len(wl))
                if join_group(sender):
                    reply("顺手把你拉进「G2 指挥群」了，群里直接说话就行（要 @ 也行）。")
            return

        m = re.match(r"^/(allow|deny)\s+(\S+)$", text)
        if m:
            if not allowed(sender):
                reply("只有白名单里的人能改白名单。")
                return
            act, target = m.group(1), m.group(2).strip()
            wl = CONF.setdefault("allowed_open_ids", [])
            if act == "allow":
                if target in wl:
                    reply("%s 已经在白名单里。" % target)
                else:
                    wl.append(target)
                    save_conf()
                    reply("已加入 %s（白名单共 %d 人）。" % (target, len(wl)))
            else:
                if target not in wl:
                    reply("%s 本来就不在白名单里。" % target)
                else:
                    wl.remove(target)
                    save_conf()
                    reply("已移出 %s（白名单共 %d 人）。" % (target, len(wl)))
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
                reply("你在白名单外（open_id：%s），找管理员加一下：\n"
                              "/allow %s" % (sender, sender))
            return

        if sender not in STATE["users"]:
            STATE["users"][sender] = {"first_seen": datetime.now().isoformat(timespec="seconds")}
            save_state()

        # 附件：取回字节 → 落进工作目录 → 把路径写进任务描述（沙箱只认 cwd 内的文件）
        if quote_note:
            text = quote_note + text
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
                reply("收到，继续等。")
            else:
                reply("现在没有在跑的任务。")
            return
        if text in ("停", "/stop", "/停", "中止", "取消"):
            # 通道模式先让插件 cancel 当前轮（keepInbox：排队的话不漏）
            if channel_stop(sender, chat_id, msg):
                return
            t = RUNNING.get(sender)
            if t:
                t.kill()
                q = QUEUES.get(sender)
                tail = "（队列里还有 %d 个，会继续跑；/清队 可清空）" % len(q) if q else ""
                reply("已发中止信号。" + tail)
            else:
                reply("现在没有在跑的任务。")
            return

        # 口语版「停手」：别把这类话当任务派下去——模型会真的去「处理」一遍，
        # 结果就是插嘴 + 白跑一次。这里直接答一句，并且顺手停掉他名下在跑的任务。
        if len(text) <= 30 and any(w in text for w in STOP_WORDS):
            t = RUNNING.get(sender)
            if t:
                t.kill()
                reply("好，停了。")
            else:
                reply("好。")
            return

        m = re.match(r"^(?:/批|批|/approve)\s*(\w+)$", text) or re.match(r"^(?:/拒|拒|/reject)\s*(\w+)$", text)
        if m:
            act = "approve" if text[0] in "/批" else "cancel"
            ok, why = resolve_approval(m.group(1), act, sender)
            if not ok:
                reply(why)
            return

        if text in ("/help", "help", "帮助", "/?", "/指令", "/h"):
            if not card_create(chat_id, help_card()):
                reply(INFO)
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
                reply("没有这个模型：%s%s" % (
                    want, "\n相近的：\n" + "\n".join(near) if near else "\n发 /模型 看列表。"))
                return
            reply("试一下 %s …" % want)
            ok, why = apply_choice(model=want)
            if ok:
                card_create(chat_id, model_card())
            else:
                reply(why)
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
                reply("reasoningEffort 只有 %s 这几档。" % " / ".join(EFFORTS))
                return
            reply("试一下 %s …" % want)
            ok, why = apply_choice(effort=want)
            if ok:
                card_create(chat_id, effort_card())
            else:
                reply(why)
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
            reply("好，以后日报里叫你 %s。" % who_name(sender))
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
                reply("好，群里以后要 @ 我才干活。"
                              "图片消息带不了 @，会先收着，等你 @ 一句再挂上去。")
            else:
                reply("好，群里不用 @ 了，直接说话就行（发图也一样）。")
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
            reply(head + do_status())
            return

        if text in ("/work", "/工作区", "/where", "/cwd"):
            here = cur_cwd(sender)
            sid = STATE["sessions"].get(sess_key(sender, here)) or ""
            code, out = run_agent(
                'p=%s; if [ -d "$p" ]; then '
                'd=$(du -sh "$p" 2>/dev/null | cut -f1); '
                'n=$(find "$p" -maxdepth 1 -type f 2>/dev/null | wc -l); '
                'echo "OK|$d|$n"; else echo "NO||"; fi'
                % shlex.quote(here),
                timeout=40,
            )
            body = ["工作区 %s" % here]
            if "OK|" in out:
                parts = [x for x in out.splitlines() if x.startswith("OK|")][0].split("|")
                body.append("  顶层 %s 个文件，共 %s" % (parts[2].strip(), parts[1] or "?"))
                body.append("  记忆：%s" % ("%s（这个目录接着上次的聊）" % sid if sid
                                            else "还没有，下一句会在这里新开一份"))
            else:
                body.append("  这个目录现在不存在了（被删或改名），下一句会退回根目录跑。")
                body.append("  用 /cd <名字> 换一个，或 /项目 看还有哪些。")
            body.append("")
            body.append("换地方：/cd <名字> 切到子目录，/cd work 回根，/项目 看全部。")
            body.append("每个目录一份独立的 DSH 记忆，互不串。")
            deliver(chat_id, "\n".join(body))
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
                reply("列不出来（exit=%d）：%s" % (code, out[:400]))
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
            lines.append("切换：/cd <项目名>（/cd work 回根）；每个目录各有一份 DSH 记忆。")
            lines.append("细节：/work 看当前工作区。")
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
                reply("没有这个目录：%s\n先 /ls 看一眼。" % target)
                return
            STATE["cwd"][sender] = target
            save_state()
            sid = STATE["sessions"].get(sess_key(sender, target))
            reply("切到「%s」。%s" % (
                target.rstrip("/").rsplit("/", 1)[-1],
                "这个项目有旧记忆，接着用。" if sid else "这个目录下第一句话会新开记忆。"))
            log.info("cd open_id=%s -> %s", sender, target)
            return

        if text in ("/queue", "/q", "/排队"):
            # 通道模式：排队在插件里（DSH 原生收件箱），读真值而不是本地 deque
            if channel_on():
                try:
                    r = channel_mod.get().control(channel_key_of(msg, chat_id), "view")
                    v = (r or {}).get("view") or {}
                    lines = []
                    if v:
                        lines.append("在跑：%s（第 %s 轮）" % (
                            "是" if v.get("status") == "running" else "否",
                            v.get("turn") or 0))
                        qq = v.get("queue") or []
                        if qq:
                            lines.append("排队 %d 个：" % len(qq))
                            for i, it in enumerate(qq[:10], 1):
                                mark = "插话" if it.get("target") == "next-step" else "下一轮"
                                who = it.get("name") or it.get("author") or ""
                                lines.append("  %d) [%s] %s%s" % (
                                    i, mark, (it.get("text") or "")[:50],
                                    (" — " + who) if who else ""))
                        else:
                            lines.append("收件箱是空的。")
                        if v.get("streaming"):
                            lines.append("正在输出：%s…" % (v.get("streaming") or "")[-120:])
                    else:
                        lines.append("这条会话还没开跑过。")
                    reply("\n".join(lines))
                    return
                except Exception:
                    log.exception("读通道队列失败，回落本地队列")
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
            reply("\n".join(lines))
            return

        if text in ("/清队", "/clearq", "/clearqueue"):
            if channel_on():
                try:
                    r = channel_mod.get().control(channel_key_of(msg, chat_id), "clearQueue")
                    reply("收件箱清空了。" if (r or {}).get("ok") else "清队没成功，再试一次。")
                    return
                except Exception:
                    log.exception("通道清队失败，回落本地队列")
            q = QUEUES.get(sender)
            n = len(q) if q else 0
            if q:
                q.clear()
            reply("已清掉 %d 个排队任务。" % n if n else "队列本来就是空的。")
            return

        if text in ("/new", "/reset", "/重置", "/新"):
            keys = [k for k in list(STATE["sessions"]) if k == sender or k.startswith(sender + "|")]
            for k in keys:
                STATE["sessions"].pop(k, None)
            save_state()
            reply("记忆清空了（%d 份），下一条从头开始。" % len(keys))
            return

        if text in ("/cost", "/额度"):
            reply("\n".join(usage_lines()))
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
            reply("▶ 在 %s 执行：%s" % (target, command))
            t0 = time.time()
            code, out = run_agent(command) if target == "agent" else run_pve(command)
            deliver(chat_id, "✔ %s 完成（%.1fs，exit=%d）\n%s" % (target, time.time() - t0, code, out))
            return

        # 不认得的斜杠命令不要当成任务丢给 DSH（它会把 /xxx 当普通文字瞎猜）
        if re.match(r"^/[A-Za-z\u4e00-\u9fff]+$", text) and len(text) <= 12:
            reply("没这个命令：%s\n看看 /help，或者直接说要做什么。" % text)
            return

        # ⑨⑩ 其余全部交给 DSH（群里也先给 DSH 一家）
        pending_task(sender, chat_id, text, label=label, msg=msg)

    except Exception as e:
        log.exception("handle error")
        try:
            # 别把 Python 异常名甩给用户看：他看不懂，也不知道该做什么
            send(data.event.message.chat_id,
                 "⚠️ 这条我没接住（%s）。重发一次通常就好；一直这样就发 /状态 看看。" % type(e).__name__)
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
        if act == "open_effort":
            if message_id:
                card_patch(message_id, effort_card())
            elif chat_id:
                card_create(chat_id, effort_card())
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
        if act in ("set_model", "set_effort", "model_all", "open_effort"):
            ctx_obj = getattr(ev, "context", None)
            chat_id = getattr(ctx_obj, "open_chat_id", "") if ctx_obj else ""
            mid = getattr(ctx_obj, "open_message_id", "") if ctx_obj else ""
            threading.Thread(
                target=_do_switch,
                args=(act, str(val.get("v") or ""), chat_id, mid),
                daemon=True,
            ).start()
            return _build_card_response()

        # 通道进度卡上的按钮：key 是会话键，插件按 key 找到对应 agent
        ckey = str(val.get("key") or "")
        if ckey and act in ("stop", "recall", "clearQueue", "view", "new") and channel_on():
            mid = ""
            try:
                ctx_obj = getattr(ev, "context", None)
                mid = getattr(ctx_obj, "open_message_id", "") if ctx_obj else ""
            except Exception:
                pass
            extra = {}
            if val.get("messageId"):
                extra["messageId"] = str(val.get("messageId"))
            try:
                r = channel_mod.get().control(ckey, act, **extra)
                log.info("通道按钮 act=%s key=%s ok=%s", act, ckey, r.get("ok"))
            except Exception:
                log.exception("通道按钮失败 act=%s", act)
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
    # 通道是可选能力：连不上就静默走老路径，绝不影响 bot 本身起来
    try:
        start_channel()
    except Exception:
        log.exception("通道启动失败，继续走老路径")

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
