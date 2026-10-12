import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hasStepContact, selectStepCrossing, recommendStepWindow } from '../src/step-click-metrics.js';
const require = createRequire(import.meta.url);
let count = 0;
function check(name, test) { test(); count++; console.log('PASS ' + name); }
const measured = (patch = {}) => ({ targetId: 7, active: false, samples: 30, durationMs: 600, closestMs: 430, closestContactMs: 420, contactWindows: [{ fromMs: 410, toMs: 450 }], ...patch });
check('active contact replaces the previous encounter, but distant movement preserves the encounter', () => {
  const old = measured(), current = measured({ active: true, closestMs: 360, closestContactMs: 350 });
  assert.equal(selectStepCrossing({ targetId: 7, crossing: current, lastEncounter: old }), current);
  assert.equal(selectStepCrossing({ targetId: 7, crossing: { ...current, contactWindows: [] }, lastEncounter: old }), old);
});
check('cleared or changed ficha cannot show another rival measurement', () => {
  assert.equal(selectStepCrossing({ targetId: 9, lastEncounter: measured(), lastCrossing: measured() }), null);
  assert.equal(selectStepCrossing({ targetId: -1, lastEncounter: measured() }), null);
});
check('a distant or incomplete reading cannot offer a contact preset', () => {
  assert.equal(recommendStepWindow(measured({ contactWindows: [] }), {}, 158).ready, false);
  assert.equal(recommendStepWindow(measured({ samples: 1 }), {}, 158).ready, false);
  assert.equal(hasStepContact(measured({ contactWindows: [{ fromMs: 0, toMs: null }] })), false);
});
check('full RTT shifts the send window while preserving width', () => {
  const r = recommendStepWindow(measured(), { startMs: 455, endMs: 500, intervalMs: 5 }, 158);
  assert.equal(r.centerMs, 262);
  assert.equal(r.endMs - r.startMs, 45);
  assert.equal(r.startMs, 240);
});
check('unknown latency is not treated as zero', () => {
  for (const latency of [null, undefined, NaN, -1]) assert.equal(recommendStepWindow(measured(), {}, latency).ready, false);
  assert.equal(recommendStepWindow(measured(), {}, 0).ready, true);
});
check('a required send before the observed step is reported unreachable, not clamped to zero', () => {
  const r = recommendStepWindow(measured({ closestContactMs: 100 }), {}, 158);
  assert.equal(r.ready, false);
  assert.equal(r.centerMs, -58);
  assert.equal(r.startMs, undefined);
});
check('short steps clip width and keep the window entirely within the measured duration', () => {
  const r = recommendStepWindow(measured({ durationMs: 80, closestContactMs: 60 }), { startMs: 350, endMs: 500 }, 10);
  assert.equal(r.ready, true);
  assert.equal(r.startMs, 0);
  assert.equal(r.endMs, 80);
  const edge = recommendStepWindow(measured({ closestContactMs: 180 }), { startMs: 455, endMs: 500 }, 158);
  assert.equal(edge.centerMs, 22);
  assert.equal(edge.startMs, 0);
  assert.equal(edge.endMs, 45);
});
check('Hub status preserves encounter, closest contact and RTT without accepting malformed windows', () => {
  const { ControllerCore } = require('../electron/controller-core.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-step-metrics-'));
  const core = new ControllerCore({ ringBoard: false, settingsPath: path.join(dir, 'settings.json') });
  try {
    core.handleSwfMessage({ type: 'step_click_state', status: { targetId: 7, latencyMs: 158, lastEncounter: measured(), crossing: measured({ contactWindows: [{ fromMs: 0, toMs: null }] }), last: { phaseMs: 263, plannedPhaseMs: 262, estimatedLandingMs: 421, latencyMs: 158 } } });
    assert.equal(core.stepClickStatus.lastEncounter.closestContactMs, 420);
    assert.equal(core.stepClickStatus.latencyMs, 158);
    assert.deepEqual(core.stepClickStatus.crossing.contactWindows, []);
    assert.equal(core.stepClickStatus.last.plannedPhaseMs, 262);
    assert.equal(core.stepClickStatus.last.estimatedLandingMs, 421);
  } finally { core.stop(); }
});
console.log(`PASS ${count} step-click metrics regression groups`);
