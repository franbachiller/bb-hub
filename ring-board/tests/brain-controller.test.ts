import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { EntityStatePayload, ServerStateSnapshot } from "../src/shared/protocol.js";
import { BrainController } from "../src/solver/brain-controller.js";
import { OpponentMemoryStore } from "../src/store/opponent-memory.js";

function buildEntity(id: number, x: number, y: number, isSelf = false): EntityStatePayload {
  return {
    id,
    isSelf,
    x,
    y,
    fromX: x,
    fromY: y,
    toX: x,
    toY: y,
    dirX: 0,
    dirY: 0,
    stepStartAt: 100,
    stepDur: 550,
    phase: 0,
    moving: false,
    targetLock: false,
    combatState: null
  };
}

function buildSnapshot(
  nowTs: number,
  nowWall: number,
  entities: EntityStatePayload[]
): ServerStateSnapshot {
  return {
    nowTs,
    nowWall,
    frameTs: nowTs,
    frameWall: nowWall,
    armed: true,
    scene: {
      sceneHash: "ring_test_hash",
      width: 28,
      height: 27,
      matrix: Array.from({ length: 27 }, () => Array.from({ length: 28 }, () => 0)),
      walkableMatrix: Array.from({ length: 27 }, () => Array.from({ length: 28 }, () => 0)),
      blocked: [],
      timestamp: nowTs,
      allowed: true,
      policy: "allowed"
    },
    entities,
    selection: {
      rawSelectedTarget: -1,
      pendingTarget: -1,
      lockedTarget: -1,
      punchTarget: -1,
      derivedTarget: -1
    },
    lastResolve: null,
    round: {
      phase: "LIVE",
      roundId: 1,
      sceneHash: "ring_test_hash",
      sinceTs: nowTs - 50,
      liveForMs: 50,
      enemyCount: entities.filter((entity) => !entity.isSelf).length,
      selfAlive: true,
      summary: "LIVE"
    },
    targetId: -1,
    window: null,
    strikeWindow: null,
    brain: null,
    lastFire: null
  };
}

describe("brain controller", () => {
  it("commits when a hot contact is available", () => {
    const controller = createController();
    const self = buildEntity(7, 10, 10, true);
    const hot = buildEntity(4, 11, 11, false);
    const far = buildEntity(2, 20, 20, false);
    const decision = controller.decide(buildSnapshot(200, 5000, [self, hot, far]));
    expect(decision).not.toBeNull();
    expect(decision?.mode).toBe("COMMIT");
    expect(decision?.targetId).toBe(4);
  });

  it("stays proactive against static corner campers when there is no contact", () => {
    const controller = createController();
    const self = buildEntity(7, 14, 14, true);
    const corner = buildEntity(1, 0, 0, false);
    const other = buildEntity(2, 24, 24, false);
    let decision = null;
    for (let i = 0; i < 5; i += 1) {
      decision = controller.decide(buildSnapshot(100 + i * 50, 3000 + i * 50, [self, corner, other]));
    }
    expect(decision).not.toBeNull();
    expect([1, 2]).toContain(decision?.targetId);
    expect(["LURE", "FEINT", "STALK", "SEEK", "INTERCEPT", "COMMIT"]).toContain(decision?.mode);
  });

  it("stays in a defensive local mode when two enemies collapse on self", () => {
    const controller = createController();
    const self = buildEntity(7, 10, 10, true);
    const left = buildEntity(4, 8.5, 10, false);
    left.moving = true;
    left.toX = 9;
    left.toY = 10;
    left.dirX = 1;
    const right = buildEntity(5, 11.5, 10, false);
    right.moving = true;
    right.toX = 11;
    right.toY = 10;
    right.dirX = -1;
    const decision = controller.decide(buildSnapshot(300, 7000, [self, left, right]));
    expect(decision).not.toBeNull();
    expect(["EVADE", "INTERCEPT", "COMMIT"]).toContain(decision?.mode);
    expect([4, 5]).toContain(decision?.targetId);
  });

  it("prefers the nearby engaged attacker over a far camper", () => {
    const controller = createController();
    const self = buildEntity(7, 10, 10, true);
    const near = buildEntity(4, 12, 10, false);
    near.moving = true;
    near.fromX = 13;
    near.toX = 12;
    near.dirX = -1;
    near.phase = 0.55;

    const farCamper = buildEntity(2, 0, 0, false);
    let decision = null;
    for (let i = 0; i < 6; i += 1) {
      decision = controller.decide(buildSnapshot(1000 + i * 50, 5000 + i * 50, [self, near, farCamper]));
    }
    expect(decision).not.toBeNull();
    expect(decision?.targetId).toBe(4);
    expect(["COMMIT", "INTERCEPT", "EVADE", "STALK"]).toContain(decision?.mode);
  });

  it("commits against an exposed idle enemy instead of orbiting", () => {
    const controller = createController();
    const self = buildEntity(7, 10, 10, true);
    const exposed = buildEntity(4, 14, 10, false);
    const far = buildEntity(2, 24, 24, false);
    let decision = null;
    for (let i = 0; i < 6; i += 1) {
      decision = controller.decide(buildSnapshot(2000 + i * 50, 9000 + i * 50, [self, exposed, far]));
    }
    expect(decision).not.toBeNull();
    expect(decision?.targetId).toBe(4);
    expect(["PUNISH", "COMMIT", "INTERCEPT"]).toContain(decision?.mode);
  });

  it("enters commit mode against a quiet isolated target", () => {
    const controller = createController();
    const self = buildEntity(7, 10, 10, true);
    const exposed = buildEntity(4, 15, 10, false);
    const far = buildEntity(2, 23, 23, false);
    let decision = null;
    for (let i = 0; i < 6; i += 1) {
      decision = controller.decide(buildSnapshot(3000 + i * 50, 11000 + i * 50, [self, exposed, far]));
    }
    expect(decision).not.toBeNull();
    expect(decision?.targetId).toBe(4);
    expect(decision?.mode).toBe("COMMIT");
  });

  it("keeps punish chain locked for a nearby exposed target", () => {
    const controller = createController();
    const self = buildEntity(7, 10, 10, true);
    const exposed = buildEntity(4, 14, 10, false);
    const decoy = buildEntity(5, 18, 10, false);
    let first = controller.decide(buildSnapshot(4000, 12000, [self, exposed, decoy]));
    expect(first).not.toBeNull();
    expect(first?.targetId).toBe(4);
    expect(["PUNISH", "COMMIT"]).toContain(first?.mode);

    decoy.x = 12.5;
    decoy.y = 11;
    decoy.fromX = 13;
    decoy.toX = 12;
    decoy.dirX = -1;
    decoy.moving = true;
    decoy.phase = 0.45;

    const second = controller.decide(buildSnapshot(4050, 12050, [self, exposed, decoy]));
    expect(second).not.toBeNull();
    expect(second?.targetId).toBe(4);
    expect(["PUNISH", "COMMIT", "INTERCEPT"]).toContain(second?.mode);
  });
});

function createController(): BrainController {
  const filePath = path.join(os.tmpdir(), "ring-board-brain-memory-test.json");
  const memory = new OpponentMemoryStore(filePath);
  memory.loadSync();
  return new BrainController(memory);
}
