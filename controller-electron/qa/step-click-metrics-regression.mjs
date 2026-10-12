import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stepClickDraft, validStepClickDraft, stepClickPhases, selectStepCrossing, stepCrossingPhase } from '../src/step-click-metrics.js';
const require = createRequire(import.meta.url);
let count = 0;
function check(name, test) { test(); count++; console.log('PASS ' + name); }
const measured = (patch = {}) => ({ targetId: 7, source: 'PAIR', active: false, complete: true, samples: 30, durationMs: 600, closestMs: 430, closestContactMs: 420, motionKind: 'BOTH', clockSource: 'socket_worker', referenceId: 7, contactWindows: [{ fromMs: 410, toMs: 450 }], ...patch });
check('new configuration has one exact moment; legacy windows remain custom without edits', () => {
  const fresh = stepClickDraft();
  assert.equal(fresh.pattern, 'SINGLE');
  assert.deepEqual(stepClickPhases(fresh, 600), [375]);
  const old = stepClickDraft({ startMs: 455, endMs: 500, intervalMs: 5, source: 'SELECTED' });
  assert.equal(old.pattern, 'CUSTOM');
  assert.deepEqual(stepClickPhases(old, 600), [455,460,465,470,475,480,485,490,495]);
  assert.equal(old.source, 'SELECTED');
});
check('single shot is at the chosen moment, never at a symmetric window start', () => {
  assert.deepEqual(stepClickPhases(stepClickDraft({pattern:'SINGLE',momentMs:262,startMs:240,endMs:285}),600),[262]);
});
check('triple offsets are symmetric and clip without moving the surviving times', () => {
  assert.deepEqual(stepClickPhases(stepClickDraft({pattern:'TRIPLE',momentMs:375}),600),[355,375,395]);
  assert.deepEqual(stepClickPhases(stepClickDraft({pattern:'TRIPLE',momentMs:0}),600),[0,20]);
  assert.deepEqual(stepClickPhases(stepClickDraft({pattern:'TRIPLE',momentMs:590}),600),[570,590]);
  assert.deepEqual(stepClickPhases(stepClickDraft({pattern:'SINGLE',momentMs:600}),600),[]);
});
check('invalid input cannot become an implicit zero or exceed the request bound', () => {
  for(const momentMs of ['', ' ', null, undefined, -1, 5000, 1.5, NaN]) assert.equal(validStepClickDraft({pattern:'SINGLE',momentMs}),false);
  assert.equal(validStepClickDraft({pattern:'CUSTOM',startMs:0,endMs:5000,intervalMs:1}),false);
  assert.equal(validStepClickDraft({pattern:'CUSTOM',startMs:100,endMs:100,intervalMs:10}),false);
  assert.deepEqual(stepClickPhases({pattern:'TRIPLE',momentMs:NaN}),[]);
});
check('partial movement never replaces a completed blue reading', () => {
  const old=measured(), current=measured({active:true,complete:false,closestMs:5});
  assert.equal(selectStepCrossing({targetId:7,source:'PAIR',crossing:current,lastEncounter:old}),old);
  assert.equal(selectStepCrossing({targetId:7,source:'PAIR',crossing:current,lastEncounter:{...old,complete:false}}),null);
});
check('changed ficha, changed reference and malformed traces cannot reuse the marker', () => {
  assert.equal(selectStepCrossing({targetId:9,lastEncounter:measured()}),null);
  assert.equal(selectStepCrossing({targetId:-1,lastEncounter:measured()}),null);
  assert.equal(selectStepCrossing({targetId:7,source:'SELECTED',lastEncounter:measured()}),null);
  for(const patch of [{closestMs:null,closestContactMs:null},{closestMs:'',closestContactMs:null},{samples:1},{durationMs:0},{complete:false},{contactWindows:[{fromMs:0,toMs:null}]}]) assert.equal(selectStepCrossing({targetId:7,lastEncounter:measured(patch)}),null);
});
check('distant minimum is excluded; blue prefers closeness during contact', () => {
  const trace=measured({closestContactMs:null,contactWindows:[]});
  assert.equal(selectStepCrossing({targetId:7,source:'PAIR',lastEncounter:trace}),null);
  assert.equal(stepCrossingPhase(measured({closestMs:10,closestContactMs:420})),420);
  assert.equal(stepCrossingPhase(measured({closestContactMs:null})),430);
});
check('Hub status retains the completed marker and its reference metadata', () => {
  const { ControllerCore } = require('../electron/controller-core.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-step-metrics-'));
  const core = new ControllerCore({ ringBoard: false, settingsPath: path.join(dir, 'settings.json') });
  try {
    core.handleSwfMessage({ type:'step_click_state',status:{targetId:7,source:'PAIR',pattern:'SINGLE',momentMs:375,lastEncounter:measured(),crossing:measured({complete:false,contactWindows:[{fromMs:0,toMs:null}]})}});
    assert.equal(core.stepClickStatus.lastEncounter.complete,true);
    assert.equal(core.stepClickStatus.lastEncounter.closestMs,430);
    assert.equal(core.stepClickStatus.lastEncounter.motionKind,'BOTH');
    assert.equal(core.stepClickStatus.lastEncounter.referenceId,7);
    assert.deepEqual(core.stepClickStatus.crossing.contactWindows,[]);
  } finally { core.stop(); }
});
console.log(`PASS ${count} step-click metrics regression groups`);
