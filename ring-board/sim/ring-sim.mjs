// Ring simulator: the ring-board's real brain (old planner or tile brain) plays
// rounds against rivals that move like the players in our captures (MOVE_MODEL)
// on the real 117-tile Ring; fights resolve with the odds measured on our 520
// fights (HTML5/tools/analyze_fight_odds.js). Same seeds for every brain.
// Uso: node sim/ring-sim.mjs [--rounds 300] [--rivals 3] [--brain old|tile|both]
// Finals (1v1, 43 real ones 25-27/09): --final [--brain old|finals|both] [--rival-model finals|general]
//   the round starts with one player in its punch animation (we made the kill 70%,
//   the rival 30%); the first contact decides it.
import { Worker } from "node:worker_threads";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, "..", "dist");
const { MOVE_MODEL } = await import(pathToFileURL(path.join(DIST, "solver", "move-model.js")).href);
const { FINALS_MODEL } = await import(pathToFileURL(path.join(DIST, "solver", "finals-model.js")).href);
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const ROUNDS = Number(arg("rounds", 300));
const FINAL = process.argv.includes("--final");
const RIVALS = FINAL ? 1 : Number(arg("rivals", 7)); // real Ring: 8 players per round (27/09, 63 rounds)
// Brains: old (planner), tile, finals (old + finals brain), icpt (old + interceptor),
// icpt+finals; comma-separated list or "both".
const BRAINS = arg("brain", "both") === "both" ? ["old", FINAL ? "finals" : "tile"] : arg("brain", "old").split(",");
// Interceptor thresholds: --icpt interceptEdge,interceptGain,vetoEdge
const ICPT = (() => {
  const v = arg("icpt", "0.08,0.06,-0.04").split(",").map(Number);
  return { interceptEdge: v[0], interceptGain: v[1], vetoEdge: v[2] };
})();
const RIVAL_MODEL = arg("rival-model", FINAL ? "finals" : "general");
// Rounds play in parallel, one brain worker per core (same seeds, same totals).
const JOBS = Math.max(1, Number(arg("jobs", os.cpus().length - 1)));
// Low priority: the gym takes the idle CPU and never slows the game down.
try {
  os.setPriority(0, os.constants.priority.PRIORITY_LOW);
} catch {}

const TICK = 600;
const LOCK = 14000;
const ROUND_START = 4660;
const MAX_TICKS = 400;
// Fight odds (ours, 520 fights, 27/09).
const WIN = { weStood: 0.66, weStood1: 0.59, both: 0.53, theyWalk0: 0.54, theyWalk1: 0.44, race: 0.5 };
// --odds post: the 246 fights after the tick-boundary fix (27/09 13:21 on, the same
// tool on those captures): we/stood+ 76% (53-17), we/stood1 71% (5-2, shrunk to 0.70),
// both 59% (walk0 55% 48-39, walk1 67% 26-13), they 43% (walk0 40% 4-6 shrunk to 0.42,
// walk1 44% 11-14). Both-walking contacts then use the rival flag, not the finals table.
const ODDS_POST = arg("odds", "pre") === "post";
if (ODDS_POST) Object.assign(WIN, { weStood: 0.76, weStood1: 0.7, theyWalk0: 0.42, theyWalk1: 0.44 });
const BOTH_POST = [0.55, 0.67]; // by the rival 182 flag (0 = path goes on, 1 = last step)
const P_NOTHING = 0.3; // a new contact that ends with no hit (someone leaves / nobody clicks)
const P_RIVAL_FIGHT = 0.5; // two rivals in contact settle it (50/50) with this chance per tick
// Finals (27/09, HTML5/tools/analyze_finals_contacts.js + ~350 walking contacts):
// every contact is decided; both walking in, by the rival's turn vs its last step
// (0, 45, 90, 135, 180), shrunk to 53% with 10 pseudo-fights; from standing 52%.
// At an unlock with the other one already next to it: our UNLOCK 18-10, RUNLOCK 7-5.
const FINAL_BOTH = [0.68, 0.58, 0.51, 0.53, 0.42];
const FINAL_BOTH_FROM_STAND = 0.52;
const FINAL_THEY = 0.5;
const FINAL_UNLOCK = 0.64;
const FINAL_RUNLOCK = 0.58;

// Ring (mGame2) walkable rows, 117 tiles (HTML5/hub_runtime/ring_scene.page.js).
const ROWS = new Map([[7, [9, 12]], [8, [9, 15]], [9, [8, 17]], [10, [8, 18]], [11, [8, 18]], [12, [9, 19]], [13, [10, 19]], [14, [10, 20]], [15, [10, 19]], [16, [9, 18]], [17, [9, 17]], [18, [11, 15]], [19, [12, 16]], [20, [14, 16]]]);
const W = 28;
const H = 27;
const matrix = Array.from({ length: H }, (_, y) => Array.from({ length: W }, (_, x) => {
  const r = ROWS.get(y);
  return r && x >= r[0] && x <= r[1] ? 0 : 1;
}));
const TILES = [];
matrix.forEach((row, y) => row.forEach((v, x) => { if (v === 0) TILES.push({ x, y }); }));
const walk = (t) => matrix[t.y]?.[t.x] === 0;
const DIRS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
const dirIdx = (dx, dy) => DIRS.findIndex(([x, y]) => x === Math.sign(dx) && y === Math.sign(dy));
const cheb = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
const lateral = (a, b) => Math.abs(b.x - a.x) === 1 && b.x - a.x === b.y - a.y;
const turnOf = (a, b) => {
  const t = (((b - a) % 8) + 8) % 8;
  return t > 4 ? t - 8 : t;
};

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function startBrain() {
  const w = new Worker(path.join(HERE, "sim-worker.mjs"), { workerData: { start: 1_000_000, brainPath: path.join(DIST, "runtime", "brain-worker.js") } });
  let pending = null;
  w.on("message", (m) => {
    if (pending) {
      const p = pending;
      pending = null;
      p(m);
    }
  });
  return {
    ask: (snapshot, name, simNow) => new Promise((resolve) => {
      pending = resolve;
      w.postMessage({ type: "evaluate", seq: 1, epoch: 1, snapshot, fireOptions: { moveAssist: true, simTileBrain: name.startsWith("tile"), simTileVariant: name.startsWith("tile3") ? "attack" : name.startsWith("tile2") ? "post" : "base", simTileKill: arg("kill", ""), simFinalsBrain: name.includes("finals"), simInterceptor: name.startsWith("icpt") ? ICPT : false }, simNow });
    }),
    reset: (simNow) => w.postMessage({ type: "reset", epoch: 1, simNow }),
    stop: () => w.terminate()
  };
}

// A rival's next step, drawn from the learned model (relative to us, as in the captures).
function rivalStep(r, me, rand, occupied, tick) {
  const d = cheb(r, me);
  const db = d <= 1 ? "1" : d <= 2 ? "2" : d <= 3 ? "3" : d <= 5 ? "4-5" : "6+";
  const towards = dirIdx(me.x - r.x, me.y - r.y);
  const walking = r.lastDir >= 0 && r.movedAt === tick - 1;
  const m = RIVAL_MODEL === "finals"
    ? FINALS_MODEL[walking ? `W|${db}|a${Math.abs(turnOf(towards, r.lastDir))}` : `S|${db}`] || FINALS_MODEL[walking ? "W|6+|a2" : "S|6+"]
    : MOVE_MODEL[walking ? `W${r.flag}|${db}|a${Math.abs(turnOf(towards, r.lastDir))}` : `S${r.still >= 4 ? "4+" : r.still >= 2 ? "2-3" : "1"}|${db}`] || MOVE_MODEL[walking ? "W1|6+|a2" : "S4+|6+"];
  const ref = walking ? r.lastDir : towards < 0 ? 0 : towards;
  let u = rand();
  if ((u -= m.stay) < 0) return null;
  if (FINAL) {
    // A finalist never stops (stay 1%): a wall or a taken tile makes it turn,
    // so its steps are drawn among the open ones.
    const opts = [];
    for (let o = -3; o <= 4; o++) {
      const [dx, dy] = DIRS[(((ref + o) % 8) + 8) % 8];
      const t = { x: r.x + dx, y: r.y + dy };
      if (walk(t) && !occupied.has(`${t.x},${t.y}`)) opts.push({ t, p: m[String(o)] ?? 0 });
    }
    const tot = opts.reduce((a, x) => a + x.p, 0);
    let v = rand() * tot;
    for (const x of opts) if ((v -= x.p) < 0) return x.t;
    return null;
  }
  for (let o = -3; o <= 4; o++) {
    if ((u -= m[String(o)] ?? 0) < 0) {
      const [dx, dy] = DIRS[(((ref + o) % 8) + 8) % 8];
      const t = { x: r.x + dx, y: r.y + dy };
      return walk(t) && !occupied.has(`${t.x},${t.y}`) ? t : null;
    }
  }
  return null;
}

function snapshotFor(state, now) {
  const ents = [state.me, ...state.rivals].filter((e) => !e.out).map((e) => ({
    id: e.id, isSelf: e.id === 1, name: e.id === 1 ? "sim" : `r${e.id}`,
    x: e.x, y: e.y, fromX: e.fromX, fromY: e.fromY, toX: e.x, toY: e.y,
    dirX: e.dirX, dirY: e.dirY, stepStartAt: e.stepAt, stepDur: TICK, phase: 1,
    moving: now - e.stepAt < TICK, targetLock: false, combatState: null,
    lockUntilTs: Math.max(e.lockUntil, state.roundLock), walkFlag: e.flag, lastTurnTs: 0, facing: 0, active: true
  }));
  const scene = { sceneHash: "794bf3d1", width: W, height: H, matrix, walkableMatrix: matrix, blocked: [], timestamp: now, allowed: true, policy: "allowed" };
  return {
    nowTs: now, nowWall: now, frameTs: now, frameWall: now, armed: true, scene, entities: ents, selection: null,
    lastResolve: state.lastResolve,
    round: { phase: "LIVE", roundId: state.roundId, sceneHash: "794bf3d1", sinceTs: state.roundAt, liveForMs: now - state.roundAt, enemyCount: ents.length - 1, selfAlive: true, summary: "LIVE" },
    targetId: -1, window: null, brain: null, lastFire: null, clients: [],
    arena: { enabled: false, phase: "OFF", pair: [], totalSamples: 0, lastSampleSummary: "", bestWindow: null, clients: [], candidates: [] },
    adaptiveTuning: null
  };
}

async function playRound(brain, name, seed, roundId) {
  const rand = rng(seed);
  const used = new Set();
  const place = (id) => {
    let t;
    do { t = TILES[Math.floor(rand() * TILES.length)]; } while (used.has(`${t.x},${t.y}`));
    used.add(`${t.x},${t.y}`);
    const d0 = Math.floor(rand() * 8);
    return { id, x: t.x, y: t.y, fromX: t.x, fromY: t.y, dirX: DIRS[d0][0], dirY: DIRS[d0][1], stepAt: 0, lastDir: d0, movedAt: -1, still: 0, flag: 0, lockUntil: 0, out: false };
  };
  let now = 1_000_000 + roundId * 1_000_000;
  const state = { me: place(1), rivals: Array.from({ length: RIVALS }, (_, i) => place(2 + i)), roundId, roundAt: now, roundLock: now + ROUND_START, lastResolve: null };
  const res = { kills: 0, died: false, win: false, contacts: 0, steps: 0, ticks: 0, fights: 0, types: {}, rivalTicks: 0, rivalSteps: 0, opener: "" };
  if (FINAL) {
    // Mid-round: somebody just eliminated player 99 and stands in its animation.
    const weKilled = rand() < 0.7;
    const opener = weKilled ? state.me : state.rivals[0];
    res.opener = weKilled ? "we locked" : "rival locked";
    state.roundAt = now - 20000;
    state.roundLock = 0;
    opener.lockUntil = now + LOCK - Math.floor(rand() * TICK);
    state.lastResolve = { attackerId: opener.id, defenderId: 99, winner: opener.id, contested: false, targetId: 99, timestamp: opener.lockUntil - LOCK };
  }
  const inContact = new Set();
  let myGoal = null;
  const me = state.me;
  for (let tick = 0; tick < MAX_TICKS; tick++) {
    now += TICK;
    res.ticks++;
    // 1. the brain decides after the batch; its request lands at the next tick
    const out = await brain.ask(snapshotFor(state, now + 40), name, now + 40);
    const plan = out.move;
    if (plan && plan.primaryTile) myGoal = plan.primaryTile;
    else if (plan && "x" in plan) myGoal = { x: plan.x, y: plan.y };
    // 2. everybody steps at once
    const all = [me, ...state.rivals].filter((e) => !e.out);
    const occupied = new Set(all.map((e) => `${e.x},${e.y}`));
    const intents = new Map();
    if (me.lockUntil <= now && myGoal && (myGoal.x !== me.x || myGoal.y !== me.y)) {
      const t = { x: me.x + Math.sign(myGoal.x - me.x), y: me.y + Math.sign(myGoal.y - me.y) };
      if (walk(t) && !occupied.has(`${t.x},${t.y}`)) intents.set(me.id, t);
    }
    for (const r of state.rivals) {
      if (r.out || r.lockUntil > now) continue;
      const t = rivalStep(r, me, rand, occupied, tick);
      if (t) intents.set(r.id, t);
      res.rivalTicks++;
      if (t) res.rivalSteps++;
    }
    const claimed = new Set();
    // Two steps on one tile: in the finals nobody knows who gets it (coin flip).
    const order = FINAL && rand() < 0.5 ? [...intents].reverse() : [...intents];
    for (const [id, t] of order) {
      const k = `${t.x},${t.y}`;
      if (claimed.has(k)) intents.delete(id);
      else claimed.add(k);
    }
    const turnClass = new Map();
    for (const r of state.rivals) {
      const t = intents.get(r.id);
      if (t) turnClass.set(r.id, r.lastDir >= 0 && r.movedAt === tick - 1 ? Math.abs(turnOf(r.lastDir, dirIdx(t.x - r.x, t.y - r.y))) : -1);
    }
    for (const e of all) {
      const t = intents.get(e.id);
      e.fromX = e.x;
      e.fromY = e.y;
      if (t) {
        e.dirX = Math.sign(t.x - e.x);
        e.dirY = Math.sign(t.y - e.y);
        e.lastDir = dirIdx(e.dirX, e.dirY);
        e.x = t.x;
        e.y = t.y;
        e.stepAt = now;
        e.movedAt = tick;
        e.still = 0;
        e.flag = rand() < 0.66 ? 0 : 1;
        if (e === me) res.steps++;
      } else {
        e.still++;
      }
    }
    // 3. our contacts
    const locked = (e) => e.lockUntil > now || state.roundLock > now;
    for (const r of state.rivals) {
      if (r.out || me.out) continue;
      const key = r.id;
      if (!lateral(me, r)) { inContact.delete(key); continue; }
      if (locked(me) || locked(r)) { inContact.add(key); continue; } // decided when the lock ends: a race
      const fresh = !inContact.has(key);
      inContact.add(key);
      res.contacts++;
      if (fresh && !FINAL && rand() < P_NOTHING) continue;
      const weMoved = intents.has(me.id);
      const theyMoved = intents.has(r.id);
      let p;
      res.types[!fresh ? "race" : weMoved && theyMoved ? "both" : weMoved ? "we" : theyMoved ? "they" : "none"] = (res.types[!fresh ? "race" : weMoved && theyMoved ? "both" : weMoved ? "we" : theyMoved ? "they" : "none"] || 0) + 1;
      if (FINAL) {
        const tc = turnClass.get(r.id);
        if (!fresh) p = me.lockUntil > r.lockUntil ? FINAL_UNLOCK : me.lockUntil < r.lockUntil ? FINAL_RUNLOCK : WIN.race;
        else if (weMoved && theyMoved) p = tc >= 0 ? FINAL_BOTH[tc] : FINAL_BOTH_FROM_STAND;
        else if (weMoved) p = r.still >= 2 ? WIN.weStood : WIN.weStood1;
        else if (theyMoved) p = FINAL_THEY;
        else p = WIN.race;
      } else if (!fresh) p = WIN.race;
      else if (weMoved && theyMoved) {
        const tc = turnClass.get(r.id);
        p = ODDS_POST ? BOTH_POST[r.flag === 0 ? 0 : 1] : tc >= 0 ? FINAL_BOTH[tc] : FINAL_BOTH_FROM_STAND;
      }
      else if (weMoved) p = r.still >= 2 ? WIN.weStood : WIN.weStood1;
      else if (theyMoved) p = r.flag === 0 ? WIN.theyWalk0 : WIN.theyWalk1;
      else p = WIN.race;
      res.fights++;
      if (rand() < p) {
        r.out = true;
        res.kills++;
        me.lockUntil = now + LOCK;
        state.lastResolve = { attackerId: 1, defenderId: r.id, winner: 1, contested: false, targetId: r.id, timestamp: now };
      } else {
        me.out = true;
        res.died = true;
        r.lockUntil = now + LOCK;
        state.lastResolve = { attackerId: r.id, defenderId: 1, winner: r.id, contested: false, targetId: 1, timestamp: now };
      }
      break;
    }
    // 4. rivals among themselves
    const alive = state.rivals.filter((r) => !r.out);
    for (let i = 0; i < alive.length; i++) {
      for (let j = i + 1; j < alive.length; j++) {
        const a = alive[i];
        const b = alive[j];
        if (a.out || b.out || locked(a) || locked(b) || !lateral(a, b) || rand() > P_RIVAL_FIGHT) continue;
        const [w, l] = rand() < 0.5 ? [a, b] : [b, a];
        l.out = true;
        w.lockUntil = now + LOCK;
      }
    }
    if (me.out) break;
    if (state.rivals.every((r) => r.out)) { res.win = true; break; }
  }
  return res;
}

for (const name of BRAINS) {
  const brains = Array.from({ length: Math.min(JOBS, ROUNDS) }, () => startBrain());
  const tot = { byOpener: {}, kills: 0, deaths: 0, wins: 0, rounds: 0, contacts: 0, steps: 0, ticks: 0, fights: 0, alive: [], types: {}, rivalTicks: 0, rivalSteps: 0 };
  const t0 = Date.now();
  let nextRound = 0;
  const lane = async (brain) => {
   for (let i = nextRound++; i < ROUNDS; i = nextRound++) {
    brain.reset(1_000_000 + i * 1_000_000);
    const r = await playRound(brain, name, 1000 + i, i + 1);
    if (FINAL) {
      const o = (tot.byOpener[r.opener] ||= { w: 0, l: 0, d: 0 });
      r.died ? o.l++ : r.win ? o.w++ : o.d++;
    }
    tot.kills += r.kills;
    tot.deaths += r.died ? 1 : 0;
    tot.wins += r.win ? 1 : 0;
    tot.rounds++;
    tot.contacts += r.contacts;
    tot.steps += r.steps;
    tot.ticks += r.ticks;
    tot.fights += r.fights;
    for (const [k, v] of Object.entries(r.types)) tot.types[k] = (tot.types[k] || 0) + v;
    tot.rivalTicks += r.rivalTicks;
    tot.rivalSteps += r.rivalSteps;
    tot.alive.push(r.ticks * TICK / 1000);
   }
  };
  await Promise.all(brains.map(lane));
  const med = (v) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];
  for (const b of brains) b.stop();
  console.log(`${name.padEnd(5)} ${RIVALS} rivals, ${tot.rounds} rounds | survive ${(100 * (tot.rounds - tot.deaths) / tot.rounds).toFixed(0)}% (last one standing ${(100 * tot.wins / tot.rounds).toFixed(0)}%) | kills/round ${(tot.kills / tot.rounds).toFixed(2)} | k/d ${(tot.kills / Math.max(1, tot.deaths)).toFixed(2)} | alive median ${med(tot.alive).toFixed(0)} s | fights/alive-min ${(tot.fights / (tot.ticks * TICK / 60000)).toFixed(2)} | moving ${(100 * tot.steps / Math.max(1, tot.ticks)).toFixed(0)}% | ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  if (FINAL) console.log(`      finals won ${tot.wins} of ${tot.rounds} (${(100 * tot.wins / tot.rounds).toFixed(1)}%) | ${Object.entries(tot.byOpener).map(([k, o]) => `${k}: ${o.w}-${o.l}${o.d ? ` (${o.d} undecided)` : ""}`).join(" | ")}`);
  const nt = Object.values(tot.types).reduce((a, b) => a + b, 0);
  console.log(`      fight types: ${Object.entries(tot.types).map(([k, v]) => `${k} ${(100 * v / nt).toFixed(0)}%`).join(" | ")} | rivals walking ${(100 * tot.rivalSteps / Math.max(1, tot.rivalTicks)).toFixed(0)}% of their ticks`);
}
process.exit(0);
