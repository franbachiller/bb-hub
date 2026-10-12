"use strict";
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('node:assert/strict');
const source=fs.readFileSync(path.join(__dirname,'../electron/game/flash_runtime.page.js'),'utf8')
 .replaceAll('await import(url)','await window.__qaImport(url)')
 .replace('  window[KEY] = {','  window.__providerQa = {state,refreshOptionalProviders,optionalProviderReady,hookSocket,stepWalkOnSelfStep};\n  window[KEY] = {');
function fixture(){
 const calls=[],timers=[];
 const c=vm.createContext({console,TextEncoder,TextDecoder,Uint8Array,ArrayBuffer,t:5000,
  setTimeout:(fn,ms)=>{timers.push({fn,ms});return timers.length},clearTimeout(){},setInterval:()=>1,clearInterval(){},
  document:{querySelectorAll:()=>[]},performance:{now:()=>c.t,getEntriesByType:()=>[{name:'https://static.boombang.tv/betahtml5/_astro/late-selection.js'}]}});
 c.window=c;c.__qaImport=async url=>{calls.push(url);return c.lateModule};vm.runInContext(source,c);
 const q=c.__providerQa;
 for(const key of ['selection','space','ping','map','nav','game','pixi','action'])q.state.providers[key]={instance:{}};
 vm.runInContext(`globalThis.q=__providerQa;globalThis.s=q.state;globalThis.sent=[];
 class Packet {constructor(id){this.id=id;this.mBody=[177,id,179,178];}appendParameter(v){this.mBody.push(...new TextEncoder().encode(String(v)),179,178);}toByteArray(){return Uint8Array.from([...this.mBody,176]);}}
 globalThis.lateModule={packetExport:Packet};
 class Socket {sendServerMessage(pk){sent.push(pk);}handleReceivedBytes(){}}
 const socket=new Socket();s.providers.socket={exported:Socket,instance:socket};q.hookSocket(s.providers.socket);
 s.selfId=1;s.selfUsername='Self';s.providers.renderer={instance:{spaceModel:{name:'mGame2'},avatars:new Map([[1,{position:{x:10,y:10},avatarInfo:{id:100,username:'Self'}}]])}};
 globalThis.walk=(x,y)=>{const p=new Packet(182);p.appendParameter(String(x).padStart(2,'0')+String(y).padStart(2,'0')+'4');p.appendParameter('');socket.sendServerMessage(p)};
 `,c);
 return {c,q,calls,timers,run:code=>vm.runInContext(code,c)};
}
let failures=0;async function check(name,fn){try{await fn();console.log('PASS '+name)}catch(e){failures++;console.error('FAIL '+name+': '+e.message)}}
async function refreshed(f){f.q.refreshOptionalProviders();for(let i=0;i<8;i++)await Promise.resolve();assert.equal(f.q.state.providerRefreshBusy,false);}
(async()=>{
 await check('late packet export is discovered without requiring a singleton',async()=>{const f=fixture();await refreshed(f);assert.equal(f.q.optionalProviderReady('packet',f.q.state.providers.packet),true);assert.equal(f.q.state.providers.packet.instance,null);assert.equal(f.calls.length,1);f.c.t+=2500;await refreshed(f);assert.equal(f.calls.length,1,'a constructor must not be rediscovered every two seconds');});
 await check('missing builder forwards one native path and leaves no unsent goal',()=>{const f=fixture();f.run('walk(13,13)');assert.equal(f.c.sent.length,1);assert.equal(f.q.state.stepWalk.steps,0);assert.equal(f.q.state.stepWalk.goal,null);f.q.stepWalkOnSelfStep(11,11);assert.equal(f.c.sent.length,1,'incoming steps must not resume an unsent replacement');});
 await check('late builder restores one-tile requests and the original destination',async()=>{const f=fixture();await refreshed(f);f.run('walk(13,13)');assert.equal(f.c.sent.length,1,'the native full path must not also be sent');assert.equal(f.q.state.stepWalk.steps,1);assert.deepEqual(Array.from(f.c.sent[0].toByteArray()),[177,182,179,178,...Buffer.from('11114'),179,178,179,178,176]);assert.equal(f.q.state.stepWalk.goal.x,13);f.q.stepWalkOnSelfStep(11,11);assert.equal(f.c.sent.length,2);assert.equal(f.q.state.stepWalk.steps,2);assert.deepEqual(Array.from(f.c.sent[1].toByteArray()),[177,182,179,178,...Buffer.from('12124'),179,178,179,178,176]);f.q.stepWalkOnSelfStep(13,13);assert.equal(f.q.state.stepWalk.goal,null);assert.equal(f.c.sent.length,2);});
 process.exitCode=failures?1:0;
})();
