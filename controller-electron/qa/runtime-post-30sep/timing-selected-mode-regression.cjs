"use strict";
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict'),os=require('node:os');
const base=process.env.BB_PACKAGED_APP_DIR?path.join(process.env.BB_PACKAGED_APP_DIR,'resources/app.asar/electron'):path.resolve(__dirname,'../electron');
const source=fs.readFileSync(path.join(base,'game/flash_runtime.page.js'),'utf8')
 .replace('  window[KEY] = {','  window.__selectedTimingQa = {state, CONTACT_MODEL, applyTimingConfig, applyPunchIsolationConfig, tickEffective, tickPump, tickPickTarget, tickOnWorkerFire, firePunch, notePunch, freshTimingSelection, timingTargetAllowed, tickHubSummary, reactCheck, runlockArm, runlockCovers};\n  window[KEY] = {')
 .replace('  function spinUntil(due) {','  function spinUntil(due) { return;');
function fixture({selected=2,isolation=true,mode='SELECTED'}={}) {
 const timers=[],cleared=[],sends=[];
 const c=vm.createContext({TextEncoder,TextDecoder,Uint8Array,ArrayBuffer,t:10000,
  setTimeout(fn,ms){timers.push({fn,ms});return timers.length},clearTimeout(id){cleared.push(id)},setInterval:()=>1,clearInterval(){},document:{hidden:false}});
 c.window=c;c.performance={now:()=>c.t};vm.runInContext(source,c);
 const run=code=>vm.runInContext(code,c);
 run(`var q=__selectedTimingQa,s=q.state,E=s.tickEngine,worker=[];
  s.selfId=1;s.selfUsername='Self';s.serverPingMs=170;s.ready=true;s.tickBurst=1;s.punchPackets=1;
  s.timing.enabled=true;s.timing.source='STEP';s.timing.tick.enabled=true;s.timing.tick.single=true;
  s.providers.renderer={instance:{spaceModel:{name:'mGame2'},avatars:new Map([
   [1,{userSpaceId:1,position:{x:10,y:10},avatarInfo:{id:100,username:'Self'}}],
   [7,{userSpaceId:7,position:{x:11,y:11},avatarInfo:{id:700,username:'Automatic best'}}],
   [2,{userSpaceId:2,position:{x:9,y:9},avatarInfo:{id:200,username:'Chosen'}}]
  ])}};
  s.providers.selection={instance:{avatarFichado:s.providers.renderer.instance.avatars.get(${selected})||null}};
  s.selectedId=7;s.timingWorker={postMessage(m){worker.push(m)}};
  E.origin=0;E.lastBatchAt=9600;E.lastBatchTick=16;E.batches=[9600];E.auto.loaded=true;
  s.timing.targetMode=${JSON.stringify(mode)};`);
 c.__selectedTimingQa.state.providers.upper={instance:{upperRequest(id){sends.push(id);c.__selectedTimingQa.state.outboundUpperSeq++;c.__selectedTimingQa.notePunch(id,c.__selectedTimingQa.state.activeFireReason)}}};
 if(isolation)run('q.applyPunchIsolationConfig({enabled:true,phaseMs:13})');
 return {c,q:c.__selectedTimingQa,run,sends,timers,cleared};
}
function firePlan(f,preId=7){
 f.run('q.tickPump()');const [planId,plan]=Array.from(f.q.state.tickEngine.plans.entries())[0];
 plan.pre={pick:{id:preId,score:1,reactive:false},avatar:f.q.state.providers.renderer.instance.avatars.get(preId)};
 const dueAt=plan.o+plan.n*600+plan.shots[0].phase-plan.lead;f.c.t=dueAt;
 const msg={planId,index:0,seq:f.q.state.seq,dueAt};f.q.tickOnWorkerFire(msg);return {plan,msg};
}
let passed=0,failed=0;
function check(name,fn){try{fn();passed++;console.log('PASS '+name)}catch(e){failed++;console.error('FAIL '+name+': '+e.stack)}}
check('automatic profile ignores ficha completely and keeps the best rival',()=>{
 const f=fixture({mode:'AUTO'});Object.defineProperty(f.q.state.providers.selection.instance,'avatarFichado',{get(){throw Error('automatic read ficha')}});
 assert.equal(f.q.tickPickTarget(17,10000,10213).id,7);firePlan(f);assert.deepEqual(f.sends,[7]);
});
check('selected mode uses the chosen rival instead of the higher ranked neighbour',()=>{
 const f=fixture();const pick=f.q.tickPickTarget(17,10000,10213);
 assert.equal(pick.id,2);assert.equal(pick.avatar,f.q.state.providers.selection.instance.avatarFichado);
 const {plan,msg}=firePlan(f);assert.equal(plan.shots.length,1);assert.equal(plan.shots[0].phase,13);
 assert.deepEqual(f.sends,[2]);f.q.tickOnWorkerFire(msg);assert.deepEqual(f.sends,[2]);
});
check('changing ficha after preflight recomputes the sole current target',()=>{
 const f=fixture({selected:7});f.q.tickPump();const [planId,plan]=Array.from(f.q.state.tickEngine.plans.entries())[0];
 plan.pre={pick:{id:7,score:1,reactive:false},avatar:f.q.state.providers.renderer.instance.avatars.get(7)};
 f.run('s.providers.selection.instance.avatarFichado=s.providers.renderer.instance.avatars.get(2)');
 f.q.tickOnWorkerFire({planId,index:0,seq:f.q.state.seq,dueAt:10000});assert.deepEqual(f.sends,[2]);
});
check('cleared ficha never falls back to the cached selection or automatic candidate',()=>{
 const f=fixture({selected:-1});assert.equal(f.q.freshTimingSelection(),null);
 firePlan(f);assert.deepEqual(f.sends,[]);
 for(const id of [-1,2,7])assert.equal(f.q.firePunch(id,'CTRL'),false);
});
check('a new ficha invalidates a cached no-selection preflight too',()=>{
 const f=fixture({selected:-1});f.q.tickPump();const [planId,plan]=Array.from(f.q.state.tickEngine.plans.entries())[0];
 plan.pre={pick:{skip:'no_selection'},avatar:null,selectedAvatar:null};
 f.run('s.providers.selection.instance.avatarFichado=s.providers.renderer.instance.avatars.get(2)');
 f.q.tickOnWorkerFire({planId,index:0,seq:f.q.state.seq,dueAt:10000});assert.deepEqual(f.sends,[2]);
});
check('recycled slot cannot inherit the old native ficha',()=>{
 const f=fixture();f.run(`s.providers.renderer.instance.avatars.set(2,{userSpaceId:2,position:{x:9,y:9},avatarInfo:{id:201,username:'Replacement'}})`);
 assert.equal(f.q.freshTimingSelection(),null);firePlan(f,2);assert.deepEqual(f.sends,[]);
});
check('a queued shot cannot cross even a freshly selected replacement at the same id',()=>{
 const f=fixture();const original=f.q.freshTimingSelection().avatar;
 f.run(`var replacement={userSpaceId:2,position:{x:9,y:9},avatarInfo:{id:201,username:'Replacement'}};
  s.providers.renderer.instance.avatars.set(2,replacement);s.providers.selection.instance.avatarFichado=replacement`);
 assert.equal(f.q.firePunch(2,'TICK_BLIND',{avatar:original}),false);assert.deepEqual(f.sends,[]);
 assert.equal(f.q.firePunch(2,'TICK_BLIND',{avatar:f.q.freshTimingSelection().avatar}),true);assert.deepEqual(f.sends,[2]);
});
check('self, departed, removed and foreign ficha objects are unusable',()=>{
 for(const code of ["s.providers.selection.instance.avatarFichado=s.providers.renderer.instance.avatars.get(1)",
  "s.providers.selection.instance.avatarFichado.__departing=true","s.providers.selection.instance.avatarFichado._removed=true",
  "s.providers.selection.instance.avatarFichado={userSpaceId:2}"]){const f=fixture();f.run(code);assert.equal(f.q.freshTimingSelection(),null);firePlan(f);assert.deepEqual(f.sends,[])}
});
check('allied and eliminated ficha are rejected without switching to another rival',()=>{
 for(const code of ["s.allies.names.add('chosen')","E.out.add(2)"]){const f=fixture();f.run(code);firePlan(f);assert.deepEqual(f.sends,[]);assert.equal(f.q.firePunch(2,'CTRL'),false);assert.equal(f.q.tickHubSummary().selectedTargetId,-1)}
});
check('selected candidate keeps the same probability threshold as automatic',()=>{
 for(const mode of ['AUTO','SELECTED']){const f=fixture({mode});
  f.run("s.providers.renderer.instance.avatars.delete(7);s.providers.renderer.instance.avatars.get(2).position={x:11,y:12};q.CONTACT_MODEL.full['1,2,0']=0.0008");
  assert.equal(f.q.tickPickTarget(17,10000,10213).id,2,mode);
 }
});
check('Board CTRL commands and retained manual ids cannot hit another player',()=>{
 const f=fixture();assert.equal(f.q.firePunch(7,'CTRL'),false);assert.equal(f.q.firePunch(7,'manual'),false);
 assert.equal(f.q.firePunch(2,'CTRL'),true);assert.deepEqual(f.sends,[2]);
});
check('the native ficha is revalidated for every physical request in a burst',()=>{
 const f=fixture({isolation:false});f.q.state.tickBurst=5;
 const upper=f.q.state.providers.upper.instance,original=upper.upperRequest;
 upper.upperRequest=id=>{original(id);f.q.state.providers.selection.instance.avatarFichado=null};
 assert.equal(f.q.firePunch(2,'TICK_BLIND',{bypassThrottle:true}),true);assert.deepEqual(f.sends,[2]);
});
check('mode transition invalidates retained worker tickets and contact callbacks',()=>{
 const f=fixture({mode:'AUTO',isolation:false});f.q.tickPump();const [planId]=Array.from(f.q.state.tickEngine.plans.keys());const seq=f.q.state.seq;
 f.q.state.lastPunch.at=9950;f.q.reactCheck();const pending=f.q.state.react.fallback;assert.ok(pending?.timer);
 f.q.applyTimingConfig({targetMode:'SELECTED'});assert.notEqual(f.q.state.seq,seq);assert.equal(f.q.state.react.fallback,null);
 assert.ok(f.cleared.includes(pending.timer));f.timers[pending.timer-1].fn();
 f.q.tickOnWorkerFire({planId,index:0,seq,dueAt:10000});assert.deepEqual(f.sends,[]);
});
check('another rival unlock does not reserve the selected target primary slot',()=>{
 const f=fixture({isolation:false});f.q.state.tickEngine.runlock.set(7,{end:10200,landing:10210,avatar:f.q.state.providers.renderer.instance.avatars.get(7)});
 assert.equal(f.q.runlockCovers(10213),false);f.q.runlockArm(7,10300);assert.equal(f.q.state.tickEngine.runlockStats.armed,0);
});
check('live status reflects cleared ficha instead of retaining its former name',()=>{
 const f=fixture();assert.equal(f.q.tickHubSummary().selectedTargetId,2);assert.equal(f.q.tickHubSummary().selectedTargetName,'Chosen');assert.equal(f.q.tickHubSummary().fixedPhaseMs,13);
 f.run('s.providers.selection.instance.avatarFichado=null');assert.equal(f.q.tickHubSummary().selectedTargetId,-1);assert.equal(f.q.tickHubSummary().selectedTargetName,'');
});
check('Core normalizes and roundtrips selected mode without configuration churn',()=>{
 const {ControllerCore,normalizeTimingConfig,timingMessage}=require(path.join(base,'controller-core.cjs'));
 assert.equal(normalizeTimingConfig({}).targetMode,'AUTO');assert.equal(normalizeTimingConfig({targetMode:'bad'}).targetMode,'AUTO');
 const core=new ControllerCore({ringBoard:false,settingsPath:path.join(os.tmpdir(),'missing-bb-selected-qa-'+process.pid+'.json')});
 core.persistSettings=()=>{};core.emitSnapshot=()=>{};core.sendToSwf=()=>{};
 core.applyTiming({enabled:true,targetMode:'SELECTED'});assert.equal(core.timing.enabled,true);assert.equal(core.timing.targetMode,'SELECTED');
 const timing=normalizeTimingConfig(core.timing);assert.equal(timingMessage(timing,true).targetMode,'SELECTED');
 const reply={timing,punchPackets:1,moveDelay:core.moveDelay};assert.equal(core.swfConfigMatchesDesired(reply),true);
 assert.equal(core.swfConfigMatchesDesired({...reply,timing:{...timing,targetMode:'AUTO'}}),false);
 core.applyTiming({targetMode:'AUTO'});assert.equal(core.timing.enabled,true);assert.equal(core.timing.targetMode,'AUTO');
 core.applyTiming({enabled:false});assert.equal(core.timing.targetMode,'AUTO');
});
check('Core retains selected mode across hotkeys, disable and restart',()=>{
 const {ControllerCore}=require(path.join(base,'controller-core.cjs')),dir=fs.mkdtempSync(path.join(os.tmpdir(),'bb-selected-qa-'));
 try{const settingsPath=path.join(dir,'settings.json'),core=new ControllerCore({ringBoard:false,settingsPath});
  core.emitSnapshot=()=>{};core.sendToSwf=()=>{};core.applyTiming({enabled:true,targetMode:'SELECTED'});core.toggleHotkeyMode('TIMING');
  assert.equal(core.timing.enabled,false);assert.equal(core.timing.targetMode,'SELECTED');
  const again=new ControllerCore({ringBoard:false,settingsPath});assert.equal(again.timing.targetMode,'SELECTED');again.stopModes();
  assert.equal(again.timing.targetMode,'SELECTED');
 }finally{const resolved=path.resolve(dir);assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(resolved).startsWith('bb-selected-qa-'));fs.rmSync(resolved,{recursive:true,force:true})}
});
check('an old connected game cannot pretend to support selected Timing',()=>{
 const {ControllerCore}=require(path.join(base,'controller-core.cjs'));
 const core=new ControllerCore({ringBoard:false,settingsPath:path.join(os.tmpdir(),'missing-bb-selected-cap-'+process.pid+'.json')});
 core.persistSettings=()=>{};core.emitSnapshot=()=>{};core.sendToSwf=()=>{};core.swfSocket={};
 core.handleSwfMessage({type:'state',tick:{enabled:false,synced:true},timing:{enabled:false}});
 assert.throws(()=>core.applyTiming({targetMode:'SELECTED'}),/Reabre el juego/);assert.equal(core.timingTargetMode,'AUTO');
 core.applyTiming({targetMode:'SELECTED',enabled:false});assert.equal(core.timing.enabled,false);
 core.handleSwfMessage({type:'state',tick:{targetMode:'AUTO',enabled:false,fixedPhaseMs:13},timing:{enabled:false,targetMode:'AUTO'}});
 core.applyTiming({targetMode:'SELECTED',enabled:true});assert.equal(core.timing.enabled,true);
});
console.log(`${passed} selected Timing cases passed`);process.exitCode=failed?1:0;
