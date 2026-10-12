"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("node:assert/strict");
const file = path.resolve(process.argv[2] || path.join(__dirname, "../electron/game/flash_runtime.page.js"));
const source = fs.readFileSync(file, "utf8").replace("  window[KEY] = {", "  window.__motionOrderQa = { state, onPacket, hookRenderer, ensureActorFromRenderer };\n  window[KEY] = {");
function fixture() {
  const c = vm.createContext({ console, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, t: 1000,
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {}, document: { hidden: false }, __bbHubSend() {} });
  c.window = c; c.performance = { now: () => c.t }; vm.runInContext(source, c);
  vm.runInContext(`class Renderer {
    static instance = new Renderer();
    spaceModel = { name: 'mGame2' };
    avatars = new Map([[1, { position: { x: 10, y: 10, z: 1 }, avatarInfo: { id: 100, username: 'Self' } }],
      [7, { position: { x: 11, y: 11, z: 1 }, avatarInfo: { id: 700, username: 'Rival' } }]]);
    rotateUser(id, position) { this.rotateCalls = (this.rotateCalls || 0) + 1; if (this.failRotate) throw Error('native rotate failure');
      this.avatars.get(id).position = { ...position }; return 'native-rotate'; }
    moveUser(id, position) { this.moveCalls = (this.moveCalls || 0) + 1; this.avatars.get(id).position = { ...position }; return 'native-move'; }
    punchUsers() {}
  }; globalThis.q = __motionOrderQa; globalThis.s = q.state; globalThis.renderer = Renderer; globalThis.R = Renderer.instance;
  s.selfId = 1; s.selfUsername = 'Self'; s.serverPingMs = 170; s.timing.enabled = true; s.timing.tick.enabled = true;
  s.timing.tick.reactive = false; s.idleSoft = false; s.providers.renderer = { exported: Renderer, instance: R };
  q.hookRenderer(s.providers.renderer); q.ensureActorFromRenderer(7);`, c);
  return { c, q: c.__motionOrderQa, run: code => vm.runInContext(code, c) };
}
let failures = 0;
function check(name, fn) { try { fn(); console.log("PASS " + name); } catch (e) { failures++; console.error("FAIL " + name + ": " + e.message); } }
check("a native rotation reconciles immediately when no newer movement was received", () => {
  const f = fixture(); f.run("q.onPacket({id:135,fields:[7,13,13,4]},'in'); t=1010; globalThis.result=R.rotateUser(7,{x:13,y:13,z:4});");
  assert.equal(f.c.result, "native-rotate"); assert.equal(f.c.R.rotateCalls, 1);
  const a = f.q.ensureActorFromRenderer(7); assert.equal(a.toX, 13); assert.equal(a.toY, 13); assert.equal(a.moving, false);
});
check("a queued old rotation cannot erase a later socket movement before its native rendering", () => {
  const f = fixture(); f.run("q.onPacket({id:135,fields:[7,11,11,4]},'in'); t=1001; q.onPacket({id:182,fields:[1,7,12,12,1,600,1]},'in'); globalThis.step=q.ensureActorFromRenderer(7); t=1020; R.rotateUser(7,{x:11,y:11,z:4});");
  const a = f.q.ensureActorFromRenderer(7); assert.equal(a.toX, 12); assert.equal(a.toY, 12); assert.equal(a.startAt, f.c.step.startAt);
  assert.equal(a.moving, true); assert.equal(f.c.R.rotateCalls, 1); assert.equal(f.c.R.avatars.get(7).position.x, 11, "native queue order remains intact");
  f.run("R.moveUser(7,{x:12,y:12,z:1},false,false);"); assert.equal(f.q.ensureActorFromRenderer(7).toX, 12); assert.equal(f.c.R.moveCalls, 1);
});
check("same-timestamp frames still preserve the later movement by packet order", () => {
  const f = fixture(); f.run("q.onPacket({id:135,fields:[7,11,11,4]},'in'); q.onPacket({id:182,fields:[1,7,12,12,1,600,1]},'in'); globalThis.step=q.ensureActorFromRenderer(7); R.rotateUser(7,{x:11,y:11,z:4});");
  const a = f.q.ensureActorFromRenderer(7); assert.equal(a.toX, 12); assert.equal(a.toY, 12); assert.equal(a.key, f.c.step.key); assert.equal(a.moving, true);
});
check("a later rotation supersedes the older movement once the renderer reaches it", () => {
  const f = fixture(); f.run("q.onPacket({id:182,fields:[1,7,12,12,1,600,1]},'in'); R.moveUser(7,{x:12,y:12,z:1},false,false); t=1001; q.onPacket({id:135,fields:[7,13,13,4]},'in'); t=1020; R.rotateUser(7,{x:13,y:13,z:4});");
  const a = f.q.ensureActorFromRenderer(7); assert.equal(a.toX, 13); assert.equal(a.toY, 13); assert.equal(a.moving, false); assert.equal(f.c.R.rotateCalls, 1);
});
check("a native rotation error propagates and cannot replace the received movement", () => {
  const f = fixture(); f.run("q.onPacket({id:182,fields:[1,7,12,12,1,600,1]},'in'); globalThis.step=q.ensureActorFromRenderer(7); R.failRotate=true;");
  assert.throws(() => f.c.R.rotateUser(7, { x: 13, y: 13, z: 4 }), /native rotate failure/);
  const a = f.q.ensureActorFromRenderer(7); assert.equal(a.toX, 12); assert.equal(a.key, f.c.step.key); assert.equal(f.c.R.rotateCalls, 1);
});
check("two queued rotations without a later walk still apply the last authoritative position", () => {
  const f = fixture(); f.run("q.onPacket({id:135,fields:[7,12,12,4]},'in'); q.onPacket({id:135,fields:[7,13,13,4]},'in'); t=1010; R.rotateUser(7,{x:12,y:12,z:4}); R.rotateUser(7,{x:13,y:13,z:4});");
  const a = f.q.ensureActorFromRenderer(7); assert.equal(a.toX, 13); assert.equal(a.toY, 13); assert.equal(a.moving, false); assert.equal(f.c.R.rotateCalls, 2);
});
check("compressed identical rotations use the latest received movement revision", () => {
  const f = fixture(); f.run("q.onPacket({id:135,fields:[7,11,11,4]},'in'); q.onPacket({id:182,fields:[1,7,12,12,1,600,1]},'in'); q.onPacket({id:135,fields:[7,11,11,4]},'in'); R.rotateUser(7,{x:11,y:11,z:4});");
  const a=f.q.ensureActorFromRenderer(7); assert.equal(a.toX,11); assert.equal(a.toY,11); assert.equal(a.moving,false); assert.equal(f.c.R.rotateCalls,1);
});
check("a later step remains authoritative across repeated native placements of the same key", () => {
  const f = fixture(); f.run("q.onPacket({id:135,fields:[7,11,11,4]},'in'); q.onPacket({id:135,fields:[7,11,11,4]},'in'); R.rotateUser(7,{x:11,y:11,z:4}); q.onPacket({id:182,fields:[1,7,12,12,1,600,1]},'in'); R.rotateUser(7,{x:11,y:11,z:4});");
  const a=f.q.ensureActorFromRenderer(7); assert.equal(a.toX,12); assert.equal(a.toY,12); assert.equal(a.moving,true); assert.equal(f.c.R.rotateCalls,2);
});
if (failures) process.exitCode = 1;
