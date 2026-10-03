# remove_hosts_boombang.ps1
# Quita la redireccion de game.boombang.tv (necesaria cuando NO usas el proxy)
# Ejecutar como ADMINISTRADOR

$hostsPath = "C:\Windows\System32\drivers\etc\hosts"
$lines = Get-Content $hostsPath
$kept = $lines | Where-Object { $_ -notmatch '^\s*127\.0\.0\.1\s+game\.boombang\.tv' }

if ($lines.Count -eq $kept.Count) {
    Write-Host "No habia entrada activa de game.boombang.tv." -ForegroundColor Yellow
} else {
    Set-Content -Path $hostsPath -Value ($kept -join "`r`n") -Encoding ASCII -NoNewline
    Add-Content -Path $hostsPath -Value "`r`n"
    ipconfig /flushdns | Out-Null
    Write-Host "OK - Eliminado redirect de game.boombang.tv" -ForegroundColor Green
}

Write-Host ""
Write-Host "Hosts activos:" -ForegroundColor Cyan
Get-Content $hostsPath | Where-Object { $_ -notmatch '^\s*#' -and $_.Trim() -ne '' }
Write-Host ""
Write-Host "DNS game.boombang.tv:" -ForegroundColor Cyan
Resolve-DnsName game.boombang.tv | Format-Table Name, Type, IPAddress
Write-Host "Presiona Enter para cerrar..."
Read-Host
