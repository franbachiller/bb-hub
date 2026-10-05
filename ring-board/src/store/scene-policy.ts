import fs from "node:fs";
import path from "node:path";

export interface ScenePolicyFile {
  allowedCombatHashes: string[];
  ignoredHashes: string[];
}

const DEFAULT_POLICY: ScenePolicyFile = {
  allowedCombatHashes: [],
  ignoredHashes: []
};

export class ScenePolicyStore {
  private readonly filePath: string;

  private policy: ScenePolicyFile = { ...DEFAULT_POLICY };

  private armed = false;

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
    const parsed = JSON.parse(raw) as Partial<ScenePolicyFile>;
    this.policy = {
      allowedCombatHashes: Array.isArray(parsed.allowedCombatHashes)
        ? parsed.allowedCombatHashes.map(String)
        : [],
      ignoredHashes: Array.isArray(parsed.ignoredHashes)
        ? parsed.ignoredHashes.map(String)
        : []
    };
    if (!hasLocalFile) this.saveSync();
  }

  public saveSync(): void {
    this.ensureParentDir();
    fs.writeFileSync(this.filePath, JSON.stringify(this.policy, null, 2), "utf8");
  }

  public setArmed(value: boolean): void {
    this.armed = Boolean(value);
  }

  public isArmed(): boolean {
    return this.armed;
  }

  public getAllowedSceneHashes(): string[] {
    return [...this.policy.allowedCombatHashes];
  }

  public getIgnoredSceneHashes(): string[] {
    return [...this.policy.ignoredHashes];
  }

  public isAllowed(sceneHash: string): boolean {
    return this.policy.allowedCombatHashes.includes(sceneHash);
  }

  public isIgnored(sceneHash: string): boolean {
    return this.policy.ignoredHashes.includes(sceneHash);
  }

  public policyState(sceneHash: string): "allowed" | "ignored" | "unknown" {
    if (this.isAllowed(sceneHash)) {
      return "allowed";
    }
    if (this.isIgnored(sceneHash)) {
      return "ignored";
    }
    return "unknown";
  }

  public markSceneAllowed(sceneHash: string): void {
    this.policy.allowedCombatHashes = unique(
      this.policy.allowedCombatHashes.concat(sceneHash)
    );
    this.policy.ignoredHashes = this.policy.ignoredHashes.filter(
      (value) => value !== sceneHash
    );
    this.saveSync();
  }

  public ignoreScene(sceneHash: string): void {
    this.policy.ignoredHashes = unique(this.policy.ignoredHashes.concat(sceneHash));
    this.policy.allowedCombatHashes = this.policy.allowedCombatHashes.filter(
      (value) => value !== sceneHash
    );
    this.saveSync();
  }

  private ensureParentDir(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values.map(String))];
}
