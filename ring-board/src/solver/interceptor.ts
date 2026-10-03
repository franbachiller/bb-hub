import type { MovePlanCommandMessage, ServerStateSnapshot, TilePoint } from "../shared/protocol.js";
import { MOVE_MODEL } from "./move-model.js";

// Interceptor: an overlay on the ring-board's own planner, for the whole round.
// It keeps the planner's step unless the next tick's contacts say otherwise.
// From ~350 real contacts where both of us walked in (27/09): a rival that keeps
// walking straight into the contact loses 70% of the time; one that doubles back
// wins 62% (Timing reads the first and misses the second). Each tick, for our 9
// options and every free rival's likely next step (MOVE_MODEL), the expected
// edge of the contacts it makes:
//   - intercept: a clearly good contact is open (a walker coming straight) and
//     the planner's step is not it -> take it;
//   - veto: the planner's step walks into a likely bad contact -> the nearest
//     option to it that does not.
// It never steps next to a standing rival on its own (user rule).

const TICK_MS = 600;
const HIT_LOCK_MS = 14000;
const MOVED_RECENT_MS = 700;
// Contact odds (see finals-brain.ts): both walked in, by the rival's turn.
const WIN_BOTH_BY_TURN = [0.68, 0.58, 0.51, 0.53, 0.42];
const WIN_BOTH_FROM_STAND = 0.52;
const WIN_WE_STEP_STANDING = 0.66;
const WIN_WE_STEP_STOPPED = 0.59;
const WIN_THEY_STEP = 0.5;
// Two rivals in reach at once: whoever of them clicks, we are one vs two.
const MULTI_CONTACT = -0.6;

export interface InterceptorParams {
  // Take an option instead of the planner's when its edge is at least this...
  interceptEdge: number;
  // ...and this much better than the planner's step.
  interceptGain: number;
  // Veto the planner's step when its edge is below this.
  vetoEdge: number;
}

export const DEFAULT_INTERCEPTOR: InterceptorParams = { interceptEdge: 0.08, interceptGain: 0.06, vetoEdge: -0.04 };

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
const turnAbs = (a: number, b: number) => {
  const t = (((b - a) % 8) + 8) % 8;
  return t > 4 ? 8 - t : t;
};
const cheb = (a: TilePoint, b: TilePoint) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
const lateral = (a: TilePoint, b: TilePoint) => Math.abs(b.x - a.x) === 1 && b.x - a.x === b.y - a.y;
const distBucket = (d: number) => (d <= 1 ? "1" : d <= 2 ? "2" : d <= 3 ? "3" : d <= 5 ? "4-5" : "6+");
const keyOf = (t: TilePoint) => `${t.x},${t.y}`;

interface RivalRead {
  tile: TilePoint;
  heading: number; // -1 standing
  still: number; // ticks standing
  next: Array<{ tile: TilePoint; p: number; cls: number }>; // cls 0..4 turn, 5 from standing, 6 stays
}

export class Interceptor {
  private roundKey = "";
  private lastResolveTs = -1;
  private readonly seenResolves = new Set<string>();
  private readonly lockedUntil = new Map<number, number>();
  private readonly out = new Set<number>();
  private readonly outAt = new Map<number, number>();
  public lastKind = "";

  constructor(private readonly params: InterceptorParams = DEFAULT_INTERCEPTOR) {}

  public reset(): void {
    this.roundKey = "";
    this.lastResolveTs = -1;
    this.seenResolves.clear();
    this.lockedUntil.clear();
    this.out.clear();
    this.outAt.clear();
  }

  // The planner's move (or null = stay) -> the move to send.
  public apply(snapshot: ServerStateSnapshot, planned: MovePlanCommandMessage | null): MovePlanCommandMessage | null {
    this.lastKind = "";
    if (!snapshot.armed || !snapshot.scene || snapshot.round.phase !== "LIVE") return planned;
    const scene = snapshot.scene;
    // Eliminated players stay on the ring for a while: reset the list only with
    // the room or when one of them walks again (a new ring).
    if (scene.sceneHash !== this.roundKey) {
      this.reset();
      this.roundKey = scene.sceneHash;
    }
    // (An eliminated player is sent to 0,0 with a step: that is not walking again.)
    const ringMatrix = scene.walkableMatrix ?? scene.matrix;
    for (const e of snapshot.entities) {
      const outAt = this.outAt.get(e.id);
      const onRing = ringMatrix[e.toY]?.[e.toX] === 0 || ringMatrix[e.toY]?.[e.toX] === 2;
      if (outAt != null && e.stepStartAt > outAt + 1500 && onRing) {
        this.out.clear();
        this.outAt.clear();
        this.lockedUntil.clear();
        break;
      }
    }
    this.noteResolve(snapshot);
    const self = snapshot.entities.find((e) => e.isSelf);
    if (!self || this.out.has(self.id)) return planned;
    const now = snapshot.nowTs;
    const nextTick = now + TICK_MS;
    if (Math.max(this.lockedUntil.get(self.id) ?? 0, self.lockUntilTs ?? 0) > nextTick) return planned;
    const matrix = scene.walkableMatrix ?? scene.matrix;
    const walkable = (t: TilePoint) => {
      const v = matrix[t.y]?.[t.x];
      return v === 0 || v === 2;
    };
    const cur = { x: self.toX, y: self.toY };
    const occupied = new Set<string>();
    for (const e of snapshot.entities) if (!e.isSelf && !this.out.has(e.id)) occupied.add(keyOf({ x: e.toX, y: e.toY }));
    const rivals: RivalRead[] = [];
    for (const e of snapshot.entities) {
      if (e.isSelf || this.out.has(e.id)) continue;
      if (Math.max(this.lockedUntil.get(e.id) ?? 0, e.lockUntilTs ?? 0) > nextTick) continue;
      rivals.push(this.readRival(e, cur, now, walkable, occupied));
    }
    if (!rivals.length) return planned;

    // The planner's next step.
    const goal = planned?.primaryTile ?? cur;
    const plannedTile = { x: cur.x + Math.sign(goal.x - cur.x), y: cur.y + Math.sign(goal.y - cur.y) };
    const options: Array<{ tile: TilePoint; edge: number; pGood: number }> = [];
    for (const d of [{ x: 0, y: 0 }, ...DIRS]) {
      const tile = { x: cur.x + d.x, y: cur.y + d.y };
      const moving = d.x !== 0 || d.y !== 0;
      if (moving && (!walkable(tile) || occupied.has(keyOf(tile)))) continue;
      options.push({ tile, ...this.edge(tile, moving, cur, rivals) });
    }
    const planOpt = options.find((o) => o.tile.x === plannedTile.x && o.tile.y === plannedTile.y) ?? options[0];
    const { interceptEdge, interceptGain, vetoEdge } = this.params;
    let pick = planOpt;
    let kind = "";
    const best = options.reduce((a, b) => (b.edge > a.edge ? b : a));
    if (best !== planOpt && best.edge >= interceptEdge && best.edge - planOpt.edge >= interceptGain) {
      pick = best;
      kind = "intercept";
    } else if (planOpt.edge < vetoEdge) {
      // Closest option to the planner's step that is not bad.
      const safe = options.filter((o) => o.edge >= 0).sort((a, b) => cheb(a.tile, plannedTile) - cheb(b.tile, plannedTile) || b.edge - a.edge);
      if (safe.length) {
        pick = safe[0];
        kind = "veto";
      }
    }
    if (!kind) return planned;
    this.lastKind = kind;
    if (pick.tile.x === cur.x && pick.tile.y === cur.y) return null;
    return {
      type: "move_plan",
      targetId: planned?.targetId ?? -1,
      reason: `ICPT ${kind} ${pick.edge.toFixed(3)} (plan ${planOpt.edge.toFixed(3)})`,
      mode: kind === "intercept" ? "INTERCEPT" : "EVADE",
      moveAt: Math.max(snapshot.nowWall, snapshot.frameWall + 1),
      primaryTile: pick.tile,
      backupTile: null,
      planTiles: [pick.tile],
      sceneHash: scene.sceneHash,
      issuedAtTs: snapshot.frameTs,
      expiresAtTs: snapshot.frameTs + 320
    };
  }

  // Expected edge (2 x P(win) - 1, summed over contacts) of being on `tile`
  // after the next tick.
  private edge(tile: TilePoint, moving: boolean, cur: TilePoint, rivals: RivalRead[]): { edge: number; pGood: number } {
    let edge = 0;
    let pGood = 0;
    let pNone = 1;
    let pOne = 0;
    for (const r of rivals) {
      const wasLateral = lateral(cur, r.tile);
      let pc = 0;
      for (const o of r.next) {
        if (o.tile.x === tile.x && o.tile.y === tile.y) continue;
        if (!lateral(tile, o.tile) || (wasLateral && o.cls === 6 && !moving)) continue;
        let w: number;
        if (moving && o.cls <= 4) w = WIN_BOTH_BY_TURN[o.cls];
        else if (moving && o.cls === 5) w = WIN_BOTH_FROM_STAND;
        else if (moving) {
          // Next to a rival that stays: not a reason to go (user rule), but
          // not a danger either.
          w = r.still >= 2 ? WIN_WE_STEP_STANDING : WIN_WE_STEP_STOPPED;
          w = Math.min(w, 0.5);
        } else if (o.cls !== 6) w = WIN_THEY_STEP;
        else continue;
        edge += o.p * (2 * w - 1);
        if (w >= 0.58) pGood += o.p;
        pc += o.p;
      }
      pOne = pOne * (1 - pc) + pNone * pc;
      pNone *= 1 - pc;
    }
    const pMulti = Math.max(0, 1 - pNone - pOne);
    return { edge: edge + MULTI_CONTACT * pMulti, pGood };
  }

  private readRival(
    e: ServerStateSnapshot["entities"][number],
    cur: TilePoint,
    now: number,
    walkable: (t: TilePoint) => boolean,
    occupied: Set<string>
  ): RivalRead {
    const tile = { x: e.toX, y: e.toY };
    const moved = now - e.stepStartAt < MOVED_RECENT_MS && (e.dirX !== 0 || e.dirY !== 0);
    const heading = moved ? dirIndex(e.dirX, e.dirY) : -1;
    const still = moved ? 0 : Math.max(1, Math.floor((now - e.stepStartAt) / TICK_MS));
    const towards = dirIndex(cur.x - tile.x, cur.y - tile.y);
    const db = distBucket(cheb(tile, cur));
    const flag = e.walkFlag === 1 ? 1 : 0;
    const key = heading >= 0 ? `W${flag}|${db}|a${turnAbs(towards, heading)}` : `S${still >= 4 ? "4+" : still >= 2 ? "2-3" : "1"}|${db}`;
    const model = MOVE_MODEL[key] ?? MOVE_MODEL[heading >= 0 ? "W1|6+|a2" : "S4+|6+"];
    const ref = heading >= 0 ? heading : towards < 0 ? 0 : towards;
    const next: RivalRead["next"] = [];
    let stay = model.stay ?? 0;
    for (let o = -3; o <= 4; o++) {
      const p = model[String(o)] ?? 0;
      const dir = (((ref + o) % 8) + 8) % 8;
      const t = { x: tile.x + DIRS[dir].x, y: tile.y + DIRS[dir].y };
      // It may step onto our tile when we leave it.
      if (!walkable(t) || (occupied.has(keyOf(t)) && !(t.x === cur.x && t.y === cur.y))) {
        stay += p;
        continue;
      }
      next.push({ tile: t, p, cls: heading >= 0 ? turnAbs(heading, dir) : 5 });
    }
    next.push({ tile, p: stay, cls: 6 });
    return { tile, heading, still, next };
  }

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
      if (r.defenderId >= 0) {
        this.out.add(r.defenderId);
        this.outAt.set(r.defenderId, r.timestamp);
      }
    }
  }
}
