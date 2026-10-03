param(
    [ValidateSet('opaque','direct','transparent')]
    [string]$WMode = 'opaque',
    [bool]$DisableVoice = $false
)

$launcherDir = Join-Path $env:LOCALAPPDATA 'Programs\BoomBang-Launcher\resources\app.asar.unpacked'
$configPath = Join-Path $launcherDir 'bbhub_perf_config.json'
if (!(Test-Path -LiteralPath $launcherDir)) {
    throw "No existe el directorio del launcher: $launcherDir"
}

[ordered]@{
    wmode = $WMode
    disableVoice = $DisableVoice
    updatedAt = (Get-Date).ToString('s')
} | ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding UTF8

Write-Host "BB Hub launcher perf config actualizada: wmode=$WMode disableVoice=$DisableVoice"
Write-Host "Reinicia BoomBangLauncher para medir este modo."
