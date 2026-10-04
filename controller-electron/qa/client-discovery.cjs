"use strict";
const fs=require("node:fs"),path=require("node:path"),os=require("node:os"),assert=require("node:assert/strict"),Module=require("node:module");
const {isHtml5Executable,locateHtml5Client}=require("../electron/game/client-locator.cjs");
const root=fs.mkdtempSync(path.join(os.tmpdir(),"bb-client-discovery-"));
const file=rel=>path.join(root,rel);
function exe(rel){const f=file(rel);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,"fixture; never executed");return f;}
const roaming=file("Roaming/boombang-launcher"),local=file("Local/boombang-launcher");
const standard=exe("Roaming/boombang-launcher/clients/2/BoomBangHTML5.exe");
assert.equal(locateHtml5Client({fallback:standard,roots:[roaming]}),standard);
const custom=exe("Otra unidad/Juegos con espacios/ñ/BoomBangHTML5.exe");
fs.writeFileSync(path.join(roaming,"installed.json"),JSON.stringify({"1":{path:file("flash")},"2":{path:path.dirname(custom)}}));
fs.renameSync(standard,standard+".old");
assert.equal(locateHtml5Client({fallback:standard,roots:[roaming,local]}),custom);
console.log("PASS official installed.json: HTML5 in a custom folder with spaces and non-ASCII characters is found");
fs.writeFileSync(path.join(roaming,"installed.json"),JSON.stringify({"1":{path:path.dirname(custom)}}));
assert.equal(locateHtml5Client({fallback:standard,roots:[roaming]}),"");
const localExe=exe("Local/boombang-launcher/clients/2/BoomBangHTML5.exe");
fs.writeFileSync(path.join(roaming,"installed.json"),"broken JSON");
assert.equal(locateHtml5Client({fallback:standard,roots:[roaming,local]}),localExe);
assert.equal(locateHtml5Client({preferred:custom,fallback:localExe,roots:[local]}),custom);
assert.equal(isHtml5Executable(exe("other/BoomBangLauncher.exe")),false);
fs.mkdirSync(file("directory/BoomBangHTML5.exe"),{recursive:true});
assert.equal(isHtml5Executable(file("directory/BoomBangHTML5.exe")),false);
assert.equal(isHtml5Executable("BoomBangHTML5.exe"),false);
console.log("PASS discovery fallback: Local installation works; explicit choice wins; Flash records, malformed manifests, wrong names and directories are rejected");

const load=Module._load;
let GameLauncher;
try {Module._load=function(name,...rest){if(name==="electron")return {safeStorage:{}};return Reflect.apply(load,this,[name,...rest]);};({GameLauncher}=require("../electron/game/game-launcher.cjs"));}
finally{Module._load=load;}
const options=file("profile/game-options.json"),account=file("profile/game-account.json");
fs.mkdirSync(path.dirname(options),{recursive:true});
fs.writeFileSync(options,JSON.stringify({diagnostics:true,otherPreference:123}));
fs.writeFileSync(account,JSON.stringify({username:"Customer fixture",password:"encrypted-fixture"}));
const accountBefore=fs.readFileSync(account,"utf8");
const config={accountPath:account,optionsPath:options,captureRoot:file("capture"),clientExe:standard,clientRoots:[],hubPort:9999};
const launcher=new GameLauncher(config);
assert.equal(launcher.snapshot().clientFound,false);
launcher.state="error";
assert.equal(launcher.selectClient(custom).clientFound,true);assert.equal(launcher.state,"idle");
assert.equal(fs.readFileSync(account,"utf8"),accountBefore);
assert.deepEqual(JSON.parse(fs.readFileSync(options,"utf8")),{diagnostics:true,otherPreference:123,clientExe:custom});
assert.equal(new GameLauncher(config).clientExe,custom);
launcher.busy=true;assert.throws(()=>launcher.selectClient(localExe),/Cierra el juego/);launcher.busy=false;
assert.throws(()=>launcher.selectClient(file("missing/BoomBangHTML5.exe")),/Selecciona/);
assert.equal(launcher.clientExe,custom);
fs.renameSync(custom,custom+".old");
assert.equal(launcher.snapshot().clientFound,false);
fs.renameSync(standard+".old",standard);
assert.equal(launcher.findClient().clientFound,true);assert.equal(launcher.clientExe,standard);
console.log("PASS selected installation: persists across restart, preserves account and preferences, rejects changes during launch and recovers after a removed installation");
(async()=>{
 const missing=new GameLauncher({...config,clientExe:file("missing/BoomBangHTML5.exe"),clientRoots:[]});
 missing.cdpAvailable=async()=>false;missing.clientRunning=async()=>false;
 await assert.rejects(()=>missing.launch(),/No se encontró BoomBang HTML5.*Elegir BoomBang HTML5/);
 console.log("PASS missing client: actionable error before authentication or game launch");
})().catch(e=>{console.error(e);process.exitCode=1;});
