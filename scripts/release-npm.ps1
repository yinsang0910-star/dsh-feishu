<#
.SYNOPSIS
    把四个包按依赖顺序发布到 npm。

.DESCRIPTION
    前提（都是人工步骤，脚本只做检查不代做）：
      1. `npm login --registry=https://registry.npmjs.org`
      2. 在 npmjs.com 上创建名为 `dsh-feishu` 的组织（scoped 包必须先有 scope）
      3. 本机 npm 若指向镜像源，发布时必须显式走官方源 —— 脚本已写死 --registry

    发布顺序不能乱：mcp 和 gateway 依赖 core，core 必须先进去。
    pnpm publish 会把 workspace:* 自动替换成实际版本号，不需要手工改。

.EXAMPLE
    .\release-npm.ps1 -DryRun      # 只打包看内容，不发布
    .\release-npm.ps1              # 真发布
    .\release-npm.ps1 -Otp 123456   # 账号开了 2FA 时带上一次性码
#>
[CmdletBinding()]
param(
    [switch]$DryRun,
    [string]$Otp
)

$ErrorActionPreference = 'Stop'
$registry = 'https://registry.npmjs.org'

# 依赖顺序：先 core，再依赖它的 mcp / gateway，最后自包含的 dsh-plugin
$order = @('core', 'mcp', 'gateway', 'dsh-plugin')

if (-not $DryRun) {
    Write-Host '→ 检查登录状态...'
    $who = (npm whoami --registry=$registry 2>&1) -join ''
    if ($LASTEXITCODE -ne 0) {
        throw "npm 没登录。先跑：npm login --registry=$registry（还要在 npmjs.com 建 dsh-feishu 组织）"
    }
    Write-Host "  已登录：$($who.Trim())"
}

Write-Host ''
Write-Host '→ 构建全部包...'
pnpm build 2>&1 | Select-Object -Last 3
if ($LASTEXITCODE -ne 0) { throw '构建失败，先修好再发' }

$otpArg = @()
if ($Otp) { $otpArg = @("--otp=$Otp") }

foreach ($name in $order) {
    $pkgJson = Get-Content "packages/$name/package.json" -Raw | ConvertFrom-Json
    $full = $pkgJson.name
    $ver = $pkgJson.version
    Write-Host ''
    Write-Host "→ $full@$ver"

    if ($DryRun) {
        # 不用 `publish --dry-run`：pnpm 会把它吞掉。改为逐项检查 files 里登记的东西
        # 真的存在，并统计会进包的字节数 —— 这才是发布前真正会咬人的地方。
        $files = @($pkgJson.files)
        $total = 0
        $missing = @()
        foreach ($entry in $files) {
            $p = "packages/$name/$entry"
            if (Test-Path $p -PathType Leaf) {
                $total += (Get-Item $p).Length
            } elseif (Test-Path $p -PathType Container) {
                Get-ChildItem $p -Recurse -File | ForEach-Object { $total += $_.Length }
            } else {
                $missing += $entry
            }
        }
        Write-Host ("  files: {0}" -f ($files -join ', '))
        Write-Host ("  体积 : {0:N1} KB" -f ($total / 1KB))
        if ($missing.Count -gt 0) {
            Write-Host ("  ✗ 缺失: {0}" -f ($missing -join ', ')) -ForegroundColor Red
        } else {
            Write-Host '  ✓ files 里登记的都存在' -ForegroundColor Green
        }
    } else {
        pnpm --filter $full publish --access public --no-git-checks --registry=$registry @otpArg 2>&1 |
            Select-Object -Last 6
        if ($LASTEXITCODE -ne 0) { throw "$full 发布失败（看上面的 npm 报错）" }
    }
}

Write-Host ''
if ($DryRun) {
    Write-Host '（DryRun 结束，没有真发布）' -ForegroundColor Yellow
} else {
    Write-Host '✓ 四个包都发布了。' -ForegroundColor Green
    Write-Host '  接下来可以提交到 MCP 目录站（smithery / mcp.so / awesome-mcp-servers）。'
}
