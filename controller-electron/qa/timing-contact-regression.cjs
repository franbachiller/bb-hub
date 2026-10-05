"use strict";
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const source = fs.readFileSync(path.resolve(process.argv[2] || path.join(__dirname, "../electron/game/flash_runtime.page.js")), "utf8")
  .replace("  window[KEY] = {", "  window.__contactQa = { state, reactCheck, notePunch, tickBounceRetry };\n  window[KEY] = {");
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
  f.ctx.t = 314643; f.timers[1].fn();
  assert.equal(f.ctx.sends.length,1,"the backup timer cannot repeat a successful reaction");
  const count = f.timers.length; f.q.reactCheck();
  assert.equal(f.timers.length,count,"one reaction plan per contact/batch");
  console.log("PASS recorded first pass: primary at rival 2, sweep at 7, fallback returns to confirmed rival 2 after the gap");
}
{
  const f = fixture(); f.q.reactCheck();
  f.q.state.lastPunch.at = 314620; f.q.state.lastPunch.targetId = 7;
  f.ctx.t = 314637; f.timers[0].fn();
  assert.equal(f.ctx.sends.length,0,"a shot during the wait moves the actual free time");
  assert.equal(f.timers.at(-1).ms,84);
  f.ctx.t = 314721; f.timers.at(-1).fn();
  assert.equal(f.ctx.sends.length,1);
  assert.equal(f.ctx.sends[0].id,2);
  console.log("PASS pending contact rechecks the actual gap after an intervening shot");
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
  f.q.state.lastPunch.targetId = 2; f.q.state.lastPunch.at = 314590; f.q.reactCheck();
  assert.equal(f.timers.length,0,"the latest click still covers the same rival: no extra reaction");
  console.log("PASS a latest click at the same contact keeps the existing single-click behavior");
}
for (const room of ['mGame2', 'BaoBab', 'Beluga Beach']) {
  // Recorded 04/10 15:18:44: we stood at 19,13. The blind request at
  // 162675.6 targeted Dylaan; his step into 18,12 arrived at 162841.5.
  // No reply confirmed that request before he hit us at 163040.8.
  const f = fixture();
  vm.runInContext(`
    t = 162842;
    s.selfId = 4; s.selfUsername = 'Herbert'; s.serverPingMs = 172;
    s.actors.clear(); s.react.lateral.clear();
    s.providers.renderer.instance.avatars = new Map([
      [4,{position:{x:19,y:13,z:1},avatarInfo:{id:400,username:'Herbert'}}],
      [1,{position:{x:18,y:12,z:5},avatarInfo:{id:100,username:'Dylaan'}}]
    ]);
    s.providers.renderer.instance.spaceModel = {name:${JSON.stringify(room)}};
    E.lastBatchAt = 162841.5; E.lastBatchTick = 271;
    E.tickTargets.clear(); E.tickTargets2.clear(); E.tickTargets.set(271,1);
    s.lastPunch.at = 162675.6; s.lastPunch.targetId = 1; s.lastPunch.reason = 'TICK_BLIND';
  `, f.ctx);
  f.q.reactCheck();
  assert.equal(f.ctx.sends.length,1,'an earlier blind request must not suppress the now-confirmed contact while we stand still');
  assert.equal(f.ctx.sends[0].id,1);
  assert.equal(f.ctx.sends[0].reason,'REACT_FALLBACK');
  f.ctx.t = 162844;
  f.q.tickBounceRetry({k:0,reactive:false,n:271,targetId:1});
  assert.equal(f.ctx.sends.length,1,'a delayed reject of the blind request must not add another retry after the reaction');
  console.log('PASS recorded Dylaan walk-in ('+room+'): standing self reacts even after a blind request at the same rival');
}
