"use strict";
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const base=process.env.BB_PACKAGED_APP_DIR?path.join(process.env.BB_PACKAGED_APP_DIR,'resources/app.asar/electron'):path.resolve(__dirname,'../electron');
const runtime=path.resolve(process.argv[2]||path.join(base,'game/flash_runtime.page.js'));
const source=fs.readFileSync(runtime,'utf8').replace('  window[KEY] = {','  window.__selectionQa = {state, notePunch, threatPick, tickPickTarget, tickOnWorkerFire, contactEdgePump, landingContactPump, scheduleStatePunch, pulseTargetId, onMoveStep, firePunch, tickHubSummary, softResetCombat};\n  window[KEY] = {');
const selections=[-1,1,7,9,8];
function fixture(selected) {
 const timers=[],sends=[];
 const c=vm.createContext({TextEncoder,TextDecoder,Uint8Array,ArrayBuffer,setTimeout:(fn,ms)=>{timers.push({fn,ms});return 1;},clearTimeout(){},setInterval:()=>1,clearInterval(){},document:{hidden:false}});
 c.window=c; c.performance={now:()=>1000}; vm.runInContext(source,c);
 vm.runInContext(`const q=__selectionQa,s=q.state; s.selfId=1;s.selfUsername='Self';s.serverPingMs=170;s.ready=true;
  s.providers.renderer={instance:{avatars:new Map([
   [1,{position:{x:10,y:10,z:1},avatarInfo:{id:100,username:'Self'}}],
   [7,{position:{x:11,y:11,z:1},avatarInfo:{id:700,username:'Near'}}],
   [8,{position:{x:9,y:9,z:1},avatarInfo:{id:800,username:'Ally'}}],
   [9,{position:{x:14,y:14,z:1},avatarInfo:{id:900,username:'Far'}}]
  ])}};
  s.allies.names.add('ally');
  s.providers.selection={instance:{avatarFichado:{userSpaceId:${selected}}}};s.selectedId=${selected};
  s.timing.enabled=true;s.timing.source='STEP';s.timing.tick.enabled=true;s.timing.tick.single=true;s.tickBurst=1;
  s.tickEngine.origin=0;s.tickEngine.lastBatchAt=600;s.tickEngine.batches=[600];
 `,c);
 c.__selectionQa.state.providers.upper={instance:{lastUpperAt:0,upperRequest(id){sends.push(id);c.__selectionQa.state.outboundUpperSeq++;c.__selectionQa.notePunch(id,c.__selectionQa.state.activeFireReason)}}};
 return {c,q:c.__selectionQa,timers,sends};
}
let failures=0;
function check(name,fn){try{fn();console.log('PASS '+name)}catch(e){failures++;console.error('FAIL '+name+': '+e.message)}}
check('current TICK picks the same contact with no fichado, self, near, far or allied fichado',()=>{
 for(const id of selections){const f=fixture(id);assert.equal(f.q.tickPickTarget(1,1000,1170).id,7,'fichado='+id)}
});
check('automatic STEP movement does not read the native ficha getter',()=>{
 const f=fixture(9);Object.defineProperty(f.q.state.providers.selection.instance,'avatarFichado',{get(){throw Error('Ficha accessed by automatic movement')}});
 f.q.onMoveStep(7,11,11,600,1,'in',0);
});
check('TICK worker dispatches the same rival among four enemies across ficha changes',()=>{
 for(const id of selections){const f=fixture(id);
  vm.runInContext(`q.state.providers.renderer.instance.avatars.set(2,{position:{x:9,y:9,z:1},avatarInfo:{id:200,username:'Other contact'}});
   q.state.providers.renderer.instance.avatars.set(3,{position:{x:12,y:12,z:1},avatarInfo:{id:300,username:'Approaching'}});`,f.c);
  const E=f.q.state.tickEngine;E.plans.set('TICK:1',{n:1,shots:[{k:0,b:0,phase:570}],fired:0,burst:1,o:0,lead:170});
  f.q.tickOnWorkerFire({planId:'TICK:1',index:0,seq:f.q.state.seq,dueAt:1000});
  assert.deepEqual(f.sends,[7],'fichado='+id);
 }
});
check('legacy contact and landing fire at the neighbour with any fichado or none',()=>{
 for(const id of selections)for(const mode of ['edge','landing']){
  const f=fixture(id);f.q.state.timing.tick.enabled=false;f.q.state.timing.landing.enabled=mode==='landing';
  f.q.state.timing.contactGate=true;f.q.state.timing.start=0;f.q.state.timing.end=0;
  if(mode==='edge')f.q.contactEdgePump();else f.q.landingContactPump();
  assert.deepEqual(f.sends,[7],mode+' fichado='+id);
 }
});
check('STATE chooses contact independently of selection',()=>{
 for(const id of selections){const f=fixture(id);f.q.state.timing.source='STATE';f.q.scheduleStatePunch(7,'in_move');for(const t of f.timers)t.fn();assert.deepEqual(f.sends,[7],'fichado='+id)}
});
check('STATE movement still arms when the inactive TICK option remains enabled',()=>{
 for(const id of selections){const f=fixture(id);f.q.state.timing.source='STATE';
  f.q.onMoveStep(7,11,11,600,1,'in',0);for(const t of f.timers)t.fn();
  assert.deepEqual(f.sends,[7],'fichado='+id);
 }
});
check('automatic pulse prioritizes its own proximity choice',()=>{
 for(const id of selections){const f=fixture(id);Object.assign(f.q.state.pulse,{autoTarget:true,requireSelected:true,contactOnly:true,autoRange:2});assert.equal(f.q.pulseTargetId(),7,'fichado='+id)}
});
check('STATE coalesces several moves before dispatch into one current choice',()=>{
 const f=fixture(9);f.q.state.timing.source='STATE';
 for(const id of [7,9,1])f.q.scheduleStatePunch(id,'in_move');
 for(const t of f.timers)t.fn();assert.deepEqual(f.sends,[7]);
});
check('contact edge does not consume a failed native dispatch',()=>{
 const f=fixture(9);f.q.state.timing.tick.enabled=false;f.q.state.timing.contactGate=true;f.q.state.timing.start=0;f.q.state.timing.end=0;
 const upper=f.q.state.providers.upper.instance,send=upper.upperRequest;upper.upperRequest=()=>{};
 f.q.contactEdgePump();assert.equal(f.q.state.contactEdge.wasContact,false);
 upper.upperRequest=send;f.c.performance.now=()=>1013;f.q.contactEdgePump();assert.deepEqual(f.sends,[7]);
});
check('landing contact remains pending until the current request gap opens',()=>{
 const f=fixture(-1);f.q.state.timing.tick.enabled=false;f.q.state.timing.landing.enabled=true;f.q.state.lastPunch.at=950;
 f.q.landingContactPump();assert.equal(f.q.state.landingC.wasContact,false);assert.deepEqual(f.sends,[]);
 f.c.performance.now=()=>1071;f.q.landingContactPump();assert.deepEqual(f.sends,[7]);
});
check('Board receives no ficha priority or entity target lock',()=>{
 const {ControllerCore}=require(path.join(base,'controller-core.cjs'));
 for(const id of selections){const core=new ControllerCore({ringBoard:false,settingsPath:path.join(__dirname,'../../tmp/nonexistent-selection-fixture.json')});
  core.ringBoardConnected=true;core.selfId=1;core.selectedTarget=id;
  core.players=new Map([[1,{id:1,self:true,name:'Self',x:10,y:10}],[7,{id:7,name:'Near',x:11,y:11,selected:id===7}],[9,{id:9,name:'Far',x:14,y:14,selected:id===9}]]);
  const messages=[];core.ringBoardSendSensor=(type,payload)=>messages.push({type,payload});core.pushRingBoardSensors({ts:1000});
  const sel=messages.find(m=>m.type==='selection_state').payload;
  assert.ok(Object.values(sel).every(value=>value===-1),'fichado must not be exported as a locked combat target');
  assert.ok(messages.filter(m=>m.type==='entity_state').every(m=>m.payload.targetLock===false));
 }
});
check('automatic target reporting survives fichar and manual punches, resets on room change',()=>{
 const f=fixture(9);assert.equal(f.q.tickHubSummary().lastTargetId,-1);
 assert.equal(f.q.firePunch(7,'TICK_REACT'),true);assert.equal(f.q.tickHubSummary().lastTargetId,7);
 f.q.state.selectedId=1;f.q.state.providers.selection.instance.avatarFichado.userSpaceId=1;
 f.q.notePunch(9,'native');assert.equal(f.q.tickHubSummary().lastTargetId,7);
 assert.equal(f.q.firePunch(-1,'TICK_BLIND'),false,'automatic shot cannot fall back to a fichado');
 assert.equal(f.q.firePunch(1,'TICK_BLIND'),false,'cannot hit self');
 f.q.state.timing.enabled=false;f.q.softResetCombat('room');assert.equal(f.q.tickHubSummary().lastTargetId,-1);
});
if(failures)process.exitCode=1;
