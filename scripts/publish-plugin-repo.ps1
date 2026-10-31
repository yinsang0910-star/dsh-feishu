<#
.SYNOPSIS
    把 monorepo 里的 packages/dsh-plugin 同步到独立的发布仓库。

.DESCRIPTION
    为什么需要这一步：dsh.pub 的自动校验从**仓库根**读包元数据，
    monorepo 根是 workspace（private、没有 dsh 字段），会被判成「不是可安装的组合包」。
    所以另建一个根目录就是插件包的仓库，专门用来被目录收录。

    源：packages/dsh-plugin（唯一事实来源，改代码只改这里）
    目标：本仓库根下的 .publish/plugin-repo（在 .gitignore 里，可以随时删掉重建）

    它只做单向复制 + 生成定制的 package.json / README / LICENSE，
    不反向写回主仓库。重复运行是幂等的。

.EXAMPLE
    .\publish-plugin-repo.ps1              # 只生成到 .publish，不提交
    .\publish-plugin-repo.ps1 -Push        # 生成并提交推送到远端
#>
[CmdletBinding()]
param(
    [switch]$Push,
    [string]$Message = ''
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$src = Join-Path $root 'packages\dsh-plugin'
$out = Join-Path $root '.publish\plugin-repo'

if (-not (Test-Path $src)) { throw "找不到插件源目录：$src" }

New-Item -ItemType Directory -Force -Path $out | Out-Null

# ── 1. 复制运行时文件（只带会被加载的东西）─────────────────────────────────
$copy = @('client.js', 'cordis.patch.yml')
foreach ($f in $copy) {
    Copy-Item (Join-Path $src $f) (Join-Path $out $f) -Force
}
New-Item -ItemType Directory -Force -Path (Join-Path $out 'dist') | Out-Null
# 不复制 .map：目录站只需要能加载的产物，54KB 的 sourcemap 是噪音
Get-ChildItem (Join-Path $src 'dist') -File | Where-Object { $_.Extension -ne '.map' } |
    ForEach-Object { Copy-Item $_.FullName (Join-Path $out "dist\$($_.Name)") -Force }

# ── 2. 生成 package.json（去掉 private，补 repository）──────────────────────
$pkg = Get-Content (Join-Path $src 'package.json') -Raw | ConvertFrom-Json
$repoUrl = 'https://github.com/yinsang0910-star/dsh-feishu-plugin'
$ordered = [ordered]@{
    name        = $pkg.name
    version     = $pkg.version
    type        = 'module'
    description = 'DeepSeek Harness 的飞书连接设置页：四步向导 + 扫码创建应用 + 九项自检'
    keywords    = @('dsh-plugin', 'deepseek-harness', 'feishu', 'lark')
    main        = $pkg.main
    types       = $pkg.types
    exports     = $pkg.exports
    files       = @('dist', 'client.js', 'cordis.patch.yml', 'README.md', 'LICENSE')
    dsh         = $pkg.dsh
    repository  = [ordered]@{ type = 'git'; url = "git+$repoUrl.git" }
    homepage    = 'https://github.com/yinsang0910-star/dsh-feishu'
    bugs        = [ordered]@{ url = 'https://github.com/yinsang0910-star/dsh-feishu/issues' }
    license     = 'MIT'
    engines     = [ordered]@{ node = '>=20' }
}
($ordered | ConvertTo-Json -Depth 12) + "`n" | Set-Content (Join-Path $out 'package.json') -Encoding utf8 -NoNewline

# ── 3. LICENSE（dsh.pub 明确要求仓库许可证文件，package.json 的 license 字段不算）
$licenseSrc = Join-Path $root 'LICENSE'
if (Test-Path $licenseSrc) {
    Copy-Item $licenseSrc (Join-Path $out 'LICENSE') -Force
} else {
    throw "主仓库根目录没有 LICENSE，先补上"
}

# ── 4. README（独立仓库要有自己的安装说明，不能直接搬 39KB 的开发笔记）──────
$readme = @"
# @yisang0910/plugin

DeepSeek Harness 设置面板里的「飞书连接」页：四步向导，把飞书接进 DSH。

**主仓库在 [yinsang0910-star/dsh-feishu](https://github.com/yinsang0910-star/dsh-feishu)**
——25 个 MCP 工具、长连接机器人、卡片网关都在那边。这个仓库只是为了能被插件目录收录，
由主仓库的 `scripts/publish-plugin-repo.ps1` 单向同步生成，**请勿直接在此提交代码**。

## 装

```bash
dsh plugin --profile <profile> add github:yinsang0910-star/dsh-feishu-plugin#<commit>
```

然后重启 DSH，设置面板左栏会出现「飞书连接」。

## 它做什么

- **建应用**：给开放平台直达链接和 11 项权限清单，可一键复制
- **填凭据**：可以扫码直接创建一个飞书自建应用（RFC 8628 设备授权），凭据只写本机、不经过浏览器；也可以手填
- **选会话**：扫描机器人所在的群并点选，不用手抄 32 位 `chat_id`
- **自检**：九项逐个真调飞书接口（凭据 / 机器人身份 / 会话列表 / 目标群 / 读历史 / 上传文件 / 云空间 / MCP 挂载 / 凭据文件），失败项直接给出该开通的 scope

自检不往聊天里发东西：读历史只读 1 条，上传探测文件只 20 字节且不发送。

## 依赖

需要 DSH 的 `@deepseek-ai/dsh-client-ui-primitives` 与 `@deepseek-ai/dsh-client-ui-slots`
（随 DSH 提供，不需要单独安装）。

## License

MIT
"@
$readme | Set-Content (Join-Path $out 'README.md') -Encoding utf8 -NoNewline

# ── 5. .gitignore（这个仓库只放产物，源码在主仓库）─────────────────────────
@"
node_modules/
*.map
*.log
.DS_Store
"@ | Set-Content (Join-Path $out '.gitignore') -Encoding utf8 -NoNewline

Write-Host "✓ 已生成 $out"
Get-ChildItem $out -Recurse -File | ForEach-Object {
    "  {0,-24} {1,7:N1} KB" -f $_.FullName.Replace($out, '').TrimStart('\'), ($_.Length / 1KB)
}

# ── 6. 提交推送 ────────────────────────────────────────────────────────────
if (-not $Push) {
    Write-Host ''
    Write-Host '（只生成。加 -Push 会提交并推送到 yinsang0910-star/dsh-feishu-plugin）' -ForegroundColor Yellow
    return
}

Push-Location $out
try {
    if (-not (Test-Path '.git')) {
        git init -q
        git branch -M main
        git remote add origin 'https://github.com/yinsang0910-star/dsh-feishu-plugin.git'
    }
    git add -A
    $status = git status --porcelain
    if (-not $status) {
        Write-Host '没有变化，跳过提交。'
        return
    }
    $msg = if ($Message) { $Message } else { "sync: 从主仓库同步 @yisang0910/plugin $(Get-Date -Format 'yyyy-MM-dd HH:mm')" }
    git -c user.name='yinsang0910-star' -c user.email='1446512943@qq.com' commit -q -m $msg
    git push -u origin main 2>&1 | Select-Object -Last 3
    Write-Host '✓ 已推送' -ForegroundColor Green
} finally {
    Pop-Location
}
