export class RoundTracker {
    constructor() {
        this.phase = "IDLE";
        this.roundId = 0;
        this.phaseSinceTs = 0;
        this.phaseSinceWall = 0;
        this.lastLiveAt = 0;
        this.liveSinceTs = 0;
        this.lastSceneHash = "";
        this.lastSelfAlive = false;
        this.lastEnemyCount = 0;
        this.lastRelevantResolveTs = -1;
        this.lastRelevantResolveWinner = -1;
    }
    update(input) {
        const self = input.entities.find((entity) => entity.isSelf) ?? null;
        const enemyCount = input.entities.filter((entity) => !entity.isSelf && entity.id !== self?.id).length;
        const sceneHash = input.scene?.sceneHash ?? null;
        const live = Boolean(input.scene && input.scene.policy === "allowed" && self && enemyCount > 0);
        if (input.lastResolve &&
            input.lastResolve.timestamp > 0 &&
            input.lastResolve.timestamp !== this.lastRelevantResolveTs &&
            self &&
            (input.lastResolve.attackerId === self.id || input.lastResolve.defenderId === self.id)) {
            this.lastRelevantResolveTs = input.lastResolve.timestamp;
            this.lastRelevantResolveWinner = input.lastResolve.winner;
        }
        if (live) {
            const newRound = this.phase !== "LIVE" ||
                this.lastSceneHash !== (sceneHash ?? "") ||
                (this.lastLiveAt > 0 && input.frameWall - this.lastLiveAt > 1200);
            if (newRound) {
                this.roundId += 1;
                this.liveSinceTs = input.frameTs;
                this.setPhase("LIVE", input.frameTs, input.frameWall);
            }
            else if (this.phase !== "LIVE") {
                this.setPhase("LIVE", input.frameTs, input.frameWall);
            }
            this.lastLiveAt = input.frameWall;
            this.lastSelfAlive = true;
            this.lastEnemyCount = enemyCount;
            this.lastSceneHash = sceneHash ?? "";
            return this.snapshot(input.frameTs, enemyCount, true, sceneHash, `LIVE x${enemyCount}`);
        }
        if (this.phase === "LIVE" || this.phase === "TRANSITION") {
            if (this.lastSelfAlive && !self) {
                const resolvedLoss = this.lastRelevantResolveWinner >= 0 && self == null;
                const summary = resolvedLoss ? "SELF_LEFT_AFTER_RESOLVE" : "SELF_MISSING";
                this.setPhase("LOST", input.frameTs, input.frameWall);
                this.lastSelfAlive = false;
                this.lastEnemyCount = enemyCount;
                this.lastSceneHash = sceneHash ?? this.lastSceneHash;
                return this.snapshot(input.frameTs, enemyCount, false, sceneHash, summary);
            }
            if (self && enemyCount === 0 && this.lastEnemyCount > 0) {
                this.setPhase("WON", input.frameTs, input.frameWall);
                this.lastSelfAlive = true;
                this.lastEnemyCount = 0;
                this.lastSceneHash = sceneHash ?? this.lastSceneHash;
                return this.snapshot(input.frameTs, 0, true, sceneHash, "LAST_ENEMY_GONE");
            }
            this.setPhase("TRANSITION", input.frameTs, input.frameWall);
            this.lastSelfAlive = Boolean(self);
            this.lastEnemyCount = enemyCount;
            this.lastSceneHash = sceneHash ?? this.lastSceneHash;
            return this.snapshot(input.frameTs, enemyCount, Boolean(self), sceneHash, "ROUND_TRANSITION");
        }
        if ((this.phase === "WON" || this.phase === "LOST") && input.frameWall - this.phaseSinceWall <= 1400) {
            return this.snapshot(input.frameTs, enemyCount, Boolean(self), sceneHash, this.phase === "WON" ? "ROUND_WON" : "ROUND_LOST");
        }
        this.setPhase("IDLE", input.frameTs, input.frameWall);
        this.lastSelfAlive = Boolean(self);
        this.lastEnemyCount = enemyCount;
        this.lastSceneHash = sceneHash ?? "";
        return this.snapshot(input.frameTs, enemyCount, Boolean(self), sceneHash, "IDLE");
    }
    reset() {
        this.phase = "IDLE";
        this.roundId = 0;
        this.phaseSinceTs = 0;
        this.phaseSinceWall = 0;
        this.lastLiveAt = 0;
        this.liveSinceTs = 0;
        this.lastSceneHash = "";
        this.lastSelfAlive = false;
        this.lastEnemyCount = 0;
        this.lastRelevantResolveTs = -1;
        this.lastRelevantResolveWinner = -1;
    }
    setPhase(phase, ts, wall) {
        if (this.phase === phase) {
            return;
        }
        this.phase = phase;
        this.phaseSinceTs = ts;
        this.phaseSinceWall = wall;
    }
    snapshot(nowTs, enemyCount, selfAlive, sceneHash, summary) {
        return {
            phase: this.phase,
            roundId: this.roundId,
            sceneHash,
            sinceTs: this.phaseSinceTs,
            liveForMs: this.liveSinceTs > 0 ? Math.max(0, nowTs - this.liveSinceTs) : 0,
            enemyCount,
            selfAlive,
            summary
        };
    }
}
