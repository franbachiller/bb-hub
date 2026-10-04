"use strict";
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const source = fs.readFileSync(path.resolve(process.argv[2] || path.join(__dirname, "../electron/game/flash_runtime.page.js")), "utf8")
  .replace("  window[KEY] = {", "  window.__contactQa = { state, reactCheck, notePunch };\n  window[KEY] = {");
function fixture() {
  const timers = [], diagnostics = [];
  const ctx = vm.createContext({ TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, t: 314590,
    setTimeout: (fn, ms) => {timers.push({fn,ms}); return 1;}, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    document: {hidden: false}, __bbHubSend: m => diagnostics.push(m) });
  vm.runInContext("globalThis.window = globalThis; globalThis.performance = {now: () => t};", ctx);
  vm.runInContext(source, ctx);
  vm.runInContext(`
    globalThis.sends = [];
    const q = __contactQa, s = q.state, E = s.tickEngine;
    s.selfId = 3; s.selfUsername = "Self"; s.serverPingMs = 167; s.tickBurst = 1;
    s.ready = true; s.diagnostics.enabled = true;
    s.timing.enabled = true; s.timing.source = "STEP";
    s.timing.tick.enabled = true; s.timing.tick.reactive = true; s.timing.tick.single = true;
    s.providers.renderer = {instance: {avatars: new Map([
      [3, {position: {x:14,y:17,z:4}, avatarInfo:{id:300,username:"Self"}}],
      [2, {position: {x:15,y:18,z:1}, avatarInfo:{id:10984358,username:"Gallotheproduce"}}],
      [7, {position: {x:18,y:17,z:1}, avatarInfo:{id:700,username:"Other"}}]
    ])}};
    s.providers.upper = {instance: {lastUpperAt: 0, upperRequest(id) {
      sends.push({id,at:t,reason:s.activeFireReason}); s.outboundUpperSeq++; q.notePunch(id,s.activeFireReason);
    }}};
    E.lastBatchAt = 314590; E.lastBatchTick = 524;
    E.tickTargets.set(524,2); E.tickTargets2.set(524,7);
    s.lastPunch.at = 314536; s.lastPunch.targetId = 7; s.lastPunch.reason = "TICK_SWEEP";
  `, ctx);
  return {ctx,timers,diagnostics,q:ctx.__contactQa};
}
{
  const f = fixture();
  f.q.reactCheck();
  assert.deepEqual(f.timers.map(x => x.ms), [47,53], "the first confirmed pass gets a reaction after the sweep's 100 ms gap");
  assert.equal(f.ctx.sends.length, 0, "do not fire inside the server gap");
  f.ctx.t = 314637; f.timers[0].fn();
  assert.equal(f.ctx.sends.length,1);
  assert.equal(f.ctx.sends[0].id,2,"the confirmed contact gets the fallback, not the other sweep target");
  assert.equal(f.ctx.sends[0].reason,"REACT_FALLBACK");
  const count = f.timers.length; f.q.reactCheck();
  assert.equal(f.timers.length,count,"one reaction plan per contact/batch");
  console.log("PASS recorded first pass: primary at rival 2, sweep at 7, fallback returns to confirmed rival 2 after the gap");
}
{
  const f = fixture(); f.q.reactCheck();
  f.q.state.tickEngine.out.add(2); f.ctx.t = 314637;
  for (const timer of f.timers) timer.fn();
  assert.equal(f.ctx.sends.length,0,"a primary hit confirmed before the fallback cancels it");
  console.log("PASS confirmed hit cancels the pending fallback");
}
{
  const f = fixture(); f.q.reactCheck();
  f.q.state.timing.enabled = false; f.ctx.t = 314637;
  for (const timer of f.timers) timer.fn();
  assert.equal(f.ctx.sends.length,0,"switching timing off cancels the pending reaction");
  console.log("PASS switching timing off cancels the pending reaction");
}
{
  const f = fixture();
  f.q.state.lastPunch.targetId = 2; f.q.reactCheck();
  assert.equal(f.timers.length,0,"the latest click still covers the same rival: no extra reaction");
  console.log("PASS a latest click at the same contact keeps the existing single-click behavior");
}
