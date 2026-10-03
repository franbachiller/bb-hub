param(
    [ValidateSet("core", "manifest")]
    [string]$Preset = "manifest",
    [switch]$SkipExisting
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = Get-Location
$extractScript = Join-Path $root "tools\extract_bb_launcher_manifest.js"
$fetchScript = Join-Path $root "tools\fetch_bb_assets.ps1"

node $extractScript

$fetchArgs = @(
    "-ExecutionPolicy", "Bypass",
    "-File", $fetchScript,
    "-Preset", $Preset,
    "-ManifestPath", "official_client\manifests\launcher-cache-assets.txt",
    "-OutDir", "official_client\downloads"
)

if ($SkipExisting) {
    $fetchArgs += "-SkipExisting"
}

powershell @fetchArgs
