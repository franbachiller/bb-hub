const {app} = require('electron');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
app.whenReady().then(async()=>{
  const gate=require(path.join(process.env.BB_PACKAGED_APP_DIR,'resources/app.asar/electron/license/gate.cjs'));
  const original=gate.hasFeature;
  assert.equal(original('ring_board'),process.env.BB_EXPECT_PRO==='1','Set BB_EXPECT_PRO=1 when testing with a real Pro license.');
  let pro=true;
  gate.hasFeature=name=>name==='ring_board' && pro; // Test fixture only; never included in production.
  const file=path.join(process.env.BB_PACKAGED_APP_DIR,'resources/app.asar/electron/ring-board/dist/server.js');
  await import(pathToFileURL(file).href);
  const response=await fetch('http://127.0.0.1:18445/health');
  assert.equal(response.status,200);
  const socket=new WebSocket('ws://127.0.0.1:18444');
  await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});
  const closed=new Promise((resolve,reject)=>{const deadline=setTimeout(()=>reject(new Error('Board left an unauthorized WebSocket open')),4000);socket.once('close',code=>{clearTimeout(deadline);resolve(code);});});
  pro=false;
  await new Promise(resolve=>setTimeout(resolve,1200));
  assert.equal((await fetch('http://127.0.0.1:18445/health')).status,403);
  assert.equal(await closed,1008);
  gate.hasFeature=original;
  console.log('PASS: obfuscated Board server with simulated Pro permission; removal denies HTTP and closes active WebSocket. Real license unchanged.');
  app.exit(0);
}).catch(error=>{console.error(error);app.exit(1);});
