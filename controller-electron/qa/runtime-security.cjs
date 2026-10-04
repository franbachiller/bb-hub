// Exercise the actual main-process license/IPC functions with a controlled
// license provider. No Cryptlex account change and no game connection.
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const app = new EventEmitter();
Object.assign(app, { isPackaged: true, disableHardwareAcceleration() {}, setAppUserModelId() {},
  requestSingleInstanceLock: () => true, whenReady: () => new Promise(() => {}),
  commandLine: { appendSwitch() {}, removeSwitch() {} }, getPath: () => '', isReady: () => false, quit() {} });
const handles = new Map();
const listeners = new Map();
let state = 'GENUINE';
const gate = { STATE: { GENUINE: 'GENUINE', ERROR: 'ERROR' }, status: () => ({state}),
  isUsable: s => ['GENUINE','GRACE'].includes(s), info: () => ({}), onChange() {}, activate: () => ({ok:true}) };
const contents = { mainFrame: {}, send() {}, setWindowOpenHandler() {}, on() {} };
const window = { webContents: contents, isDestroyed: () => false, isMinimized: () => false,
  isVisible: () => true, show() {}, focus() {}, hide() {}, minimize() {} };
let suspended = 0;
const core = { on() {}, snapshot: () => ({connected:false}), suspendForLicense() { suspended++; } };
const shortcuts = new Map();
let saved = 0, toggles = 0;
Object.assign(core, { persistSettings(){saved++;}, emitSnapshot(){}, toggleHotkeyMode(mode){ assert.equal(mode,'TIMING'); toggles++; } });
const context = vm.createContext({ console, __dirname: path.resolve(__dirname, '../electron'),
  require(name) {
    if (name === 'electron') return { app, BrowserWindow: function() {},
      ipcMain: { handle: (name, fn) => handles.set(name,fn), on: (name, fn) => listeners.set(name,fn) },
      globalShortcut: { unregisterAll() {shortcuts.clear();}, unregister(key){shortcuts.delete(key);}, register(key,fn){ if(key==='F3') return false; shortcuts.set(key,fn); return true; } } };
    if (name === './controller-core.cjs') return { ControllerCore: function() {} };
    if (name === './license/gate.cjs') return gate;
    if (name.startsWith('./')) return require(path.resolve(__dirname,'../electron',name));
    return require(name);
  }, process: { env: {BB_SKIP_LICENSE:'1'}, platform:'win32', on() {} },
  setTimeout() {}, setInterval() {}, clearInterval() {}, module:{exports:{}} });
vm.runInContext(fs.readFileSync(path.resolve(__dirname,'../electron/main.cjs'),'utf8') + `
module.exports={wireIpc,wireLicenseIpc,requireRuntimeLicense,currentLicense,setTimingHotkey,
  setup(w,c){mainWindow=w;licenseWindow=w;core=c;runtimeAllowed=true;licenseWindowReady=true;},
  locked(){return !runtimeAllowed;}};`, context);
const api = context.module.exports;
api.setup(window,core);
api.wireIpc();
api.wireLicenseIpc();
const trusted = { sender:contents, senderFrame:contents.mainFrame };
assert.equal(handles.get('controller:getSnapshot')(trusted).connected,false);
assert.equal(handles.get('controller:setTimingHotkey')(trusted,'ctrl+F4'),'Control+F4');
shortcuts.get('Control+F4')();
assert.equal(toggles,1);
assert.throws(()=>api.setTimingHotkey('F3'),/ocupado/);
assert.equal(core.timingHotkey,'Control+F4');
assert.equal(saved,1);
assert.equal(api.setTimingHotkey('F5'),'F5');
assert.equal(shortcuts.has('Control+F4'),false);
api.setTimingHotkey('');
assert.equal(shortcuts.size,0);
assert.throws(() => handles.get('controller:getSnapshot')({sender:contents,senderFrame:{}}),/no autorizada/);
assert.throws(() => handles.get('game:selectClient')({sender:contents,senderFrame:{}}),/no autorizada/);
assert.throws(() => handles.get('license:activate')({sender:{},senderFrame:{}},'test'),/no autorizada/);
state='SUSPENDED';
assert.equal(api.currentLicense().state,'SUSPENDED'); // Production ignores BB_SKIP_LICENSE.
assert.throws(() => handles.get('controller:getSnapshot')(trusted),/licencia válida/);
assert.throws(() => handles.get('game:findClient')(trusted),/licencia válida/);
assert.throws(() => handles.get('game:selectClient')(trusted),/licencia válida/);
assert.equal(suspended,1);
assert.equal(api.locked(),true);
assert.throws(() => handles.get('controller:getSnapshot')(trusted),/licencia válida/);
assert.equal(suspended,1); // Lockdown is idempotent.
state='GENUINE';
assert.throws(() => handles.get('controller:getSnapshot')(trusted),/licencia válida/); // Explicit restart required.
const {ControllerCore} = require('../electron/controller-core.cjs');
const sent=[];
let stopped=false, disarmed=false, modes=false;
ControllerCore.prototype.suspendForLicense.call({stopModes(){modes=true;},setRingBoardArmed(x){disarmed=x===false;},
  sendToSwf(x){sent.push(x);},stop(){stopped=true;}});
assert.ok(modes && disarmed && stopped);
assert.ok(sent.some(x=>x.type==='auto_ring_config' && x.enabled===false));
assert.ok(sent.some(x=>x.type==='coco_guard_config' && x.selfMode==='off'));
assert.ok(sent.some(x=>x.type==='free_fire_config' && x.enabled===false));
console.log('PASS: IPC origin/frame checks, production bypass disabled, suspension blocks repeated calls, motor shutdown.');
