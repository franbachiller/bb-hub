import { describe, expect, it } from "vitest";
import { MoveController } from "../src/solver/move-controller.js";
import type { BrainState, EntityStatePayload, ServerStateSnapshot } from "../src/shared/protocol.js";

function buildSceneSnapshot(
  entities: EntityStatePayload[],
  brain: BrainState
): ServerStateSnapshot {
  return {
    nowTs: 1000,
    nowWall: 2000,
    frameTs: 1000,
    frameWall: 2000,
    armed: true,
    scene: {
      sceneHash: "ring-open",
      width: 7,
      height: 7,
      matrix: Array.from({ length: 7 }, () => Array.from({ length: 7 }, () => 0)),
      walkableMatrix: Array.from({ length: 7 }, () => Array.from({ length: 7 }, () => 0)),
      blocked: [],
      timestamp: 1000,
      allowed: true,
      policy: "allowed"
    },
    entities,
    selection: {
      rawSelectedTarget: brain.targetId,
      pendingTarget: -1,
      lockedTarget: -1,
      punchTarget: -1,
      derivedTarget: brain.targetId
    },
    lastResolve: null,
    round: {
      phase: "LIVE",
      roundId: 1,
      sceneHash: "ring-open",
      sinceTs: 960,
      liveForMs: 40,
      enemyCount: entities.filter((entity) => !entity.isSelf).length,
      selfAlive: true,
      summary: "LIVE"
    },
    targetId: brain.targetId,
    window: null,
    strikeWindow: null,
    brain,
    lastFire: null
  };
}

describe("move controller", () => {
  it("emits move_plan tiles around the projected contact zone", () => {
    const controller = new MoveController();
    const snapshot = buildSceneSnapshot(
      [
        entity({
          id: 4,
          isSelf: true,
          x: 2,
          y: 5,
          fromX: 2,
          fromY: 5,
          toX: 2,
          toY: 5,
          dirX: 0,
          dirY: 0,
          moving: false
        }),
        entity({
          id: 7,
          isSelf: false,
          x: 4,
          y: 2.5,
          fromX: 4,
          fromY: 2,
          toX: 4,
          toY: 3,
          dirX: 0,
          dirY: 1,
          moving: true
        })
      ],
      {
        mode: "COMMIT",
        reason: "HOT_DIAG",
        targetId: 7,
        score: 9,
        pressure: 1,
        anchorTargetId: 7,
        anchorAgeMs: 100,
        switchLockedUntil: 2600,
        timingConfidence: 0.9,
        threatCount: 1,
        campScore: 0,
        planScore: 9.5,
        enemyTags: []
      }
    );

    const command = controller.evaluate(snapshot, 2000);
    expect(command).not.toBeNull();
    expect(command?.type).toBe("move_plan");
    expect(command?.primaryTile).not.toEqual({ x: 2, y: 5 });
    expect(command?.targetId).toBe(7);
    expect(command?.planTiles?.length).toBeGreaterThanOrEqual(2);
    const future = { x: 4, y: 4 };
    const bestPlanCheb = Math.min(
      ...(command?.planTiles ?? []).map((tile) =>
        Math.max(Math.abs(tile.x - future.x), Math.abs(tile.y - future.y))
      )
    );
    expect(bestPlanCheb).toBeLessThanOrEqual(1);
  });

  it("avoids occupied tiles and keeps a backup option in bait mode", () => {
    const controller = new MoveController();
    const snapshot = buildSceneSnapshot(
      [
        entity({
          id: 4,
          isSelf: true,
          x: 3,
          y: 3,
          fromX: 3,
          fromY: 3,
          toX: 3,
          toY: 3,
          dirX: 0,
          dirY: 0,
          moving: false
        }),
        entity({
          id: 7,
          isSelf: false,
          x: 5,
          y: 3,
          fromX: 5,
          fromY: 3,
          toX: 5,
          toY: 3,
          dirX: 0,
          dirY: 0,
          moving: false
        }),
        entity({
          id: 8,
          isSelf: false,
          x: 4,
          y: 3,
          fromX: 4,
          fromY: 3,
          toX: 4,
          toY: 3,
          dirX: 0,
          dirY: 0,
          moving: false
        })
      ],
      {
        mode: "LURE",
        reason: "BAIT_7",
        targetId: 7,
        score: 4,
        pressure: 1,
        anchorTargetId: 7,
        anchorAgeMs: 100,
        switchLockedUntil: 2600,
        timingConfidence: 0.6,
        threatCount: 1,
        campScore: 4.2,
        planScore: 4.8,
        enemyTags: []
      }
    );

    const command = controller.evaluate(snapshot, 2000);
    expect(command).not.toBeNull();
    expect(command?.type).toBe("move_plan");
    expect(command?.primaryTile).not.toEqual({ x: 4, y: 3 });
    expect(command?.backupTile).not.toBeNull();
  });

  it("upgrades stale lure into commit against a reachable camper", () => {
    const controller = new MoveController();
    const snapshot = buildSceneSnapshot(
      [
        entity({
          id: 4,
          isSelf: true,
          x: 2,
          y: 3,
          fromX: 2,
          fromY: 3,
          toX: 2,
          toY: 3,
          dirX: 0,
          dirY: 0,
          moving: false
        }),
        entity({
          id: 7,
          isSelf: false,
          x: 5,
          y: 3,
          fromX: 5,
          fromY: 3,
          toX: 5,
          toY: 3,
          dirX: 0,
          dirY: 0,
          moving: false
        })
      ],
      {
        mode: "LURE",
        reason: "CAMP_7",
        targetId: 7,
        score: 6,
        pressure: 0,
        anchorTargetId: 7,
        anchorAgeMs: 700,
        switchLockedUntil: 2600,
        timingConfidence: 0.6,
        threatCount: 0,
        campScore: 5.2,
        planScore: 6.4,
        enemyTags: []
      }
    );

    const command = controller.evaluate(snapshot, 2000);
    expect(command).not.toBeNull();
    expect(command?.mode).toBe("COMMIT");
  });

  it("prefers a nearby attacker over a far anchored target", () => {
    const controller = new MoveController();
    const snapshot = buildSceneSnapshot(
      [
        entity({
          id: 4,
          isSelf: true,
          x: 3,
          y: 3,
          fromX: 3,
          fromY: 3,
          toX: 3,
          toY: 3,
          dirX: 0,
          dirY: 0,
          moving: false
        }),
        entity({
          id: 7,
          isSelf: false,
          x: 9,
          y: 9,
          fromX: 9,
          fromY: 9,
          toX: 9,
          toY: 9,
          dirX: 0,
          dirY: 0,
          moving: false
        }),
        entity({
          id: 8,
          isSelf: false,
          x: 4,
          y: 4,
          fromX: 5,
          fromY: 5,
          toX: 4,
          toY: 4,
          dirX: -1,
          dirY: -1,
          moving: true
        })
      ],
      {
        mode: "COMMIT",
        reason: "LOCAL_ATTACKER",
        targetId: 7,
        score: 8,
        pressure: 1,
        anchorTargetId: 7,
        anchorAgeMs: 100,
        switchLockedUntil: 2600,
        timingConfidence: 0.8,
        threatCount: 1,
        campScore: 0,
        planScore: 8.5,
        enemyTags: []
      }
    );
    snapshot.scene = {
      ...snapshot.scene!,
      width: 12,
      height: 12,
      matrix: Array.from({ length: 12 }, () => Array.from({ length: 12 }, () => 0)),
      walkableMatrix: Array.from({ length: 12 }, () => Array.from({ length: 12 }, () => 0))
    };
    snapshot.round.enemyCount = 2;

    const command = controller.evaluate(snapshot, 2000);
    expect(command).not.toBeNull();
    expect(command?.targetId).toBe(8);
  });
});

function entity(input: Partial<EntityStatePayload> & Pick<EntityStatePayload, "id" | "isSelf" | "x" | "y" | "fromX" | "fromY" | "toX" | "toY" | "dirX" | "dirY" | "moving">): EntityStatePayload {
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
    phase: input.moving ? 0.4 : 0,
    moving: input.moving,
    targetLock: false,
    combatState: null
  };
}
