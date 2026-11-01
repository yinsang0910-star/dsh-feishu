# 搭配记忆插件：dsh-mnemon

机器人本身只保证「会话内」连续：同一个人 + 同一个工作目录，第二轮能接上第一轮。
**跨会话、跨项目的长期记忆不在它职责内**，靠 DSH 的记忆插件补。

不装的表现很具体：今天告诉它「我叫什么、做什么的、别用术语」，明天开新会话，它一样不知道。
装了之后这些写进 `~/.mnemon/runtime/`，每次进上下文，机器人在飞书里才像个记得事的同事。

推荐搭配的是 [dsh-mnemon](https://github.com/omdsh-dev/dsh-mnemon) —— 作者
[@Grivn](https://github.com/Grivn)，MIT，本项目未修改、未打包、不参与分发，只建议安装。

## 它是什么

DSH 的三层记忆控制面：

| 层 | 存什么 | 落在哪 |
| --- | --- | --- |
| Runtime Memory | 稳定事实与偏好（你是谁、忌讳什么、常用路径） | `~/.mnemon/runtime/MEMORY.md`、`USER.md` |
| Documents | 项目级长文档，按需检索 | `~/.mnemon/documents/` |
| Memory Spaces | 长期记忆库，可接外部 provider（mem0 / honcho / OpenViking 等） | `~/.mnemon/data/` |

本地优先，SQLite 落盘，不需要额外的服务或 API Key。`embedding.enabled` 默认关闭，
召回走关键词与图谱，所以没有向量库依赖。

## 关键点：headless profile 是另一套装配

这一点最容易踩。桌面/网页 profile 装过记忆插件，**跟 headless 没有关系**：

- 机器人在飞书里跑的 `dsh-task` 落在 **headless profile**
- headless 默认只有 `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-headless` 两个 bundle
- 于是 `~/.mnemon/runtime/{MEMORY.md,USER.md}` 从来没进过上下文 —— 看起来就像「它失忆了」

## 安装

在跑 agent 的那台机器上（不是 Windows 本机）：

```bash
bash services/agent-workspace/install-mnemon.sh           # 装到 headless
bash services/agent-workspace/install-mnemon.sh web       # 也可以装到 web
```

脚本是幂等的：已经装过就跳过安装，只做检查。它做四件事 —— 备份 `package.json`、
调 `dsh plugin --profile headless add dsh-mnemon`、数 `--dump-config` 里的 mnemon entry、
列出 runtime 记忆文件大小。

手动等价操作：

```bash
cp -p ~/.dsh/profiles/headless/package.json{,.bak-before-mnemon-$(date +%Y%m%d-%H%M%S)}
dsh plugin --profile headless add dsh-mnemon      # 会自动写 dependencies 与 dsh.profile.bundles
dsh --profile headless --dump-config | grep -ci mnemon    # 期望 ≥3
```

不需要手改 `cordis.patch.yml`，也不需要手改 `package.json` 的 `dsh.profile.bundles` ——
pnpm 装完会自动把 bundle 追加进去。

## 验证

```bash
cd /home/agent/work && dsh-task --json "你还记得我叫什么名字？只回答名字"
```

两句**独立 session** 都应答出记忆里的名字。判定依据不是「答对了」，而是：
两次的 `inputTokens` 相同 —— 说明是同一份 runtime 记忆注入，不是从会话历史里猜的。

想确认读写面完整，让它显式检索一次：

```bash
cd /home/agent/work && dsh-task --json "用 mnemon_recall 查一下我的名字，只回答查到的内容"
```

日志里应看到 `mnemon_recall` 真的被调用，返回 provider `mnemon-native`。

## 与 web profile 共用同一份记忆

`mnemon` 不做 profile 级存储隔离。headless 装好后与 web 读写同一份 `~/.mnemon`，
所以在桌面端教过它的事，飞书里也认。这是想要的行为，但也意味着两边的写入会互相影响。

它启动时会 flush 一次 runtime 文件：`mtime` 变、大小不变，属正常现象。

## 别做的事

不要把 `~/.dsh/profiles/web/node_modules/.../dsh-mnemon/cordis.patch.yml` 里的 `insert`
块抄进 profile 自己的 patch 文件。entry id 会重复，后果是 Settings 存不住
（上游 issue #470）。`dsh plugin add` 已经把该做的都做了。

## 回滚

```bash
cp -p ~/.dsh/profiles/headless/package.json.bak-before-mnemon-<时间戳> \
      ~/.dsh/profiles/headless/package.json
```

`~/.mnemon/` 里的记忆数据不受影响，重装后接着用。

## 上游

| 项 | 值 |
| --- | --- |
| 仓库 | [omdsh-dev/dsh-mnemon](https://github.com/omdsh-dev/dsh-mnemon) |
| 作者 | [@Grivn](https://github.com/Grivn)（[npm](https://www.npmjs.com/package/dsh-mnemon) 上的维护者） |
| 协议 | MIT |
| 最新版 | v0.5.37 |

记忆这件事上游做得比本项目能做的更细：三层记忆、可插拔 provider、文档检索、知识图谱、
子 agent 工作流都是它自己的能力。本项目只是把「机器人得用同一份记忆」这件事写进部署流程，
其余不重复实现。

## 版本

本项目按 `dsh-mnemon@^0.5.37` 验证（与桌面 profile 对齐）。要换版本：

```bash
MNEMON_PKG=dsh-mnemon@0.5.40 bash services/agent-workspace/install-mnemon.sh
```

装完跑一遍上面「验证」那两条，确认 `inputTokens` 仍然稳定、`mnemon_recall` 仍可用。
