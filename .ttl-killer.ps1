$target = 6056
$port = 3000
$endsAt = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
Start-Sleep -Seconds 3600
$now = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
$killed = @()
foreach ($p in (Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*next*dev*' -and $_.CommandLine -like '*gsap-animation-pipeline*' })) {
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    $killed += $p.ProcessId
}
$conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($conn) { Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue; $killed += $conn.OwningProcess }
$logDir = 'D:\delete\gsap-recovery\gsap-animation-pipeline'
Add-Content -LiteralPath "$logDir\ttl-killer.log" -Value "[$now] TTL expired. Killed PIDs: $($killed -join ', ')"
