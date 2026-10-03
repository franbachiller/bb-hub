import type { MovePlanCommandMessage, ServerStateSnapshot, TilePoint } from "../shared/protocol.js";
import { FINALS_MODEL } from "./finals-model.js";

// Finals brain: the Ring once only we and one rival are left (1v1). The first
// contact decides the round (43 of 43 finals, 25-27/09), so the whole final is
// one question: where does that contact happen. From ~350 contacts where we both
// walked in (HTML5/tools, 27/09), our odds depend on the rival's step: straight on
// from its last one 71% (32-13), a 45 turn 59%, a U-turn 38% (13-21) - Timing
// reads a walker that keeps going and misses one that doubles back. Finalists
// never stand still (stay 1%), so the brain plans the meeting point: for every
// (our tile, rival tile, rival heading) a value iteration over the rival's
// learned finals moves (finals-model.ts) gives P(we win the final); each tick it
// takes the step with the best value.
// While the rival is in its punch animation (it made the kill that opened the
// final) it stands locked 14 s where it hit: we go stand next to it and the
// runtime's RUNLOCK click lands 1 ms after it ends (7-5 live).

const TICK_MS = 600;
const HIT_LOCK_MS = 14000;
const MOVED_RECENT_MS = 700;
// Odds of the deciding contact, shrunk towards 53% with 10 pseudo-fights.
// Both walked in: by the rival's turn vs its last step (0, 45, 90, 135, 180).
const WIN_BOTH_BY_TURN = [0.68, 0.58, 0.51, 0.53, 0.42];
const WIN_BOTH_FROM_STAND = 0.52;
// We walked in next to it: standing 2+ ticks 66% (42-22), just stopped 59%.
const WIN_WE_STEP_STANDING = 0.66;
const WIN_WE_STEP_STOPPED = 0.59;
// It walked in on us (26-26).
const WIN_THEY_STEP = 0.5;
const WIN_RACE = 0.5;
// Value iteration: a final lasts ~10-30 ticks after the unlocks.
const GAMMA = 0.995;
const SWEEPS = 40;
// Planner size cap (states = tiles^2 x 9): the Ring is 117 tiles.
const MAX_TILES = 160;
const STAND = 8;
const OUTS = ["0", "1", "-1", "2", "-2", "3", "-3", "4"];

const DIRS: TilePoint[] = [
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
  { x: -1, y: 1 },
  { x: -1, y: 0 },
  { x: -1, y: -1 },
  { x: 0, y: -1 },
  { x: 1, y: -1 }
];
const dirIndex = (dx: number, dy: number) => DIRS.findIndex((d) => d.x === Math.sign(dx) && d.y === Math.sign(dy));
const distBucket = (d: number) => (d <= 1 ? "1" : d <= 2 ? "2" : d <= 3 ? "3" : d <= 5 ? "4-5" : "6+");
const turnAbs = (a: number, b: number) => {
  const t = (((b - a) % 8) + 8) % 8;
  return t > 4 ? 8 - t : t;
};
const perfNow = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

// Per-scene table of P(win) for (our tile, rival tile, rival heading or STAND).
class FinalsPlanner {
  readonly n: number;
  readonly tiles: TilePoint[];
  private readonly index: Map<number, number>;
  private readonly nb: Int16Array;
  readonly V: Float32Array;
  // Rival outcomes per (m, r, h): up to 9 (8 steps + stay).
  private readonly oNext: Int32Array; // r' * 9 + h'
  private readonly oP: Float32Array;
  private readonly oCls: Int8Array; // 0..4 turn, 5 from standing, 6 stayed
  private sweep = 0;
  private cursor = 0;
  private built = false;

  constructor(private readonly matrix: number[][]) {
    const tiles: TilePoint[] = [];
    matrix.forEach((row, y) => row.forEach((v, x) => { if (v === 0 || v === 2) tiles.push({ x, y }); }));
    this.tiles = tiles;
    this.n = tiles.length;
    this.index = new Map(tiles.map((t, i) => [t.y * 4096 + t.x, i]));
    this.nb = new Int16Array(this.n * 8).fill(-1);
    tiles.forEach((t, i) => DIRS.forEach((d, k) => { this.nb[i * 8 + k] = this.idx(t.x + d.x, t.y + d.y); }));
    const states = this.n * this.n * 9;
    this.V = new Float32Array(states).fill(0.5);
    this.oNext = new Int32Array(states * 9).fill(-1);
    this.oP = new Float32Array(states * 9);
    this.oCls = new Int8Array(states * 9);
  }

  get ready(): boolean {
    return this.sweep >= SWEEPS;
  }

  idx(x: number, y: number): number {
    return this.index.get(y * 4096 + x) ?? -1;
  }

  // On the ring or right at its edge (players stand on edge tiles the matrix
  // leaves out); who left or was sent out stands far away (0,0).
  nearRing(x: number, y: number): boolean {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (this.idx(x + dx, y + dy) >= 0) return true;
    return false;
  }

  lateral(i: number, j: number): boolean {
    const a = this.tiles[i];
    const b = this.tiles[j];
    return Math.abs(b.x - a.x) === 1 && b.x - a.x === b.y - a.y;
  }

  // Work for up to budgetMs; true once the table is final.
  work(budgetMs: number): boolean {
    const t0 = perfNow();
    const n = this.n;
    if (!this.built) {
      for (; this.cursor < n * n; this.cursor++) {
        this.buildOutcomes(Math.floor(this.cursor / n), this.cursor % n);
        if ((this.cursor & 63) === 0 && perfNow() - t0 > budgetMs) return false;
      }
      this.built = true;
      this.cursor = 0;
    }
    while (this.sweep < SWEEPS) {
      for (; this.cursor < n * n; this.cursor++) {
        const m = Math.floor(this.cursor / n);
        const r = this.cursor % n;
        if (m === r) continue;
        const base = (m * n + r) * 9;
        if (this.lateral(m, r)) {
          for (let h = 0; h < 9; h++) this.V[base + h] = WIN_RACE;
          continue;
        }
        for (let h = 0; h < 9; h++) this.V[base + h] = this.bestQ(m, r, h).q;
        if ((this.cursor & 31) === 0 && perfNow() - t0 > budgetMs) return false;
      }
      this.cursor = 0;
      this.sweep++;
    }
    return true;
  }

  // Best of our 9 options (stay + 8 steps) in state (m, r, h).
  // qs (optional) receives every option's value, -1 when it can not be taken.
  bestQ(m: number, r: number, h: number, qs?: number[]): { q: number; to: number } {
    const n = this.n;
    let best = -1;
    let bestTo = m;
    const ob = ((m * n + r) * 9 + h) * 9;
    for (let a = -1; a < 8; a++) {
      const to = a < 0 ? m : this.nb[m * 8 + a];
      if (to < 0 || to === r) {
        qs?.push(-1);
        continue;
      }
      const weMoved = a >= 0;
      let q = 0;
      for (let o = 0; o < 9; o++) {
        const p = this.oP[ob + o];
        if (p <= 0) continue;
        const next = this.oNext[ob + o];
        const cls = this.oCls[ob + o];
        const r2 = Math.floor(next / 9);
        if (r2 === to) {
          // Both step on one tile: a coin flip for who gets it.
          q += 0.5 * p * this.outcome(to, true, r, r * 9 + STAND, 6, h);
          q += 0.5 * p * this.outcome(m, false, r2, next, cls, h);
        } else {
          q += p * this.outcome(to, weMoved, r2, next, cls, h);
        }
      }
      qs?.push(q);
      if (q > best) {
        best = q;
        bestTo = to;
      }
    }
    return { q: best, to: bestTo };
  }

  // Value after one tick: we are on `to`, the rival on next = r2 * 9 + heading.
  private outcome(to: number, weMoved: boolean, r2: number, next: number, cls: number, h: number): number {
    if (!this.lateral(to, r2)) return GAMMA * this.V[(to * this.n + r2) * 9 + (next % 9)];
    if (weMoved && cls <= 4) return WIN_BOTH_BY_TURN[cls];
    if (weMoved && cls === 5) return WIN_BOTH_FROM_STAND;
    if (weMoved) return h === STAND ? WIN_WE_STEP_STANDING : WIN_WE_STEP_STOPPED;
    if (cls !== 6) return WIN_THEY_STEP;
    return WIN_RACE;
  }

  private buildOutcomes(m: number, r: number): void {
    if (m === r) return;
    const n = this.n;
    const me = this.tiles[m];
    const rv = this.tiles[r];
    const d = Math.max(Math.abs(me.x - rv.x), Math.abs(me.y - rv.y));
    const towards = dirIndex(me.x - rv.x, me.y - rv.y);
    for (let h = 0; h < 9; h++) {
      const walking = h !== STAND;
      const key = walking ? `W|${distBucket(d)}|a${turnAbs(towards, h)}` : `S|${distBucket(d)}`;
      const model = FINALS_MODEL[key] ?? FINALS_MODEL[walking ? "W|6+|a2" : "S|6+"];
      const ref = walking ? h : towards;
      const ob = ((m * n + r) * 9 + h) * 9;
      // A finalist never stops (stay 1%): at a wall or at our tile it turns, so
      // blocked steps are spread over the open ones.
      const stay = model.stay ?? 0;
      let open = 0;
      let k = 1;
      for (const o of OUTS) {
        const p = model[o] ?? 0;
        const dir = (((ref + Number(o)) % 8) + 8) % 8;
        const to = this.nb[r * 8 + dir];
        if (to < 0 || to === m) continue;
        this.oNext[ob + k] = to * 9 + dir;
        this.oP[ob + k] = p;
        this.oCls[ob + k] = walking ? turnAbs(h, dir) : 5;
        open += p;
        k++;
      }
      const scale = open > 0 ? (1 - stay) / open : 0;
      for (let i = 1; i < k; i++) this.oP[ob + i] *= scale;
      this.oNext[ob] = r * 9 + STAND;
      this.oP[ob] = open > 0 ? stay : 1;
      this.oCls[ob] = 6;
    }
  }
}

export interface FinalsDecision {
  // True while we are in a final: the caller uses this brain's move (null = stay).
  active: boolean;
  move: MovePlanCommandMessage | null;
}

const INACTIVE: FinalsDecision = { active: false, move: null };

export class FinalsBrain {
  private readonly planners = new Map<string, FinalsPlanner>();
  private sceneKey = "";
  private lastResolveTs = -1;
  private readonly seenResolves = new Set<string>();
  private readonly lockedUntil = new Map<number, number>();
  private readonly out = new Map<number, number>();

  public reset(): void {
    this.sceneKey = "";
    this.lastResolveTs = -1;
    this.seenResolves.clear();
    this.lockedUntil.clear();
    this.out.clear();
  }

  // budgetMs: planning work allowed in this call (the table for a new ring is
  // built over the first calls; until it is ready the old movement plays).
  public evaluate(snapshot: ServerStateSnapshot, budgetMs: number): FinalsDecision {
    if (!snapshot.armed || !snapshot.scene || snapshot.scene.policy !== "allowed") return INACTIVE;
    const scene = snapshot.scene;
    // The ring-board's round id also changes on a pause in its sensors, so the
    // list of eliminated players only resets with the room, or when one of them
    // walks again (a new ring: ids are dealt again).
    if (scene.sceneHash !== this.sceneKey) {
      this.reset();
      this.sceneKey = scene.sceneHash;
    }
    const planner = this.planner(scene.sceneHash, scene.walkableMatrix ?? scene.matrix);
    if (planner && !planner.ready) planner.work(budgetMs);
    if (snapshot.round.phase !== "LIVE") return INACTIVE;
    // (An eliminated player is sent to 0,0 with a step: that is not walking again.)
    for (const e of snapshot.entities) {
      const outAt = this.out.get(e.id);
      if (outAt != null && e.stepStartAt > outAt + 1500 && (!planner || planner.nearRing(e.toX, e.toY))) {
        this.out.clear();
        this.lockedUntil.clear();
        break;
      }
    }
    this.noteResolve(snapshot);
    const self = snapshot.entities.find((e) => e.isSelf) ?? null;
    if (!self) return INACTIVE;
    if (this.out.has(self.id) || this.out.size === 0) return INACTIVE;
    // Alive = not punched this ring (user 27/09: the one hit is out, nothing else).
    const rivals = snapshot.entities.filter((e) => !e.isSelf && !this.out.has(e.id));
    if (rivals.length !== 1) return INACTIVE;
    if (!planner || !planner.ready) return INACTIVE;
    const rival = rivals[0];
    const now = snapshot.nowTs;
    const nextTick = now + TICK_MS;
    const selfLock = Math.max(this.lockedUntil.get(self.id) ?? 0, self.lockUntilTs ?? 0);
    if (selfLock > now) return { active: true, move: null }; // our animation: nothing to do
    const m = planner.idx(self.toX, self.toY);
    const r = planner.idx(rival.toX, rival.toY);
    if (m < 0 || r < 0 || m === r) return INACTIVE;
    const rivalLock = Math.max(this.lockedUntil.get(rival.id) ?? 0, rival.lockUntilTs ?? 0);

    let to: number;
    let why: string;
    if (rivalLock > nextTick) {
      // Its animation: stand next to it for the RUNLOCK click.
      if (planner.lateral(m, r)) return { active: true, move: null };
      to = this.stepTowardsSide(planner, m, r);
      why = `runlock ${Math.round((rivalLock - now) / 100) / 10}s`;
    } else {
      const moved = now - rival.stepStartAt < MOVED_RECENT_MS && (rival.dirX !== 0 || rival.dirY !== 0);
      const h = moved ? dirIndex(rival.dirX, rival.dirY) : STAND;
      const qs: number[] = [];
      const best = planner.bestQ(m, r, h < 0 ? STAND : h, qs);
      to = best.to;
      why = `v ${best.q.toFixed(3)} stay ${qs[0] < 0 ? "-" : qs[0].toFixed(3)}`;
    }
    if (to === m) return { active: true, move: null };
    const tile = planner.tiles[to];
    return {
      active: true,
      move: {
        type: "move_plan",
        targetId: rival.id,
        reason: `FINAL ${why}`,
        mode: rivalLock > nextTick ? "INTERCEPT" : "COMMIT",
        moveAt: Math.max(snapshot.nowWall, snapshot.frameWall + 1),
        primaryTile: tile,
        backupTile: null,
        planTiles: [tile],
        sceneHash: scene.sceneHash,
        issuedAtTs: snapshot.frameTs,
        expiresAtTs: snapshot.frameTs + 320
      }
    };
  }

  private planner(hash: string, matrix: number[][] | undefined): FinalsPlanner | null {
    if (!matrix) return null;
    let p = this.planners.get(hash);
    if (!p) {
      let n = 0;
      for (const row of matrix) for (const v of row) if (v === 0 || v === 2) n++;
      if (n > MAX_TILES || n < 4) return null;
      p = new FinalsPlanner(matrix);
      this.planners.set(hash, p);
    }
    return p;
  }

  // First step of a shortest path to one of the rival's two contact tiles.
  private stepTowardsSide(p: FinalsPlanner, m: number, r: number): number {
    const t = p.tiles[r];
    const goals = new Set([p.idx(t.x + 1, t.y + 1), p.idx(t.x - 1, t.y - 1)].filter((g) => g >= 0));
    const prev = new Map<number, number>([[m, -1]]);
    const queue = [m];
    for (let qi = 0; qi < queue.length; qi++) {
      const c = queue[qi];
      if (goals.has(c)) {
        let s = c;
        while (prev.get(s) !== m && prev.get(s) !== -1) s = prev.get(s)!;
        return s;
      }
      const ct = p.tiles[c];
      for (const d of DIRS) {
        const nx = p.idx(ct.x + d.x, ct.y + d.y);
        if (nx < 0 || nx === r || prev.has(nx)) continue;
        prev.set(nx, c);
        queue.push(nx);
      }
    }
    return m;
  }

  // Every 211 since the last call: the attacker stays 14 s in its animation,
  // the defender is out of this ring for good.
  private noteResolve(snapshot: ServerStateSnapshot): void {
    const list = snapshot.recentResolves?.length ? snapshot.recentResolves : snapshot.lastResolve ? [snapshot.lastResolve] : [];
    for (const r of list) {
      if (!r || r.timestamp <= 0) continue;
      const seenKey = `${r.timestamp}:${r.attackerId}:${r.defenderId}`;
      if (this.seenResolves.has(seenKey)) continue;
      this.seenResolves.add(seenKey);
      if (this.seenResolves.size > 256) this.seenResolves.delete(this.seenResolves.values().next().value!);
      this.lastResolveTs = r.timestamp;
      if (r.attackerId >= 0) this.lockedUntil.set(r.attackerId, r.timestamp + HIT_LOCK_MS);
      if (r.defenderId >= 0) this.out.set(r.defenderId, r.timestamp);
    }
  }
}
