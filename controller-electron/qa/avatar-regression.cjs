"use strict";
// Exercise the launcher's actual serialized page code in Chromium, including
// the protected ASAR. No game, saved account, licensing or combat is started.
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const assert = require("node:assert/strict");
const base = process.env.BB_PACKAGED_APP_DIR
  ? path.join(process.env.BB_PACKAGED_APP_DIR, "resources/app.asar/electron/game")
  : path.join(__dirname, "../electron/game");
const { GameLauncher } = require(path.join(base, "game-launcher.cjs"));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const portrait = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="60"><rect width="40" height="60" fill="#ff3849"/></svg>');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bb-avatar-"));
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const launcher = new GameLauncher({ accountPath: path.join(directory, "account.json"),
    optionsPath: path.join(directory, "options.json"), captureRoot: directory, clientExe: "", hubPort: 9999 });
  let evaluations = 0, changes = 0;
  launcher.on("change", () => changes++);
  const frame = { evaluate(source) {
    evaluations++;
    assert.equal(typeof source, "string", "page functions must survive bytecode protection");
    return win.webContents.executeJavaScript(source);
  } };
  async function fixture(html) {
    launcher.stopAvatarRead?.();
    launcher.gameFrame = frame;
    await win.loadURL("data:text/html," + encodeURIComponent(html));
  }
  async function ownImage(src) {
    await win.webContents.executeJavaScript(`(async () => {
      const image = new Image(); image.src = ${JSON.stringify(src)};
      await image.decode(); document.getElementById('BoomBangFlowerPowerAvatar').replaceChildren(image);
    })()`);
  }
  try {
    if (process.env.BB_AVATAR_LEGACY === "1") {
      await fixture('<div id="BoomBangFlowerPowerAvatar"></div>');
      await launcher.readAvatar();
      await delay(15000);
      await launcher.readAvatar();
      await delay(2000);
      await ownImage(portrait);
      await delay(100);
      assert.equal(launcher.avatarUrl, "", "released two-read startup misses a late portrait");
      await launcher.readAvatar();
      assert.equal(launcher.avatarUrl, portrait, "same selector/image works when actually read after loading");
      console.log("PASS: official 0.1.12 reproduces the lost portrait after its two startup reads; a later read retrieves it.");
      return;
    }
    await fixture('<img id="fichado"><div id="BoomBangFlowerPowerAvatar"></div>');
    await win.webContents.executeJavaScript(`document.getElementById('fichado').src = ${JSON.stringify(portrait)}`);
    assert.equal(await launcher.readAvatar(), false);
    assert.equal(launcher.avatarUrl, "", "never use the selected rival's image");
    await ownImage(portrait);
    assert.equal(await launcher.readAvatar(), true);
    assert.equal(launcher.avatarUrl, portrait);
    const unchanged = changes;
    assert.equal(await launcher.readAvatar(), true);
    assert.equal(changes, unchanged, "unchanged portraits do not broadcast snapshots");
    console.log("PASS: own keko only; Chromium data image; source-string evaluation; deduplicated snapshots.");

    await fixture('<div id="BoomBangFlowerPowerAvatar"><img src="data:image/png;base64,broken"></div>');
    assert.equal(await launcher.readAvatar(), false);
    assert.equal(launcher.avatarUrl, "", "a broken image must not stop recovery");
    await ownImage(portrait);
    assert.equal(await launcher.readAvatar(), true);
    console.log("PASS: failed image does not latch the initial permanently.");

    await fixture('<div id="BoomBangFlowerPowerAvatar"></div>');
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
    await win.webContents.executeJavaScript(`(async () => {
      const blob = await (await fetch(${JSON.stringify(png)})).blob();
      const image = new Image(); image.src = URL.createObjectURL(blob); await image.decode();
      document.getElementById('BoomBangFlowerPowerAvatar').appendChild(image);
    })()`);
    assert.equal(await launcher.readAvatar(), true);
    assert.ok(launcher.avatarUrl.startsWith("data:image/png;base64,"));
    console.log("PASS: game-local blob becomes portable image bytes for the Hub.");

    // The old launcher read only at t=0 and t=15s. Render the portrait after
    // both opportunities, as happens after asynchronous avatar-service/bake.
    await fixture('<div id="BoomBangFlowerPowerAvatar"></div>');
    launcher.startAvatarRead();
    await delay(17000);
    assert.equal(launcher.avatarUrl, "");
    await ownImage(portrait);
    for (let i = 0; i < 80 && !launcher.avatarUrl; i++) await delay(100);
    assert.equal(launcher.avatarUrl, portrait, "late avatar must recover beyond the old 15s cutoff");
    assert.equal(launcher.avatarTimer, null, "polling stops once the image is available");
    const stopped = evaluations;
    await delay(5200);
    assert.equal(evaluations, stopped, "no ongoing work after successful capture");
    console.log("PASS: keko appearing after 17s is recovered; all polling stops after success.");

    let resolvePending;
    launcher.gameFrame = { evaluate: () => new Promise(resolve => { resolvePending = resolve; }) };
    const pending = launcher.readAvatar();
    launcher.stopAvatarRead();
    resolvePending(portrait);
    assert.equal(await pending, false);
    assert.equal(launcher.avatarUrl, "", "old account/session results cannot restore stale portraits");
    launcher.gameFrame = frame;
    launcher.startAvatarRead();
    launcher.stop();
    await delay(100);
    assert.equal(launcher.avatarUrl, "");
    assert.equal(launcher.avatarTimer, null);
    console.log("PASS: in-flight reads and retry timers are cancelled on stop/account reset.");
    launcher.gameFrame = frame;
    await launcher.readAvatar();
    launcher.forgetAccount();
    assert.equal(launcher.avatarUrl, "");
    console.log("PASS: forgetting an account clears its portrait.");
    console.log("PASS: avatar recovery in " + (process.env.BB_PACKAGED_APP_DIR ? "protected package" : "source launcher") + ".");
  } finally {
    launcher.stop(); win.destroy();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}).then(() => app.exit(0)).catch(error => { console.error(error.stack); app.exit(1); });
