param(
    [ValidateSet('opaque','direct','transparent')]
    [string]$WMode = 'opaque',
    [switch]$DisableVoice
)

$launcherDir = Join-Path $env:LOCALAPPDATA 'Programs\BoomBang-Launcher\resources\app.asar.unpacked'
$preloadPath = Join-Path $launcherDir 'preload.js'
$cleanBackupPath = Join-Path $launcherDir 'preload_backup.js'
$configPath = Join-Path $launcherDir 'bbhub_perf_config.json'

if (!(Test-Path -LiteralPath $launcherDir)) {
    throw "No existe el directorio del launcher: $launcherDir"
}
if (!(Test-Path -LiteralPath $preloadPath)) {
    throw "No existe preload.js: $preloadPath"
}

$stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
$backupPath = Join-Path $launcherDir "preload.before_bbhub_perf_$stamp.js"
Copy-Item -LiteralPath $preloadPath -Destination $backupPath -Force

$basePath = if (Test-Path -LiteralPath $cleanBackupPath) { $cleanBackupPath } else { $preloadPath }
$base = Get-Content -LiteralPath $basePath -Raw
$legacyMarker = '// BoomBang Ring Injector v2'
$legacyIndex = $base.IndexOf($legacyMarker)
if ($legacyIndex -ge 0) {
    $base = $base.Substring(0, $legacyIndex).TrimEnd()
}

$config = [ordered]@{
    wmode = $WMode
    disableVoice = [bool]$DisableVoice
    updatedAt = (Get-Date).ToString('s')
}
$config | ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding UTF8

$patch = @'

// BB Hub Performance Patch 20260518
;(function () {
  var config = { wmode: "opaque", disableVoice: false };
  try {
    var fs = require("fs");
    var path = require("path");
    var raw = fs.readFileSync(path.join(__dirname, "bbhub_perf_config.json"), "utf8");
    var parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      config = Object.assign(config, parsed);
    }
  } catch (_) {}

  function normalizedWMode() {
    var mode = String(config.wmode || "opaque").toLowerCase();
    if (mode !== "opaque" && mode !== "direct" && mode !== "transparent") {
      mode = "opaque";
    }
    return mode;
  }

  function patchFlashElement(element) {
    if (!element || !element.setAttribute) return;
    var tag = String(element.tagName || "").toLowerCase();
    var mode = normalizedWMode();
    if (tag === "embed") {
      element.setAttribute("wmode", mode);
      if (!element.getAttribute("quality")) element.setAttribute("quality", "high");
      return;
    }
    if (tag !== "object") return;
    var found = false;
    var params = element.querySelectorAll ? element.querySelectorAll("param") : [];
    for (var i = 0; i < params.length; i++) {
      if (String(params[i].getAttribute("name") || "").toLowerCase() === "wmode") {
        params[i].setAttribute("value", mode);
        found = true;
      }
    }
    if (!found && document && document.createElement) {
      var param = document.createElement("param");
      param.setAttribute("name", "wmode");
      param.setAttribute("value", mode);
      element.appendChild(param);
    }
  }

  function patchExistingFlash() {
    if (!document || !document.querySelectorAll) return;
    var nodes = document.querySelectorAll("embed,object");
    for (var i = 0; i < nodes.length; i++) {
      var src = String(nodes[i].getAttribute("src") || nodes[i].getAttribute("data") || "");
      var type = String(nodes[i].getAttribute("type") || "");
      if (src.indexOf(".swf") >= 0 || type.indexOf("flash") >= 0) {
        patchFlashElement(nodes[i]);
      }
    }
  }

  function patchSwfObject() {
    if (!window.swfobject || window.swfobject.__bbHubPerfPatched || typeof window.swfobject.embedSWF !== "function") {
      return;
    }
    var original = window.swfobject.embedSWF;
    window.swfobject.embedSWF = function (swfUrl, replaceId, width, height, version, xiSwfUrl, flashvars, params, attributes, callback) {
      params = params || {};
      params.wmode = normalizedWMode();
      if (!params.quality) params.quality = "high";
      return original.call(this, swfUrl, replaceId, width, height, version, xiSwfUrl, flashvars, params, attributes, callback);
    };
    window.swfobject.__bbHubPerfPatched = true;
  }

  function removeVoiceScripts(root) {
    if (!config.disableVoice || !root || !root.querySelectorAll) return;
    var scripts = root.querySelectorAll('script[src*="voice-integration"],script[src*="voice"]');
    for (var i = 0; i < scripts.length; i++) {
      try { scripts[i].parentNode.removeChild(scripts[i]); } catch (_) {}
    }
  }

  function tick() {
    patchSwfObject();
    patchExistingFlash();
    removeVoiceScripts(document);
  }

  try {
    window.BBHubSetWMode = function (mode) {
      config.wmode = String(mode || "opaque").toLowerCase();
      tick();
      return normalizedWMode();
    };
    window.BBHubPerfConfig = config;
  } catch (_) {}

  if (document && document.addEventListener) {
    document.addEventListener("DOMContentLoaded", tick, false);
  }
  var started = Date.now();
  var timer = setInterval(function () {
    tick();
    if (Date.now() - started > 8000) clearInterval(timer);
  }, 100);
  try {
    new MutationObserver(function () { tick(); }).observe(document.documentElement || document, { childList: true, subtree: true });
  } catch (_) {}
})();
'@

$newContent = $base.TrimEnd() + "`r`n" + $patch.TrimStart()
Set-Content -LiteralPath $preloadPath -Value $newContent -Encoding UTF8

Write-Host "Launcher preload limpio y parcheado."
Write-Host "Backup: $backupPath"
Write-Host "Config: $configPath"
Write-Host "wmode=$WMode disableVoice=$([bool]$DisableVoice)"
Write-Host "Reinicia BoomBangLauncher para que tome el cambio."
