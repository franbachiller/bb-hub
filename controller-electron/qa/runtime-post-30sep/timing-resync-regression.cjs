"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("node:assert/strict");
const file = path.resolve(process.argv[2] || path.join(__dirname, "../electron/game/flash_runtime.page.js"));
const source = fs.readFileSync(file, "utf8").replace("  window[KEY] = {", "  window.__resyncQa = { state, onPacket, exitBlocksLanding, exitPump, rivalLocked };\n  window[KEY] = {");
function fixture() {
  const arms = [];
  const c = vm.createContext({ console, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, t: 1000,
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {}, document: { hidden: false }, __bbHubSend() {} });
  c.window = c; c.performance = { now: () => c.t }; vm.runInContext(source, c);
  vm.runInContext(`globalThis.q = __resyncQa; globalThis.s = q.state;
    s.selfId = 1; s.selfUsername = 'Self'; s.serverPingMs = 170; s.timing.enabled = true;
    s.timing.tick.enabled = true; s.timing.tick.single = true; s.idleSoft = false;
    s.timingWorker = { postMessage(m) { armMessages.push(m); } };
    s.providers.renderer = { instance: { spaceModel: { name: 'mGame2' }, avatars: new Map([
      [1, { position: { x: 10, y: 10 }, avatarInfo: { id: 100, username: 'Self' } }],
      [7, { position: { x: 11, y: 11 }, avatarInfo: { id: 700, username: 'Rival' } }],
      [8, { position: { x: 9, y: 9 }, avatarInfo: { id: 800, username: 'Other' } }]
    ]) } };`, Object.assign(c, { armMessages: arms }));
  return { c, q: c.__resyncQa, arms, run: code => vm.runInContext(code, c),
    packet(fields, at = c.t) { c.t = at; c.__resyncQa.onPacket({ id: 215, fields }, "in"); } };
}
let failures = 0;
function check(name, fn) { try { fn(); console.log("PASS " + name); } catch (e) { failures++; console.error("FAIL " + name + ": " + e.message); } }

// Native AnimResync reads roomId, accountId, kind, animationParam, peer,
// elapsedMs, durationMs; ANIM_COCO === 2. Duration describes the received
// animation. No Upper-lock duration policy is inferred from ANIM_UPPER.
check("a self COCO resync recovers only its remaining duration and arms its exit", () => {
  const f = fixture(); f.packet([1, 100, 2, 0, 0, 2500, 7000]);
  assert.equal(f.q.state.exitMode.cocoByAccount.get(100)?.endAt, 5500);
  assert.equal(f.q.state.exitMode.self?.endAt, 5500); assert.equal(f.q.exitBlocksLanding(1170), true);
  assert.equal(f.q.state.exitMode.plan?.endAt, 5500); assert.equal(f.arms.filter(m => m.window === "EXIT").length, 1);
});
// Captured native example: [17,10346797,2,6,0,9504,11000].
check("a rival COCO resync uses supplied age and duration without a default seven-second restart", () => {
  const f = fixture(); f.packet([7, 700, 2, 6, 0, 9504, 11000]);
  assert.equal(f.q.state.exitMode.cocoByAccount.get(700)?.endAt, 2496);
  assert.equal(f.q.rivalLocked(7, 1170), true); assert.equal(f.q.rivalLocked(7, 2600), false);
  assert.equal(f.q.state.exitMode.self, null);
});
check("a COCO snapshot before avatar creation survives identification without extending its end", () => {
  const f = fixture(); f.run("globalThis.savedSelf = s.providers.renderer.instance.avatars.get(1); s.providers.renderer.instance.avatars.delete(1); s.selfId = -1;");
  f.packet([1, 100, 2, 0, 0, 2500, 7000]); assert.equal(f.q.state.exitMode.self, null);
  assert.equal(f.q.state.exitMode.cocoByAccount.get(100)?.endAt, 5500);
  f.run("s.providers.renderer.instance.avatars.set(1, savedSelf); s.selfId = 1; t = 1300;"); f.q.exitPump();
  assert.equal(f.q.state.exitMode.self?.endAt, 5500); assert.equal(f.q.exitBlocksLanding(1470), true);
  assert.equal(f.q.state.exitMode.plan?.endAt, 5500); assert.equal(f.arms.filter(m => m.window === "EXIT").length, 1);
});
check("a room ID belonging to another account cannot hydrate either player", () => {
  const f = fixture(); f.packet([7, 800, 2, 0, 0, 1000, 7000]);
  assert.equal(f.q.state.exitMode.cocoByAccount.size, 0); assert.equal(f.q.rivalLocked(7, 1170), false);
  assert.equal(f.q.rivalLocked(8, 1170), false); assert.equal(f.q.state.exitMode.self, null);
});
check("malformed identity, elapsed time, duration and expired snapshots are rejected", () => {
  const invalid = [
    ["invalid", 100, 2, 0, 0, 1000, 7000], [-1, 100, 2, 0, 0, 1000, 7000],
    [1, "invalid", 2, 0, 0, 1000, 7000], [1, 0, 2, 0, 0, 1000, 7000],
    [1, 100, 2, 0, 0, -1, 7000], [1, 100, 2, 0, 0, "invalid", 7000],
    [1, 100, 2, 0, 0, 1000, 0], [1, 100, 2, 0, 0, 1000, 30001],
    [1, 100, 2, 0, 0, 1000, Infinity], [1, 100, 2, 0, 0, 7000, 7000],
    [1, 100, 2, 0, 0, 7001, 7000], [1, 100, 2, 0, 0, 1000]
  ];
  for (const fields of invalid) { const f = fixture(); f.packet(fields);
    assert.equal(f.q.state.exitMode.cocoByAccount.size, 0, JSON.stringify(fields));
    assert.equal(f.q.state.exitMode.self, null); assert.equal(f.arms.filter(m => m.window === "EXIT").length, 0); }
});
check("other animation kinds cannot create a coco or change the established Upper lock", () => {
  for (const kind of [1, 3, 4]) { const f = fixture(); f.q.state.tickEngine.selfLockEnd = 25000;
    f.packet([1, 100, kind, 0, 7, 1173, 13000]);
    assert.equal(f.q.state.exitMode.cocoByAccount.size, 0); assert.equal(f.q.state.exitMode.self, null);
    assert.equal(f.q.state.tickEngine.selfLockEnd, 25000); }
});
check("an animation parameter never becomes a learned 184 type or a confirmed throw budget", () => {
  const f = fixture(); f.run("s.cocoGuard.thrown.push({ acc: 100, t: 1000 });"); f.packet([1, 100, 2, 6, 0, 2000, 7000]);
  assert.equal(f.q.state.cocoGuard.used, 0); assert.equal(f.q.state.cocoGuard.thrown.length, 1);
  f.c.t = 6000; f.q.onPacket({ id: 184, type: 120, fields: [100, 6, 0] }, "in");
  assert.equal(Object.keys(f.q.state.exitMode.durByType).length, 0); assert.equal(f.q.state.exitMode.self, null);
  assert.equal(f.q.state.cocoGuard.used, 0);
});
check("changing rooms clears the recovered effect and its armed self exit", () => {
  const f = fixture(); f.packet([1, 100, 2, 0, 0, 2500, 7000]);
  f.q.onPacket({ id: 128, type: 120, fields: [1] }, "in");
  assert.equal(f.q.state.exitMode.cocoByAccount.size, 0); assert.equal(f.q.state.exitMode.self, null);
  assert.equal(f.q.state.exitMode.plan, null); assert.equal(f.q.exitBlocksLanding(1170), false);
});
if (failures) process.exitCode = 1;
