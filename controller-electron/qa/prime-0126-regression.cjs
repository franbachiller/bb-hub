"use strict";
// 0.1.26 (27/10): the Hub ships the 30/09 runtime (v6_44_silent_gap) byte for byte and
// configures it as on 30/09: T+10 manual, one request, one click, second click +105 at
// the same rival (T+115), sweep and reaction on. Feeds the Hub's real connect messages into
// the shipped runtime and checks the runtime's own state.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { ControllerCore } = require("../electron/controller-core.cjs");

const RUNTIME = path.join(__dirname, "../electron/game/flash_runtime.page.js");
const PRIME_SHA256 = "2ba9151ab4c2ff77fdfc7cbaf442d5a593c7ec09ba51e24f666a01eda82d2ac8";
let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log("PASS " + name); }
const socket = () => ({ messages: [], destroyed: false,
  write(text) { this.messages.push(JSON.parse(text.slice(0, -1))); },
  destroy() { this.destroyed = true; }
});
const waitConfigs = () => new Promise((resolve) => setTimeout(resolve, 400));

function runtime() {
  const source = fs.readFileSync(RUNTIME, "utf8");
  const ctx = vm.createContext({ TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, console: { log() {}, warn() {}, error() {} },
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    document: { hidden: false, addEventListener() {} }, addEventListener() {}, __bbHubSend() {} });
  vm.runInContext("globalThis.window = globalThis; globalThis.performance = { now: () => 1000 };", ctx);
  vm.runInContext(source, ctx);
  return ctx.__BBFlashRuntime;
}

async function connectMessages(saved) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "bb-0126-qa-"));
  const settingsPath = path.join(profile, "settings.json");
  if (saved) fs.writeFileSync(settingsPath, JSON.stringify(saved));
  const core = new ControllerCore({ ringBoard: false, settingsPath });
  const peer = socket();
  core.registerSwfSocket(peer, { host: "qa", port: 1 });
  await waitConfigs();
  core.applyTiming({ enabled: true }); // the user turns TIMING on (F1 / button)
  await waitConfigs();
  const out = { core: { tickAim: core.tickAim, advanced: { ...core.advanced } }, messages: peer.messages };
  core.stop();
  return out;
}

function applyTo(rt, messages) {
  for (const m of messages) rt.onHubMessage(m);
  return rt.status();
}

(async () => {
  await check("the Hub packages the 30/09 runtime byte for byte", () => {
    // LF bytes: a CRLF checkout (core.autocrlf) is the same file.
    const sha = crypto.createHash("sha256").update(fs.readFileSync(RUNTIME, "utf8").replace(/\r\n/g, "\n")).digest("hex");
    assert.equal(sha, PRIME_SHA256);
    assert.match(fs.readFileSync(RUNTIME, "utf8"), /BRIDGE_BUILD = "29092026_html5_hub_v6_44_silent_gap"/);
  });

  for (const [label, saved] of [
    ["a new install", null],
    ["a 0.1.25 install (T+8, no second click)", { timingOn: true, timingDefaultsRev: "0.1.25", tickAim: 8, advanced: { burst: 1, repeatMs: 0, sweep: false, reactive: true } }]
  ]) {
    await check(`${label} configures the runtime as on 30/09`, async () => {
      const { core, messages } = await connectMessages(saved);
      assert.equal(core.tickAim, 10);
      assert.deepEqual(core.advanced, { burst: 1, repeatMs: 105, sweep: true, reactive: true });
      const s = applyTo(runtime(), messages);
      const tick = s.timing.tick;
      assert.equal(s.timing.enabled, true);
      assert.equal(tick.enabled, true);
      assert.equal(tick.offsetMs, 10);
      assert.equal(tick.auto, false);
      assert.equal(tick.single, true);
      assert.equal(tick.shots, 1);
      assert.equal(tick.blind, true);
      assert.equal(tick.reactive, true);
      assert.equal(s.punchPackets, 1);
      assert.equal(s.tickAdv.burst, 1);
      assert.equal(s.tickAdv.repeatMs, 105);
      assert.equal(s.tickAdv.sweep, true);
    });
  }

  await check("the Hub launches the game without wire observer, priority boost or portrait polling", () => {
    const src = fs.readFileSync(path.join(__dirname, "../electron/game/game-launcher.cjs"), "utf8");
    assert.ok(src.includes('if (process.env.BB_WIRE_OBSERVER !== "1") return Promise.resolve();'));
    const attach = src.slice(src.indexOf("this.startAvatarRead();"), src.indexOf("void this.startWire();"));
    assert.equal(attach.includes("this.startPriorityBoost()"), false);
    assert.equal(attach.includes("this.startPortraitRead()"), false);
  });

  console.log(`${passed} prime 0.1.26 checks passed`);
})().catch((error) => { console.error("FAIL", error); process.exit(1); });
