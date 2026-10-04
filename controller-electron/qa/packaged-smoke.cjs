// Tests the actual ASAR renderer and sandboxed preload without starting the bot.
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const packagedDir = process.env.BB_PACKAGED_APP_DIR || path.join(root, 'release/win-unpacked');
const archive = path.join(packagedDir, 'resources/app.asar');
fs.mkdirSync(path.resolve(root, '../tmp'), { recursive: true });
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const { ControllerCore } = require(path.join(archive, 'electron/controller-core.cjs'));
  const core = new ControllerCore({ settingsPath: path.join(app.getPath('temp'), 'bb-packaged-smoke-unused.json'), ringBoard: false });
  const emptyGame = { state: 'idle', message: '', username: '', hasAccount: false, clientFound: true, avatarUrl: '' };
  ipcMain.handle('controller:getSnapshot', () => ({ ...core.snapshot(), game: emptyGame }));
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
  const fresh = await win.webContents.executeJavaScript(`({
    username: document.querySelector('input[aria-label="Usuario de BoomBang"]')?.value,
    password: document.querySelector('input[type="password"]')?.value,
    name: document.querySelector('.profile-name')?.textContent,
    hasSpoof: /spoof/i.test(document.body.innerText)
  })`);
  assert.equal(fresh.username, ''); assert.equal(fresh.password, '');
  assert.equal(fresh.name, 'Tu keko'); assert.equal(fresh.hasSpoof, false);
  const avatar = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="red"/></svg>');
  win.webContents.send('controller:snapshot', { ...core.snapshot(), connected: true,
    selfId: 7, players: [{ id: 7, name: 'Cliente de prueba', self: true, x: 10, y: 11 }],
    game: { ...emptyGame, state: 'ready', hasAccount: true, username: 'Cliente de prueba', avatarUrl: avatar } });
  await new Promise(resolve => setTimeout(resolve, 250));
  const profile = await win.webContents.executeJavaScript(`({
    name: document.querySelector('.profile-name')?.textContent,
    avatar: document.querySelector('.profile-avatar img')?.getAttribute('src'),
    alt: document.querySelector('.profile-avatar img')?.getAttribute('alt')
  })`);
  assert.equal(profile.name, 'Cliente de prueba'); assert.equal(profile.avatar, avatar);
  assert.equal(profile.alt, 'Personaje de Cliente de prueba');
  const { GameLauncher } = require(path.join(archive, 'electron/game/game-launcher.cjs'));
  const cleanRoot = fs.mkdtempSync(path.join(app.getPath('temp'), 'bb-fresh-client-'));
  const freshLauncher = new GameLauncher({ accountPath: path.join(cleanRoot, 'game-account.json'),
    optionsPath: path.join(cleanRoot, 'game-options.json'), captureRoot: path.join(cleanRoot, 'combate'),
    clientExe: path.join(packagedDir, 'BB Hub.exe'), hubPort: 9999 });
  assert.equal(freshLauncher.readAccount(), null);
  assert.equal(freshLauncher.snapshot().username, '');
  assert.equal(freshLauncher.snapshot().hasAccount, false);
  assert.equal(freshLauncher.snapshot().avatarUrl, '');
  const selectedExe = path.join(cleanRoot, 'BoomBangHTML5.exe');
  fs.writeFileSync(selectedExe, 'Test fixture; not executed.');
  let searches = 0, selections = 0;
  ipcMain.handle('game:findClient', () => {
    searches++; const game = freshLauncher.findClient();
    win.webContents.send('controller:snapshot', { ...core.snapshot(), game }); return game;
  });
  ipcMain.handle('game:selectClient', () => {
    selections++; const game = freshLauncher.selectClient(selectedExe);
    win.webContents.send('controller:snapshot', { ...core.snapshot(), game }); return game;
  });
  win.webContents.send('controller:snapshot', { ...core.snapshot(), game: freshLauncher.snapshot() });
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(await win.webContents.executeJavaScript(`document.body.innerText.includes('No se encontró BoomBang HTML5')`), true);
  fs.writeFileSync(path.join(root, '../tmp/hub-missing-client-015.png'), (await win.webContents.capturePage()).toPNG());
  await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Buscar de nuevo').click()`);
  await new Promise(resolve => setTimeout(resolve, 200)); assert.equal(searches, 1);
  await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Elegir BoomBang HTML5').click()`);
  await new Promise(resolve => setTimeout(resolve, 200)); assert.equal(selections, 1);
  assert.equal(await win.webContents.executeJavaScript(`document.body.innerText.includes('BoomBang HTML5 encontrado')`), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(cleanRoot, 'game-options.json'))).clientExe, selectedExe);
  console.log('PASS: missing-client recovery UI, sandbox IPC for discovery/selection and persistent path in the packaged launcher.');
  console.log('PASS: fresh customer has empty credentials; packaged launcher has no default account; keko and name follow the customer snapshot.');
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
