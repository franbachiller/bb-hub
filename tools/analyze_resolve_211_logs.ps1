param(
    [string]$LogsRoot = "C:\Users\Fran\Desktop\BOT BB\punch_proxy\logs",
    [int]$SampleLimit = 12
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Add-Count {
    param(
        [hashtable]$Table,
        [string]$Key
    )
    if (-not $Table.ContainsKey($Key)) {
        $Table[$Key] = 0
    }
    $Table[$Key] += 1
}

function Get-EventValue {
    param(
        [object]$Event,
        [string]$Name
    )
    $prop = $Event.PSObject.Properties[$Name]
    if ($null -eq $prop) {
        return ""
    }
    return $prop.Value
}

function Format-Counts {
    param([hashtable]$Table)
    return (
        $Table.GetEnumerator() |
            Sort-Object @{ Expression = "Value"; Descending = $true }, @{ Expression = "Key"; Descending = $false } |
            ForEach-Object { "{0}:{1}" -f [string]$_.Key, [int]$_.Value }
    ) -join ", "
}

if (-not (Test-Path $LogsRoot)) {
    throw "Logs root not found: $LogsRoot"
}

$slot1 = @{}
$slot2 = @{}
$slot6 = @{}
$lengths = @{}
$matchedRole = @{}
$targetCorrectCounts = @{}
$runsWithResolve = New-Object System.Collections.Generic.HashSet[string]
$samples = New-Object System.Collections.Generic.List[object]
$resolveCount = 0
$resolveContextCount = 0

Get-ChildItem -Path $LogsRoot -Directory | Sort-Object Name | ForEach-Object {
    $runId = $_.Name
    $eventsPath = Join-Path $_.FullName "events.jsonl"
    if (-not (Test-Path $eventsPath)) {
        return
    }
    Get-Content -Path $eventsPath | ForEach-Object {
        try {
            $evt = $_ | ConvertFrom-Json -ErrorAction Stop
        }
        catch {
            return
        }

        if ($evt.type -eq "RESOLVE") {
            $resolveCount += 1
            [void]$runsWithResolve.Add($runId)
            $fields = @($evt.all_fields)
            Add-Count $lengths ([string]$fields.Count)
            if ($fields.Count -gt 1) { Add-Count $slot1 ([string]$fields[1]) }
            if ($fields.Count -gt 2) { Add-Count $slot2 ([string]$fields[2]) }
            if ($fields.Count -gt 6) { Add-Count $slot6 ([string]$fields[6]) }
            Add-Count $matchedRole ([string](Get-EventValue $evt "matched_role"))

            if ($samples.Count -lt $SampleLimit) {
                $samples.Add(
                    [pscustomobject]@{
                        run_id = $runId
                        ts_ms = [int64](Get-EventValue $evt "ts_ms")
                        atk_id = [string](Get-EventValue $evt "atk_id")
                        def_id = [string](Get-EventValue $evt "def_id")
                        my_scene_id = [string](Get-EventValue $evt "my_scene_id")
                        matched_role = [string](Get-EventValue $evt "matched_role")
                        all_fields = @($fields)
                    }
                ) | Out-Null
            }
            return
        }

        if ($evt.type -eq "RESOLVE_CONTEXT") {
            $resolveContextCount += 1
            Add-Count $targetCorrectCounts ([string](Get-EventValue $evt "target_correct"))
        }
    }
}

Write-Output ("logs_root=" + $LogsRoot)
Write-Output ("runs_with_resolve=" + $runsWithResolve.Count)
Write-Output ("resolve_count=" + $resolveCount)
Write-Output ("resolve_context_count=" + $resolveContextCount)
Write-Output ("field_lengths=" + (Format-Counts $lengths))
Write-Output ("slot_1_counts=" + (Format-Counts $slot1))
Write-Output ("slot_2_counts=" + (Format-Counts $slot2))
Write-Output ("slot_6_counts=" + (Format-Counts $slot6))
Write-Output ("matched_role_counts=" + (Format-Counts $matchedRole))
Write-Output ("resolve_context_target_correct=" + (Format-Counts $targetCorrectCounts))
Write-Output "samples:"
$samples | ForEach-Object { $_ | ConvertTo-Json -Compress -Depth 6 }
