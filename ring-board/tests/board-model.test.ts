import { describe, expect, it } from "vitest";
import { resolveTargetId } from "../src/store/board-model.js";

describe("board-model target resolution", () => {
  it("does not treat raw visual selection as authoritative movement target", () => {
    expect(
      resolveTargetId({
        rawSelectedTarget: 7,
        pendingTarget: 7,
        lockedTarget: -1,
        punchTarget: 7,
        derivedTarget: 7
      })
    ).toBe(-1);
  });

  it("keeps explicit locked target as authoritative", () => {
    expect(
      resolveTargetId({
        rawSelectedTarget: 7,
        pendingTarget: 7,
        lockedTarget: 9,
        punchTarget: 7,
        derivedTarget: 7
      })
    ).toBe(9);
  });
});
