# 这个目录的来源与历史

`channel/` 曾经是一个独立仓库 `yinsang0910-star/dsh-feishu-channel`（2026-11-04 创建）。
2026-11-04 合并进本仓库，成为 `dsh-feishu` 下的一个目录。此后**只有一个仓库**，就是这里。

## 为什么合并

独立仓库会让人找不到历史：想看「上一版卡片长什么样」，得先去猜它在哪个仓库。
合并时用 `git filter-repo --to-subdirectory-filter channel` 把每个提交的文件路径改写到
`channel/` 前缀下，所以**提交链原样保留**，只是 commit hash 因为 tree 变了而重新计算。

## 怎么查这个目录的历史

```bash
# 这个目录的全部提交（含合并前的那 4 个）
git log --oneline -- channel/

# 某个文件的历史
git log --follow --oneline -- channel/lib/index.js

# 看某一版卡片是怎么写的
git show 9baf514:channel/lib/card.js
```

GitHub 网页上也可以直接点进 `channel/` 目录，右上角 **History** 就是这条路径的完整历史。

## 原始 commit hash 对照

合并时 hash 变了，对照如下（左边是旧仓库里的 hash，右边是合并后的）：

| 旧 hash | 新 hash | 说明 |
|---|---|---|
| `9644967` | `1e9cbcc` | feat: 飞书通道 v0.1.7 — 原生 inbox 注入 + 出站回答回传 |
| `e2ea1f7` | `cfe982c` | 0.1.8: 回答改成结构化卡片，并带回思考过程与思考深度 |
| `ff203e3` | `9baf514` | 0.1.11: 工具流水进飞书卡片，回答卡不再贴思考全文 |
| `6c023c6` | `4383cda` | docs: 顶部标注世代关系 |

旧仓库 `dsh-feishu-channel` 已删除，上述旧 hash 仅作追溯参考，仓库里已经不存在。

## 版本演进

逐版本「症状 → 根因 → 修法」的完整记录在 [`CHANGELOG.md`](CHANGELOG.md)，0.1.0 到 0.1.11 一条不落。
