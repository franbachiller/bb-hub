"use strict";
// Hub 0.1.26 "Disparo": T+ manual 0-100 (T+10 by default, the 30/09 prime) and clicks
// per shot 1-20 (1 by default; the 30/09 runtime caps a burst at 20). Old settings get
// these defaults once; Ultimate Pelx and Modo Grilla stay gone from the Hub.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { ControllerCore } = require("../electron/controller-core.cjs");

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "bb-shot-config-qa-"));
const make = (name, saved) => {
  const settingsPath = path.join(profile, `${name}.json`);
  if (saved) fs.writeFileSync(settingsPath, JSON.stringify(saved));
  return { core: new ControllerCore({ ringBoard: false, settingsPath }), settingsPath };
};
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
let passed = 0;
function check(name, fn) { fn(); passed++; console.log("PASS " + name); }

check("a fresh Hub aims at T+10 with one click per shot and a second click +105", () => {
  const { core } = make("fresh");
  assert.equal(core.tickAim, 10);
  assert.deepEqual(core.advanced, { burst: 1, repeatMs: 105, sweep: true, reactive: true });
  const tick = core.singleTiming(true).tick;
  assert.equal(tick.offsetMs, 10);
  assert.equal(tick.auto, false, "the learned Auto never moves the aim");
});

check("settings from 0.1.25 or older move to the 0.1.26 defaults once", () => {
  const { core, settingsPath } = make("old", { timingDefaultsRev: "0.1.25", tickAim: 8, advanced: { burst: 5, repeatMs: 0, sweep: true, reactive: true }, emotes: true, gridMode: true, pelx: { enabled: true } });
  assert.equal(core.tickAim, 10);
  assert.equal(core.advanced.burst, 1);
  assert.equal(core.advanced.repeatMs, 105);
  core.persistSettings();
  const saved = read(settingsPath);
  assert.equal(saved.timingDefaultsRev, "0.1.26");
  assert.equal(saved.tickAim, 10);
  for (const key of ["emotes", "gridMode", "pelx", "pelxHotkey"]) assert.equal(key in saved, false, `${key} is not saved any more`);
});

check("a user's own 0.1.26 values survive a restart", () => {
  const { core, settingsPath } = make("own", { timingDefaultsRev: "0.1.26", tickAim: 23, advanced: { burst: 7, repeatMs: 110, sweep: false, reactive: true } });
  assert.equal(core.tickAim, 23);
  assert.deepEqual(core.advanced, { burst: 7, repeatMs: 110, sweep: false, reactive: true });
  core.persistSettings();
  const again = new ControllerCore({ ringBoard: false, settingsPath });
  assert.equal(again.tickAim, 23);
  assert.equal(again.advanced.burst, 7);
});

check("T+ is bounded to 0-100 and falls back to T+10", () => {
  const { core } = make("aim");
  for (const [input, want] of [[0, 0], [8, 8], [100, 100], [150, 100], [-5, 0], [12.6, 13], [null, 10], ["", 10], ["auto", 10]]) {
    core.setTickAim(input);
    assert.equal(core.tickAim, want, `setTickAim(${JSON.stringify(input)})`);
  }
});

check("clicks per shot are bounded to 1-20 and reach the runtime", () => {
  const { core } = make("burst");
  const sent = [];
  core.sendToSwf = (message) => sent.push(message);
  for (const [input, want] of [[1, 1], [7, 7], [20, 20], [250, 20], [0, 1]]) {
    core.setAdvanced({ burst: input });
    assert.equal(core.advanced.burst, want, `burst ${input}`);
    assert.equal(sent.filter((m) => m.type === "tick_burst_config").at(-1).count, want);
  }
});

check("the snapshot and the core carry no Pelx, Modo Grilla or emotes", () => {
  const { core } = make("snapshot");
  const snap = core.snapshot();
  for (const key of ["pelx", "pelxHotkey", "gridMode", "emotes"]) assert.equal(key in snap, false, key);
  assert.equal(snap.tickAim, 10);
  assert.equal(snap.punchIsolationPhase, null);
  for (const method of ["applyPelx", "pushPelx", "disablePelx", "applyGridMode", "setEmotes", "pushEmotes"]) assert.equal(typeof core[method], "undefined", method);
});

check("the 30/09 runtime takes a 20-click burst and knows no Pelx or grid", () => {
  const source = fs.readFileSync(path.join(__dirname, "../electron/game/flash_runtime.page.js"), "utf8");
  assert.equal(/pelx|gridMode|grid_mode/i.test(source), false);
  const ctx = vm.createContext({ TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, t: 1000,
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    document: { hidden: false }, __bbHubSend() {} });
  vm.runInContext("globalThis.window = globalThis; globalThis.performance = {now: () => t};", ctx);
  vm.runInContext(source, ctx);
  const api = ctx.__BBFlashRuntime;
  api.onHubMessage({ type: "tick_burst_config", count: 20 });
  assert.equal(api.status().tickAdv.burst, 20);
  api.onHubMessage({ type: "tick_burst_config", count: 500 });
  assert.equal(api.status().tickAdv.burst, 20, "capped at 20");
  assert.equal("pelx" in api.status(), false);
});

fs.rmSync(profile, { recursive: true, force: true });
console.log(`${passed} PASS`);
