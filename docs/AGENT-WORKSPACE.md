# agent 工作区（`~/work`）归档规则

`/home/agent/work` 是 bot 里 `agent_cwd` 与 `agent_root` 指向的地方，也就是飞书上让它干活时的落脚点。
它同时承担了四个互相冲突的角色：**项目源码、构建产物、交付物、一次性试验**。混在一起的后果很具体——

- 「把作业发我」时，agent 要在 2 万多个文件里找那个 `.docx`；
- 每次扫描/备份/统计都要爬过 1G 的 `node_modules`；
- 一个 Electron 项目吃掉 79% 的磁盘，看起来像"磁盘快满了"，其实是打包产物。

## 现状（2026-10-30 实测）

```
3.0G / 约 2 万个文件

negative film/        2.4G    ← 源码只有 1.9M（src 792K + test 852K + docs 168K + scripts 32K）
AAAzjx/               429M    ← 学术项目，含 113 个交付物里的大部分
job/                   95M
research/              45M
film-dust-removal-ps/  33M
Aodink/                28M
自己_PixCake/          19M
作业汇总_Word/        1.5M
600 G2 set/           228K
BTZS/                  12K    ← 449 天未动
```

按「能不能重建」重切一遍，才是真实结构：

| 类别 | 体积 | 占比如 | 说明 |
| --- | --- | --- | --- |
| L2 构建产物 | 1261.9 MB | 41% | `out/` 545M + `release/` 719M，全在 `negative film/` |
| L3 依赖 | 1019.9 MB | 33% | `node_modules/` 1.1G，全在 `negative film/` |
| 源码 + `.git` | ~450 MB | 15% | 7 个 git 仓库，`.git` 共 210M |
| 交付物 | 163.6 MB | 5% | 113 个 doc/docx/pdf/xlsx/pptx |
| 其余 | ~150 MB | 5% | research、job 里的数据与中间文件 |

**74% 是可重建的**。删掉 L2+L3，项目一条命令就能回来（`pnpm install && pnpm build`）。

> `negative film/` 的病根：`release/` 里躺着 `NegLift.exe` 246MB ×2、`nsis.7z` 122MB、`electron` 228MB，
> 是同一个应用的多份打包结果。真源码不到 2MB。

## 四条规则

### 1. 按角色分目录，不按项目分

```
work/
├── projects/    活跃项目：有 .git，正在改
├── deliver/     交付物：只放最终要发出去的那一份
├── archive/     停摆项目：>90 天没动，打成 tar.gz
└── tmp/         一次性试验：7 天后自动清
```

现在交付物散在各项目里（`AAAzjx/assignments/…`、`AAAzjx/presentations/…`、根目录零散的
`作业汇总_Word.zip`）。让 agent「把报告发我」时它得猜。统一到 `deliver/<日期>-<课程或项目>/` 之后，
一句话就能定位，也方便 `/状态` 里列「最近交付了什么」。

原始素材（`references/`、`papers/`、`pdfs/`）留在项目里，**不进 `deliver/`**——那些是输入不是输出。

### 2. 可重建目录不进备份、不做索引

`node_modules` / `dist` / `out` / `release` / `.cache` / `.next` / `.turbo` 一律视为可丢弃。
判断标准只有一条：**一条命令能不能回来**。

- 能回来的（`pnpm install`、`npm run build`）→ 随时可删
- 回不来的（源码、`.git`、交付物、数据集）→ 进备份

`release/` 要单独说一句：它可重建，但里面可能有**要交付给别人的安装包**。所以规则是
「打完包就把要发的那一个移进 `deliver/`，其余 `release/` 可以清」。

### 3. 坏安装残骸立即清，不等

`node_modules.incomplete-20260922-060316`（354M）、`node_modules.link-repair-20260922-2155`
是 `pnpm install` 中断留下的半成品——只有 30 个包，正常是几百个。这类目录**没有任何价值**，
且会让 `find` 多爬 354M。已于 2026-10-30 清除。

### 4. 停摆的先压缩，不要直接删

`BTZS/` 449 天没动。直接删掉等于丢历史；打包成 `archive/BTZS-2025.tar.gz` 只占几 KB，
需要时还能翻出来。规则：**>90 天未修改的项目进 `archive/`，压缩后从 `projects/` 移走**。

## 清理脚本

`agent-work-gc`（装于 agent `~/.local/bin/`，源码在本仓库 `services/agent-workspace/agent-work-gc.sh`）。

```bash
agent-work-gc              # 报告全部级别，不删任何东西
agent-work-gc -r L1        # 只删残骸（永远安全）
agent-work-gc -r L1,L2     # ！删构建产物，需要重新 build
agent-work-gc -r L1,L2,L3  # ！连 node_modules 一起删，需要重新 install
```

设计上刻意保守：
- 默认只报告；
- L2/L3 必须显式点名，不会因为"顺手"被删；
- 删除前二次校验目录名，不匹配规则的一律跳过；
- `release/` 在报告里单独列出，提醒先确认有没有要交付的包。

## 还没做的（等确认）

1. **把 `work/` 重构成 `projects|deliver|archive|tmp`** —— 要移动 7 个项目目录，
   `agent_cwd` 配置也要跟着改，属于一次性重构，风险在"迁完发现某个脚本写死了老路径"。
2. **删 L2+L3（2.2G）** —— 零风险但 `negative film/` 要重装依赖（几分钟）。
3. **`deliver/` 单一出口** —— 需要先改 bot 的 `PROMPT_TMPL`，让 agent 交付时写这里并 `pushfile`。
4. **`/状态` 里列最近交付物** —— 依赖第 3 条落地。

第 1 条建议等有明确的新项目要开工时顺手做，别为重构而重构。
