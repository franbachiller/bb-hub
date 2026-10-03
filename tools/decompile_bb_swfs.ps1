param(
    [string[]]$SwfPaths = @(),
    [string]$OutDir = "official_client\decompiled",
    [string]$FfdecPath = "tools\ffdec\app\ffdec-cli.exe",
    [switch]$SkipExisting
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = Get-Location
$ffdec = Join-Path $root $FfdecPath
if (-not (Test-Path $ffdec)) {
    throw "FFDec not found: $ffdec"
}

if ($SwfPaths.Count -eq 0) {
    throw "Provide at least one SWF path."
}

$outputRoot = Join-Path $root $OutDir
New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null

$results = New-Object System.Collections.Generic.List[object]

foreach ($swfPath in $SwfPaths) {
    $fullSwf = if ([System.IO.Path]::IsPathRooted($swfPath)) {
        $swfPath
    } else {
        Join-Path $root $swfPath
    }

    if (-not (Test-Path $fullSwf)) {
        $results.Add([pscustomobject]@{
            Status = "missing"
            Swf = $fullSwf
            Out = ""
        })
        continue
    }

    $swfName = [System.IO.Path]::GetFileNameWithoutExtension($fullSwf)
    $targetDir = Join-Path $outputRoot $swfName

    if ($SkipExisting -and (Test-Path $targetDir) -and (Get-ChildItem $targetDir -Recurse -File -ErrorAction SilentlyContinue | Select-Object -First 1)) {
        $results.Add([pscustomobject]@{
            Status = "skipped"
            Swf = $fullSwf
            Out = $targetDir
        })
        continue
    }

    New-Item -ItemType Directory -Force -Path $targetDir | Out-Null

    try {
        & $ffdec -export script $targetDir $fullSwf | Out-Null
        $results.Add([pscustomobject]@{
            Status = "ok"
            Swf = $fullSwf
            Out = $targetDir
        })
    }
    catch {
        $results.Add([pscustomobject]@{
            Status = "error"
            Swf = $fullSwf
            Out = $targetDir
            Error = $_.Exception.Message
        })
    }
}

$results | Group-Object Status | Sort-Object Name | ForEach-Object {
    "{0}: {1}" -f $_.Name, $_.Count
}

$results | Format-Table -AutoSize
