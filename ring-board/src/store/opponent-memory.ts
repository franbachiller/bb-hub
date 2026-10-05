import fs from "node:fs";
import path from "node:path";
import type { OpponentArchetype } from "../shared/protocol.js";

export interface ArchetypeMemory {
  seen: number;
  commits: number;
  lures: number;
  evades: number;
  lastSeenTs: number;
}

export interface OpponentMemoryFile {
  version: 1;
  archetypes: Record<OpponentArchetype, ArchetypeMemory>;
}

const ARCHETYPES: OpponentArchetype[] = [
  "camper",
  "chaser",
  "side-stepper",
  "hesitant",
  "collapser"
];

function defaultEntry(): ArchetypeMemory {
  return {
    seen: 0,
    commits: 0,
    lures: 0,
    evades: 0,
    lastSeenTs: 0
  };
}

function defaultFile(): OpponentMemoryFile {
  return {
    version: 1,
    archetypes: {
      camper: defaultEntry(),
      chaser: defaultEntry(),
      "side-stepper": defaultEntry(),
      hesitant: defaultEntry(),
      collapser: defaultEntry()
    }
  };
}

export class OpponentMemoryStore {
  private readonly filePath: string;

  private memory: OpponentMemoryFile = defaultFile();

  public constructor(filePath: string) {
    this.filePath = filePath;
  }

  public loadSync(seedFilePath?: string): void {
    const hasLocalFile = fs.existsSync(this.filePath);
    const readPath = hasLocalFile ? this.filePath : seedFilePath;
    if (!readPath || !fs.existsSync(readPath)) {
      this.saveSync();
      return;
    }
    const raw = fs.readFileSync(readPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<OpponentMemoryFile>;
    const next = defaultFile();
    for (const archetype of ARCHETYPES) {
      const current = parsed.archetypes?.[archetype];
      if (current) {
        next.archetypes[archetype] = {
          seen: Number(current.seen) || 0,
          commits: Number(current.commits) || 0,
          lures: Number(current.lures) || 0,
          evades: Number(current.evades) || 0,
          lastSeenTs: Number(current.lastSeenTs) || 0
        };
      }
    }
    this.memory = next;
    if (!hasLocalFile) this.saveSync();
  }

  public saveSync(): void {
    this.ensureParentDir();
    fs.writeFileSync(this.filePath, JSON.stringify(this.memory, null, 2), "utf8");
  }

  public observe(archetype: OpponentArchetype, nowTs: number): void {
    const entry = this.memory.archetypes[archetype];
    entry.seen += 1;
    entry.lastSeenTs = nowTs;
  }

  public markCommit(archetype: OpponentArchetype): void {
    this.memory.archetypes[archetype].commits += 1;
  }

  public markLure(archetype: OpponentArchetype): void {
    this.memory.archetypes[archetype].lures += 1;
  }

  public markEvade(archetype: OpponentArchetype): void {
    this.memory.archetypes[archetype].evades += 1;
  }

  public getBias(archetype: OpponentArchetype): {
    attack: number;
    bait: number;
    evade: number;
    lure: number;
    feint: number;
  } {
    const entry = this.memory.archetypes[archetype];
    const seenBoost = Math.min(0.45, Math.log10(entry.seen + 1) * 0.18);
    switch (archetype) {
      case "camper":
        return {
          attack: -0.1,
          bait: 0.35 + seenBoost,
          evade: -0.05,
          lure: 0.4 + seenBoost,
          feint: 0.18
        };
      case "chaser":
        return {
          attack: 0.14 + seenBoost * 0.5,
          bait: 0.08,
          evade: 0.22 + seenBoost,
          lure: 0.05,
          feint: 0.14
        };
      case "side-stepper":
        return {
          attack: -0.04,
          bait: 0.05,
          evade: 0.08,
          lure: 0.12,
          feint: 0.28 + seenBoost
        };
      case "hesitant":
        return {
          attack: 0.02,
          bait: 0.16 + seenBoost * 0.4,
          evade: 0.02,
          lure: 0.28 + seenBoost,
          feint: 0.24 + seenBoost * 0.6
        };
      case "collapser":
        return {
          attack: 0.06,
          bait: -0.04,
          evade: 0.32 + seenBoost,
          lure: 0.06,
          feint: 0.1
        };
      default:
        return { attack: 0, bait: 0, evade: 0, lure: 0, feint: 0 };
    }
  }

  private ensureParentDir(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
  }
}
