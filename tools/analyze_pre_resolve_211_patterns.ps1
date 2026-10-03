param(
    [string]$LogsRoot = "C:\Users\Fran\Desktop\BOT BB\punch_proxy\logs",
    [int]$SampleLimit = 12,
    [switch]$RingOnly
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

function Format-Counts {
    param([hashtable]$Table)
    return (
        $Table.GetEnumerator() |
            Sort-Object @{ Expression = "Value"; Descending = $true }, @{ Expression = "Key"; Descending = $false } |
            ForEach-Object { "{0}:{1}" -f [string]$_.Key, [int]$_.Value }
    ) -join ", "
}

function Top-Counts {
    param(
        [hashtable]$Table,
        [int]$Limit = 8
    )
    return (
        $Table.GetEnumerator() |
            Sort-Object @{ Expression = "Value"; Descending = $true }, @{ Expression = "Key"; Descending = $false } |
            Select-Object -First $Limit |
            ForEach-Object { "{0}:{1}" -f [string]$_.Key, [int]$_.Value }
    ) -join ", "
}

function Get-OpcodeKey {
    param([object]$Opcode)
    if ($null -eq $Opcode) {
        return ""
    }
    if ($Opcode -is [System.Array]) {
        return (($Opcode | ForEach-Object { [string]$_ }) -join " ")
    }
    return [string]$Opcode
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

function Is-RingResolve {
    param([object]$Event)
    $atkId = [string]$Event.atk_id
    $defId = [string]$Event.def_id
    return $atkId -match "^[0-7]$" -and $defId -match "^[0-7]$"
}

if (-not (Test-Path $LogsRoot)) {
    throw "Logs root not found: $LogsRoot"
}

$immediatePrevDown = @{}
$window100Counts = @{}
$tail3Counts = @{}
$trackedOpcodes = @("146", "182", "144", "135", "163", "175", "200 122")
$trackedOpcodeDeltas = @{}
foreach ($opcode in $trackedOpcodes) {
    $trackedOpcodeDeltas[$opcode] = New-Object System.Collections.Generic.List[double]
}

$samples = New-Object System.Collections.Generic.List[object]
$resolveCount = 0

Get-ChildItem -Path $LogsRoot -Directory | Sort-Object Name | ForEach-Object {
    $runId = $_.Name
    $eventsPath = Join-Path $_.FullName "events.jsonl"
    if (-not (Test-Path $eventsPath)) {
        return
    }

    $downstream = New-Object System.Collections.Generic.List[object]

    Get-Content -Path $eventsPath | ForEach-Object {
        try {
            $evt = $_ | ConvertFrom-Json -ErrorAction Stop
        }
        catch {
            return
        }

        if ($evt.type -eq "DOWN") {
            $downstream.Add(
                [pscustomobject]@{
                    ts_ms = [double]$evt.ts_ms
                    opcode = Get-OpcodeKey $evt.opcode
                    fields_preview = @($evt.fields_preview)
                }
            ) | Out-Null
            return
        }

        if ($evt.type -ne "RESOLVE") {
            return
        }

        if ($RingOnly -and -not (Is-RingResolve $evt)) {
            return
        }

        $resolveCount += 1
        $resolveTsMs = [double]$evt.ts_ms
        $prevDown = @($downstream | Where-Object { $_.ts_ms -le $resolveTsMs })
        if ($prevDown.Count -eq 0) {
            return
        }

        $lastDown = $prevDown[$prevDown.Count - 1]
        Add-Count $immediatePrevDown ([string]$lastDown.opcode)

        $tail3 = (
            $prevDown |
                Select-Object -Last 3 |
                ForEach-Object { [string]$_.opcode }
        ) -join " > "
        Add-Count $tail3Counts $tail3

        foreach ($item in @($prevDown | Where-Object { ($resolveTsMs - $_.ts_ms) -le 100 })) {
            Add-Count $window100Counts ([string]$item.opcode)
        }

        foreach ($opcode in $trackedOpcodes) {
            $lastMatch = $null
            for ($i = $prevDown.Count - 1; $i -ge 0; $i--) {
                if ($prevDown[$i].opcode -eq $opcode) {
                    $lastMatch = $prevDown[$i]
                    break
                }
            }
            if ($null -ne $lastMatch) {
                $trackedOpcodeDeltas[$opcode].Add($resolveTsMs - $lastMatch.ts_ms) | Out-Null
            }
        }

        if ($samples.Count -lt $SampleLimit) {
            $samples.Add(
                [pscustomobject]@{
                    run_id = $runId
                    ts_ms = [int64]$evt.ts_ms
                    prev_down = @(
                        $prevDown |
                            Select-Object -Last 3 |
                            ForEach-Object {
                                [pscustomobject]@{
                                    opcode = [string]$_.opcode
                                    fields_preview = @($_.fields_preview)
                                }
                            }
                    )
                    resolve = [pscustomobject]@{
                        atk_id = [string]$evt.atk_id
                        def_id = [string]$evt.def_id
                        matched_role = [string](Get-EventValue $evt "matched_role")
                        all_fields = @($evt.all_fields)
                    }
                }
            ) | Out-Null
        }
    }
}

Write-Output ("logs_root=" + $LogsRoot)
Write-Output ("ring_only=" + [bool]$RingOnly)
Write-Output ("resolve_count=" + $resolveCount)
Write-Output ("immediate_prev_down=" + (Format-Counts $immediatePrevDown))
Write-Output ("window_100ms_counts=" + (Format-Counts $window100Counts))
Write-Output ("tail3_top=" + (Top-Counts $tail3Counts 8))
foreach ($opcode in $trackedOpcodes) {
    $values = $trackedOpcodeDeltas[$opcode]
    if ($values.Count -eq 0) {
        continue
    }
    $measure = $values | Measure-Object -Average -Minimum -Maximum
    Write-Output (
        "delta_to_last_{0}=count:{1} min:{2} avg:{3} max:{4}" -f
            $opcode,
            $values.Count,
            [Math]::Round([double]$measure.Minimum, 2),
            [Math]::Round([double]$measure.Average, 2),
            [Math]::Round([double]$measure.Maximum, 2)
    )
}
Write-Output "samples:"
$samples | ForEach-Object { $_ | ConvertTo-Json -Compress -Depth 6 }
