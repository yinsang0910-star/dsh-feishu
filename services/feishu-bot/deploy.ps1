<#
.SYNOPSIS
    把仓库里的 bot.py 部署到 PVE 的 /opt/feishu-bot/ 并重启服务。

.DESCRIPTION
    这是一个**部署脚本**，只有三个动作：把本文件旁边的 bot.py 传到目标机、
    重启一个 systemd 服务、检查它是否活着。它不接收任意命令、不执行远端下载。

    仓库是源，PVE 上的 /opt/feishu-bot/ 是运行副本。
    改了 bot.py 就必须跑这个脚本，否则飞书上跑的还是旧的。

    流程：sha256 比对 → 备份 → 分块上传 → 落地校验 → systemctl restart
          → 健康检查（is-active + 进程 + 日志无 Traceback）→ 失败自动回滚。

.PARAMETER Check
    只比对本地与远端的 sha256，不上传不重启。用来发现「是不是有人直接在 PVE 上改了」。

.PARAMETER Execute
    真正执行。**不加这个参数时脚本只打印计划，不动远端任何东西。**
    部署与回滚都需要显式带上它。

.PARAMETER Force
    即使哈希相同也重新上传并重启。

.PARAMETER Rollback
    回滚到远端最近一次部署前的备份，然后重启（同样需要 -Execute）。

.EXAMPLE
    . C:\path\to\vmctl.ps1   # 提供 $PLINK / $HOSTKEY / $PASSWORD
    .\deploy.ps1 -Check

.EXAMPLE
    .\deploy.ps1              # 只打印计划
    .\deploy.ps1 -Execute     # 真的部署
#>
[CmdletBinding()]
param(
    [switch]$Check,
    [switch]$Execute,
    [switch]$Force,
    [switch]$Rollback
)

$ErrorActionPreference = 'Stop'

# ── 连接参数：不在此文件硬编码。优先用当前作用域里已有的，其次读环境变量 ────
$PLINK    = if ($PLINK)    { $PLINK }    else { $env:PLINK_PATH }
$HOSTKEY  = if ($HOSTKEY)  { $HOSTKEY }  else { $env:PVE_HOSTKEY }
$PASSWORD = if ($PASSWORD) { $PASSWORD } else { $env:PVE_PASSWORD }
$PVEHOST  = if ($PVEHOST)  { $PVEHOST }  else { 'root@192.168.1.10' }

if (-not $PLINK -or -not (Test-Path $PLINK)) { throw "找不到 plink。设置环境变量 PLINK_PATH，或先 . 你的 vmctl.ps1（它会设 `$PLINK / `$HOSTKEY / `$PASSWORD）" }
if (-not $HOSTKEY)  { throw "缺少 hostkey（ssh 主机指纹，形如 SHA256:xxx）。设环境变量 PVE_HOSTKEY，或先 . 你的 vmctl.ps1" }
if (-not $PASSWORD) { throw "缺少密码。设环境变量 PVE_PASSWORD，或先 . 你的 vmctl.ps1" }

$RemoteDir  = '/opt/feishu-bot'
$RemoteFile = "$RemoteDir/bot.py"
$BackupDir  = '/root/bot-backup'
$Service    = 'feishu-bot'
$LocalFile  = Join-Path $PSScriptRoot 'bot.py'

# 统一的远端调用：只执行本脚本写死的那几条命令，不接受外部传入的任意脚本。
function Invoke-Pve {
    param([string]$Script)
    Write-Verbose "ssh $PVEHOST -- $Script"
    $r = & $PLINK -ssh -batch -hostkey $HOSTKEY -pw $PASSWORD $PVEHOST $Script 2>&1
    if ($LASTEXITCODE -ne 0) { throw "PVE 命令失败(exit $LASTEXITCODE)：$($r -join "`n")" }
    return ($r -join "`n")
}

function Get-Sha256([string]$Path) {
    (Get-FileHash $Path -Algorithm SHA256).Hash.ToLower()
}

function Assert-Execute([string]$Why) {
    if ($Execute) { return }
    Write-Host ''
    Write-Host "（计划）会做：$Why" -ForegroundColor Yellow
    Write-Host '  确认无误后加 -Execute 真正执行。' -ForegroundColor Yellow
    exit 0
}

# ── 回滚 ────────────────────────────────────────────────────────────────────
if ($Rollback) {
    Write-Host '→ 查找最近可回滚的备份...' -ForegroundColor Cyan
    $latest = Invoke-Pve "ls -1t $BackupDir/bot.py.* 2>/dev/null | head -1"
    if (-not $latest) { throw "没有找到任何备份（$BackupDir/bot.py.*）" }
    Write-Host "  用备份：$latest"
    Assert-Execute "把 $latest 覆盖回 $RemoteFile 并重启 $Service"
    Invoke-Pve "cp '$latest' $RemoteFile && chmod 644 $RemoteFile && systemctl restart $Service" | Out-Null
    Start-Sleep -Seconds 3
    $state = Invoke-Pve "systemctl is-active $Service"
    Write-Host "  服务状态：$state" -ForegroundColor $(if ($state.Trim() -eq 'active') { 'Green' } else { 'Red' })
    return
}

if (-not (Test-Path $LocalFile)) { throw "找不到本地 bot.py：$LocalFile" }

# ── sha256 比对 ─────────────────────────────────────────────────────────────
$localHash = Get-Sha256 $LocalFile
$remoteHash = (Invoke-Pve "sha256sum $RemoteFile | cut -d' ' -f1").Trim()

Write-Host "  本地：$localHash  ($((Get-Item $LocalFile).Length) 字节)"
Write-Host "  远端：$remoteHash"

if ($Check) {
    if ($localHash -eq $remoteHash) {
        Write-Host '✓ 一致：PVE 上跑的就是仓库这一份。' -ForegroundColor Green
    } else {
        Write-Host '✗ 不一致：PVE 上的 bot.py 与仓库不同。' -ForegroundColor Yellow
        Write-Host '  可能是有人在 PVE 上直接改过（那些改动没有进仓库，注意别覆盖丢掉）。' -ForegroundColor Yellow
        Write-Host '  想看差在哪：' -ForegroundColor Yellow
        Write-Host "    plink ... 'cat $RemoteFile' > `$env:TEMP\remote_bot.py; code `$env:TEMP\remote_bot.py bot.py"
    }
    return
}

if ($localHash -eq $remoteHash -and -not $Force) {
    Write-Host '✓ 已是最新，无需部署（加 -Force 可强制重传）。' -ForegroundColor Green
    return
}

Assert-Execute "把本目录的 bot.py 传到 $RemoteFile、重启 $Service；失败会自动回滚"

# ── 备份 ────────────────────────────────────────────────────────────────────
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$remoteBak = "$BackupDir/bot.py.$stamp"
Write-Host "→ 备份现有文件到 $remoteBak"
Invoke-Pve "mkdir -p $BackupDir && cp $RemoteFile '$remoteBak'" | Out-Null

# ── 上传（base64 分块，避免 plink 命令行长度上限）────────────────────────────
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

$uploadHash = (Invoke-Pve "base64 -d /tmp/bot.py.b64 > /tmp/bot.py.new && sha256sum /tmp/bot.py.new | cut -d' ' -f1 && rm -f /tmp/bot.py.b64").Trim()
if ($uploadHash -ne $localHash) {
    Invoke-Pve "rm -f /tmp/bot.py.new" | Out-Null
    throw "上传校验失败：远端 $uploadHash 本地 $localHash（未替换线上文件，服务未动）"
}
Write-Host '✓ 上传校验通过' -ForegroundColor Green

# ── 替换 + 重启 ─────────────────────────────────────────────────────────────
Write-Host "→ 落盘并重启 $Service"
Invoke-Pve "install -m 644 -o root -g root /tmp/bot.py.new $RemoteFile && rm -f /tmp/bot.py.new && systemctl restart $Service" | Out-Null
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
    Write-Host "`n✓ 部署成功。$remoteBak 可回滚（.\deploy.ps1 -Rollback -Execute）。" -ForegroundColor Green
} else {
    Write-Host "`n✗ 健康检查未通过，自动回滚到 $remoteBak ..." -ForegroundColor Red
    Invoke-Pve "cp '$remoteBak' $RemoteFile && systemctl restart $Service" | Out-Null
    Start-Sleep -Seconds 3
    $state2 = (Invoke-Pve "systemctl is-active $Service").Trim()
    Write-Host "  回滚后状态：$state2" -ForegroundColor Yellow
    throw '部署失败，已回滚。'
}
