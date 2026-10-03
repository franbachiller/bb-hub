param(
    [switch]$Aggressive,
    [switch]$IncludeFiddler,
    [switch]$Watch,
    [int]$IntervalSeconds = 5
)

function Set-PrioritySafe {
    param(
        [System.Diagnostics.Process]$Process,
        [string]$Priority,
        [string]$Label
    )
    try {
        $Process.PriorityClass = $Priority
        [pscustomobject]@{
            Process = $Process.ProcessName
            Id = $Process.Id
            Role = $Label
            Priority = $Process.PriorityClass.ToString()
            Ok = $true
        }
    } catch {
        [pscustomobject]@{
            Process = $Process.ProcessName
            Id = $Process.Id
            Role = $Label
            Priority = $Priority
            Ok = $false
        }
    }
}

function Invoke-BBPerfBoost {
    $targetFlashPriority = if ($Aggressive) { 'High' } else { 'AboveNormal' }
    $targetRendererPriority = 'AboveNormal'
    $targetHubPriority = 'BelowNormal'
    $rows = @()

    $boom = Get-CimInstance Win32_Process -Filter "Name='BoomBangLauncher.exe'" -ErrorAction SilentlyContinue
    foreach ($procInfo in $boom) {
        $proc = Get-Process -Id $procInfo.ProcessId -ErrorAction SilentlyContinue
        if (!$proc) { continue }
        $cmd = [string]$procInfo.CommandLine
        if ($cmd -match '--type=ppapi') {
            $rows += Set-PrioritySafe -Process $proc -Priority $targetFlashPriority -Label 'Flash PPAPI'
        } elseif ($cmd -match '--type=gpu-process') {
            $rows += Set-PrioritySafe -Process $proc -Priority $targetRendererPriority -Label 'GPU'
        } elseif ($cmd -match '--type=renderer') {
            $rows += Set-PrioritySafe -Process $proc -Priority $targetRendererPriority -Label 'Renderer'
        } else {
            $rows += Set-PrioritySafe -Process $proc -Priority 'AboveNormal' -Label 'Main'
        }
    }

    Get-Process -Name 'BB Hub' -ErrorAction SilentlyContinue | ForEach-Object {
        $rows += Set-PrioritySafe -Process $_ -Priority $targetHubPriority -Label 'BB Hub'
    }

    if ($IncludeFiddler) {
        Get-Process -Name 'Fiddler','Fiddler Everywhere' -ErrorAction SilentlyContinue | ForEach-Object {
            $rows += Set-PrioritySafe -Process $_ -Priority 'BelowNormal' -Label 'Fiddler'
        }
    }

    $rows
}

do {
    $rows = Invoke-BBPerfBoost
    if (!$rows.Count) {
        Write-Host "No encontre procesos de BoomBangLauncher/BB Hub activos."
    } else {
        if ($Watch) {
            Clear-Host
            Write-Host "BB perf boost activo - $(Get-Date -Format 'HH:mm:ss') - Ctrl+C para cerrar"
        }
        $rows | Sort-Object Process, Role | Format-Table -AutoSize
    }
    if ($Watch) {
        Start-Sleep -Seconds ([math]::Max(1, $IntervalSeconds))
    }
} while ($Watch)
