param(
    [string]$Tag = (Get-Date -Format "yyyyMMdd"),
    [string]$BaseUrl = "https://static.boombang.tv/21032026_prod/Kernel.swf",
    [string]$OldExport = "official_client\decompiled\Kernel_06052026",
    [string]$OutRoot = "official_client\downloads",
    [string]$ExportRoot = "official_client\decompiled",
    [string]$ReportRoot = "tmp\kernel_update_analysis",
    [switch]$SkipDownload,
    [switch]$SkipExport
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$ffdec = Join-Path $root "tools\ffdec\app\ffdec-cli.exe"
$analyzer = Join-Path $root "tools\kernel_update_analyzer.js"

if (-not (Test-Path $ffdec)) {
    throw "FFDEC CLI not found: $ffdec"
}
if (-not (Test-Path $analyzer)) {
    throw "Analyzer not found: $analyzer"
}

$downloadDir = Join-Path $root (Join-Path $OutRoot "check_$Tag")
$swfPath = Join-Path $downloadDir "Kernel.server.$Tag`_prod.swf"
$exportDir = Join-Path $root (Join-Path $ExportRoot "Kernel_$Tag")
$reportDir = Join-Path $root (Join-Path $ReportRoot $Tag)
$oldExportFull = Join-Path $root $OldExport

New-Item -ItemType Directory -Force -Path $downloadDir | Out-Null
New-Item -ItemType Directory -Force -Path $reportDir | Out-Null

if (-not $SkipDownload) {
    $cacheBust = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $url = "${BaseUrl}?t=$cacheBust"
    $temp = "$swfPath.download"
    Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue
    Write-Host "Downloading $url"
    Invoke-WebRequest -Uri $url -OutFile $temp -UseBasicParsing
    $bytes = [System.IO.File]::ReadAllBytes($temp)
    if ($bytes.Length -lt 3) {
        throw "Downloaded file is too small: $temp"
    }
    $sig = [System.Text.Encoding]::ASCII.GetString($bytes, 0, 3)
    if ($sig -notin @("FWS", "CWS", "ZWS")) {
        Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue
        throw "Invalid SWF signature '$sig' from $url"
    }
    Move-Item -Force -LiteralPath $temp -Destination $swfPath
}

$hash = Get-FileHash $swfPath -Algorithm SHA256
Write-Host "Kernel: $swfPath"
Write-Host "SHA256: $($hash.Hash)"

if (-not $SkipExport) {
    if (Test-Path $exportDir) {
        Remove-Item -LiteralPath $exportDir -Recurse -Force
    }
    Write-Host "Exporting scripts to $exportDir"
    & $ffdec -export script $exportDir $swfPath
    if ($LASTEXITCODE -ne 0) {
        throw "FFDEC export failed with exit code $LASTEXITCODE"
    }
}

Write-Host "Analyzing old=$oldExportFull new=$exportDir"
node $analyzer --old $oldExportFull --new $exportDir --out $reportDir
if ($LASTEXITCODE -ne 0) {
    throw "Analyzer failed with exit code $LASTEXITCODE"
}

Write-Host ""
Write-Host "Report files:"
Get-ChildItem -Path $reportDir | Select-Object FullName, Length, LastWriteTime
