import fs from "node:fs";
import path from "node:path";
const DEFAULT_POLICY = {
    allowedCombatHashes: [],
    ignoredHashes: []
};
export class ScenePolicyStore {
    constructor(filePath) {
        this.policy = { ...DEFAULT_POLICY };
        this.armed = false;
        this.filePath = filePath;
    }
    loadSync() {
        if (!fs.existsSync(this.filePath)) {
            this.ensureParentDir();
            this.saveSync();
            return;
        }
        const raw = fs.readFileSync(this.filePath, "utf8");
        const parsed = JSON.parse(raw);
        this.policy = {
            allowedCombatHashes: Array.isArray(parsed.allowedCombatHashes)
                ? parsed.allowedCombatHashes.map(String)
                : [],
            ignoredHashes: Array.isArray(parsed.ignoredHashes)
                ? parsed.ignoredHashes.map(String)
                : []
        };
    }
    saveSync() {
        this.ensureParentDir();
        fs.writeFileSync(this.filePath, JSON.stringify(this.policy, null, 2), "utf8");
    }
    setArmed(value) {
        this.armed = Boolean(value);
    }
    isArmed() {
        return this.armed;
    }
    getAllowedSceneHashes() {
        return [...this.policy.allowedCombatHashes];
    }
    getIgnoredSceneHashes() {
        return [...this.policy.ignoredHashes];
    }
    isAllowed(sceneHash) {
        return this.policy.allowedCombatHashes.includes(sceneHash);
    }
    isIgnored(sceneHash) {
        return this.policy.ignoredHashes.includes(sceneHash);
    }
    policyState(sceneHash) {
        if (this.isAllowed(sceneHash)) {
            return "allowed";
        }
        if (this.isIgnored(sceneHash)) {
            return "ignored";
        }
        return "unknown";
    }
    markSceneAllowed(sceneHash) {
        this.policy.allowedCombatHashes = unique(this.policy.allowedCombatHashes.concat(sceneHash));
        this.policy.ignoredHashes = this.policy.ignoredHashes.filter((value) => value !== sceneHash);
        this.saveSync();
    }
    ignoreScene(sceneHash) {
        this.policy.ignoredHashes = unique(this.policy.ignoredHashes.concat(sceneHash));
        this.policy.allowedCombatHashes = this.policy.allowedCombatHashes.filter((value) => value !== sceneHash);
        this.saveSync();
    }
    ensureParentDir() {
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    }
}
function unique(values) {
    return [...new Set(values.map(String))];
}
