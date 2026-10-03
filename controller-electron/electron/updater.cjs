const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { Transform, Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { spawn } = require("node:child_process");
const gate = require("./license/gate.cjs");

function newerVersion(candidate, current) {
  if (!/^\d+\.\d+\.\d+(\.\d+)?$/.test(candidate)) return false;
  const a = candidate.split('.').map(Number), b = current.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return false;
}

function createUpdater({ app, onChange, beforeInstall }) {
  let state = { status: "idle", version: app.getVersion(), message: "" };
  let offered = null, busy = false, lastCheck = 0;
  const publish = patch => { state = { ...state, ...patch }; onChange?.(); return { ...state }; };
  const validLicense = () => gate.isUsable(gate.status().state);
  async function downloadResponse(file, timeout = 180000) {
    let url = gate.releaseDownloadUrl(file), response;
    for (let redirects = 0; redirects <= 5; redirects++) {
      response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(timeout) });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location || redirects === 5) throw new Error("No se pudo descargar la actualización.");
      const next = new URL(location, url);
      if (next.protocol !== "https:" || next.username || next.password) throw new Error("Redirección de actualización inválida.");
      url = next.href;
    }
    if (!response.ok || !response.body) throw new Error("No se pudo descargar la actualización.");
    return response;
  }
  async function check() {
    if (busy || Date.now() - lastCheck < 30000) return { ...state };
    busy = true;
    lastCheck = Date.now();
    offered = null;
    publish({ status: "checking", message: "Comprobando actualizaciones…" });
    try {
      const release = await gate.checkRelease(app.getVersion());
      if (!validLicense()) throw new Error("Se necesita una licencia válida.");
      if (!release || !newerVersion(release.version, app.getVersion())) return publish({ status: "current", message: "Tienes la versión más reciente." });
      const canonicalName = `BB Hub Setup ${release.version}.exe`;
      // Cryptlex external files forbid spaces, while hosted NSIS files retain them.
      const names = [canonicalName, `BB-Hub-Setup-${release.version}.exe`, `BB_Hub_Setup_${release.version}.exe`];
      const installers = (release.files || []).filter(f => names.includes(f.name));
      if (installers.length > 1) throw new Error("La actualización contiene varios instaladores de Windows x64.");
      const file = installers[0];
      if (!file) throw new Error("La actualización no incluye el instalador de Windows x64.");
      let checksum = String(file.checksum || "");
      if (!/^[a-f0-9]{64}$/i.test(checksum)) {
        const manifest = (release.files || []).find(f => f.name === "SHA256.txt" && Number.isSafeInteger(f.size) && f.size > 0 && f.size <= 65536);
        if (!manifest) throw new Error("La actualización necesita un checksum SHA256 válido o el archivo SHA256.txt.");
        const response = await downloadResponse(manifest, 30000);
        let bytes = 0; const chunks = [];
        for await (const chunk of Readable.fromWeb(response.body)) {
          bytes += chunk.length;
          if (bytes > 65536) throw new Error("Archivo SHA256 demasiado grande.");
          chunks.push(chunk);
        }
        const entries = Buffer.concat(chunks).toString("utf8").split(/\r?\n/).map(line => line.trim().match(/^([a-f0-9]{64})\s+\*?(.+)$/i)).filter(Boolean);
        // An external alias still distributes the original NSIS installer.
        const matches = entries.filter(match => match[2] === file.name || match[2] === canonicalName);
        if (new Set(matches.map(match => match[1].toLowerCase())).size > 1) throw new Error("SHA256.txt contiene hashes contradictorios.");
        checksum = matches[0]?.[1] || "";
        if (!/^[a-f0-9]{64}$/i.test(checksum)) throw new Error("SHA256.txt no contiene el hash de este instalador.");
      }
      if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > 512 * 1024 * 1024) throw new Error("Tamaño de actualización inválido.");
      gate.releaseDownloadUrl(file); // Validate privately. URLs/keys never enter the renderer.
      offered = { version: release.version, file: { ...file, checksum } };
      return publish({ status: "available", nextVersion: release.version, message: `Versión ${release.version} disponible.` });
    } catch (error) { return publish({ status: "error", message: error.message }); }
    finally { busy = false; }
  }
  async function install() {
    if (busy || !offered || !validLicense()) throw new Error("Comprueba primero si hay una actualización disponible.");
    busy = true;
    let folder;
    let motorStopped = false;
    try {
      publish({ status: "downloading", message: "Descargando actualización…" });
      folder = fs.mkdtempSync(path.join(app.getPath("temp"), "bb-hub-update-"));
      const installer = path.join(folder, "BB-Hub-Update.exe");
      const response = await downloadResponse(offered.file);
      let bytes = 0;
      const hash = crypto.createHash("sha256");
      const verify = new Transform({ transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > offered.file.size) { callback(new Error("Tamaño de actualización incorrecto.")); return; }
        hash.update(chunk); callback(null, chunk);
      } });
      await pipeline(Readable.fromWeb(response.body), verify, fs.createWriteStream(installer, { flags: "wx" }));
      if (bytes !== offered.file.size || hash.digest("hex") !== offered.file.checksum.toLowerCase()) throw new Error("La verificación SHA256 falló. La actualización no se instalará.");
      if (!validLicense()) throw new Error("Se necesita una licencia válida.");
      await beforeInstall();
      motorStopped = true;
      const child = spawn(installer, [], { detached: true, stdio: "ignore", windowsHide: false });
      await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
      child.unref();
      publish({ status: "installing", message: "Se abrirá el instalador y BB Hub se cerrará." });
      app.quit();
      return { ...state };
    } catch {
      // Never expose request URLs or license keys through transport errors.
      if (folder && path.dirname(path.resolve(folder)) === path.resolve(app.getPath("temp")) && path.basename(folder).startsWith("bb-hub-update-")) fs.rmSync(folder, { recursive: true, force: true });
      offered = null;
      return publish({ status: "error", message: motorStopped ? "No se pudo abrir el instalador. El motor se ha detenido; reinicia BB Hub para continuar." : "No se pudo descargar o verificar la actualización. Comprueba la conexión y el espacio disponible, y vuelve a intentarlo." });
    } finally { busy = false; }
  }
  return { check, install, snapshot: () => ({ ...state }) };
}
module.exports = { createUpdater, newerVersion };
