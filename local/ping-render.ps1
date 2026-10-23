$u = 'https://akira-ia.onrender.com/api/health'
$log = Join-Path $env:USERPROFILE 'presitn-keepalive.log'
try {
  $t0 = Get-Date
  $r = Invoke-WebRequest -Uri $u -TimeoutSec 25 -UseBasicParsing
  $ms = [math]::Round(((Get-Date) - $t0).TotalMilliseconds)
  Add-Content -LiteralPath $log -Value "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] ping $($r.StatusCode) ${ms}ms"
} catch {
  Add-Content -LiteralPath $log -Value "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] ping FALHOU: $($_.Exception.Message)"
}