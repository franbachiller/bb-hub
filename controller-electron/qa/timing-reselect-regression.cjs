"use strict";
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), assert = require('node:assert/strict');
const source = fs.readFileSync(path.resolve(process.argv[2] || path.join(__dirname, '../electron/game/flash_runtime.page.js')), 'utf8');
function fixture() {
  const timers = [];
  const ctx = vm.createContext({TextEncoder,TextDecoder,Uint8Array,ArrayBuffer,t:10000,
    setTimeout:(fn,ms)=>{timers.push({fn,ms});return timers.length;},clearTimeout(){},setInterval:()=>1,clearInterval(){},document:{hidden:false}});
  vm.runInContext('globalThis.window=globalThis;performance={now:()=>t};',ctx);
  vm.runInContext(source.replace('  window[KEY] = {','  window.__q = {state,reactCheck,notePunch,firePunch,threatPick};\n  window[KEY] = {'),ctx);
  const run = script => vm.runInContext(script,ctx);
  run(`globalThis.s=__q.state;globalThis.E=s.tickEngine;globalThis.sends=[];
    s.selfId=3;s.selfUsername='Self';s.serverPingMs=167;s.ready=true;s.tickBurst=1;
    s.timing.enabled=true;s.timing.source='STEP';s.timing.tick.enabled=true;s.timing.tick.reactive=true;s.timing.tick.single=true;
    E.lastBatchAt=10000;E.lastBatchTick=16;E.tickTargets.set(16,2);
    s.providers.renderer={instance:{spaceModel:{name:'mGame2'},avatars:new Map([
    [3,{position:{x:14,y:17},avatarInfo:{id:300,username:'Self'}}],
    [2,{position:{x:15,y:18},avatarInfo:{id:200,username:'First'}}],
    [7,{position:{x:13,y:16},avatarInfo:{id:700,username:'Second'}}]])}};
    s.providers.upper={instance:{lastUpperAt:0,upperRequest(id){sends.push({id,at:t});s.outboundUpperSeq++;__q.notePunch(id,s.activeFireReason);}}};
    s.lastPunch.at=9946;s.lastPunch.targetId=2;s.lastPunch.reason='TICK_REPEAT';`);
  return {ctx,run,timers,q:ctx.__q};
}
let cases = 0;
for (const [scenario,change,expected] of [
  ['first_departed','s.providers.renderer.instance.avatars.delete(2)',7],
  ['first_departing','s.providers.renderer.instance.avatars.get(2).__departing=true',7],
  ['first_moved','s.actors.get(2).toX=17;s.actors.get(2).toY=18',7],
  ['first_eliminated','E.out.add(2)',7],
  ['first_locked','E.lockUntil.set(2,20000)',7],
  ['first_muted','E.mutedUntil.set(2,20000)',7],
  ['first_stays','',2],
  ['all_invalid','E.out.add(2);E.out.add(7)',null],
  ['round_changed','s.seq++',null],
  ['timing_disabled','s.timing.enabled=false',null],
  ['new_batch','E.lastBatchAt=10010;E.lastBatchTick=17',null],
  ['self_eliminated','E.selfOut=true',null]
]) {
  const f=fixture();f.q.reactCheck();assert.equal(f.ctx.sends.length,0);
  f.run(change);f.ctx.t=10047;f.timers[0].fn();f.ctx.t=10053;f.timers[1].fn();
  const sent=JSON.parse(JSON.stringify(f.ctx.sends));
  assert.equal(sent.length,expected==null?0:1,scenario);
  if(expected!=null){assert.equal(sent[0].id,expected,scenario);assert.ok(sent[0].at-9946>=101,'retain actual request gap');}
  console.log('PASS reaction reselect: '+scenario);cases++;
}
{
  const f=fixture();
  f.run('s.providers.renderer.instance.avatars.get(2).__departing=true;s.providers.renderer.instance.avatars.delete(7)');
  assert.equal(f.q.threatPick(10170,0)?.id??null,null,'departing avatar is not eligible for predictive picks');
  assert.equal(f.q.firePunch(2,'TICK_REPEAT',{bypassThrottle:true}),false,'automatic retained target must reject native departure');
  assert.equal(f.q.firePunch(2,'manual'),true,'manual API behavior is preserved');
  console.log('PASS native departing flag excludes automatic selection and dispatch');cases++;
}
{
  const f=fixture();
  // A rival already in contact is not a fresh fallback. Preserve the original
  // one-plan-per-contact rule rather than repeatedly attacking an old contact.
  f.run('s.react.lateral.add(7)');f.q.reactCheck();f.run('E.out.add(2)');
  f.ctx.t=10047;f.timers[0].fn();f.ctx.t=10053;f.timers[1].fn();
  assert.equal(f.ctx.sends.length,0,'reselection only uses fresh siblings of the original batch');
  console.log('PASS reaction reselect does not add an old contact');cases++;
}
console.log('PASS '+cases+' contact reselection/departure regression cases');
