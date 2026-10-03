import type { EntityStatePayload, MovePlanCommandMessage, ServerStateSnapshot, TilePoint } from "../shared/protocol.js";
import { MOVE_MODEL } from "./move-model.js";

// Tile brain: the ring as a board. Every player moves at most one king step per
// server tick (600 ms) and contact is only lateral (dx == dy == +-1). For each
// of our 9 options (stay + 8 steps) it reads every rival's next step from
// what they are doing and scores what can happen, plus the step after it
// (bait / set-ups). Numbers from the live captures of 25-26/09 unless noted.

const TICK_MS = 600;
// A 211 locks the attacker in its punch animation for 14 s and eliminates the
// defender until the round ends (live 26/09; the old tracker assumed 260 ms).
const HIT_LOCK_MS = 14000;
// Moved in the last tick: its step started within this.
const MOVED_RECENT_MS = 700;

// Rival next step (~40k rival ticks). A rival standing still stays 79-92% of
// the time (index = Chebyshev distance to us); one walking keeps walking.
const STAND_STAY_BY_DIST = [0.92, 0.92, 0.79, 0.86, 0.89, 0.91];
const WALK_STAY = 0.12;
const WALK_STAY_NEAR = 0.2;
// Turn of a walker's next step vs its last one: 0, 45, 90, 135, 180 degrees
// (45-135 per side). Mix of paths that go on (70%) and last steps (30%).
const TURN_WEIGHTS = [0.23, 0.098, 0.116, 0.098, 0.154];

// User's rule: never walk next to a rival that stands still - a standing
// player is often waiting with its click ready (26/09: we stepped next to a
// standing #4, Timing clicked at T+12, #4 won at T+94). Aggression is punishing
// mistakes: a rival that walks into our reach, and baiting from one step out.
const CHARGE_STANDING = -0.5;
// ...except a distracted one (user 27/09, from 81 of our fights stepping next to
// a standing rival, 64% overall): still 4 s+, no turn for 3 s and not facing us
// 72% (21-8); no step or turn seen at all (idle) 92% (11-1). Only when no other
// free rival is within 2 tiles of where we step.
const WIN_DISTRACTED = 0.72;
const WIN_IDLE = 0.85;
const DISTRACTED_STILL_MS = 4000;
const DISTRACTED_NO_TURN_MS = 3000;
const ORIENT_VEC: Record<number, TilePoint> = { 1: { x: 1, y: 1 }, 2: { x: -1, y: -1 }, 3: { x: 1, y: -1 }, 4: { x: -1, y: 1 }, 5: { x: 1, y: 0 }, 6: { x: 0, y: -1 }, 7: { x: 0, y: 1 }, 8: { x: -1, y: 0 } };
// Contacts made by a rival's own step (Timing aims its tick click at the
// likeliest one). The server holds a hit on a defender that walks much less
// than on one that stands (our hits: 76 vs 118 ms median): if we step into
// the contact too, the rival's click resolves almost at once (26/09: Negro and
// DarkNero won at T+12/13 while ours landed at T+16/19). So when a walker is
// coming into reach, brake and let it walk in; do not walk out to meet it.
const WIN_BOTH = 0.5;
const WIN_WAIT = 0.6;
// A walking rival is the careless one: extra weight on catching it.
const WALKER_BONUS = 0.15;
// "post" variant (sim only, 27/09): odds from the 246 fights after the tick
// boundary fix (analyze_fight_odds.js on 13:21+): we walk next to a rival that
// stays there 76% (still 1.2 s+, 53-17) / 71% (5-2, taken as 0.70); both step
// in 59%; it walks in while we stand 43% (15-20, and 43% before the fix too);
// a walking rival is not easier (path going on 55%, last step 67%).
const POST = { charge: 0.76, chargeFresh: 0.7, both: 0.59, wait: 0.43, walkerBonus: 0 };
// One step from contact with a standing rival: it gets scared and walks.
const BAIT = 0.03;
// Aggressive: a kill weighs this much more than a death.
const KILL_WEIGHT = 1.3;
// After our hit we stand locked 14 s where we hit, and ~0.2-0.4 s more before
// we can walk: the good players wait next to us for it (26/09: fights right
// after our unlock 10-10, a coin flip we can not walk away from). The chance
// that some free rival is there by then, from how near it is now; being caught
// there counts as a likely death. 27/09: at full weight (0.8 near, cost 1.0) every
// contact looked bad with 3+ players in the ring and the brain fled (284 "evade"
// moves in 4 minutes, circling the middle while they hit it). Softer: it takes a
// walker with one or two free rivals around, and stands down only when surrounded.
const AMBUSH_NEAR = 0.7; // within 4 tiles
const AMBUSH_MID = 0.45; // within 8
const AMBUSH_FAR = 0.2;
const AMBUSH_COST = 0.7;
// Two contacts in the same tick: Timing clicks one, the other clicks us.
const MULTI_CONTACT = -0.6;
// Not knowing WHICH rival steps in: Timing's click leaves ~170 ms before the
// tick, at the likeliest one; if another one steps in, our correction lands
// too late (26/09: Negro and kakaskerosa stepped in while the click went to
// the other candidate; the correction landed 7 and 11 ms after they resolved).
// Weighted by the chance that the one stepping in is not the likeliest.
const WRONG_TARGET = -0.5;
// Next to a rival as its animation ends: its own unlock click races ours
// (4-3 today): not worth being there.
const UNLOCK_RACE = -0.25;
// Do not dither: going straight back costs a little. Do not park either
// (user 26/09: it stood one tile from the enemy and waited): every tick we
// have stood still costs more, so the bait keeps moving around the rival.
const BACKTRACK = -0.05;
const STILL_PER_TICK = -0.05;
const STILL_MAX = -0.25;
// Baiting counts fully when we move into the bait tile, a little when we stay.
const BAIT_STAYING = 0.3;
const MOBILITY = 0.008;
// Where to be when nothing happens (no fixed spot; the "hold the centre" rule
// was dropped 27/09): 2-3 tiles from the nearest free rival - close enough to
// bait and punish whoever walks in, out of its reach this tick - never with a
// second free rival that near, and away from dead ends.
const ENGAGE_BAND = 0.05; // nearest free rival at 2-3 tiles
const ENGAGE_FAR = -0.012; // per tile beyond 3
const CROWD = -0.06; // each further free rival within 3 tiles
// Immune window (user 27/09): after the gong nobody's punch counts for 4.66 s,
// and in our coco nobody can hit us, but we can walk. Walk up to the rivals
// and, on the last tick before our punches count again, stand next to exactly
// one of them: the runtime's unlock click lands 1 ms after the edge, at it.
const IMMUNE_TAKE = 0.9; // x P(it is next to us when the window ends)
const IMMUNE_APPROACH = -0.03; // per tile to the nearest hittable rival

const DIRS: TilePoint[] = [
  { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }, { x: -1, y: 1 },
  { x: -1, y: 0 }, { x: -1, y: -1 }, { x: 0, y: -1 }, { x: 1, y: -1 }
];

interface Rival {
  id: number;
  tile: TilePoint;
  lockedUntil: number;
  // Next-tick tile distribution (only when free this tick).
  next: Array<{ tile: TilePoint; p: number }>;
  pStay: number;
  walking: boolean;
  standMs: number;
  lastTurnTs: number;
  facing: number;
  active: boolean;
}

// "attack" variant (tile3, user 29/09: bait, look for the step, get into the chaos).
// Fights with 2+ rivals near went 62% vs 55% with none (1189 fights), so extra free
// rivals near us are a small plus instead of a cost; ambush fear halved; bait and
// hunting pull stronger; standing still costs more.
const STYLE_BASE = { crowd: CROWD, bait: BAIT, baitStaying: BAIT_STAYING, ambushCost: AMBUSH_COST, engageBand: ENGAGE_BAND, engageFar: ENGAGE_FAR, stillPerTick: STILL_PER_TICK };
const STYLE_ATTACK = { crowd: 0.02, bait: 0.08, baitStaying: 0.3, ambushCost: 0.35, engageBand: 0.08, engageFar: -0.025, stillPerTick: -0.09 };

interface Option {
  tile: TilePoint;
  score: number;
  immediate: number;
  kind: string;
  targetId: number;
}

export class TileBrain {
  // variant "post": the live odds after the tick-boundary fix (sim only for now).
  // aggression (sim only, 27/09): KILL_WEIGHT as one value, or [5+ rivals alive,
  // 3-4, 2 or fewer] to find what wins the most rings (the monthly ranking).
  public constructor(private readonly variant: "base" | "post" | "attack" = "base", private readonly aggression: number[] | null = null) {
    this.style = variant === "attack" ? STYLE_ATTACK : STYLE_BASE;
  }
  private readonly style: typeof STYLE_BASE;
  private killWeight = KILL_WEIGHT;
  private roundKey = "";
  private lastResolveTs = -1;
  private readonly lockedUntil = new Map<number, number>();
  // Eliminated (the defender of a 211) -> when. Out for the rest of that ring:
  // nobody comes back. The ring-board's round id only changes with the room,
  // so a new ring is also seen when we walk again after being eliminated.
  private readonly out = new Map<number, number>();
  private selfTile: TilePoint | null = null;
  private prevSelfTile: TilePoint | null = null;
  private stillSince = 0;
  private nowTs = 0;

  public reset(): void {
    this.roundKey = "";
    this.lastResolveTs = -1;
    this.lockedUntil.clear();
    this.out.clear();
    this.selfTile = null;
    this.prevSelfTile = null;
    this.stillSince = 0;
  }

  public evaluate(snapshot: ServerStateSnapshot): MovePlanCommandMessage | null {
    if (!snapshot.armed || !snapshot.scene || snapshot.scene.policy !== "allowed") return null;
    const key = `${snapshot.round.roundId}:${snapshot.scene.sceneHash}`;
    if (key !== this.roundKey) {
      this.reset();
      this.roundKey = key;
    }
    if (snapshot.round.phase !== "LIVE") return null;
    this.noteResolve(snapshot);
    const self = snapshot.entities.find((entity) => entity.isSelf) ?? null;
    const selfOutAt = self ? this.out.get(self.id) : undefined;
    if (self && selfOutAt != null && self.stepStartAt > selfOutAt + 1500) {
      this.reset();
      this.roundKey = key;
    }
    if (!self || this.out.has(self.id)) return null;
    const now = snapshot.nowTs;
    this.nowTs = now;
    if ((this.lockedUntil.get(self.id) ?? 0) > now) return null; // our animation
    const cur = { x: self.toX, y: self.toY };
    if (!this.selfTile || this.selfTile.x !== cur.x || this.selfTile.y !== cur.y) {
      this.prevSelfTile = this.selfTile;
      this.selfTile = cur;
      this.stillSince = now;
    }
    const stillTicks = Math.floor((now - this.stillSince) / TICK_MS);

    const scene = snapshot.scene;
    const matrix = scene.walkableMatrix ?? scene.matrix;
    const walkable = (t: TilePoint) => {
      const v = matrix[t.y]?.[t.x];
      return v === 0 || v === 2;
    };
    const occupied = new Set<string>();
    for (const e of snapshot.entities) if (!e.isSelf) occupied.add(keyOf(e.toX, e.toY));
    const nextTick = now + TICK_MS;
    const rivals = snapshot.entities
      .filter((e) => !e.isSelf && !this.out.has(e.id))
      .map((e) => this.readRival(e, cur, now, walkable, occupied));
    const ag = this.aggression;
    this.killWeight = !ag || !ag.length ? KILL_WEIGHT : ag.length < 3 ? ag[0] : rivals.length >= 5 ? ag[0] : rivals.length >= 3 ? ag[1] : ag[2];
    if (!rivals.length) {
      // Everybody else is out: this ring is over (ids are dealt again next one).
      if (this.out.size) {
        this.reset();
        this.roundKey = key;
      }
      return null;
    }

    // Our punches do not count yet but we can walk (round start, our coco):
    // no risk while it lasts, only where to be when it ends.
    const immuneUntil = self.lockUntilTs ?? 0;
    const immune = immuneUntil > nextTick;
    const options: Option[] = [];
    for (const d of [{ x: 0, y: 0 }, ...DIRS]) {
      const tile = { x: cur.x + d.x, y: cur.y + d.y };
      const moving = d.x !== 0 || d.y !== 0;
      if (moving && (!walkable(tile) || occupied.has(keyOf(tile.x, tile.y)))) continue;
      const now1 = immune ? this.scoreImmune(tile, rivals, nextTick, immuneUntil) : this.scoreTile(tile, moving, rivals, nextTick);
      const bait = immune ? 0 : this.baitScore(tile, rivals, nextTick) * (moving ? 1 : this.style.baitStaying);
      let score = now1.score + bait;
      // Braking for one tick is free; standing longer costs more every tick.
      if (!moving) score += Math.max(STILL_MAX, this.style.stillPerTick * stillTicks);
      if (moving && this.prevSelfTile && tile.x === this.prevSelfTile.x && tile.y === this.prevSelfTile.y) score += BACKTRACK;
      let free = 0;
      for (const d3 of DIRS) {
        const t3 = { x: tile.x + d3.x, y: tile.y + d3.y };
        if (walkable(t3) && !occupied.has(keyOf(t3.x, t3.y))) free++;
      }
      score += MOBILITY * free + (immune ? 0 : this.positionScore(tile, rivals, nextTick));
      const kind = now1.kind === "idle" && bait > 0 ? "bait" : now1.kind;
      options.push({ tile, score, immediate: now1.score, kind, targetId: now1.targetId });
    }
    if (!options.length) return null;

    options.sort((a, b) => b.score - a.score);
    const best = options[0];
    if (best.tile.x === cur.x && best.tile.y === cur.y) return null;
    const backup = options.find((o) => o !== best && (o.tile.x !== cur.x || o.tile.y !== cur.y)) ?? null;
    return {
      type: "move_plan",
      targetId: best.targetId,
      reason: `${this.variant === "attack" ? "TILE3" : this.variant !== "base" ? "TILE2" : "TILE"} ${best.kind} ${best.score.toFixed(3)}`,
      mode: modeOf(best.kind),
      moveAt: Math.max(snapshot.nowWall, snapshot.frameWall + 1),
      primaryTile: best.tile,
      backupTile: backup ? backup.tile : null,
      planTiles: [best.tile],
      sceneHash: scene.sceneHash,
      issuedAtTs: snapshot.frameTs,
      expiresAtTs: snapshot.frameTs + 320
    };
  }

  // Is this standing rival not paying attention to us (and can we take it
  // without another free rival reaching us)? "idle", "distracted" or null.
  private distraction(r: Rival, tile: TilePoint, rivals: Rival[], tickAt: number): "idle" | "distracted" | null {
    if (r.walking) return null;
    for (const o of rivals) if (o !== r && o.lockedUntil <= tickAt && cheb(o.tile, tile) <= 2) return null;
    if (!r.active) return "idle";
    if (r.standMs < DISTRACTED_STILL_MS) return null;
    if (r.lastTurnTs > 0 && this.nowTs - r.lastTurnTs < DISTRACTED_NO_TURN_MS) return null;
    const v = ORIENT_VEC[r.facing];
    if (v && v.x * Math.sign(tile.x - r.tile.x) + v.y * Math.sign(tile.y - r.tile.y) > 0) return null; // looking our way
    return "distracted";
  }

  // Inside the immune window: close in, then take one rival as it ends.
  private scoreImmune(tile: TilePoint, rivals: Rival[], tickAt: number, until: number): { score: number; kind: string; targetId: number } {
    let score = 0;
    let targetId = -1;
    if (until - tickAt <= TICK_MS * 1.5) {
      const ps: number[] = [];
      let bestP = 0;
      for (const r of rivals) {
        if (r.lockedUntil > until + 50) continue; // still in its own animation/coco then
        let p = 0;
        for (const n of r.next) if (lateral(tile, n.tile)) p += n.p;
        if (p <= 0) continue;
        ps.push(p);
        score += IMMUNE_TAKE * p * (r.walking ? 0.8 : 1);
        if (p > bestP) {
          bestP = p;
          targetId = r.id;
        }
      }
      score += MULTI_CONTACT * probAtLeastTwo(ps);
      return { score, kind: targetId >= 0 ? "unlock-take" : "unlock-wait", targetId };
    }
    let best = Infinity;
    for (const r of rivals) {
      if (r.lockedUntil > until + 50) continue;
      const d = cheb(tile, r.tile) + (r.walking ? 1 : 0);
      if (d < best) {
        best = d;
        targetId = r.id;
      }
    }
    if (best < Infinity) score += IMMUNE_APPROACH * Math.max(0, best - 1);
    return { score, kind: "unlock-approach", targetId };
  }

  // Distance to the free rivals from here: engage range, crowding.
  private positionScore(tile: TilePoint, rivals: Rival[], tickAt: number): number {
    const ds = rivals.filter((r) => r.lockedUntil <= tickAt).map((r) => cheb(tile, r.tile)).sort((x, y) => x - y);
    if (!ds.length) return 0;
    let s = 0;
    const d = ds[0];
    if (d >= 2 && d <= 3) s += this.style.engageBand;
    else if (d > 3) s += this.style.engageFar * Math.min(12, d - 3);
    for (let i = 1; i < ds.length && ds[i] <= 3; i++) s += this.style.crowd;
    return s;
  }

  private noteResolve(snapshot: ServerStateSnapshot): void {
    const r = snapshot.lastResolve;
    if (!r || r.timestamp <= 0 || r.timestamp === this.lastResolveTs) return;
    this.lastResolveTs = r.timestamp;
    if (r.attackerId >= 0) this.lockedUntil.set(r.attackerId, r.timestamp + HIT_LOCK_MS);
    if (r.defenderId >= 0) this.out.set(r.defenderId, r.timestamp);
  }

  private readRival(
    e: EntityStatePayload,
    cur: TilePoint,
    now: number,
    walkable: (t: TilePoint) => boolean,
    occupied: Set<string>
  ): Rival {
    const tile = { x: e.toX, y: e.toY };
    const lockedUntil = Math.max(this.lockedUntil.get(e.id) ?? 0, e.lockUntilTs ?? 0);
    const dist = cheb(tile, cur);
    const d = Math.min(5, dist);
    const attn = { standMs: now - e.stepStartAt, lastTurnTs: e.lastTurnTs ?? 0, facing: e.facing ?? 0, active: e.active !== false };
    const moved = now - e.stepStartAt < MOVED_RECENT_MS && (e.dirX !== 0 || e.dirY !== 0);
    const lastDir = moved ? DIRS.findIndex((v) => v.x === Math.sign(e.dirX) && v.y === Math.sign(e.dirY)) : -1;
    const towards = DIRS.findIndex((v) => v.x === Math.sign(cur.x - tile.x) && v.y === Math.sign(cur.y - tile.y));
    // A tile it can step on (our own counts: when we step away it may walk into it).
    const open = (t: TilePoint) => walkable(t) && (!occupied.has(keyOf(t.x, t.y)) || (t.x === cur.x && t.y === cur.y));
    if (lockedUntil > now + TICK_MS) return { id: e.id, tile, lockedUntil, next: [{ tile, p: 1 }], pStay: 1, walking: moved, ...attn };

    // Learned model (move-model.ts): how it moves given what it was doing.
    const db = dist <= 1 ? "1" : dist <= 2 ? "2" : dist <= 3 ? "3" : dist <= 5 ? "4-5" : "6+";
    const standTicks = Math.max(1, Math.floor((now - e.stepStartAt) / TICK_MS));
    const key = moved
      ? `W${e.walkFlag === 0 ? 0 : 1}|${db}|a${Math.abs(turnOf(towards, lastDir))}`
      : `S${standTicks >= 4 ? "4+" : standTicks >= 2 ? "2-3" : "1"}|${db}`;
    const m = MOVE_MODEL[key];
    const ref = moved ? lastDir : towards;
    if (m && ref >= 0) {
      let pStay = m.stay;
      const next: Array<{ tile: TilePoint; p: number }> = [];
      for (let o = -3; o <= 4; o++) {
        const v = DIRS[(((ref + o) % 8) + 8) % 8];
        const t = { x: tile.x + v.x, y: tile.y + v.y };
        const p = m[String(o)] ?? 0;
        if (open(t)) next.push({ tile: t, p });
        else pStay += p; // a blocked step leaves it where it is
      }
      const total = pStay + next.reduce((acc, x) => acc + x.p, 0);
      return { id: e.id, tile, lockedUntil, next: [{ tile, p: pStay / total }, ...next.map((x) => ({ tile: x.tile, p: x.p / total }))], pStay: pStay / total, walking: moved, ...attn };
    }

    // No learned entry for this case: the coarse model.
    let pStay = moved ? (d <= 1 ? WALK_STAY_NEAR : WALK_STAY) : STAND_STAY_BY_DIST[d];
    const steps: Array<{ tile: TilePoint; w: number }> = [];
    DIRS.forEach((v, i) => {
      const t = { x: tile.x + v.x, y: tile.y + v.y };
      if (!open(t)) return;
      let w = 1;
      if (lastDir >= 0) {
        const turn = Math.min((i - lastDir + 8) % 8, (lastDir - i + 8) % 8);
        w = TURN_WEIGHTS[turn];
      }
      steps.push({ tile: t, w });
    });
    const total = steps.reduce((acc, x) => acc + x.w, 0);
    if (!steps.length || total <= 0) pStay = 1;
    const next = [{ tile, p: pStay }];
    for (const st of steps) next.push({ tile: st.tile, p: ((1 - pStay) * st.w) / total });
    return { id: e.id, tile, lockedUntil, next, pStay, walking: moved, ...attn };
  }

  // What can happen at the next tick if we stand on `tile` then.
  private scoreTile(tile: TilePoint, moving: boolean, rivals: Rival[], tickAt: number): { score: number; kind: string; targetId: number } {
    let score = 0;
    let kind = "idle";
    let targetId = -1;
    let bestPart = 0;
    const pContact: number[] = [];
    for (const r of rivals) {
      // In its animation (or waking up before the tick): next to it as it
      // wakes, its own unlock click races ours - not worth being there. We are
      // there at its end if we stand next to it now, or arrive before it ends.
      if (r.lockedUntil > tickAt - TICK_MS && r.lockedUntil <= tickAt + TICK_MS && lateral(tile, r.tile) &&
          (!moving || r.lockedUntil > tickAt)) {
        score += UNLOCK_RACE;
        if (Math.abs(UNLOCK_RACE) > Math.abs(bestPart)) {
          bestPart = UNLOCK_RACE;
          kind = "avoid-unlock";
          targetId = r.id;
        }
        continue;
      }
      if (r.lockedUntil > tickAt) continue; // harmless at this tick
      let pStayIn = 0;
      let pMoveIn = 0;
      for (const n of r.next) {
        if (!lateral(tile, n.tile)) continue;
        if (n.tile.x === r.tile.x && n.tile.y === r.tile.y) pStayIn += n.p;
        else pMoveIn += n.p;
      }
      const p = pStayIn + pMoveIn;
      if (p <= 0) continue;
      pContact.push(p);
      const ambush = this.ambushRisk(tile, r.id, rivals, tickAt);
      const ev = (win: number) => win * this.killWeight - (1 - win) - win * ambush;
      let part = 0;
      // Walking next to a rival that stays there: charging - never, unless it
      // is distracted and nobody else free can get to us there.
      let punishing = false;
      if (moving && pStayIn > 0) {
        const read = this.distraction(r, tile, rivals, tickAt);
        if (this.variant !== "base") {
          const charge = r.standMs >= 1200 ? POST.charge : POST.chargeFresh;
          part += pStayIn * ev(read === "idle" ? WIN_IDLE : Math.max(charge, read ? WIN_DISTRACTED : 0));
          punishing = true;
        } else if (read) {
          part += pStayIn * ev(read === "idle" ? WIN_IDLE : WIN_DISTRACTED);
          punishing = true;
        } else {
          part += pStayIn * CHARGE_STANDING;
        }
      }
      // The rival's own step brings it next to us: its mistake if it walks.
      const post = this.variant !== "base";
      const winIn = moving ? (post ? POST.both : WIN_BOTH) : post ? POST.wait : WIN_WAIT;
      const walkerBonus = post ? POST.walkerBonus : WALKER_BONUS;
      if (pMoveIn > 0) part += pMoveIn * (ev(winIn) + (r.walking ? walkerBonus * (1 - ambush) : 0));
      score += part;
      if (Math.abs(part) > Math.abs(bestPart)) {
        bestPart = part;
        targetId = r.id;
        kind = part > 0 ? (punishing ? "punish-distracted" : moving ? "intercept" : "brake") : moving && pStayIn > 0 ? "no-charge" : "evade";
      }
    }
    score += MULTI_CONTACT * probAtLeastTwo(pContact);
    if (pContact.length > 1) {
      const sum = pContact.reduce((a, b) => a + b, 0);
      score += WRONG_TARGET * (sum - Math.max(...pContact));
    }
    return { score, kind, targetId };
  }

  // One step from contact with a standing rival (not next to it): it has to
  // move - away, or into our reach. Only while no other rival can reach us too.
  private baitScore(tile: TilePoint, rivals: Rival[], tickAt: number): number {
    let s = 0;
    let reach = 0;
    for (const r of rivals) {
      if (r.lockedUntil > tickAt) continue;
      const dx = r.tile.x - tile.x;
      const dy = r.tile.y - tile.y;
      if (lateral(tile, r.tile) || !inReach(dx, dy)) continue;
      reach++;
      if (!r.walking) s += this.style.bait;
    }
    return reach > 1 ? 0 : s;
  }

  // Chance that some other free rival is next to us when our 14 s animation
  // ends (rivals out, or in an animation lasting past ours, can not be).
  private ambushRisk(tile: TilePoint, targetId: number, rivals: Rival[], tickAt: number): number {
    let none = 1;
    for (const r of rivals) {
      if (r.id === targetId) continue;
      if (r.lockedUntil > tickAt + HIT_LOCK_MS) continue;
      const d = cheb(tile, r.tile);
      none *= 1 - (d <= 4 ? AMBUSH_NEAR : d <= 8 ? AMBUSH_MID : AMBUSH_FAR);
    }
    return this.style.ambushCost * (1 - none);
  }

}

function modeOf(kind: string): MovePlanCommandMessage["mode"] {
  switch (kind) {
    case "unlock-take":
      return "COMMIT";
    case "unlock-approach":
    case "unlock-wait":
      return "INTERCEPT";
    case "punish-distracted":
      return "COMMIT";
    case "intercept":
      return "INTERCEPT";
    case "evade":
    case "no-charge":
    case "avoid-unlock":
      return "EVADE";
    case "hunt":
      return "SEEK";
    default:
      return "LURE";
  }
}

// One king step of either side turns offset (dx, dy) into a lateral contact.
function inReach(dx: number, dy: number): boolean {
  return (Math.abs(dx - 1) <= 1 && Math.abs(dy - 1) <= 1) || (Math.abs(dx + 1) <= 1 && Math.abs(dy + 1) <= 1);
}

// Turn from direction index a to b, in 45-degree steps: -3..4.
function turnOf(a: number, b: number): number {
  const t = (((b - a) % 8) + 8) % 8;
  return t > 4 ? t - 8 : t;
}

function lateral(a: TilePoint, b: TilePoint): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return dx === dy && Math.abs(dx) === 1;
}

function cheb(a: TilePoint, b: TilePoint): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

function keyOf(x: number, y: number): string {
  return `${x},${y}`;
}

// P(at least two of these independent contacts happen).
function probAtLeastTwo(ps: number[]): number {
  if (ps.length < 2) return 0;
  let none = 1;
  for (const p of ps) none *= 1 - p;
  let exactlyOne = 0;
  for (let i = 0; i < ps.length; i++) {
    let term = ps[i];
    for (let j = 0; j < ps.length; j++) if (j !== i) term *= 1 - ps[j];
    exactlyOne += term;
  }
  return Math.max(0, 1 - none - exactlyOne);
}
