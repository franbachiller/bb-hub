"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { ControllerCore } = require("../electron/controller-core.cjs");

const mainSource = fs.readFileSync(path.join(__dirname, "../electron/main.cjs"), "utf8").replace(/\r\n/g, "\n");
const gateStart = mainSource.indexOf("function punchIsolationPhaseFromEnvironment(");
const gateEnd = mainSource.indexOf("\n}\n", gateStart) + 2;
assert.ok(gateStart >= 0 && gateEnd > gateStart, "the source-only gate must be present");
const phaseFromEnv = vm.runInNewContext(`(${mainSource.slice(gateStart, gateEnd)})`);
let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log("PASS " + name); }
const saved = {
  timingOn: true, tickAim: 23,
  advanced: { reactive: true, sweep: true, repeatMs: 110, burst: 5 },
  stepWalk: false, freeFire: true, cocoSelfMode: "off", emotes: false
};
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "bb-punch-isolation-qa-"));
const settingsPath = path.join(profile, "settings.json");
const savedBytes = JSON.stringify(saved);
fs.writeFileSync(settingsPath, savedBytes);
const make = (phase) => new ControllerCore({ ringBoard: false, settingsPath, punchIsolationPhase: phase });
const socket = () => ({ messages: [], destroyed: false,
  write(text) { this.messages.push(JSON.parse(text.slice(0, -1))); },
  destroy() { this.destroyed = true; }
});
const waitConfigs = () => new Promise(resolve => setTimeout(resolve, 280));

(async () => {
  await check("isolation is opt-in via env only; by default launches run the real adaptive Timing", () => {
    for (const flag of [undefined, "", "0", "true", 1]) {
      assert.equal(phaseFromEnv(false, { BB_TIMING_PUNCH_ISOLATION: flag }), null);
      assert.equal(phaseFromEnv(true, { BB_TIMING_PUNCH_ISOLATION: flag }), null, "packaged default is also real Timing");
    }
    assert.ok(mainSource.includes("punchIsolationPhase: punchIsolationPhaseFromEnvironment(app.isPackaged)"));
  });
  await check("with the isolation env set, valid decimal phases are bounded and invalid phases default to 13", () => {
    for (const [raw, expected] of [[undefined,13], ["",13], ["13",13], [" -20 ",-20], ["40",40], ["13.5",13.5], [".5",.5], ["41",13], ["-21",13], ["Infinity",13], ["NaN",13], ["0x10",13], ["1;throw Error()",13]]) {
      assert.equal(phaseFromEnv(false, { BB_TIMING_PUNCH_ISOLATION: "1", BB_TIMING_PUNCH_ISOLATION_PHASE: raw }), expected, String(raw));
      assert.equal(phaseFromEnv(true, { BB_TIMING_PUNCH_ISOLATION: "1", BB_TIMING_PUNCH_ISOLATION_PHASE: raw }), expected, "packaged " + raw);
    }
  });
  await check("the Core option is numeric and launch-only, without coercing saved values", () => {
    for (const phase of [undefined, null, "13", NaN, Infinity, -21, 41]) {
      const core = make(phase); assert.equal(core.punchIsolationPhase, null); core.stop();
    }
    for (const phase of [13, -20, 40, 13.5]) {
      const core = make(phase); assert.equal(core.punchIsolationPhase, phase); core.stop();
    }
    assert.equal(fs.readFileSync(settingsPath, "utf8"), savedBytes);
  });
  await check("each connection installs the overlay before saved Timing without changing preferences", async () => {
    const normal = make(null), core = make(13);
    const expected = { advanced: JSON.stringify(normal.advanced), desiredTiming: JSON.stringify(normal.desiredTiming), tickAim: normal.tickAim };
    normal.stop();
    const first = socket(); core.registerSwfSocket(first, { host: "qa", port: 1 });
    assert.deepEqual(first.messages[0], { type: "punch_isolation_config", enabled: true, phaseMs: 13 });
    await waitConfigs();
    assert.ok(first.messages.some(m => m.type === "timing_config" && m.enabled));
    assert.equal(first.messages.filter(m => m.type === "punch_isolation_config").length, 1);
    const second = socket(); core.registerSwfSocket(second, { host: "qa", port: 2 });
    assert.equal(first.destroyed, true);
    assert.deepEqual(second.messages[0], { type: "punch_isolation_config", enabled: true, phaseMs: 13 });
    await waitConfigs();
    assert.equal(JSON.stringify(core.advanced), expected.advanced);
    assert.equal(JSON.stringify(core.desiredTiming), expected.desiredTiming);
    assert.equal(core.tickAim, expected.tickAim);
    assert.equal(fs.readFileSync(settingsPath, "utf8"), savedBytes);
    core.stop();
  });
  await check("normal launches retain the regular config and send no experimental command", async () => {
    const core = make(null), peer = socket(); core.registerSwfSocket(peer, { host: "qa", port: 3 });
    await waitConfigs();
    assert.ok(peer.messages.some(m => m.type === "timing_config" && m.enabled));
    assert.equal(peer.messages.some(m => m.type === "punch_isolation_config"), false);
    assert.equal(fs.readFileSync(settingsPath, "utf8"), savedBytes);
    core.stop();
  });
  await check("the isolated launcher uses source Electron and preserves the license and account flow", () => {
    const trial = fs.readFileSync(path.resolve(__dirname, "../../ABRIR_TIMING_PUNCH_AISLADO.cmd"), "utf8");
    assert.ok(trial.includes('set "BB_TIMING_PUNCH_ISOLATION=1"'));
    assert.ok(trial.includes('set "BB_TIMING_PUNCH_ISOLATION_PHASE=13"'));
    assert.ok(trial.includes('node_modules\\electron\\dist\\electron.exe'));
    assert.ok(trial.includes('IMAGENAME eq BoomBangHTML5.exe'));
    assert.equal(/BB_SKIP_LICENSE|BB_HUB_NO_GAME|copy\s|settings\.json|game-account\.json/i.test(trial), false);
    const normal = fs.readFileSync(path.resolve(__dirname, "../../ABRIR_TIMING_PRUEBA.cmd"), "utf8");
    assert.ok(normal.includes('set "BB_TIMING_PUNCH_ISOLATION="'));
  });
  console.log(`${passed} host isolation groups passed`);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  fs.unlinkSync(settingsPath);
  fs.rmdirSync(profile);
});
