import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { ScenePolicyStore } from "../src/store/scene-policy.js";
import { OpponentMemoryStore } from "../src/store/opponent-memory.js";

describe("Board profile persistence", () => {
  it("seeds policy once and preserves customer changes across restart", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-board-policy-"));
    const seed = path.join(dir, "bundled.json"), local = path.join(dir, "profile", "scene-policy.json");
    fs.writeFileSync(seed, JSON.stringify({ allowedCombatHashes: ["ring"], ignoredHashes: ["lobby"] }));
    const first = new ScenePolicyStore(local); first.loadSync(seed);
    first.markSceneAllowed("island"); first.ignoreScene("ring");
    const next = new ScenePolicyStore(local); next.loadSync(seed);
    expect(next.isAllowed("island")).toBe(true);
    expect(next.isIgnored("ring")).toBe(true);
    expect(JSON.parse(fs.readFileSync(seed, "utf8")).allowedCombatHashes).toEqual(["ring"]);
  });

  it("persists learned memory to the profile and retains it across worker restart", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-board-memory-"));
    const seed = path.join(dir, "bundled.json"), local = path.join(dir, "profile", "opponent-memory.json");
    const bundled = new OpponentMemoryStore(seed); bundled.loadSync(); bundled.observe("camper", 100); bundled.saveSync();
    const first = new OpponentMemoryStore(local); first.loadSync(seed); first.observe("camper", 200); first.saveSync();
    const next = new OpponentMemoryStore(local); next.loadSync(seed);
    expect(next.getBias("camper")).toEqual(first.getBias("camper"));
    expect(JSON.parse(fs.readFileSync(local, "utf8")).archetypes.camper.seen).toBe(2);
    expect(JSON.parse(fs.readFileSync(seed, "utf8")).archetypes.camper.seen).toBe(1);
  });
});
