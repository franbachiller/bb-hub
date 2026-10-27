"use strict";
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), assert = require('node:assert/strict');
const source = fs.readFileSync(path.join(__dirname, '../electron/game/flash_runtime.page.js'), 'utf8')
  .replace('  window[KEY] = {', '  window.__isolationQa = {state, applyPunchIsolationConfig, tickEffective, tickPump, tickOnWorkerFire, firePunch, notePunch, reactSchedule, reactCheck, unlockArm, unlockOnWorkerFire, runlockArm, runlockCovers, runlockOnWorkerFire, exitArm, exitOnWorkerFire, tickBounceRetry, tickAutoSample, tickAutoRace, tickAutoSave, tickAutoReset, tickOnServerReply, tickAutoLoad};\n  window[KEY] = {')
  .replace('  function spinUntil(due) {', '  function spinUntil(due) { return;');

function fixture(saved = null) {
  const storage = new Map(), writes = [], timers = [];
  if (saved) storage.set('bbhub.tickAuto.v5', JSON.stringify(saved));
  const c = vm.createContext({ TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, t: 10000,
    setTimeout(fn, ms) { timers.push({fn, ms}); return timers.length; }, clearTimeout() {},
    setInterval() { return 1; }, clearInterval() {}, document: { hidden: false } });
  c.window = c; c.performance = { now: () => c.t };
  c.localStorage = { getItem: k => storage.get(k) ?? null,
    setItem(k, v) { writes.push([k, String(v)]); storage.set(k, String(v)); },
    removeItem(k) { writes.push([k, null]); storage.delete(k); } };
  vm.runInContext(source, c);
  const run = code => vm.runInContext(code, c);
  run(`var q = __isolationQa, s = q.state, E = s.tickEngine, sends = [], worker = [];
    s.selfId=1; s.selfUsername='Self'; s.serverPingMs=170; s.ready=true; s.tickBurst=1; s.punchPackets=1;
    s.timing.enabled=true; s.timing.source='STEP'; s.timing.tick.enabled=true; s.timing.tick.single=true;
    s.timing.tick.auto=true; s.timing.tick.autoCal=true; s.timing.tick.reactive=true;
    s.tickAdv.repeatMs=105; s.tickAdv.sweep=true;
    s.providers.renderer={instance:{spaceModel:{name:'mGame2'},avatars:new Map([
      [1,{position:{x:10,y:10},avatarInfo:{id:100,username:'Self'}}],
      [7,{position:{x:11,y:11},avatarInfo:{id:700,username:'Rival'}}]
    ])}};
    s.providers.upper={instance:{upperRequest(id){sends.push({id,at:t,reason:s.activeFireReason});s.outboundUpperSeq++;q.notePunch(id,s.activeFireReason);}}};
    s.timingWorker={postMessage(m){worker.push(m);}};
    E.origin=0; E.lastBatchAt=9600; E.lastBatchTick=16; E.batches=[9600];
    E.corr=4; E.auto.B=5; E.auto.margin=8; E.auto.loaded=${saved ? 'false' : 'true'};
    var enable=()=>q.applyPunchIsolationConfig({enabled:true,phaseMs:13});`);
  return { c, run, q: c.__isolationQa, storage, writes, timers, sends: c.sends, worker: c.worker };
}
let passes=0, failures=0;
function check(name, fn) { try { fn(); passes++; console.log('PASS '+name); } catch(e) { failures++; console.error('FAIL '+name+': '+e.stack); } }

check('default mode retains its normal repeat and learned phase', () => {
  const f=fixture(); assert.equal(f.q.state.punchIsolation.enabled,false);
  assert.equal(f.q.tickEffective().offset,13); f.q.tickPump();
  const plan=Array.from(f.q.state.tickEngine.plans.values())[0];
  assert.equal(plan.shots.length,2); assert.equal(plan.shots[1].repeat,true);
});
check('isolation arms one frozen primary despite burst and free-fire settings', () => {
  const f=fixture(); f.run('enable(); s.tickBurst=20; s.freeFire.enabled=true; E.auto.B=20; E.auto.margin=16; q.tickPump()');
  const plans=Array.from(f.q.state.tickEngine.plans.values()); assert.equal(plans.length,1);
  assert.equal(plans[0].shots.length,1); assert.equal(plans[0].shots[0].phase,13);
  assert.equal(plans[0].burst,1); assert.equal(f.q.tickEffective().auto,false);
});
check('one worker primary emits one packet and duplicate callbacks cannot emit again', () => {
  const f=fixture(); f.run('enable(); s.tickBurst=20; q.tickPump(); var entry=Array.from(E.plans.entries())[0]; var msg={planId:entry[0],index:0,seq:s.seq,dueAt:t}; entry[1].pre={pick:{id:7,score:1,reactive:false},avatar:s.providers.renderer.instance.avatars.get(7)}; q.tickOnWorkerFire(msg); q.tickOnWorkerFire(msg)');
  assert.equal(f.sends.length,1); assert.equal(f.sends[0].id,7);
  assert.equal(f.q.state.lastFireResult.sentCount,1);
});
check('additional automatic engines cannot consume the punch gap', () => {
  const f=fixture(); f.run('enable()'); const before=JSON.stringify(f.q.state.lastPunch);
  for(const reason of ['TICK_REPEAT','TICK_RETRY','TICK_SWEEP','TICK_DUAL','REACT','REACT_FALLBACK','UNLOCK','RUNLOCK','GUARD','EXIT','RETRY','REACH_PROBE','STEP','MOVE_DELAY']) {
    assert.equal(f.q.firePunch(7,reason,{bypassThrottle:true}),false,reason);
    assert.equal(f.q.state.lastFireResult.held,'punch_isolation');
  }
  assert.equal(f.sends.length,0); assert.equal(JSON.stringify(f.q.state.lastPunch),before);
});
check('pending reaction and unlock callbacks are suppressed and reserve no coverage', () => {
  const f=fixture(); f.run('enable(); E.unlock.end=10100; E.selfLockEnd=10100; q.reactSchedule(); q.reactCheck(); q.unlockArm(); q.unlockOnWorkerFire({}); q.runlockArm(7,10100); q.runlockOnWorkerFire({}); q.exitArm(); q.exitOnWorkerFire({}); q.tickBounceRetry({k:0})');
  assert.equal(f.sends.length,0); assert.equal(f.q.runlockCovers(10110),false);
  assert.equal(f.worker.some(m => m.type==='arm' && m.window!=='TICK'),false);
});
check('trial rejects, wins and reset controls cannot alter or save normal learning', () => {
  const f=fixture(); const normal=f.q.state.tickEngine.auto; const snapshot=JSON.stringify(normal);
  f.run(`enable(); var beforeCorr=E.corr; E.shots=[{seq:s.seq,o:0,n:17,k:0,b:0,phase:13,sentAt:10000,late:0,targetId:7,packets:1,ok:true,reactive:false,matched:false}];
    q.tickOnServerReply(10216,'reject'); q.tickAutoSample(-5,false); q.tickAutoRace('win',17,20,null,-1); q.tickAutoSave(20000,true); q.tickAutoReset();`);
  assert.equal(f.q.state.tickEngine.corr,4); assert.equal(f.q.state.tickEngine.auto.samples.length,0);
  assert.equal(f.q.state.tickEngine.auto.margin,8); assert.equal(f.writes.length,0);
  assert.equal(JSON.stringify(normal),snapshot);
  f.run('q.applyPunchIsolationConfig({enabled:false}); q.tickAutoSave(30000,true)');
  assert.equal(f.q.state.tickEngine.auto,normal); assert.equal(f.q.state.tickEngine.auto.wins,0);
  const saved=JSON.parse(f.storage.get('bbhub.tickAuto.v5')); assert.equal(saved.margin,8);
});
check('a trial started before boot retains the saved transport correction', () => {
  const f=fixture({v6:true,learningVersion:1,B:5,margin:8,corr:7,sigma:2,samples:[]}); f.run('enable()');
  assert.equal(f.q.state.tickEngine.corr,7); assert.equal(f.q.state.punchIsolation.saved.corr,7);
  assert.equal(f.writes.length,0);
});
check('manual punch remains available and records a competing request', () => {
  const f=fixture(); f.run('enable(); q.firePunch(7,"manual")');
  assert.equal(f.sends.length,1); assert.equal(f.q.state.tickEngine.allShots.at(-1).reason,'manual');
});
check('mode changes invalidate retained tickets and restore ordinary planning', () => {
  const f=fixture(); f.q.tickPump(); const old=Array.from(f.q.state.tickEngine.plans.entries())[0];
  const seq=f.q.state.seq; f.run('enable()'); assert.notEqual(f.q.state.seq,seq);
  f.q.tickOnWorkerFire({planId:old[0],index:0,seq,dueAt:10000}); assert.equal(f.sends.length,0);
  f.run('q.applyPunchIsolationConfig({enabled:false}); q.tickPump()');
  assert.equal(Array.from(f.q.state.tickEngine.plans.values())[0].shots.length,2);
});
check('mode transitions discard old unlock reservations along with their worker tickets', () => {
  const f=fixture(); f.run('q.runlockArm(7,10160); E.unlock.end=10160; enable()');
  assert.equal(f.q.state.tickEngine.runlock.size,0); assert.equal(f.q.state.tickEngine.unlock.end,0);
  f.run('q.applyPunchIsolationConfig({enabled:false})'); assert.equal(f.q.runlockCovers(10170),false);
});
console.log(`${passes} isolation cases passed`); process.exitCode=failures?1:0;
