param(
    [int]$Seconds = 30
)

function Get-TrackedProcessRows {
    $items = @()
    $names = @('BoomBangLauncher.exe', 'BB Hub.exe', 'Fiddler.exe')
    foreach ($name in $names) {
        $items += Get-CimInstance Win32_Process -Filter "Name='$name'" -ErrorAction SilentlyContinue
    }
    foreach ($item in $items) {
        $proc = Get-Process -Id $item.ProcessId -ErrorAction SilentlyContinue
        if (!$proc) { continue }
        $cmd = [string]$item.CommandLine
        $role = 'main'
        if ($cmd -match '--type=ppapi') { $role = 'ppapi' }
        elseif ($cmd -match '--type=renderer') { $role = 'renderer' }
        elseif ($cmd -match '--type=gpu-process') { $role = 'gpu' }
        [pscustomobject]@{
            Id = $proc.Id
            Name = $proc.ProcessName
            Role = $role
            Cpu = [double]($(if ($null -eq $proc.CPU) { 0 } else { $proc.CPU }))
            WorkingSetMB = [math]::Round($proc.WorkingSet64 / 1MB, 1)
            Priority = $proc.PriorityClass.ToString()
            Command = $cmd
        }
    }
}

$Seconds = [math]::Max(3, [math]::Min(300, $Seconds))
$start = Get-TrackedProcessRows
Start-Sleep -Seconds $Seconds
$end = Get-TrackedProcessRows

$rows = foreach ($after in $end) {
    $before = $start | Where-Object { $_.Id -eq $after.Id } | Select-Object -First 1
    $cpuDelta = if ($before) { [math]::Max(0, $after.Cpu - $before.Cpu) } else { 0 }
    [pscustomobject]@{
        Name = $after.Name
        Id = $after.Id
        Role = $after.Role
        CpuPctOneCore = [math]::Round(($cpuDelta / $Seconds) * 100, 1)
        WorkingSetMB = $after.WorkingSetMB
        Priority = $after.Priority
    }
}

$rows | Sort-Object CpuPctOneCore -Descending | Format-Table -AutoSize
