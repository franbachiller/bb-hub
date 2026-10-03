import { describe, expect, it } from "vitest";
import { estimateSwfClock, FireController } from "../src/solver/fire-controller.js";
import type { ServerStateSnapshot } from "../src/shared/protocol.js";

function buildSnapshot(): ServerStateSnapshot {
  return {
    nowTs: 200,
    nowWall: 1000,
    frameTs: 200,
    frameWall: 1000,
    armed: true,
    scene: {
      sceneHash: "abcd1234",
      width: 3,
      height: 3,
      matrix: [
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0]
      ],
      walkableMatrix: [
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0]
      ],
      blocked: [],
      timestamp: 200,
      allowed: true,
      policy: "allowed"
    },
    entities: [
      {
        id: 4,
        isSelf: true,
        x: 1,
        y: 1,
        fromX: 1,
        fromY: 1,
        toX: 1,
        toY: 1,
        dirX: 0,
        dirY: 0,
        stepStartAt: 200,
        stepDur: 550,
        phase: 0,
        moving: false,
        targetLock: false,
        combatState: null
      },
      {
        id: 7,
        isSelf: false,
        x: 2,
        y: 2,
        fromX: 3,
        fromY: 3,
        toX: 2,
        toY: 2,
        dirX: -1,
        dirY: -1,
        stepStartAt: 200,
        stepDur: 550,
        phase: 0.45,
        moving: true,
        targetLock: false,
        combatState: null
      }
    ],
    selection: {
      rawSelectedTarget: 7,
      pendingTarget: -1,
      lockedTarget: -1,
      punchTarget: -1,
      derivedTarget: 7
    },
    lastResolve: null,
    round: {
      phase: "LIVE",
      roundId: 1,
      sceneHash: "abcd1234",
      sinceTs: 180,
      liveForMs: 20,
      enemyCount: 1,
      selfAlive: true,
      summary: "LIVE x1"
    },
    targetId: 7,
    window: {
      kind: "HOT",
      reason: "HOT_1_1",
      targetId: 7,
      sourceTargetId: 7,
      startAt: 8,
      bestAt: 12,
      endAt: 16,
      fireDelay: 4,
      deltaNowX: 2,
      deltaNowY: 2,
      deltaFutureX: 1,
      deltaFutureY: 1,
      relVelX: -1,
      relVelY: -1,
      signX: 1,
      signY: 1,
      score: 0.1,
      confidence: 0.88,
      hypothesis: "PLAN|CONTINUE_1",
      planAligned: true,
      widthMs: 8
    },
    strikeWindow: {
      kind: "HOT",
      reason: "HOT_1_1",
      targetId: 7,
      sourceTargetId: 7,
      startAt: 8,
      bestAt: 12,
      endAt: 16,
      fireDelay: 4,
      deltaNowX: 2,
      deltaNowY: 2,
      deltaFutureX: 1,
      deltaFutureY: 1,
      relVelX: -1,
      relVelY: -1,
      signX: 1,
      signY: 1,
      score: 0.1,
      confidence: 0.88,
      hypothesis: "PLAN|CONTINUE_1",
      planAligned: true,
      widthMs: 8
    },
    brain: null,
    lastFire: null
  };
}

describe("fire controller", () => {
  it("emits a fire plan and retries while the same window is alive", () => {
    const controller = new FireController();
    const snapshot = buildSnapshot();
    const first = controller.evaluate(snapshot, 1500);
    const second = controller.evaluate(snapshot, 1500);
    const third = controller.evaluate(snapshot, 1518);
    expect(first).not.toBeNull();
    expect(first?.burstOffsetsMs).toEqual([0, 38, 73, 106, 136, 164, 189, 212, 232, 250, 266, 280, 291, 301, 308, 314, 316, 318, 320]);
    expect(first?.requireSelection).toBe(false);
    expect(second).toBeNull();
    expect(third).not.toBeNull();
  });

  it("drops contested targets", () => {
    const controller = new FireController();
    const snapshot = buildSnapshot();
    snapshot.lastResolve = {
      attackerId: 9,
      defenderId: 1,
      winner: 9,
      contested: true,
      targetId: 7,
      timestamp: 150
    };
    expect(controller.evaluate(snapshot, 1500)).toBeNull();
  });

  it("arms a compressed hot burst around the opening edge", () => {
    const controller = new FireController();
    const snapshot = buildSnapshot();
    const burst = controller.evaluate(snapshot, 1500);
    expect(burst).not.toBeNull();
    expect(estimateSwfClock(snapshot)).toBe(260);
    expect((burst?.fireAtTs ?? 0)).toBeGreaterThanOrEqual(260);
    expect((burst?.fireAtTs ?? 0)).toBeLessThanOrEqual(680);
    expect(burst?.burstOffsetsMs).toEqual([0, 38, 73, 106, 136, 164, 189, 212, 232, 250, 266, 280, 291, 301, 308, 314, 316, 318, 320]);
  });

  it("does not burst on far approach windows", () => {
    const controller = new FireController();
    const snapshot = buildSnapshot();
    snapshot.entities[1] = {
      ...snapshot.entities[1],
      x: 8,
      y: 8,
      fromX: 8,
      fromY: 8,
      toX: 8,
      toY: 8,
      dirX: 0,
      dirY: 0,
      moving: false
    };
    snapshot.strikeWindow = {
      ...snapshot.strikeWindow!,
      kind: "APPROACH",
      bestAt: 40,
      startAt: 28,
      endAt: 58,
      fireDelay: 25
    };
    expect(controller.evaluate(snapshot, 1500)).toBeNull();
  });

  it("still emits when step-cadence detects a close crossing without strikeWindow", () => {
    const controller = new FireController();
    const snapshot = buildSnapshot();
    snapshot.strikeWindow = null;
    expect(controller.evaluate(snapshot, 1500)).not.toBeNull();
  });

  it("keeps the strike target chosen by the strike window", () => {
    const controller = new FireController();
    const snapshot = buildSnapshot();
    snapshot.entities[1] = {
      ...snapshot.entities[1],
      x: 3,
      y: 3,
      fromX: 4,
      fromY: 4,
      toX: 3,
      toY: 3
    };
    snapshot.entities.push({
      id: 9,
      isSelf: false,
      x: 1,
      y: 2,
      fromX: 1,
      fromY: 2,
      toX: 1,
      toY: 2,
      dirX: 0,
      dirY: 0,
      stepStartAt: 200,
      stepDur: 550,
      phase: 0,
      moving: false,
      targetLock: false,
      combatState: null
    });
    const first = controller.evaluate(snapshot, 1500);
    expect(first).not.toBeNull();
    expect(first?.targetId).toBe(7);
  });
});
