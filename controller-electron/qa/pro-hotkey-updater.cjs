const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { normalizeHotkey } = require('../electron/hotkey.cjs');
assert.equal(normalizeHotkey('Alt + Ctrl + T'),'Control+Alt+T');
for (const value of ['T','F','Shift+T','F25','Control+Control+T','Meta+T',{},'F2;calc']) assert.throws(()=>normalizeHotkey(value));

let feature = { featureName:'ring_board',value:'true',baseValue:'false',expiresAt:0 }, nativeCode=0;
const native = { SetProductData(){},SetProductId(){},SetReleaseVersion(){},SetLicenseCallback(){},GetLibraryVersion:()=>'',
  IsLicenseGenuine:()=>nativeCode,GetFeatureEntitlement(){ if (!feature) throw new Error('missing'); return feature; } };
const gateVM = vm.createContext({ module:{exports:{}},console,Date,__dirname:'test',
  require(name){
    if(name==='@cryptlex/lexactivator') return {LexActivator:native,PermissionFlags:{LA_USER:1},LexStatusCodes:{LA_OK:0,LA_FAIL:1},ReleaseFlags:{LA_RELEASES_ALLOWED:1}};
    if(name==='fs') return {readFileSync(file){return file.endsWith('config.json')?' {"productId":"test","releaseVersion":"0.1.1"} ':'test-product';}};
    if(name==='electron') return {};
    return require(name);
  } });
vm.runInContext(fs.readFileSync(path.resolve(__dirname,'../electron/license/gate.cjs'),'utf8'),gateVM);
const gate = gateVM.module.exports;
assert.equal(gate.hasFeature('ring_board'),true);
feature.expiresAt = Math.floor(Date.now()/1000)-1;
assert.equal(gate.hasFeature('ring_board'),false);
feature.baseValue='true'; assert.equal(gate.hasFeature('ring_board'),true);
feature=null; assert.equal(gate.hasFeature('ring_board'),false);
feature={featureName:'ring_board',value:'true',expiresAt:0}; nativeCode=1;
assert.equal(gate.hasFeature('ring_board'),false);

(async()=>{
  const actualGate=require('../electron/license/gate.cjs');
  const original=actualGate.hasFeature;
  let pro=false;
  actualGate.hasFeature=()=>pro;
  try {
    const {ControllerCore}=require('../electron/controller-core.cjs');
    const core=new ControllerCore({settingsPath:path.join(__dirname,'never-created-settings.json')});
    const sent=[];
    core.sendToSwf=x=>sent.push(x);
    assert.equal(core.snapshot().ringBoard.licensed,false);
    assert.throws(()=>core.setRingBoardArmed(true),/Pro/);
    assert.throws(()=>core.setRingBoardOption('set_move_brain',1),/Pro/);
    assert.throws(()=>core.setAutoRun(true),/Pro/);
    core.ensureRingBoardBridge(); assert.equal(core.ringBoardSocket,null);
    core.handleRingBoardMessage({type:'timing_config',enabled:true}); assert.equal(core.timing.enabled,false);
    pro=true;
    assert.equal(core.snapshot().ringBoard.licensed,true);
    core.scheduleRingBoardMove({primaryTile:{x:1,y:1},moveAt:Date.now()+50});
    core.scheduleRingBoardFire({targetId:2,fireAt:Date.now()+50});
    pro=false;
    await new Promise(r=>setTimeout(r,100));
    assert.equal(sent.length,0,'queued Board commands survived permission removal');
    core.stop();
  } finally {actualGate.hasFeature=original;}
  console.log('PASS: Basic denied, Pro enabled, expiry/missing entitlement fail closed, queued commands canceled.');

  const tempBase='D:/bb-hub-build-temp-1003';
  const content=Buffer.from('test-update-never-executed');
  const checksum=crypto.createHash('sha256').update(content).digest('hex');
  let good=true, manifestMode=false, externalMode=false, conflicting=false, duplicate=false, launches=0, shutdowns=0, quitted=0;
  const updaterGate={isUsable:()=>true,status:()=>({state:'GENUINE'}),
    checkRelease:async()=>({version:'0.1.2',files:[{name:externalMode?'BB-Hub-Setup-0.1.2.exe':'BB Hub Setup 0.1.2.exe',url:'https://example.invalid/test.exe',size:content.length,checksum:externalMode?'1'.repeat(32):manifestMode?'':good?checksum:'0'.repeat(64)},...(manifestMode?[{name:'SHA256.txt',url:'https://example.invalid/SHA256.txt',size:200}]:[]),...(duplicate?[{name:'BB_Hub_Setup_0.1.2.exe',size:content.length}]:[])]}),
    releaseDownloadUrl:f=>f.url};
  const updateVM=vm.createContext({module:{exports:{}},console,Buffer,URL,AbortSignal,Date,
    fetch:async url=>new Response(url.endsWith('SHA256.txt')?`${checksum}  BB Hub Setup 0.1.2.exe\n${conflicting?'0'.repeat(64)+'  BB-Hub-Setup-0.1.2.exe\n':''}`:content),
    require(name){
      if(name==='./license/gate.cjs')return updaterGate;
      if(name==='node:child_process')return{spawn(){launches++;const child=new EventEmitter();child.unref=()=>{};queueMicrotask(()=>child.emit('spawn'));return child;}};
      return require(name);
    }});
  vm.runInContext(fs.readFileSync(path.resolve(__dirname,'../electron/updater.cjs'),'utf8'),updateVM);
  const {createUpdater,newerVersion}=updateVM.module.exports;
  assert.equal(newerVersion('0.1.2','0.1.1'),true);
  assert.equal(newerVersion('0.1.1','0.1.1'),false);
  assert.equal(newerVersion('../bad','0.1.1'),false);
  const app={getVersion:()=> '0.1.1',getPath:()=>tempBase,quit(){quitted++;}};
  const make=()=>createUpdater({app,beforeInstall(){shutdowns++;}});
  const success=make(); assert.equal((await success.check()).status,'available');
  assert.equal((await success.install()).status,'installing');
  assert.equal(launches,1); assert.equal(shutdowns,1); assert.equal(quitted,1);
  good=false;
  const corrupt=make(); await corrupt.check();
  assert.equal((await corrupt.install()).status,'error');
  assert.equal(launches,1); assert.equal(shutdowns,1);
  manifestMode=true; good=true;
  const manifestUpdate=make();
  assert.equal((await manifestUpdate.check()).status,'available');
  assert.equal((await manifestUpdate.install()).status,'installing');
  assert.equal(launches,2);
  externalMode=true;
  const externalUpdate=make();
  assert.equal((await externalUpdate.check()).status,'available');
  assert.equal((await externalUpdate.install()).status,'installing');
  assert.equal(launches,3,'external MD5 must fall back to the canonical SHA256 manifest');
  conflicting=true;
  assert.equal((await make().check()).status,'error');
  conflicting=false; duplicate=true;
  assert.equal((await make().check()).status,'error');
  console.log('PASS: updater checks versions, verifies download before launch, rejects corrupted files; installer execution mocked.');
})().catch(error=>{console.error(error);process.exitCode=1;});
