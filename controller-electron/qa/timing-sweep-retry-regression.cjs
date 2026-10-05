"use strict";
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync(path.resolve(process.argv[2]||path.join(__dirname,'../electron/game/flash_runtime.page.js')),'utf8')
 .replace('  window[KEY] = {','  window.__sweepQa={state,tickOnWorkerFire,threatPick,notePunch,reactCheck};\n  window[KEY] = {');
function fixture(){
 const timers=[];
 const ctx=vm.createContext({TextEncoder,TextDecoder,Uint8Array,ArrayBuffer,t:136218,setTimeout:(fn,ms)=>{timers.push({fn,ms});return 1;},clearTimeout(){},setInterval:()=>1,clearInterval(){},document:{hidden:false}});
 vm.runInContext('globalThis.window=globalThis;globalThis.performance={now:()=>t};',ctx);vm.runInContext(source,ctx);
 vm.runInContext(`
 globalThis.q=__sweepQa;globalThis.s=q.state;globalThis.E=s.tickEngine;globalThis.sent=[];
 s.selfId=7;s.selfUsername='Herbert';s.serverPingMs=175;s.tickBurst=1;s.timing.enabled=true;s.timing.tick.enabled=true;s.timing.tick.single=true;s.timing.tick.reactive=true;
 s.providers.renderer={instance:{spaceModel:{name:'mGame2'},avatars:new Map([
 [7,{position:{x:15,y:13},avatarInfo:{id:700,username:'Herbert'}}],
 [0,{position:{x:12,y:12},avatarInfo:{id:10802026,username:'Launch'}}],
 [1,{position:{x:17,y:14},avatarInfo:{id:100,username:'LuciferJS'}}],
 [4,{position:{x:19,y:15},avatarInfo:{id:400,username:'Other'}}]
 ])}};
 s.providers.upper={instance:{upperRequest(id){sent.push({id,reason:s.activeFireReason,at:t});s.outboundUpperSeq++;q.notePunch(id,s.activeFireReason);}}};
 for(const [id,x,y,dx,dy]of[[7,15,13,1,1],[0,12,12,1,0],[1,17,14,-1,1],[4,19,15,-1,1]])
 s.actors.set(id,{fromX:x-dx,fromY:y-dy,toX:x,toY:y,dirX:dx,dirY:dy,startAt:135674,endAt:136274,stepMs:600,moving:true,key:id+':'+x+','+y});
 E.origin=73.5;E.batches=[135674];E.lastBatchAt=135673.5;E.lastBatchTick=226;E.selfDest={x:14,y:13};E.selfWalkAt=136049.7;E.walkReqs=[{x:14,y:13,t:136049.7}];
 s.lastPunch={...s.lastPunch,at:136103.4,targetId:0,reason:'TICK_BLIND'};
 globalThis.plan={n:227,shots:[{phase:124,k:1,b:0,sweep:true}],fired:0,burst:1,burstTarget:0,burstReactive:false,burstScore:0.161,o:73.5};
 E.plans.set('TICK:227',plan);
 globalThis.fire=()=>q.tickOnWorkerFire({planId:'TICK:227',index:0,dueAt:t,seq:s.seq});
 `,ctx);
 return {ctx,timers,q:ctx.__sweepQa,run:code=>vm.runInContext(code,ctx)};
}
let failed=0;
function check(name,fn){try{fn();console.log('PASS '+name);}catch(e){failed++;console.error('FAIL '+name+': '+e.message);}}
check('recorded Launch positions reuse the empty sweep slot for the best still-valid primary',()=>{
 const f=fixture();const best=f.q.threatPick(136397.5,0.05);assert.equal(best.id,0);
 assert.equal(f.q.threatPick(136397.5,0.05,0),null,'recorded state has no eligible runner-up');
 f.run('fire()');assert.equal(f.ctx.sent.length,1);assert.equal(f.ctx.sent[0].id,0);assert.equal(f.ctx.sent[0].reason,'TICK_RETRY');
});
check('a runner-up still receives the sweep when one is eligible',()=>{
 const f=fixture();f.run('s.actors.get(1).toX=15;s.actors.get(1).toY=14;s.actors.get(1).dirX=0;s.actors.get(1).dirY=1');f.run('fire()');
 assert.equal(f.ctx.sent.length,1);assert.equal(f.ctx.sent[0].id,1);assert.equal(f.ctx.sent[0].reason,'TICK_SWEEP');
});
check('a confirmed eliminated primary gets no retry',()=>{
 const f=fixture();f.run('E.out.add(0);fire()');assert.equal(f.ctx.sent.length,0);
});
check('a departed primary gets no retry even with a cached actor',()=>{
 const f=fixture();f.run('s.providers.renderer.instance.avatars.delete(0);fire()');assert.equal(f.ctx.sent.length,0);
});
check('the empty slot cannot retry an implausible primary',()=>{
 const f=fixture();f.run('s.actors.get(0).toX=5;s.actors.get(0).toY=5;fire()');assert.equal(f.ctx.sent.length,0);
});
check('a more recent actual punch keeps the server gap clear',()=>{
 const f=fixture();f.run('s.lastPunch.at=t-30;fire()');assert.equal(f.ctx.sent.length,0);
});
check('the native 100 ms boundary is kept clear and the next millisecond is allowed',()=>{
 const f=fixture();f.run('s.lastPunch.at=t-100;fire()');assert.equal(f.ctx.sent.length,0);
 const g=fixture();g.run('s.lastPunch.at=t-101;fire()');assert.equal(g.ctx.sent.length,1);
});
check('an ally cannot become the retry target',()=>{
 const f=fixture();f.run("s.allies.names.add('launch');fire()");assert.equal(f.ctx.sent.length,0);
});
check('a reactive primary does not acquire a blind retry',()=>{
 const f=fixture();f.run('plan.burstReactive=true;fire()');assert.equal(f.ctx.sent.length,0);
});
check('an eliminated self cannot retry',()=>{
 const f=fixture();f.run('E.selfOut=true;fire()');assert.equal(f.ctx.sent.length,0);
});
check('retries are not counted as another independent silent-target trial',()=>{
 const f=fixture();f.run('fire()');assert.equal(f.q.state.tickEngine.silentPending.length,0);
});
check('Launch retry preserves one confirmed-contact reaction after the shared gap',()=>{
 const f=fixture();f.run('fire()');assert.equal(f.ctx.sent.length,1);
 f.run('t=136279;E.lastBatchTick=227;E.lastBatchAt=t;s.actors.clear();s.providers.renderer.instance.avatars.get(7).position={x:14,y:13};s.providers.renderer.instance.avatars.get(0).position={x:13,y:12};q.reactCheck()');
 assert.equal(f.ctx.sent.length,1,'contact cannot send inside the retry gap');
 const pending=f.timers.slice(-2);assert.deepEqual(pending.map(x=>x.ms),[40,46]);
 f.ctx.t=136319;pending[0].fn();assert.equal(f.ctx.sent.length,2);assert.equal(f.ctx.sent[1].id,0);assert.equal(f.ctx.sent[1].reason,'REACT_FALLBACK');
 f.ctx.t=136325;pending[1].fn();assert.equal(f.ctx.sent.length,2,'backup timer does not duplicate the successful fallback');
});
if(failed)process.exitCode=1;
