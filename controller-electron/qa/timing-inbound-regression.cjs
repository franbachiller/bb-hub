"use strict";
// Native contract: audit-20261003-bundles/deob/renderer/
// deobfuscated.resolved.js onWorkerMessage -> handleReceivedBytes -> inboundQueue.
// The runtime taps the socket entry, before the native renderer's RAF drain.
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const assert = require("node:assert/strict");
const file = path.resolve(process.argv[2] || path.join(__dirname, "../electron/game/flash_runtime.page.js"));
const source = fs.readFileSync(file, "utf8").replace("  window[KEY] = {", "  window.__inboundQa = {state, earlyInboundTap, onPacket, hookSocket, hookSocketWorkerEarly, parsePacket, ensureActorFromRenderer};\n  window[KEY] = {");
function fixture() {
  const frames = [], nativeQueue = [], sent = [];
  const c = vm.createContext({ console, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer,
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    document: { hidden: false }, __bbHubSend: m => sent.push(m) });
  c.window = c; c.t = 1000; c.performance = { now: () => c.t };
  vm.runInContext(source, c);
  vm.runInContext(`
    globalThis.q=__inboundQa;globalThis.s=q.state;
    s.selfId=1;s.selfUsername='Self';
    s.providers.renderer={instance:{spaceModel:{name:'mGame2'},avatars:new Map([
      [1,{userSpaceId:1,position:{x:10,y:10},avatarInfo:{id:1001,username:'Self'}}],
      [7,{userSpaceId:7,position:{x:13,y:13},avatarInfo:{id:1007,username:'Rival'}}]
    ])}};
    class Socket { handleReceivedBytes(bytes){nativeQueue.push(bytes)} sendServerMessage(){} }
    globalThis.socket=new Socket();
    socket.socketWorker={onmessage(ev){const d=ev.data;for(const bytes of d.type==='received'?[d.bytes]:d.packets||[])socket.handleReceivedBytes(bytes)}};
    s.providers.socket={instance:socket,exported:Socket};q.hookSocket(s.providers.socket);
  `, Object.assign(c, { nativeQueue }));
  const packet=(mode=1,id=7,x=12,y=12) => ({id:182,type:0,subType:0,fields:[mode,id,x,y,2,600,0].map(String)});
  const bytes=p=>{
    const a=[177,p.id];
    if(p.type>0){a.push(179,p.type);if(p.subType>0)a.push(179,p.subType)}
    a.push(179,178);
    for(const field of p.fields){a.push(...new TextEncoder().encode(String(field)),179,178)}
    a.push(176);return new Uint8Array(a);
  };
  return {c,q:c.q,s:c.s,packet,bytes,nativeQueue,sent,
    early(p,at=1000){c.t=at;c.q.earlyInboundTap({type:'received',bytes:bytes(p)})},
    dispatch(p,at=1000){c.t=at;c.q.onPacket(p,'in')},
    deliver(p,at=1000){c.t=at;c.socket.socketWorker.onmessage({data:{type:'received',bytes:bytes(p)}})},
    batch(packets,at=1000){c.t=at;c.socket.socketWorker.onmessage({data:{type:'received-batch',packets:packets.map(bytes)}})}};
}
let cases=0,failures=0;
function check(name,fn){cases++;try{fn();console.log('PASS '+name)}catch(e){failures++;console.error('FAIL '+name+': '+e.message)}}
check('NPC and pet dispatches cannot establish the player tick phase',()=>{
  for(const mode of [2,3]){const f=fixture();f.dispatch(f.packet(mode));assert.equal(f.s.tickEngine.batches.length,0);assert.equal(f.s.actors.has(7),false)}
});
check('NPC and pet worker messages cannot establish the player tick phase',()=>{
  for(const mode of [2,3]){const f=fixture();f.early(f.packet(mode));assert.equal(f.s.tickEngine.batches.length,0)}
});
check('unknown movement modes cannot shift a known player phase',()=>{
  const f=fixture();f.deliver(f.packet(1),1000);const origin=f.s.tickEngine.origin;
  f.deliver(f.packet(0),1300);f.deliver(f.packet(4),1600);
  assert.equal(f.s.tickEngine.batches.length,1);assert.equal(f.s.tickEngine.origin,origin);
});
check('native received shape is tapped once before the deferred renderer queue',()=>{
  const f=fixture();const p=f.packet();f.deliver(p);
  assert.equal(f.nativeQueue.length,1);assert.equal(f.s.tickEngine.batches.length,1);
  assert.equal(f.s.actors.get(7).toX,12);assert.equal(f.s.actors.get(7).toY,12);
  assert.equal(f.s.providers.renderer.instance.avatars.get(7).position.x,13);
  assert.equal(f.q.ensureActorFromRenderer(7).toX,12);
});
check('native received-batch with NPC collisions has one player sample and no player overwrite',()=>{
  const f=fixture();f.batch([f.packet(2,7,1,1),f.packet(1,7,12,12),f.packet(3,7,2,2)]);
  assert.equal(f.nativeQueue.length,3);assert.equal(f.s.tickEngine.batches.length,1);
  assert.equal(f.s.actors.get(7).toX,12);assert.equal(f.s.actors.get(7).toY,12);
});
check('delayed normal tap of the same player frame does not add a second phase sample',()=>{
  const f=fixture();const p=f.packet();f.early(p,1000);f.dispatch(p,1250);
  assert.deepEqual(Array.from(f.s.tickEngine.batches),[1000]);
});
check('actor clock retains worker arrival after a delayed normal dispatch',()=>{
  const f=fixture();const p=f.packet();f.early(p,1000);f.dispatch(p,1250);
  assert.equal(f.s.actors.get(7).startAt,1000);assert.equal(f.s.actors.get(7).endAt,1600);
});
check('matching an early frame does not consume the stamp of a different player frame',()=>{
  const f=fixture();const first=f.packet(1,7,12,12),second=f.packet(1,7,11,11);
  f.early(first,1000);f.early(second,1600);f.dispatch(second,1850);f.dispatch(first,1851);
  assert.deepEqual(Array.from(f.s.tickEngine.batches),[1000,1600]);
});
check('identical successive steps retain distinct arrival stamps in FIFO order',()=>{
  const f=fixture();const p=f.packet();f.early(p,1000);f.early(p,1600);f.dispatch(p,1850);
  assert.equal(f.s.actors.get(7).startAt,1000);f.dispatch(p,1851);
  assert.equal(f.s.actors.get(7).startAt,1600);assert.deepEqual(Array.from(f.s.tickEngine.batches),[1000,1600]);
});
check('normal dispatch remains a valid fallback when no worker tap is available',()=>{
  const f=fixture();f.dispatch(f.packet(),1250);
  assert.deepEqual(Array.from(f.s.tickEngine.batches),[1250]);assert.equal(f.s.actors.get(7).startAt,1250);
});
check('a room boundary followed by a player step in one native batch establishes the new phase',()=>{
  const f=fixture();f.batch([{id:128,type:120,subType:0,fields:['1']},f.packet()],1000);
  assert.equal(f.s.tickEngine.gridResets,1);assert.deepEqual(Array.from(f.s.tickEngine.batches),[1000]);
  assert.notEqual(f.s.tickEngine.origin,null);assert.equal(f.s.actors.get(7).startAt,1000);
});
check('a gong followed by a player step in one native batch preserves that step phase',()=>{
  const f=fixture();f.batch([{id:160,type:126,subType:0,fields:[]},f.packet()],1000);
  assert.equal(f.s.tickEngine.gridResets,1);assert.deepEqual(Array.from(f.s.tickEngine.batches),[1000]);
  assert.notEqual(f.s.tickEngine.origin,null);
});
check('failed room entry leaves the existing player clock and actors intact',()=>{
  const f=fixture();f.deliver(f.packet(),1000);const origin=f.s.tickEngine.origin,actor=f.s.actors.get(7);
  f.dispatch({id:128,type:120,subType:0,fields:['-1']},1300);
  assert.equal(f.s.tickEngine.gridResets,0);assert.deepEqual(Array.from(f.s.tickEngine.batches),[1000]);
  assert.equal(f.s.tickEngine.origin,origin);assert.equal(f.s.actors.get(7),actor);
});
console.log(`${cases-failures}/${cases} inbound cases passed`);
if(failures)process.exitCode=1;
