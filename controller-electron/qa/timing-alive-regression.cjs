"use strict";
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync(path.resolve(process.argv[2]||path.join(__dirname,'../electron/game/flash_runtime.page.js')),'utf8').replace('  window[KEY] = {','  window.__aliveQa = {state,onPacket,firePunch,refreshEliminated,ensureActorFromRenderer,tickResetGrid,tickOnWorkerFire};\n  window[KEY] = {');
let failures=0;
function check(name,fn){try{fn();}catch(e){failures++;console.error('FAIL '+name+': '+e.message);}}
function fixture(room='mGame2'){
 const ctx=vm.createContext({TextEncoder,TextDecoder,Uint8Array,ArrayBuffer,t:10000,setTimeout:()=>1,clearTimeout(){},setInterval:()=>1,clearInterval(){},document:{hidden:false}});
 vm.runInContext('globalThis.window=globalThis;globalThis.performance={now:()=>t};',ctx);vm.runInContext(source,ctx);
 vm.runInContext(`
 globalThis.q=__aliveQa;globalThis.s=q.state;globalThis.E=s.tickEngine;globalThis.sends=[];
 s.selfId=1;s.selfUsername='Self';s.serverPingMs=170;s.tickBurst=1;s.timing.enabled=true;s.timing.tick.enabled=true;s.idleSoft=false;
 s.providers.renderer={instance:{spaceModel:{name:${JSON.stringify(room)}},avatars:new Map([
 [1,{position:{x:10,y:10},avatarInfo:{id:100,username:'Self'}}],
 [7,{position:{x:11,y:11},avatarInfo:{id:700,username:'Rival'}}]
 ])}};
 s.providers.upper={instance:{lastUpperAt:0,upperRequest(id){sends.push(id);s.outboundUpperSeq++;}}};
 globalThis.hit=(attacker,defender)=>q.onPacket({id:211,type:0,fields:[1,1,attacker,11,11,1,defender,10,10].map(String)},'in');
 `,ctx);return{ctx,q:ctx.__aliveQa,run:c=>vm.runInContext(c,ctx)};
}
check('queued eliminated target',()=>{
 const f=fixture();f.run('hit(2,7)');
 f.run("E.origin=0;E.plans.set('TICK:17',{n:17,shots:[{phase:110,k:1,b:0,repeat:true}],fired:0,burst:1,burstTarget:7,burstReactive:false,burstScore:1,o:0});q.tickOnWorkerFire({planId:'TICK:17',index:0,dueAt:t,seq:s.seq})");
 assert.equal(f.ctx.sends.length,0);assert.equal(f.q.firePunch(7,'manual'),true,'manual control remains available');
 console.log('PASS eliminated target cannot receive queued automatic punch; manual control preserved');
});
check('Ring spectator replacement',()=>{
 const f=fixture();f.run('hit(2,7);globalThis.old=s.providers.renderer.instance.avatars.get(7);s.providers.renderer.instance.avatars.delete(7)');f.q.refreshEliminated();
 f.run('s.providers.renderer.instance.avatars.set(7,{...old})');f.q.refreshEliminated();
 assert.equal(f.q.state.tickEngine.out.has(7),true,'a Ring spectator reappearing must stay eliminated until the next round');
 f.q.tickResetGrid('gong');assert.equal(f.q.state.tickEngine.out.has(7),false,'the new round clears the elimination');
 console.log('PASS Ring eliminated IDs remain out through roster replacement and reset on new round');
});
check('island re-entry',()=>{
 const f=fixture('BaoBab');f.run('hit(2,7);globalThis.old=s.providers.renderer.instance.avatars.get(7);s.providers.renderer.instance.avatars.delete(7)');f.q.refreshEliminated();
 f.run('s.providers.renderer.instance.avatars.set(7,{...old})');f.q.refreshEliminated();assert.equal(f.q.state.tickEngine.out.has(7),false);
 console.log('PASS island rival becomes eligible after leaving and returning');
});
check('island ID replacement between polls',()=>{
 const f=fixture('Beluga Beach');f.run('hit(2,7);globalThis.old=s.providers.renderer.instance.avatars.get(7);s.providers.renderer.instance.avatars.set(7,{...old})');f.q.refreshEliminated();
 assert.equal(f.q.state.tickEngine.out.has(7),false,'a replacement between 100 ms polls is still a new island incarnation');
 console.log('PASS island ID reuse without an observable gap clears old elimination');
});
check('self re-entry',()=>{
 const f=fixture('BaoBab');f.run('hit(7,1);globalThis.old=s.providers.renderer.instance.avatars.get(1);s.providers.renderer.instance.avatars.delete(1)');f.q.refreshEliminated();
 f.run('s.providers.renderer.instance.avatars.set(1,{...old})');f.q.refreshEliminated();
 assert.equal(f.q.state.tickEngine.selfOut,false,'our island re-entry must clear our elimination flag too');
 assert.equal(f.q.state.tickEngine.pausedUntil,0);assert.equal(f.q.firePunch(7,'TICK_BLIND',{bypassThrottle:true}),true);
 console.log('PASS self re-entry clears stale out/pause flags and automatic combat resumes');
});
check('departed cached ID',()=>{
 const f=fixture();f.q.ensureActorFromRenderer(7);f.run('s.providers.renderer.instance.avatars.delete(7)');
 assert.equal(f.q.firePunch(7,'TICK_REPEAT',{bypassThrottle:true}),false,'an actor cache cannot authorize a departed ID');assert.equal(f.ctx.sends.length,0);
 console.log('PASS cached actor with no live avatar cannot receive an automatic request');
});
if(failures)process.exitCode=1;
