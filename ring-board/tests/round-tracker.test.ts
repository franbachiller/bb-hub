import { describe, expect, it } from "vitest";
import { RoundTracker } from "../src/runtime/round-tracker.js";
import type { EntityStatePayload, ResolveEventPayload, ServerSceneState } from "../src/shared/protocol.js";

describe("round tracker", () => {
  it("opens a new live round when combat appears", () => {
    const tracker = new RoundTracker();
    const state = tracker.update({
      frameTs: 1000,
      frameWall: 2000,
      scene: scene("ring-a"),
      entities: [entity(7, true), entity(3, false)],
      lastResolve: null
    });
    expect(state.phase).toBe("LIVE");
    expect(state.roundId).toBe(1);
    expect(state.enemyCount).toBe(1);
  });

  it("marks lost when self disappears after a live round", () => {
    const tracker = new RoundTracker();
    tracker.update({
      frameTs: 1000,
      frameWall: 2000,
      scene: scene("ring-a"),
      entities: [entity(7, true), entity(3, false)],
      lastResolve: null
    });
    const lost = tracker.update({
      frameTs: 1400,
      frameWall: 2400,
      scene: scene("ring-a"),
      entities: [entity(3, false)],
      lastResolve: resolve(7, 3, 3, 3, 1300)
    });
    expect(lost.phase).toBe("LOST");
    expect(lost.selfAlive).toBe(false);
  });
});

function scene(hash: string): ServerSceneState {
  return {
    sceneHash: hash,
    width: 10,
    height: 10,
    matrix: Array.from({ length: 10 }, () => Array.from({ length: 10 }, () => 0)),
    walkableMatrix: Array.from({ length: 10 }, () => Array.from({ length: 10 }, () => 0)),
    blocked: [],
    timestamp: 0,
    allowed: true,
    policy: "allowed"
  };
}

function entity(id: number, isSelf: boolean): EntityStatePayload {
  return {
    id,
    isSelf,
    x: isSelf ? 4 : 6,
    y: 4,
    fromX: isSelf ? 4 : 6,
    fromY: 4,
    toX: isSelf ? 4 : 6,
    toY: 4,
    dirX: 0,
    dirY: 0,
    stepStartAt: 0,
    stepDur: 550,
    phase: 0,
    moving: false,
    targetLock: false,
    combatState: null
  };
}

function resolve(
  attackerId: number,
  defenderId: number,
  winner: number,
  targetId: number,
  timestamp: number
): ResolveEventPayload {
  return {
    attackerId,
    defenderId,
    winner,
    contested: false,
    targetId,
    timestamp
  };
}
