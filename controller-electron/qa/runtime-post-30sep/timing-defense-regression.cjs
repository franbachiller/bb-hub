"use strict";
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('node:assert/strict');
const file=path.resolve(process.argv[2]||path.join(__dirname,'../electron/game/flash_runtime.page.js'));
let source=fs.readFileSync(file,'utf8').replace('  window[KEY] = {','  window.__defenseQa = {state,reactCheck,cocoSelfOnStep,tickResetGrid,tickOnWorkerFire,exitArm,exitOnWorkerFire,roundStartNote};\n  window[KEY] = {');
const spin=source.indexOf('  function spinUntil('),end=source.indexOf('\n  }',spin)+4;source=source.slice(0,spin)+'  function spinUntil() {}'+source.slice(end);
function fixture(){
 const timers=[],messages=[],arms=[];
 const c=vm.createContext({console,TextEncoder,TextDecoder,Uint8Array,ArrayBuffer,t:1000,
  setTimeout:(fn,ms)=>{const o={fn,ms,at:c.t+ms,canceled:false};timers.push(o);return o},clearTimeout:o=>{if(o)o.canceled=true},setInterval:()=>1,clearInterval(){},document:{hidden:false},__bbHubSend:m=>messages.push(m)});
 c.window=c;c.performance={now:()=>c.t};vm.runInContext(source,c);
 vm.runInContext(`globalThis.q=__defenseQa;globalThis.s=q.state;globalThis.E=s.tickEngine;globalThis.sent=[];globalThis.cocos=[];
 s.selfId=1;s.selfUsername='Self';s.serverPingMs=170;s.tickBurst=1;s.timing.enabled=true;s.timing.tick.enabled=true;s.timing.tick.single=true;s.timing.tick.reactive=true;s.idleSoft=false;
 s.timingWorker={postMessage(m){armMessages.push(m)}};
 s.providers.renderer={instance:{spaceModel:{name:'mGame2'},avatars:new Map([[1,{position:{x:10,y:10},avatarInfo:{id:100,username:'Self'}}],[7,{position:{x:11,y:11},avatarInfo:{id:700,username:'Rival'}}]])}};
 s.providers.upper={instance:{upperRequest(id){sent.push({id,at:t,reason:s.activeFireReason});s.outboundUpperSeq++;s.lastPunch.at=t;s.lastPunch.seq++;},cocoRequest(id){cocos.push(id)}}};
 `,Object.assign(c,{armMessages:arms}));
 return {c,q:c.__defenseQa,run:code=>vm.runInContext(code,c),timers,arms,messages,flushAt(at){c.t=at;for(const o of timers.slice()){if(!o.canceled&&o.at<=at){o.canceled=true;o.fn()}}}};
}
let failures=0;function check(n,fn){try{fn();console.log('PASS '+n)}catch(e){failures++;console.error('FAIL '+n+': '+e.message)}}
check('guard coverage prevents redundant self coco',()=>{const f=fixture();f.run('t=2800;E.selfLockEnd=3000;E.selfLockKind="UPPER";s.cocoGuard.upperEnd=3000;s.cocoGuard.pending.set(7,3300);q.cocoSelfOnStep(7)');assert.equal(f.c.cocos.length,0)});
check('round countdown is not an upper animation needing self coco',()=>{const f=fixture();f.run('t=2800;E.selfLockEnd=3000;E.selfLockKind="ROUND";q.cocoSelfOnStep(7)');assert.equal(f.c.cocos.length,0)});
check('an uncovered ambusher still permits the enabled self coco feature',()=>{const f=fixture();f.run('t=2800;E.selfLockEnd=3000;E.selfLockKind="UPPER";s.cocoGuard.upperEnd=3000;q.cocoSelfOnStep(7)');assert.deepEqual(Array.from(f.c.cocos),[1])});
check('stationary walk-in keeps one fallback after a speculative tick shot',()=>{const f=fixture();f.run('E.lastBatchAt=1000;E.lastBatchTick=2;E.tickTargets.set(2,7);s.lastPunch.at=950;q.reactCheck()');f.flushAt(1051);assert.equal(f.c.sent.length,1);assert.equal(f.c.sent[0].id,7);assert.equal(f.c.sent[0].reason,'REACT_FALLBACK')});
check('a delayed reaction rechecks the latest shared punch gap',()=>{const f=fixture();f.run('E.lastBatchAt=1000;s.lastPunch.at=950;q.reactCheck();t=1040;s.lastPunch.at=1040');f.flushAt(1051);assert.equal(f.c.sent.length,0);f.flushAt(1141);assert.equal(f.c.sent.length,1)});
check('a queued reaction cannot survive Timing being disabled',()=>{const f=fixture();f.run('E.lastBatchAt=1000;s.lastPunch.at=950;q.reactCheck();s.timing.enabled=false');f.flushAt(1051);assert.equal(f.c.sent.length,0)});
check('a successful reaction is not duplicated by its delayed callback',()=>{const f=fixture();f.run('E.lastBatchAt=1000;s.lastPunch.at=950;q.reactCheck()');f.flushAt(1051);f.flushAt(1057);assert.equal(f.c.sent.length,1)});
check('room/round reset clears previous locks and defensive coverage',()=>{const f=fixture();f.run('E.selfLockEnd=20000;E.pausedUntil=19000;E.lockUntil.set(7,20000);s.cocoGuard.upperEnd=20000;s.cocoGuard.selfEnd=20000;s.cocoGuard.pending.set(7,20300);s.react.lateral.add(7);s.exitMode.self={endAt:20000};s.exitMode.plan={endAt:20000};q.tickResetGrid("gong")');assert.equal(f.q.state.tickEngine.selfLockEnd,0);assert.equal(f.q.state.tickEngine.pausedUntil,0);assert.equal(f.q.state.tickEngine.lockUntil.size,0);assert.equal(f.q.state.cocoGuard.pending.size,0);assert.equal(f.q.state.react.lateral.size,0);assert.equal(f.q.state.exitMode.plan,null)});
check('a tick repeat respects a contact shot from another mechanism',()=>{const f=fixture();f.run('E.origin=0;s.lastPunch.at=950;E.plans.set("TICK:2",{n:2,shots:[{phase:10,k:1,b:0,repeat:true}],fired:0,burst:1,burstTarget:7,burstReactive:false,burstScore:1,o:0});q.tickOnWorkerFire({planId:"TICK:2",index:0,dueAt:t,seq:s.seq})');assert.equal(f.c.sent.length,0);assert.equal(f.q.state.tickEngine.stats.lastSkip,'shared_gap')});
check('coco exit with no first target retains its backup for a new walk-in',()=>{const f=fixture();f.run('s.providers.renderer.instance.avatars.get(7).position={x:20,y:20};s.exitMode.self={endAt:1200};s.exitMode.plan={endAt:1200,shots:[{phase:6,k:0,b:0},{phase:111,k:1,b:0}],target:null,sent:[],replies:[],done:false};q.exitOnWorkerFire({planId:"EXIT:1200",index:0,dueAt:t})');assert.equal(f.q.state.exitMode.plan.done,false,'no first target must not cancel the backup');f.run('s.providers.renderer.instance.avatars.get(7).position={x:11,y:11};s.actors.delete(7);t=1141;q.exitOnWorkerFire({planId:"EXIT:1200",index:1,dueAt:t})');assert.equal(f.c.sent.length,1);assert.equal(f.c.sent[0].id,7)});
if(failures)process.exitCode=1;
