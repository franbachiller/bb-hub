"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "../../..");
const runtimePath = path.resolve(__dirname, "../../electron/game/flash_runtime.page.js");
const original = fs.readFileSync(runtimePath, "utf8");
const official = fs.readFileSync(path.join(__dirname, "fixtures/client-methods.txt"), "utf8");
function section(source, start, end) {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `Missing source boundary: ${start}`);
  return source.slice(a, b);
}
const messages = [];
const intervals = [];
const context = vm.createContext({
  console, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer,
  time: 1000, setInterval: (fn, ms) => intervals.push({ fn, ms }), clearInterval: () => {},
  setTimeout: () => 1, clearTimeout: () => {},
  __bbHubSend: (message) => messages.push(JSON.parse(JSON.stringify(message))),
  document: { hidden: false }
});
vm.runInContext(`
  globalThis.window = globalThis;
  globalThis.performance = { now: () => time };
  ${section(official, "class $ {", "function mc()")}
  class Socket {
    static instance = new Socket();
    frames = [];
    fail = false;
    inboundBacklog = 0;
    sendServerMessage(packet) {
      if (this.fail) throw new Error("mock transport failure");
      this.frames.push({ at: time, bytes: [...packet.toByteArray()] });
    }
    handleReceivedBytes(bytes) { this.lastReceived = bytes; }
  }
  const W = Socket;
  class Upper {
    static instance = new Upper();
    lastUpperAt = 0;
    ${section(official, '  ["upperRequest"](t) {', '  ["changeHobbiesRequest"]')}
    // Same as the official client's cocoRequest (149, 1, id).
    cocoRequest(t) {
      const e = new $(149);
      e.appendParameter(1);
      e.appendParameter(t);
      Socket.instance.sendServerMessage(e);
    }
    // Same as the official client's rotationRequest (135, "", orient).
    rotationRequest(t) {
      const e = new $(135);
      e.appendParameter("");
      e.appendParameter(t);
      Socket.instance.sendServerMessage(e);
    }
  }
  class Renderer {
    static instance = new Renderer();
    avatars = new Map([
      [1, { position: { x: 10, y: 10, z: 1 }, avatarInfo: { id: 100, username: "Self" } }],
      [7, { position: { x: 11, y: 11, z: 2 }, avatarInfo: { id: 700, username: "Rival" } }]
    ]);
    moveUser() {}
    punchUsers() {}
    ${section(official, '  ["getStaticWalkMatrix"]() {', '  ["isAvatarSombraSelectable"]')}
  }
  // exitSpace / islandRequest send what the official client sends (128/124, 128/120 [isArea, zone, pwd]).
  class Walk { static instance = new Walk(); walk() {} exitSpace() { Socket.instance.sendServerMessage(new $(128, 124)); } }
  class Nav { static instance = new Nav(); navs = []; clearPendingNavigation() {} islandRequest(t, e, n = "") { this.navs.push([t, e]); const p = new $(128, 120); p.appendParameter(t); p.appendParameter(e); p.appendParameter(n); Socket.instance.sendServerMessage(p); return true; } }
  class Ping { static instance = new Ping(); latency = 5; sendPing() {} }
  class Game { static instance = new Game(); calls = []; gameRequest(t, e) { this.calls.push(["join", t, e]); } gameStatusRequest() { this.calls.push(["status"]); } }
  class Action { static instance = new Action(); calls = []; actionRequest(t) { this.calls.push(t); } changeUpperRequest() {} }
  class Pixi { static instance = new Pixi(); app = { renderer: { draws: 0, render() { this.draws++; } } }; loadPIXIScene() {} applyResolution() {} }
  const provider = (exported) => ({ exported, instance: exported.instance });
  globalThis.__testProviders = {
    upper: provider(Upper), socket: provider(Socket), renderer: provider(Renderer),
    walk: provider(Walk), ping: provider(Ping), packet: { exported: $, instance: null },
    game: provider(Game), pixi: provider(Pixi), action: provider(Action), nav: provider(Nav)
  };
  globalThis.fixture = { Socket, Upper, Renderer, Packet: $, Game, Pixi, Action, Nav };
`, context);
// Only replace module discovery; exercise the full runtime and boot/hooks.
const discovery = "await loadProvidersWithRetry(timeoutMs)";
assert.ok(original.includes(discovery));
vm.runInContext(original.replace(discovery, "window.__testProviders"), context);
const run = (code) => vm.runInContext(code, context);
const api = context.__BBFlashRuntime;

(async () => {
  await api.boot({ selfUsername: "Self" });
  api.onHubMessage({ type: "ring_slots_config", enabled: false }); // fixture ids are free; see the ring slots test
  api.select(7);
  assert.equal(api.status().serverPingMs, 5);
  api.onHubMessage({ type: "diagnostic_config", enabled: true });
  // Our fixture hits would lock our punches for 13.8 s; the lock has its own test.
  api.onHubMessage({ type: "hit_lock_config", ms: 0 });
  api.onHubMessage({ type: "tick_burst_config", count: 1 }); // single requests in the older tests; the burst has its own
  api.onHubMessage({ type: "reach_probe_config", enabled: false }); // likewise: the reach probe has its own test
  api.onHubMessage({ type: "low_ping_config", mode: "off" }); // the fixture ping (5 ms) would turn it on; it has its own test
  api.onHubMessage({ type: "performance_config", packetBus: true });
  api.onHubMessage({ type: "punch_config", packets: 8 });
  // The client native 100 ms guard, as the official client (our default skips it; see below).
  api.onHubMessage({ type: "no_throttle_config", enabled: false });
  const results = [];
  for (const at of [1000, 1005, 1010, 1099, 1100]) {
    context.time = at;
    results.push(api.fire(7));
  }
  assert.deepEqual(results, [true, false, false, false, true]);
  assert.equal(run("fixture.Socket.instance.frames.length"), 2);
  assert.equal(api.status().stats.fires, 2);
  assert.equal(api.status().stats.fireAttempts, 5);
  assert.equal(api.status().stats.blockedFires, 3);
  const outgoing = messages.filter((m) => m.type === "packet_event" && m.dir === "out");
  assert.equal(outgoing.length, 2);
  assert.deepEqual(outgoing[0].fields, ["7"]);
  assert.equal(outgoing[0].packetType, 0);
  console.log("PASS native 100 ms throttle: blocked calls are not counted as dispatches; builder target preserved");

  context.time = 1200;
  run("fixture.Upper.instance.upperRequest(7)"); // normal game UI shares cooldown
  context.time = 1210;
  assert.equal(api.fire(7), false);
  assert.equal(api.status().stats.fires, 3);
  context.time = 1300;
  run("fixture.Socket.instance.fail = true");
  assert.equal(api.fire(7), false);
  assert.equal(api.status().stats.fires, 3);
  assert.equal(api.status().stats.sendErrors, 1);
  run("fixture.Socket.instance.fail = false");
  console.log("PASS manual upper shares cooldown; socket exception produces no successful dispatch");

  // 30/09: our default skips the client 100 ms guard: every punch goes out, the
  // user own clicks in the game (upperRequest) too. The server gap is not ours.
  api.onHubMessage({ type: "no_throttle_config", enabled: true });
  {
    const before = run("fixture.Socket.instance.frames.length");
    const msgBefore = messages.length;
    context.time = 1400; run("fixture.Upper.instance.upperRequest(7)");
    context.time = 1410; run("fixture.Upper.instance.upperRequest(7)");
    context.time = 1420; assert.equal(api.fire(7), true, "engine click 20 ms after a manual one");
    assert.equal(run("fixture.Socket.instance.frames.length") - before, 2 + 8, "both game clicks + the engine burst (punch_config 8), all within 20 ms");
    assert.equal(api.status().noThrottle.enabled, true);
    assert.equal(api.status().noThrottle.installed, true);
    // the older tests below measure the native guard: back to it, clock as they left it
    api.onHubMessage({ type: "no_throttle_config", enabled: false });
    run("fixture.Upper.instance.lastUpperAt = 1300");
    run("fixture.Socket.instance.frames").splice(before);
    messages.splice(msgBefore); // the recorder and analyzer tests below count every message so far
  }
  console.log("PASS no local throttle: game clicks and engine clicks skip the client 100 ms guard");

  run(`{
    const resolve = new fixture.Packet(211);
    for (const v of [1, 1, 3, 10, 10, 1, 7, 11, 11]) resolve.appendParameter(v);
    fixture.Socket.instance.handleReceivedBytes(resolve.toByteArray());
    const room = new fixture.Packet(128, 120);
    fixture.Socket.instance.handleReceivedBytes(room.toByteArray());
    for (const [id, avatar] of [...fixture.Renderer.instance.avatars]) fixture.Renderer.instance.avatars.set(id, { ...avatar });
    const resync = new fixture.Packet(215);
    for (const v of [1, 100, 3, 0, 7, 120, 500]) resync.appendParameter(v);
    fixture.Socket.instance.handleReceivedBytes(resync.toByteArray());
  }`);
  const resolveEvent = messages.find((m) => m.type === "packet_event" && m.dir === "in" && m.opcode === 211);
  assert.equal(resolveEvent.fields.length, 9);
  assert.equal(messages.find((m) => m.type === "packet_event" && m.opcode === 128).packetType, 120);
  assert.equal(messages.filter((m) => m.type === "resolve_event").length, 1);
  assert.equal(messages.filter((m) => m.type === "diagnostic_event" && m.packet?.id === 215).length, 1);
  console.log("PASS raw opcode 128, all nine resolve fields, and passive 215 capture");

  // PULSE runs through the same observed-send result, including blocked attempts.
  // Per-fire metrics are off by default (the Hub no longer shows them).
  api.onHubMessage({ type: "timing_config", fireMetrics: true });
  context.time = 1400;
  api.onHubMessage({ type: "pulse_config", enabled: true, burst: 1 });
  context.time = 1410;
  api.onHubMessage({ type: "pulse_config", enabled: true, burst: 1 });
  const pulse = messages.filter((m) => m.type === "timing_metric" && m.mode === "PULSE");
  assert.equal(pulse.at(-2).ok, true);
  assert.equal(pulse.at(-1).ok, false);
  assert.equal(pulse.at(-1).sentCount, 0);
  api.onHubMessage({ type: "pulse_config", enabled: false });
  console.log("PASS PULSE metrics distinguish emitted and blocked attempts");

  // STEP must follow the Hub window. Packaged Hub builds send no `landing`.
  const armed = [];
  context.Blob = class {};
  context.URL = { createObjectURL: () => "blob:test" };
  context.Worker = class {
    constructor() { context.__worker = this; }
    postMessage(m) { if (m.type === "arm") armed.push(m); }
  };
  const walk = (mode, id, x, y) => run(`{
    const p = new fixture.Packet(182);
    for (const v of [${mode}, ${id}, ${x}, ${y}, 2, 600, 0]) p.appendParameter(v);
    fixture.Socket.instance.handleReceivedBytes(p.toByteArray());
  }`);
  context.time = 2000;
  // The room packet above retires its avatar objects. The new room supplies
  // fresh ones; automatic combat correctly ignores objects from the old room.
  run(`for (const [id, av] of fixture.Renderer.instance.avatars) {
    fixture.Renderer.instance.avatars.set(id, { ...av, position: { ...av.position }, avatarInfo: { ...av.avatarInfo } });
  }`);
  // The autonomous STEP window needs an actual contact at our destination;
  // a ficha alone must not force a window at an out-of-contact player.
  walk(1, 7, 11, 12);
  api.onHubMessage({
    type: "timing_config", enabled: true, source: "STEP", stepAnchor: "SELF",
    start: 100, end: 400, rate: 50, mult: 1, clicks: 0, gap: 1, profile: "LINEAR",
    power: false, stepScale: true, fireMetrics: true
  });
  assert.equal(api.status().timing.landing.enabled, false);
  walk(2, 1, 10, 11); // pet walk with a colliding id must not arm
  assert.equal(armed.length, 0);
  walk(1, 1, 10, 11);
  assert.equal(armed.length, 1);
  assert.equal(armed[0].window, "A");
  const delays = armed[0].fires.map((f) => Math.round(f.delayMs));
  assert.equal(delays[0], 80); // 100 on the 750 Hub scale -> 80 ms of a 600 ms step
  assert.equal(delays.at(-1), 320);
  const stepArm = messages.filter((m) => m.type === "timing_metric" && m.phase === "arm" && m.mode === "STEP").at(-1);
  assert.equal(stepArm.plannedMs, 80);
  api.onHubMessage({ type: "timing_config", enabled: true, source: "STEP", start: 100, end: 400, clicks: 100, gap: 1000 });
  assert.equal(api.status().timing.clicks, 100);
  assert.equal(api.status().timing.gap, 1000);
  api.onHubMessage({ type: "timing_config", enabled: false, source: "STEP" });
  walk(1, 7, 11, 11); // restore the rival pose for the following fixtures
  console.log("PASS STEP follows Hub window without landing field; pet walks ignored; Hub clamps match");

  const hubCore = require("../../electron/controller-core.cjs");

  // Separate direct check of the delay policy, including fractional/invalid RTT.
  vm.runInContext(section(original, "  function rttEstimateMs()", "  // Legacy predictive"), context);
  context.state = { serverPingMs: 5 };
  for (const [input, expected] of [[0.5, 0.5], [5, 5], [15, 15], [20, 20], [170, 170], [-1, 160], [0, 160], [NaN, 160]]) {
    context.state.serverPingMs = input;
    assert.equal(context.rttEstimateMs(), expected);
  }
  console.log("PASS low RTT respected; unknown/invalid RTT retains fallback");

  const { createDiagnosticRecorder } = require("../../electron/game/diagnostic-recorder.cjs");
  const tmp = path.join(root, "tmp");
  fs.mkdirSync(tmp, { recursive: true });
  const dir = fs.mkdtempSync(path.join(tmp, "hub-diagnostics-test-"));
  const recorder = createDiagnosticRecorder(dir, { enabled: true, onError: (e) => { throw e; } });
  assert.equal(recorder.record({ type: "diagnostic_event", event: "packet", packet: { id: 233, fields: ["private"] } }), false);
  for (const m of messages) recorder.record(m);
  await recorder.close();
  const rows = fs.readFileSync(recorder.file, "utf8").trim().split("\n").map(JSON.parse);
  assert.ok(rows.some((m) => m.event === "packet" && m.packet.id === 215));
  assert.ok(rows.some((m) => m.event === "fire_attempt" && m.sentCount === 0));
  assert.ok(!rows.some((m) => m.packet?.id === 233));
  const disabled = createDiagnosticRecorder(dir);
  assert.equal(disabled.record(rows[0]), false);
  await disabled.close();
  console.log("PASS optional recorder flushes combat evidence and excludes authentication traffic");
  const { analyze } = require("./analyze-diagnostics.cjs");
  const analysis = await analyze(recorder.file);
  assert.equal(analysis.observedOutgoing211, 4);
  assert.equal(analysis.resync215, 1);
  assert.equal(analysis.resyncSamples[0].elapsedMs, 120);
  assert.equal(analysis.resyncSamples[0].kind, 3);
  assert.equal(analysis.callErrors, 1);
  assert.ok(analysis.configChanges >= 3);
  console.log("PASS end-to-end capture analysis: sends, errors, config changes and decoded animation age");

  // Orientation must match the client's moveUser rule for every step direction.
  const clientOrient = new Function("c", "o",
    "const e = { z: 0 };\n" +
    section(official, '    if (c !== 0 || o !== 0) {', '    if (W["instance"]?.["instantCatchUp"]') +
    "return e.z;");
  vm.runInContext(section(original, "  function computeOrient(", "  function preFaceTarget("), context);
  for (const dx of [-1, 0, 1]) {
    for (const dy of [-1, 0, 1]) {
      assert.equal(context.computeOrient(10, 10, 10 + dx * 3, 10 + dy), clientOrient(dx, dy), `orient ${dx},${dy}`);
    }
  }
  assert.equal(context.computeOrient(10, 10, 9, 9), 2); // Ring contact on the left
  assert.equal(context.computeOrient(10, 10, 11, 11), 1); // Ring contact on the right
  console.log("PASS computeOrient matches the live client's moveUser facing table");

  // Scene: fallback equals the real mGame2 layout; the live room matrix wins once loaded.
  // Ring after the 22–23/09 update (117 tiles), read live on 23/09.
  const probe = require("./fixtures/ring-static.json");
  const parseRows = (rows) => rows.map((row) => String(row).split(",").map(Number));
  const ringStatic = parseRows(probe.static);
  const ringMap = ringStatic.map((row) => row.slice());
  ringMap[13][16] = 1; // avatars mark occupancy on top of the static layout
  ringMap[14][13] = 1;
  const scenes = () => messages.filter((m) => m.type === "scene_snapshot");
  const bootScene = scenes()[0];
  assert.equal(bootScene.sceneSource, "fallback_ring");
  assert.deepEqual(bootScene.matrix, ringStatic);
  assert.equal(bootScene.matrix.flat().filter((v) => v === 0).length, 117);
  assert.equal(bootScene.sceneHash, "794bf3d1"); // Hub RING_BOARD_SCENE_HASH / ring-board allowlist
  const tick = intervals.find((i) => i.ms === 100).fn;
  const ringModel = {
    name: "mGame2",
    escenario: { matrix: { rows: ringStatic.map((row, id) => ({ id, data: row.join(", ") })) } },
    map: ringMap.map((row) => row.slice())
  };
  run("fixture.Renderer.instance").spaceModel = ringModel;
  context.time += 6000;
  tick();
  const live = scenes().at(-1);
  assert.equal(live.sceneSource, "live_static");
  assert.equal(live.spaceName, "mGame2");
  assert.deepEqual(live.matrix, ringStatic);
  assert.deepEqual(live.occupancyMatrix, ringMap);
  assert.equal(live.sceneHash, bootScene.sceneHash);
  assert.ok(!("modelRef" in live) && !("baseHash" in live));
  assert.ok(live.blocked.every((p) => ringStatic[p.y][p.x] === 1));
  assert.equal(api.status().scene.source, "live_static");
  run("fixture.Renderer.instance").spaceModel = {
    name: "lobby",
    escenario: { matrix: { rows: [{ data: "1, 0" }, { data: "0, 0" }] } },
    map: [[1, 0], [0, 1]]
  };
  context.time += 6000;
  tick();
  const lobby = scenes().at(-1);
  assert.equal(lobby.spaceName, "lobby");
  assert.deepEqual(lobby.matrix, [[1, 0], [0, 0]]);
  assert.notEqual(lobby.sceneHash, live.sceneHash);
  console.log("PASS scene reads the live room matrix (official getStaticWalkMatrix); fallback is the real Ring");

  // TICK engine: grid from 182 batches, shots never aimed before T, blind then
  // reactive targeting, calibration from 144 phase, grid reset per room.
  // Like the game: a user's step (182, mode 1) also moves its avatar on screen.
  const inbound = (id, type, values) => run(`{
    const p = new fixture.Packet(${id}${type ? `, ${type}` : ""});
    for (const v of ${JSON.stringify(values)}) p.appendParameter(v);
    fixture.Socket.instance.handleReceivedBytes(p.toByteArray());
    const v = ${JSON.stringify(values)};
    // Like the client: a room load (128/120) drops the old avatars and adds new objects.
    if (${id} === 128 && ${type || 0} === 120) for (const [k, av] of [...fixture.Renderer.instance.avatars]) fixture.Renderer.instance.avatars.set(k, { ...av });
    if (${id} === 182 && Number(v[0]) === 1) {
      const av = fixture.Renderer.instance.avatars.get(Number(v[1]));
      if (av && av.position) { av.position.x = Number(v[2]); av.position.y = Number(v[3]); }
    }
  }`);
  run("fixture.Renderer.instance").spaceModel = ringModel;
  run("__testProviders.ping.instance.latency = 170");
  context.time += 6000;
  tick(); // refresh ping and the Ring scene cache
  assert.equal(api.status().serverPingMs, 170);
  inbound(128, 120, [2, 0, 0, 0, 1, 2, "Ring"]); // room load: fresh grid and actors
  assert.equal(api.status().tick.origin, null);
  api.onHubMessage({
    type: "timing_config", enabled: true, source: "STEP", start: 430, end: 750,
    tick: { enabled: true, auto: false, offsetMs: 10, shots: 9, spacingMs: 110, burst: 5, burstGapMs: 4, autoCal: true }
  });
  assert.equal(api.status().timing.tick.shots, 5); // Hub clamp 1..5
  api.onHubMessage({ type: "timing_config", tick: { shots: 4 } });
  const pump = intervals.filter((i) => i.ms === 8).at(-1).fn;
  const tickArms = () => armed.filter((m) => m.window === "TICK");
  // Pet walks still mark server ticks; batches arrive at 200 (mod 600) locally.
  for (const at of [20000, 20600, 21200]) {
    context.time = at;
    inbound(182, 0, [2, 50, 12, 12, 2, 600, 0]);
  }
  assert.equal(api.status().tick.origin, 200);
  context.time = 21250;
  pump();
  const plan = tickArms().at(-1);
  assert.equal(plan.planId, "TICK:36");
  // Local send = batch arrival + phase - RTT: a dense burst landing at
  // T+10..T+26, then T+120, +230, +340.
  assert.deepEqual(Array.from(plan.fires, (f) => Math.round(f.dueAt)), [21640, 21644, 21648, 21652, 21656, 21750, 21860, 21970]);
  assert.ok(plan.fires.every((f) => f.dueAt - (200 + 36 * 600 - 170) >= 0), "no shot aimed before T");
  pump();
  assert.equal(tickArms().length, 1, "one plan per tick");
  const fireTick = (index, at) => {
    context.time = at;
    context.__worker.onmessage({ data: { type: "fire", planId: plan.planId, index, dueAt: plan.fires[index].dueAt, seq: plan.seq, window: "TICK" } });
  };
  const framesBefore = run("fixture.Socket.instance.frames.length");
  fireTick(0, 21640); // batch 36 not received yet: blind at the fichado 7 (1 tile away)
  fireTick(1, 21644); // burst: 4 ms later, local 100 ms throttle bypassed, same fichado
  const sent211 = run("fixture.Socket.instance.frames").slice(framesBefore).map((fr) => fr.bytes);
  assert.equal(sent211.length, 2);
  assert.ok(sent211.every((b) => b[1] === 211 && b[4] === 55), "every burst request goes to fichado 7");
  assert.equal(api.status().tick.blind, 2);
  context.time = 21818; // one reply at T+18: it belongs to the first request (aimed at T+10)
  inbound(144, 0, []);
  assert.equal(api.status().tick.lastErrMs, 8);
  assert.equal(api.status().tick.corrMs, 2);
  fireTick(6, 21860); // batch 36 is due by now: reactive, real adjacency
  assert.equal(run("fixture.Socket.instance.frames.length"), framesBefore + 3);
  assert.equal(api.status().tick.reactive, 1);
  // The rival steps away (continuing route) and nobody is lateral any more.
  context.time = 21905;
  inbound(182, 0, [1, 7, 12, 11, 7, 600, 1]);
  fireTick(7, 21970);
  assert.equal(api.status().tick.lastSkip, "no_contact");
  assert.equal(run("fixture.Socket.instance.frames.length"), framesBefore + 3);
  // A 211 against us eliminates us: the engine stops; a new room resets it.
  context.time = 22000;
  inbound(211, 0, [1, 1, 7, 12, 11, 1, 1, 10, 10]);
  fireTick(5, 22010);
  assert.equal(api.status().tick.lastSkip, "eliminado"); // a hit on us eliminates
  context.time = 23700; // burst summary: 2 requests out, 1 reply
  assert.equal(api.status().tick.bursts, 1);
  assert.equal(api.status().tick.burstSentAvg, 2);
  assert.equal(api.status().tick.burstRepliesAvg, 1);
  inbound(128, 120, [2, 0, 0, 0, 1, 2, "Ring"]);
  assert.equal(api.status().tick.origin, null);
  // A full STEP config from an older Hub (no `tick`) falls back to windows.
  api.onHubMessage({ type: "timing_config", enabled: true, source: "STEP", start: 430, end: 750 });
  assert.equal(api.status().timing.tick.enabled, false);
  api.onHubMessage({ type: "timing_config", enabled: false, source: "STEP" });
  console.log("PASS TICK engine: tick grid, dense burst after T at the fichado, reactive check, 144 calibration, room reset");

  // TICK autotune: learns the contact switch B from ticks where the contact
  // with the fichado changed, and moves the margin with every race.
  const storage = new Map();
  context.localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k)
  };
  api.onHubMessage({
    type: "timing_config", enabled: true, source: "STEP", start: 430, end: 750,
    tick: { enabled: true, auto: true, shots: 1, burst: 1, burstGapMs: 4, autoCal: true }
  });
  api.onHubMessage({ type: "tick_auto_reset" }); // the room reset above judged the last race of that test
  assert.equal(api.status().tick.auto.enabled, true);
  assert.equal(api.status().tick.auto.aimMs, 10); // B 0 (duel lab) + margin floor 10
  const rivalAt = (at, x, y) => { context.time = at; inbound(182, 0, [1, 7, x, y, 2, 600, 0]); };
  const pumpAt = (at) => { context.time = at; pump(); };
  for (const at of [34800, 35400]) { context.time = at; inbound(182, 0, [2, 50, 12, 12, 2, 600, 0]); }
  rivalAt(36000, 13, 11); pumpAt(36045);   // tick 60: no contact
  rivalAt(36600, 11, 11);                  // tick 61: new lateral contact
  // Our request processed at T-5: before the switch. On the batch grid a 144's
  // phase is its landing (v6_61: v6_58 wrongly subtracted the RTT again).
  context.time = 36595; inbound(144, 0, []);
  pumpAt(36645);
  context.time = 36603; inbound(211, 0, [1, 1, 7, 11, 11, 1, 1, 10, 10]); // fichado hits us at T+3
  pumpAt(36935);                            // tick 61 classified: lost the race by landing early
  let auto = api.status().tick.auto;
  assert.equal(auto.races, 1);
  assert.equal(auto.early, 1);
  assert.equal(auto.marginMs, 10); // no click aimed at that tick: the aim learns nothing
  assert.equal(auto.rivalMedianMs, 3);
  context.time = 37190; inbound(211, 0, [1, 1, 1, 10, 10, 1, 7, 11, 11]); // our hit at T-10...
  rivalAt(37200, 13, 11); pumpAt(37245);   // ...then the contact is lost at tick 62
  rivalAt(37800, 11, 11); pumpAt(37845);   // tick 63: new contact again
  context.time = 37808; inbound(211, 0, [1, 1, 1, 10, 10, 1, 7, 11, 11]); // we hit first at T+8
  pumpAt(38145);
  auto = api.status().tick.auto;
  // 27/09: only the 144 at -5. A 211 phase is landing + hold, so our hits (-10,
  // +8, no click aimed at those ticks) and the rival hit (+3) are not samples.
  assert.equal(auto.samples, 1);
  assert.equal(auto.boundaryMs, 0);         // between -5 (rejected) and +3 (accepted): the prior 0 fits
  assert.equal(auto.wins, 1);
  assert.equal(auto.marginMs, 10);           // a win without the tick click does not move it
  assert.equal(auto.aimMs, 10);
  assert.equal(auto.recentWinRate, 50);
  // The next plan aims its first shot at T + aim.
  context.time = 38300;
  pump();
  const autoPlan = tickArms().at(-1);
  const n = Number(autoPlan.planId.split(":")[1]);
  const corr = api.status().tick.corrMs;
  assert.equal(Math.round(autoPlan.fires[0].dueAt + 170 + corr - n * 600), 10);
  // Learned values persist (localStorage, at most every 15 s) and a reset clears them.
  assert.equal(JSON.parse(storage.get("bbhub.tickAuto.v5")).samples.length, 1); // saved after the first race (only the 144 at -5)
  pumpAt(38300 + 15000);
  const saved = JSON.parse(storage.get("bbhub.tickAuto.v5"));
  assert.equal(saved.margin, 10);
  assert.equal(saved.samples.length, 1);
  api.onHubMessage({ type: "tick_auto_reset" });
  assert.equal(api.status().tick.auto.races, 0);
  assert.equal(api.status().tick.auto.aimMs, 10);
  assert.equal(storage.has("bbhub.tickAuto.v5"), false);
  // First shot early but a follow-up still wins: "rescued" pushes the margin
  // back. A stale 144 from the previous tick (T-260) is not an early aim.
  for (const at of [52800, 53400]) { context.time = at; inbound(182, 0, [2, 50, 12, 12, 2, 600, 0]); }
  rivalAt(54000, 13, 11); pumpAt(54045);   // tick 90: no contact
  rivalAt(54600, 11, 11);                  // tick 91: new contact
  context.time = 54596; inbound(144, 0, []); // first shot at T-4: early
  pumpAt(54645);
  context.time = 54716; inbound(211, 0, [1, 1, 1, 10, 10, 1, 7, 11, 11]); // follow-up hits at T+116
  pumpAt(54935);
  auto = api.status().tick.auto;
  assert.deepEqual([auto.races, auto.wins, auto.rescued, auto.marginMs], [1, 1, 1, 10]);
  rivalAt(55200, 13, 11); pumpAt(55245);   // tick 92: contact lost, no replies
  context.time = 55540; inbound(144, 0, []); // stale reject, T-260 of tick 93
  rivalAt(55800, 11, 11); pumpAt(55845);   // tick 93: new contact
  context.time = 55806; inbound(211, 0, [1, 1, 7, 11, 11, 1, 1, 10, 10]); // fichado first at T+6
  pumpAt(56135);
  auto = api.status().tick.auto;
  assert.deepEqual([auto.races, auto.late, auto.early, auto.marginMs], [2, 1, 0, 10]);
  // Manual mode keeps the Hub values.
  api.onHubMessage({ type: "timing_config", tick: { auto: false, offsetMs: 30 } });
  assert.equal(api.status().tick.auto.aimMs, 30);
  api.onHubMessage({ type: "timing_config", enabled: false, source: "STEP" });
  console.log("PASS TICK autotune: boundary from contact changes, races without the tick click leave the aim alone, persisted, reset");

  // EXIT: a burst at the end of our own coco (184/120), at the enemy closest
  // to us; engine shots are held meanwhile; the unlock phase is learned.
  run(`fixture.Renderer.instance.avatars.set(9, { position: { x: 12, y: 12, z: 1 }, avatarInfo: { id: 900, username: "Far" } })`);
  api.select(9); // fichado 2 tiles away; rival 7 is lateral (1 tile)
  const exitArms = () => armed.filter((m) => m.window === "EXIT");
  context.time = 59990;
  inbound(160, 126, []); // new round: the hits on us in the tests above eliminated us
  context.time = 60000;
  inbound(184, 120, [100, 35, 35]); // coco on us (account 100)
  inbound(184, 120, [700, 35, 35]); // and on the rival
  let ex = api.status().exit;
  assert.equal(ex.cocoActive, true);
  assert.equal(ex.cocoRemainingMs, 7000);
  const exitPlan = exitArms().at(-1);
  assert.equal(exitPlan.planId, "EXIT:67000");
  const exitBurst = exitPlan.fires.length - 2; // burst sized from sigma (3..8 requests) + 2 follow-ups
  assert.ok(exitBurst >= 3 && exitBurst <= 8);
  const exitLead = 170 + api.status().tick.corrMs;
  const exitPhases = exitPlan.fires.map((f) => Math.round(f.dueAt + exitLead - 67000));
  assert.ok(exitPhases[0] < 0 && exitPhases[exitBurst - 1] > 0, `burst straddles the unlock: ${exitPhases}`);
  const statePlayers = () => messages.filter((m) => m.type === "state").at(-1).players;
  context.time = 60100;
  tick();
  assert.equal(statePlayers().find((pl) => pl.id === 7).cocoMs, 6900);
  // An engine shot during our coco is held; a manual one is not.
  const held0 = api.status().stats.cocoHeld || 0;
  api.onHubMessage({ type: "pulse_config", enabled: true, burst: 1 });
  api.onHubMessage({ type: "pulse_config", enabled: false });
  assert.equal(api.status().stats.cocoHeld, held0 + 1);
  const framesExit = run("fixture.Socket.instance.frames.length");
  for (let i = 0; i < exitBurst; i++) {
    context.time = exitPlan.fires[i].dueAt;
    context.__worker.onmessage({ data: { type: "fire", planId: exitPlan.planId, index: i, dueAt: exitPlan.fires[i].dueAt, window: "EXIT" } });
  }
  const exitSent = run("fixture.Socket.instance.frames").slice(framesExit).map((fr) => fr.bytes);
  assert.equal(exitSent.length, exitBurst, "local throttle bypassed for the whole burst");
  assert.ok(exitSent.every((b) => b[1] === 211 && b[4] === 55), "burst at the closest enemy (7), not the far fichado (9)");
  context.time = 67002;
  inbound(184, 120, [100, 0, 0]); // coco ends on time
  context.time = 67004;
  inbound(211, 0, [1, 1, 1, 10, 10, 1, 7, 11, 11]); // processed at E+4: we hit first
  context.time = 67800;
  tick();
  ex = api.status().exit;
  assert.equal(ex.cocoActive, false);
  assert.deepEqual([ex.exits, ex.wins, ex.lost, ex.lastPhaseMs, ex.lastOutcome], [1, 1, 0, 4, "ganada"]);
  assert.ok(ex.samples >= 2); // requests clearly before E+4 were ignored, E+4 processed
  assert.ok(ex.unlockMs >= 0 && ex.unlockMs <= 4, `unlock learned near E+0..4: ${ex.unlockMs}`);
  api.onHubMessage({ type: "exit_config", enabled: false });
  assert.equal(api.status().exit.enabled, false);
  api.onHubMessage({ type: "exit_config", enabled: true });
  run("fixture.Renderer.instance.avatars").delete(9);
  api.select(7);
  console.log("PASS EXIT: coco end burst straddles the unlock, closest enemy, engine held during coco, unlock learned");

  // 02/10 (v6_62): single mode, the exit click picks like the tick engine. A
  // rival standing one step from contact (12,12: floor 0.03) beats the merely
  // closest one (11,9: beside us, two steps from any lateral tile).
  {
    api.onHubMessage({
      type: "timing_config", enabled: true, source: "STEP", landing: { enabled: false },
      tick: { enabled: true, auto: true, single: true, blind: true, reactive: true, autoCal: true, shots: 1, burst: 1 }
    });
    const avsX = run("fixture.Renderer.instance.avatars");
    const saved7x = avsX.get(7);
    avsX.delete(7);
    run(`fixture.Renderer.instance.avatars.set(60, { position: { x: 11, y: 9, z: 1 }, avatarInfo: { id: 6000, username: "Close" } })`);
    run(`fixture.Renderer.instance.avatars.set(61, { position: { x: 12, y: 12, z: 1 }, avatarInfo: { id: 6100, username: "Step" } })`);
    // On the 600 ms grid; the coco ends at 75634, so the 75600 tick falls between
    // the exit click (~75460) and its landing (~75650).
    context.time = 68400; inbound(182, 0, [1, 50, 20, 20, 2, 600, 0]);
    context.time = 68634; inbound(184, 120, [100, 35, 35]);
    const exitPlan2 = exitArms().at(-1);
    assert.equal(exitPlan2.fires.length, 1, "single mode: one exit click");
    const framesExit2 = run("fixture.Socket.instance.frames.length");
    context.time = exitPlan2.fires[0].dueAt;
    context.__worker.onmessage({ data: { type: "fire", planId: exitPlan2.planId, index: 0, dueAt: exitPlan2.fires[0].dueAt, window: "EXIT" } });
    const exit2 = Array.from(run("fixture.Socket.instance.frames").slice(framesExit2), (fr) => Array.from(fr.bytes)).filter((b) => b[1] === 211).map((b) => b.slice(4, 6));
    assert.deepEqual(exit2, [[54, 49]], "exit click at 61 (one step from contact), not at the closest (60)");
    context.time = 75636; inbound(184, 120, [100, 0, 0]);
    avsX.delete(60); avsX.delete(61);
    avsX.set(7, saved7x);
    api.onHubMessage({ type: "timing_config", enabled: false, source: "STEP" });
    console.log("PASS EXIT single: the exit click picks like the tick engine");
  }

  // 2-vs-1 without fichado: at the next tick rival 7 steps out of contact and
  // rival 22 walks in. TICK aims at 22 (the threat), and the punch exit fires
  // at 22 right after our 100 ms server lock.
  run(`fixture.Renderer.instance.avatars.set(22, { position: { x: 13, y: 13, z: 1 }, avatarInfo: { id: 2100, username: "Two" } })`);
  api.onHubMessage({
    type: "timing_config", enabled: true, source: "STEP", start: 430, end: 750,
    tick: { enabled: true, auto: false, offsetMs: 10, shots: 1, spacingMs: 110, burst: 1, burstGapMs: 4, blind: true, reactive: true, autoCal: true }
  });
  context.time = 70800;
  inbound(182, 0, [1, 7, 10, 11, 2, 600, 1]); // 7 steps (11,11) -> (10,11)
  inbound(182, 0, [1, 22, 13, 13, 2, 600, 1]); // 22 already walking towards us
  context.time = 71400;
  inbound(182, 0, [1, 7, 11, 11, 1, 600, 1]); // back to (11,11), still walking right: leaves at the next tick
  inbound(182, 0, [1, 22, 12, 12, 2, 600, 1]); // 22 walking down-left: enters (11,11) at the next tick
  context.time = 71450;
  pump();
  const threatPlan = tickArms().at(-1);
  assert.equal(threatPlan.planId, "TICK:120");
  const framesThreat = run("fixture.Socket.instance.frames.length");
  context.time = threatPlan.fires[0].dueAt;
  context.__worker.onmessage({ data: { type: "fire", planId: threatPlan.planId, index: 0, dueAt: threatPlan.fires[0].dueAt, seq: threatPlan.seq, window: "TICK" } });
  const threatSent = run("fixture.Socket.instance.frames").slice(framesThreat).map((fr) => fr.bytes);
  assert.equal(threatSent.length, 1);
  assert.deepEqual(Array.from(threatSent[0].slice(4, 6)), [50, 50], "TICK shot goes to 22, the one walking in");
  // The punch exit armed itself from that send: 100 ms lock + 3 / + 9 ms.
  const guard = armed.filter((m) => m.window === "GUARD").at(-1);
  assert.deepEqual(Array.from(guard.fires, (f) => Math.round(f.dueAt - threatPlan.fires[0].dueAt)), [103, 109]);
  context.time = guard.fires[0].dueAt;
  context.__worker.onmessage({ data: { type: "fire", planId: "GUARD", index: 0, dueAt: guard.fires[0].dueAt, window: "GUARD" } });
  const guardSent = run("fixture.Socket.instance.frames").slice(framesThreat + 1).map((fr) => fr.bytes);
  assert.equal(guardSent.length, 1);
  assert.deepEqual(Array.from(guardSent[0].slice(4, 6)), [50, 50], "punch exit also at 22");
  assert.equal(api.status().exit.guardFired, 1);
  // Nobody in or entering contact: the punch exit holds its fire.
  run("fixture.Renderer.instance.avatars").delete(22);
  context.time = 72300;
  inbound(182, 0, [1, 7, 14, 11, 1, 600, 0]);
  context.__worker.onmessage({ data: { type: "fire", planId: "GUARD", index: 1, dueAt: 72400, window: "GUARD" } });
  assert.equal(run("fixture.Socket.instance.frames.length"), framesThreat + 2);
  assert.equal(api.status().exit.guardSkipped >= 1, true);
  api.onHubMessage({ type: "timing_config", enabled: false, source: "STEP" });
  context.time = 72900;
  inbound(182, 0, [1, 7, 11, 11, 2, 600, 0]); // 7 back in place for the next tests
  console.log("PASS threat sensor: 2-vs-1 without fichado, TICK and punch exit hit the one walking in");

  // Instant reaction: the batch that puts a rival in lateral contact fires at
  // it right away (its first visible step: direction from orient); inside our
  // 100 ms server lock it waits for the lock to end, with a twin 6 ms later.
  const timers = [];
  const savedSetTimeout = context.setTimeout;
  context.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return 1; };
  const runTimers = () => { while (timers.length) timers.shift().fn(); };
  api.onHubMessage({
    type: "timing_config", enabled: true, source: "STEP", start: 430, end: 750,
    tick: { enabled: true, auto: true, shots: 1, burst: 1, burstGapMs: 4, blind: false, reactive: true, autoCal: true }
  });
  run(`fixture.Renderer.instance.avatars.set(23, { position: { x: 9, y: 9, z: 1 }, avatarInfo: { id: 2300, username: "In" } })`);
  run(`fixture.Renderer.instance.avatars.set(24, { position: { x: 12, y: 12, z: 1 }, avatarInfo: { id: 2400, username: "In2" } })`);
  const framesReact = run("fixture.Socket.instance.frames.length");
  context.time = 74400;
  inbound(182, 0, [1, 23, 9, 9, 1, 600, 0]); // first step we see: from (8,8), orient 1
  runTimers();
  let reactSent = Array.from(run("fixture.Socket.instance.frames").slice(framesReact), (fr) => Array.from(fr.bytes.slice(4, 6)));
  assert.deepEqual(reactSent, [[50, 51]], "fires at 23 the moment its step arrives");
  context.time = 74500;
  tick();
  assert.equal(messages.filter((m) => m.type === "state").at(-1).tick.reactFired, 1);
  // Inside the lock: a manual punch at 75000, a rival steps in at 75030.
  context.time = 75000;
  run("fixture.Renderer.instance.avatars").delete(23);
  api.fire(7);
  timers.length = 0;
  context.time = 75030;
  inbound(182, 0, [1, 24, 11, 11, 2, 600, 0]);
  const pendingFire = timers.shift(); // reactSchedule -> reactCheck
  pendingFire.fn();
  // v6_60: the batch also queues the tick preflight (0 ms); run it out of the way.
  for (let i = 0; i < timers.length; ) if (!timers[i].ms) timers.splice(i, 1)[0].fn(); else i++;
  assert.deepEqual(Array.from(timers, (x) => x.ms), [71, 77], "waits for the lock: 75000 + 101 and + 107");
  const framesLock = run("fixture.Socket.instance.frames.length");
  context.time = 75101;
  timers.shift().fn();
  reactSent = Array.from(run("fixture.Socket.instance.frames").slice(framesLock), (fr) => Array.from(fr.bytes.slice(4, 6)));
  assert.deepEqual(reactSent, [[50, 52]], "then at 24");
  timers.length = 0;
  context.setTimeout = savedSetTimeout;
  run("fixture.Renderer.instance.avatars").delete(24);
  api.onHubMessage({ type: "timing_config", enabled: false, source: "STEP" });
  console.log("PASS instant reaction: fires on the batch that brings contact, waits for the 100 ms lock when needed");

  // 01/10 (v6_60): the preflight decides when the batch settles; a walk of ours
  // sent after that must redo it. We stand at (10,10) with 31 lateral at (9,9);
  // after the batch we step to (11,11), next to 30 standing at (12,12). The
  // click has to go to 30, not to the stale pick (31).
  {
    const timers3 = [];
    const savedSetTimeout3 = context.setTimeout;
    context.setTimeout = (fn) => { timers3.push(fn); return 1; };
    const flush3 = () => { while (timers3.length) timers3.shift()(); };
    const walk3 = (x, y) => run(`{ const p = new fixture.Packet(182); p.appendParameter("${String(x).padStart(2, "0")}${String(y).padStart(2, "0")}4"); p.appendParameter(""); fixture.Socket.instance.sendServerMessage(p); }`);
    api.onHubMessage({
      type: "timing_config", enabled: true, source: "STEP", landing: { enabled: false },
      tick: { enabled: true, auto: true, single: true, blind: true, reactive: true, autoCal: true, shots: 1, burst: 1 }
    });
    run(`fixture.Renderer.instance.avatars.set(30, { position: { x: 12, y: 12, z: 1 }, avatarInfo: { id: 3000, username: "Still" } })`);
    run(`fixture.Renderer.instance.avatars.set(31, { position: { x: 9, y: 9, z: 1 }, avatarInfo: { id: 3100, username: "Old" } })`);
    context.time = 76200; inbound(182, 0, [1, 7, 14, 11, 5, 600, 0]); inbound(182, 0, [1, 1, 10, 10, 1, 600, 1]);
    context.time = 76205; pump();
    const arm3 = tickArms().at(-1);
    flush3(); // preflight with us at (10,10): 31 is the pick
    context.time = 76210; walk3(11, 11);
    flush3();
    const frames3 = run("fixture.Socket.instance.frames.length");
    context.time = arm3.fires[0].dueAt;
    context.__worker.onmessage({ data: { type: "fire", planId: arm3.planId, index: 0, dueAt: arm3.fires[0].dueAt, seq: arm3.seq, window: "TICK" } });
    const sent3 = Array.from(run("fixture.Socket.instance.frames").slice(frames3), (fr) => Array.from(fr.bytes)).filter((b) => b[1] === 211).map((b) => b.slice(4, 6));
    assert.deepEqual(sent3, [[51, 48]], "our walk after the preflight re-decides: the click goes to 30");
    context.setTimeout = savedSetTimeout3;
    run("fixture.Renderer.instance.avatars").delete(30);
    run("fixture.Renderer.instance.avatars").delete(31);
    context.time = 76800;
    inbound(182, 0, [1, 1, 11, 11, 2, 600, 0]);
    context.time = 76801; inbound(182, 0, [1, 1, 10, 10, 2, 600, 0]);
    api.onHubMessage({ type: "timing_config", enabled: false, source: "STEP" });
    console.log("PASS preflight fresh: a walk of ours after the batch redoes the tick decision");
  }

  // SINGLE CLICK (the Hub's only mode): one click per tick at the learned
  // phase, at whoever will be lateral, counting our own step exactly: the
  // server applies a walk at the first tick after receiving it.
  const timers2 = [];
  const savedSetTimeout2 = context.setTimeout;
  context.setTimeout = (fn, ms) => { timers2.push({ fn, ms }); return 1; };
  const walkTo = (x, y) => run(`{
    const p = new fixture.Packet(182);
    p.appendParameter("${String(x).padStart(2, "0")}${String(y).padStart(2, "0")}4");
    p.appendParameter("");
    fixture.Socket.instance.sendServerMessage(p);
  }`);
  api.onHubMessage({
    type: "timing_config", enabled: true, source: "STEP", landing: { enabled: false },
    tick: { enabled: true, auto: true, single: true, blind: true, reactive: true, autoCal: true, shots: 1, burst: 1 }
  });
  run(`fixture.Renderer.instance.avatars.set(30, { position: { x: 12, y: 12, z: 1 }, avatarInfo: { id: 3000, username: "Still" } })`);
  context.time = 77400; inbound(182, 0, [1, 7, 14, 11, 5, 600, 0]); // 7 out of the way
  context.time = 78000; inbound(182, 0, [2, 50, 12, 12, 2, 600, 0]);
  context.time = 78010;
  walkTo(11, 11); // early in the tick: we step at 78600, next to 30 (standing)
  context.time = 78050;
  pump();
  const single1 = tickArms().at(-1);
  assert.equal(single1.planId, "TICK:131");
  assert.equal(single1.fires.length, 2, "one click per tick, plus the sweep after the server gap");
  assert.ok(single1.fires[1].dueAt - single1.fires[0].dueAt >= 104, "the sweep lands after the 100 ms gap");
  assert.equal(Math.round(single1.fires[0].delayMs), Math.round(single1.fires[0].dueAt - 78050 - 12), "woken 12 ms early, then spins to the exact moment");
  const framesSingle = run("fixture.Socket.instance.frames.length");
  context.time = single1.fires[0].dueAt;
  context.__worker.onmessage({ data: { type: "fire", planId: single1.planId, index: 0, dueAt: single1.fires[0].dueAt, seq: single1.seq, window: "TICK" } });
  const singleFrames = Array.from(run("fixture.Socket.instance.frames").slice(framesSingle), (fr) => Array.from(fr.bytes));
  assert.deepEqual(singleFrames.map((b) => b[1]), [211], "the click alone (no turn: facing does not matter)");
  let singleSent = singleFrames.filter((b) => b[1] === 211).map((b) => b.slice(4, 6));
  assert.deepEqual(singleSent, [[51, 48]], "the click goes to 30, lateral once our step lands");
  // The batch confirms contact, not the earlier blind request's success.
  // No hit/reject replied: react at the same rival after the server gap.
  context.time = 78600;
  inbound(182, 0, [1, 1, 11, 11, 1, 600, 0]);
  while (timers2.length) timers2.shift().fn();
  assert.equal(run("fixture.Socket.instance.frames.length"), framesSingle + 2);
  assert.ok(run("fixture.Socket.instance.frames").at(-1).at - run("fixture.Socket.instance.frames")[framesSingle].at >= 100, "confirmed contact fallback respects the request gap");
  // A walk sent too late for tick 133 (it reaches the server after it) must
  // not count: at 79800 we are still next to 30.
  context.time = 79150;
  pump();
  const single2 = tickArms().at(-1);
  assert.equal(single2.planId, "TICK:133");
  context.time = single2.fires[0].dueAt - 5;
  walkTo(10, 10);
  context.time = single2.fires[0].dueAt;
  context.__worker.onmessage({ data: { type: "fire", planId: single2.planId, index: 0, dueAt: single2.fires[0].dueAt, seq: single2.seq, window: "TICK" } });
  singleSent = Array.from(run("fixture.Socket.instance.frames").slice(framesSingle + 3), (fr) => Array.from(fr.bytes)).filter((b) => b[1] === 211).map((b) => b.slice(4, 6));
  assert.deepEqual(singleSent, [[51, 48]], "late walk: still lateral to 30 at that tick");
  timers2.length = 0;
  context.setTimeout = savedSetTimeout2;
  run("fixture.Renderer.instance.avatars").delete(30);
  context.time = 80400;
  inbound(182, 0, [1, 1, 10, 10, 2, 600, 0]);
  inbound(182, 0, [1, 7, 11, 11, 8, 600, 0]);
  api.onHubMessage({ type: "timing_config", enabled: false, source: "STEP" });
  console.log("PASS single click: tick prediction plus contact fallback after the gap, late walks handled");


  // Our tick click wins the race: the margin tightens (and only then).
  api.onHubMessage({
    type: "timing_config", enabled: true, source: "STEP", landing: { enabled: false },
    tick: { enabled: true, auto: true, single: true, blind: true, reactive: true, autoCal: true, shots: 1, burst: 1 }
  });
  run(`fixture.Renderer.instance.avatars.set(31, { position: { x: 12, y: 12, z: 1 }, avatarInfo: { id: 3100, username: "Aim" } })`);
  api.onHubMessage({ type: "tick_auto_test", margin: 14 });
  const margin0 = api.status().tick.auto.marginMs;
  context.time = 81000; inbound(182, 0, [2, 50, 12, 12, 2, 600, 0]);
  context.time = 81010; walkTo(11, 11);
  context.time = 81050; pump();
  const aimPlan = tickArms().at(-1);
  const aimTick = Number(aimPlan.planId.split(":")[1]);
  context.time = aimPlan.fires[0].dueAt;
  context.__worker.onmessage({ data: { type: "fire", planId: aimPlan.planId, index: 0, dueAt: aimPlan.fires[0].dueAt, seq: aimPlan.seq, window: "TICK" } });
  const T = aimTick * 600;
  context.time = T; inbound(182, 0, [1, 1, 11, 11, 1, 600, 0]); // our step: contact with 31
  const aimLanding = api.status().tick.auto.aimMs;
  const corrBeforeHit = api.status().tick.corrMs;
  const sigmaBeforeHit = api.status().tick.auto.sigmaMs;
  context.time = T + aimLanding + 45; inbound(211, 0, [1, 1, 1, 11, 11, 1, 31, 12, 12]); // our click wins (held 45 ms, as the server does)
  assert.equal(api.status().tick.corrMs, corrBeforeHit, "a held hit does not move the landing calibration");
  assert.equal(api.status().tick.auto.sigmaMs, sigmaBeforeHit, "nor the jitter");
  context.time = T + 340; pump();
  assert.equal(api.status().tick.auto.marginMs, margin0 - 1, "the tick click won: tighten by 1 ms");
  // That 211 eliminated 31: no click goes to it any more, even if it walks
  // around as a spectator.
  context.time = T + aimLanding + 1; inbound(160, 130, [5, 0, "Ring"]);
  context.time = T + 300; inbound(182, 0, [1, 31, 12, 12, 2, 600, 0]);
  const framesOut = run("fixture.Socket.instance.frames.length");
  context.time = T + 450; pump();
  const outPlan = tickArms().at(-1);
  context.time = outPlan.fires[0].dueAt;
  context.__worker.onmessage({ data: { type: "fire", planId: outPlan.planId, index: 0, dueAt: outPlan.fires[0].dueAt, seq: outPlan.seq, window: "TICK" } });
  assert.equal(run("fixture.Socket.instance.frames.length"), framesOut, "no click at an eliminated player");
  // We get eliminated: every engine click is held until the round ends.
  run(`fixture.Renderer.instance.avatars.set(32, { position: { x: 12, y: 12, z: 1 }, avatarInfo: { id: 3200, username: "Killer" } })`);
  context.time = T + 1300; inbound(211, 0, [1, 1, 32, 12, 12, 1, 1, 11, 11]);
  context.time = T + 1301; inbound(160, 130, [4, 0, "Ring"]);
  assert.equal(api.fire(32), true, "manual clicks still go out");
  context.time = T + 1500;
  api.onHubMessage({ type: "pulse_config", enabled: true, burst: 1 });
  api.onHubMessage({ type: "pulse_config", enabled: false });
  assert.ok(api.status().stats.outHeld >= 1, "engine click held while we are out");
  context.time = T + 2400; inbound(182, 0, [1, 1, 10, 10, 2, 600, 0]); // walking as a spectator
  context.time = T + 2450;
  api.onHubMessage({ type: "pulse_config", enabled: true, burst: 1 });
  api.onHubMessage({ type: "pulse_config", enabled: false });
  assert.ok(api.status().stats.outHeld >= 2, "still out while spectating");
  context.time = T + 2500; inbound(160, 126, []); // round over: everyone back in play
  // Island: the eliminated player leaves the room and comes back in.
  run("fixture.Renderer.instance.spaceModel.name = 'isla'");
  assert.equal(api.status().tick.selfOut, false, "round over: we are back in play");
  context.time = T + 2600; inbound(211, 0, [1, 1, 1, 10, 10, 1, 32, 12, 12]);
  assert.ok(api.status().tick.eliminated.includes(32));
  const avatars32 = run("fixture.Renderer.instance.avatars");
  const saved32 = avatars32.get(32);
  avatars32.delete(32); // thrown out of the island
  context.time = T + 2700; tick();
  assert.ok(api.status().tick.eliminated.includes(32), "still out while away");
  avatars32.set(32, saved32); // walks back in
  context.time = T + 2800; tick();
  assert.ok(!api.status().tick.eliminated.includes(32), "back in play after re-entering");
  run("fixture.Renderer.instance.spaceModel.name = 'mGame2'");
  api.onHubMessage({ type: "timing_config", enabled: false, source: "STEP" });
  run("fixture.Renderer.instance.avatars").delete(31);
  run("fixture.Renderer.instance.avatars").delete(32);
  console.log("PASS eliminations and aim: a won tick click tightens the aim; a hit eliminates (spectator until the round ends, island players back when they re-enter)");

  // Any room: islands and areas have punch events too. A 211 there is not
  // followed by 160/130, so nobody is marked out and the rival stays a target.
  run("fixture.Renderer.instance").spaceModel = { name: "isla", escenario: { matrix: { rows: [{ data: "0, 0" }] } }, map: [[0, 0]] };
  const firesIsland = api.status().stats.fires;
  // A fresh time base for the tests below.
  const T2 = T + 20000;
  context.time = T2;
  api.onHubMessage({ type: "pulse_config", enabled: true, burst: 1 });
  api.onHubMessage({ type: "pulse_config", enabled: false });
  assert.equal(api.status().stats.fires, firesIsland + 1, "engines click outside the Ring too");
  run("fixture.Renderer.instance").spaceModel = ringModel;
  console.log("PASS any room: engines also click in islands and areas");

  // A target the server never answers (no 144, no 211) is muted after three
  // engine clicks, so the engine stops wasting clicks on it.
  api.select(7);
  for (let i = 0; i < 3; i++) {
    context.time = T2 + 1000 + i * 150;
    api.onHubMessage({ type: "pulse_config", enabled: true, burst: 1 });
    api.onHubMessage({ type: "pulse_config", enabled: false });
  }
  context.time = T2 + 2000;
  tick();
  assert.ok(api.status().tick.muted.includes(7), "silent target muted");
  context.time = T2 + 2050;
  inbound(144, 0, []); // an answer now does not unmute it early
  context.time = T2 + 11000;
  tick();
  assert.ok(!api.status().tick.muted.includes(7), "unmuted after 8 s");
  console.log("PASS silent targets: three unanswered engine clicks mute a target for 8 s");

  // 29/09 (cryptic vs iBjorn): a click right after a reply falls in the server gap and
  // says nothing; in the Ring a mute lasts 1.8 s, not 8 s.
  {
    const T3 = T2 + 20000;
    context.time = T3 - 500; // an answered click: clears what the tests above left counted
    api.onHubMessage({ type: "pulse_config", enabled: true, burst: 1 });
    api.onHubMessage({ type: "pulse_config", enabled: false });
    context.time = T3; inbound(144, 0, []);
    for (const dt of [20, 200, 400]) {
      context.time = T3 + dt;
      api.onHubMessage({ type: "pulse_config", enabled: true, burst: 1 });
      api.onHubMessage({ type: "pulse_config", enabled: false });
    }
    context.time = T3 + 1000; tick();
    assert.ok(!api.status().tick.muted.includes(7), "the click in the gap after a reply is not a silence");
    context.time = T3 + 600;
    api.onHubMessage({ type: "pulse_config", enabled: true, burst: 1 });
    api.onHubMessage({ type: "pulse_config", enabled: false });
    context.time = T3 + 1500; tick();
    assert.ok(api.status().tick.muted.includes(7), "three real silences mute");
    context.time = T3 + 3400; tick();
    assert.ok(!api.status().tick.muted.includes(7), "in the Ring the mute ends after 1.8 s");
  }
  console.log("PASS silent gap: clicks inside the server gap do not count; Ring mute 1.8 s");

  // Held hits resolve in landing order: a rival 211 while our aimed click
  // drew no 144 means the rival landed first, even if its 211 comes at T+83.
  const saved7 = run("fixture.Renderer.instance.avatars").get(7);
  run("fixture.Renderer.instance.avatars").delete(7);
  run(`fixture.Renderer.instance.avatars.set(33, { position: { x: 13, y: 13, z: 1 }, avatarInfo: { id: 3300, username: "Fast" } })`);
  api.onHubMessage({
    type: "timing_config", enabled: true, source: "STEP", landing: { enabled: false },
    tick: { enabled: true, auto: true, single: true, blind: true, reactive: true, autoCal: true, shots: 1, burst: 1 }
  });
  api.onHubMessage({ type: "tick_auto_test", margin: 14 });
  const marginLoss0 = api.status().tick.auto.marginMs;
  context.time = T2 + 12400; inbound(182, 0, [1, 33, 12, 12, 2, 600, 1]); // walking at us
  context.time = T2 + 12450; pump();
  const lossPlan = tickArms().at(-1);
  const lossTick = Number(lossPlan.planId.split(":")[1]);
  const framesLoss = run("fixture.Socket.instance.frames.length");
  context.time = lossPlan.fires[0].dueAt;
  context.__worker.onmessage({ data: { type: "fire", planId: lossPlan.planId, index: 0, dueAt: lossPlan.fires[0].dueAt, seq: lossPlan.seq, window: "TICK" } });
  const lossSent = Array.from(run("fixture.Socket.instance.frames").slice(framesLoss), (fr) => Array.from(fr.bytes)).filter((b) => b[1] === 211).map((b) => b.slice(4, 6));
  assert.deepEqual(lossSent, [[51, 51]], "the click goes to 33, walking into contact");
  const T3 = lossTick * 600;
  context.time = T3; inbound(182, 0, [1, 33, 11, 11, 2, 600, 0]); // 33 steps next to us
  context.time = T3 + 83; inbound(211, 0, [1, 1, 33, 11, 11, 1, 1, 10, 10]); // and wins: no 144 for us
  context.time = T3 + 90; inbound(160, 126, []); // the round ends at once: judged before the reset
  const marginLoss1 = api.status().tick.auto.marginMs;
  assert.ok(marginLoss1 < marginLoss0 && marginLoss1 >= marginLoss0 - 3, "our click was valid but later: aim earlier (down to the floor)");
  run("fixture.Renderer.instance.avatars").delete(33);
  run("fixture.Renderer.instance.avatars").set(7, saved7);
  api.onHubMessage({ type: "timing_config", enabled: false, source: "STEP" });
  console.log("PASS held hits: a rival 211 over our valid (no 144) aimed click tightens the aim");

  // Post-hit lock: after our hit the server ignores our punches for ~13.8 s.
  // No engine click meanwhile (nothing to mute), one click lands the moment
  // it ends, and a rival in its own punch animation is not a target.
  // (lock chosen so that a server tick falls between the unlock click and its landing)
  const HIT_LOCK = 14150;
  api.onHubMessage({ type: "hit_lock_config", ms: HIT_LOCK });
  api.onHubMessage({
    type: "timing_config", enabled: true, source: "STEP", landing: { enabled: false },
    tick: { enabled: true, auto: true, single: true, blind: true, reactive: true, autoCal: true, shots: 1, burst: 1 }
  });
  const avs = run("fixture.Renderer.instance.avatars");
  const saved7b = avs.get(7);
  avs.delete(7);
  run(`fixture.Renderer.instance.avatars.set(34, { position: { x: 11, y: 11, z: 1 }, avatarInfo: { id: 3400, username: "Victim" } })`);
  const TL = T2 + 30000;
  context.time = TL; inbound(182, 0, [1, 50, 20, 20, 2, 600, 0]); // grid
  context.time = TL + 100;
  assert.equal(api.fire(34), true); // our (manual) click
  context.time = TL + 300; inbound(211, 0, [1, 1, 1, 10, 10, 1, 34, 11, 11]); // it hits
  const lockEnd = TL + 300 + HIT_LOCK;
  // 28/09: an aim change (timing_config) during our lock clears the worker; the
  // unlock click must be armed again (with the new seq), not lost.
  const unlockArmsBefore = armed.filter((m) => m.window === "UNLOCK").length;
  api.onHubMessage({
    type: "timing_config", enabled: true, source: "STEP", landing: { enabled: false },
    tick: { enabled: true, auto: true, single: true, blind: true, reactive: true, autoCal: true, shots: 1, burst: 1 }
  });
  assert.ok(armed.filter((m) => m.window === "UNLOCK").length > unlockArmsBefore, "unlock re-armed after a config change during our lock");
  assert.ok(Math.abs(api.status().tick.lockMs - (HIT_LOCK - 170 - api.status().tick.corrMs)) <= 2, "lock from the 211 that ended it");
  const unlockPlan = armed.filter((m) => m.window === "UNLOCK").at(-1);
  assert.ok(unlockPlan, "unlock click armed");
  assert.ok(Math.abs(unlockPlan.fires[0].dueAt + 170 + api.status().tick.corrMs - (lockEnd + 10)) <= 1, "lands 10 ms after the lock ends");
  avs.delete(34); // thrown out
  run(`fixture.Renderer.instance.avatars.set(36, { position: { x: 12, y: 12, z: 1 }, avatarInfo: { id: 3600, username: "Free" } })`);
  run(`fixture.Renderer.instance.avatars.set(35, { position: { x: 9, y: 9, z: 1 }, avatarInfo: { id: 3500, username: "Busy" } })`);
  context.time = TL + 600; inbound(182, 0, [1, 50, 20, 21, 2, 600, 0]);
  context.time = TL + 1000; inbound(211, 0, [1, 1, 35, 9, 9, 1, 60, 8, 8]); // 35 hits someone: its own lock
  // Engine clicks inside our lock: none go out.
  const framesHitLock = run("fixture.Socket.instance.frames.length");
  context.time = TL + 1050; pump();
  const lockTick = tickArms().at(-1);
  context.time = lockTick.fires[0].dueAt;
  context.__worker.onmessage({ data: { type: "fire", planId: lockTick.planId, index: 0, dueAt: lockTick.fires[0].dueAt, seq: lockTick.seq, window: "TICK" } });
  assert.equal(run("fixture.Socket.instance.frames.length"), framesHitLock, "no click during our lock");
  assert.equal(api.status().tick.lastSkip, "traba");
  // 36 steps next to us 0.7 s before the unlock, to ambush us: the July model
  // says such a rival usually leaves (P 0.04), but it waits, so it gets the click.
  context.time = unlockPlan.fires[0].dueAt - 3000;
  inbound(184, 120, [3600, 35, 35]);
  context.time = TL + Math.floor((unlockPlan.fires[0].dueAt - 700 - TL) / 600) * 600; // on the tick grid
  inbound(182, 0, [1, 36, 11, 11, 2, 600, 0]);
  // Coco guard (27/09): armed with our hit, it lands before the lock ends (v6_53:
  // 60 ms, was 300); 36 is waiting next to us but already in a coco: no coco at it.
  const guardPlan = armed.filter((m) => m.window === "CGUARD").at(-1);
  assert.ok(guardPlan, "coco guard armed with our hit");
  assert.ok(Math.abs(guardPlan.fires[0].dueAt + 170 + api.status().tick.corrMs - (lockEnd - 60)) <= 1, "coco lands 60 ms before our lock ends");
  const framesGuard0 = run("fixture.Socket.instance.frames.length");
  context.time = guardPlan.fires[0].dueAt;
  context.__worker.onmessage({ data: { type: "fire", planId: guardPlan.planId, index: 0, dueAt: guardPlan.fires[0].dueAt, seq: guardPlan.seq, window: "CGUARD" } });
  assert.equal(run("fixture.Socket.instance.frames.length"), framesGuard0, "no coco at a rival already in coco");
  assert.equal(messages.filter((m) => m.type === "diagnostic_event" && m.event === "coco_guard").at(-1).why, "nadie_pegado");
  // Lock over, but 36 is stunned by a coco: nobody hittable, no click.
  context.time = unlockPlan.fires[0].dueAt;
  context.__worker.onmessage({ data: { type: "fire", planId: unlockPlan.planId, index: 0, dueAt: unlockPlan.fires[0].dueAt, seq: unlockPlan.seq, window: "UNLOCK" } });
  assert.equal(run("fixture.Socket.instance.frames.length"), framesHitLock, "no click at a rival in coco");
  assert.equal(api.status().tick.unlock.noTarget, 1);
  inbound(184, 120, [3600, 0, 0]); // its coco ends
  // Now: one click at the rival that can be hit (36), not 35 (in its animation).
  // The ping went down 4 ms since the unlock was armed (26/09 live: the lock
  // guard then dropped the click): it still goes out.
  run("__testProviders.ping.instance.latency = 166");
  api.onHubMessage({ type: "select_target", targetId: 7 }); // refreshes the ping (166)
  context.__worker.onmessage({ data: { type: "fire", planId: unlockPlan.planId, index: 0, dueAt: unlockPlan.fires[0].dueAt, seq: unlockPlan.seq, window: "UNLOCK" } });
  run("__testProviders.ping.instance.latency = 170");
  api.onHubMessage({ type: "select_target", targetId: 7 });
  const unlockSent = Array.from(run("fixture.Socket.instance.frames").slice(framesHitLock), (fr) => Array.from(fr.bytes));
  assert.deepEqual(unlockSent.map((b) => b[1]), [211], "turn, then one click");
  assert.deepEqual(unlockSent[0].slice(4, 6), [51, 54], "at 36, which can punch us");
  assert.equal(api.status().tick.unlock.fired, 1);
  // 27/09: a second click 30 ms later covers a first one the lock ignored (if the
  // first was processed, the server's 100 ms gap drops it).
  // v6_53: a third rung at +210 (live, the first two landed inside the true lock).
  assert.equal(unlockPlan.fires.length, 3, "unlock arms two retries");
  assert.equal(Math.round(unlockPlan.fires[1].dueAt - unlockPlan.fires[0].dueAt), 105, "retry 105 ms after the first");
  assert.equal(Math.round(unlockPlan.fires[2].dueAt - unlockPlan.fires[0].dueAt), 210, "third rung at +210");
  api.onHubMessage({ type: "tick_burst_config", count: 5 }); // engine bursts on: the unlock still goes out alone
  const framesRetry = run("fixture.Socket.instance.frames.length");
  context.time = unlockPlan.fires[1].dueAt;
  context.__worker.onmessage({ data: { type: "fire", planId: unlockPlan.planId, index: 1, dueAt: unlockPlan.fires[1].dueAt, seq: unlockPlan.seq, window: "UNLOCK" } });
  const retrySent = Array.from(run("fixture.Socket.instance.frames").slice(framesRetry), (fr) => Array.from(fr.bytes)).filter((b) => b[1] === 211);
  assert.equal(retrySent.length, 1, "retry goes out as one request, not a burst");
  api.onHubMessage({ type: "tick_burst_config", count: 1 });
  assert.deepEqual(retrySent[0].slice(4, 6), [51, 54], "retry at the same rival (36)");
  assert.equal(api.status().tick.unlock.fired, 2);
  avs.delete(35);
  avs.delete(36);
  avs.set(7, saved7b);
  api.onHubMessage({ type: "timing_config", enabled: false, source: "STEP" });
  api.onHubMessage({ type: "hit_lock_config", ms: 0 });
  console.log("PASS punch animation: no clicks for 13.76 s after our hit, one click as it ends, animating rivals skipped");


  // Our step is a guess too: with a walk pending, a rival that can reach the
  // tile next to where we stand now still gets the click (25/09 live miss).
  api.onHubMessage({
    type: "timing_config", enabled: true, source: "STEP", landing: { enabled: false },
    tick: { enabled: true, auto: true, single: true, blind: true, reactive: true, autoCal: true, shots: 1, burst: 1 }
  });
  const saved7c = avs.get(7);
  avs.delete(7);
  run(`fixture.Renderer.instance.avatars.set(37, { position: { x: 8, y: 9, z: 1 }, avatarInfo: { id: 3700, username: "Sneak" } })`);
  const TS = TL + 20000;
  context.time = TS; inbound(182, 0, [1, 37, 8, 8, 6, 600, 1]); // (8,9) -> (8,8): 2 tiles off where we stand
  context.time = TS + 10; walkTo(12, 10); // we mean to step to (11,10), 3 tiles from it
  context.time = TS + 50; pump();
  const spotPlan = tickArms().at(-1);
  const framesSpot = run("fixture.Socket.instance.frames.length");
  context.time = spotPlan.fires[0].dueAt;
  context.__worker.onmessage({ data: { type: "fire", planId: spotPlan.planId, index: 0, dueAt: spotPlan.fires[0].dueAt, seq: spotPlan.seq, window: "TICK" } });
  const spotSent = Array.from(run("fixture.Socket.instance.frames").slice(framesSpot), (fr) => Array.from(fr.bytes)).filter((b) => b[1] === 211).map((b) => b.slice(4, 6));
  assert.deepEqual(spotSent, [[51, 55]], "the click covers the rival next to where we stand");
  avs.delete(37);
  avs.set(7, saved7c);
  api.onHubMessage({ type: "timing_config", enabled: false, source: "STEP" });
  console.log("PASS both tiles: with a walk pending, a rival next to where we stand is covered too");

  // The server drops a walk request sent < 100 ms after the one it kept (26/09
  // live, ring-board sending pairs 15-35 ms apart): our step is the first of
  // the pair, so a rival walking in next to that tile gets the click.
  api.onHubMessage({
    type: "timing_config", enabled: true, source: "STEP", landing: { enabled: false },
    tick: { enabled: true, auto: true, single: true, blind: true, reactive: true, autoCal: true, shots: 1, burst: 1 }
  });
  const saved7w = avs.get(7);
  avs.delete(7);
  run(`fixture.Renderer.instance.avatars.set(46, { position: { x: 14, y: 14, z: 1 }, avatarInfo: { id: 4600, username: "Walker" } })`);
  const TW = TS + 10000;
  context.time = TW; inbound(182, 0, [1, 46, 13, 13, 2, 600, 1]); // (14,14) -> (13,13), towards us
  context.time = TW + 10; walkTo(11, 11); // kept: we step to (11,11), 2 tiles from it
  context.time = TW + 30; walkTo(9, 9);   // 20 ms later: dropped by the server
  context.time = TW + 50; pump();
  const throttlePlan = tickArms().at(-1);
  const framesThrottle = run("fixture.Socket.instance.frames.length");
  context.time = throttlePlan.fires[0].dueAt;
  context.__worker.onmessage({ data: { type: "fire", planId: throttlePlan.planId, index: 0, dueAt: throttlePlan.fires[0].dueAt, seq: throttlePlan.seq, window: "TICK" } });
  const throttleSent = Array.from(run("fixture.Socket.instance.frames").slice(framesThrottle), (fr) => Array.from(fr.bytes)).filter((b) => b[1] === 211).map((b) => b.slice(4, 6));
  assert.deepEqual(throttleSent, [[52, 54]], "the click goes to 46, judged from the kept step (11,11)");
  avs.delete(46);
  avs.set(7, saved7w);
  api.onHubMessage({ type: "timing_config", enabled: false, source: "STEP" });
  console.log("PASS walk throttle: a walk request 20 ms after the kept one is dropped, our step is the kept one");

  // Ring-board walk gate: its newest decision goes out as soon as the server's
  // 100 ms walk gap allows; a decision replaced before that never goes out,
  // and a tile already sent is not sent again.
  const savedSetTimeoutG = context.setTimeout;
  const gateTimers = [];
  context.setTimeout = (fn, ms) => { gateTimers.push({ fn, ms }); return 1; };
  run(`fixture.walks = []; __testProviders.walk.instance.walk = (p) => {
    fixture.walks.push(p);
    const pk = new fixture.Packet(182);
    pk.appendParameter(String(p.x).padStart(2, "0") + String(p.y).padStart(2, "0") + "4");
    pk.appendParameter("");
    fixture.Socket.instance.sendServerMessage(pk);
  }`);
  const TG = TW + 3000;
  context.time = TG; api.onHubMessage({ type: "move", x: 11, y: 11 });
  assert.deepEqual(JSON.parse(run("JSON.stringify(fixture.walks)")), [{ x: 11, y: 11 }], "first decision goes out at once");
  context.time = TG + 20; api.onHubMessage({ type: "move", x: 9, y: 11 });   // inside the gap: waits
  context.time = TG + 40; api.onHubMessage({ type: "move", x: 10, y: 11 });  // replaces it
  assert.equal(run("fixture.walks.length"), 1, "nothing inside the server gap");
  const gateTimer = gateTimers.at(-1);
  assert.ok(gateTimer && gateTimer.ms >= 60 && gateTimer.ms <= 83, "fires when the gap ends");
  context.time = TG + 102; gateTimer.fn();
  assert.deepEqual(JSON.parse(run("JSON.stringify(fixture.walks.at(-1))")), { x: 10, y: 11 }, "the newest decision");
  assert.equal(run("fixture.walks.length"), 2);
  context.time = TG + 300; api.onHubMessage({ type: "move", x: 10, y: 11 }); // same tile again
  assert.equal(run("fixture.walks.length"), 2, "a tile already sent is not sent again");
  const G = api.status().tick.rbGate;
  assert.deepEqual([G.received, G.sent, G.replaced, G.repeats], [4, 2, 1, 1]);
  run(`__testProviders.walk.instance.walk = () => {}`);
  context.setTimeout = savedSetTimeoutG;
  console.log("PASS ring-board walk gate: newest decision after the server gap, replaced ones and repeats never sent");

  // Near tie: two rivals walking in with similar chances. The second click at
  // the runner-up is off (25/09 live: never answered), so one click at the likelier.
  api.onHubMessage({
    type: "timing_config", enabled: true, source: "STEP", landing: { enabled: false },
    tick: { enabled: true, auto: true, single: true, blind: true, reactive: true, autoCal: true, shots: 1, burst: 1 }
  });
  const saved7d = avs.get(7);
  avs.delete(7);
  run(`fixture.Renderer.instance.avatars.set(38, { position: { x: 13, y: 13, z: 1 }, avatarInfo: { id: 3800, username: "Right" } })`);
  run(`fixture.Renderer.instance.avatars.set(39, { position: { x: 7, y: 7, z: 1 }, avatarInfo: { id: 3900, username: "Left" } })`);
  const TD = TS + 20000;
  context.time = TD - 400; walkTo(10, 10); // we stay put
  context.time = TD;
  inbound(182, 0, [1, 38, 12, 12, 2, 600, 1]); // (13,13) -> (12,12), towards us: P 0.239
  inbound(182, 0, [1, 39, 8, 8, 1, 600, 1]);   // (7,7) -> (8,8), towards us: P 0.269
  context.time = TD + 50; pump();
  const dualPlan = tickArms().at(-1);
  const framesDual = run("fixture.Socket.instance.frames.length");
  context.time = dualPlan.fires[0].dueAt;
  context.__worker.onmessage({ data: { type: "fire", planId: dualPlan.planId, index: 0, dueAt: dualPlan.fires[0].dueAt, seq: dualPlan.seq, window: "TICK" } });
  const dualSent = Array.from(run("fixture.Socket.instance.frames").slice(framesDual), (fr) => Array.from(fr.bytes));
  assert.deepEqual(dualSent.map((b) => b[1]), [211], "turn, one click");
  assert.deepEqual(dualSent[0].slice(4, 6), [51, 57], "at 39, the likelier");
  assert.equal(api.status().tick.dual || 0, 0);
  // Sweep: the tick's second click lands after the server gap of a rejected
  // first one, at the runner-up (before the batch tells who stepped in).
  assert.equal(dualPlan.fires.length, 2);
  assert.ok(dualPlan.fires[1].dueAt - dualPlan.fires[0].dueAt >= 104, "after the 100 ms gap");
  const framesSweep = run("fixture.Socket.instance.frames.length");
  context.time = dualPlan.fires[1].dueAt;
  context.__worker.onmessage({ data: { type: "fire", planId: dualPlan.planId, index: 1, dueAt: dualPlan.fires[1].dueAt, seq: dualPlan.seq, window: "TICK" } });
  const sweepSent = Array.from(run("fixture.Socket.instance.frames").slice(framesSweep), (fr) => Array.from(fr.bytes)).filter((b) => b[1] === 211).map((b) => b.slice(4, 6));
  assert.deepEqual(sweepSent, [[51, 56]], "the sweep goes to 38, the runner-up");
  assert.equal(api.status().tick.sweep.fired, 1);
  avs.delete(38);
  avs.delete(39);
  avs.set(7, saved7d);
  api.onHubMessage({ type: "timing_config", enabled: false, source: "STEP" });
  console.log("PASS near tie: one click at the likelier, the sweep at the runner-up after the server gap");

  // Round start: after the gong punches are ignored for 4.66 s. No click is
  // wasted (nothing gets muted) and one click lands as the round starts, at
  // the rival waiting next to us.
  api.onHubMessage({
    type: "timing_config", enabled: true, source: "STEP", landing: { enabled: false },
    tick: { enabled: true, auto: true, single: true, blind: true, reactive: true, autoCal: true, shots: 1, burst: 1 }
  });
  const saved7e = avs.get(7);
  avs.delete(7);
  const TR = TD + 20000;
  context.time = TR; inbound(182, 0, [1, 50, 20, 20, 2, 600, 0]);
  context.time = TR + 100; inbound(160, 126, []); // gong
  inbound(160, 130, [8, 300]); // v6_59: a START gong is confirmed by 160/130 [N, 300]
  const roundPlan = armed.filter((m) => m.window === "UNLOCK").at(-1);
  assert.ok(Math.abs(roundPlan.fires[0].dueAt + 170 + api.status().tick.corrMs - (TR + 100 + 5010)) <= 1, "lands as the round starts");
  run(`fixture.Renderer.instance.avatars.set(40, { position: { x: 11, y: 11, z: 1 }, avatarInfo: { id: 4000, username: "Waiting" } })`);
  const framesRound = run("fixture.Socket.instance.frames.length");
  context.time = TR + 1200; inbound(182, 0, [1, 50, 20, 21, 2, 600, 0]);
  context.time = TR + 1250; pump();
  const roundTick = tickArms().at(-1);
  if (roundTick && roundTick.fires[0].dueAt < TR + 100 + 5000 - 200) {
    context.time = roundTick.fires[0].dueAt;
    context.__worker.onmessage({ data: { type: "fire", planId: roundTick.planId, index: 0, dueAt: roundTick.fires[0].dueAt, seq: roundTick.seq, window: "TICK" } });
  }
  assert.equal(run("fixture.Socket.instance.frames.length"), framesRound, "no click before the round starts");
  context.time = roundPlan.fires[0].dueAt;
  context.__worker.onmessage({ data: { type: "fire", planId: roundPlan.planId, index: 0, dueAt: roundPlan.fires[0].dueAt, seq: roundPlan.seq, window: "UNLOCK" } });
  const roundSent = Array.from(run("fixture.Socket.instance.frames").slice(framesRound), (fr) => Array.from(fr.bytes));
  assert.deepEqual(roundSent.map((b) => b[1]), [211], "one click as the round starts");
  assert.deepEqual(roundSent[0].slice(4, 6), [52, 48], "at 40, waiting next to us");
  avs.delete(40);
  avs.set(7, saved7e);
  api.onHubMessage({ type: "timing_config", enabled: false, source: "STEP" });
  console.log("PASS round start: no clicks for 4.66 s after the gong, one click as the round starts");

  // Rival unlock: a rival next to us that hit someone else wakes up at a known
  // moment off the tick grid. One click lands 1 ms after it; a tick click
  // landing within the server gap of it stands down.
  api.onHubMessage({ type: "hit_lock_config", ms: 3000 });
  api.onHubMessage({
    type: "timing_config", enabled: true, source: "STEP", landing: { enabled: false },
    tick: { enabled: true, auto: true, single: true, blind: true, reactive: true, autoCal: true, shots: 1, burst: 1 }
  });
  const saved7f = avs.get(7);
  avs.delete(7);
  run(`fixture.Renderer.instance.avatars.set(41, { position: { x: 11, y: 11, z: 1 }, avatarInfo: { id: 4100, username: "Puncher" } })`);
  const TU = TR + 20000;
  context.time = TU; inbound(182, 0, [1, 50, 20, 20, 2, 600, 0]);
  context.time = TU + 200; inbound(211, 0, [1, 1, 41, 11, 11, 1, 60, 12, 12]); // 41 hits 60
  const rlPlan = armed.filter((m) => m.window === "RUNLOCK").at(-1);
  assert.ok(rlPlan, "rival unlock armed");
  assert.ok(Math.abs(rlPlan.fires[0].dueAt + 170 + api.status().tick.corrMs - (TU + 200 + 3000 + 10)) <= 1, "lands 10 ms after its lock ends");
  context.time = TU + 2400; inbound(182, 0, [1, 50, 20, 21, 2, 600, 0]);
  context.time = TU + 2750; pump();
  const rlTick = tickArms().at(-1);
  const framesRl = run("fixture.Socket.instance.frames.length");
  context.time = rlTick.fires[1].dueAt; // the sweep would land ~100 ms before the unlock click
  context.__worker.onmessage({ data: { type: "fire", planId: rlTick.planId, index: 1, dueAt: rlTick.fires[1].dueAt, seq: rlTick.seq, window: "TICK" } });
  assert.equal(run("fixture.Socket.instance.frames.length"), framesRl, "no tick click in the unlock's gap");
  assert.equal(api.status().tick.lastSkip, "runlock");
  context.time = rlPlan.fires[0].dueAt;
  context.__worker.onmessage({ data: { type: "fire", planId: rlPlan.planId, index: 0, dueAt: rlPlan.fires[0].dueAt, seq: rlPlan.seq, window: "RUNLOCK" } });
  const rlSent = Array.from(run("fixture.Socket.instance.frames").slice(framesRl), (fr) => Array.from(fr.bytes));
  assert.deepEqual(rlSent.map((b) => b[1]), [211], "turn, then one click");
  assert.deepEqual(rlSent[0].slice(4, 6), [52, 49], "at 41 as its animation ends");
  assert.equal(api.status().tick.runlock.fired, 1);
  // A rival that is not next to us when the click would leave gets nothing.
  context.time = TU + 3500; inbound(211, 0, [1, 1, 41, 11, 11, 1, 61, 12, 12]);
  const rlPlan2 = armed.filter((m) => m.window === "RUNLOCK").at(-1);
  context.time = TU + 3600; inbound(182, 0, [1, 41, 14, 14, 2, 600, 0]); // it walks away
  const framesRl2 = run("fixture.Socket.instance.frames.length");
  context.time = rlPlan2.fires[0].dueAt;
  context.__worker.onmessage({ data: { type: "fire", planId: rlPlan2.planId, index: 0, dueAt: rlPlan2.fires[0].dueAt, seq: rlPlan2.seq, window: "RUNLOCK" } });
  assert.equal(run("fixture.Socket.instance.frames.length"), framesRl2, "no click at a rival that left");
  assert.equal(api.status().tick.runlock.noContact, 1);
  avs.delete(41);
  avs.set(7, saved7f);
  api.onHubMessage({ type: "timing_config", enabled: false, source: "STEP" });
  api.onHubMessage({ type: "hit_lock_config", ms: 0 });
  console.log("PASS rival unlock: one click as a neighbour's punch animation ends, tick clicks around it stand down");


  // Hub and runtime must clamp TICK identically (a mismatch makes the Hub
  // re-push timing_config forever, clearing armed plans on every push).
  const hub = hubCore;
  for (const input of [
    { enabled: true, auto: false, single: false, offsetMs: -5, shots: 0, spacingMs: 50, blind: false, reactive: true, autoCal: false, burst: 0, burstGapMs: 0 },
    { enabled: true, auto: true, single: true, offsetMs: 500, shots: 9, spacingMs: 999, blind: true, reactive: false, autoCal: true, burst: 99, burstGapMs: 99 },
    { enabled: false, auto: false, single: false, offsetMs: 25, shots: 3, spacingMs: 150, blind: true, reactive: true, autoCal: true, burst: 6, burstGapMs: 5 }
  ]) {
    api.onHubMessage({ type: "timing_config", tick: input });
    assert.deepEqual({ ...api.status().timing.tick }, hub.normalizeTickConfig(input));
  }
  const hubTiming = hub.normalizeTimingConfig({ tick: { enabled: true, offsetMs: 12 } });
  assert.equal(hubTiming.tick.offsetMs, 12);
  assert.equal(hubTiming.tick.shots, 4);
  assert.equal(hub.normalizeTimingConfig({}).tick.enabled, false);
  assert.equal(hub.normalizeTimingConfig({}).tick.auto, true); // autotune on by default
  console.log("PASS Hub and runtime clamp TICK identically; Hub defaults keep TICK off");

  // Step walk: a walk of several tiles goes to the server one tile per tick,
  // each requested right after our previous step arrives; off, the client's walk
  // goes out untouched.
  {
    const avsW = run("fixture.Renderer.instance.avatars");
    const others = [...avsW.entries()].filter(([id]) => id !== 1);
    for (const [id] of others) avsW.delete(id);
    api.onHubMessage({ type: "step_walk_config", enabled: true });
    context.time += 5000; inbound(182, 0, [1, 1, 10, 10, 2, 600, 1]); // we stand at (10,10)
    const framesW = run("fixture.Socket.instance.frames.length");
    const walkOut = () => Array.from(run("fixture.Socket.instance.frames").slice(framesW), (fr) => Array.from(fr.bytes))
      .filter((b) => b[1] === 182).map((b) => String.fromCharCode(...b.slice(4, 9)));
    walkTo(13, 13);
    assert.deepEqual(walkOut(), ["11114"], "only the first tile goes out");
    context.time += 600; inbound(182, 0, [1, 1, 11, 11, 1, 600, 1]);
    assert.deepEqual(walkOut(), ["11114", "12124"], "the next tile right after our step");
    context.time += 600; inbound(182, 0, [1, 1, 12, 12, 1, 600, 1]);
    context.time += 600; inbound(182, 0, [1, 1, 13, 13, 1, 600, 1]);
    assert.deepEqual(walkOut(), ["11114", "12124", "13134"], "goal reached: nothing more");
    walkTo(14, 14);
    assert.deepEqual(walkOut().slice(-1), ["14144"], "a one-tile walk goes out as is");
    api.onHubMessage({ type: "step_walk_config", enabled: false });
    walkTo(10, 10);
    assert.deepEqual(walkOut().slice(-1), ["10104"], "off: the client's walk untouched");
    context.time += 600; inbound(182, 0, [1, 1, 10, 10, 2, 600, 1]); // back where the next test expects us
    for (const [id, av] of others) avsW.set(id, av);
  }
  console.log("PASS step walk: one tile per tick towards the goal, off leaves the client's walk alone");

  // Bounce retry: the tick click at a rival walking in bounces (landed a hair
  // before the switch) while the batch shows it next to us: one more click at
  // it right away, as an autoclick would after the server gap.
  {
    const avsB = run("fixture.Renderer.instance.avatars");
    const othersB = [...avsB.entries()].filter(([id]) => id !== 1);
    for (const [id] of othersB) avsB.delete(id);
    const savedST = context.setTimeout;
    const timersB = [];
    context.setTimeout = (fn, ms) => { timersB.push({ fn, ms }); return 1; };
    api.onHubMessage({
      type: "timing_config", enabled: true, source: "STEP", landing: { enabled: false },
      tick: { enabled: true, auto: true, single: true, blind: true, reactive: true, autoCal: true, shots: 1, burst: 1 }
    });
    run(`fixture.Renderer.instance.avatars.set(42, { position: { x: 13, y: 13, z: 1 }, avatarInfo: { id: 4200, username: "Bouncer" } })`);
    const TB = Math.ceil((context.time + 30000) / 600) * 600;
    context.time = TB; inbound(182, 0, [1, 1, 10, 10, 2, 600, 1]);
    context.time = TB + 600; inbound(182, 0, [1, 42, 12, 12, 2, 600, 0]); // walking in
    context.time = TB + 650; pump();
    const bPlan = tickArms().at(-1);
    context.time = bPlan.fires[0].dueAt;
    context.__worker.onmessage({ data: { type: "fire", planId: bPlan.planId, index: 0, dueAt: bPlan.fires[0].dueAt, seq: bPlan.seq, window: "TICK" } });
    const framesB = run("fixture.Socket.instance.frames.length");
    const n = Number(bPlan.planId.split(":")[1]);
    const T = api.status().tick.origin + n * 600;
    context.time = T; inbound(182, 0, [1, 42, 11, 11, 2, 600, 0]); // next to us now
    while (timersB.length) timersB.shift().fn();
    assert.equal(run("fixture.Socket.instance.frames.length"), framesB + 1, "the blind request gets a confirmed-contact reaction");
    context.time = T + 2; inbound(144, 0, []); // ...but it bounced
    while (timersB.length) timersB.shift().fn();
    const retrySent = Array.from(run("fixture.Socket.instance.frames").slice(framesB), (fr) => Array.from(fr.bytes)).filter((b) => b[1] === 211).map((b) => b.slice(4, 6));
    assert.deepEqual(retrySent, [[52, 50]], "one fallback at 42; the delayed reject adds no duplicate retry");
    context.setTimeout = savedST;
    avsB.delete(42);
    for (const [id, av] of othersB) avsB.set(id, av);
    api.onHubMessage({ type: "timing_config", enabled: false, source: "STEP" });
  }
  console.log("PASS bounce retry: a bounced tick click at a rival now next to us is retried once");

  // Burst: an engine shot goes out as N requests 1 ms apart; the sweep waits
  // for the server gap after the burst's last one.
  {
    const avsR = run("fixture.Renderer.instance.avatars");
    const othersR = [...avsR.entries()].filter(([id]) => id !== 1);
    for (const [id] of othersR) avsR.delete(id);
    api.onHubMessage({ type: "tick_burst_config", count: 5 });
    api.onHubMessage({
      type: "timing_config", enabled: true, source: "STEP", landing: { enabled: false },
      tick: { enabled: true, auto: true, single: true, blind: true, reactive: true, autoCal: true, shots: 1, burst: 1 }
    });
    run(`fixture.Renderer.instance.avatars.set(43, { position: { x: 13, y: 13, z: 1 }, avatarInfo: { id: 4300, username: "Burst" } })`);
    const TQ = Math.ceil((context.time + 30000) / 600) * 600;
    context.time = TQ; inbound(182, 0, [1, 1, 10, 10, 2, 600, 1]);
    context.time = TQ + 600; inbound(182, 0, [1, 43, 12, 12, 2, 600, 0]);
    context.time = TQ + 650; pump();
    const qPlan = tickArms().at(-1);
    assert.ok(qPlan.fires[1].dueAt - qPlan.fires[0].dueAt >= 104 + 4, "sweep after the gap of the burst's last request");
    const framesQ = run("fixture.Socket.instance.frames.length");
    context.time = qPlan.fires[0].dueAt;
    context.__worker.onmessage({ data: { type: "fire", planId: qPlan.planId, index: 0, dueAt: qPlan.fires[0].dueAt, seq: qPlan.seq, window: "TICK" } });
    const qSent = Array.from(run("fixture.Socket.instance.frames").slice(framesQ), (fr) => fr);
    assert.equal(qSent.filter((fr) => fr.bytes[1] === 211).length, 5, "five requests");
    api.onHubMessage({ type: "tick_burst_config", count: 1 });
    avsR.delete(43);
    for (const [id, av] of othersR) avsR.set(id, av);
    api.onHubMessage({ type: "timing_config", enabled: false, source: "STEP" });
  }
  console.log("PASS burst: an engine shot is N requests 1 ms apart, the sweep waits for the last one's gap");

  // Advanced knobs (29/09): a repeat click at the same target repeatMs after the
  // first one (replaces the sweep); sweep off = one click per tick.
  {
    const avsA = run("fixture.Renderer.instance.avatars");
    const othersA = [...avsA.entries()].filter(([id]) => id !== 1);
    for (const [id] of othersA) avsA.delete(id);
    api.onHubMessage({ type: "tick_advanced_config", repeatMs: 115 });
    api.onHubMessage({
      type: "timing_config", enabled: true, source: "STEP", landing: { enabled: false },
      tick: { enabled: true, auto: true, single: true, blind: true, reactive: true, autoCal: true, shots: 1, burst: 1 }
    });
    run(`fixture.Renderer.instance.avatars.set(44, { position: { x: 13, y: 13, z: 1 }, avatarInfo: { id: 4400, username: "Repeat" } })`);
    const TA = Math.ceil((context.time + 30000) / 600) * 600;
    context.time = TA; inbound(182, 0, [1, 1, 10, 10, 2, 600, 1]);
    context.time = TA + 600; inbound(182, 0, [1, 44, 12, 12, 2, 600, 0]);
    context.time = TA + 650; pump();
    const aPlan = tickArms().at(-1);
    assert.equal(aPlan.fires.length, 2, "first click + repeat");
    assert.ok(Math.abs(aPlan.fires[1].dueAt - aPlan.fires[0].dueAt - 115) <= 1, "repeat lands 115 ms after the first");
    const framesA = run("fixture.Socket.instance.frames.length");
    for (const i of [0, 1]) {
      context.time = aPlan.fires[i].dueAt;
      context.__worker.onmessage({ data: { type: "fire", planId: aPlan.planId, index: i, dueAt: aPlan.fires[i].dueAt, seq: aPlan.seq, window: "TICK" } });
    }
    const aSent = Array.from(run("fixture.Socket.instance.frames").slice(framesA), (fr) => Array.from(fr.bytes)).filter((b) => b[1] === 211).map((b) => b.slice(4, 6));
    assert.deepEqual(aSent, [[52, 52], [52, 52]], "both at 44");
    assert.equal(api.status().tickAdv.repeats, 1);
    // Sweep off and no repeat: one click per tick.
    api.onHubMessage({ type: "tick_advanced_config", repeatMs: 0, sweep: false });
    context.time = TA + 1200; inbound(182, 0, [1, 44, 12, 12, 2, 600, 0]);
    context.time = TA + 1250; pump();
    assert.equal(tickArms().at(-1).fires.length, 1, "sweep off: a single click");
    api.onHubMessage({ type: "tick_advanced_config", sweep: true });
    avsA.delete(44);
    for (const [id, av] of othersA) avsA.set(id, av);
    api.onHubMessage({ type: "timing_config", enabled: false, source: "STEP" });
  }
  console.log("PASS advanced: repeat click at the same target after repeatMs; sweep off leaves one click");

  // Low-ping mode (29/09): no guessing on uncertain contacts (the reaction covers them), no sweep.
  {
    const avsL = run("fixture.Renderer.instance.avatars");
    const othersL = [...avsL.entries()].filter(([id]) => id !== 1);
    for (const [id] of othersL) avsL.delete(id);
    api.onHubMessage({ type: "low_ping_config", mode: "on" });
    assert.equal(api.status().lowPing.active, true);
    api.onHubMessage({
      type: "timing_config", enabled: true, source: "STEP", landing: { enabled: false },
      tick: { enabled: true, auto: true, single: true, blind: true, reactive: true, autoCal: true, shots: 1, burst: 1 }
    });
    run(`fixture.Renderer.instance.avatars.set(45, { position: { x: 13, y: 13, z: 1 }, avatarInfo: { id: 4500, username: "Walker" } })`);
    const TL2 = Math.ceil((context.time + 30000) / 600) * 600;
    context.time = TL2; inbound(182, 0, [1, 1, 10, 10, 2, 600, 1]);
    context.time = TL2 + 600; inbound(182, 0, [1, 45, 12, 12, 2, 600, 0]); // walking, 2 tiles away: a guess
    context.time = TL2 + 650; pump();
    const lPlan = tickArms().at(-1);
    assert.equal(lPlan.fires.length, 1, "no sweep in low-ping mode");
    const framesL = run("fixture.Socket.instance.frames.length");
    context.time = lPlan.fires[0].dueAt;
    context.__worker.onmessage({ data: { type: "fire", planId: lPlan.planId, index: 0, dueAt: lPlan.fires[0].dueAt, seq: lPlan.seq, window: "TICK" } });
    assert.equal(run("fixture.Socket.instance.frames.length"), framesL, "uncertain contact: no blind click");
    assert.equal(api.status().tick.lastSkip, "ping_bajo");
    assert.ok(api.status().lowPing.skipped >= 1);
    api.onHubMessage({ type: "low_ping_config", mode: "off" });
    avsL.delete(45);
    for (const [id, av] of othersL) avsL.set(id, av);
    api.onHubMessage({ type: "timing_config", enabled: false, source: "STEP" });
  }
  console.log("PASS low ping: uncertain contacts are left to the reaction, no sweep");

  // Cooldown probe against a simulated server: it must tell a global cooldown
  // from a per-target one, and only aim at players 3+ tiles away.
  const avatars = run("fixture.Renderer.instance.avatars");
  run(`fixture.Renderer.instance.avatars.set(20, { position: { x: 14, y: 14, z: 1 }, avatarInfo: { id: 2000, username: "Far1" } })`);
  run(`fixture.Renderer.instance.avatars.set(21, { position: { x: 10, y: 14, z: 1 }, avatarInfo: { id: 2100, username: "Far2" } })`);
  assert.deepEqual(Array.from(api.lab.targets()).sort(), [20, 21]); // rival 7 is close: excluded
  const realSetTimeout = context.setTimeout;
  context.setTimeout = (fn, ms) => { context.time += Math.max(0, ms || 0); Promise.resolve().then(fn); return 1; };
  const socket = run("fixture.Socket.instance");
  const realSend = socket.sendServerMessage;
  const serve = (perTarget) => {
    const lastAt = new Map();
    socket.sendServerMessage = function (packet) {
      realSend.call(this, packet);
      const bytes = packet.toByteArray();
      if (bytes[1] !== 211) return;
      const key = perTarget ? String.fromCharCode(...bytes.slice(4, bytes.indexOf(179, 4))) : "all";
      if (context.time - (lastAt.get(key) ?? -1e9) < 100) return; // dropped silently
      lastAt.set(key, context.time);
      inbound(144, 0, []);
    };
  };
  serve(false);
  const global = await api.lab.cooldownProbe({ gapMs: 30, rounds: 2 });
  assert.deepEqual({ ...global.summary }, { same: "2/6 respuestas/enviados", split: "2/4 respuestas/enviados", control: "4/4 respuestas/enviados" });
  serve(true);
  const perTarget = await api.lab.cooldownProbe({ gapMs: 30, rounds: 2 });
  assert.deepEqual({ ...perTarget.summary }, { same: "2/6 respuestas/enviados", split: "4/4 respuestas/enviados", control: "4/4 respuestas/enviados" });
  socket.sendServerMessage = realSend;
  context.setTimeout = realSetTimeout;
  avatars.delete(20);
  avatars.delete(21);
  console.log("PASS cooldown probe separates global vs per-target server cooldown; never aims at nearby players");

  // Coco guard, free rival: 38 waits next to us through our animation; the guard
  // cocos it (149 [1, 38]) before our lock ends. Only 3 per round, counting ours by hand.
  api.onHubMessage({ type: "hit_lock_config", ms: HIT_LOCK });
  api.onHubMessage({
    type: "timing_config", enabled: true, source: "STEP", landing: { enabled: false },
    tick: { enabled: true, auto: true, single: true, blind: true, reactive: true, autoCal: true, shots: 1, burst: 1 }
  });
  // v6_53: the automatic self-coco would cover this window too; this test is the guard's.
  api.onHubMessage({ type: "coco_guard_config", selfMode: "off" });
  const saved7g = avs.get(7);
  avs.delete(7);
  run(`fixture.Renderer.instance.avatars.set(37,{ position: { x: 11, y: 11, z: 1 }, avatarInfo: { id: 3700, username: "Victim2" } })`);
  const TCG = context.time + 60000; // after every other test
  context.time = TCG; inbound(182, 0, [1, 50, 20, 20, 2, 600, 0]);
  context.time = TCG + 100;
  assert.equal(api.fire(37), true);
  context.time = TCG + 300; inbound(211, 0, [1, 1, 1, 10, 10, 1, 37, 11, 11]); // our hit: 37 is out
  avs.delete(37);
  context.time = TCG + 2000;
  run(`fixture.Renderer.instance.avatars.set(38, { position: { x: 9, y: 9, z: 1 }, avatarInfo: { id: 3800, username: "Waiter" } })`);
  inbound(182, 0, [1, 38, 9, 9, 2, 600, 0]); // 38 steps next to us and waits
  const guard2 = armed.filter((m) => m.window === "CGUARD").at(-1);
  const framesGuard = run("fixture.Socket.instance.frames.length");
  context.time = guard2.fires[0].dueAt;
  context.__worker.onmessage({ data: { type: "fire", planId: guard2.planId, index: 0, dueAt: guard2.fires[0].dueAt, seq: guard2.seq, window: "CGUARD" } });
  const cocoSent = Array.from(run("fixture.Socket.instance.frames").slice(framesGuard), (fr) => Array.from(fr.bytes)).filter((b) => b[1] === 149);
  assert.equal(cocoSent.length, 1, "coco at the rival waiting next to us");
  assert.equal(messages.filter((m) => m.type === "diagnostic_event" && m.event === "coco_guard").at(-1).targetId, 38);
  // Two waiting (user 27/09: they come 2-3 at once): 39 also stands next to us.
  // 38 got the coco, so the unlock click and its retry go to 39, even before 38's 184.
  run(`fixture.Renderer.instance.avatars.set(39, { position: { x: 11, y: 11, z: 1 }, avatarInfo: { id: 3900, username: "Second" } })`);
  inbound(182, 0, [1, 39, 11, 11, 2, 600, 0]);
  const unlock2 = armed.filter((m) => m.window === "UNLOCK").at(-1);
  const framesU2 = run("fixture.Socket.instance.frames.length");
  for (const i of [0, 1]) {
    context.time = unlock2.fires[i].dueAt;
    context.__worker.onmessage({ data: { type: "fire", planId: unlock2.planId, index: i, dueAt: unlock2.fires[i].dueAt, seq: unlock2.seq, window: "UNLOCK" } });
  }
  const u2 = Array.from(run("fixture.Socket.instance.frames").slice(framesU2), (fr) => Array.from(fr.bytes)).filter((b) => b[1] === 211).map((b) => b.slice(4, 6));
  assert.deepEqual(u2, [[51, 57], [51, 57]], "unlock click and retry at 39, not at 38 (our coco)");
  avs.delete(39);
  // Out of cocos (3 thrown this round): no more.
  run("fixture.Upper.instance.cocoRequest(38)"); run("fixture.Upper.instance.cocoRequest(38)");
  // v6_56: a throw only counts once its 184 confirms it.
  for (let i = 0; i < 3; i++) inbound(184, 120, [3800, 35, 35]);
  assert.equal(messages.filter((m) => m.type === "diagnostic_event" && m.event === "coco_used").at(-1).used, 3);
  const framesGuard3 = run("fixture.Socket.instance.frames.length");
  context.__worker.onmessage({ data: { type: "fire", planId: guard2.planId, index: 0, dueAt: guard2.fires[0].dueAt, seq: guard2.seq, window: "CGUARD" } });
  assert.equal(run("fixture.Socket.instance.frames.length"), framesGuard3, "no 4th coco in a round");
  assert.equal(messages.filter((m) => m.type === "diagnostic_event" && m.event === "coco_guard").at(-1).why, "sin_cocos");
  avs.delete(38);
  avs.set(7, saved7g);
  api.onHubMessage({ type: "timing_config", enabled: false, source: "STEP" });
  api.onHubMessage({ type: "hit_lock_config", ms: 0 });
  api.onHubMessage({ type: "coco_guard_config", selfMode: "auto" });
  console.log("PASS coco guard: coco at the free rival waiting next to us before our animation ends; not at one in coco; 3 per round");

  // Reach probe (28/09): after a batch, nobody beside us and a rival one tile above us
  // (not beside): one click at it, logged with its offset. A rival beside us: no probe.
  {
    api.onHubMessage({
      type: "timing_config", enabled: true, source: "STEP", landing: { enabled: false },
      tick: { enabled: true, auto: true, single: true, blind: true, reactive: true, autoCal: true, shots: 1, burst: 1 }
    });
    api.onHubMessage({ type: "reach_probe_config", enabled: true });
    const saved7r = avs.get(7);
    avs.delete(7);
    const probeTimers = [];
    const savedST = context.setTimeout;
    context.setTimeout = (fn, ms) => { probeTimers.push(fn); return 1; };
    context.time += 60000;
    run(`fixture.Renderer.instance.avatars.set(41, { position: { x: 10, y: 9, z: 1 }, avatarInfo: { id: 4100, username: "Above" } })`);
    const framesP = run("fixture.Socket.instance.frames.length");
    inbound(182, 0, [1, 41, 10, 9, 2, 600, 0]);
    while (probeTimers.length) probeTimers.shift()();
    const probeSent = Array.from(run("fixture.Socket.instance.frames").slice(framesP), (fr) => Array.from(fr.bytes)).filter((b) => b[1] === 211).map((b) => b.slice(4, 6));
    assert.deepEqual(probeSent, [[52, 49]], "one probe click at 41 (vertical neighbour)");
    const probe = messages.filter((m) => m.type === "diagnostic_event" && m.event === "reach_probe").at(-1);
    assert.deepEqual([probe.targetId, probe.dx, probe.dy, probe.cheb], [41, 0, -1, 1]);
    // A rival beside us (lateral): a real fight, the probe stays out of it.
    context.time += 5000;
    run(`fixture.Renderer.instance.avatars.set(42, { position: { x: 11, y: 11, z: 1 }, avatarInfo: { id: 4200, username: "Beside" } })`);
    inbound(182, 0, [1, 42, 11, 11, 2, 600, 0]);
    const probesBefore = messages.filter((m) => m.type === "diagnostic_event" && m.event === "reach_probe").length;
    while (probeTimers.length) probeTimers.shift()();
    // (the engine reaction may click 42: that is the real fight, not the probe)
    assert.equal(messages.filter((m) => m.type === "diagnostic_event" && m.event === "reach_probe").length, probesBefore, "no probe with a rival beside us");
    context.setTimeout = savedST;
    avs.delete(41); avs.delete(42);
    avs.set(7, saved7r);
    api.onHubMessage({ type: "timing_config", enabled: false, source: "STEP" });
    console.log("PASS reach probe: one click at a rival 1-2 tiles away but not beside us; none next to a real fight");
  }

  // 27/09 A/B: engine bursts alternate 5 / 8 by round (roundStartNote); the Hub's
  // tick_burst_config turns it off, { ab: true } turns it back on.
  api.onHubMessage({ type: "tick_burst_config", ab: true });
  for (const want of [8, 5, 8]) {
    run(`{ const p = new fixture.Packet(160, 126); fixture.Socket.instance.handleReceivedBytes(p.toByteArray()); }`);
    inbound(160, 130, [8, 300]); // v6_59: the round starts on the 300 confirmation
    const ab = messages.filter((m) => m.type === "diagnostic_event" && m.event === "burst_ab").at(-1);
    assert.equal(ab && ab.burst, want, "burst A/B alternates by round");
  }
  const abCount = messages.filter((m) => m.type === "diagnostic_event" && m.event === "burst_ab").length;
  api.onHubMessage({ type: "tick_burst_config", count: 1 });
  run(`{ const p = new fixture.Packet(160, 126); fixture.Socket.instance.handleReceivedBytes(p.toByteArray()); }`);
  assert.equal(messages.filter((m) => m.type === "diagnostic_event" && m.event === "burst_ab").length, abCount, "a Hub burst config stops the A/B");
  console.log("PASS burst A/B: 5 / 8 by round, off with a Hub config, back on with ab");

  // 29/09 ally account: an ally (by account id or username) is never punched.
  const sendTickFn = intervals.filter((i) => i.ms === 100).at(-1).fn;
  context.time += 1000;
  api.onHubMessage({ type: "ally_config", accounts: [700] });
  const framesAlly = run("fixture.Socket.instance.frames.length");
  assert.equal(api.fire(7), false, "never punch an ally (account id)");
  assert.equal(run("fixture.Socket.instance.frames.length"), framesAlly);
  assert.ok(api.status().allies.blocked >= 1);
  api.onHubMessage({ type: "ally_config", names: ["RIVAL"] });
  context.time += 1000;
  assert.equal(api.fire(7), false, "never punch an ally (username, any case)");
  api.onHubMessage({ type: "ally_config", accounts: [], names: [] });
  context.time += 1000;
  assert.equal(api.fire(7), true, "not an ally any more");
  console.log("PASS ally: never punched, by account id or username; off with an empty list");

  // Auto Ring: outside the Ring, ask the status; a [0,..] reply joins with gameRequest(1, 1).
  api.onHubMessage({ type: "auto_ring_config", enabled: true });
  const calls = () => JSON.parse(run("JSON.stringify(fixture.Game.instance.calls.map((c) => c.join(':')))"));
  const savedSpaceName = run("fixture.Renderer.instance.spaceModel.name");
  run("fixture.Renderer.instance.spaceModel.name = 'mGame2'");
  context.time += 5000;
  sendTickFn();
  assert.deepEqual(calls(), [], "inside the Ring: nothing");
  run("fixture.Renderer.instance.spaceModel.name = 'escenario404'"); // the Ring lobby
  context.time += 5000;
  sendTickFn();
  assert.deepEqual(calls(), ["status"], "asks the queue status");
  inbound(160, 123, [0, 0]);
  assert.deepEqual(calls(), ["status", "join:1:1"], "not queued: joins the Ring");
  context.time += 1000;
  sendTickFn();
  inbound(160, 123, [1, 1]);
  assert.deepEqual(calls(), ["status", "join:1:1"], "queued: no new request within 4 s, none on [1,1]");
  // The cycle: hit in the Ring -> leave the room (128/124) -> Ring lobby (128/120 [true,100]).
  const sentSince = (n) => Array.from(run("fixture.Socket.instance.frames").slice(n), (fr) => Array.from(fr.bytes));
  run("fixture.Renderer.instance.spaceModel.name = 'mGame2'");
  const framesCycle = run("fixture.Socket.instance.frames.length");
  inbound(211, 0, [1, 1, 7, 11, 11, 1, 1, 10, 10]); // 7 hits us: out
  context.time += 1000;
  sendTickFn();
  assert.equal(sentSince(framesCycle).filter((b) => b[1] === 128).length, 0, "not before 3 s");
  context.time += 3500;
  sendTickFn();
  let nav = sentSince(framesCycle).filter((b) => b[1] === 128);
  assert.equal(nav.length, 1, "leaves the room");
  assert.equal(nav[0][3], 124, "with 128/124"); // frame: [start, id, sep, type, ...]
  run("fixture.Renderer.instance.spaceModel.name = 'flowerpower'");
  context.time += 1000;
  sendTickFn();
  context.time += 2500;
  sendTickFn();
  nav = sentSince(framesCycle).filter((b) => b[1] === 128);
  assert.equal(nav.length, 2, "then the Ring lobby");
  assert.equal(nav[1][3], 120, "with 128/120 (Games -> Ring)");
  assert.equal(api.status().autoRing.leaves, 1);
  assert.equal(api.status().autoRing.lobbyTrips, 1);
  assert.deepEqual(JSON.parse(run("JSON.stringify(fixture.Nav.instance.navs)")).at(-1), [true, 100], "through the client islandRequest (Games -> Ring)");
  context.time += 3000;
  sendTickFn();
  assert.equal(sentSince(framesCycle).filter((b) => b[1] === 128).length, 2, "no new trip within 8 s");
  api.onHubMessage({ type: "auto_ring_config", enabled: false });
  context.time += 10000;
  sendTickFn();
  assert.equal(calls().length, 2, "off: no requests");
  assert.equal(sentSince(framesCycle).filter((b) => b[1] === 128).length, 2, "off: no trips");
  run(`fixture.Renderer.instance.spaceModel.name = ${JSON.stringify(savedSpaceName)}`);
  console.log("PASS auto Ring: joins from the lobby when not queued; hit -> leaves the room -> Ring lobby");

  // Random emotes: one of risa1/risa2/pedo/escupir/llorar every minMs..maxMs; in the
  // Ring never with a free rival within 4 tiles (retries 3 s later).
  const emotes = () => JSON.parse(run("JSON.stringify(fixture.Action.instance.calls)"));
  run("fixture.Renderer.instance.spaceModel.name = 'escenario404'");
  api.onHubMessage({ type: "emote_config", enabled: true, minMs: 10000, maxMs: 10000 });
  sendTickFn(); // schedules the first one 10 s ahead
  context.time += 5000; sendTickFn();
  assert.equal(emotes().length, 0, "not before its time");
  context.time += 6000; sendTickFn();
  assert.equal(emotes().length, 1, "one emote");
  assert.ok([1, 2, 3, 4, 7].includes(emotes()[0]), "a known emote id");
  context.time += 11000; sendTickFn();
  assert.equal(emotes().length, 2, "and another one later");
  run("fixture.Renderer.instance.spaceModel.name = 'mGame2'");
  inbound(128, 120, []); // new room: we are in play again (the auto Ring test left us out)
  run("fixture.Renderer.instance.avatars.set(77, { position: { x: 12, y: 11, z: 1 }, avatarInfo: { id: 7700, username: 'Close' } })");
  inbound(182, 0, [1, 77, 12, 11, 2, 600, 0]);
  context.time += 11000; sendTickFn();
  assert.equal(emotes().length, 2, "a rival 2 tiles away in the Ring: no emote");
  assert.ok(api.status().emotes.skipped >= 1);
  run("fixture.Renderer.instance.avatars.delete(77)");
  api.onHubMessage({ type: "emote_config", enabled: false });
  context.time += 30000; sendTickFn();
  assert.equal(emotes().length, 2, "off");
  console.log("PASS emotes: at random intervals, a known id, never with a rival close in the Ring");

  // Re-queue key (29/09): in the Ring -> leave now (128/124); outside -> Ring lobby
  // (128/120); in the lobby -> status + join; queued -> done. Ignored while typing.
  {
    const keyListeners = [];
    context.addEventListener = (type, fn) => { if (type === "keydown") keyListeners.push(fn); };
    const press = (tagName = "CANVAS", code = "Tab") => {
      let prevented = false;
      for (const fn of keyListeners) fn({ code, repeat: false, target: { tagName }, preventDefault() { prevented = true; }, stopPropagation() {} });
      return prevented;
    };
    const navSince = (n) => Array.from(run("fixture.Socket.instance.frames").slice(n), (fr) => Array.from(fr.bytes)).filter((b) => b[1] === 128).map((b) => b[3]);
    api.onHubMessage({ type: "auto_ring_config", enabled: false });
    api.onHubMessage({ type: "requeue_hotkey_config", code: "Tab" });
    assert.equal(keyListeners.length, 1, "one keydown listener");
    run("fixture.Renderer.instance.spaceModel.name = \x27mGame2\x27");
    const framesK = run("fixture.Socket.instance.frames.length");
    assert.equal(press("INPUT"), false, "typing in the chat: ignored");
    assert.equal(press("CANVAS", "KeyR"), false, "another key: ignored");
    assert.deepEqual(navSince(framesK), [], "nothing sent yet");
    assert.equal(press(), true, "Tab in the game: taken");
    assert.deepEqual(navSince(framesK), [124], "leaves the Ring at once");
    run("fixture.Renderer.instance.spaceModel.name = \x27flowerpower\x27");
    context.time += 200; sendTickFn();
    assert.deepEqual(navSince(framesK), [124, 120], "then the Ring lobby, no wait");
    run("fixture.Renderer.instance.spaceModel.name = \x27escenario404\x27");
    const gameCalls = () => JSON.parse(run("JSON.stringify(fixture.Game.instance.calls.map((c) => c.join(\x27:\x27)))"));
    const callsBefore = gameCalls().length;
    context.time += 1600; sendTickFn();
    assert.deepEqual(gameCalls().slice(callsBefore), ["status"], "asks the queue status in the lobby");
    inbound(160, 123, [0, 0]);
    assert.deepEqual(gameCalls().slice(callsBefore), ["status", "join:1:1"], "joins");
    inbound(160, 123, [1, 1]);
    assert.equal(api.status().autoRing.oneShot, false, "queued: done");
    context.time += 5000; sendTickFn();
    assert.equal(gameCalls().length, callsBefore + 2, "no more requests after that");
    assert.equal(api.status().autoRing.requeues, 1);
    api.onHubMessage({ type: "requeue_hotkey_config", code: "" });
    assert.equal(press(), false, "key off");
    delete context.addEventListener;
  }
  console.log("PASS re-queue key: Ring -> leave now -> lobby -> join; ignored while typing or when off");

  // Stale avatars (29/09): the avatars present when a room load arrives are leftovers if
  // the client does not clear them; the new room brings new avatar objects.
  {
    const avsS = run("fixture.Renderer.instance.avatars");
    const before = avsS.size;
    // a room load the client does NOT clear after (as on the codespace): raw, no refresh
    run(`{ const p = new fixture.Packet(128, 120); p.appendParameter(1); fixture.Socket.instance.handleReceivedBytes(p.toByteArray()); }`);
    assert.equal(api.status().stale.remembered, before, "old room avatars remembered");
    assert.equal(api.status().stale.listed, before, "client did not clear them: all stale");
    run(`fixture.Renderer.instance.avatars.set(7, { position: { x: 11, y: 11, z: 2 }, avatarInfo: { id: 700, username: "Rival" } })`);
    assert.equal(api.status().stale.listed, before - 1, "a new avatar object for id 7 counts again");
    // the roster (128/121) does not mark again: a Ring player created before it is real
    run(`{ const p = new fixture.Packet(128, 121); fixture.Socket.instance.handleReceivedBytes(p.toByteArray()); }`);
    assert.equal(api.status().stale.listed, before - 1, "id 7 created before the roster still counts");
    run(`{ const p = new fixture.Packet(128, 120); p.appendParameter(1); fixture.Socket.instance.handleReceivedBytes(p.toByteArray()); }`); // next room, not cleared
    assert.equal(api.status().stale.listed, avsS.size);
    run(`{ const p = new fixture.Packet(128, 120); p.appendParameter(-1); fixture.Socket.instance.handleReceivedBytes(p.toByteArray()); }`); // a failed load: nothing new marked
    assert.equal(api.status().stale.remembered, avsS.size);
    // leave the fixture as a fresh room for the tests below
    for (const [id, av] of [...avsS.entries()]) avsS.set(id, { ...av });
    assert.equal(api.status().stale.listed, 0, "fresh objects: nothing stale");
  }
  console.log("PASS stale avatars: leftovers of the previous room are ignored, new avatars count");

  // Ring slots (29/09): called right after paying, the lobby roster lands in the Ring
  // scene; in the Ring only ids 0..7 are players.
  {
    const avsR = run("fixture.Renderer.instance.avatars");
    const roomWas = run("fixture.Renderer.instance.spaceModel.name");
    run("fixture.Renderer.instance.spaceModel.name = \"mGame2\"");
    api.onHubMessage({ type: "ring_slots_config", enabled: true });
    const high = [...avsR.keys()].filter((k) => Number(k) >= 8).length;
    run('fixture.Renderer.instance.avatars.set(169, { position: { x: 11, y: 11, z: 2 }, avatarInfo: { id: 16900, username: "Lobby" } })');
    assert.equal(api.status().stale.outOfRing, high + 1, "lobby id 169 is not a Ring player");
    avsR.delete(169);
    api.onHubMessage({ type: "ring_slots_config", enabled: false });
    assert.equal(api.status().stale.outOfRing, 0);
    run("fixture.Renderer.instance.spaceModel.name = " + JSON.stringify(roomWas));
  }
  console.log("PASS ring slots: in the Ring, ids >= 8 are lobby leftovers");

  // Render off: PIXI keeps ticking, its renderer draws nothing; back on restores it.
  api.onHubMessage({ type: "render_off_config", enabled: true });
  run("fixture.Pixi.instance.app.renderer.render()");
  assert.equal(run("fixture.Pixi.instance.app.renderer.draws"), 0, "no draw while off");
  run("fixture.Pixi.instance.app.renderer.render({ container: {}, target: {} })");
  assert.equal(run("fixture.Pixi.instance.app.renderer.draws"), 1, "render-to-texture (baking) still goes through");
  api.onHubMessage({ type: "render_off_config", enabled: false });
  run("fixture.Pixi.instance.app.renderer.render()");
  assert.equal(run("fixture.Pixi.instance.app.renderer.draws"), 2, "draws again when back on");
  console.log("PASS render off: the PIXI renderer stops drawing and is restored");
})().catch((error) => { console.error(error); process.exitCode = 1; });
