param(
  [string]$Workbench = "workbench\kernel_rebuild_20260603_current",
  [string]$OutSwf = "MODDED SWF\Kernel.swf"
)

$ErrorActionPreference = "Stop"

$root = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")
$work = Join-Path $root $Workbench
$ffdec = Join-Path $root "tools\ffdec\app\ffdec-cli.exe"
$base = Join-Path $work "Kernel.official.20260603_current.swf"
$patch = Join-Path $work "patch_scripts_clean_step"
$tmp = Join-Path $work "Kernel.clean_step.test.swf"
$out = Join-Path $root $OutSwf

if (!(Test-Path -LiteralPath $ffdec)) { throw "FFDec CLI no encontrado: $ffdec" }
if (!(Test-Path -LiteralPath $base)) { throw "SWF oficial base no encontrada: $base" }

$ifaceDir = Join-Path $patch "src\modules\interfaz"
$dropDir = Join-Path $patch "src\modules\concursos"
New-Item -ItemType Directory -Force -Path $ifaceDir | Out-Null
New-Item -ItemType Directory -Force -Path $dropDir | Out-Null

Copy-Item -LiteralPath (Join-Path $work "scripts\src\modules\interfaz\_je14031.as") -Destination (Join-Path $ifaceDir "_je14031.as") -Force
Copy-Item -LiteralPath (Join-Path $work "scripts\src\modules\concursos\_he13618.as") -Destination (Join-Path $dropDir "_he13618.as") -Force

& $ffdec -importScript $base $tmp $patch
if ($LASTEXITCODE -ne 0) { throw "FFDec importScript falló con código $LASTEXITCODE" }
if (!(Test-Path -LiteralPath $tmp)) { throw "FFDec no generó salida: $tmp" }

if (Test-Path -LiteralPath $out) {
  $stamp = Get-Date -Format "yyyyMMdd_HHmmss"
  Copy-Item -LiteralPath $out -Destination (Join-Path (Split-Path -Parent $out) "Kernel.backup_$stamp.swf") -Force
}

Copy-Item -LiteralPath $tmp -Destination $out -Force
Get-Item -LiteralPath $out | Select-Object FullName,Length,LastWriteTime
