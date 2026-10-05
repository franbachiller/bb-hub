import fs from "node:fs";
import path from "node:path";
const ARCHETYPES = [
    "camper",
    "chaser",
    "side-stepper",
    "hesitant",
    "collapser"
];
function defaultEntry() {
    return {
        seen: 0,
        commits: 0,
        lures: 0,
        evades: 0,
        lastSeenTs: 0
    };
}
function defaultFile() {
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
    constructor(filePath) {
        this.memory = defaultFile();
        this.filePath = filePath;
    }
    loadSync(seedFilePath) {
        const hasLocalFile = fs.existsSync(this.filePath);
        const readPath = hasLocalFile ? this.filePath : seedFilePath;
        if (!readPath || !fs.existsSync(readPath)) {
            this.saveSync();
            return;
        }
        const raw = fs.readFileSync(readPath, "utf8");
        const parsed = JSON.parse(raw);
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
        if (!hasLocalFile)
            this.saveSync();
    }
    saveSync() {
        this.ensureParentDir();
        fs.writeFileSync(this.filePath, JSON.stringify(this.memory, null, 2), "utf8");
    }
    observe(archetype, nowTs) {
        const entry = this.memory.archetypes[archetype];
        entry.seen += 1;
        entry.lastSeenTs = nowTs;
    }
    markCommit(archetype) {
        this.memory.archetypes[archetype].commits += 1;
    }
    markLure(archetype) {
        this.memory.archetypes[archetype].lures += 1;
    }
    markEvade(archetype) {
        this.memory.archetypes[archetype].evades += 1;
    }
    getBias(archetype) {
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
    ensureParentDir() {
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    }
}
