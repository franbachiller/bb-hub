"use strict";
// BB Hub — puerta de licencia (Cryptlex / LexActivator).
//
// Qué hace:
//  - init(): carga el Product.dat y el Product ID y prepara el callback de
//    sincronización con el server de Cryptlex (el que permite el kill-switch).
//  - status(): dice si la licencia es GENUINA, está en gracia (sin internet un
//    rato), sin activar, vencida, suspendida o revocada.
//  - activate(key) / deactivate(): activa o libera esta PC.
//  - onChange(cb): avisa cuando el server revoca/suspende/vence la licencia EN
//    CALIENTE (lease). main.cjs usa eso para frenar el bot y bloquear la ventana.
//
// La config real (Product ID + Product.dat) se completa desde el panel de
// Cryptlex; ver electron/license/README.md. Sin esos datos, el gate queda en
// modo "NO_CONFIG" y (en build de producción) no deja arrancar.

const path = require("path");
const fs = require("fs");

let LA = null;
let CODES = null;
let FLAGS = null;
let RELEASE_FLAGS = null;
let nativeError = null;
try {
  const mod = require("@cryptlex/lexactivator");
  LA = mod.LexActivator;
  CODES = mod.LexStatusCodes;
  FLAGS = mod.PermissionFlags;
  RELEASE_FLAGS = mod.ReleaseFlags;
} catch (error) {
  nativeError = error;
}

// Estados que entiende el resto de la app.
const STATE = Object.freeze({
  GENUINE: "GENUINE", // licencia OK (incluye gracia tras ActivateLicense)
  GRACE: "GRACE", // genuina pero sin poder sincronizar hace poco (sin internet)
  NOT_ACTIVATED: "NOT_ACTIVATED", // esta PC no tiene licencia todavía
  EXPIRED: "EXPIRED", // venció
  SUSPENDED: "SUSPENDED", // suspendida en el panel
  REVOKED: "REVOKED", // activación borrada/revocada (no pagó → kill-switch)
  GRACE_OVER: "GRACE_OVER", // demasiado tiempo sin sincronizar: se bloquea
  NO_CONFIG: "NO_CONFIG", // falta Product.dat / Product ID (error de empaquetado)
  ERROR: "ERROR"
});

const CONFIG_PATH = path.join(__dirname, "config.json");
const PRODUCT_DAT_PATH = path.join(__dirname, "product.dat");

let config = { productId: "", releaseVersion: "" };
let ready = false;
let initError = null;
const changeListeners = new Set();

function log(message) {
  try {
    const { app } = require("electron");
    const dir = app.isReady() ? app.getPath("userData") : path.join(app.getPath("temp"), "BB Hub");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "license.log"), `[${new Date().toISOString()}] ${message}\n`, "utf8");
  } catch {
    // el log de licencia nunca debe tirar la app
  }
}

function readConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    config.productId = String(raw.productId || "").trim();
    config.releaseVersion = String(raw.releaseVersion || "").trim();
  } catch (error) {
    log(`config.json ilegible: ${error.message}`);
  }
}

// Mapea el número que devuelve IsLicenseGenuine()/Activate() a nuestro estado.
function codeToState(code) {
  if (code === CODES.LA_OK) return STATE.GENUINE;
  if (code === CODES.LA_EXPIRED) return STATE.EXPIRED;
  if (code === CODES.LA_SUSPENDED) return STATE.SUSPENDED;
  if (code === CODES.LA_GRACE_PERIOD_OVER) return STATE.GRACE_OVER;
  // Revocación: la activación ya no existe en el server (no pagó, la borraste).
  if (code === CODES.LA_E_REVOKED || code === CODES.LA_E_ACTIVATION_NOT_FOUND) return STATE.REVOKED;
  return STATE.NOT_ACTIVATED;
}

// El server de Cryptlex contestó una sincronización (lease). Acá cae el
// kill-switch en caliente: si revocaste/suspendiste la licencia, llega un
// código != LA_OK y avisamos a main.cjs para bloquear.
function onServerSync(code) {
  let state;
  try {
    // A network error must respect the signed local activation and its grace
    // period. A suspended/revoked license is still blocked immediately.
    if ([CODES.LA_E_INET, CODES.LA_E_SERVER, CODES.LA_E_RATE_LIMIT].includes(code)) {
      const local = status();
      state = local.state === STATE.GENUINE ? STATE.GRACE : local.state;
    } else state = codeToState(code);
  } catch {
    state = STATE.ERROR;
  }
  log(`server sync → code=${code} state=${state}`);
  for (const cb of changeListeners) {
    try { cb(state, code); } catch { /* ignore */ }
  }
}

function init() {
  if (ready) return { ok: true };
  if (!LA) {
    initError = nativeError;
    log(`módulo nativo no disponible: ${nativeError && nativeError.message}`);
    return { ok: false, state: STATE.ERROR, reason: "native_missing" };
  }
  readConfig();
  let productData = "";
  try {
    productData = fs.readFileSync(PRODUCT_DAT_PATH, "utf8").trim();
  } catch (error) {
    log(`product.dat ausente: ${error.message}`);
  }
  if (!productData || !config.productId || config.productId.startsWith("PEGAR")) {
    return { ok: false, state: STATE.NO_CONFIG, reason: "sin product.dat / productId" };
  }
  try {
    LA.SetProductData(productData);
    // LA_USER: no requiere permisos de admin; guarda la activación por usuario.
    LA.SetProductId(config.productId, FLAGS.LA_USER);
    if (config.releaseVersion) {
      try { LA.SetReleaseVersion(config.releaseVersion); } catch { /* opcional */ }
    }
    LA.SetLicenseCallback(onServerSync);
    ready = true;
    log(`init OK (lib ${LA.GetLibraryVersion ? LA.GetLibraryVersion() : "?"})`);
    return { ok: true };
  } catch (error) {
    initError = error;
    log(`init falló: ${error.message}`);
    return { ok: false, state: STATE.ERROR, reason: error.message };
  }
}

// Estado actual. IsLicenseGenuine() además dispara la sincronización periódica
// con el server respetando el lease definido en la política del panel.
function status() {
  if (!ready) {
    const i = init();
    if (!i.ok) return { state: i.state || STATE.ERROR, reason: i.reason };
  }
  try {
    const code = LA.IsLicenseGenuine();
    return { state: codeToState(code), code };
  } catch (error) {
    // IsLicenseGenuine tira excepción cuando no hay licencia activada.
    const code = typeof error.code === "number" ? error.code : null;
    if (code === CODES.LA_FAIL || code === null) return { state: STATE.NOT_ACTIVATED, code };
    return { state: codeToState(code), code };
  }
}

function activate(licenseKey) {
  if (!ready) {
    const i = init();
    if (!i.ok) return { ok: false, state: i.state || STATE.ERROR, reason: i.reason };
  }
  const key = String(licenseKey || "").trim();
  if (!key) return { ok: false, state: STATE.NOT_ACTIVATED, reason: "clave vacía" };
  try {
    LA.SetLicenseKey(key);
    const code = LA.ActivateLicense();
    const state = codeToState(code);
    log(`activate → code=${code} state=${state}`);
    return { ok: state === STATE.GENUINE, state, code };
  } catch (error) {
    const code = typeof error.code === "number" ? error.code : null;
    log(`activate error code=${code} msg=${error.message}`);
    return { ok: false, state: STATE.ERROR, code, reason: activationReason(code, error.message) };
  }
}

function deactivate() {
  if (!ready) return { ok: false, reason: "sin init" };
  try {
    const code = LA.DeactivateLicense();
    log(`deactivate → code=${code}`);
    return { ok: code === CODES.LA_OK, code };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

// Datos para mostrar en la pantalla de licencia (todo opcional/defensivo).
function info() {
  const out = {};
  if (!ready) return out;
  const safe = (fn) => { try { return fn(); } catch { return null; } };
  out.key = safe(() => LA.GetLicenseKey());
  out.email = safe(() => LA.GetLicenseUserEmail());
  out.name = safe(() => LA.GetLicenseUserName());
  out.expiry = safe(() => LA.GetLicenseExpiryDate()); // epoch segundos (0 = perpetua)
  out.type = safe(() => LA.GetLicenseType());
  out.allowed = safe(() => LA.GetLicenseAllowedActivations());
  out.total = safe(() => LA.GetLicenseTotalActivations());
  return out;
}

function activationReason(code, fallback) {
  const map = {
    [CODES.LA_E_LICENSE_KEY]: "Clave inválida.",
    [CODES.LA_E_ACTIVATION_LIMIT]: "Esta licencia alcanzó el límite de equipos permitidos.",
    [CODES.LA_E_REVOKED]: "La licencia fue revocada.",
    [CODES.LA_SUSPENDED]: "La licencia está suspendida.",
    [CODES.LA_EXPIRED]: "La licencia venció.",
    [CODES.LA_E_PRODUCT_VERSION_NOT_LINKED]: "La licencia no está habilitada para esta versión.",
    [CODES.LA_E_RATE_LIMIT]: "Demasiados intentos. Espera un momento.",
    [CODES.LA_E_SERVER]: "No se pudo contactar al servidor de licencias.",
    [CODES.LA_E_TIME]: "La fecha o la hora del equipo es incorrecta. Corrígela para activar.",
    [CODES.LA_E_TIME_MODIFIED]: "Se detectó manipulación de la fecha del sistema.",
    [CODES.LA_E_MACHINE_FINGERPRINT]: "No se pudo identificar la máquina.",
    [CODES.LA_E_ACTIVATION_CLONE_DETECTED]: "Se detectó una copia de la activación."
  };
  return map[code] || fallback || "No se pudo activar.";
}

function onChange(cb) {
  if (typeof cb === "function") changeListeners.add(cb);
  return () => changeListeners.delete(cb);
}

// Estados en los que la app debe quedar operativa.
function isUsable(state) {
  return state === STATE.GENUINE || state === STATE.GRACE;
}

// Entitlements come from LexActivator's verified activation, never settings/UI.
function hasFeature(name) {
  if (!isUsable(status().state)) return false;
  try {
    const feature = LA.GetFeatureEntitlement(name);
    if (!feature || feature.featureName !== name) return false;
    const expiry = Number(feature.expiresAt || 0);
    if (!Number.isFinite(expiry) || expiry < 0) return false;
    const value = expiry > 0 && Date.now() >= expiry * 1000 ? feature.baseValue : feature.value;
    return String(value).trim().toLowerCase() === "true";
  } catch { return false; }
}

function checkRelease(version) {
  if (!isUsable(status().state)) return Promise.reject(new Error("Se necesita una licencia válida."));
  return new Promise((resolve, reject) => {
    let finished = false;
    const timer = setTimeout(() => {
      finished = true;
      reject(new Error("No se pudo comprobar la actualización. Inténtalo más tarde."));
    }, 30000);
    const finish = (error, release) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(release);
    };
    try {
      LA.SetReleasePlatform("windows");
      LA.SetReleaseChannel("stable");
      LA.SetReleaseVersion(version);
      LA.CheckReleaseUpdate((code, release) => {
        if (code === CODES.LA_RELEASE_UPDATE_AVAILABLE) finish(null, release);
        else if (code === CODES.LA_RELEASE_UPDATE_NOT_AVAILABLE) finish(null, null);
        else if (code === CODES.LA_RELEASE_UPDATE_AVAILABLE_NOT_ALLOWED) finish(new Error("Tu licencia no incluye esta actualización."));
        else finish(new Error("No se pudo comprobar la actualización. Revisa la conexión o contacta con tu distribuidor."));
      }, RELEASE_FLAGS.LA_RELEASES_ALLOWED, null);
    } catch {
      finish(new Error("Las actualizaciones aún no están disponibles. Contacta con tu distribuidor."));
    }
  });
}

function releaseDownloadUrl(file) {
  const url = new URL(file.url);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("URL de actualización inválida.");
  if (file.secured) {
    if (!/^releases(?:\.eu)?\.cryptlex\.com$/.test(url.hostname)) throw new Error("Servidor de descarga no admitido.");
    url.searchParams.set("key", LA.GetLicenseKey());
  }
  return url.href;
}

module.exports = {
  STATE,
  init,
  status,
  activate,
  deactivate,
  info,
  onChange,
  isUsable,
  hasFeature,
  checkRelease,
  releaseDownloadUrl,
  available: () => Boolean(LA)
};
