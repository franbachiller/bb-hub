import { describe, expect, it } from "vitest";
import { TileBrain } from "../src/solver/tile-brain.js";
import type { EntityStatePayload, ResolveEventPayload, ServerStateSnapshot } from "../src/shared/protocol.js";

const NOW = 100000;

function entity(partial: Partial<EntityStatePayload> & { id: number; x: number; y: number }): EntityStatePayload {
  return {
    isSelf: false,
    fromX: partial.x,
    fromY: partial.y,
    toX: partial.x,
    toY: partial.y,
    dirX: 0,
    dirY: 0,
    stepStartAt: NOW - 5000, // standing
    stepDur: 600,
    phase: 1,
    moving: false,
    targetLock: false,
    combatState: null,
    ...partial
  };
}

function snapshot(entities: EntityStatePayload[], lastResolve: ResolveEventPayload | null = null): ServerStateSnapshot {
  const grid = Array.from({ length: 28 }, () => Array.from({ length: 28 }, () => 0));
  return {
    nowTs: NOW,
    nowWall: NOW,
    frameTs: NOW,
    frameWall: NOW,
    armed: true,
    scene: {
      sceneHash: "ring",
      width: 28,
      height: 28,
      matrix: grid,
      walkableMatrix: grid,
      blocked: [],
      timestamp: NOW,
      allowed: true,
      policy: "allowed"
    },
    entities,
    selection: null,
    lastResolve,
    round: { phase: "LIVE", roundId: 1, sceneHash: "ring", sinceTs: NOW - 10000, liveForMs: 10000, enemyCount: entities.length - 1, selfAlive: true, summary: "LIVE" },
    targetId: -1,
    window: null,
    brain: null,
    lastFire: null,
    clients: [],
    arena: null as unknown as ServerStateSnapshot["arena"],
    adaptiveTuning: null
  } as ServerStateSnapshot;
}

const resolve = (attackerId: number, defenderId: number, timestamp: number): ResolveEventPayload => ({
  attackerId,
  defenderId,
  winner: attackerId,
  contested: false,
  targetId: defenderId,
  timestamp
});

describe("tile brain", () => {
  it("never walks next to a standing rival that is paying attention (it baits one step out)", () => {
    const brain = new TileBrain();
    // 2 has stood 5 s but just turned towards us (orient 2 = (-1,-1), our side)
    const plan = brain.evaluate(snapshot([entity({ id: 1, x: 12, y: 12, isSelf: true }), entity({ id: 2, x: 14, y: 14, facing: 2, lastTurnTs: NOW - 500 })]));
    const t = plan ? plan.primaryTile : { x: 12, y: 12 };
    expect(t.x - 14 === t.y - 14 && Math.abs(t.x - 14) === 1).toBe(false);
  });

  it("punishes a distracted standing rival (still 4 s+, no turn for 3 s, looking away)", () => {
    const brain = new TileBrain();
    const plan = brain.evaluate(snapshot([entity({ id: 1, x: 12, y: 12, isSelf: true }), entity({ id: 2, x: 14, y: 14, facing: 1, lastTurnTs: NOW - 6000 })]));
    expect(plan?.primaryTile).toEqual({ x: 13, y: 13 });
    expect(plan?.reason).toContain("punish-distracted");
  });

  it("does not punish a distracted rival when another free rival is close to that spot", () => {
    const brain = new TileBrain();
    const plan = brain.evaluate(snapshot([entity({ id: 1, x: 12, y: 12, isSelf: true }), entity({ id: 2, x: 14, y: 14, facing: 1, lastTurnTs: NOW - 6000 }), entity({ id: 3, x: 15, y: 12 })]));
    const t = plan ? plan.primaryTile : { x: 12, y: 12 };
    expect(t).not.toEqual({ x: 13, y: 13 });
  });

  it("walks into the way of a careless rival that walks into reach", () => {
    const brain = new TileBrain();
    // 2 keeps walking left along y = 13 (just stepped 16 -> 15): next it is at (14,13) most likely.
    const walker = entity({ id: 2, x: 15, y: 13, fromX: 16, fromY: 13, dirX: -1, dirY: 0, stepStartAt: NOW - 100, moving: true });
    const plan = brain.evaluate(snapshot([entity({ id: 1, x: 12, y: 12, isSelf: true }), walker]));
    expect(plan?.reason).toContain("intercept");
  });

  it("brakes when a walker is about to walk next to us (it walks in, we stand)", () => {
    const brain = new TileBrain();
    // 2 walks left along y = 13: its next tile (13,13) is next to where we stand.
    const walker = entity({ id: 2, x: 14, y: 13, fromX: 15, fromY: 13, dirX: -1, dirY: 0, stepStartAt: NOW - 100, moving: true });
    const plan = brain.evaluate(snapshot([entity({ id: 1, x: 12, y: 12, isSelf: true }), walker]));
    expect(plan).toBeNull();
  });

  it("still takes a walker with another free rival four tiles away (aggressive)", () => {
    const brain = new TileBrain();
    const walker = entity({ id: 2, x: 14, y: 13, fromX: 15, fromY: 13, dirX: -1, dirY: 0, stepStartAt: NOW - 100, moving: true });
    const plan = brain.evaluate(snapshot([entity({ id: 1, x: 12, y: 12, isSelf: true }), walker, entity({ id: 3, x: 16, y: 12 })]));
    expect(plan).toBeNull(); // brakes and lets 2 walk in
  });

  it("keeps out of tiles where two different walkers could step in (the click can only go to one)", () => {
    const brain = new TileBrain();
    // Two walkers heading for (14,14), a contact tile of (13,13): whichever gets there, we cannot know which.
    const w1 = entity({ id: 2, x: 15, y: 14, fromX: 16, fromY: 14, dirX: -1, dirY: 0, stepStartAt: NOW - 100, moving: true });
    const w2 = entity({ id: 3, x: 14, y: 15, fromX: 14, fromY: 16, dirX: 0, dirY: -1, stepStartAt: NOW - 100, moving: true });
    const plan = brain.evaluate(snapshot([entity({ id: 1, x: 12, y: 12, isSelf: true }), w1, w2]));
    const t = plan ? plan.primaryTile : { x: 12, y: 12 };
    expect(t).not.toEqual({ x: 13, y: 13 });
  });

  it("does not wait next to a rival whose punch animation is about to end", () => {
    const brain = new TileBrain();
    // 2 hit someone 13.7 s ago: it wakes in 300 ms, and we stand next to it.
    const plan = brain.evaluate(
      snapshot([entity({ id: 1, x: 12, y: 12, isSelf: true }), entity({ id: 2, x: 13, y: 13 }), entity({ id: 9, x: 25, y: 25 })], resolve(2, 9, NOW - 13700))
    );
    expect(plan).not.toBeNull();
    const t = plan!.primaryTile;
    expect(t.x - 13 === t.y - 13 && Math.abs(t.x - 13) === 1).toBe(false); // not next to 2 any more
  });

  it("with nobody near, closes in to engage range (2-3 tiles) without charging", () => {
    const brain = new TileBrain();
    const plan = brain.evaluate(snapshot([entity({ id: 1, x: 5, y: 5, isSelf: true }), entity({ id: 2, x: 15, y: 15 })]));
    expect(plan?.primaryTile).toEqual({ x: 6, y: 6 });
  });

  it("round start: nobody can punch yet, so it walks up and stands next to one rival for the unlock", () => {
    // our punches count again in 900 ms: the next tick (in 600 ms) is the last one before that
    const brain = new TileBrain();
    const self = entity({ id: 1, x: 12, y: 12, isSelf: true, lockUntilTs: NOW + 900 });
    const plan = brain.evaluate(snapshot([self, entity({ id: 2, x: 14, y: 14 }), entity({ id: 3, x: 20, y: 5 })]));
    expect(plan?.primaryTile).toEqual({ x: 13, y: 13 }); // next to 2 when the window ends: it would never charge it otherwise
    expect(plan?.reason).toContain("unlock-take");
    // with 3 s left it only closes in
    const early = new TileBrain().evaluate(snapshot([entity({ id: 1, x: 5, y: 5, isSelf: true, lockUntilTs: NOW + 3000 }), entity({ id: 2, x: 14, y: 14 })]));
    expect(early?.reason).toContain("unlock-approach");
  });

  it("ignores a rival eliminated in this ring", () => {
    const brain = new TileBrain();
    // 3 was eliminated by 4 long ago (4 is far away): 3 standing two tiles off is no target.
    const plan = brain.evaluate(
      snapshot([entity({ id: 1, x: 12, y: 12, isSelf: true }), entity({ id: 3, x: 14, y: 14 }), entity({ id: 4, x: 25, y: 3 })], resolve(4, 3, NOW - 20000))
    );
    expect(plan?.targetId ?? -1).not.toBe(3); // never its target (it may still walk past, towards the centre)
  });
});
