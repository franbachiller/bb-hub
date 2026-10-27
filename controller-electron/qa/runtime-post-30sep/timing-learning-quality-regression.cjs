"use strict";

// Learning must distinguish an observed result from evidence about which
// request won or where that request landed. No renderer or live game needed.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const runtime = path.resolve(process.argv[2] || path.join(__dirname, "../electron/game/flash_runtime.page.js"));
const source = fs.readFileSync(runtime, "utf8").replace(
  "  window[KEY] = {",
  "  window.__learningQualityQa = { state, notePunch, tickOnServerReply, tickAutoClassify, tickAutoNewContact, tickAutoLoad, tickAutoSave };\n  window[KEY] = {"
);

function fixture(savedAuto = null) {
  const storage = new Map();
  if (savedAuto != null) storage.set("bbhub.tickAuto.v5", JSON.stringify(savedAuto));
  const context = vm.createContext({
    console, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer,
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    performance: { now: () => 1000 }, document: { hidden: false }
  });
  context.window = context;
  context.localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key)
  };
  vm.runInContext(source, context);
  const q = context.__learningQualityQa;
  const E = q.state.tickEngine;
  const A = E.auto;
  q.state.timing.tick.auto = true;
  q.state.timing.tick.autoCal = true;
  q.state.serverPingMs = 160;
  E.origin = 0;
  A.B = 0;
  A.margin = 10;
  A.sigma = 4;
  A.cooldown = "global";
  A.contact.set(1, new Map([[7, false]]));
  A.contact.set(2, new Map([[7, true]]));
  const shot = (extra = {}) => ({
    seq: q.state.seq, o: 0, n: 2, k: 0, b: 0,
    phase: 10, sentAt: 1050, dueAt: 1050, lead: 160, late: 0, targetId: 7,
    ok: true, reactive: false, matched: false, ...extra
  });
  return { q, E, A, shot, storage };
}

function assertUnchanged(A, text) {
  assert.equal(A.samples.length, 0, `${text}: cannot invent a contact-boundary sample`);
  assert.equal(A.B, 0, `${text}: cannot change the fitted boundary`);
  assert.equal(A.margin, 10, `${text}: cannot change the automatic margin`);
}

const cases = [
  ["a competing request uses its own saved lead after ping changes", () => {
    const {q,E,A,shot}=fixture(); E.shots=[shot()]; E.allShots=[{at:1100,lead:110,targetId:8,reason:'REACT'}];q.state.serverPingMs=500;
    q.tickOnServerReply(1220,'reject');q.tickAutoClassify(2);assertUnchanged(A,'saved lead competition');
  }],
  ["a native manual click remains a hit competitor after the ping estimate changes", () => {
    const {q,E,A,shot}=fixture();E.shots=[shot()];q.notePunch(7,'manual');q.state.serverPingMs=500;
    q.tickOnServerReply(1220,'hit',7);q.tickAutoClassify(2);assertUnchanged(A,'manual hit competitor');
  }],
  ["a rejection from a packet burst cannot label a single primary landing", () => {
    const {q,E,A,shot}=fixture();E.shots=[shot({packets:3})];
    q.tickOnServerReply(1220,'reject');q.tickAutoClassify(2);assertUnchanged(A,'packet burst rejection');
  }],
  ["a unique hit includes small observed dispatch lateness in its landing estimate", () => {
    const {q,E,A,shot}=fixture();E.shots=[shot({late:2,sentAt:1052})];
    q.tickOnServerReply(1260,'hit',7);q.tickAutoClassify(2);assert.equal(A.samples.length,1);assert.equal(A.samples[0].p,12);
  }],
  ["an ambiguous reject does not contaminate boundary or margin", () => {
    const { q, E, A, shot } = fixture();
    E.shots = [shot()];
    E.allShots = [{ at: 1100, targetId: 8, reason: "REACT" }];
    q.tickOnServerReply(1220, "reject");
    assert.equal(E.stats.calSkippedAmbiguous, 1);
    q.tickAutoClassify(2);
    assertUnchanged(A, "ambiguous rejection");
  }],
  ["a late-dispatch reject does not contaminate boundary or margin", () => {
    const { q, E, A, shot } = fixture();
    E.shots = [shot({ late: 8, sentAt: 1058 })];
    q.tickOnServerReply(1220, "reject");
    assert.equal(E.stats.calSkippedLate, 1);
    q.tickAutoClassify(2);
    assertUnchanged(A, "late dispatch");
  }],
  ["an unmatched reject cannot be assigned to the only contact change", () => {
    const { q, A } = fixture();
    q.tickOnServerReply(1220, "reject");
    q.tickAutoClassify(2);
    assertUnchanged(A, "unattributed rejection");
  }],
  ["a rival win without a primary reply records the race without advancing the aim", () => {
    const { q, E, A, shot } = fixture();
    E.shots = [shot()];
    A.rivalHits.push({ n: 2, p: 25, attacker: 7 });
    q.tickAutoClassify(2);
    assertUnchanged(A, "rival hit with no request attribution");
    assert.equal(A.races.length, 1, "the observed lost race must remain visible");
  }],
  ["a hit competing with a repeat does not teach a primary landing", () => {
    const { q, E, A, shot } = fixture();
    E.shots = [shot(), shot({ k: 1, phase: 115, sentAt: 1155, dueAt: 1155 })];
    q.tickOnServerReply(1325, "hit", 7);
    q.tickAutoClassify(2);
    assertUnchanged(A, "primary/repeat hit ambiguity");
    assert.equal(A.races.length, 1, "the observed win must remain visible");
  }],
  ...["REACT", "REACT_FALLBACK"].map((reason) => [
    `a hit competing with ${reason} does not teach a primary landing`, () => {
      const { q, E, A, shot } = fixture();
      E.shots = [shot()];
      E.allShots = [
        { at: 1050, targetId: 7, reason: "TICK_BLIND" },
        { at: 1100, targetId: 7, reason }
      ];
      q.tickOnServerReply(1260, "hit", 7);
      q.tickAutoClassify(2);
      assertUnchanged(A, `${reason} hit ambiguity`);
      assert.equal(A.races.length, 1, "the observed win must remain visible");
    }
  ]),
  ["a unique primary hit still learns its armed landing phase", () => {
    const { q, E, A, shot } = fixture();
    E.shots = [shot()];
    q.tickOnServerReply(1260, "hit", 7);
    q.tickAutoClassify(2);
    assert.equal(A.samples.length, 1);
    assert.equal(A.samples[0].p, 10, "a hit's hold must not become its landing phase");
    assert.equal(A.samples[0].after, true);
    assert.equal(A.margin, 9, "unique accepted primary evidence still trains the aim");
  }],
  ["an origin refit does not rewrite the unique hit's armed tick and phase", () => {
    const { q, E, A, shot } = fixture();
    E.shots = [shot({ o: 100, phase: 20, sentAt: 1160, dueAt: 1160 })];
    E.origin = 190;
    q.tickOnServerReply(1370, "hit", 7); // armed T=1300, primary=1320, hold=50
    q.tickAutoClassify(2);
    assert.equal(A.samples.length, 1);
    assert.equal(A.samples[0].p, 20, "learning uses the shot's saved origin/tick frame");
    assert.equal(A.samples[0].after, true);
    assert.equal(A.margin, 9);
  }],
  ["a unique clean primary reject still teaches boundary and margin", () => {
    const { q, E, A, shot } = fixture();
    E.shots = [shot()];
    q.tickOnServerReply(1220, "reject");
    assert.equal(E.stats.calibrated, 1);
    q.tickAutoClassify(2);
    assert.equal(A.samples.length, 1);
    assert.equal(A.samples[0].p, 20);
    assert.equal(A.samples[0].after, false);
    assert.equal(A.margin, 14);
  }],
  ["a reply to a previous generation cannot train the current contact", () => {
    const { q, E, A, shot } = fixture();
    E.shots = [shot({ seq: q.state.seq - 1 })];
    q.tickOnServerReply(1220, "reject");
    q.tickAutoClassify(2);
    assertUnchanged(A, "previous generation reply");
  }],
  ["legacy labels are discarded while saved prior, correction and configuration remain", () => {
    const { q, E, A } = fixture({
      v6: true, B: 5, margin: 12, sigma: 4, corr: 7, cooldown: "global",
      samples: [{ p: 60, after: false }, { p: 80, after: false }]
    });
    const configuration = JSON.stringify(q.state.timing);
    q.tickAutoLoad();
    assert.equal(A.samples.length, 0, "labels without quality provenance cannot train the new fitter");
    assert.equal(A.B, 5, "the old boundary remains a weak initial prior, not a verified new sample");
    assert.equal(A.boundaryPrior, 5);
    assert.equal(A.margin, 12);
    assert.equal(E.corr, 7);
    assert.equal(JSON.stringify(q.state.timing), configuration, "migration cannot change user configuration");
    q.tickAutoNewContact(2, [], { p: 25, attacker: 7 }, 7);
    q.tickAutoClassify(2);
    assert.equal(A.B, 5, "an unqualified race cannot erase the saved weak prior");
  }],
  ["a fresh qualified sample survives save and load with its quality provenance", () => {
    const { q, E, A, shot, storage } = fixture();
    E.shots = [shot()];
    q.tickOnServerReply(1220, "reject");
    q.tickAutoClassify(2);
    q.tickAutoSave(1000, true);
    const saved = JSON.parse(storage.get("bbhub.tickAuto.v5"));
    assert.equal(saved.learningVersion, 1);
    assert.equal(saved.samples.length, 1);
    assert.equal(saved.samples[0].quality, 1);
    const restored = fixture(saved);
    restored.q.tickAutoLoad();
    assert.equal(restored.A.samples.length, 1);
    assert.equal(restored.A.samples[0].p, 20);
    assert.equal(restored.A.samples[0].after, false);
    assert.equal(restored.A.samples[0].quality, 1);
    assert.equal(restored.A.B, A.B);
    assert.equal(restored.A.margin, A.margin);
    assert.equal(restored.E.corr, Math.round(E.corr));
  }],
  ["a new-format container cannot launder an unqualified point", () => {
    const { q, A } = fixture({
      v6: true, learningVersion: 1, B: 5, boundaryPrior: 5,
      margin: 12, sigma: 4, corr: 7, cooldown: "global",
      samples: [{ p: 60, after: false }, { p: 15, after: true, quality: 1 }]
    });
    q.tickAutoLoad();
    assert.equal(A.samples.length, 1);
    assert.equal(A.samples[0].p, 15);
    assert.equal(A.samples[0].quality, 1);
  }]
];

let failures = 0;
for (const [name, run] of cases) {
  try { run(); console.log(`PASS ${name}`); }
  catch (error) { failures++; console.error(`FAIL ${name}\n${error.message}`); }
}
console.log(`${cases.length - failures}/${cases.length} learning-quality cases passed`);
process.exitCode = failures ? 1 : 0;
