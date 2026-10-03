param(
    [ValidateSet("core", "manifest")]
    [string]$Preset = "core",
    [string]$BaseUrl = "https://static.boombang.tv/21032026_prod/",
    [string]$ManifestPath = "official_client/manifests/launcher-cache-assets.txt",
    [string]$OutDir = "official_client/downloads",
    [string]$ReportPath = "",
    [int]$Limit = 0,
    [switch]$SkipExisting
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-CoreAssetList {
    return @(
        "BBLoad.swf",
        "Kernel.swf",
        "dswmedia/commons/commonLibrary.swf",
        "dswmedia/commons/ledScreenLibrary.swf",
        "dswmedia/commons/audioLibrary.swf",
        "dswmedia/config/objects/functionality.xml",
        "dswmedia/config/notifications/notifications.xml",
        "dswmedia/config/locale/es_ES.xml",
        "dswmedia/config/locale/lang_es.xml",
        "dswmedia/interfaz/personsResources.swf",
        "dswmedia/interfaz/baseChat/baseChat.swf",
        "dswmedia/interfaz/intercambios_001.swf",
        "dswmedia/interfaz/compraObjetos_001.swf",
        "dswmedia/interfaz/editObject.swf",
        "dswmedia/interfaz/editSkin.swf",
        "dswmedia/interfaz/mochila_001.swf",
        "dswmedia/interfaz/previewObjects.swf",
        "dswmedia/interfaz/fichaAvatar.swf",
        "dswmedia/interfaz/interfazLlaves.swf",
        "dswmedia/interfaz/tomarFoto.swf",
        "dswmedia/gui/userSetupMenu.swf",
        "dswmedia/member/FichaMember.swf",
        "dswmedia/noticias/FichaNoticias.swf",
        "dswmedia/notificaciones/paneles_notificaciones.swf",
        "dswmedia/chooseScene/PersonajeCayendo01.swf",
        "dswmedia/chooseScene/barraInferior.swf",
        "dswmedia/chooseScene/concursosFP.swf",
        "dswmedia/chooseScene/fichas/fichaBienvenido.swf",
        "dswmedia/chooseScene/fichas/fichaPrepagos.swf",
        "dswmedia/chooseScene/fichas/fichaMarketingViral.swf",
        "dswmedia/chooseScene/fichas/fichaBaneo.swf",
        "dswmedia/chooseScene/fichas/fichaRecuperarCuenta.swf",
        "dswmedia/chooseScene/fichas/fichaUnderAgeCreation.swf",
        "dswmedia/chooseScene/fichas/fichaDialogoBicho.swf",
        "dswmedia/chooseScene/skinNormal/backGround.swf",
        "dswmedia/chooseScene/skinNormal/foreGround.swf",
        "dswmedia/chooseScene/skinNormal/flor.swf",
        "dswmedia/chooseScene/skinNormal/marikita.swf",
        "dswmedia/chooseScene/skinNormal/cajaRegalo.swf"
    )
}

function Resolve-AssetUrl {
    param([string]$Item)

    if ([string]::IsNullOrWhiteSpace($Item)) {
        return $null
    }

    $trimmed = $Item.Trim()
    if ($trimmed -match "^https?://") {
        $uri = [System.Uri]$trimmed
        $builder = [System.UriBuilder]::new($uri)
        $builder.Path = ($builder.Path -replace "/{2,}", "/")
        return $builder.Uri.AbsoluteUri
    }

    $relative = $trimmed.TrimStart("/") -replace "/{2,}", "/"
    $root = $BaseUrl.TrimEnd("/") + "/"
    return $root + $relative
}

function Resolve-RelativeOutputPath {
    param([string]$Url)

    $uri = [System.Uri]$Url
    $path = $uri.AbsolutePath -replace "/{2,}", "/"
    if ($path -match "/21032026_prod/(.+)$") {
        return $Matches[1]
    }
    return [System.IO.Path]::GetFileName($path)
}

function Test-DownloadedAsset {
    param(
        [string]$FilePath,
        [string]$Url
    )

    $bytes = [System.IO.File]::ReadAllBytes($FilePath)
    if ($bytes.Length -eq 0) {
        return $false
    }

    if ($Url -match "\.swf(?:\?|$)") {
        if ($bytes.Length -lt 3) {
            return $false
        }
        $sig = [System.Text.Encoding]::ASCII.GetString($bytes, 0, 3)
        return $sig -in @("FWS", "CWS", "ZWS")
    }

    if ($Url -match "\.xml(?:\?|$)") {
        $headLength = [Math]::Min(64, $bytes.Length)
        $head = [System.Text.Encoding]::UTF8.GetString($bytes, 0, $headLength).Trim()
        return $head.StartsWith("<")
    }

    return $true
}

function Get-DownloadList {
    if ($Preset -eq "core") {
        return Get-CoreAssetList | ForEach-Object { Resolve-AssetUrl $_ }
    }

    $manifestFullPath = Join-Path (Get-Location) $ManifestPath
    if (-not (Test-Path $manifestFullPath)) {
        throw "Manifest not found: $manifestFullPath"
    }

    return Get-Content $manifestFullPath |
        Where-Object { $_ -match "\.(swf|xml)(?:\?|$)" } |
        ForEach-Object { Resolve-AssetUrl $_ } |
        Sort-Object -Unique
}

$downloadList = Get-DownloadList
if ($Limit -gt 0) {
    $downloadList = $downloadList | Select-Object -First $Limit
}

$outRoot = Join-Path (Get-Location) $OutDir
New-Item -ItemType Directory -Force -Path $outRoot | Out-Null

$results = New-Object System.Collections.Generic.List[object]
$ProgressPreference = "SilentlyContinue"

foreach ($url in $downloadList) {
    $relative = Resolve-RelativeOutputPath $url
    $relativeWindows = $relative -replace "/", "\"
    $destination = Join-Path $outRoot $relativeWindows
    $destinationDir = Split-Path -Parent $destination
    New-Item -ItemType Directory -Force -Path $destinationDir | Out-Null

    if ($SkipExisting -and (Test-Path $destination)) {
        $results.Add([pscustomobject]@{
            Status = "skipped"
            Url = $url
            Path = $destination
        })
        continue
    }

    $tempFile = "$destination.download"
    try {
        Invoke-WebRequest -Uri $url -OutFile $tempFile

        if (-not (Test-DownloadedAsset -FilePath $tempFile -Url $url)) {
            Remove-Item -Force $tempFile -ErrorAction SilentlyContinue
            $results.Add([pscustomobject]@{
                Status = "invalid"
                Url = $url
                Path = $destination
            })
            continue
        }

        Move-Item -Force $tempFile $destination
        $results.Add([pscustomobject]@{
            Status = "ok"
            Url = $url
            Path = $destination
        })
    }
    catch {
        Remove-Item -Force $tempFile -ErrorAction SilentlyContinue
        $results.Add([pscustomobject]@{
            Status = "error"
            Url = $url
            Path = $destination
            Error = $_.Exception.Message
        })
    }
}

$grouped = $results | Group-Object Status | Sort-Object Name
$grouped | ForEach-Object {
    "{0}: {1}" -f $_.Name, $_.Count
}

$resolvedReportPath = $ReportPath
if ([string]::IsNullOrWhiteSpace($resolvedReportPath)) {
    $resolvedReportPath = "official_client/manifests/fetch-$Preset-report.json"
}
$reportFullPath = Join-Path (Get-Location) $resolvedReportPath
$reportDir = Split-Path -Parent $reportFullPath
New-Item -ItemType Directory -Force -Path $reportDir | Out-Null

$reportObject = [pscustomobject]@{
    preset = $Preset
    baseUrl = $BaseUrl
    manifestPath = $ManifestPath
    outDir = $OutDir
    limit = $Limit
    skipExisting = [bool]$SkipExisting
    summary = ($grouped | ForEach-Object {
        [pscustomobject]@{
            status = $_.Name
            count = $_.Count
        }
    })
    results = $results
}

$reportObject | ConvertTo-Json -Depth 6 | Set-Content -Encoding UTF8 $reportFullPath
"report: $reportFullPath"

$results | Select-Object -First 20 | Format-Table -AutoSize
