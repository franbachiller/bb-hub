"use strict";
// Piso de amenaza (26/10): un rival parado a UN paso de rey de una casilla de
// contacto (1,1)/(-1,-1) es candidato del tiro a ciegas; uno que no puede entrar
// en un paso no lo es. Caso real (Ring 26/10 18:44Z): nosotros en 10,11, Bate (6)
// parado en 10,13 = (0,2) entró a 11,12 y el tiro fue al 1 en 12,10 = (2,-1).
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const source = fs.readFileSync(path.resolve(process.argv[2] || path.join(__dirname, "../electron/game/flash_runtime.page.js")), "utf8")
  .replace("  window[KEY] = {", "  window.__floorQa = { state, threatPick };\n  window[KEY] = {");

function fixture(avatars) {
  const ctx = vm.createContext({ TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, t: 500000,
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    document: { hidden: false }, __bbHubSend() {} });
  vm.runInContext("globalThis.window = globalThis; globalThis.performance = {now: () => t};", ctx);
  vm.runInContext(source, ctx);
  const q = ctx.__floorQa;
  const s = q.state;
  s.selfId = 7; s.serverPingMs = 172; s.ready = true;
  s.timing.enabled = true; s.timing.source = "STEP"; s.timing.targetMode = "AUTO";
  s.timing.tick.enabled = true; s.timing.tick.single = true;
  s.providers.renderer = { instance: { avatars: new Map(avatars.map(([id, x, y]) =>
    [id, { position: { x, y, z: 4 }, avatarInfo: { id: 1000 + id, username: `u${id}` } }])) } };
  // Cross-tick shot: the batch is known, the landing is after the next tick.
  const E = s.tickEngine;
  E.origin = 499400; E.batches.push({ at: 500000 }); E.lastBatchAt = 500000;
  return q;
}
const LANDING = 500700;
const BLIND_MIN = 0.0005; // TICK_BLIND_MIN_P

// 1) The live case: the rival that can step in is the pick, not the one that can not.
{
  const q = fixture([[7, 10, 11], [6, 10, 13], [1, 12, 10]]);
  const pick = q.threatPick(LANDING, BLIND_MIN);
  assert.ok(pick, "a blind candidate exists");
  assert.equal(pick.id, 6, "(0,2) can step into (1,1): it is the threat");
  assert.equal(pick.score, 0.03);
  console.log("PASS live Ring case: blind click goes to the rival one step from contact");
}

// 2) Every tile one king move from a contact tile gets the floor; tiles that need two steps do not.
{
  const one = [[2, 0], [0, 2], [2, 1], [1, 2], [2, 2], [1, 0], [0, 1], [-2, 0], [0, -2], [-2, -1], [-1, -2], [-2, -2], [-1, 0], [0, -1]];
  const two = [[2, -1], [1, -2], [-1, 2], [-2, 1], [2, -2], [-2, 2]];
  for (const [dx, dy] of one) {
    const q = fixture([[7, 10, 11], [5, 10 + dx, 11 + dy]]);
    const pick = q.threatPick(LANDING, BLIND_MIN);
    assert.ok(pick && pick.id === 5 && pick.score >= 0.03, `(${dx},${dy}) is one step from contact`);
  }
  for (const [dx, dy] of two) {
    const q = fixture([[7, 10, 11], [5, 10 + dx, 11 + dy]]);
    const pick = q.threatPick(LANDING, BLIND_MIN);
    assert.ok(!pick || pick.score < 0.03, `(${dx},${dy}) needs two steps: no floor`);
  }
  console.log("PASS floor covers exactly the tiles one king move from (1,1)/(-1,-1)");
}

// 3) A standing rival already in contact keeps its model value, far above the floor.
{
  const q = fixture([[7, 10, 11], [6, 10, 13], [2, 11, 12]]);
  const pick = q.threatPick(LANDING, BLIND_MIN);
  assert.equal(pick.id, 2, "contact beats a step-in candidate");
  assert.ok(pick.score > 0.9);
  console.log("PASS a rival already in contact outranks the floor");
}
