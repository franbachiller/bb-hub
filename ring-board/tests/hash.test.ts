import { describe, expect, it } from "vitest";
import { computeSceneHash } from "../src/shared/hash.js";

describe("scene hash", () => {
  it("is stable for the same matrix", () => {
    const matrix = [
      [0, 1, 0],
      [0, 0, 1]
    ];
    expect(computeSceneHash(3, 2, matrix)).toBe(computeSceneHash(3, 2, matrix));
  });

  it("changes when a tile changes", () => {
    const a = [
      [0, 1, 0],
      [0, 0, 1]
    ];
    const b = [
      [0, 1, 0],
      [0, 1, 1]
    ];
    expect(computeSceneHash(3, 2, a)).not.toBe(computeSceneHash(3, 2, b));
  });
});
