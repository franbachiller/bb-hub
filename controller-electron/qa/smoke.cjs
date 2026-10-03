/* Local controller UI regression checks through agent-browser. No game connection. */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const exe = process.env.AGENT_BROWSER_BIN || path.join(process.env.APPDATA, 'npm/node_modules/agent-browser/bin/agent-browser-win32-x64.exe');
const session = 'bb-ui-smoke';
const base = process.env.BB_UI_PREVIEW_URL || 'http://127.0.0.1:5188';
const out = path.resolve(__dirname, '../../tmp/controller-redesign-20260926');
fs.mkdirSync(out, { recursive: true });
function browser(...args) {
  const r = spawnSync(exe, ['--session', session, ...args, '--json'], { encoding:'utf8', timeout:30000, windowsHide:true });
  if (r.status !== 0) throw new Error(`${args.join(' ')}: ${r.stderr || r.stdout}`);
  const parsed = JSON.parse(r.stdout.trim());
  if (!parsed.success) throw new Error(JSON.stringify(parsed.error));
  return parsed.data;
}
const evaluate = (code) => browser('eval', code).result;
const click = (selector) => browser('click', selector);
const nav = (name) => {
  const index = ['Inicio','Timing','Board','Drops','Jugadores','Registro'].indexOf(name) + 1;
  return browser('click',`.nav-list .nav-button:nth-child(${index})`);
};
const hasCall = (name) => evaluate(`window.__qa.calls.some(c=>c.name===${JSON.stringify(name)})`);
const checks = [];
function check(name, fn) { fn(); checks.push(name); console.log(`PASS ${name}`); }
try {
  browser('set','viewport','1260','780');
  browser('open',`${base}/qa/redesign-preview.html`);
  browser('wait','.overview-hero');
  check('connected overview and actual target',()=>assert.ok(evaluate("document.body.innerText.includes('Nébula') && document.body.innerText.includes('171 ms')")));
  nav('Timing');
  click('[aria-label="Activar Timing automático"]');
  check('Timing toggle dispatches and reflects state',()=>assert.equal(evaluate('window.__qa.state.timing.enabled'),false));
  click('[aria-label="Caminar paso a paso"]');
  check('step walk setting retained',()=>assert.equal(evaluate('window.__qa.state.stepWalk'),false));
  click('.technical-details summary');
  browser('find','role','button','click','--name','Reiniciar aprendizaje');
  check('learning resets both systems',()=>{assert.ok(hasCall('resetTickAuto'));assert.ok(hasCall('resetExit'));});
  nav('Board');
  browser('find','role','button','click','--name','Armar Board','--exact');
  for(const label of ['Asistir movimiento','Alta potencia']) browser('find','role','button','click','--name',label,'--exact');
  browser('find','role','button','click','--name','Permitir sala');
  click('[aria-label="Reiniciar Board"]');
  check('all four current Board actions and arm retained',()=>{
    const actions=evaluate("window.__qa.calls.filter(c=>c.name==='ringBoardAction').map(c=>c.args[0])");
    assert.equal(new Set(actions).size,4);assert.equal(evaluate('window.__qa.state.ringBoard.armed'),true);
  });
  nav('Drops');
  click('[aria-label="Activar captura de drops"]');
  click('[aria-label="Reclamar automáticamente"]');
  check('Drops changes remain draft',()=>assert.equal(evaluate('window.__qa.state.dropHunter.enabled'),false));
  browser('find','role','button','click','--name','Aplicar cambios');
  check('Drops apply preserves both values',()=>assert.deepEqual(evaluate('({enabled:window.__qa.state.dropHunter.enabled,autoClaim:window.__qa.state.dropHunter.autoClaim})'),{enabled:true,autoClaim:false}));
  nav('Jugadores');
  browser('fill','.search input','1003');
  check('player filtering by user ID',()=>assert.equal(evaluate('document.querySelectorAll("tbody tr").length'),1));
  browser('find','role','button','click','--name','Seleccionar a Órbita');
  check('player selection reaches IPC facade',()=>assert.equal(evaluate('window.__qa.state.selectedTarget'),3));
  browser('fill','.search input','no-existe');
  check('empty player filter is clear',()=>assert.ok(evaluate("document.body.innerText.includes('Ninguna coincidencia')")));
  nav('Registro');
  browser('fill','.search input','Timing');
  check('logs filter',()=>assert.equal(evaluate('document.querySelectorAll(".log-entry").length'),1));
  browser('find','role','button','click','--name','Limpiar','--exact');
  check('logs clear action',()=>assert.equal(evaluate('window.__qa.state.logs.length'),0));
  browser('find','role','button','click','--name','Detener todo');
  check('global stop includes Board',()=>{assert.ok(hasCall('stopModes'));assert.equal(evaluate('window.__qa.state.ringBoard.armed'),false);assert.equal(evaluate('window.__qa.state.dropHunter.enabled'),false);});
  // Reject an action without touching any real backend.
  evaluate("window.ringController.resetTickAuto=async()=>{throw new Error('Prueba de error controlado')}");
  nav('Timing');click('.technical-details summary');
  browser('find','role','button','click','--name','Reiniciar aprendizaje');
  check('action failures are visible',()=>assert.ok(evaluate("document.querySelector('[role=alert]')?.innerText.includes('Prueba de error controlado')")));
  click('[aria-label="Cerrar aviso"]');
  for(const [width,height] of [[1260,780],[980,640],[390,844]]) {
    browser('set','viewport',String(width),String(height));
    for(const name of ['Inicio','Timing','Board','Drops','Jugadores','Registro']) {
      nav(name);
      check(`${name} fits ${width}px`,()=>assert.ok(evaluate('document.documentElement.scrollWidth <= innerWidth + 1')));
    }
  }
  browser('set','viewport','1260','780');browser('open',base);browser('wait','.overview-hero');
  check('real disconnected preview has no mock data',()=>assert.ok(evaluate("document.body.innerText.includes('Sin conexión') && !window.__qa")));
  browser('screenshot',path.join(out,'desktop.png'));
  browser('set','viewport','390','844');browser('screenshot',path.join(out,'compact.png'),'--full');
  const errors=browser('errors');
  fs.writeFileSync(path.join(out,'smoke-results.json'),JSON.stringify({checks,errors},null,2));
  console.log(`${checks.length} UI checks passed`);
} finally { browser('close'); }
