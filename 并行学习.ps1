# 河南干部网络学院 · 多账号并行学习启动器
#
# 用法:
#   .\并行学习.ps1                        # 按 accounts.local.json 里的账号全部并行跑
#   .\并行学习.ps1 -Daily:$false          # 不按"当日上限"跑,改用 config.json 的目标学时
#   .\并行学习.ps1 -Accounts a,b          # 只跑指定的账号(按 profile 名匹配)
#
# 账号来源(优先级从高到低):
#   1. 当前目录下的 accounts.local.json,格式(手机号换成你自己的):
#        [
#          { "profile": "账号1", "user": "138xxxxxxxx", "pass": "密码1" },
#          { "profile": "账号2", "user": "139xxxxxxxx", "pass": "密码2" }
#        ]
#   2. 没有该文件时,交互式询问(最多 3 个账号),问完可以选择保存到 accounts.local.json。
#
# 注意:accounts.local.json 里是明文密码,别外传,也别提交到 git(已在 .gitignore 里排除)。

[CmdletBinding()]
param(
  [switch]$Daily = $true,
  [string[]]$Accounts,
  [int]$MaxAccounts = 3
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

$credFile = Join-Path $PSScriptRoot 'accounts.local.json'
$list = @()

# profile 名脱敏:11 位手机号 → 135＊＊＊＊6716(全角星号,Windows 文件名合法,
# 半角 * 是 NTFS 保留字符不能用),避免手机号明文出现在
# state-xxx.json / logs\run-xxx.log / .chrome-profile-xxx 的文件名里
function Get-MaskedProfile([string]$name) {
  if ($name -match '^1[3-9]\d{9}$') { return $name.Substring(0, 3) + '＊＊＊＊' + $name.Substring(7) }
  return $name
}

function Read-InteractiveAccounts {
  $acc = @()
  for ($i = 1; $i -le $MaxAccounts; $i++) {
    Write-Host ""
    Write-Host "── 第 $i 个账号(直接回车结束输入)──" -ForegroundColor Cyan
    $user = (Read-Host '  手机号/账号').Trim()
    if (-not $user) { break }
    $secure = Read-Host '  密码' -AsSecureString
    $pass = [System.Net.NetworkCredential]::new('', $secure).Password
    if (-not $pass) { Write-Host '  密码为空,跳过。' -ForegroundColor Yellow; continue }
    $acc += [pscustomobject]@{ profile = Get-MaskedProfile $user; user = $user; pass = $pass }
  }
  return $acc
}

if (Test-Path -LiteralPath $credFile) {
  Write-Host "读取账号文件:$credFile" -ForegroundColor Green
  $list = @(Get-Content -LiteralPath $credFile -Raw -Encoding UTF8 | ConvertFrom-Json)
} else {
  Write-Host "未找到 accounts.local.json,改为交互输入。" -ForegroundColor Yellow
  $list = @(Read-InteractiveAccounts)
  if ($list.Count -gt 0) {
    $save = (Read-Host '把这次输入的账号保存到 accounts.local.json 以便下次直接用?(y/N)').Trim()
    if ($save -eq 'y' -or $save -eq 'Y') {
      $list | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $credFile -Encoding UTF8
      Write-Host "已保存到 $credFile(明文密码,请勿外传)" -ForegroundColor Yellow
    }
  }
}

if ($Accounts) {
  $list = @($list | Where-Object { $Accounts -contains $_.profile -or $Accounts -contains $_.user })
}

$list = @($list | Where-Object { $_.user -and $_.pass })
if ($list.Count -eq 0) { Write-Host '没有可用账号,退出。' -ForegroundColor Red; exit 1 }

if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'node_modules'))) {
  Write-Host '首次运行,正在安装依赖(puppeteer-core)…' -ForegroundColor Yellow
  npm install
}

Write-Host ""
Write-Host "即将并行启动 $($list.Count) 个账号:" -ForegroundColor Cyan
foreach ($a in $list) { Write-Host "  · $($a.user)" }

$started = @()
foreach ($a in $list) {
  $argList = @('auto-learn.mjs', "--profile=$($a.profile)", "--user=$($a.user)", "--pass=$($a.pass)")
  if ($Daily) { $argList += '--daily' } else { $argList += '--credit=5' }
  $p = Start-Process -FilePath 'node' -ArgumentList $argList -WorkingDirectory $PSScriptRoot -PassThru
  $started += $p
  Write-Host "  → 已启动 $($a.user) (PID $($p.Id))" -ForegroundColor Green
}

Write-Host ""
Write-Host "两个窗口会各自弹出 Chrome 自动登录并开始播放。" -ForegroundColor Cyan
Write-Host "⚠ 不要关掉浏览器窗口、不要最小化;关掉终端窗口会中断对应的学习。" -ForegroundColor Yellow
Write-Host "进度看 logs\run-<账号>-*.log,或等窗口自己结束。" -ForegroundColor Cyan
Write-Host ""
Write-Host "本次启动的进程:" -ForegroundColor Cyan
$started | ForEach-Object { Write-Host ("  PID {0}" -f $_.Id) }
