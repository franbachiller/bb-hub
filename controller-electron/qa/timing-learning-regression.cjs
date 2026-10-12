"use strict";
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const runtime = path.resolve(process.argv[2] || path.join(__dirname, "../electron/game/flash_runtime.page.js"));
const source = fs.readFileSync(runtime, "utf8").replace("  window[KEY] = {", "  window.__timingQa = { state, tickAutoNewContact, tickEffective, tickOnServerReply };\n  window[KEY] = {");
const context = vm.createContext({ console, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {}, performance: {now: () => 1000}, document: {hidden: false} });
context.window = context;
vm.runInContext(source, context);
const { state, tickAutoNewContact, tickEffective, tickOnServerReply } = context.__timingQa;
const E = state.tickEngine;
state.timing.tick.auto = true;
E.auto.margin = 14;
E.auto.sigma = 4;
E.auto.cooldown = "global";
E.shots = [{n: 2, k: 0, b: 0, ok: true, reactive: false, targetId: 7, phase: 14}];
tickAutoNewContact(2, [], {p: 30}, 8);
assert.equal(E.auto.margin, 14, "a loss to rival 8 cannot adjust the click aimed at rival 7");
console.log("PASS multi-rival learning: an untargeted rival does not change the aim");
E.auto.B = -10;
E.auto.margin = 10;
assert.equal(tickEffective().offset, 0, "Auto combines the measured boundary and margin without a second fixed floor");
console.log("PASS Auto arrival: the current boundary plus margin determines the aim");
E.origin = 0;
E.shots = [
  {o: 0, n: 2, k: 0, b: 0, ok: true, matched: false, targetId: 7, phase: 10, sentAt: 1000},
  {o: 0, n: 2, k: 1, b: 0, ok: true, matched: false, targetId: 8, phase: 30, sentAt: 1020}
];
tickOnServerReply(1240, "hit", 8);
assert.equal(E.shots[0].matched, false, "the hit names rival 8, so it cannot consume rival 7's shot");
assert.equal(E.shots[1].matched, true);
console.log("PASS hit attribution: replies only match shots at their named defender");
