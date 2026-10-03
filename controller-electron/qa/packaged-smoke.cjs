// Tests the actual ASAR renderer and sandboxed preload without starting the bot.
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const packagedDir = process.env.BB_PACKAGED_APP_DIR || path.join(root, 'release/win-unpacked');
const archive = path.join(packagedDir, 'resources/app.asar');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const { ControllerCore } = require(path.join(archive, 'electron/controller-core.cjs'));
  const core = new ControllerCore({ settingsPath: path.join(app.getPath('temp'), 'bb-packaged-smoke-unused.json'), ringBoard: false });
  ipcMain.handle('controller:getSnapshot', () => core.snapshot());
  const win = new BrowserWindow({ show: false, width: 1260, height: 820,
    webPreferences: { preload: path.join(archive, 'electron/preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  const errors = [];
  win.webContents.on('preload-error', (_event, _preload, error) => errors.push(error.message));
  win.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message); });
  await win.loadFile(path.join(archive, 'dist-ui/index.html'));
  const result = await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 10000;
    const poll = () => {
      if (document.querySelector('.rail-nav') && document.body.innerText.includes('Sin conexión')) {
        resolve({ bridge: typeof window.ringController, body: document.body.innerText, sandbox: typeof require });
      } else if (Date.now() > deadline) resolve({ bridge: typeof window.ringController, body: document.body.innerText, sandbox: typeof require, html: document.querySelector('#root')?.innerHTML, url: location.href });
      else setTimeout(poll, 100);
    }; poll();
  })`);
  if (errors.length || result.html !== undefined) console.log(JSON.stringify({ bridge: result.bridge, body: result.body.slice(0,500), errors }));
  assert.equal(result.bridge, 'object');
  assert.equal(result.sandbox, 'undefined');
  assert.ok(result.body.includes('Inicio'));
  assert.ok(result.body.includes('Sin conexión'));
  assert.deepEqual(errors, []);
  await win.webContents.executeJavaScript(`document.querySelectorAll('.rail-link')[2].click()`);
  const preview = await win.webContents.executeJavaScript(`({locked:document.querySelector('.board-tools').disabled,tiles:document.querySelectorAll('.preview-tile').length,frames:document.querySelectorAll('iframe').length})`);
  assert.equal(preview.locked,true); assert.equal(preview.tiles,117); assert.equal(preview.frames,0);
  const out = path.join(root, '../tmp/hub-packaged-smoke-1003.png');
  fs.writeFileSync(out, (await win.webContents.capturePage()).toPNG());
  console.log('PASS: packaged bytecode core, sandbox preload, IPC snapshot and Hub renderer. Screenshot: ' + out);
  const license = new BrowserWindow({ show: false, width: 440, height: 460, frame: false,
    webPreferences: { preload: path.join(archive, 'electron/license/license-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  license.webContents.on('preload-error', (_event, _preload, error) => errors.push(error.message));
  license.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message); });
  await license.loadFile(path.join(archive, 'electron/license/license-window.html'));
  const activation = await license.webContents.executeJavaScript(`(async () => {
    await document.fonts.ready;
    document.querySelector('#btnActivate').click();
    return { bridge: typeof window.bbLicense, error: document.querySelector('#msgActivate').textContent,
      alert: document.querySelector('#msgActivate').getAttribute('role'), logo: document.querySelector('.brand img').naturalWidth,
      matte: getComputedStyle(document.body).backgroundColor, overflow: document.documentElement.scrollWidth > innerWidth };
  })()`);
  assert.equal(activation.bridge, 'object');
  assert.equal(activation.error, 'Introduce una clave.');
  assert.equal(activation.alert, 'alert');
  assert.ok(activation.logo > 0);
  assert.equal(activation.matte, 'rgb(17, 17, 17)');
  assert.equal(activation.overflow, false);
  await license.webContents.executeJavaScript(`init({mode:'locked',state:'SUSPENDED',info:{key:'TEST-ONLY-NOT-A-LICENSE',email:'very-long-test-address-for-layout@example.invalid'}})`);
  const locked = await license.webContents.executeJavaScript(`({ text: document.querySelector('#locked').innerText,
    overflow: document.documentElement.scrollWidth > innerWidth })`);
  assert.ok(locked.text.includes('Licencia suspendida'));
  assert.equal(locked.overflow, false);
  await new Promise(resolve => setTimeout(resolve, 150));
  fs.writeFileSync(path.join(root, '../tmp/bb-activation-locked-1003.png'), (await license.webContents.capturePage()).toPNG());
  await license.webContents.executeJavaScript(`init({mode:'activate'}); setMsg(document.querySelector('#msgActivate'),''); document.querySelector('#key').removeAttribute('aria-invalid'); document.querySelector('#key').blur()`);
  await new Promise(resolve => setTimeout(resolve, 150));
  fs.writeFileSync(path.join(root, '../tmp/bb-activation-matte-1003.png'), (await license.webContents.capturePage()).toPNG());
  assert.deepEqual(errors, []);
  console.log('PASS: packaged activation preload, logo, fonts, matte theme, empty-key alert and suspended layout.');
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
