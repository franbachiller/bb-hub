// Run under development Electron against an actual packaged app.asar. All
// profile, license and loopback redirection below are QA fixtures only.
const {app}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const assert=require('node:assert/strict'),{pathToFileURL}=require('node:url'),WebSocket=require('ws');
app.disableHardwareAcceleration();
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'bb-board-auto-'));
app.setPath('userData',profile);
const archive=path.join(process.env.BB_PACKAGED_APP_DIR,'resources','app.asar');
const errors=[],workerErrors=[],servers=new Map();
process.on('uncaughtException',e=>errors.push(e));
const warn=console.error;console.error=(...args)=>{workerErrors.push(args.map(String).join(' '));warn(...args);};
const listen=net.Server.prototype.listen;
net.Server.prototype.listen=function(port,...args){
  if(port===18444||port===18445){servers.set(port,this);return listen.call(this,0,...args);}
  return listen.call(this,port,...args);
};
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,label){const deadline=Date.now()+7000;while(Date.now()<deadline){if(fn())return;await wait(20);}throw new Error('Timed out: '+label);}
app.whenReady().then(async()=>{
  const gate=require(path.join(archive,'electron/license/gate.cjs'));
  gate.hasFeature=name=>name==='ring_board';
  await import(pathToFileURL(path.join(archive,'electron/ring-board/dist/server.js')).href);
  await until(()=>servers.get(18444)?.listening&&servers.get(18445)?.listening,'isolated Board listeners');
  net.Server.prototype.listen=listen;
  const wsPort=servers.get(18444).address().port,httpPort=servers.get(18445).address().port;
  const socket=new WebSocket('ws://127.0.0.1:'+wsPort);
  await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});
  const {ControllerCore}=require(path.join(archive,'electron/controller-core.cjs'));
  const core=new ControllerCore({settingsPath:path.join(profile,'settings.json')});
  const runtimeMessages=[],boardMessages=[];
  core.swfSocket={write(){return true;}}; // Connected runtime fixture for config dispatch.
  core.sendToSwf=message=>{runtimeMessages.push(message);return true;};
  core.ringBoardSend=message=>{socket.send(JSON.stringify(message));return true;};
  core.ringBoardConnected=true;
  socket.on('message',raw=>{const message=JSON.parse(String(raw));boardMessages.push(message);core.handleRingBoardMessage(message);});
  socket.send(JSON.stringify({type:'bridge_hello',clientId:'bbhub-main'}));
  socket.send(JSON.stringify({type:'ui_hello'}));
  await until(()=>core.ringBoardStatus,'bridge hello');
  core.setAutoRun(true);
  if(process.env.BB_BOARD_EXPECT_BUG==='1'){
    await until(()=>errors.some(e=>e.code==='ENOTDIR'),'old ASAR write failure');
    console.log('PASS reproduction: enabling automatic mode on the old package raises ENOTDIR in ScenePolicyStore.markSceneAllowed.');
    app.exit(0);return;
  }
  await until(()=>core.ringBoardStatus?.armed,'automatic mode armed');
  assert.ok(runtimeMessages.some(m=>m.type==='auto_ring_config'&&m.enabled));
  assert.ok(runtimeMessages.some(m=>m.type==='timing_config'&&m.enabled));
  const policyFile=path.join(profile,'ring-board/scene-policy.json'),memoryFile=path.join(profile,'ring-board/opponent-memory.json');
  await until(()=>fs.existsSync(policyFile)&&fs.existsSync(memoryFile),'main and worker profile files');
  const matrix=Array.from({length:25},()=>Array(25).fill(0));
  for(const [i,sceneHash] of ['qa-island','qa-lobby','qa-ring','qa-lobby','qa-ring'].entries()){
    const firstMessage=boardMessages.length;
    core.lastSwfTs=10000+i*1000;
    core.lastSwfWall=Date.now();
    core.updateRingBoardScene({sceneHash,width:25,height:25,matrix,timestamp:core.lastSwfTs});
    core.updatePlayers([
      {id:1,name:'Self',self:true,userId:101,posId:1,x:10,y:10,active:true},
      {id:2,name:'Rival',userId:102,posId:2,x:14,y:14,active:true}
    ]);
    core.pushRingBoardSensors();
    await until(()=>boardMessages.slice(firstMessage).some(m=>m.type==='state'&&m.payload?.scene?.sceneHash===sceneHash&&m.payload.entities?.length===2),'worker evaluated '+sceneHash);
    assert.ok(core.ringBoardStatus.armed);
    assert.ok(JSON.parse(fs.readFileSync(policyFile,'utf8')).allowedCombatHashes.includes(sceneHash));
  }
  const memoryModifiedAt=fs.statSync(memoryFile).mtimeMs;
  core.setRingBoardOption('reset_session_memory');
  await until(()=>fs.statSync(memoryFile).mtimeMs>memoryModifiedAt,'worker saved memory outside ASAR');
  const storedPolicy=fs.readFileSync(policyFile,'utf8'),storedMemory=fs.readFileSync(memoryFile,'utf8');
  const {ScenePolicyStore}=await import(pathToFileURL(path.join(archive,'electron/ring-board/dist/store/scene-policy.js')).href);
  const {OpponentMemoryStore}=await import(pathToFileURL(path.join(archive,'electron/ring-board/dist/store/opponent-memory.js')).href);
  const reloaded=new ScenePolicyStore(policyFile);reloaded.loadSync(path.join(archive,'electron/ring-board/data/scene-policy.json'));
  assert.ok(reloaded.isAllowed('qa-ring'));assert.equal(fs.readFileSync(policyFile,'utf8'),storedPolicy);
  const memory=new OpponentMemoryStore(memoryFile);memory.loadSync(path.join(archive,'electron/ring-board/data/opponent-memory.json'));
  assert.equal(fs.readFileSync(memoryFile,'utf8'),storedMemory);
  core.setAutoRun(false);await until(()=>core.ringBoardStatus?.armed===false,'automatic mode stopped');
  core.setAutoRun(true);await until(()=>core.ringBoardStatus?.armed===true,'automatic mode restarted');
  core.pushRingBoardSensors();
  assert.equal((await fetch('http://127.0.0.1:'+httpPort+'/health')).status,200);
  assert.deepEqual(errors,[],'no unhandled Board exceptions');assert.deepEqual(workerErrors,[],'no brain worker errors');
  assert.ok(boardMessages.some(m=>m.type==='move_plan'),'Board brain emits a movement plan after automatic activation');
  const closed=new Promise((resolve,reject)=>{const deadline=setTimeout(()=>reject(new Error('Board license removal did not close the socket')),4000);socket.once('close',code=>{clearTimeout(deadline);resolve(code);});});
  gate.hasFeature=()=>false;
  await wait(1200);
  assert.equal((await fetch('http://127.0.0.1:'+httpPort+'/health')).status,403);
  assert.equal(await closed,1008);
  console.log('PASS packaged automatic activation, Timing config, Board movement, island/lobby/Ring transitions, worker resets and off/on.');
  console.log('PASS policy and opponent memory persist under the isolated customer profile; bundled files stay read-only.');
  console.log('PASS Board still denies HTTP and closes WebSocket when the simulated Pro permission is removed.');
  app.exit(0);
}).catch(e=>{console.error(e);app.exit(1);});
