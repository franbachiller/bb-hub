// Replays a live capture into the finals brain (the ring-board's entity list as
// the Hub feeds it: every player seen in the room, eliminated ones left where
// they were) and reports, per real final, whether the brain knew it was one.
// Uso: node sim/replay-finals.mjs <capture dir>
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const { FinalsBrain } = await import(pathToFileURL(path.join(HERE, "..", "dist", "solver", "finals-brain.js")).href);
const ROWS = new Map([[7, [9, 12]], [8, [9, 15]], [9, [8, 17]], [10, [8, 18]], [11, [8, 18]], [12, [9, 19]], [13, [10, 19]], [14, [10, 20]], [15, [10, 19]], [16, [9, 18]], [17, [9, 17]], [18, [11, 15]], [19, [12, 16]], [20, [14, 16]]]);
const matrix = Array.from({ length: 27 }, (_, y) => Array.from({ length: 28 }, (_, x) => { const r = ROWS.get(y); return r && x >= r[0] && x <= r[1] ? 0 : 1; }));
const file = path.join(process.argv[2], "hub_diagnostics.ndjson");
const L = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const brain = new FinalsBrain();
const ents = new Map();
const resolves = [];
let self = -1;
let round = null;
let active = 0, moves = 0, evals = 0, outside = 0, falseActive = 0;
const report = [];
const evalAt = (t) => {
  const snapshot = {
    armed: true, nowTs: t, nowWall: t, frameTs: t, frameWall: t,
    scene: { sceneHash: "794bf3d1", policy: "allowed", matrix, walkableMatrix: matrix },
    round: { phase: "LIVE", roundId: 1 },
    entities: [...ents.values()].filter((e) => !round || round.players.has(e.id) || e.id === self).map((e) => ({ ...e, isSelf: e.id === self })),
    lastResolve: resolves[resolves.length - 1] ?? null, recentResolves: resolves.slice(-32)
  };
  const d = brain.evaluate(snapshot, Infinity);
  if (process.env.DBG && round?.final && !round.final.done && evals === 0) console.log("dbg", t, "self", self, "out", [...brain["out"].keys()], "ents", snapshot.entities.map((e) => `${e.id}@${e.toX},${e.toY}`).join(" "), "ready", [...brain["planners"].values()].map((p) => p.ready));
  if (round?.final && !round.final.done) { evals++; if (d.active) active++; if (d.move) moves++; } else { outside++; if (d.active) { falseActive++; if (process.env.FA) console.log("FA", Math.round(t), round?.final ? "after final" : "no final", "alive(analyzer)", round ? [...round.players].filter((id) => !round.out.has(id)).join(",") : "-", "brainOut", [...brain["out"].keys()].join(","), "ents", snapshot.entities.map((e) => `${e.id}@${e.toX},${e.toY}`).join(" ")); } }
};
for (const r of L) {
  if (r.selfId >= 0) self = r.selfId;
  if (r.event === "room_boundary" && r.opcode === 160 && r.packetType === 126) { round = { players: new Set(), out: new Set(), final: null }; continue; }
  if (r.event === "room_boundary" && r.opcode === 128 && r.packetType === 120) ents.clear();
  if (r.event !== "packet" || r.direction !== "in") continue;
  const f = r.packet.fields;
  if (r.packet.id === 182 && f[0] === "1") {
    const id = +f[1];
    const e = ents.get(id);
    const x = +f[2], y = +f[3];
    ents.set(id, { id, toX: x, toY: y, dirX: e ? Math.sign(x - e.toX) : 0, dirY: e ? Math.sign(y - e.toY) : 0, stepStartAt: r.ts, lockUntilTs: 0 });
    round?.players.add(id);
    evalAt(r.ts + 1);
    continue;
  }
  if (r.packet.id !== 211 || !round) continue;
  const a = +f[2], d = +f[6];
  resolves.push({ attackerId: a, defenderId: d, winner: a, timestamp: r.ts });
  if (round.final && !round.final.done && (a === self || d === self)) {
    round.final.done = true;
    report.push(`final at ${Math.round(round.final.start)}: ${a === self ? "WON" : "LOST"} | brain active in ${active} of ${evals} evaluations, ${moves} moves`);
  }
  round.out.add(d);
  const alive = [...round.players].filter((id) => !round.out.has(id));
  if (!round.final && alive.length === 2 && alive.includes(self)) { round.final = { start: r.ts, done: false }; active = 0; moves = 0; evals = 0; }
  evalAt(r.ts + 1);
}
console.log(report.join("\n") || "no finals");
console.log(`outside finals: active in ${falseActive} of ${outside} evaluations`);
