$conns = Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue
foreach ($c in $conns) {
    Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
    Write-Host "Killed PID $($c.OwningProcess)"
}
if (-not $conns) {
    Write-Host "No process on port 8765"
}
