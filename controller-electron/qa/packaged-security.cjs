const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const asar = require('@electron/asar');
const packed = process.env.BB_PACKAGED_APP_DIR;
const expectedPro = process.env.BB_EXPECT_PRO === '1';
if (!packed || !path.isAbsolute(packed)) throw new Error('Set BB_PACKAGED_APP_DIR to the absolute packaged directory.');
const exe = path.join(packed,'BB Hub.exe');
const testRoot = fs.mkdtempSync('D:/bb-hub-build-temp-1003/security-test-');
const startup = path.join(process.env.APPDATA,'bb-hub/startup.log');
const wait = ms => new Promise(resolve=>setTimeout(resolve,ms));
const stop = child => { if (child.exitCode === null) spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'}); };
const connects = port => new Promise(resolve => {
  const socket = net.connect({host:'127.0.0.1',port});
  socket.setTimeout(1000);
  socket.once('connect',()=>{socket.destroy();resolve(true);});
  socket.once('error',()=>resolve(false));
  socket.once('timeout',()=>{socket.destroy();resolve(false);});
});
(async()=>{
  const {getCurrentFuseWire,FuseV1Options,FuseState} = await import('@electron/fuses');
  const wire = await getCurrentFuseWire(exe);
  for (const option of ['RunAsNode','EnableNodeOptionsEnvironmentVariable','EnableNodeCliInspectArguments'])
    assert.equal(wire[FuseV1Options[option]],FuseState.DISABLE);
  for (const option of ['EnableEmbeddedAsarIntegrityValidation','OnlyLoadAppFromAsar'])
    assert.equal(wire[FuseV1Options[option]],FuseState.ENABLE);
  const {NtExecutable,NtExecutableResource} = await import('resedit');
  const resources = NtExecutableResource.from(NtExecutable.from(fs.readFileSync(exe),{ignoreCert:true}));
  const integrity = JSON.parse(resources.getResourceEntriesAsString('INTEGRITY','ELECTRONASAR')[0][1]);
  const header = asar.getRawHeader(path.join(packed,'resources/app.asar')).headerString;
  assert.equal(integrity[0].value,crypto.createHash('sha256').update(header).digest('hex'));
  const marker = path.join(testRoot,'node-options-executed.txt');
  const injection = path.join(testRoot,'injection.cjs');
  fs.writeFileSync(injection,`require('node:fs').writeFileSync(${JSON.stringify(marker)},'executed');`);
  const oldSize = fs.existsSync(startup) ? fs.statSync(startup).size : 0;
  const child = spawn(exe,['--inspect=9363','--remote-debugging-port=9364','--noerrdialogs'],{
    windowsHide:true,env:{...process.env,ELECTRON_RUN_AS_NODE:'1',BB_SKIP_LICENSE:'1',
      VITE_DEV_SERVER_URL:'http://127.0.0.1:9',NODE_OPTIONS:`--require=${injection}`},stdio:['ignore','pipe','pipe']});
  let output='';
  child.stderr.on('data',chunk=>{output+=chunk;});
  child.stdout.on('data',chunk=>{output+=chunk;});
  try {
    await wait(7000);
    const log = fs.readFileSync(startup,'utf8').slice(oldSize);
    assert.ok(log.includes('estado licencia al arrancar: GENUINE'),log + output);
    assert.ok(log.includes('renderer handshake OK'),log + output);
    assert.equal(log.includes('ring-board server started'),expectedPro,'Board startup does not match the expected license tier');
    assert.ok(!/brain worker error|ring-board startup failed/i.test(output + log),output + log);
    assert.ok(!log.includes('licencia OMITIDA'));
    assert.ok(!fs.existsSync(marker),'NODE_OPTIONS was executed');
    assert.equal(await connects(9363),false,'Node inspector is listening');
    assert.equal(await connects(9364),false,'Chromium remote debugger is listening');
    assert.equal(await connects(18445),expectedPro,'Board HTTP port does not match the expected tier');
    assert.equal(await connects(18444),expectedPro,'Board WebSocket port does not match the expected tier');
    if(expectedPro) assert.equal((await fetch('http://127.0.0.1:18445/health')).status,200);
    console.log(`PASS: genuine ${expectedPro?'Pro':'Basic'} activation + renderer, Board access matches tier, environment injection and debugging blocked.`);
  } finally { stop(child); }
  await wait(1000);
  const tampered = path.join(testRoot,'tampered');
  fs.cpSync(packed,tampered,{recursive:true});
  const archive = path.join(tampered,'resources/app.asar');
  const fd = fs.openSync(archive,'r+');
  const bytes = Buffer.alloc(Buffer.byteLength(header) + 64);
  fs.readSync(fd,bytes,0,bytes.length,0);
  const offset = bytes.indexOf('cyrillic');
  assert.ok(offset>=16,'Unused font entry not found in ASAR header');
  fs.writeSync(fd,Buffer.from('C'),0,1,offset);
  fs.closeSync(fd);
  const modified = spawn(path.join(tampered,'BB Hub.exe'),['--noerrdialogs'],{
    windowsHide:true,env:{...process.env,ELECTRON_RUN_AS_NODE:'',NODE_OPTIONS:''},stdio:['ignore','pipe','pipe']});
  let tamperOutput='';
  modified.stderr.on('data',chunk=>{tamperOutput+=chunk;});
  modified.stdout.on('data',chunk=>{tamperOutput+=chunk;});
  try {
    await wait(5000);
    assert.notEqual(modified.exitCode,null,'Modified archive was not rejected');
    assert.notEqual(modified.exitCode,0);
    assert.match(tamperOutput,/integrity|hash mismatch/i);
    console.log('PASS: modified ASAR rejected by the packaged executable.');
  } finally { stop(modified); }
  fs.writeFileSync(path.join(testRoot,'result.json'),JSON.stringify({passed:true,fuses:wire,asarTamperingRejected:true},null,2));
  console.log('Security test artifacts: ' + testRoot);
})().catch(error=>{console.error(error);process.exitCode=1;});
