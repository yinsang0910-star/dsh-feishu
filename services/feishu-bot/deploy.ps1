<#
.SYNOPSIS
    把仓库里的 bot.py 部署到 PVE 的 /opt/feishu-bot/ 并重启服务。

.DESCRIPTION
    仓库是源，PVE 上的 /opt/feishu-bot/ 是运行副本。
    改了 bot.py 就必须跑这个脚本，否则飞书上跑的还是旧的。

    流程：md5 比对 → 远端备份 → 分块上传 → 校验 → systemctl restart
          → 健康检查（is-active + 进程 + 日志无 Traceback）→ 失败自动回滚。

.PARAMETER Check
    只比对本地与远端 md5，不上传不重启。用来发现「是不是有人直接在 PVE 上改了」。

.PARAMETER Force
    即使 md5 相同也重新上传并重启（清缓存/确认进程用）。

.PARAMETER Rollback
    回滚到远端最近一次部署前的备份，然后重启。

.EXAMPLE
    . C:\Users\苏元洛\.pve600\vmctl.ps1   # 提供 $PLINK / $HOSTKEY / $PASSWORD
    .\deploy.ps1 -Check

.EXAMPLE
    .\deploy.ps1
#>
[CmdletBinding()]
param(
    [switch]$Check,
    [switch]$Force,
    [switch]$Rollback
)

$ErrorActionPreference = 'Stop'

# ── 连接参数：不在此文件硬编码，从 vmctl.ps1 的作用域或环境变量取 ──────────
$PLINK    = if ($PLINK)    { $PLINK }    else { 'C:\Users\苏元洛\.pve600\tools\plink.exe' }
$HOSTKEY  = if ($HOSTKEY)  { $HOSTKEY }  else { $env:PVE_HOSTKEY }
$PASSWORD = if ($PASSWORD) { $PASSWORD } else { $env:PVE_PASSWORD }
$PVEHOST  = if ($PVEHOST)  { $PVEHOST }  else { 'root@192.168.1.200' }

if (-not (Test-Path $PLINK)) { throw "找不到 plink：$PLINK" }
if (-not $HOSTKEY)  { throw "缺少 hostkey。先执行：. C:\Users\苏元洛\.pve600\vmctl.ps1" }
if (-not $PASSWORD) { throw "缺少密码。先执行：. C:\Users\苏元洛\.pve600\vmctl.ps1" }

$RemoteDir  = '/opt/feishu-bot'
$RemoteFile = "$RemoteDir/bot.py"
$BackupDir  = '/root/bot-backup'
$Service    = 'feishu-bot'
$LocalFile  = Join-Path $PSScriptRoot 'bot.py'

function Invoke-Pve {
    param([string]$Script)
    $r = & $PLINK -ssh -batch -hostkey $HOSTKEY -pw $PASSWORD $PVEHOST $Script 2>&1
    if ($LASTEXITCODE -ne 0) { throw "PVE 命令失败(exit $LASTEXITCODE)：$($r -join "`n")" }
    return ($r -join "`n")
}

# ── 回滚 ────────────────────────────────────────────────────────────────────
if ($Rollback) {
    Write-Host '→ 查找最近可回滚的备份...' -ForegroundColor Cyan
    $latest = Invoke-Pve "ls -1t $BackupDir/bot.py.* 2>/dev/null | head -1"
    if (-not $latest) { throw "没有找到任何备份（$BackupDir/bot.py.*）" }
    Write-Host "  用备份：$latest"
    Invoke-Pve "cp '$latest' $RemoteFile && chmod 644 $RemoteFile && systemctl restart $Service" | Out-Null
    Start-Sleep -Seconds 3
    $state = Invoke-Pve "systemctl is-active $Service"
    Write-Host "  服务状态：$state" -ForegroundColor $(if ($state.Trim() -eq 'active') { 'Green' } else { 'Red' })
    return
}

if (-not (Test-Path $LocalFile)) { throw "找不到本地 bot.py：$LocalFile" }

# ── md5 比对 ────────────────────────────────────────────────────────────────
$localMd5 = (Get-FileHash $LocalFile -Algorithm MD5).Hash.ToLower()
$remoteMd5 = (Invoke-Pve "md5sum $RemoteFile | cut -d' ' -f1").Trim()

Write-Host "  本地：$localMd5  ($((Get-Item $LocalFile).Length) 字节)"
Write-Host "  远端：$remoteMd5"

if ($Check) {
    if ($localMd5 -eq $remoteMd5) {
        Write-Host '✓ 一致：PVE 上跑的就是仓库这一份。' -ForegroundColor Green
    } else {
        Write-Host '✗ 不一致：PVE 上的 bot.py 与仓库不同。' -ForegroundColor Yellow
        Write-Host '  可能是有人在 PVE 上直接改过（那些改动没有进仓库，注意别覆盖丢掉）。' -ForegroundColor Yellow
        Write-Host '  想看差在哪：' -ForegroundColor Yellow
        Write-Host "    plink ... 'cat $RemoteFile' > \$env:TEMP\remote_bot.py; code \$env:TEMP\remote_bot.py bot.py"
    }
    return
}

if ($localMd5 -eq $remoteMd5 -and -not $Force) {
    Write-Host '✓ 已是最新，无需部署（加 -Force 可强制重传）。' -ForegroundColor Green
    return
}

# ── 备份 ────────────────────────────────────────────────────────────────────
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$remoteBak = "$BackupDir/bot.py.$stamp"
Invoke-Pve "mkdir -p $BackupDir && cp $RemoteFile '$remoteBak' && echo 备份=$remoteBak" | ForEach-Object { Write-Host "  $_" }

# ── 上传（base64 分块，避免命令行长度上限）──────────────────────────────────
$b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($LocalFile))
$chunkSize = 20000
$chunks = [math]::Ceiling($b64.Length / $chunkSize)
Write-Host "→ 上传 $($b64.Length) 字符 base64，分 $chunks 块..."

Invoke-Pve "rm -f /tmp/bot.py.b64" | Out-Null
for ($i = 0; $i -lt $chunks; $i++) {
    $start = $i * $chunkSize
    $len = [math]::Min($chunkSize, $b64.Length - $start)
    $chunk = $b64.Substring($start, $len)
    Invoke-Pve "printf '%s' '$chunk' >> /tmp/bot.py.b64" | Out-Null
    Write-Host "  块 $($i + 1)/$chunks" -NoNewline; Write-Host "`r" -NoNewline
}
Write-Host ''

$uploadMd5 = (Invoke-Pve "base64 -d /tmp/bot.py.b64 > /tmp/bot.py.new && md5sum /tmp/bot.py.new | cut -d' ' -f1 && rm -f /tmp/bot.py.b64").Trim()
if ($uploadMd5 -ne $localMd5) {
    Invoke-Pve "rm -f /tmp/bot.py.new" | Out-Null
    throw "上传校验失败：远端 md5=$uploadMd5 本地 md5=$localMd5（未替换线上文件，服务未动）"
}
Write-Host '✓ 上传校验通过' -ForegroundColor Green

# ── 替换 + 重启 ─────────────────────────────────────────────────────────────
Invoke-Pve "install -m 644 -o root -g root /tmp/bot.py.new $RemoteFile && rm -f /tmp/bot.py.new && systemctl restart $Service" | Out-Null
Write-Host '→ 已重启，等 4 秒做健康检查...'
Start-Sleep -Seconds 4

# ── 健康检查 ────────────────────────────────────────────────────────────────
$state = (Invoke-Pve "systemctl is-active $Service").Trim()
# 用 ps + grep 而不是 pgrep -f：pgrep 的 pattern 会匹配到 ssh 那侧的 shell 命令行，把进程数算高
$procs = (Invoke-Pve "ps -eo args | grep -F '$RemoteDir/venv/bin/python' | grep -v grep | wc -l").Trim()
$trace = Invoke-Pve "journalctl -u $Service --since '-20 sec' --no-pager 2>/dev/null | grep -iE 'Traceback|ImportError|SyntaxError' | head -5 || true"

$ok = ($state -eq 'active') -and ([int]$procs -ge 1) -and (-not $trace.Trim())
Write-Host ''
Write-Host "  服务状态 : $state"
Write-Host "  进程数   : $procs"
Write-Host "  启动异常 : $(if ($trace.Trim()) { $trace.Trim() } else { '无' })"

if ($ok) {
    Write-Host "`n✓ 部署成功。$remoteBak 可回滚（.\deploy.ps1 -Rollback）。" -ForegroundColor Green
} else {
    Write-Host "`n✗ 健康检查未通过，自动回滚到 $remoteBak ..." -ForegroundColor Red
    Invoke-Pve "cp '$remoteBak' $RemoteFile && systemctl restart $Service" | Out-Null
    Start-Sleep -Seconds 3
    $state2 = (Invoke-Pve "systemctl is-active $Service").Trim()
    Write-Host "  回滚后状态：$state2" -ForegroundColor Yellow
    throw '部署失败，已回滚。'
}
