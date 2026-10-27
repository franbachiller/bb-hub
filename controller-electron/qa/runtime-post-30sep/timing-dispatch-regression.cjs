"use strict";
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm"), assert = require("node:assert/strict");
const runtime = path.resolve(process.argv[2] || path.join(__dirname, "../electron/game/flash_runtime.page.js"));
const source = fs.readFileSync(runtime, "utf8").replace("  window[KEY] = {",
  "  window.__dispatchQa = {state, tickBounceRetry, notePunch, ensureActorFromRenderer, runlockArm, runlockCovers, runlockOnWorkerFire, firePunch, tickOnWorkerFire, onMoveStep, exitArm, exitOnWorkerFire, refreshEliminated, tickResetGrid, reactCheck, threatPick};\n  window[KEY] = {");
function fixture(room = "mGame2") {
  const timers = [];
  let context;
  context = vm.createContext({ TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, t: 10000,
    setTimeout(fn, ms) { timers.push({ fn, due: context.t + Math.max(0, Number(ms) || 0), canceled: false, ran: false }); return timers.length; },
    clearTimeout(id) { if (timers[id - 1]) timers[id - 1].canceled = true; },
    setInterval() { return 1; }, clearInterval() {}, document: { hidden: false } });
  vm.runInContext("globalThis.window = globalThis; performance = { now: () => t };", context);
  vm.runInContext(source, context);
  const run = code => vm.runInContext(code, context);
  run(`var q = __dispatchQa, s = q.state, E = s.tickEngine, sends = [];
    s.selfId = 1; s.selfUsername = 'Self'; s.serverPingMs = 170; s.ready = true; s.tickBurst = 1; s.punchPackets = 1;
    s.timing.enabled = true; s.timing.source = 'STEP'; s.timing.tick.enabled = true; s.timing.tick.single = true; s.timing.tick.reactive = true;
    s.providers.renderer = { instance: { spaceModel: { name: ${JSON.stringify(room)} }, avatars: new Map([
      [1, { position: { x: 10, y: 10 }, avatarInfo: { id: 100, username: 'Self' } }],
      [7, { position: { x: 11, y: 11 }, avatarInfo: { id: 700, username: 'Rival' } }]
    ]) } };
    s.providers.upper = { instance: { upperRequest(id) {
      sends.push({ id, account: s.providers.renderer.instance.avatars.get(id)?.avatarInfo.id, at: t, reason: s.activeFireReason });
      s.outboundUpperSeq++; q.notePunch(id, s.activeFireReason);
    } } };
    E.origin = 0; E.lastBatchAt = 9600; E.lastBatchTick = 16; E.batches = [9600];
    var originalAvatar = s.providers.renderer.instance.avatars.get(7);
    var replaceRival = (x = 11, y = 11) => s.providers.renderer.instance.avatars.set(7,
      { position: { x, y }, avatarInfo: { id: 701, username: 'Replacement' } });`);
  function advance(t) {
    context.t = t;
    let iterations = 0;
    while (iterations++ < 50) {
      const timer = timers.find(item => !item.canceled && !item.ran && item.due <= context.t);
      if (!timer) return;
      timer.ran = true; timer.fn();
    }
    throw Error("QA timer did not settle");
  }
  return { context, run, timers, advance, q: context.__dispatchQa, sends: context.sends };
}
function armBounce(f) {
  f.run("var shot = { n: 16, k: 0, reactive: false, targetId: 7 }; E.shots = [{ n: 16, phase: 550, ok: true }]; q.tickBounceRetry(shot);");
  assert.ok(f.timers.some(timer => timer.due === 10084), "recorded retry has 84 ms of deferred wait");
}
let passed = 0, failures = 0;
function check(name, fn) { try { fn(); passed++; console.log("PASS " + name); } catch (error) { failures++; console.error("FAIL " + name + ": " + error.message); } }

// Delayed dispatch tickets: a room ID alone cannot retain a particular player.
check("deferred bounce stays attached to the original native avatar", () => {
  const f = fixture(); armBounce(f); f.run("replaceRival()"); f.advance(10084);
  assert.equal(f.sends.length, 0, "account 701 must not receive account 700's retained retry");
});
for (const [name, change] of [["Timing disabled", "s.timing.enabled = false"], ["round sequence changed", "s.seq++"], ["target departed", "s.providers.renderer.instance.avatars.delete(7)"], ["target eliminated", "E.out.add(7)"], ["self eliminated", "E.selfOut = true"]]) {
  check("deferred bounce cancels after " + name, () => {
    const f = fixture(); armBounce(f); f.run(change); f.advance(10084);
    assert.equal(f.sends.length, 0);
  });
}
check("deferred bounce rechecks the actual latest shared punch gap", () => {
  const f = fixture(); armBounce(f); f.run("t = 10070; q.notePunch(7, 'manual')"); f.advance(10084);
  assert.equal(f.sends.length, 0, "the original due time is only 14 ms after the later manual punch");
  f.advance(10172);
  assert.ok(f.sends.every(send => send.at - 10070 >= 101), "a rescheduled request must preserve the real latest gap");
});
check("a still-valid bounce can dispatch exactly once", () => {
  const f = fixture(); armBounce(f); f.advance(10084); f.advance(10090);
  assert.equal(f.sends.length, 1); assert.equal(f.sends[0].account, 700); assert.equal(f.sends[0].reason, "RETRY");
});
check("a late blind reject cannot duplicate an already sent contact fallback", () => {
  const f = fixture();
  f.run("q.notePunch(7, 'REACT_FALLBACK'); E.shots = [{n:16,phase:550,ok:true}]; q.tickBounceRetry({n:16,k:0,reactive:false,targetId:7})");
  f.advance(10150); assert.equal(f.sends.length, 0);
});
check("rival-unlock cannot transfer the old player's animation end to a recycled ID", () => {
  const f = fixture(); f.run("q.runlockArm(7, 10160); replaceRival(); q.runlockOnWorkerFire({ planId: 'RUNLOCK:7:10160', dueAt: t, seq: s.seq })");
  assert.equal(f.sends.length, 0);
});
check("rival-unlock coverage cannot suppress a shot for a recycled incarnation", () => {
  const f = fixture(); f.run("q.runlockArm(7, 10160); replaceRival()");
  assert.equal(f.q.runlockCovers(10170), false);
});
for (const [name, change] of [["an ally", "s.allies.names.add('rival')"], ["a muted rival", "E.mutedUntil.set(7, 20000)"], ["a newly extended lock", "E.lockUntil.set(7, 20000)"]]) {
  check("rival-unlock coverage is absent for " + name, () => {
    const f = fixture(); f.run("q.runlockArm(7, 10160)"); f.run(change);
    assert.equal(f.q.runlockCovers(10170), false, "a callback that cannot send must not reserve this landing");
  });
}
check("a valid rival-unlock still dispatches to the original player", () => {
  const f = fixture(); f.run("q.runlockArm(7, 10160); q.runlockOnWorkerFire({ planId: 'RUNLOCK:7:10160', dueAt: t, seq: s.seq })");
  assert.equal(f.sends.length, 1); assert.equal(f.sends[0].account, 700); assert.equal(f.sends[0].reason, "RUNLOCK");
});
check("an exit burst invalidates a retained ID that was recycled far away", () => {
  const f = fixture();
  f.run("s.timing.tick.single = false; s.exitMode.enabled = true; s.exitMode.self = { endAt: 10200, type: 35 }; q.exitArm(); t = 10024; q.exitOnWorkerFire({ planId: 'EXIT:10200', index: 0, dueAt: t });");
  assert.equal(f.sends.length, 1, "first exit request establishes the retained target");
  f.run("replaceRival(15, 15); t = 10128; q.exitOnWorkerFire({ planId: 'EXIT:10200', index: 1, dueAt: t })");
  assert.equal(f.sends.length, 1, "remaining burst cannot follow a far-away replacement");
});
check("an automatic invalid destination never uses the manual ficha", () => {
  const f = fixture(); f.run("s.providers.selection = { instance: { avatarFichado: { userSpaceId: 7 } } }");
  for (const bad of [-1, null, undefined, "bad"]) assert.equal(f.q.firePunch(bad, "TICK_BLIND", { bypassThrottle: true }), false);
  assert.equal(f.sends.length, 0);
  assert.equal(f.q.firePunch(-1, "manual"), true, "manual selection fallback remains available");
  assert.equal(f.sends[0].id, 7);
});

// Same-avatar movement: this is distinct from recycled identity cleanup.
check("ordinary movement invalidates the precomputed proximity choice", () => {
  const f = fixture();
  f.run("E.plans.set('TICK:17', { n: 17, shots: [{ phase: 10, k: 0, b: 0 }], fired: 0, burst: 1, o: 0, pre: { pick: { id: 7, reactive: false, score: 1 }, avatar: originalAvatar } }); q.onMoveStep(7, 15, 15, 600, 1, 'in', 0); s.providers.renderer.instance.avatars.set(2, { position: { x: 11, y: 11 }, avatarInfo: { id: 200, username: 'CurrentThreat' } }); q.tickOnWorkerFire({ planId: 'TICK:17', index: 0, dueAt: t, seq: s.seq })");
  assert.deepEqual(Array.from(f.sends, send => send.id), [2], "the departed contact must yield to the current threat");
});
check("a removed native avatar cannot remain a predictive or cached first target", () => {
  const f=fixture();
  f.run("q.ensureActorFromRenderer(7); originalAvatar._removed=true; s.providers.renderer.instance.avatars.set(2,{position:{x:9,y:9},avatarInfo:{id:200,username:'CurrentThreat'}}); E.plans.set('TICK:17',{n:17,shots:[{phase:10,k:0,b:0}],fired:0,burst:1,o:0,pre:{pick:{id:7,reactive:false,score:1},avatar:originalAvatar}}); q.tickOnWorkerFire({planId:'TICK:17',index:0,dueAt:t,seq:s.seq})");
  assert.equal(f.q.ensureActorFromRenderer(7),null);assert.deepEqual(Array.from(f.sends,send=>send.id),[2]);
});
check("an ally change invalidates the cached choice and lets an eligible rival take it", () => {
  const f=fixture();
  f.run("s.providers.renderer.instance.avatars.set(2,{position:{x:9,y:9},avatarInfo:{id:200,username:'CurrentThreat'}}); E.plans.set('TICK:17',{n:17,shots:[{phase:10,k:0,b:0}],fired:0,burst:1,o:0,pre:{pick:{id:7,reactive:false,score:1},avatar:originalAvatar}}); s.allies.names.add('rival'); q.tickOnWorkerFire({planId:'TICK:17',index:0,dueAt:t,seq:s.seq})");
  assert.deepEqual(Array.from(f.sends,send=>send.id),[2]);
});

// Incarnation-scoped state: do not let another account inherit the old ID's locks.
check("a different account does not inherit actor-local locks and muted contact history", () => {
  const f = fixture("BaoBab");
  f.run("q.ensureActorFromRenderer(7); E.lockUntil.set(7, 20000); E.mutedUntil.set(7, 20000); E.down.set(7, 20000); E.cont.set(7, 1); E.silentCount.set(7, 2); s.react.lateral.add(7); replaceRival(); q.ensureActorFromRenderer(7)");
  assert.equal(f.q.state.tickEngine.lockUntil.has(7), false);
  assert.equal(f.q.state.tickEngine.mutedUntil.has(7), false);
  assert.equal(f.q.state.tickEngine.down.has(7), false);
  assert.equal(f.q.state.tickEngine.cont.has(7), false);
  assert.equal(f.q.state.tickEngine.silentCount.has(7), false);
  assert.equal(f.q.state.react.lateral.has(7), false);
  assert.equal(f.q.threatPick(10170, 0)?.id, 7, "the current live player is eligible independently");
});
check("predictive selection refreshes identity before applying an old ID's muted/down filters", () => {
  const f = fixture("BaoBab");
  f.run("q.ensureActorFromRenderer(7); E.lockUntil.set(7, 20000); E.mutedUntil.set(7, 20000); E.down.set(7, 20000); replaceRival()");
  assert.equal(f.q.threatPick(10170, 0)?.id, 7, "selection must not wait for the next UI roster poll to notice the different account");
});
check("Ring spectator reconstruction keeps the confirmed elimination until the next round", () => {
  const f = fixture();
  f.run("q.ensureActorFromRenderer(7); E.out.add(7); E.outAvatars.set(7, originalAvatar); s.providers.renderer.instance.avatars.set(7, { ...originalAvatar }); q.ensureActorFromRenderer(7); q.refreshEliminated()");
  assert.equal(f.q.state.tickEngine.out.has(7), true);
  assert.equal(f.q.firePunch(7, "TICK_BLIND", { bypassThrottle: true }), false);
  f.q.tickResetGrid("gong"); assert.equal(f.q.state.tickEngine.out.has(7), false);
});
check("a continuous same-account Ring reconstruction preserves the confirmed upper lock", () => {
  const f = fixture();
  f.run("q.ensureActorFromRenderer(7); E.lockUntil.set(7, 20000); s.providers.renderer.instance.avatars.set(7, { ...originalAvatar }); q.ensureActorFromRenderer(7)");
  assert.equal(f.q.state.tickEngine.lockUntil.get(7), 20000, "a drawing object replacement must not make this same player hittable during its confirmed upper animation");
  assert.equal(f.q.threatPick(10170, 0), null);
});
check("same-account reconstruction still invalidates a deferred native-avatar retry ticket", () => {
  const f = fixture(); armBounce(f);
  f.run("s.providers.renderer.instance.avatars.set(7, { ...originalAvatar })"); f.advance(10084);
  assert.equal(f.sends.length, 0, "preserving account-scoped lock state does not authorize a retained native-avatar ticket");
});
console.log(`${passed} passed, ${failures} failed dispatch regression cases`);
if (failures) process.exitCode = 1;
