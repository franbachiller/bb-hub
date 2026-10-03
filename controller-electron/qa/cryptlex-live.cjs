// Read the real signed entitlement from the packaged gate. Never prints keys.
const { app } = require('electron');
const path = require('node:path');
const assert = require('node:assert/strict');
app.whenReady().then(async () => {
  const archive = path.join(process.env.BB_PACKAGED_APP_DIR, 'resources/app.asar');
  const gate = require(path.join(archive, 'electron/license/gate.cjs'));
  assert.equal(gate.init().ok, true);
  const { LexActivator } = require(path.join(archive, 'node_modules/@cryptlex/lexactivator'));
  const code = LexActivator.SyncLicenseActivation();
  assert.equal(code, 0);
  assert.equal(gate.status().state, 'GENUINE');
  assert.equal(gate.hasFeature('ring_board'), true);
  const entitlement = LexActivator.GetFeatureEntitlement('ring_board');
  console.log(JSON.stringify({ state: gate.status().state, boardPro: true,
    feature: entitlement.featureName, value: entitlement.value }, null, 2));
  const update = await gate.checkRelease('0.1.2');
  console.log(JSON.stringify({ releaseCheck: 'ok', updateAvailable: Boolean(update) }));
  app.exit(0);
}).catch(error => { console.error(error.code || error.message); app.exit(1); });
