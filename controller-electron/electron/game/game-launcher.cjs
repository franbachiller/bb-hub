"use strict";

// Opens the official BoomBang HTML5 client with CDP, injects the Hub runtime
// (ring_scene + flash_runtime) into the game frame and bridges it to the Hub
// :9999 server. Port of HTML5/harness/launch_hub_one_click.ps1 +
// HTML5/hub_runtime/launch_hub_client.js, so the installed Hub works on its own
// (no Node, scripts or .cmd on the customer's PC).

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { safeStorage } = require("electron");
const { HubBridge } = require("./hub-bridge.cjs");

const BACKEND = "https://backend-launcher.boombang.tv";
const CDP_PORT = 9230;
const CDP_TIMEOUT_MS = 30000;
const READY_TIMEOUT_MS = 120000;
const GAME_FRAME_RE = /static\.boombang\.tv\/betahtml5/;
const RING_SCENE_PATH = path.join(__dirname, "ring_scene.page.js");
const RUNTIME_PATH = path.join(__dirname, "flash_runtime.page.js");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function requestJson(url, options) {
  let response;
  try {
    response = await fetch(url, { ...options, signal: AbortSignal.timeout(20000) });
  } catch {
    throw new Error("No se pudo conectar con BoomBang. Revisa tu conexión a internet.");
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("retry-after"));
      throw new Error(`Demasiados intentos de inicio de sesión. Espera ${retryAfter > 0 ? `${retryAfter} s` : "unos minutos"} y vuelve a intentarlo.`);
    }
    if (response.status === 401 || response.status === 403) throw new Error("Usuario o contraseña incorrectos.");
    throw new Error(data?.message || `BoomBang respondió con un error (HTTP ${response.status}).`);
  }
  return data;
}

class GameLauncher extends EventEmitter {
  constructor({ accountPath, clientExe, hubPort, log }) {
    super();
    this.accountPath = accountPath;
    this.clientExe = clientExe;
    this.hubPort = hubPort;
    this.log = typeof log === "function" ? log : () => {};
    this.state = "idle";
    this.message = "";
    this.pendingToken = null;
    this.child = null;
    this.browser = null;
    this.bridge = null;
    this.gameFrame = null;
    this.busy = false;
  }

  snapshot() {
    const account = this.readAccount();
    return {
      state: this.state,
      message: this.message,
      username: account?.username || "",
      hasAccount: Boolean(account),
      clientFound: fs.existsSync(this.clientExe)
    };
  }

  setState(state, message = "") {
    this.state = state;
    this.message = message;
    if (message) this.log(`Juego: ${message}`);
    this.emit("change");
  }

  // ---- Account (stored encrypted with the Windows user's key, DPAPI) --------

  readAccount() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.accountPath, "utf8"));
      if (typeof saved?.username === "string" && typeof saved?.password === "string") return saved;
    } catch {}
    return null;
  }

  saveAccount(username, password) {
    username = String(username || "").trim();
    password = String(password || "");
    if (!username || username.length > 64) throw new Error("Escribe tu usuario de BoomBang.");
    if (!password || password.length > 256) throw new Error("Escribe tu contraseña de BoomBang.");
    if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows no permite guardar la contraseña cifrada en este equipo.");
    const cipher = safeStorage.encryptString(password).toString("base64");
    fs.mkdirSync(path.dirname(this.accountPath), { recursive: true });
    fs.writeFileSync(this.accountPath, JSON.stringify({ username, password: cipher }), { encoding: "utf8", mode: 0o600 });
    this.log(`Cuenta del juego guardada: ${username}`);
    this.emit("change");
    return true;
  }

  forgetAccount() {
    fs.rmSync(this.accountPath, { force: true });
    this.pendingToken = null;
    if (this.state === "twofa") this.setState("idle");
    this.log("Cuenta del juego borrada de este equipo.");
    this.emit("change");
    return true;
  }

  // ---- Launch -----------------------------------------------------------------

  isRunning() {
    return ["login", "twofa", "launching", "injecting", "ready"].includes(this.state);
  }

  async launch() {
    if (this.busy || this.state === "ready") return this.snapshot();
    const account = this.readAccount();
    if (!account) throw new Error("Primero guarda tu cuenta de BoomBang.");
    // An already open game with CDP (a previous Hub session): attach to it.
    if (await this.cdpAvailable()) return this.guard(() => this.attach(account.username, null));
    if (!fs.existsSync(this.clientExe)) {
      throw new Error("No se encontró BoomBang HTML5. Instala el launcher oficial de BoomBang y abre el juego una vez desde ahí.");
    }
    return this.guard(async () => {
      this.setState("login", `Iniciando sesión como ${account.username}…`);
      let password = safeStorage.decryptString(Buffer.from(account.password, "base64"));
      let login;
      try {
        login = await requestJson(`${BACKEND}/auth/login`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username: account.username, password })
        });
      } finally {
        password = null;
      }
      if (login?.status === "2fa_required" && login.pendingToken) {
        this.pendingToken = String(login.pendingToken);
        this.setState("twofa", "BoomBang pide el código de verificación (2FA).");
        return;
      }
      if (login?.status !== "ok" || !login.token) throw new Error("Usuario o contraseña incorrectos.");
      await this.openWithToken(account.username, login.token);
    });
  }

  async submitTwoFactor(code) {
    code = String(code || "").trim();
    if (!/^[0-9A-Za-z]{4,12}$/.test(code)) throw new Error("Escribe el código de verificación.");
    if (this.state !== "twofa" || !this.pendingToken) throw new Error("No hay un inicio de sesión esperando el código.");
    const account = this.readAccount();
    if (!account) throw new Error("Primero guarda tu cuenta de BoomBang.");
    return this.guard(async () => {
      this.setState("login", "Verificando el código…");
      const pendingToken = this.pendingToken;
      this.pendingToken = null;
      const result = await requestJson(`${BACKEND}/auth/2fa`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pendingToken, code })
      });
      if (result?.status !== "ok" || !result.token) throw new Error("Código de verificación inválido.");
      await this.openWithToken(account.username, result.token);
    });
  }

  async guard(task) {
    this.busy = true;
    try {
      await task();
    } catch (error) {
      this.log(`Juego: fallo al abrir: ${error.stack || error.message}`);
      // Close BoomBang only if this launch started it.
      await this.teardown(Boolean(this.child));
      this.setState("error", error.message || "No se pudo abrir el juego.");
    } finally {
      this.busy = false;
    }
    return this.snapshot();
  }

  async openWithToken(username, token) {
    const ticket = await requestJson(`${BACKEND}/clients/2/ticket`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` }
    });
    if (!ticket?.ticket) throw new Error("BoomBang no entregó el ticket de sesión. Vuelve a intentarlo.");
    this.setState("launching", "Abriendo BoomBang…");
    this.child = spawn(this.clientExe, [
      `--sso-ticket=${ticket.ticket}`,
      "--lang=es",
      `--remote-debugging-port=${CDP_PORT}`,
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding"
    ], {
      cwd: path.dirname(this.clientExe),
      env: { ...process.env, BB_HTML5_DEVTOOLS: "1", BB_LANG: "es" },
      shell: false,
      windowsHide: false,
      stdio: "ignore"
    });
    this.child.once("error", (error) => this.log(`Juego: el cliente no arrancó: ${error.message}`));
    await this.attach(username, this.child);
  }

  async cdpAvailable() {
    try {
      const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, { signal: AbortSignal.timeout(800) });
      return response.ok;
    } catch {
      return false;
    }
  }

  async waitForCdp(child) {
    const deadline = Date.now() + CDP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await this.cdpAvailable()) return;
      if (child && child.exitCode != null) break;
      await sleep(250);
    }
    throw new Error("BoomBang no respondió. Si ya estaba abierto, ciérralo y vuelve a intentarlo desde el Hub.");
  }

  findGameFrame(page) {
    return page.frames().find((frame) => GAME_FRAME_RE.test(frame.url())) || null;
  }

  async waitForGame(page) {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const frame = this.findGameFrame(page);
      if (frame) {
        const loaded = await frame.evaluate(() => performance.getEntriesByType("resource")
          .some((entry) => /\/betahtml5\/_astro\/.*\.js(?:[?#].*)?$/.test(entry.name))).catch(() => false);
        if (loaded) return frame;
      }
      await sleep(500);
    }
    throw new Error("El juego tardó demasiado en cargar.");
  }

  async attach(username, child) {
    this.setState("launching", "Esperando a BoomBang…");
    await this.waitForCdp(child);
    const { chromium } = require("playwright-core");
    this.browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
    const pages = this.browser.contexts().flatMap((context) => context.pages());
    const page = pages.find((p) => /boombang/.test(p.url())) || pages[0];
    if (!page) throw new Error("No se encontró la ventana del juego.");

    this.bridge = new HubBridge({
      port: this.hubPort,
      log: (line) => this.log(line),
      onMessage: (msg) => { void this.deliver(msg); },
      onStatus: ({ connected }) => {
        this.gameFrame?.evaluate((value) => window.__BBFlashRuntime?.setHubConnected?.(value), Boolean(connected)).catch(() => {});
      }
    });
    const relay = (obj) => {
      // Combat diagnostics stay off in the distributed Hub.
      if (obj?.type === "diagnostic_event") return;
      this.bridge?.send(obj);
    };
    await page.exposeFunction("__bbHubSend", relay);
    await page.exposeBinding("__bbHubSendBound", (_source, obj) => relay(obj));

    const ringSource = fs.readFileSync(RING_SCENE_PATH, "utf8");
    const flashSource = fs.readFileSync(RUNTIME_PATH, "utf8");
    const runtimeHash = crypto.createHash("sha256").update(ringSource).update(flashSource).digest("hex").slice(0, 16);

    this.setState("injecting", "Cargando el juego…");
    let frame = await this.waitForGame(page);
    // flash_runtime never installs twice in a page: a game left open from an
    // earlier session keeps its old runtime (timing, coco guard) whatever Hub
    // connects. Reload the game when the loaded runtime is not this one.
    const loadedHash = await frame.evaluate(() => (window.__BBFlashRuntime ? window.__bbHubRuntimeHash || "otro" : null)).catch(() => null);
    if (loadedHash && loadedHash !== runtimeHash) {
      this.log("Juego: tenía cargado otro runtime; recargo el juego para usar el de este Hub.");
      await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
      frame = await this.waitForGame(page);
    }
    // The client remembers app mode (bb.isNativeApp) and would keep reporting
    // android-app: clear it and reload once, as launch_hub_client.js does.
    const sticky = await frame.evaluate(() => { try { return localStorage.getItem("bb.isNativeApp"); } catch { return null; } }).catch(() => null);
    if (sticky === "1") {
      await frame.evaluate(() => { try { localStorage.removeItem("bb.isNativeApp"); } catch {} }).catch(() => {});
      await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
      frame = await this.waitForGame(page);
    }

    await page.evaluate(() => {
      if (window.__bbHubRelayInstalled) return;
      window.__bbHubRelayInstalled = true;
      window.addEventListener("message", (event) => {
        const data = event.data;
        if (!data || data.source !== "bb-flash-runtime" || data.type !== "hub_out") return;
        try { if (typeof window.__bbHubSend === "function") window.__bbHubSend(data.payload); } catch {}
      });
    });

    const inject = (target) => target.evaluate(({ ringSource, flashSource, runtimeHash }) => {
      if (typeof window.__bbHubSend !== "function") {
        window.__bbHubSend = (payload) => {
          window.parent.postMessage({ source: "bb-flash-runtime", type: "hub_out", payload }, "*");
        };
      }
      // ring_scene first so __BBFlashRingScene is available to flash_runtime.
      const fresh = !window.__BBFlashRuntime;
      (0, eval)(ringSource);
      (0, eval)(flashSource);
      if (fresh) window.__bbHubRuntimeHash = runtimeHash;
    }, { ringSource, flashSource, runtimeHash });
    await inject(frame);
    // Deliver from now on: the Hub answers the runtime's first messages (configs,
    // allies) while boot() is still running.
    this.gameFrame = frame;
    this.bridge.start();

    let boot = null;
    let lastError = "";
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      // Keep a live frame reference; the shell can recreate the iframe.
      frame = this.findGameFrame(page) || frame;
      this.gameFrame = frame;
      try {
        boot = await frame.evaluate(({ selfUsername }) => window.__BBFlashRuntime.boot({ selfUsername, timeoutMs: 8000 }), { selfUsername: username });
        if (boot?.ready) break;
        lastError = "el juego todavía no está listo";
      } catch (error) {
        lastError = error.message || String(error);
        const hasRuntime = await frame.evaluate(() => Boolean(window.__BBFlashRuntime?.boot)).catch(() => false);
        if (!hasRuntime) await inject(frame).catch(() => {});
      }
      await sleep(1000);
    }
    if (!boot?.ready) throw new Error(`No se pudo conectar el Hub con el juego (${lastError || "tiempo agotado"}).`);
    await frame.evaluate((value) => window.__BBFlashRuntime?.setHubConnected?.(value), Boolean(this.bridge.connected)).catch(() => {});
    this.log(`Juego: runtime ${boot.bridgeBuild || "?"} listo.`);
    this.setState("ready", "Juego conectado.");

    const closed = () => {
      if (this.state !== "ready") return;
      void this.teardown(false).then(() => this.setState("idle", "BoomBang se cerró."));
    };
    this.browser.once("disconnected", closed);
    child?.once("exit", closed);
  }

  async deliver(msg) {
    if (!this.gameFrame) return;
    try {
      await this.gameFrame.evaluate((message) => window.__BBFlashRuntime?.onHubMessage?.(message), msg);
    } catch (error) {
      this.log(`Juego: no se pudo entregar ${msg?.type || "?"}: ${error.message}`);
    }
  }

  // closeGame: also kill a client we started (failed launch). On Hub exit the
  // game stays open; it reconnects when the Hub opens again.
  async teardown(closeGame) {
    this.gameFrame = null;
    try { this.bridge?.stop(); } catch {}
    this.bridge = null;
    const browser = this.browser;
    this.browser = null;
    try { browser?.removeAllListeners("disconnected"); } catch {}
    // close() on a CDP connection can close BoomBang itself: only on a failed launch.
    if (closeGame) {
      try { await browser?.close(); } catch {}
      try { this.child?.kill(); } catch {}
    }
    this.child = null;
  }

  stop() {
    try { this.bridge?.stop(); } catch {}
    this.bridge = null;
  }
}

module.exports = { GameLauncher, CDP_PORT };
