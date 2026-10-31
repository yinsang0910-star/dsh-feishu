<#
.SYNOPSIS
    把四个包按依赖顺序发布到 npm。

.DESCRIPTION
    前提（都是人工步骤，脚本只做检查不代做）：
      1. `npm login --registry=https://registry.npmjs.org`
      2. scope 必须已存在。npm 没有创建组织的 API（`PUT /-/org/<name>` 返回 404），
         只能走网页 https://www.npmjs.com/org/create —— 那需要登录态，无法自动化。
         所以默认发到维护者个人 scope `@yisang0910/*`，它随账号立即可用。
         将来建好组织再把包迁过去（改名前先确认没有对外文档引用旧名）。
      3. **账号必须开启 2FA**，否则一定 403。这是 npm 2026 年的新政策，不是配置错：
         - 2026-07-31 起，bypass-2FA 的 granular token 被禁止做账号级操作
           （建 token / 改包权限 / 配 trusted publishing 都要交互式 2FA 挑战）
         - 报错原文：`Two-factor authentication or granular access token with
           bypass 2fa enabled is required to publish packages.`
           查 token 详情会看到 `"bypass_2fa": false` —— 而这个开关现在建不出来
         - 2027-01 起 bypass-2FA token 连直接发布也要收走，只剩「读私有包 + 暂存发布」
         所以开 2FA 是唯一出路：网页 → Account → Two-Factor Authentication → 用
         手机认证器扫码。开完之后本脚本加 `-Otp <6位码>` 就能发。
         想彻底免码就走 trusted publishing（见 .github/workflows/publish-npm.yml）。
      4. 本机 npm 若指向镜像源，发布时必须显式走官方源 —— 脚本已写死 --registry

    发布顺序不能乱：mcp 和 gateway 依赖 core，core 必须先进去。
    pnpm publish 会把 workspace:* 自动替换成实际版本号，不需要手工改。

.EXAMPLE
    .\release-npm.ps1 -DryRun      # 只打包看内容，不发布
    .\release-npm.ps1 -Otp 123456   # 开了 2FA 之后：带一次性码真发布
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
