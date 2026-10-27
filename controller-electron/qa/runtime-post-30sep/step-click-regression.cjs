"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const os = require("node:os");
const runtimeFile = path.resolve(__dirname, "../electron/game/flash_runtime.page.js");
const source = fs.readFileSync(runtimeFile, "utf8").replace("  window[KEY] = {", "  window.__stepQa = {state, stepClick, stepClickObserve, stepClickFire, earlyInboundTap, onPacket, hookSocket, hookSocketWorkerEarly, stepClickWorkerMain, stepClickSampleCrossing, stepClickNativeWalks, sendTick};\n  window[KEY] = {");
const official = fs.readFileSync(path.join(__dirname, "harness/fixtures/client-methods.txt"), "utf8");
function section(text, a, b) { return text.slice(text.indexOf(a), text.indexOf(b, text.indexOf(a) + a.length)); }

function fixture() {
  const sends = [], workers = [], messages = [];
  const c = vm.createContext({ TextEncoder, TextDecoder, Uint8Array, ArrayBuffer,
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    document: { hidden: false }, Blob: class {}, URL: { createObjectURL: () => "blob:qa", revokeObjectURL() {} },
    Worker: class { constructor() { this.messages = []; workers.push(this); } postMessage(m) { this.messages.push(m); } terminate() {} },
    __bbHubSend: (msg) => messages.push(msg)
  });
  c.window = c; c.time = 1000; c.performance = { now: () => c.time, timeOrigin: 100000 };
  vm.runInContext(source, c);
  vm.runInContext(`
    ${section(official, "class $ {", "function mc()")}
    class Socket { static instance = new Socket(); sendServerMessage(p) { captured.push([...p.toByteArray()]); } handleReceivedBytes() {} }
    const W = Socket;
    class Upper { static instance = new Upper(); lastUpperAt = 0;
      ${section(official, '  ["upperRequest"](t) {', '  ["changeHobbiesRequest"]')}
    }
    const q = __stepQa, s = q.state;
    s.selfId = 1; s.selfUsername = "Self"; s.hubConnected = true; s.ready = true;
    s.providers.renderer = {instance: {avatars: new Map([
      [1, {userSpaceId:1,position:{x:1,y:1},avatarInfo:{id:1001,username:"Self"}}],
      [7, {userSpaceId:7,position:{x:20,y:20},avatarInfo:{id:1007,username:"Selected"}}],
      [9, {userSpaceId:9,position:{x:2,y:2},avatarInfo:{id:1009,username:"Closer"}}]
    ])}};
    s.providers.selection = {instance: {avatarFichado: s.providers.renderer.instance.avatars.get(7)}};
    s.providers.upper = {instance: Upper.instance};
    s.providers.socket = {instance: Socket.instance, exported: Socket};
    s.providers.packet = {exported: $};
    q.hookSocket(s.providers.socket);
    globalThis.Packet = $;
  `, Object.assign(c, { captured: sends }));
  const q = c.__stepQa, api = c.__BBFlashRuntime;
  const configure = (patch = {}) => api.onHubMessage({type:"step_click_config", enabled:true, source:"SELF", startMs:350, endMs:400, intervalMs:9, ...patch});
  const walk = (id = 1, duration = 600, kind = 1) => ({id:182, fields:[kind,id,2,3,4,duration,0]});
  const observe = (p = walk()) => q.stepClickObserve(p, c.time, "socket_worker");
  const plan = () => workers.flatMap(w => w.messages).filter(m => m.type === "arm").at(-1);
  const fire = (p, index, late = 0.25) => { c.time = p.shots[index].dueAt + late; q.stepClickFire({generation:p.generation,index,dueAt:p.shots[index].dueAt}); };
  const select = (id) => { q.state.providers.selection.instance.avatarFichado = q.state.providers.renderer.instance.avatars.get(id) || null; };
  const targetIds = () => messages.filter(m => m.type === "packet_event" && m.dir === "out" && m.opcode === 211).map(m => Number(m.fields[0]));
  api.onHubMessage({type:"performance_config",packetBus:true});
  return {c,q,api,sends,messages,configure,walk,observe,plan,fire,select,targetIds};
}
let count = 0;
function check(name, fn) { fn(); count++; console.log("PASS " + name); }
check("native 211 to ficha only: six timed requests, no proximity, no packet multiplier", () => {
  const f = fixture(); f.q.state.punchPackets = 8;
  f.configure(); f.observe(); const p = f.plan();
  assert.equal(p.shots.length, 6);
  assert.ok(p.shots.every(s => s.dueAt >= 1350 && s.dueAt < 1400));
  assert.equal(p.shots[0].dueEpoch, 101350);
  assert.deepEqual(Array.from(p.shots,s=>s.dueAt),[1350,1359,1368,1377,1386,1395]);
  for (let i=0;i<6;i++) f.fire(p,i);
  assert.deepEqual(f.targetIds(), [7,7,7,7,7,7]);
  assert.equal(f.sends.length,6);
  assert.equal(f.api.status().stepClick.sent,6);
  assert.equal(f.messages.filter(m=>m.type==="timing_target").length,0);
});
check("current ficha is re-read for each click; clearing it never reuses cached selectedId", () => {
  const f=fixture(); f.configure(); f.observe(); const p=f.plan();
  f.fire(p,0); f.select(9); f.fire(p,1); f.select(-1); f.q.state.selectedId=7; f.fire(p,2);
  assert.deepEqual(f.targetIds(),[7,9]); assert.equal(f.api.status().stepClick.targetId,-1);
  f.select(1); f.fire(p,3); assert.deepEqual(f.targetIds(),[7,9]);
});
check("removed, departing, recycled slots and allies cannot receive a stale-ficha click", () => {
  for (const mode of ["removed","departing","recycled","same_account_new_avatar","ally"]) {
    const f=fixture(); f.configure(); f.observe(); const p=f.plan();
    const av=f.q.state.providers.renderer.instance.avatars.get(7);
    if(mode==="removed")av._removed=true;
    if(mode==="departing")av.__departing=true;
    if(mode==="recycled")f.q.state.providers.renderer.instance.avatars.set(7,{...av,avatarInfo:{id:5007,username:"Recycled"}});
    if(mode==="same_account_new_avatar")f.q.state.providers.renderer.instance.avatars.set(7,{...av});
    if(mode==="ally")f.q.state.allies.accounts.add(1007);
    f.fire(p,0); assert.equal(f.sends.length,0,mode);
  }
});
check("an unavailable native ficha getter cannot crash the mode or reuse the old id", () => {
  const f=fixture();f.configure();f.observe();const p=f.plan();
  Object.defineProperty(f.q.state.providers.selection.instance,'avatarFichado',{get(){throw Error('native selection unavailable');}});
  f.fire(p,0);assert.equal(f.sends.length,0);assert.equal(f.api.status().stepClick.targetId,-1);
});
check("slot zero is valid for a selected rival, and unknown self identity prevents firing", () => {
  const f=fixture();f.configure();f.observe();const p=f.plan();
  f.q.state.providers.renderer.instance.avatars.set(0,{userSpaceId:0,position:{x:30,y:30},avatarInfo:{id:8000,username:'Zero'}});
  f.select(0);f.fire(p,0);assert.deepEqual(f.targetIds(),[0]);
  f.q.state.providers.renderer.instance.avatars.delete(1);f.q.state.selfId=-1;f.q.state.selfUsername='unknown';
  f.fire(p,1);assert.deepEqual(f.targetIds(),[0]);
});
check("queued Board fire and old Timing callbacks cannot punch another id in this mode", () => {
  const f=fixture(); f.configure(); f.observe();
  f.api.onHubMessage({type:"fire",targetId:9});
  assert.equal(f.sends.length,0);
  f.fire(f.plan(),0);assert.deepEqual(f.targetIds(),[7]);
});
check("late callbacks are dropped, never catch up with a burst outside its window", () => {
  const f=fixture(); f.configure(); f.observe(); const p=f.plan();
  f.fire(p,0,9); f.fire(p,5,10); assert.equal(f.sends.length,0);
  assert.equal(f.api.status().stepClick.skipped,2);
  f.q.stepClickFire({generation:p.generation,index:5,dueAt:p.shots[5].dueAt});
  assert.equal(f.api.status().stepClick.skipped,2,"duplicate callback ignored");
});
check("sources follow actual self/selected/room steps and ignore NPCs and pets", () => {
  const f=fixture(); f.configure(); f.observe(f.walk(7)); assert.equal(f.plan(),undefined);
  f.observe(f.walk(1,600,2)); f.observe(f.walk(1,600,3)); assert.equal(f.plan(),undefined);
  f.configure({source:"SELECTED"}); f.observe(f.walk(1)); assert.equal(f.plan(),undefined);
  f.observe(f.walk(7,500)); assert.equal(f.api.status().stepClick.durationMs,500);
  f.configure({source:"ROOM"}); f.observe(f.walk(9)); const p=f.plan();
  f.c.time+=10; f.observe(f.walk(7)); assert.equal(f.plan(),p,"one burst per room batch");
});
check("new step, room change, disable, config edit and disconnect invalidate pending callbacks", () => {
  for(const mode of ["step","room","round","disable","config","disconnect","timing"]) {
    const f=fixture(); f.configure(); f.observe(); const p=f.plan();
    if(mode==="step"){f.c.time+=600;f.observe();}
    if(mode==="room")f.observe({id:128,type:120,fields:["1"]});
    if(mode==="round")f.observe({id:160,type:126,fields:[]});
    if(mode==="disable")f.api.onHubMessage({type:"step_click_config",enabled:false});
    if(mode==="config")f.api.onHubMessage({type:"step_click_config",startMs:360});
    if(mode==="disconnect")f.api.setHubConnected(false);
    if(mode==="timing")f.api.onHubMessage({type:"timing_config",enabled:true});
    f.fire(p,0); assert.equal(f.sends.length,0,mode);
  }
});
check("duration changes use actual packet duration; no firing after a finished step", () => {
  const f=fixture(); f.configure(); f.observe(f.walk(1,300)); assert.equal(f.plan(),undefined);
  assert.equal(f.api.status().stepClick.reason,"window_outside_step");
  f.c.time+=600; f.observe(f.walk(1,750)); const p=f.plan(); f.fire(p,0);
  f.c.time=3000; assert.equal(f.api.status().stepClick.running,false);
  assert.equal(f.api.status().stepClick.phaseMs,750); assert.equal(f.sends.length,1);
});
check("early worker stamp precedes native dispatch; fallback does not arm a duplicate", () => {
  const f=fixture(); f.configure();
  let seenEarly=false;
  const worker={onmessage(){seenEarly=Boolean(f.q.stepClick.clock);}};
  f.q.state.providers.socket.instance.socketWorker=worker;
  f.q.hookSocketWorkerEarly(f.q.state.providers.socket.instance);
  const bytes=vm.runInContext('{const p=new Packet(182); for(const v of [1,1,2,3,4,600,0])p.appendParameter(v);p.toByteArray()}',f.c);
  worker.onmessage({data:{type:"received-batch",packets:[bytes]}});
  assert.equal(seenEarly,true); const p=f.plan(); assert.equal(f.api.status().stepClick.clockSource,"socket_worker");
  f.c.time+=16;f.q.onPacket(f.walk(),"in");assert.equal(f.plan(),p);
  const g=fixture();g.configure();g.q.onPacket(g.walk(),"in");assert.ok(g.plan());assert.equal(g.api.status().stepClick.clockSource,"client_dispatch");
});
check("worker absolute deadlines handle distinct time origins and cancellation", () => {
  const f=fixture(), pending=new Map(), delivered=[]; let seq=0, time=0;
  const c=vm.createContext({performance:{timeOrigin:100500,now:()=>time},self:{postMessage:m=>delivered.push(m)},
    setTimeout:(fn,ms)=>{pending.set(++seq,{fn,at:time+ms});return seq;},clearTimeout:id=>pending.delete(id)});
  vm.runInContext(`(${f.q.stepClickWorkerMain.toString()})();`,c);
  c.self.onmessage({data:{type:"arm",generation:8,shots:[{index:0,dueAt:1350,dueEpoch:101350},{index:1,dueAt:1360,dueEpoch:101360}]}});
  const first=[...pending.values()][0];assert.equal(first.at,850);time=850;first.fn();assert.equal(delivered[0].dueAt,1350);
  c.self.onmessage({data:{type:"clear"}});assert.equal(pending.size,0);
});
check("core modes, persistence, reconnect and stop preserve isolation", () => {
  const {ControllerCore,normalizeStepClick}=require("../electron/controller-core.cjs");
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"bb-step-click-"));
  const settingsPath=path.join(dir,"settings.json");
  const core=new ControllerCore({ringBoard:false,settingsPath}); const sent=[];
  core.sendToSwf=m=>{sent.push(m);return true;}; core.swfSocket={destroy(){}}; core.stepClickStatus={};
  try {
    core.applyTiming({enabled:true});core.applyStepClick({enabled:true,startMs:350,endMs:400,clicks:6});
    assert.equal(core.timing.enabled,false);assert.equal(core.autoRun,false);assert.equal(core.simon.enabled,false);assert.equal(core.exitMode.punch,false);
    assert.equal(core.desiredMode,"STEP_CLICK");core.applyStepClick({startMs:360,enabled:undefined});assert.equal(core.stepClick.enabled,true);
    assert.equal(core.stepClick.startMs,360);core.pushDesiredConfig(true);
    assert.equal(sent.filter(m=>m.type==="step_click_config").at(-1).enabled,true);
    const before=sent.length;core.scheduleRingBoardFire({targetId:9});core.applyRingBoardTiming({enabled:true});assert.equal(sent.length,before);
    core.applyTiming({enabled:true});assert.equal(core.stepClick.enabled,false);
    core.applyStepClick({enabled:true});core.stopModes();assert.equal(core.stepClick.enabled,false);
    core.applyStepClick({enabled:true});core.registerSwfSocket({destroy(){}},{host:"127.0.0.1",port:1});assert.equal(core.stepClick.enabled,false);
    const restored=new ControllerCore({ringBoard:false,settingsPath});assert.equal(restored.stepClick.enabled,false);assert.equal(restored.stepClick.startMs,360);restored.stop();
    assert.deepEqual(normalizeStepClick({startMs:600,endMs:100,clicks:999}),{enabled:false,source:"PAIR",pattern:"CUSTOM",momentMs:375,startMs:600,endMs:601,intervalMs:1});
    core.applyStepClick({intervalMs:13});assert.equal(core.stepClick.intervalMs,13);
    core.handleSwfMessage({type:'step_click_state',status:{enabled:true,steps:20,crossing:{targetId:7,closestMs:330,durationMs:600,contactWindows:[{fromMs:120,toMs:210}],resolutionMs:16,samples:38}}});
    assert.equal(core.stepClickStatus.crossing.closestMs,330);assert.equal(core.stepClickStatus.steps,20);
  } finally {core.stop();}
});
check('a fixed interval clips to a short step without stretching or sending beyond it',()=>{
 const f=fixture();f.configure({startMs:10,endMs:100,intervalMs:7});f.observe(f.walk(1,30));
 assert.deepEqual(Array.from(f.plan().shots,s=>s.dueAt),[1010,1017,1024]);
 const g=fixture();g.configure({startMs:0,endMs:5000,intervalMs:1});g.observe(f.walk(1,600));assert.equal(g.plan(),undefined);assert.equal(g.api.status().stepClick.reason,'interval_too_small');
});
check('distinct rapid steps of the same actor are never swallowed by a room debounce',()=>{
 for(const source of ['SELF','SELECTED','PAIR','ROOM']){
 const f=fixture();f.configure({source,startMs:2,endMs:15,intervalMs:4});const id=source==='SELECTED'?7:1;
 f.observe(f.walk(id,20));const old=f.plan();f.c.time+=5;f.observe(f.walk(id,20));const next=f.plan();assert.notEqual(next.generation,old.generation,source);assert.equal(f.api.status().stepClick.steps,2);
 f.fire(old,0);assert.equal(f.sends.length,0);f.fire(next,0);assert.deepEqual(f.targetIds(),[7]);
 }
});
check('pair follows the selected rival while self stands, and groups only siblings of the same pulse',()=>{
 const f=fixture();f.configure({source:'PAIR'});f.observe(f.walk(9));assert.equal(f.plan(),undefined);
 f.observe(f.walk(7));const p=f.plan();f.c.time+=10;f.observe(f.walk(1));assert.equal(f.plan(),p);
 f.c.time+=10;f.observe(f.walk(7));assert.notEqual(f.plan().generation,p.generation);
});
check('worker shapes not covered by the early hook still use dispatch, without replaying known packets',()=>{
 const f=fixture();f.configure();f.q.state.providers.socket.instance.socketWorker={__bbEarlyTap:true};f.q.onPacket(f.walk(),'in');assert.ok(f.plan());
 const g=fixture();g.configure();g.observe();const p=g.plan();g.c.time+=16;g.q.onPacket(g.walk(),'in');assert.equal(g.plan(),p);
});
check('Autoclick leaves native walking untouched even with Step Walk enabled',()=>{
 const f=fixture();f.q.state.stepWalk.enabled=true;f.configure();
 vm.runInContext('const pk=new Packet(182);pk.appendParameter("08084");pk.appendParameter("");__stepQa.state.providers.socket.instance.sendServerMessage(pk);',f.c);
 assert.equal(f.sends.length,1);assert.equal(f.q.state.stepWalk.steps,0);assert.equal(f.q.state.stepWalk.goal,null);
});
check('native short and continuous animations provide a real fallback without duplicating packet anchors',()=>{
 const f=fixture();f.configure({startMs:5,endMs:50,intervalMs:10});f.observe(f.walk(1,80));
 const a=f.q.state.providers.renderer.instance.avatars.get(1);a.currentAnimation={getType:()=>"WalkingAnimation",time:80,elapsedMs:0};
 f.q.stepClickNativeWalks(1000);assert.equal(f.api.status().stepClick.durationMs,80);assert.equal(f.api.status().stepClick.steps,1);const p=f.plan();f.q.stepClickNativeWalks(1016);assert.equal(f.plan(),p);
 f.c.time=1080;a.currentAnimation={getType:()=>"WalkingAnimation",time:80,elapsedMs:0};f.q.stepClickNativeWalks(1080);assert.equal(f.api.status().stepClick.steps,2);assert.equal(f.api.status().stepClick.clockSource,'native_animation');
});
check('a 540 ms visual animation cannot rearm a received 600 ms step or change its click dates',()=>{
 const f=fixture();f.configure({source:'PAIR',startMs:450,endMs:455,intervalMs:1});f.observe();const p=f.plan();
 const a=f.q.state.providers.renderer.instance.avatars.get(1);a.currentAnimation={getType:()=>"WalkingAnimation",time:540,elapsedMs:0};
 f.q.stepClickNativeWalks(1000);assert.equal(f.plan(),p);assert.equal(f.api.status().stepClick.durationMs,600);assert.equal(f.api.status().stepClick.clockSource,'socket_worker');
 const b=f.q.state.providers.renderer.instance.avatars.get(7);b.currentAnimation={getType:()=>"WalkingAnimation",time:540,elapsedMs:50};
 f.c.time=1080;f.q.stepClickNativeWalks(1080);assert.equal(f.plan(),p,'the other actor cannot replace an active received step');
 assert.deepEqual(Array.from(p.shots,s=>s.dueAt),[1450,1451,1452,1453,1454]);
});
check('the early tap attaches when a worker appears after provider discovery and survives native handler replacement',()=>{
 const f=fixture();assert.equal(f.q.hookSocketWorkerEarly(f.q.state.providers.socket.instance),false);
 let calls=0;const w={onmessage(){calls++}};f.q.state.providers.socket.instance.socketWorker=w;
 f.q.sendTick();assert.equal(w.__bbEarlyTap,true);const wrapped=w.onmessage;f.q.sendTick();assert.equal(w.onmessage,wrapped);
 w.onmessage=function(){calls++};f.q.sendTick();assert.notEqual(w.onmessage,wrapped);w.onmessage({data:{type:'ignored'}});assert.equal(calls,1);
});
check('crossing measurements use native visual interpolation, preserve contact gaps and report resolution',()=>{
 const f=fixture();f.configure();f.observe();const avatars=f.q.state.providers.renderer.instance.avatars;
 const a=avatars.get(1),b=avatars.get(7);a.currentAnimation={getType:()=>"WalkingAnimation",time:600,elapsedMs:0,posIni:{x:100,y:0},posFin:{x:0,y:0}};b.screenPos={x:45,y:0};
 for(let phase=0;phase<600;phase+=30){f.c.time=1000+phase;a.currentAnimation.elapsedMs=phase;b.position={x:phase>=120&&phase<240||phase>=300?2:4,y:phase>=120&&phase<240||phase>=300?2:4};f.q.stepClickSampleCrossing();}
 f.c.time=1600;f.q.stepClickSampleCrossing();const m=f.api.status().stepClick.crossing;
 assert.equal(m.closestMs,330);assert.equal(m.distancePx,0);assert.equal(m.resolutionMs,30);assert.equal(m.complete,true);
 assert.deepEqual(JSON.parse(JSON.stringify(m.contactWindows)),[{fromMs:120,toMs:210},{fromMs:300,toMs:570}]);
 f.observe();f.c.time=1630;a.currentAnimation.elapsedMs=30;f.q.stepClickSampleCrossing();assert.equal(f.api.status().stepClick.lastCrossing.closestMs,330,'the completed measurement survives the next live step');
 f.select(9);assert.equal(f.api.status().stepClick.crossing,null,'a new ficha cannot inherit the previous rival measurement');
});
check('a short selected step cannot inherit a simultaneous long self clock',()=>{
 const f=fixture();f.configure({source:'PAIR',startMs:5,endMs:50,intervalMs:10});f.observe(f.walk(1,600));const old=f.plan();
 f.c.time=1010;f.observe(f.walk(7,80));const next=f.plan();assert.notEqual(next.generation,old.generation);
 assert.equal(f.api.status().stepClick.durationMs,80);assert.equal(f.api.status().stepClick.referenceId,7);assert.equal(f.api.status().stepClick.steps,2);
 f.fire(next,0);assert.deepEqual(f.targetIds(),[7]);
});
check('a distinct short native step is detected before an older received clock expires',()=>{
 const f=fixture();f.configure({source:'PAIR',startMs:2,endMs:15,intervalMs:4});f.observe(f.walk(1,600));const old=f.plan();
 const a=f.q.state.providers.renderer.instance.avatars.get(7);a.currentAnimation={getType:()=>"WalkingAnimation",time:20,elapsedMs:0};
 f.c.time=1200;f.q.stepClickNativeWalks(1200);const next=f.plan();assert.notEqual(next.generation,old.generation);
 assert.equal(f.api.status().stepClick.durationMs,20);assert.equal(f.api.status().stepClick.clockSource,'native_animation');assert.equal(f.api.status().stepClick.steps,2);
 f.fire(next,0);assert.deepEqual(f.targetIds(),[7]);
});
check('an animation deferred by a received clock is not marked seen forever',()=>{
 const f=fixture();f.configure({source:'PAIR',startMs:5,endMs:50,intervalMs:10});f.observe(f.walk(1,600));const old=f.plan();
 const a=f.q.state.providers.renderer.instance.avatars.get(7);a.currentAnimation={getType:()=>"WalkingAnimation",time:800,elapsedMs:100};
 f.c.time=1100;f.q.stepClickNativeWalks(1100);assert.equal(f.plan(),old,'same-pulse animation cannot replace received clock');
 f.c.time=1650;a.currentAnimation.elapsedMs=650;f.q.stepClickNativeWalks(1650);
 assert.equal(f.api.status().stepClick.durationMs,800);assert.equal(f.api.status().stepClick.clockSource,'native_animation');assert.equal(f.api.status().stepClick.steps,2);
});
check('PAIR selected anchors cannot time another ficha; a new self step can use the current ficha',()=>{
 for(const grouped of [false,true]) {
 const f=fixture();f.configure({source:'PAIR'});
 if(grouped){f.observe(f.walk(1));f.c.time=1010;}
 f.observe(f.walk(7));const old=f.plan();f.select(9);f.fire(old,0);
 assert.deepEqual(f.targetIds(),[]);assert.equal(f.api.status().stepClick.reason,'waiting_step');
 f.c.time=1600;f.observe(f.walk(1));f.fire(f.plan(),0);assert.deepEqual(f.targetIds(),[9]);
 }
});
check('valid encounter survives distant steps and window edits but never another ficha',()=>{
 const f=fixture();f.configure();f.observe();const avatars=f.q.state.providers.renderer.instance.avatars;
 const a=avatars.get(1),b=avatars.get(7);a.screenPos={x:0,y:0};b.screenPos={x:5,y:0};b.position={x:2,y:2};
 for(let phase=0;phase<600;phase+=20){f.c.time=1000+phase;f.q.stepClickSampleCrossing();}f.c.time=1600;f.q.stepClickSampleCrossing();
 assert.equal(f.api.status().stepClick.lastEncounter.targetId,7);
 b.position={x:20,y:20};f.observe();f.c.time=1700;f.q.stepClickSampleCrossing();f.c.time=1800;f.q.stepClickSampleCrossing();f.c.time=2200;f.q.stepClickSampleCrossing();
 assert.equal(f.api.status().stepClick.lastEncounter.contactWindows.length,1);
 f.configure({startMs:320,endMs:380});assert.ok(f.api.status().stepClick.lastEncounter,'window edits retain the usable measurement');
 f.select(9);assert.equal(f.api.status().stepClick.lastEncounter,null,'new ficha cannot inherit a different encounter');
});
check('selected click reports planned send and estimated arrival separately',()=>{
 const f=fixture();f.q.state.serverPingMs=160;f.configure();f.observe();const p=f.plan();f.fire(p,0,2);
 const last=f.api.status().stepClick.last;assert.equal(last.plannedPhaseMs,350);assert.equal(last.phaseMs,352);assert.equal(last.latenessMs,2);assert.equal(last.estimatedLandingMs,512);assert.equal(last.targetId,7);
});
check('single sends exactly at the configured moment with normal delivery tolerance',()=>{
 const f=fixture();f.configure({pattern:'SINGLE',momentMs:262});f.observe();const p=f.plan();
 assert.deepEqual(Array.from(p.shots,s=>s.dueAt),[1262]);f.fire(p,0,2);
 assert.deepEqual(f.targetIds(),[7]);assert.equal(f.api.status().stepClick.last.plannedPhaseMs,262);
 assert.equal(f.api.status().stepClick.last.phaseMs,264);
});
check('three attempts are symmetric and clipped without moving the configured moment',()=>{
 for(const [moment,duration,phases] of [[375,600,[355,375,395]],[0,600,[0,20]],[599,600,[579,599]],[25,30,[5,25]]]){
 const f=fixture();f.configure({pattern:'TRIPLE',momentMs:moment});f.observe(f.walk(1,duration));
 assert.deepEqual(Array.from(f.plan().shots,s=>s.dueAt-1000),phases);
 }
});
check('changing the moment invalidates all retained single and triple callbacks',()=>{
 const f=fixture();f.configure({pattern:'SINGLE',momentMs:200});f.observe();const old=f.plan();
 f.api.onHubMessage({type:'step_click_config',momentMs:220});f.fire(old,0);assert.equal(f.sends.length,0);
 f.c.time=1600;f.observe();assert.deepEqual(Array.from(f.plan().shots,s=>s.dueAt-1600),[220]);
});
check('new configs are single but old intervals survive migration, edits and persistence',()=>{
 const {ControllerCore,normalizeStepClick}=require('../electron/controller-core.cjs');
 assert.equal(normalizeStepClick({}).pattern,'SINGLE');
 assert.equal(normalizeStepClick({startMs:300,endMs:430,intervalMs:17}).pattern,'CUSTOM');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bb-step-pattern-')),settingsPath=path.join(dir,'settings.json');
 fs.writeFileSync(settingsPath,JSON.stringify({stepClick:{enabled:true,source:'SELF',startMs:300,endMs:430,intervalMs:17}}));
 const core=new ControllerCore({ringBoard:false,settingsPath});core.sendToSwf=()=>true;
 try{
 assert.equal(core.stepClick.pattern,'CUSTOM');assert.equal(core.stepClick.intervalMs,17);assert.equal(core.stepClick.enabled,false);
 core.applyStepClick({pattern:'SINGLE',momentMs:262});core.applyStepClick({enabled:false});assert.equal(core.stepClick.pattern,'SINGLE');
 core.applyStepClick({intervalMs:19});assert.equal(core.stepClick.pattern,'CUSTOM');assert.equal(core.stepClick.startMs,300);
 core.applyStepClick({pattern:'TRIPLE',momentMs:280});
 const restored=new ControllerCore({ringBoard:false,settingsPath});assert.equal(restored.stepClick.pattern,'TRIPLE');assert.equal(restored.stepClick.momentMs,280);restored.stop();
 }finally{core.stop();}
});
check('blue encounter never updates from a partial approach, and includes movement context',()=>{
 const f=fixture();f.configure({source:'SELF'});f.observe();const a=f.q.state.providers.renderer.instance.avatars.get(1),b=f.q.state.providers.renderer.instance.avatars.get(7);
 a.screenPos={x:0,y:0};b.screenPos={x:5,y:0};b.position={x:2,y:2};
 for(let phase=0;phase<600;phase+=20){f.c.time=1000+phase;f.q.stepClickSampleCrossing();}f.c.time=1600;f.q.stepClickSampleCrossing();
 const complete=f.api.status().stepClick.lastEncounter;assert.equal(complete.complete,true);assert.equal(complete.motionKind,'SELF');assert.equal(complete.source,'SELF');
 assert.equal(complete.clockSource,'socket_worker');assert.equal(complete.referenceId,1);
 f.observe();f.c.time=1620;f.q.stepClickSampleCrossing();f.c.time=1640;b.screenPos={x:0,y:0};f.q.stepClickSampleCrossing();
 assert.equal(f.api.status().stepClick.lastEncounter.closestMs,complete.closestMs);
 f.c.time=1660;f.observe();assert.equal(f.api.status().stepClick.lastEncounter.closestMs,complete.closestMs);
});
check('old connected step runtimes cannot silently substitute their interval for a single moment',()=>{
 const {ControllerCore}=require('../electron/controller-core.cjs');
 const core=new ControllerCore({ringBoard:false,settingsPath:path.join(os.tmpdir(),'missing-bb-step-cap-'+process.pid+'.json')});
 core.persistSettings=()=>{};core.emitSnapshot=()=>{};core.sendToSwf=()=>{};core.swfSocket={destroy(){}};
 core.handleSwfMessage({type:'step_click_state',status:{enabled:false,source:'PAIR',startMs:350,endMs:400,intervalMs:10}});
 assert.throws(()=>core.applyStepClick({enabled:true,pattern:'SINGLE',momentMs:262}),/Reabre el juego/);
 assert.equal(core.stepClick.enabled,false);
 core.handleSwfMessage({type:'step_click_state',status:{enabled:false,source:'PAIR',pattern:'SINGLE',momentMs:375}});
 core.applyStepClick({enabled:true,pattern:'SINGLE',momentMs:262});assert.equal(core.stepClick.enabled,true);assert.equal(core.stepClick.momentMs,262);
 core.stop();
});
console.log(`PASS ${count} step autoclick regression groups`);
