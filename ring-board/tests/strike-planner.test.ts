import { describe, expect, it } from "vitest";
import type { EntityStatePayload, ServerStateSnapshot } from "../src/shared/protocol.js";
import { selectStrikeWindow } from "../src/solver/strike-planner.js";

function entity(
  input: Partial<EntityStatePayload> &
    Pick<EntityStatePayload, "id" | "isSelf" | "x" | "y" | "fromX" | "fromY" | "toX" | "toY" | "dirX" | "dirY" | "moving">
): EntityStatePayload {
  return {
    id: input.id,
    isSelf: input.isSelf,
    x: input.x,
    y: input.y,
    fromX: input.fromX,
    fromY: input.fromY,
    toX: input.toX,
    toY: input.toY,
    dirX: input.dirX,
    dirY: input.dirY,
    stepStartAt: 1000,
    stepDur: 550,
    phase: input.moving ? 0.45 : 0,
    moving: input.moving,
    targetLock: false,
    combatState: null
  };
}

function snapshot(entities: EntityStatePayload[], targetId: number): ServerStateSnapshot {
  return {
    nowTs: 1200,
    nowWall: 2200,
    frameTs: 1200,
    frameWall: 2200,
    armed: true,
    scene: {
      sceneHash: "strike-nearest",
      width: 10,
      height: 10,
      matrix: Array.from({ length: 10 }, () => Array.from({ length: 10 }, () => 0)),
      walkableMatrix: Array.from({ length: 10 }, () => Array.from({ length: 10 }, () => 0)),
      blocked: [],
      timestamp: 1200,
      allowed: true,
      policy: "allowed"
    },
    entities,
    selection: {
      rawSelectedTarget: targetId,
      pendingTarget: -1,
      lockedTarget: -1,
      punchTarget: -1,
      derivedTarget: targetId
    },
    lastResolve: null,
    round: {
      phase: "LIVE",
      roundId: 1,
      sceneHash: "strike-nearest",
      sinceTs: 1100,
      liveForMs: 100,
      enemyCount: entities.filter((current) => !current.isSelf).length,
      selfAlive: true,
      summary: "LIVE"
    },
    targetId,
    window: null,
    strikeWindow: null,
    brain: {
      mode: "COMMIT",
      reason: "TEST",
      targetId,
      score: 8,
      pressure: 1,
      anchorTargetId: targetId,
      anchorAgeMs: 120,
      switchLockedUntil: 2600,
      timingConfidence: 0.82,
      threatCount: 1,
      campScore: 0,
      planScore: 8.4,
      enemyTags: []
    },
    lastFire: null
  };
}

describe("strike planner", () => {
  it("prefers the nearest local target over a farther selected target", () => {
    const self = entity({
      id: 7,
      isSelf: true,
      x: 5,
      y: 5,
      fromX: 5,
      fromY: 5,
      toX: 5,
      toY: 5,
      dirX: 0,
      dirY: 0,
      moving: false
    });
    const near = entity({
      id: 4,
      isSelf: false,
      x: 6,
      y: 6,
      fromX: 6,
      fromY: 6,
      toX: 6,
      toY: 6,
      dirX: 0,
      dirY: 0,
      moving: false
    });
    const farSelected = entity({
      id: 8,
      isSelf: false,
      x: 8,
      y: 8,
      fromX: 8,
      fromY: 8,
      toX: 8,
      toY: 8,
      dirX: 0,
      dirY: 0,
      moving: false
    });

    const result = selectStrikeWindow(snapshot([self, near, farSelected], 8), null);
    expect(result).not.toBeNull();
    expect(result?.targetId).toBe(4);
    expect(result?.sourceTargetId).toBe(4);
  });

  it("skips a nearest target that is already in busy/react animation", () => {
    const self = entity({
      id: 7,
      isSelf: true,
      x: 5,
      y: 5,
      fromX: 5,
      fromY: 5,
      toX: 5,
      toY: 5,
      dirX: 0,
      dirY: 0,
      moving: false
    });
    const invalidNear = entity({
      id: 4,
      isSelf: false,
      x: 6,
      y: 5,
      fromX: 6,
      fromY: 5,
      toX: 6,
      toY: 5,
      dirX: 0,
      dirY: 0,
      moving: false
    });
    invalidNear.combatState = {
      state: 2,
      busy: true,
      free: false,
      react: true,
      attack: false,
      frame: 2,
      total: 8,
      progress: 0.3,
      anim: "lose"
    };
    const validNext = entity({
      id: 8,
      isSelf: false,
      x: 6,
      y: 6,
      fromX: 6,
      fromY: 6,
      toX: 6,
      toY: 6,
      dirX: 0,
      dirY: 0,
      moving: false
    });

    const result = selectStrikeWindow(snapshot([self, invalidNear, validNext], 4), null);
    expect(result).not.toBeNull();
    expect(result?.targetId).toBe(8);
  });
});
