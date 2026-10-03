$launcherDir = Join-Path $env:LOCALAPPDATA 'Programs\BoomBang-Launcher\resources\app.asar.unpacked'
$preloadPath = Join-Path $launcherDir 'preload.js'
$cleanBackupPath = Join-Path $launcherDir 'preload_backup.js'

if (!(Test-Path -LiteralPath $cleanBackupPath)) {
    throw "No existe backup limpio: $cleanBackupPath"
}

$stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
$backupPath = Join-Path $launcherDir "preload.before_restore_$stamp.js"
Copy-Item -LiteralPath $preloadPath -Destination $backupPath -Force
Copy-Item -LiteralPath $cleanBackupPath -Destination $preloadPath -Force

Write-Host "preload.js restaurado desde preload_backup.js"
Write-Host "Backup previo: $backupPath"
Write-Host "Reinicia BoomBangLauncher."
