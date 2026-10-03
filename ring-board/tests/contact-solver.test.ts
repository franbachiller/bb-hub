import { describe, expect, it } from "vitest";
import {
  contactClass,
  predictContactWindow,
  predictBestWindowForSelf,
  predictWindowForEntities,
  ringTargetDistance,
  type ContinuousState
} from "../src/solver/contact-solver.js";
import type { EntityStatePayload } from "../src/shared/protocol.js";

describe("contact solver", () => {
  it("detects a fast 2-tile approach into contact", () => {
    const self: ContinuousState = {
      id: 1,
      moving: true,
      from: { x: 0, y: 0 },
      to: { x: 1, y: 0 },
      pos: { x: 0, y: 0 },
      dir: { x: 1, y: 0 },
      dur: 100,
      remain: 100,
      age: 0,
      p: 0,
      nextDur: 100,
      future: [{ x: 2, y: 0 }]
    };
    const target: ContinuousState = {
      id: 2,
      moving: true,
      from: { x: 2, y: 2 },
      to: { x: 2, y: 1 },
      pos: { x: 2, y: 2 },
      dir: { x: 0, y: -1 },
      dur: 100,
      remain: 100,
      age: 0,
      p: 0,
      nextDur: 100,
      future: [{ x: 2, y: 0 }]
    };
    const window = predictContactWindow(self, target, 160, 4);
    expect(window).not.toBeNull();
    expect(["HOT", "DIAG", "STAGE", "APPROACH"]).toContain(window?.kind);
  });

  it("rejects false diagonals with opposite signs", () => {
    expect(contactClass(1, -1)).toBeNull();
  });

  it("rejects orthogonal adjacency because ring only hits on lateral side-band", () => {
    expect(contactClass(1, 0)).toBeNull();
    expect(contactClass(0, 1)).toBeNull();
  });

  it("treats same-sign side-band targets as closer than opposite-band neighbors", () => {
    const self = { x: 10, y: 10 };
    expect(ringTargetDistance(self, { x: 11, y: 11 })).toBeLessThan(
      ringTargetDistance(self, { x: 11, y: 9 })
    );
  });

  it("keeps signed orientation in the predicted output", () => {
    const baseEntity = (id: number, x: number, y: number): EntityStatePayload => ({
      id,
      isSelf: id === 1,
      x,
      y,
      fromX: x,
      fromY: y,
      toX: x,
      toY: y,
      dirX: 0,
      dirY: 0,
      stepStartAt: 10,
      stepDur: 100,
      phase: 0,
      moving: false,
      targetLock: false,
      combatState: null
    });

    const a = predictWindowForEntities(baseEntity(1, 0, 0), baseEntity(2, 1, 1), 20);
    const b = predictWindowForEntities(baseEntity(1, 0, 0), baseEntity(2, -1, -1), 20);

    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a?.signX).toBe(1);
    expect(a?.signY).toBe(1);
    expect(b?.signX).toBe(-1);
    expect(b?.signY).toBe(-1);
  });

  it("picks best target window across all enemies", () => {
    const self: EntityStatePayload = {
      id: 1,
      isSelf: true,
      x: 10,
      y: 10,
      fromX: 10,
      fromY: 10,
      toX: 10,
      toY: 10,
      dirX: 0,
      dirY: 0,
      stepStartAt: 10,
      stepDur: 100,
      phase: 0,
      moving: false,
      targetLock: false,
      combatState: null
    };
    const far: EntityStatePayload = {
      id: 2,
      isSelf: false,
      x: 14,
      y: 14,
      fromX: 14,
      fromY: 14,
      toX: 14,
      toY: 14,
      dirX: 0,
      dirY: 0,
      stepStartAt: 10,
      stepDur: 100,
      phase: 0,
      moving: false,
      targetLock: false,
      combatState: null
    };
    const hot: EntityStatePayload = {
      id: 3,
      isSelf: false,
      x: 11,
      y: 11,
      fromX: 11,
      fromY: 11,
      toX: 11,
      toY: 11,
      dirX: 0,
      dirY: 0,
      stepStartAt: 10,
      stepDur: 100,
      phase: 0,
      moving: false,
      targetLock: false,
      combatState: null
    };

    const result = predictBestWindowForSelf(self, [self, far, hot], 20, -1);
    expect(result).not.toBeNull();
    expect(result?.targetId).toBe(3);
    expect(["HOT", "DIAG"]).toContain(result?.kind);
  });
});
