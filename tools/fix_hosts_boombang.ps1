# fix_hosts_boombang.ps1
# Agrega la entrada de game.boombang.tv al hosts para que el proxy funcione
# Ejecutar como ADMINISTRADOR

$hostsPath = "C:\Windows\System32\drivers\etc\hosts"
$current = Get-Content $hostsPath -Raw

if ($current -match 'game\.boombang\.tv') {
    Write-Host "Ya existe una entrada para game.boombang.tv:" -ForegroundColor Yellow
    Get-Content $hostsPath | Select-String 'game\.boombang\.tv'
    Write-Host ""
    Write-Host "No se realizo ningun cambio." -ForegroundColor Yellow
} else {
    Add-Content -Path $hostsPath -Value "`r`n127.0.0.1`tgame.boombang.tv`t# BOT BB proxy redirect" -Encoding ASCII
    Write-Host "OK - Agregado: 127.0.0.1  game.boombang.tv" -ForegroundColor Green
    Write-Host ""
    Write-Host "Hosts file actual (entradas activas):" -ForegroundColor Cyan
    Get-Content $hostsPath | Where-Object { $_ -notmatch '^#' -and $_.Trim() -ne '' }
}

Write-Host ""
Write-Host "Presiona Enter para cerrar..."
Read-Host
