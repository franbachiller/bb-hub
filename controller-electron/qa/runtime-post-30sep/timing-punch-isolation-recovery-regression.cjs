"use strict";
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync(path.resolve(process.argv[2]||path.join(__dirname,'../electron/game/flash_runtime.page.js')),'utf8')
  .replace('  window[KEY] = {','  window.__recoveryQa={state,tickPump,tickOnWorkerFire,notePunch,firePunch,applyPunchIsolationConfig,threatPick,refreshSilent,isMuted,tickIsolatedRecoveryBoundary};\n  window[KEY] = {')
  .replace('  function spinUntil(due) {','  function spinUntil(due) { return;');
function fixture(){
  const storage=new Map(),timers=[];
  const c=vm.createContext({TextEncoder,TextDecoder,Uint8Array,ArrayBuffer,t:10000,
    setTimeout(fn,ms){timers.push({fn,ms});return timers.length},clearTimeout(){},
    setInterval(){return 1},clearInterval(){},document:{hidden:false}});
  c.window=c;c.performance={now:()=>c.t};c.localStorage={getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)};
  vm.runInContext(source,c);const run=code=>vm.runInContext(code,c);
  run(`var q=__recoveryQa,s=q.state,E=s.tickEngine,sends=[],worker=[];
    s.selfId=1;s.selfUsername='Self';s.serverPingMs=170;s.ready=true;s.tickBurst=1;s.punchPackets=1;
    s.timing.enabled=true;s.timing.source='STEP';s.timing.tick.enabled=true;s.timing.tick.single=true;
    s.timing.tick.auto=true;s.timing.tick.autoCal=true;s.timing.tick.reactive=true;
    s.providers.renderer={instance:{spaceModel:{name:'mGame2'},avatars:new Map([
      [1,{userSpaceId:1,position:{x:10,y:10},avatarInfo:{id:100,username:'Self'}}],
      [7,{userSpaceId:7,position:{x:11,y:11},avatarInfo:{id:700,username:'Rival'}}],
      [6,{userSpaceId:6,position:{x:20,y:20},avatarInfo:{id:600,username:'Other'}}]
    ])}};
    s.providers.selection={instance:{avatarFichado:s.providers.renderer.instance.avatars.get(7)}};
    s.providers.upper={instance:{upperRequest(id){sends.push({id,at:t,reason:s.activeFireReason});s.outboundUpperSeq++;q.notePunch(id,s.activeFireReason)}}};
    s.timingWorker={postMessage(m){worker.push(m)}};
    E.auto.loaded=true; q.applyPunchIsolationConfig({enabled:true,phaseMs:13});
    E.origin=0;E.lastBatchAt=9600;E.lastBatchTick=16;E.batches=[9600];E.corr=4;
    E.selfLockKind='UPPER';E.selfLockEnd=10350;
    var initial=()=>{q.tickPump();var entry=Array.from(E.plans.entries())[0];var arm=worker.findLast(m=>m.type==='arm');
      t=arm.fires[0].dueAt;var msg={planId:entry[0],index:0,seq:arm.seq,dueAt:t};q.tickOnWorkerFire(msg);return msg;};
    var recovery=()=>{var arm=worker.findLast(m=>m.type==='arm');t=arm.fires[0].dueAt;
      var msg={planId:arm.planId,index:0,seq:arm.seq,dueAt:t};q.tickOnWorkerFire(msg);return msg;};
  `);
  return {c,run,q:c.__recoveryQa,sends:c.sends,worker:c.worker,timers};
}
let passes=0,failures=0;function check(name,fn){try{fn();passes++;console.log('PASS '+name)}catch(e){failures++;console.error('FAIL '+name+': '+e.stack)}}
check('waiting rival reuses a locked primary at upper end+10, exactly one packet',()=>{
  const f=fixture();f.run('var old=initial()');assert.equal(f.sends.length,0);assert.equal(f.worker.filter(m=>m.type==='arm').length,2);
  const plan=Array.from(f.q.state.tickEngine.plans.values())[0];assert.equal(plan.shots.length,1);assert.equal(plan.shots[0].phase,160);
  assert.equal(plan.recovery.landing,10360);f.run('var deferred=recovery()');assert.equal(f.sends.length,1);assert.equal(f.sends[0].id,7);
  f.run('q.tickOnWorkerFire(old);q.tickOnWorkerFire(deferred)');assert.equal(f.sends.length,1);
});
check('normal T+13 survives when our lock already ended before callback',()=>{
  const f=fixture();f.run('E.selfLockEnd=10020;initial()');assert.equal(f.worker.filter(m=>m.type==='arm').length,1);assert.equal(f.sends.length,1);assert.equal(f.q.state.tickEngine.shots.at(-1).phase,13);
});
check('no currently lateral rival retains normal locked skip',()=>{
  const f=fixture();f.run('s.providers.renderer.instance.avatars.get(7).position={x:13,y:12};s.actors.clear();initial()');assert.equal(f.worker.filter(m=>m.type==='arm').length,1);assert.equal(f.sends.length,0);
});
check('next grid primary stays at T+13 and clears the shared server gap',()=>{
  const f=fixture();f.run('initial();recovery();t=10460;q.tickPump();var next=worker.at(-1);t=next.fires[0].dueAt;q.tickOnWorkerFire({planId:next.planId,index:0,seq:s.seq,dueAt:t})');
  assert.equal(f.sends.length,2);assert.equal(f.q.state.tickEngine.shots.at(-1).phase,13);assert.ok(f.sends[1].at-f.sends[0].at>=101);
});
check('a too-late recovery cannot consume the next T+13 shared gap',()=>{
  const f=fixture();f.run('E.selfLockEnd=10750;initial()');assert.equal(f.worker.filter(m=>m.type==='arm').length,1);assert.equal(f.sends.length,0);
});
check('exact latest recovery slot leaves 101 ms before next normal primary',()=>{
  const f=fixture();f.run('E.selfLockEnd=10702;initial();recovery();t=10550;q.tickPump();var next=worker.at(-1);t=next.fires[0].dueAt;q.tickOnWorkerFire({planId:next.planId,index:0,seq:s.seq,dueAt:t})');
  assert.equal(f.sends.length,2);assert.equal(f.sends[1].at-f.sends[0].at,101);
});
check('dead target cancels the retained recovery',()=>{
  const f=fixture();f.run('initial();E.out.add(7);recovery()');assert.equal(f.sends.length,0);
});
check('departed native avatar cancels the retained recovery',()=>{
  const f=fixture();f.run('initial();s.providers.renderer.instance.avatars.delete(7);recovery()');assert.equal(f.sends.length,0);
});
check('reused target slot cannot inherit an old recovery',()=>{
  const f=fixture();f.run("initial();s.providers.renderer.instance.avatars.set(7,{userSpaceId:7,position:{x:11,y:11},avatarInfo:{id:701,username:'Replacement'}});recovery()");assert.equal(f.sends.length,0);
});
check('walking out of lateral contact cancels the retained recovery',()=>{
  const f=fixture();f.run('initial();s.providers.renderer.instance.avatars.get(7).position={x:13,y:12};s.actors.clear();recovery()');assert.equal(f.sends.length,0);
});
check('new rival lock cancels the retained recovery',()=>{
  const f=fixture();f.run('initial();E.lockUntil.set(7,11000);recovery()');assert.equal(f.sends.length,0);
});
check('new own lock cancels an earlier recovery',()=>{
  const f=fixture();f.run('initial();E.selfLockEnd=11000;recovery()');assert.equal(f.sends.length,0);
});
check('manual competitor cancels recovery even outside the 100 ms gap',()=>{
  const f=fixture();f.run('initial();q.firePunch(7,"manual");t+=105;recovery()');assert.equal(f.sends.length,1);assert.equal(f.sends[0].reason,'manual');
});
check('changing native ficha cancels a selected-mode recovery',()=>{
  const f=fixture();f.run('s.timing.targetMode="SELECTED";initial();s.providers.renderer.instance.avatars.get(6).position={x:9,y:9};s.providers.selection.instance.avatarFichado=s.providers.renderer.instance.avatars.get(6);recovery()');assert.equal(f.sends.length,0);
});
check('AUTO recovery ignores an unrelated ficha and keeps its chosen native target',()=>{
  const f=fixture();f.run('initial();s.providers.selection.instance.avatarFichado=s.providers.renderer.instance.avatars.get(6);recovery()');assert.equal(f.sends.length,1);assert.equal(f.sends[0].id,7);
});
check('eliminated self never arms recovery',()=>{
  const f=fixture();f.run('E.selfOut=true;initial()');assert.equal(f.worker.filter(m=>m.type==='arm').length,1);assert.equal(f.sends.length,0);
});
check('self in out set cannot recover despite an inconsistent selfOut flag',()=>{
  const f=fixture();f.run('E.out.add(1);initial()');assert.equal(f.worker.filter(m=>m.type==='arm').length,1);assert.equal(f.sends.length,0);
});
check('round countdown is not treated as our punch recovery',()=>{
  const f=fixture();f.run('E.selfLockKind="ROUND";initial()');assert.equal(f.worker.filter(m=>m.type==='arm').length,1);assert.equal(f.sends.length,0);
});
check('ordinary nonisolated Timing keeps its existing scheduler',()=>{
  const f=fixture();f.run('q.applyPunchIsolationConfig({enabled:false});initial()');assert.equal(f.worker.filter(m=>m.type==='arm').length,1);
});
check('mode/sequence changes cancel a pending recovery',()=>{
  const f=fixture();f.run('initial();s.seq++;recovery()');assert.equal(f.sends.length,0);
});
check('known own coco recovery works in an island without bypassing elimination',()=>{
  const f=fixture();f.run('E.selfLockEnd=0;E.selfLockKind="";s.providers.renderer.instance.spaceModel.name="island";s.exitMode.U=20;s.exitMode.self={type:35,start:3000,endAt:10335};initial();recovery()');
  assert.equal(f.sends.length,1);assert.equal(f.q.state.tickEngine.shots.at(-1).phase,160);
});
check('a real coco end clearing the effect does not invalidate a safe pending recovery',()=>{
  const f=fixture();f.run('E.selfLockEnd=0;E.selfLockKind="";s.exitMode.U=20;s.exitMode.self={type:35,start:3000,endAt:10335};initial();s.exitMode.self=null;recovery()');assert.equal(f.sends.length,1);
});
check('a replacement coco cancels the previous predicted end',()=>{
  const f=fixture();f.run('E.selfLockEnd=0;E.selfLockKind="";s.exitMode.U=20;s.exitMode.self={type:35,start:3000,endAt:10335};initial();s.exitMode.self={type:35,start:10050,endAt:17050};recovery()');assert.equal(f.sends.length,0);
});
check('clock refit retains the original recovery schedule frame',()=>{
  const f=fixture();f.run('initial();E.origin=-20;recovery()');assert.equal(f.sends.length,1);assert.equal(f.worker.at(-1).fires[0].dueAt,10186);assert.equal(f.q.state.tickEngine.shots.at(-1).o,0);
});
check('a manual shot between initial planning and callback cancels retiming',()=>{
  const f=fixture();f.run('q.tickPump();q.firePunch(7,"manual");var arm=worker.findLast(m=>m.type==="arm");t=arm.fires[0].dueAt;q.tickOnWorkerFire({planId:arm.planId,index:0,seq:arm.seq,dueAt:t})');
  assert.equal(f.worker.filter(m=>m.type==='arm').length,1);assert.equal(f.sends.length,1);assert.equal(f.sends[0].reason,'manual');
});
check('a callback delivered after the actual lock ended creates no recovery ticket',()=>{
  const f=fixture();f.run('q.tickPump();var arm=worker.findLast(m=>m.type==="arm");t=10370;q.tickOnWorkerFire({planId:arm.planId,index:0,seq:arm.seq,dueAt:arm.fires[0].dueAt})');
  assert.equal(f.worker.filter(m=>m.type==='arm').length,1);assert.equal(f.sends.length,0);
});
check('SELECTED mode preserves its explicit target despite an old mute entry',()=>{
  const f=fixture();f.run('s.timing.targetMode="SELECTED";E.mutedUntil.set(7,11000);initial();recovery()');assert.equal(f.sends.length,1);assert.equal(f.sends[0].id,7);
});
check('eliminated self cannot use a pending coco recovery',()=>{
  const f=fixture();f.run('E.selfLockEnd=0;E.selfLockKind="";s.exitMode.U=20;s.exitMode.self={type:35,start:3000,endAt:10335};initial();E.selfOut=true;E.out.add(1);recovery()');assert.equal(f.sends.length,0);
});
check('three unanswered speculative shots do not mute a valid native Ring player',()=>{
  const f=fixture();f.run('E.selfLockEnd=0;E.silentPending=[{id:7,at:9600},{id:7,at:9700},{id:7,at:9800}];t=10450;q.refreshSilent()');
  assert.equal(f.q.isMuted(7),false);assert.equal(f.q.threatPick(10450,.99).id,7);
});
check('outside Ring the ordinary 8 s silence exclusion remains',()=>{
  const f=fixture();f.run('E.selfLockEnd=0;s.providers.renderer.instance.spaceModel.name="island";E.silentPending=[{id:7,at:9600},{id:7,at:9700},{id:7,at:9800}];t=10450;q.refreshSilent()');
  assert.equal(f.q.isMuted(7),true);assert.equal(f.q.state.tickEngine.mutedUntil.get(7),18450);
});
check('Ring NPC/invalid account still gets the existing 1.8 s exclusion',()=>{
  const f=fixture();f.run('E.selfLockEnd=0;s.providers.renderer.instance.avatars.get(7).avatarInfo.id=0;E.silentPending=[{id:7,at:9600},{id:7,at:9700},{id:7,at:9800}];t=10450;q.refreshSilent()');
  assert.equal(f.q.isMuted(7),true);assert.equal(f.q.state.tickEngine.mutedUntil.get(7),12250);
});
check('eliminated target stays ineligible and contributes no silence verdict',()=>{
  const f=fixture();f.run('E.selfLockEnd=0;E.out.add(7);E.silentPending=[{id:7,at:9600},{id:7,at:9700},{id:7,at:9800}];t=10450;q.refreshSilent()');
  assert.equal(f.q.isMuted(7),false);assert.equal(f.q.threatPick(10450,.99),null);assert.equal(f.q.state.tickEngine.silentCount.has(7),false);
});
check('removed native object is not treated as proof of an eligible player',()=>{
  const f=fixture();f.run('E.selfLockEnd=0;s.providers.renderer.instance.avatars.get(7)._removed=true;E.silentPending=[{id:7,at:9600},{id:7,at:9700},{id:7,at:9800}];t=10450;q.refreshSilent()');assert.equal(f.q.isMuted(7),true);
});
check('late recovery is dropped instead of sending after its edge',()=>{
  const f=fixture();f.run('initial();var edge=worker.at(-1);t=edge.fires[0].dueAt+9;q.tickOnWorkerFire({planId:edge.planId,index:0,seq:s.seq,dueAt:edge.fires[0].dueAt})');
  assert.equal(f.sends.length,0);assert.equal(f.q.state.tickEngine.stats.lastSkip,'recovery_late');
});
check('a small late recovery cannot steal the armed following primary gap',()=>{
  const f=fixture();f.run('E.selfLockEnd=10702;initial();var edge=worker.at(-1);t=10550;q.tickPump();var following=worker.at(-1);t=edge.fires[0].dueAt+2;q.tickOnWorkerFire({planId:edge.planId,index:0,seq:s.seq,dueAt:edge.fires[0].dueAt})');
  assert.equal(f.sends.length,0);assert.equal(f.q.state.tickEngine.stats.lastSkip,'recovery_next_gap');
  f.run('t=following.fires[0].dueAt;q.tickOnWorkerFire({planId:following.planId,index:0,seq:s.seq,dueAt:t})');
  assert.equal(f.sends.length,1);assert.equal(f.q.state.tickEngine.shots.at(-1).phase,13);
});
console.log(`${passes} recovery/silence cases passed`);process.exitCode=failures?1:0;
