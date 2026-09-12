# foodmap 一键启动/自愈脚本
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts\start-foodmap.ps1        # 幂等启动（已在跑则跳过）
#   powershell -ExecutionPolicy Bypass -File scripts\start-foodmap.ps1 -Force # 强制重启（先杀旧进程）
param(
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$ProjectDir = 'D:\dev\foodie-map'
$Url = 'http://127.0.0.1:3000/discover'

Set-Location $ProjectDir

# 1. 检查是否已在运行
$listener = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
if ($listener -and -not $Force) {
    Write-Host '[OK] foodmap 已在运行 (:3000)，无需操作（如需重启请加 -Force）' -ForegroundColor Green
    exit 0
}
if ($listener -and $Force) {
    Write-Host '[..] 强制重启：停止旧进程...'
    $listener | ForEach-Object {
        Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 2
}

# 2. 构建检查（.next 不存在则先构建）
if (-not (Test-Path (Join-Path $ProjectDir '.next\BUILD_ID'))) {
    Write-Host '[..] 未找到构建产物，开始构建（可能需 1-3 分钟）...'
    $env:NODE_OPTIONS = '--max-old-space-size=3072'
    Push-Location $ProjectDir
    npm run build
    Pop-Location
    if ($LASTEXITCODE -ne 0) {
        Write-Host '[X] 构建失败，请检查错误' -ForegroundColor Red
        exit 1
    }
}

# 3. 启动 next server（后台、隐藏窗口；.NET Process 绕开 Start-Process 的 Path/PATH bug）
Write-Host '[..] 启动 next server...'
$nodeBin = (Get-Command node).Source
$nextCli = Join-Path $ProjectDir 'node_modules\next\dist\bin\next'
$outLog = Join-Path $ProjectDir 'server.log'
# cmd /c 双层引号模式（""prog" args"），正确处理含空格路径
$cmdline = '""' + $nodeBin + '" "' + $nextCli + '" start -H 0.0.0.0 -p 3000 > "' + $outLog + '" 2>&1"'
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = 'cmd.exe'
$psi.Arguments = '/c ' + $cmdline
$psi.WorkingDirectory = $ProjectDir
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
[System.Diagnostics.Process]::Start($psi) | Out-Null

# 4. 自检（最多等 30 秒）
for ($i = 1; $i -le 30; $i++) {
    Start-Sleep -Seconds 1
    try {
        $r = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3
        if ($r.StatusCode -eq 200) {
            Write-Host ('[OK] foodmap 已就绪，耗时 {0}s -> {1}' -f $i, $Url) -ForegroundColor Green
            exit 0
        }
    } catch {
        # 继续等待
    }
}
Write-Host '[X] 启动超时，请查看 server.log' -ForegroundColor Red
exit 1
