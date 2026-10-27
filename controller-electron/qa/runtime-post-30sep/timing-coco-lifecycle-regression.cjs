"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("node:assert/strict");
const file = path.resolve(process.argv[2] || path.join(__dirname, "../electron/game/flash_runtime.page.js"));
const source = fs.readFileSync(file, "utf8").replace("  window[KEY] = {", "  window.__cocoLifecycleQa = { state, onPacket, exitNoteCoco, exitBlocksLanding, exitPump, rivalLocked };\n  window[KEY] = {");

function fixture() {
  const arms = [], messages = [];
  const c = vm.createContext({ console, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, t: 1000,
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {}, document: { hidden: false },
    __bbHubSend: m => messages.push(m) });
  c.window = c; c.performance = { now: () => c.t }; vm.runInContext(source, c);
  vm.runInContext(`globalThis.q = __cocoLifecycleQa; globalThis.s = q.state;
    s.selfId = 1; s.selfUsername = 'Self'; s.serverPingMs = 170; s.timing.enabled = true;
    s.timing.tick.enabled = true; s.timing.tick.single = true; s.idleSoft = false;
    s.timingWorker = { postMessage(m) { armMessages.push(m); } };
    s.providers.renderer = { instance: { spaceModel: { name: 'mGame2' }, avatars: new Map([
      [1, { position: { x: 10, y: 10 }, avatarInfo: { id: 100, username: 'Self' } }],
      [7, { position: { x: 11, y: 11 }, avatarInfo: { id: 700, username: 'Rival' } }],
      [8, { position: { x: 9, y: 9 }, avatarInfo: { id: 800, username: 'Other' } }]
    ]) } };`, Object.assign(c, { armMessages: arms }));
  return { c, q: c.__cocoLifecycleQa, arms, messages, run: code => vm.runInContext(code, c),
    packet(fields, at = c.t) { c.t = at; c.__cocoLifecycleQa.onPacket({ id: 184, type: 120, fields }, "in"); } };
}

let failures = 0;
function check(name, fn) { try { fn(); console.log("PASS " + name); } catch (e) { failures++; console.error("FAIL " + name + ": " + e.message); } }

// Native UserCocoPotion reads account, type, then active (fields[2]); ordinary
// potion updates with active === 0 are endings, even when type remains nonzero.
// Captured 12/10: [11008968,35,35] at 83689.3 -> [11008968,1,0] at 90690.7.
check("a real nonzero-type ending clears the rival instead of restarting seven seconds", () => {
  const f = fixture(); f.packet([700, 35, 35], 83689.3); assert.equal(f.q.rivalLocked(7, 84000), true);
  f.packet([700, 1, 0], 90690.7); assert.equal(f.q.state.exitMode.cocoByAccount.has(700), false);
  assert.equal(f.q.rivalLocked(7, 90860), false); assert.equal(f.q.state.exitMode.durByType[35], 7000);
});
// Captured 09/10: [10305598,35,35] at 32955.9 -> [10305598,6,0] at 39877.3.
check("the alternative type-six ending uses the same third-field contract", () => {
  const f = fixture(); f.packet([700, 35, 35], 32955.9); f.packet([700, 6, 0], 39877.3);
  assert.equal(f.q.state.exitMode.cocoByAccount.has(700), false); assert.equal(f.q.rivalLocked(7, 40050), false);
});
check("a self ending removes the landing block and learns the original coco type", () => {
  const f = fixture(); f.packet([100, 35, 35], 1000); assert.equal(f.q.exitBlocksLanding(2000), true);
  f.packet([100, 1, 0], 8001.4); assert.equal(f.q.state.exitMode.self, null);
  assert.equal(f.q.exitBlocksLanding(8171), false); assert.equal(f.q.state.exitMode.cocoByAccount.has(100), false);
  assert.equal(f.q.state.exitMode.durByType[35], 7000); assert.equal(f.q.state.exitMode.durByType[1], undefined);
});
check("potion termination without an active coco cannot invent a stun", () => {
  const f = fixture(); f.packet([100, 53, 0]); f.packet([700, 7, 0]);
  assert.equal(f.q.state.exitMode.self, null); assert.equal(f.q.state.exitMode.cocoByAccount.size, 0);
  assert.equal(f.q.rivalLocked(7, 1170), false);
});
check("active ordinary potions are not treated as combat cocos", () => {
  const f = fixture(); f.packet([100, 53, 53]); f.packet([700, 6, 6]);
  assert.equal(f.q.state.exitMode.self, null); assert.equal(f.q.state.exitMode.cocoByAccount.size, 0);
  assert.equal(f.q.rivalLocked(7, 1170), false);
});
check("all native coco types remain supported", () => {
  for (let type = 32; type <= 41; type++) { const f = fixture(); f.packet([700, type, type]);
    assert.equal(f.q.state.exitMode.cocoByAccount.get(700)?.type, type); assert.equal(f.q.rivalLocked(7, 1170), true); }
});
check("a legacy two-field start and type-zero end still work", () => {
  const f = fixture(); f.packet([700, 35]); assert.equal(f.q.rivalLocked(7, 1170), true);
  f.packet([700, 0], 8000); assert.equal(f.q.rivalLocked(7, 8170), false); assert.equal(f.q.state.exitMode.cocoByAccount.size, 0);
});
check("an unrelated account ending cannot unlock our active coco", () => {
  const f = fixture(); f.packet([100, 35, 35]); f.packet([700, 1, 0], 1100);
  assert.equal(f.q.exitBlocksLanding(1270), true); assert.equal(f.q.state.exitMode.cocoByAccount.has(100), true);
});
check("the active field is the third parameter, regardless of following text", () => {
  const f = fixture(); f.packet([700, 35, 35]); f.packet([700, 1, 0, "potion text"], 8000);
  assert.equal(f.q.state.exitMode.cocoByAccount.has(700), false); assert.equal(f.q.rivalLocked(7, 8170), false);
});
check("learning records the elapsed duration of the ended coco, not the ending potion type", () => {
  const f = fixture(); f.packet([700, 37, 37], 1000); f.packet([700, 7, 0], 12001);
  assert.equal(f.q.state.exitMode.durByType[37], 8200); assert.equal(f.q.state.exitMode.durByType[7], undefined);
  assert.equal(f.q.state.exitMode.cocoByAccount.has(700), false);
});
check("a coco received before identifying our avatar blocks landings after identification", () => {
  const f = fixture(); f.run("globalThis.savedSelf = s.providers.renderer.instance.avatars.get(1); s.providers.renderer.instance.avatars.delete(1); s.selfId = -1;");
  f.packet([100, 35, 35], 1000); assert.equal(f.q.state.exitMode.self, null);
  f.run("s.providers.renderer.instance.avatars.set(1, savedSelf); s.selfId = 1; t = 1300;");
  assert.equal(f.q.exitBlocksLanding(1470), true); assert.equal(f.q.state.exitMode.cocoByAccount.get(100).endAt, 8000);
});
check("identification reconciles and arms the original self-coco exit exactly once", () => {
  const f = fixture(); f.run("globalThis.savedSelf = s.providers.renderer.instance.avatars.get(1); s.providers.renderer.instance.avatars.delete(1); s.selfId = -1;");
  f.packet([100, 35, 35], 1000);
  f.run("s.providers.renderer.instance.avatars.set(1, savedSelf); s.selfId = 1; t = 1300;");
  f.q.exitPump(); f.q.exitPump();
  assert.equal(f.q.state.exitMode.self?.endAt, 8000, "identification must not restart the stun from 1300");
  assert.equal(f.q.state.exitMode.plan?.endAt, 8000); assert.equal(f.q.state.exitMode.plan?.armed, true);
  assert.equal(f.arms.filter(m => m.window === "EXIT").length, 1);
});
if (failures) process.exitCode = 1;
