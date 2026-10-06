const path = require("path");
const fs = require("fs");
const { app, BrowserWindow, globalShortcut, ipcMain, shell, dialog } = require("electron");
const { ControllerCore } = require("./controller-core.cjs");
const gate = require("./license/gate.cjs");
const { normalizeHotkey } = require("./hotkey.cjs");
const { createUpdater } = require("./updater.cjs");
const { GameLauncher } = require("./game/game-launcher.cjs");

const APP_ICON = path.join(__dirname, "assets", process.platform === "win32" ? "icon.ico" : "icon.png");

let mainWindow = null;
let licenseWindow = null;
let core = null;
let ringBoardStarted = false;
let pendingSnapshot = null;
let appStarted = false;
let runtimeAllowed = false;
let licenseTimer = null;
let licenseWindowReady = false;
let pendingLicensePayload = null;
let registeredTimingHotkey = "";
let updater = null;
let launcher = null;
let updateTimer = null;

app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("disable-gpu-compositing");
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
app.setAppUserModelId("local.bb.hub");

// Production never accepts a development URL or a debugging endpoint.
if (app.isPackaged) {
  for (const flag of ["remote-debugging-port", "remote-debugging-pipe", "inspect", "inspect-brk"]) app.commandLine.removeSwitch(flag);
  for (const name of ["ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "VITE_DEV_SERVER_URL", "BB_SKIP_LICENSE", "BB_NO_OBF"]) delete process.env[name];
}

function trustedSender(event, window) {
  return Boolean(window && !window.isDestroyed() && event.sender === window.webContents &&
    event.senderFrame === window.webContents.mainFrame);
}

function protectWindow(window) {
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", event => event.preventDefault());
  window.webContents.on("will-attach-webview", event => event.preventDefault());
}

function currentLicense() {
  if (!app.isPackaged && process.env.BB_SKIP_LICENSE === "1") return { state: gate.STATE.GENUINE };
  try { return gate.status(); } catch { return { state: gate.STATE.ERROR }; }
}

function requireRuntimeLicense() {
  const state = currentLicense().state;
  if (!runtimeAllowed || !gate.isUsable(state)) {
    if (runtimeAllowed) lockDownRuntime(state);
    throw new Error("Se necesita una licencia válida para usar BB Hub.");
  }
}

function appLog(message) {
  try {
    const dir = app.isReady() ? app.getPath("userData") : path.join(app.getPath("temp"), "BB Hub");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "startup.log"), `[${new Date().toISOString()}] ${message}\n`, "utf8");
  } catch {
    // Startup logging must never block the app window.
  }
}

function windowIsHidden() {
  return !mainWindow ||
    mainWindow.isDestroyed() ||
    mainWindow.isMinimized() ||
    !mainWindow.isVisible();
}

function sendSnapshot(snapshot) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  if (windowIsHidden()) {
    pendingSnapshot = snapshot || true;
    return;
  }
  pendingSnapshot = null;
  try {
    mainWindow.webContents.send("controller:snapshot", { ...snapshot, updates: updater?.snapshot(), game: launcher?.snapshot() });
  } catch (error) {
    appLog(`snapshot send failed: ${error.message}`);
  }
}

function flushPendingSnapshot() {
  if (!core || windowIsHidden()) {
    return;
  }
  try {
    sendSnapshot(core.snapshot());
  } catch (error) {
    appLog(`snapshot flush failed: ${error.message}`);
  }
}

function showMainWindow() {
  if (!runtimeAllowed) return;
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
  setTimeout(flushPendingSnapshot, 50);
}

const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  app.quit();
}

async function startBundledRingBoard() {
  if (!gate.hasFeature("ring_board")) return;
  if (ringBoardStarted) {
    return;
  }
  const serverPath = path.join(__dirname, "ring-board", "dist", "server.js");
  try {
    // Node 24 supports synchronous ESM loading. Unlike import(), require()
    // works from bytenode's VM context without a dynamic-import callback.
    require(serverPath);
    ringBoardStarted = true;
    appLog("ring-board server started");
    core?.log("Ring-board server en 127.0.0.1:18444 / 18445");
  } catch (error) {
    appLog(`ring-board startup failed: ${error.stack || error.message}`);
    core?.log(`AVISO: no se pudo iniciar ring-board: ${error.message}`);
  }
}

function createWindow() {
  appLog("createWindow");
  mainWindow = new BrowserWindow({
    width: 1260,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: "#f4f1e9",
    center: true,
    show: true,
    autoHideMenuBar: true,
    icon: APP_ICON,
    title: "BB Hub",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged
    }
  });
  protectWindow(mainWindow);

  mainWindow.once("ready-to-show", () => {
    appLog("ready-to-show");
    showMainWindow();
  });
  mainWindow.webContents.on("did-finish-load", () => appLog("did-finish-load"));
  mainWindow.webContents.on("preload-error", (_event, _preload, error) => { appLog(`preload-error ${error.message}`); app.quit(); });
  mainWindow.webContents.on("did-fail-load", (_event, code, description, url) => {
    appLog(`did-fail-load code=${code} description=${description} url=${url}`);
    showMainWindow();
  });
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    appLog(`render-process-gone ${JSON.stringify(details)}`);
  });
  mainWindow.on("unresponsive", () => appLog("window unresponsive"));
  mainWindow.on("minimize", () => {
    pendingSnapshot = true;
  });
  mainWindow.on("restore", () => setTimeout(flushPendingSnapshot, 80));
  mainWindow.on("show", () => setTimeout(flushPendingSnapshot, 80));
  mainWindow.on("closed", () => {
    appLog("window closed");
    mainWindow = null;
  });

  if (!app.isPackaged && process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "dist-ui", "index.html"));
  }

  setTimeout(showMainWindow, 1200);
}

function wireIpc() {
  const handle = (channel, callback) => ipcMain.handle(channel, (event, ...args) => {
    if (!trustedSender(event, mainWindow)) throw new Error("Solicitud no autorizada.");
    requireRuntimeLicense();
    return callback(event, ...args);
  });
  handle("controller:getSnapshot", () => { appLog("renderer handshake OK"); return { ...core.snapshot(), updates: updater?.snapshot(), game: launcher?.snapshot() }; });
  handle("controller:checkUpdates", () => updater.check());
  handle("controller:installUpdate", () => updater.install());
  handle("controller:applyTiming", (_event, payload) => core.applyTiming(payload || {}));
  handle("controller:setTimingHotkey", (_event, value) => setTimingHotkey(value));
  handle("controller:applyMovePunch", (_event, payload) => core.applyMovePunch(payload || {}));
  handle("controller:applyDropHunter", (_event, payload) => core.applyDropHunter(payload || {}));
  handle("controller:saveDraftConfig", (_event, mode, payload) => core.saveDraftConfig(mode, payload || {}));
  handle("controller:resetTickAuto", () => core.resetTickAuto());
  handle("controller:setTickAim", (_event, value) => core.setTickAim(value));
  handle("controller:applyExit", (_event, payload) => core.applyExit(payload || {}));
  handle("controller:applyStepWalk", (_event, payload) => core.applyStepWalk(payload || {}));
  handle("controller:applyFreeFire", (_event, payload) => core.applyFreeFire(payload || {}));
  handle("controller:setAllies", (_event, value) => core.setAllies(value));
  handle("controller:toggleAlly", (_event, value) => core.toggleAlly(value && typeof value === "object" ? { accountId: value.accountId, name: value.name } : null));
  handle("controller:addAllyByName", (_event, name) => core.addAllyByName(typeof name === "string" ? name : ""));
  handle("controller:removeAlly", (_event, value) => core.removeAlly(value && typeof value === "object" ? { accountId: value.accountId, name: value.name } : null));
  handle("controller:getPortraits", () => core.getPortraits());
  handle("controller:setAutoRun", (_event, value) => core.setAutoRun(value));
  handle("controller:setEmotes", (_event, value) => core.setEmotes(value));
  handle("controller:setCocoSelf", (_event, mode) => core.setCocoSelf(mode));
  handle("controller:setCocoSelfKey", (_event, code) => core.setCocoSelfKey(code));
  handle("controller:cocoSelfNow", () => core.cocoSelfNow());
  handle("controller:setAdvanced", (_event, value) => core.setAdvanced(value));
  handle("controller:setRequeueKey", (_event, value) => core.setRequeueKey(value));
  handle("controller:requeueNow", () => core.requeueNow());
  handle("controller:resetExit", () => core.resetExit());
  handle("controller:setRingBoardArmed", (_event, value) => core.setRingBoardArmed(value));
  handle("controller:ringBoardAction", (_event, action, value) => core.setRingBoardOption(action, value));
  handle("controller:setPunchPackets", (_event, packets) => core.setPunchPackets(packets));
  handle("controller:selectTarget", (_event, targetId) => core.selectTarget(targetId));
  handle("controller:rawPunch", () => core.rawPunch());
  handle("controller:stopModes", () => core.stopModes());
  handle("controller:clearLogs", () => core.clearLogs());
  handle("game:launch", () => launcher.launch());
  handle("game:submitCode", (_event, code) => launcher.submitTwoFactor(typeof code === "string" ? code : ""));
  handle("game:saveAccount", (_event, username, password) => launcher.saveAccount(typeof username === "string" ? username : "", typeof password === "string" ? password : ""));
  handle("game:forgetAccount", () => launcher.forgetAccount());
  handle("game:findClient", () => launcher.findClient());
  handle("game:selectClient", async () => {
    if (launcher.busy || launcher.isRunning()) throw new Error("Cierra el juego antes de cambiar la instalación.");
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Seleccionar BoomBang HTML5",
      defaultPath: launcher.clientExe || undefined,
      properties: ["openFile"],
      filters: [{ name: "BoomBang HTML5 (BoomBangHTML5.exe)", extensions: ["exe"] }]
    });
    if (result.canceled || !result.filePaths[0]) return launcher.snapshot();
    return launcher.selectClient(result.filePaths[0]);
  });
  handle("game:setDiagnostics", (_event, enabled) => launcher.setDiagnostics(enabled === true));
  handle("game:openCaptures", () => {
    const dir = path.join(app.getPath("userData"), "combate");
    fs.mkdirSync(dir, { recursive: true });
    return shell.openPath(dir);
  });

  core.on("snapshot", (snapshot) => {
    sendSnapshot(snapshot);
  });
}

function setTimingHotkey(value, persist = true) {
  const accelerator = normalizeHotkey(value);
  if (accelerator && [core.cocoSelfKey, core.requeueKey].includes(accelerator)) throw new Error("Ese atajo ya se usa para coco propio o reinscripción. Elige otro.");
  if (accelerator !== registeredTimingHotkey) {
    if (accelerator && !globalShortcut.register(accelerator, () => {
      try { requireRuntimeLicense(); } catch { return; }
      core?.toggleHotkeyMode("TIMING");
    })) throw new Error("Ese atajo está ocupado por otra aplicación. Elige otro.");
    if (registeredTimingHotkey) globalShortcut.unregister(registeredTimingHotkey);
    registeredTimingHotkey = accelerator;
  }
  core.timingHotkey = accelerator;
  if (persist) core.persistSettings();
  core.emitSnapshot();
  return accelerator;
}

function registerHotkeys() {
  try { setTimingHotkey(core.timingHotkey, false); }
  catch (error) { core.log(error.message); }
}

function syncBoardAccess() {
  if (!core || !runtimeAllowed) return;
  if (core.enforceBoardLicense()) void startBundledRingBoard();
  core.emitSnapshot();
}

// ---- Licencia (Cryptlex) -------------------------------------------------------
function createLicenseWindow() {
  if (licenseWindow && !licenseWindow.isDestroyed()) return licenseWindow;
  licenseWindowReady = false;
  licenseWindow = new BrowserWindow({
    width: 440,
    height: 460,
    resizable: false,
    maximizable: false,
    minimizable: true,
    fullscreenable: false,
    frame: false,
    transparent: false,
    backgroundColor: "#111111",
    hasShadow: true,
    center: true,
    show: false,
    skipTaskbar: false,
    icon: APP_ICON,
    title: "BB Hub",
    webPreferences: {
      preload: path.join(__dirname, "license", "license-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged
    }
  });
  protectWindow(licenseWindow);
  licenseWindow.loadFile(path.join(__dirname, "license", "license-window.html"));
  licenseWindow.once("ready-to-show", () => licenseWindow.show());
  licenseWindow.on("closed", () => { licenseWindow = null; licenseWindowReady = false; });
  return licenseWindow;
}

function sendLicenseState(payload) {
  pendingLicensePayload = payload;
  if (licenseWindow && !licenseWindow.isDestroyed() && licenseWindowReady) {
    try { licenseWindow.webContents.send("license:state", payload); } catch { /* ignore */ }
  }
}

function openLicenseWindow(payload) {
  const info = (() => { try { return gate.info(); } catch { return {}; } })();
  createLicenseWindow();
  sendLicenseState(Object.assign({ info }, payload));
}

function closeLicenseWindow() {
  if (licenseWindow && !licenseWindow.isDestroyed()) {
    const w = licenseWindow;
    licenseWindow = null;
    licenseWindowReady = false;
    try { w.close(); } catch { /* ignore */ }
  }
}

// Revocación/vencimiento en caliente: frena el bot y bloquea la ventana.
function lockDownRuntime(state) {
  if (!runtimeAllowed) return;
  runtimeAllowed = false;
  globalShortcut.unregisterAll();
  registeredTimingHotkey = "";
  appLog(`lockdown en caliente: ${state}`);
  try { core?.suspendForLicense(); } catch (error) { appLog(`bloqueo del motor falló: ${error.message}`); app.quit(); }
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
  if (licenseWindow && !licenseWindow.isDestroyed() && licenseWindowReady) {
    try { licenseWindow.webContents.send("license:locked", state); } catch { /* ignore */ }
    try { licenseWindow.show(); } catch { /* ignore */ }
  } else {
    openLicenseWindow({ mode: "locked", state });
  }
}

function startApp() {
  const state = currentLicense().state;
  if (!gate.isUsable(state)) { openLicenseWindow({ mode: "locked", state }); return; }
  if (appStarted) {
    if (!runtimeAllowed) { core.start(); runtimeAllowed = true; registerHotkeys(); }
    closeLicenseWindow();
    showMainWindow();
    return;
  }
  appStarted = true;
  runtimeAllowed = true;
  closeLicenseWindow();
  appLog("startApp (licencia OK)");
  core = new ControllerCore({
    autoPort: true,
    settingsPath: path.join(app.getPath("userData"), "settings.json")
  });
  updater = createUpdater({ app, onChange: () => sendSnapshot(core.snapshot()), beforeInstall: () => {
    requireRuntimeLicense();
    core.suspendForLicense();
    globalShortcut.unregisterAll();
    registeredTimingHotkey = "";
  } });
  // Replaces ABRIR_HUB_Y_CONTROLLER.cmd: the Hub opens BoomBang itself.
  launcher = new GameLauncher({
    accountPath: path.join(app.getPath("userData"), "game-account.json"),
    optionsPath: path.join(app.getPath("userData"), "game-options.json"),
    captureRoot: path.join(app.getPath("userData"), "combate"),
    clientExe: path.join(app.getPath("appData"), "boombang-launcher", "clients", "2", "BoomBangHTML5.exe"),
    clientRoots: [
      path.join(app.getPath("appData"), "boombang-launcher"),
      path.join(process.env.LOCALAPPDATA || path.resolve(app.getPath("appData"), "..", "Local"), "boombang-launcher")
    ],
    hubPort: core.port,
    resolveHubPort: () => core.waitForTcpReady(),
    isRuntimeConnected: (bridge, build) => Boolean(core.swfSocket &&
      core.swfAddr?.port === bridge.socket?.localPort && core.bridgeBuild === build),
    log: (line) => core.log(line)
  });
  launcher.on("change", () => sendSnapshot(core.snapshot()));
  launcher.on("portrait", (portrait) => core.notePortrait(portrait));
  wireIpc();
  core.start();
  void startBundledRingBoard();
  createWindow();
  registerHotkeys();
  setTimeout(() => {
    // ABRIR_HUB_VIEJO.cmd (dev only): the HTML5 .cmd opens the game, not the Hub.
    const noGame = !app.isPackaged && process.env.BB_HUB_NO_GAME === "1";
    if (runtimeAllowed && !noGame && launcher.readAccount()) launcher.launch().catch((error) => core.log(`Juego: ${error.message}`));
  }, 1500);
  setTimeout(() => { if (runtimeAllowed) void updater.check(); }, 5000);
  updateTimer = setInterval(() => { if (runtimeAllowed) void updater.check(); }, 6 * 60 * 60 * 1000);
}

// Decide: arrancar la app, pedir activación o bloquear.
function gateAndStart() {
  if (!app.isPackaged && process.env.BB_SKIP_LICENSE === "1") {
    appLog("licencia OMITIDA (BB_SKIP_LICENSE=1)");
    startApp();
    return;
  }
  // El server manda en caliente: si revoca/suspende/vence, frená el bot; si
  // vuelve a ponerse buena mientras está la pantalla de licencia, arrancá solo.
  gate.onChange((state) => {
    if (!gate.isUsable(state) && runtimeAllowed) lockDownRuntime(state);
    else if (gate.isUsable(state) && !runtimeAllowed) startApp();
    if (gate.isUsable(state)) syncBoardAccess();
  });
  licenseTimer = setInterval(() => {
    const state = currentLicense().state;
    if (runtimeAllowed && !gate.isUsable(state)) lockDownRuntime(state);
    if (runtimeAllowed) syncBoardAccess();
  }, 15000);
  let st;
  try { st = gate.status(); } catch (error) { st = { state: gate.STATE.ERROR, reason: error.message }; }
  appLog(`estado licencia al arrancar: ${st.state}`);
  if (gate.isUsable(st.state)) { startApp(); return; }
  if (st.state === gate.STATE.NOT_ACTIVATED) openLicenseWindow({ mode: "activate" });
  else openLicenseWindow({ mode: "locked", state: st.state });
}

function wireLicenseIpc() {
  ipcMain.on("license:ready", (event) => {
    if (trustedSender(event, licenseWindow)) {
      licenseWindowReady = true;
      if (pendingLicensePayload) {
        try { licenseWindow.webContents.send("license:state", pendingLicensePayload); } catch { /* ignore */ }
      }
    }
  });
  ipcMain.handle("license:activate", (event, key) => {
    if (!trustedSender(event, licenseWindow)) throw new Error("Solicitud no autorizada.");
    if (typeof key !== "string" || key.length > 256) return { ok: false, reason: "Clave inválida." };
    const res = gate.activate(key);
    if (res.ok) setTimeout(startApp, 400);
    return res;
  });
  ipcMain.handle("license:recheck", (event) => {
    if (!trustedSender(event, licenseWindow)) throw new Error("Solicitud no autorizada.");
    let st;
    try { st = gate.status(); } catch (error) { st = { state: gate.STATE.ERROR, reason: error.message }; }
    if (gate.isUsable(st.state)) { setTimeout(startApp, 300); return { ok: true, state: st.state }; }
    return { ok: false, state: st.state };
  });
  ipcMain.on("license:quit", event => { if (trustedSender(event, licenseWindow)) app.quit(); });
  ipcMain.on("license:minimize", event => {
    if (!trustedSender(event, licenseWindow)) return;
    if (licenseWindow && !licenseWindow.isDestroyed()) licenseWindow.minimize();
  });
}

app.on("second-instance", () => {
  appLog("second-instance");
  if (runtimeAllowed) showMainWindow();
  else if (licenseWindow && !licenseWindow.isDestroyed()) { licenseWindow.show(); licenseWindow.focus(); }
});

process.on("uncaughtException", (error) => {
  appLog(`uncaughtException ${error.stack || error.message}`);
});

process.on("unhandledRejection", (error) => {
  appLog(`unhandledRejection ${error?.stack || error}`);
});

if (singleInstanceLock) {
app.whenReady().then(() => {
  appLog("app ready");
  wireLicenseIpc();
  gateAndStart();

  app.on("activate", () => {
    if (runtimeAllowed && BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else if (runtimeAllowed) {
      showMainWindow();
    } else if (licenseWindow && !licenseWindow.isDestroyed()) {
      licenseWindow.show();
    }
  });
}).catch((error) => {
  appLog(`whenReady failed ${error.stack || error.message}`);
});
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  clearInterval(licenseTimer);
  clearInterval(updateTimer);
  globalShortcut.unregisterAll();
  launcher?.stop();
  if (core) {
    core.stop();
  }
});
