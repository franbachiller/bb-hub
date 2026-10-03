$mutex = New-Object System.Threading.Mutex($false, 'Global\BBHubPerfBoostDaemon')
if (-not $mutex.WaitOne(0, $false)) {
    exit 0
}

try {
    $boostScript = Join-Path $PSScriptRoot 'bb_perf_boost.ps1'
    while ($true) {
        try {
            & $boostScript | Out-Null
        } catch {
            # Keep the daemon alive; process priorities are best-effort.
        }
        Start-Sleep -Seconds 5
    }
} finally {
    $mutex.ReleaseMutex() | Out-Null
    $mutex.Dispose()
}
