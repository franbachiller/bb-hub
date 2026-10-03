import { describe, expect, it } from "vitest";
import type { EntityStatePayload, ServerStateSnapshot } from "../src/shared/protocol.js";
import { resolveFocusResolution } from "../src/runtime/engagement-resolver.js";

function buildEntity(
  id: number,
  x: number,
  y: number,
  isSelf = false,
  overrides: Partial<EntityStatePayload> = {}
): EntityStatePayload {
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
    combatState: null,
    ...overrides
  };
}

function buildSnapshot(
  entities: EntityStatePayload[],
  targetId = -1
): ServerStateSnapshot {
  return {
    nowTs: 1000,
    nowWall: 2000,
    frameTs: 1000,
    frameWall: 2000,
    armed: true,
    scene: {
      sceneHash: "ring-focus",
      width: 14,
      height: 14,
      matrix: Array.from({ length: 14 }, () => Array.from({ length: 14 }, () => 0)),
      walkableMatrix: Array.from({ length: 14 }, () => Array.from({ length: 14 }, () => 0)),
      blocked: [],
      timestamp: 1000,
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
      sceneHash: "ring-focus",
      sinceTs: 900,
      liveForMs: 100,
      enemyCount: entities.filter((entity) => !entity.isSelf).length,
      selfAlive: true,
      summary: "LIVE"
    },
    targetId,
    window: null,
    strikeWindow: null,
    brain: null,
    lastFire: null
  };
}

describe("engagement resolver", () => {
  it("prefers an engaged local attacker over a far selected target", () => {
    const self = buildEntity(7, 5, 5, true);
    const local = buildEntity(4, 7, 5, false, {
      moving: true,
      fromX: 8,
      toX: 7,
      dirX: -1,
      phase: 0.45
    });
    const far = buildEntity(9, 0, 0, false);
    const resolution = resolveFocusResolution(buildSnapshot([self, local, far], 9));
    expect(resolution.focusTargetId).toBe(4);
    expect(resolution.attackerTargetId).toBe(4);
    expect(resolution.engagedIds).toContain(4);
    expect(resolution.attackerIds).toContain(4);
  });

  it("forces attacker focus over a nearby non-attacker", () => {
    const self = buildEntity(7, 5, 5, true);
    const attacker = buildEntity(4, 8, 5, false, {
      moving: true,
      fromX: 9,
      toX: 8,
      dirX: -1,
      phase: 0.35
    });
    const drifter = buildEntity(8, 4, 7, false, {
      moving: true,
      fromX: 4,
      toX: 4,
      dirX: 0,
      dirY: 1,
      phase: 0.35
    });
    const resolution = resolveFocusResolution(buildSnapshot([self, attacker, drifter], 8));
    expect(resolution.attackerTargetId).toBe(4);
    expect(resolution.attackerIds).toContain(4);
  });

  it("keeps using a far target only when there is no local threat", () => {
    const self = buildEntity(7, 5, 5, true);
    const farA = buildEntity(4, 0, 0, false);
    const farB = buildEntity(9, 12, 12, false);
    const resolution = resolveFocusResolution(buildSnapshot([self, farA, farB], 9));
    expect([4, 9]).toContain(resolution.focusTargetId);
    expect(resolution.localThreatCount).toBe(0);
  });

  it("ignores local targets stuck in react/busy animation", () => {
    const self = buildEntity(7, 5, 5, true);
    const invalidLocal = buildEntity(4, 6, 5, false, {
      combatState: {
        state: 2,
        busy: true,
        free: false,
        react: true,
        attack: false,
        frame: 3,
        total: 8,
        progress: 0.4,
        anim: "lose"
      }
    });
    const validOther = buildEntity(9, 7, 5, false, {
      moving: true,
      fromX: 8,
      toX: 7,
      dirX: -1,
      phase: 0.4
    });
    const resolution = resolveFocusResolution(buildSnapshot([self, invalidLocal, validOther], 4));
    expect(resolution.focusTargetId).toBe(9);
    expect(resolution.attackerTargetId).toBe(9);
  });
});
