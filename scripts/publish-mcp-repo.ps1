<#
.SYNOPSIS
    把 monorepo 里的 packages/mcp 打成自包含单文件，同步到独立的 MCP 仓库。

.DESCRIPTION
    为什么需要这一步：MCP 目录（smithery / mcp.so / glama）和 `npx` 都要求
    「一个能直接跑起来的包」。monorepo 里的 packages/mcp 依赖 workspace 内的
    @yisang0910/core，外部装不到；发 npm 又被「granular token」卡住。
    所以用 esbuild 打成一个 1.5MB 的单文件（含 SDK 与 core），放进根目录就是包的仓库，
    `npx github:yinsang0910-star/dsh-feishu-mcp` 即可运行，不经 npm registry。

    源：packages/mcp（唯一事实来源）
    目标：.publish/mcp-repo（在 .gitignore 里，可随时删掉重建）
    单向同步，重复运行幂等。

.EXAMPLE
    .\publish-mcp-repo.ps1            # 只生成并自检
    .\publish-mcp-repo.ps1 -Push      # 生成、提交、推送
#>
[CmdletBinding()]
param(
    [switch]$Push,
    [string]$Message = ''
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$src = Join-Path $root 'packages\mcp'
$out = Join-Path $root '.publish\mcp-repo'
$entry = Join-Path $src 'src\server.ts'
$repoUrl = 'https://github.com/yinsang0910-star/dsh-feishu-mcp'

if (-not (Test-Path $entry)) { throw "找不到 MCP 入口：$entry" }
New-Item -ItemType Directory -Force -Path $out | Out-Null

# ── 1. 打自包含 bundle（node 内置模块外置，其余全打进来）────────────────────
$bundleName = 'dsh-feishu-mcp.mjs'
$bundlePath = Join-Path $out $bundleName
$esbuild = Join-Path $root 'node_modules\.bin\esbuild.cmd'
if (-not (Test-Path $esbuild)) { throw "找不到 esbuild：$esbuild（先 pnpm install）" }

Write-Host '→ 打包 MCP server...' -ForegroundColor Cyan
# 不加 --banner:js：src/server.ts 首行已有 shebang，esbuild 会保留它。
# 再加一次会变成两行 shebang，ESM 第二行直接 SyntaxError。
& $esbuild $entry `
    --bundle `
    --platform=node `
    --format=esm `
    --target=node20 `
    --outfile=$bundlePath `
    --log-level=warning 2>&1 | ForEach-Object { "  $_" }
if ($LASTEXITCODE -ne 0) { throw '打包失败' }
"  {0}  {1:N2} MB" -f $bundleName, ((Get-Item $bundlePath).Length / 1MB) | Write-Host

# ── 2. 自检：喂一个 initialize，必须回 serverInfo ──────────────────────────
Write-Host '→ 自检（发 initialize）...' -ForegroundColor Cyan
$req = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}'
$env:FEISHU_APP_ID = 'cli_probe'
$env:FEISHU_APP_SECRET = 'probe_secret_for_selfcheck_only'
# 只要 stdout：stderr 是启动日志（"[dsh-feishu-mcp] ready · app=..."），混进来会误判
$resp = $req | node $bundlePath 2>$null | Select-Object -First 1
Remove-Item Env:\FEISHU_APP_ID, Env:\FEISHU_APP_SECRET -ErrorAction SilentlyContinue
if ($resp -match 'serverInfo') {
    Write-Host "  ✓ 响应正常" -ForegroundColor Green
    "  $($resp.Substring(0, [Math]::Min(160, $resp.Length)))" | Write-Host
} else {
    Write-Host "  ⚠ 响应异常：$resp" -ForegroundColor Yellow
}

# ── 3. package.json ────────────────────────────────────────────────────────
$srcPkg = Get-Content (Join-Path $src 'package.json') -Raw | ConvertFrom-Json
$pkg = [ordered]@{
    name        = 'dsh-feishu-mcp'
    version     = $srcPkg.version
    description = '飞书 / Lark MCP server：25 个工具，能真发文件进会话、读上下文、停下来等人拍板'
    type        = 'module'
    bin         = [ordered]@{ 'dsh-feishu-mcp' = "./$bundleName" }
    files       = @($bundleName, 'README.md', 'LICENSE')
    scripts     = [ordered]@{ start = "node ./$bundleName" }
    engines     = [ordered]@{ node = '>=20' }
    keywords    = @('mcp', 'model-context-protocol', 'feishu', 'lark', 'dsh', 'deepseek-harness')
    repository  = [ordered]@{ type = 'git'; url = "git+$repoUrl.git" }
    homepage    = 'https://github.com/yinsang0910-star/dsh-feishu#readme'
    bugs        = [ordered]@{ url = 'https://github.com/yinsang0910-star/dsh-feishu/issues' }
    license     = 'MIT'
}
($pkg | ConvertTo-Json -Depth 12) + "`n" | Set-Content (Join-Path $out 'package.json') -Encoding utf8 -NoNewline

# ── 4. LICENSE ─────────────────────────────────────────────────────────────
$licenseSrc = Join-Path $root 'LICENSE'
if (-not (Test-Path $licenseSrc)) { throw '主仓库根目录没有 LICENSE' }
Copy-Item $licenseSrc (Join-Path $out 'LICENSE') -Force

# ── 5. README ──────────────────────────────────────────────────────────────
$readme = @"
# dsh-feishu-mcp

飞书 / Lark 的 MCP server，25 个工具。**不需要公网 IP**：它走飞书长连接或 HTTP 回调拿事件，
你在任何一台能上网的机器上跑就行。

**主仓库在 [yinsang0910-star/dsh-feishu](https://github.com/yinsang0910-star/dsh-feishu)** ——
真源码、长连接机器人、卡片网关、四步安装向导都在那边。这个仓库是打包产物，
由主仓库的 ``scripts/publish-mcp-repo.ps1`` 单向同步生成，**请勿直接在此提交代码**。

## 装

**Claude Desktop**：从 [Releases](https://github.com/yinsang0910-star/dsh-feishu-mcp/releases) 下载
``dsh-feishu-mcp.mcpb``，双击安装，在配置面板填 App ID 与 App Secret。

**其他 stdio 客户端**（Cursor / Cline / DSH / 自己写的）：

``````bash
npx github:yinsang0910-star/dsh-feishu-mcp
``````

单文件自包含（SDK 和 core 都打进去了，不需要装依赖）。需要两个环境变量：

``````bash
export FEISHU_APP_ID=cli_xxxxxxxx
export FEISHU_APP_SECRET=xxxxxxxx
``````

## 挂到 DSH

``````yaml
- insert:
    - id: mcp-feishu
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: feishu
        transport: stdio
        command: node
        args: ['/绝对路径/dsh-feishu-mcp.mjs']
        toolCallTimeoutMs: 660000
``````

写进 ``~/.dsh/profiles/<profile>/cordis.patch.yml``，重启 DSH 后 agent 会多出
``mcp__feishu__*`` 25 个工具。

## 25 个工具

| 组 | 工具 |
|---|---|
| 身份 | ``feishu_whoami`` ``feishu_send_info_card`` |
| 消息 | ``feishu_send_text`` ``feishu_send_card`` ``feishu_update_card`` ``feishu_reply`` |
| 文件 | ``feishu_send_file`` ``feishu_send_image`` ``feishu_download`` |
| 上下文 | ``feishu_recent`` ``feishu_ask`` |
| 会话 | ``feishu_chats`` ``feishu_members`` |
| 多维表格 | ``feishu_bitable_tables`` ``feishu_bitable_fields`` ``feishu_bitable_records`` ``feishu_bitable_add`` ``feishu_bitable_update`` ``feishu_sheet_create`` |
| 云文档 | ``feishu_drive_list`` ``feishu_doc_read`` ``feishu_doc_create`` ``feishu_wiki_spaces`` ``feishu_wiki_node`` ``feishu_user_lookup`` |

其中 ``feishu_send_file`` 是把本地文件真的发进会话（不是给个路径），
``feishu_update_card`` 是让一张进度卡片原地刷新，``feishu_ask`` 会阻塞到有人
点卡片按钮或打字回复为止。

## 权限

应用要开的消息类 scope：``im:message`` ``im:message:send_as_bot`` ``im:chat:readonly``
``im:resource``；云文档类：``drive:drive`` ``docx:document`` ``wiki:wiki:readonly``
``bitable:app``。漏开时工具会直接告诉你缺哪个。

## License

MIT
"@
$readme | Set-Content (Join-Path $out 'README.md') -Encoding utf8 -NoNewline

# ── 6. .gitignore + .gitattributes ─────────────────────────────────────────
@"
node_modules/
*.map
*.log
.DS_Store
# .mcpb 是给 Claude Desktop 装的二进制产物，走 GitHub Release，不进 git
*.mcpb
"@ | Set-Content (Join-Path $out '.gitignore') -Encoding utf8 -NoNewline

# 必须有：Windows 上 git 默认 autocrlf 会把 .mjs 转成 CRLF，
# shebang 变成 "#!/usr/bin/env node`r"，npx / env 找不到 "node`r" 直接失败。
@"
* text=auto eol=lf
*.mjs text eol=lf
*.js text eol=lf
*.json text eol=lf
"@ | Set-Content (Join-Path $out '.gitattributes') -Encoding utf8 -NoNewline

Write-Host "✓ 已生成 $out" -ForegroundColor Green
Get-ChildItem $out -Recurse -File | ForEach-Object {
    "  {0,-26} {1,8:N1} KB" -f $_.FullName.Replace($out, '').TrimStart('\'), ($_.Length / 1KB)
}

# ── 8. 生成 .mcpb（MCP Bundle，Claude Desktop 双击即装的格式，smithery 也收）──
# 结构：manifest.json + icon.png + server/index.mjs，zip 后改扩展名，不能有外层目录。
Write-Host '→ 生成 .mcpb...' -ForegroundColor Cyan
$stage = Join-Path $root '.publish\mcpb-stage'
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path (Join-Path $stage 'server') | Out-Null
Copy-Item $bundlePath (Join-Path $stage 'server\index.mjs') -Force
$iconSrc = Join-Path $root 'docs\assets\icon-180.png'
if (Test-Path $iconSrc) { Copy-Item $iconSrc (Join-Path $stage 'icon.png') -Force }

$manifest = [ordered]@{
    manifest_version = '0.3'
    name             = 'dsh-feishu'
    display_name     = '飞书 / Lark'
    version          = $srcPkg.version
    description      = '25 个工具的飞书 MCP server：把本地文件真的发进会话、读会话上下文、发进度卡、停下来等人拍板。不需要公网 IP。'
    long_description = @'
把飞书变成一个可以操作的工作界面，而不是又一个通知渠道。

- **发文件**：`feishu_send_file` 把本地文件真的传进会话（不是给个路径），支持批量与说明文字
- **读上下文**：`feishu_recent` 拉最近的对话，agent 知道自己不在场时群里说了什么
- **等人拍板**：`feishu_ask` 会阻塞到有人点卡片按钮或打字回复为止
- **进度卡**：`feishu_update_card` 让同一张卡片原地刷新，不是刷屏
- **云内容**：多维表格增删改查、云文档读写、知识库浏览
'@
    author           = [ordered]@{
        name = 'yinsang0910-star'
        url  = 'https://github.com/yinsang0910-star'
    }
    repository       = [ordered]@{ type = 'git'; url = "git+$repoUrl.git" }
    homepage         = 'https://github.com/yinsang0910-star/dsh-feishu#readme'
    support          = 'https://github.com/yinsang0910-star/dsh-feishu/issues'
    license          = 'MIT'
    keywords         = @('feishu', 'lark', 'messaging', 'file-transfer', 'bitable')
    server           = [ordered]@{
        type        = 'node'
        entry_point = 'server/index.mjs'
        mcp_config  = [ordered]@{
            command = 'node'
            args    = @('${__dirname}/server/index.mjs')
            env     = [ordered]@{
                FEISHU_APP_ID           = '${user_config.app_id}'
                FEISHU_APP_SECRET       = '${user_config.app_secret}'
                FEISHU_DEFAULT_CHAT_ID  = '${user_config.default_chat_id}'
            }
        }
    }
    compatibility    = [ordered]@{
        platforms = @('darwin', 'win32', 'linux')
        runtimes  = [ordered]@{ node = '>=20.0.0' }
    }
    user_config      = [ordered]@{
        app_id           = [ordered]@{
            type        = 'string'
            title       = 'App ID'
            description = '飞书自建应用的 App ID（cli_ 开头）。在开放平台「凭证与基础信息」里'
            required    = $true
        }
        app_secret       = [ordered]@{
            type        = 'string'
            title       = 'App Secret'
            description = '飞书自建应用的 App Secret。只存在本机，不会上传'
            sensitive   = $true
            required    = $true
        }
        default_chat_id  = [ordered]@{
            type        = 'string'
            title       = '默认会话 ID'
            description = '可选。不填时每次调用都要显式传 chat_id（oc_ 开头）'
            required    = $false
        }
    }
}
($manifest | ConvertTo-Json -Depth 12) + "`n" | Set-Content (Join-Path $stage 'manifest.json') -Encoding utf8 -NoNewline

$mcpbPath = Join-Path $out 'dsh-feishu-mcp.mcpb'
if (Test-Path $mcpbPath) { Remove-Item $mcpbPath -Force }
# 用 .NET 的 ZipFile 而不是 Compress-Archive：后者会写外层目录、还会把 \ 写成 / 之外的问题
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory($stage, $mcpbPath, [IO.Compression.CompressionLevel]::Optimal, $false)
"  dsh-feishu-mcp.mcpb  {0:N2} MB" -f ((Get-Item $mcpbPath).Length / 1MB) | Write-Host
Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue

# ── 7. 提交推送 ────────────────────────────────────────────────────────────
if (-not $Push) {
    Write-Host ''
    Write-Host "（只生成。加 -Push 会推送到 $repoUrl）" -ForegroundColor Yellow
    return
}

Push-Location $out
try {
    if (-not (Test-Path '.git')) {
        git init -q
        git branch -M main
        git remote add origin "$repoUrl.git"
    }
    git add -A
    if (-not (git status --porcelain)) {
        Write-Host '没有变化，跳过提交。'
        return
    }
    $msg = if ($Message) { $Message } else { "sync: 从主仓库打包 MCP server $(Get-Date -Format 'yyyy-MM-dd HH:mm')" }
    git -c user.name='yinsang0910-star' -c user.email='1446512943@qq.com' commit -q -m $msg
    git push -u origin main 2>&1 | Select-Object -Last 3
    Write-Host '✓ 已推送' -ForegroundColor Green
} finally {
    Pop-Location
}
