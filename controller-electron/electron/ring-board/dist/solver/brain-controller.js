import { predictWindowForEntities, ringTargetDistance } from "./contact-solver.js";
import { AnchorTargetController } from "./anchor-target-controller.js";
export class BrainController {
    constructor(memory) {
        this.profiles = new Map();
        this.anchorController = new AnchorTargetController();
        this.lastResolveTs = -1;
        this.commitChain = {
            targetId: -1,
            mode: "RESET",
            sinceWall: 0,
            lockedUntil: 0
        };
        this.rngState = 0x9e3779b9;
        this.memory = memory;
    }
    reset() {
        this.profiles.clear();
        this.anchorController.reset();
        this.lastResolveTs = -1;
        this.commitChain = {
            targetId: -1,
            mode: "RESET",
            sinceWall: 0,
            lockedUntil: 0
        };
    }
    decide(snapshot) {
        if (!snapshot.armed || !snapshot.scene || snapshot.scene.policy !== "allowed") {
            this.anchorController.reset();
            this.commitChain = {
                targetId: -1,
                mode: "RESET",
                sinceWall: 0,
                lockedUntil: 0
            };
            return null;
        }
        const self = snapshot.entities.find((entity) => entity.isSelf) ?? null;
        if (!self) {
            return buildBrainState({
                mode: "RESET",
                reason: "NO_SELF",
                targetId: -1,
                anchorTargetId: -1,
                anchorAgeMs: 0,
                switchLockedUntil: 0,
                score: 0,
                pressure: 0,
                timingConfidence: 0,
                threatCount: 0,
                campScore: 0,
                planScore: 0,
                enemyTags: []
            });
        }
        this.updateProfiles(snapshot, self);
        const enemies = snapshot.entities.filter((entity) => isEnemy(self, entity));
        if (enemies.length === 0) {
            this.anchorController.reset();
            this.commitChain = {
                targetId: -1,
                mode: "RESET",
                sinceWall: 0,
                lockedUntil: 0
            };
            return buildBrainState({
                mode: "SEEK",
                reason: "NO_ENEMIES",
                targetId: -1,
                anchorTargetId: -1,
                anchorAgeMs: 0,
                switchLockedUntil: 0,
                score: 0,
                pressure: 0,
                timingConfidence: 0,
                threatCount: 0,
                campScore: 0,
                planScore: 0,
                enemyTags: []
            });
        }
        const pressure = enemies.filter((enemy) => ringTargetDistance(self, enemy) <= 2.4 || chebyshev(self, enemy) <= 1.6).length;
        const localThreats = enemies.filter((enemy) => ringTargetDistance(self, enemy) <= 4.8 || chebyshev(self, enemy) <= 2.8).length;
        const collapse = collapseScore(self, enemies);
        const recentAggressorId = resolveRecentAggressorId(snapshot, self.id);
        const openingChaos = snapshot.round.liveForMs <= 9000 && snapshot.round.enemyCount >= 3;
        const evaluations = enemies
            .map((enemy) => this.evaluateEnemy(snapshot, self, enemy, enemies, localThreats, recentAggressorId, openingChaos))
            .sort((left, right) => rankEnemy(right) - rankEnemy(left) || left.hotEta - right.hotEta);
        const priorityPool = buildDecisionPool(evaluations, pressure, localThreats);
        const candidates = priorityPool.map((evaluation) => ({
            id: evaluation.entity.id,
            confidence: anchorConfidence(evaluation),
            window: predictWindowForEntities(self, evaluation.entity, snapshot.nowTs),
            utility: evaluation.utility,
            localThreatScore: evaluation.localThreatScore,
            pincerRisk: evaluation.pincerRisk,
            reachable: evaluation.reachable,
            distance: evaluation.distance,
            engaged: evaluation.engaged,
            recentAggressor: evaluation.recentAggressor
        }));
        const enemyCount = enemies.length;
        const provisionalMode = chooseMode(evaluations[0] ?? null, pressure, localThreats, collapse, enemyCount, openingChaos);
        const anchor = this.anchorController.choose(candidates, {
            nowWall: snapshot.nowWall,
            mode: provisionalMode,
            pressure,
            localThreats,
            collapse
        });
        const anchorEval = priorityPool.find((evaluation) => evaluation.entity.id === anchor.targetId) ??
            evaluations.find((evaluation) => evaluation.entity.id === anchor.targetId) ??
            priorityPool[0] ??
            evaluations[0] ??
            null;
        const anchorWindow = anchorEval ? predictWindowForEntities(self, anchorEval.entity, snapshot.nowTs) : null;
        const mode = applyAdaptiveModeTuning(chooseMode(anchorEval, pressure, localThreats, collapse, enemyCount, openingChaos), anchorEval, snapshot.adaptiveTuning);
        const chained = this.applyCommitChain(snapshot, evaluations, anchorEval, mode, pressure, localThreats, collapse);
        const finalEval = chained.evaluation ?? anchorEval;
        const finalMode = applyAdaptiveModeTuning(chained.mode, chained.evaluation ?? anchorEval, snapshot.adaptiveTuning);
        const finalTargetId = finalEval?.entity.id ?? -1;
        const finalAnchorTargetId = chained.targetId >= 0 ? chained.targetId : anchor.targetId;
        const enemyTags = evaluations.map((evaluation) => toEnemyTag(evaluation, finalAnchorTargetId));
        const score = finalEval ? modeScore(finalMode, finalEval) : 0;
        const finalWindow = finalEval && finalEval.entity.id !== (anchorEval?.entity.id ?? -1)
            ? predictWindowForEntities(self, finalEval.entity, snapshot.nowTs)
            : anchorWindow;
        const timingConfidence = finalWindow?.confidence ?? Math.max(0.22, 0.56 - collapse * 0.06);
        const campScore = finalEval?.campScore ?? 0;
        const planScore = finalEval ? finalEval.utility + modePlanBias(finalMode, finalEval) : 0;
        if (finalEval) {
            this.memory.observe(finalEval.archetype, snapshot.nowTs);
            if (finalMode === "COMMIT" || finalMode === "PUNISH") {
                this.memory.markCommit(finalEval.archetype);
            }
            else if (finalMode === "LURE") {
                this.memory.markLure(finalEval.archetype);
            }
            else if (finalMode === "EVADE") {
                this.memory.markEvade(finalEval.archetype);
            }
        }
        return buildBrainState({
            mode: finalMode,
            reason: buildReason(finalMode, finalEval, pressure, collapse, finalWindow),
            targetId: finalTargetId,
            committedTargetId: finalTargetId,
            strikeTargetId: finalTargetId,
            targetReason: finalEval ? describeTargetReason(finalEval, pressure, localThreats) : "NONE",
            laneState: finalWindow?.kind ?? (finalEval?.engaged ? "ENGAGED" : "FAR"),
            planIntent: planIntentForMode(finalMode),
            anchorTargetId: finalAnchorTargetId,
            anchorAgeMs: finalAnchorTargetId >= 0 && this.commitChain.targetId === finalAnchorTargetId
                ? Math.max(0, snapshot.nowWall - this.commitChain.sinceWall)
                : anchor.sinceWall > 0
                    ? Math.max(0, snapshot.nowWall - anchor.sinceWall)
                    : 0,
            switchLockedUntil: Math.max(anchor.lockedUntil, chained.lockedUntil),
            score: round2(score),
            pressure,
            timingConfidence: round2(timingConfidence),
            threatCount: enemies.filter((enemy) => ringTargetDistance(self, enemy) <= 3.8 || chebyshev(self, enemy) <= 2.2).length,
            campScore: round2(campScore),
            planScore: round2(planScore),
            enemyTags
        });
    }
    applyCommitChain(snapshot, evaluations, anchorEval, mode, pressure, localThreats, collapse) {
        const nowWall = snapshot.nowWall;
        const active = this.commitChain.targetId >= 0 && nowWall < this.commitChain.lockedUntil;
        const chainedEval = active ? evaluations.find((evaluation) => evaluation.entity.id === this.commitChain.targetId) ?? null : null;
        if (active && chainedEval && !shouldAbortCommitChain(chainedEval, localThreats, pressure, collapse)) {
            const chainedMode = upgradeCommitChainMode(this.commitChain.mode, chainedEval);
            this.commitChain.mode = chainedMode;
            this.commitChain.lockedUntil = Math.max(this.commitChain.lockedUntil, nowWall + extensionDuration(chainedMode, chainedEval));
            return {
                targetId: this.commitChain.targetId,
                mode: chainedMode,
                evaluation: chainedEval,
                lockedUntil: this.commitChain.lockedUntil
            };
        }
        this.commitChain = {
            targetId: -1,
            mode: "RESET",
            sinceWall: 0,
            lockedUntil: 0
        };
        if (!anchorEval) {
            return { targetId: -1, mode, evaluation: null, lockedUntil: 0 };
        }
        if (!shouldStartCommitChain(anchorEval, mode, pressure, localThreats)) {
            return {
                targetId: anchorEval.entity.id,
                mode,
                evaluation: anchorEval,
                lockedUntil: 0
            };
        }
        this.commitChain = {
            targetId: anchorEval.entity.id,
            mode,
            sinceWall: nowWall,
            lockedUntil: nowWall + commitChainDuration(mode, anchorEval)
        };
        return {
            targetId: anchorEval.entity.id,
            mode,
            evaluation: anchorEval,
            lockedUntil: this.commitChain.lockedUntil
        };
    }
    updateProfiles(snapshot, self) {
        const nowTs = snapshot.nowTs;
        if (snapshot.lastResolve &&
            snapshot.lastResolve.timestamp > 0 &&
            snapshot.lastResolve.timestamp !== this.lastResolveTs) {
            this.lastResolveTs = snapshot.lastResolve.timestamp;
            const id = snapshot.lastResolve.targetId;
            if (id >= 0 && id !== self.id) {
                const profile = this.ensureProfile(id);
                profile.resolveMentions += 1;
                profile.threat = clamp(profile.threat + (snapshot.lastResolve.contested ? 0.25 : 0.4), 0, 8);
            }
        }
        for (const entity of snapshot.entities) {
            if (!isEnemy(self, entity)) {
                continue;
            }
            const profile = this.ensureProfile(entity.id);
            const moved = Math.hypot(entity.x - profile.lastX, entity.y - profile.lastY);
            if (moved < 0.08) {
                profile.stationaryTicks += 1;
            }
            else {
                profile.stationaryTicks = Math.max(0, profile.stationaryTicks - 1);
            }
            const dxToSelf = self.x - entity.x;
            const dyToSelf = self.y - entity.y;
            const moveDx = entity.x - profile.lastX;
            const moveDy = entity.y - profile.lastY;
            const towardSelf = moveDx * dxToSelf + moveDy * dyToSelf;
            if (towardSelf > 0.02) {
                profile.chaseTicks += 1;
            }
            else {
                profile.chaseTicks = Math.max(0, profile.chaseTicks - 1);
            }
            const lateralMotion = Math.abs(moveDx) > 0.04 && Math.abs(moveDy) > 0.04;
            if (lateralMotion) {
                profile.lateralTicks += 1;
            }
            else {
                profile.lateralTicks = Math.max(0, profile.lateralTicks - 1);
            }
            if ((ringTargetDistance(self, entity) <= 3.9 || chebyshev(self, entity) <= 2.2) && entity.moving) {
                profile.collapseTicks += 1;
            }
            else {
                profile.collapseTicks = Math.max(0, profile.collapseTicks - 1);
            }
            profile.lastX = entity.x;
            profile.lastY = entity.y;
            profile.lastSeenTs = nowTs;
            profile.threat = Math.max(0, profile.threat - 0.01);
            profile.archetype = classifyArchetype(profile);
        }
        for (const [id, profile] of this.profiles) {
            if (nowTs - profile.lastSeenTs > 5000) {
                this.profiles.delete(id);
            }
        }
    }
    evaluateEnemy(snapshot, self, enemy, enemies, localThreats, recentAggressorId, openingChaos) {
        const profile = this.ensureProfile(enemy.id);
        const distance = ringTargetDistance(self, enemy);
        const prevDist = Math.hypot(profile.lastX - self.x, profile.lastY - self.y);
        const closing = clamp(prevDist - distance, -2.5, 2.5);
        const focusSelected = enemy.id === snapshot.targetId;
        const standbyRemaining = enemy.standbyRemainingMs ?? 0;
        const standbyRole = enemy.standbyRole ?? "NONE";
        const standby = standbyRemaining > 0;
        const cluster = enemies.filter((candidate) => candidate.id !== enemy.id && chebyshev(candidate, enemy) <= 2).length;
        const corner = isCornerLike(enemy, snapshot.scene);
        if (corner && profile.stationaryTicks >= 2) {
            profile.anchorTicks += 1;
        }
        else {
            profile.anchorTicks = Math.max(0, profile.anchorTicks - 1);
        }
        const archetype = profile.archetype;
        const memoryBias = this.memory.getBias(archetype);
        const window = predictWindowForEntities(self, enemy, snapshot.nowTs);
        const hotEta = window?.bestAt ?? 999;
        const pincerRisk = cluster * 0.65 + Math.max(0, pressureAt(self, enemies, enemy.id) - 1) * 0.8;
        const reachable = distance <= 8.2;
        const engaged = distance <= 4.8 || hotEta <= 132 || closing > 0.28 || (standby && distance <= 5.6);
        const recentAggressor = enemy.id === recentAggressorId;
        const localThreatScore = clamp(5.9 - distance, 0, 5.9) * 1.62 +
            (engaged ? 1.1 : 0) +
            (recentAggressor ? 2.1 : 0) +
            (focusSelected ? (engaged ? 2.15 : 1.15) : 0) +
            (distance <= 3.5 ? 0.95 : 0) -
            (distance > 5.5 ? 0.25 : 0);
        const campScore = profile.stationaryTicks * 0.35 +
            profile.anchorTicks * 0.6 +
            (corner ? 1.2 : 0) -
            profile.chaseTicks * 0.08;
        const mistakeScore = computeMistakeScore({
            distance,
            closing,
            cluster,
            corner,
            campScore,
            engaged,
            hotEta,
            moving: enemy.moving,
            pincerRisk,
            localThreats,
            recentAggressor,
            focusSelected
        });
        const chaosMobileBonus = openingChaos && enemy.moving && distance <= 6.8
            ? 1.35 + Math.max(0, 6.2 - distance) * 0.42 + Math.min(1.6, cluster * 0.38)
            : 0;
        const chaosTrafficBonus = openingChaos && enemy.moving && cluster >= 1 && hotEta <= 220
            ? 1.15 + Math.min(1.4, cluster * 0.33)
            : 0;
        const chaosPassivePenalty = openingChaos && !enemy.moving && !engaged && !recentAggressor
            ? 3.2 + Math.max(0, 5.8 - distance) * 0.62
            : 0;
        const adaptive = snapshot.adaptiveTuning;
        const spacingBias = clamp(adaptive?.spacingBias ?? 0, -0.7, 0.9);
        const commitBias = clamp(adaptive?.commitBias ?? 0, -0.7, 0.7);
        let attackScore = 0;
        attackScore += window ? windowWeight(window.kind) + Math.max(0, (142 - window.bestAt) * 0.04) : 0;
        attackScore += clamp(4.9 - distance, -1.6, 5.8);
        attackScore += closing * 4.15;
        attackScore -= cluster * 0.85;
        attackScore -= profile.threat * 1.05;
        attackScore -= pincerRisk * 0.65;
        attackScore += memoryBias.attack;
        attackScore += engaged ? 1.7 : 0;
        attackScore += recentAggressor ? 2.45 : 0;
        attackScore += focusSelected ? (engaged ? 3.55 : 2.05) : 0;
        attackScore += campScore >= 4.2 && distance <= 5.8 && localThreats <= 1 ? 1.2 : 0;
        attackScore += hotEta <= 84 ? 1.2 : 0;
        attackScore -= !enemy.moving && !engaged && !recentAggressor ? 2.4 + Math.max(0, 5 - distance) * 0.55 : 0;
        attackScore -= enemy.moving && !engaged ? 1.35 + Math.max(0, distance - 2.4) * 0.22 : 0;
        attackScore -= enemy.moving && !recentAggressor && hotEta > 112 ? 0.95 : 0;
        attackScore -= archetype === "side-stepper" || archetype === "hesitant" ? 0.65 : 0;
        attackScore += standby
            ? standbyRole === "DEFENDER"
                ? 4.8 + Math.max(0, 6 - distance) * 0.82
                : 3.2 + Math.max(0, 5.6 - distance) * 0.64
            : 0;
        attackScore += mistakeScore * 2.15;
        attackScore += chaosMobileBonus + chaosTrafficBonus;
        attackScore -= chaosPassivePenalty;
        attackScore -= Math.max(0, distance - 5) * 1.1;
        attackScore += commitBias * (enemy.moving ? 0.78 : 1.05);
        attackScore -= spacingBias * (enemy.moving ? 1.05 : 0.46);
        if (localThreats >= 1 && distance > 5) {
            attackScore -= 5.8;
        }
        if (localThreats >= 2 && distance > 4.5) {
            attackScore -= 3.1;
        }
        let stalkScore = 0;
        stalkScore += bandScore(distance, 2, 3, 3.2);
        stalkScore += profile.threat * 0.1;
        stalkScore += window ? Math.max(0, (180 - window.bestAt) * 0.014) : 0;
        stalkScore += memoryBias.feint * 0.25;
        stalkScore += !enemy.moving && !engaged ? 1.25 + campScore * 0.22 : 0;
        stalkScore += enemy.moving && !engaged ? 0.62 : 0;
        stalkScore -= mistakeScore * 0.72;
        stalkScore += openingChaos && enemy.moving && distance <= 6.8 ? 0.8 : 0;
        stalkScore -= chaosPassivePenalty * 0.42;
        stalkScore -= focusSelected && engaged ? 0.65 : 0;
        stalkScore -= standby ? 1.8 : 0;
        stalkScore += spacingBias * 1.15;
        stalkScore -= commitBias * 0.42;
        if (localThreats >= 1 && distance > 4.5) {
            stalkScore -= 3.5;
        }
        let lureScore = 0;
        lureScore += campScore * 1.05;
        lureScore += bandScore(distance, 2, 5, 2.4);
        lureScore += corner ? 1.25 : 0;
        lureScore -= pincerRisk * 0.45;
        lureScore += memoryBias.bait + memoryBias.lure;
        lureScore += !enemy.moving && !engaged ? 2.45 + campScore * 0.35 : 0;
        lureScore += enemy.moving && !engaged && !recentAggressor ? 1.05 : 0;
        lureScore -= mistakeScore * 1.05;
        lureScore += openingChaos && enemy.moving && cluster >= 1 ? 0.85 : 0;
        lureScore -= chaosPassivePenalty * 0.55;
        lureScore -= focusSelected && engaged ? 1.35 : 0;
        lureScore -= campScore >= 4.8 && distance <= 5.5 ? 0.8 : 0;
        lureScore -= standby ? 2.2 : 0;
        lureScore += spacingBias * 0.92;
        lureScore -= commitBias * 0.25;
        if (localThreats >= 1 && distance > 4.5) {
            lureScore -= 4.2;
        }
        if (engaged) {
            lureScore -= 1.2;
        }
        let feintScore = 0;
        feintScore += bandScore(distance, 1, 3, 2.8);
        feintScore += memoryBias.feint;
        feintScore -= mistakeScore * 0.85;
        feintScore -= focusSelected && engaged ? 1.05 : 0;
        feintScore += archetype === "hesitant" || archetype === "side-stepper" ? 0.55 : 0;
        feintScore += !enemy.moving && distance <= 6.4 ? 1.6 : 0;
        feintScore += enemy.moving && distance <= 6.1 ? 1.3 : 0;
        feintScore += !recentAggressor && !engaged && hotEta > 104 ? 0.65 : 0;
        feintScore += openingChaos && enemy.moving ? 1.1 + Math.min(0.9, cluster * 0.22) : 0;
        feintScore -= chaosPassivePenalty * 0.38;
        feintScore -= pincerRisk * 0.4;
        feintScore -= standby ? 1.1 : 0;
        feintScore += spacingBias * 0.74;
        feintScore -= commitBias * 0.18;
        if (localThreats >= 1 && distance > 4.5) {
            feintScore -= 2.8;
        }
        let evadeScore = 0;
        evadeScore += clamp(distance, 1, 6) * 0.9;
        evadeScore += cluster * 0.82;
        evadeScore += Math.max(0, closing) * 1.5;
        evadeScore += profile.threat * 1.18;
        evadeScore += profile.collapseTicks * 0.18;
        evadeScore += memoryBias.evade;
        evadeScore += focusSelected && engaged ? 0.25 : 0;
        evadeScore -= standby ? 1.6 : 0;
        if (corner) {
            evadeScore -= 1.1;
        }
        const utility = Math.max(attackScore, stalkScore * 0.84, lureScore * 0.9, feintScore * 0.82) -
            pincerRisk * 0.22 +
            (engaged ? 0.9 : 0) +
            (recentAggressor ? 1.2 : 0) +
            (focusSelected ? 1.85 : 0) +
            (standby
                ? standbyRole === "DEFENDER"
                    ? 2.6
                    : 1.7
                : 0) +
            (campScore >= 5 && distance <= 5.8 && localThreats <= 1 ? 1.15 : 0) +
            (openingChaos && enemy.moving ? 1.1 + Math.min(0.8, cluster * 0.2) : 0) -
            chaosPassivePenalty * 0.42 +
            mistakeScore * 1.45 +
            localThreatScore * 0.85;
        const priorityScore = utility +
            localThreatScore * 0.95 +
            (engaged ? 0.7 : 0) +
            (recentAggressor ? 0.95 : 0) +
            (focusSelected ? 1.95 : 0) +
            (standby
                ? standbyRole === "DEFENDER"
                    ? 2.2
                    : 1.4
                : 0) +
            (openingChaos && enemy.moving ? 1.3 + Math.min(1.1, cluster * 0.26) : 0) -
            chaosPassivePenalty * 0.54 +
            mistakeScore * 1.15 -
            Math.max(0, distance - 5.2) * 0.85 -
            (localThreats >= 1 && distance > 5 ? 2.2 : 0);
        return {
            entity: enemy,
            distance,
            closing,
            cluster,
            corner,
            profile,
            archetype,
            campScore,
            attackScore,
            stalkScore,
            lureScore,
            feintScore,
            evadeScore,
            localThreatScore,
            priorityScore,
            utility,
            mistakeScore,
            pincerRisk,
            reachable,
            hotEta,
            engaged,
            recentAggressor,
            focusSelected
        };
    }
    ensureProfile(id) {
        let profile = this.profiles.get(id);
        if (profile) {
            return profile;
        }
        profile = {
            id,
            lastX: 0,
            lastY: 0,
            lastSeenTs: 0,
            stationaryTicks: 0,
            anchorTicks: 0,
            threat: 0,
            resolveMentions: 0,
            chaseTicks: 0,
            lateralTicks: 0,
            collapseTicks: 0,
            archetype: "hesitant"
        };
        this.profiles.set(id, profile);
        return profile;
    }
    rand01() {
        let x = this.rngState | 0;
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        this.rngState = x | 0;
        return ((this.rngState >>> 0) % 10000) / 10000;
    }
    randBetween(min, max) {
        return min + (max - min) * this.rand01();
    }
}
function buildBrainState(input) {
    return input;
}
function chooseMode(anchorEval, pressure, localThreats, collapse, enemyCount, openingChaos) {
    if (!anchorEval) {
        return "SEEK";
    }
    const movingTarget = anchorEval.entity.moving;
    const openingGo = openingChaos &&
        pressure <= 0 &&
        localThreats <= 1 &&
        !anchorEval.engaged &&
        !anchorEval.recentAggressor &&
        anchorEval.hotEta > 108;
    const softCommit = anchorEval.recentAggressor ||
        anchorEval.engaged ||
        anchorEval.hotEta <= 132 ||
        anchorEval.mistakeScore >= 4.4;
    const hardCommit = anchorEval.recentAggressor ||
        anchorEval.engaged ||
        anchorEval.hotEta <= 88 ||
        anchorEval.mistakeScore >= 5.2;
    if (enemyCount <= 1) {
        if (!anchorEval.entity.moving && anchorEval.distance <= 8.6) {
            return anchorEval.engaged || anchorEval.hotEta <= 92 ? "PUNISH" : "LURE";
        }
        if (movingTarget && !softCommit) {
            if (anchorEval.distance <= 6.2 && anchorEval.feintScore >= anchorEval.attackScore - 0.55) {
                return "FEINT";
            }
            return "STALK";
        }
        if (hardCommit && (!movingTarget || anchorEval.recentAggressor || anchorEval.engaged || anchorEval.hotEta <= 64)) {
            return "COMMIT";
        }
        return movingTarget ? "FEINT" : "STALK";
    }
    const camperWindow = !anchorEval.entity.moving &&
        anchorEval.campScore >= 1.45 &&
        anchorEval.distance <= 8.2 &&
        !anchorEval.recentAggressor;
    const cutWindow = camperWindow &&
        anchorEval.distance <= 6.8 &&
        anchorEval.pincerRisk <= 3.35 &&
        (anchorEval.mistakeScore >= 2.5 || anchorEval.utility >= 3.2);
    if (openingGo) {
        if (!movingTarget) {
            return "LURE";
        }
        if (anchorEval.hotEta <= 154 || anchorEval.mistakeScore >= 3.4 || anchorEval.cluster >= 1) {
            return "TRAP";
        }
        if (anchorEval.distance <= 6.1 && anchorEval.feintScore >= anchorEval.attackScore - 0.35) {
            return "FEINT";
        }
        return "INTERCEPT";
    }
    if (localThreats >= 3 && anchorEval.distance <= 7.2 && anchorEval.pincerRisk >= 3.6 && anchorEval.hotEta > 104) {
        return "CONTROL";
    }
    if (anchorEval.hotEta <= 68 && (!movingTarget || anchorEval.recentAggressor || anchorEval.engaged)) {
        return "COMMIT";
    }
    if (camperWindow && pressure <= 1) {
        return cutWindow && (anchorEval.engaged || anchorEval.hotEta <= 86) ? "TRAP" : "LURE";
    }
    if (!anchorEval.entity.moving && anchorEval.distance <= 8) {
        return anchorEval.engaged || anchorEval.hotEta <= 82 ? "TRAP" : "LURE";
    }
    if (movingTarget && !softCommit && anchorEval.distance <= 6.8) {
        if (anchorEval.feintScore >= anchorEval.attackScore - 0.4 && anchorEval.pincerRisk <= 3.5) {
            return "FEINT";
        }
        return pressure <= 0 ? "STALK" : "FEINT";
    }
    if (localThreats >= 1 && anchorEval.distance <= 7.8) {
        if (movingTarget && !softCommit) {
            return pressure <= 0 ? "STALK" : "FEINT";
        }
        return hardCommit && (!movingTarget || anchorEval.recentAggressor || anchorEval.engaged || anchorEval.hotEta <= 74) ? "COMMIT" : (movingTarget ? "FEINT" : "LURE");
    }
    if (pressure <= 1 && anchorEval.mistakeScore >= 3.4 && anchorEval.distance <= 7.2 && anchorEval.pincerRisk <= 3.2) {
        return movingTarget ? "TRAP" : "LURE";
    }
    if (pressure <= 1 &&
        anchorEval.distance <= 7.6 &&
        anchorEval.pincerRisk <= 3.3 &&
        anchorEval.mistakeScore >= 2.2 &&
        (!anchorEval.engaged || anchorEval.campScore >= 1.2)) {
        return anchorEval.campScore >= 1.2 ? "TRAP" : "FEINT";
    }
    if (anchorEval.mistakeScore >= 4.6 && anchorEval.distance <= 7.2 && anchorEval.pincerRisk <= 3.25) {
        return movingTarget ? "TRAP" : "COMMIT";
    }
    if (anchorEval.recentAggressor &&
        anchorEval.distance <= 5.9 &&
        anchorEval.hotEta <= 132) {
        return "COMMIT";
    }
    if (anchorEval.engaged &&
        anchorEval.distance <= 5.8 &&
        anchorEval.pincerRisk <= 3.9 &&
        anchorEval.hotEta <= 138 &&
        (!movingTarget || anchorEval.recentAggressor)) {
        return "COMMIT";
    }
    if (anchorEval.campScore >= 1.9 &&
        anchorEval.distance <= 7.4 &&
        anchorEval.pincerRisk <= 3.4 &&
        pressure <= 1) {
        return anchorEval.engaged || anchorEval.hotEta <= 104 ? "TRAP" : "LURE";
    }
    if (anchorEval.hotEta <= 180 && anchorEval.distance <= 7.8) {
        return movingTarget ? (anchorEval.feintScore >= anchorEval.attackScore - 0.6 ? "FEINT" : "STALK") : "LURE";
    }
    if (anchorEval.distance <= 7.8) {
        return movingTarget ? "STALK" : "LURE";
    }
    return movingTarget ? "STALK" : "INTERCEPT";
}
function applyAdaptiveModeTuning(mode, evaluation, tuning) {
    if (!evaluation || !tuning) {
        return mode;
    }
    const spacingBias = clamp(tuning.spacingBias, -0.7, 0.9);
    const commitBias = clamp(tuning.commitBias, -0.7, 0.7);
    const urgent = evaluation.recentAggressor || evaluation.engaged || evaluation.hotEta <= 86 || evaluation.mistakeScore >= 4.8;
    if (spacingBias >= 0.2 && mode === "COMMIT" && evaluation.entity.moving && !urgent) {
        return evaluation.distance <= 5.8 ? "FEINT" : "STALK";
    }
    if (spacingBias >= 0.28 && mode === "TRAP" && !urgent && evaluation.entity.moving) {
        return "FEINT";
    }
    if (commitBias >= 0.2 && (mode === "STALK" || mode === "LURE" || mode === "FEINT") && urgent) {
        return evaluation.hotEta <= 72 || evaluation.mistakeScore >= 5 ? "COMMIT" : "INTERCEPT";
    }
    if (commitBias <= -0.2 && mode === "INTERCEPT" && evaluation.entity.moving && !evaluation.recentAggressor) {
        return "FEINT";
    }
    return mode;
}
function buildReason(mode, evaluation, pressure, collapse, window) {
    if (!evaluation) {
        return "NO_EVAL";
    }
    const windowText = window ? `${window.kind}_${window.bestAt}` : "NO_WIN";
    return `${mode}_${evaluation.archetype}_P${pressure}_C${collapse.toFixed(2)}_${windowText}_M${evaluation.mistakeScore.toFixed(2)}`;
}
function modeScore(mode, evaluation) {
    switch (mode) {
        case "CONTROL":
            return evaluation.attackScore * 0.52 + evaluation.stalkScore * 0.28 + evaluation.utility + 1.2;
        case "TRAP":
            return evaluation.attackScore * 0.96 + evaluation.mistakeScore * 1.08 + evaluation.lureScore * 0.12 + 4.4;
        case "PUNISH":
            return evaluation.attackScore * 1.06 + evaluation.mistakeScore * 1.34 + 5.6;
        case "COMMIT":
            return evaluation.attackScore * 1.08 + 5.2;
        case "INTERCEPT":
            return evaluation.attackScore * 1.02 + 3.3;
        case "STALK":
            return evaluation.stalkScore + 0.4;
        case "LURE":
            return evaluation.lureScore + 0.5;
        case "FEINT":
            return evaluation.feintScore + 1.1;
        case "EVADE":
            return evaluation.evadeScore + 2.4;
        case "SEEK":
            return evaluation.utility;
        case "RESET":
            return 0;
        default:
            return evaluation.utility;
    }
}
function modePlanBias(mode, evaluation) {
    switch (mode) {
        case "CONTROL":
            return evaluation.utility * 0.08 + evaluation.stalkScore * 0.04 + Math.max(0, evaluation.localThreatScore) * 0.04;
        case "TRAP":
            return evaluation.attackScore * 0.18 + evaluation.mistakeScore * 0.34 + evaluation.lureScore * 0.06;
        case "PUNISH":
            return evaluation.attackScore * 0.2 + evaluation.mistakeScore * 0.42;
        case "COMMIT":
            return evaluation.attackScore * 0.24 + evaluation.mistakeScore * 0.28;
        case "INTERCEPT":
            return evaluation.attackScore * 0.16 + evaluation.mistakeScore * 0.16;
        case "STALK":
            return evaluation.stalkScore * 0.05;
        case "LURE":
            return evaluation.lureScore * 0.06;
        case "FEINT":
            return evaluation.feintScore * 0.18;
        case "EVADE":
            return evaluation.evadeScore * 0.22;
        default:
            return evaluation.utility * 0.08;
    }
}
function toEnemyTag(evaluation, anchorTargetId) {
    return {
        id: evaluation.entity.id,
        archetype: evaluation.archetype,
        threat: round2(evaluation.profile.threat),
        campScore: round2(evaluation.campScore),
        hotEta: evaluation.hotEta,
        anchored: evaluation.entity.id === anchorTargetId
    };
}
function classifyArchetype(profile) {
    if (profile.collapseTicks >= 5) {
        return "collapser";
    }
    if (profile.anchorTicks >= 5 || profile.stationaryTicks >= 7) {
        return "camper";
    }
    if (profile.chaseTicks >= 5) {
        return "chaser";
    }
    if (profile.lateralTicks >= 4) {
        return "side-stepper";
    }
    return "hesitant";
}
function isEnemy(self, entity) {
    return entity.id !== self.id && !entity.isSelf;
}
function pressureAt(self, enemies, excludeId = -1) {
    return enemies.filter((enemy) => enemy.id !== excludeId && (ringTargetDistance(self, enemy) <= 3.2 || chebyshev(self, enemy) <= 2)).length;
}
function collapseScore(self, enemies) {
    const close = enemies.filter((enemy) => ringTargetDistance(self, enemy) <= 4 || chebyshev(self, enemy) <= 2.4);
    if (close.length <= 1) {
        return close.length * 0.8;
    }
    const quadrants = new Set();
    let opposite = 0;
    for (let i = 0; i < close.length; i += 1) {
        const dx = close[i].x - self.x;
        const dy = close[i].y - self.y;
        quadrants.add(`${dx >= 0 ? "R" : "L"}${dy >= 0 ? "D" : "U"}`);
        for (let j = i + 1; j < close.length; j += 1) {
            const odx = close[j].x - self.x;
            const ody = close[j].y - self.y;
            const magA = Math.hypot(dx, dy);
            const magB = Math.hypot(odx, ody);
            if (magA < 0.001 || magB < 0.001) {
                continue;
            }
            const dot = (dx * odx + dy * ody) / (magA * magB);
            if (dot < -0.18) {
                opposite += 1;
            }
        }
    }
    const movingClose = close.filter((enemy) => enemy.moving).length;
    return round2(close.length * 0.95 + quadrants.size * 0.35 + opposite * 0.8 + movingClose * 0.28);
}
function windowWeight(kind) {
    switch (kind) {
        case "HOT":
            return 8.7;
        case "DIAG":
            return 6.8;
        case "STAGE":
            return 4.4;
        case "APPROACH":
            return 2.8;
        default:
            return 0;
    }
}
function anchorConfidence(evaluation) {
    return clamp(0.4 +
        Math.max(0, evaluation.attackScore) * 0.035 +
        Math.max(0, evaluation.stalkScore) * 0.015 -
        evaluation.pincerRisk * 0.03 +
        (evaluation.engaged ? 0.08 : 0) +
        (evaluation.recentAggressor ? 0.06 : 0) +
        (evaluation.focusSelected ? 0.1 : 0) +
        Math.max(0, evaluation.mistakeScore) * 0.025 +
        Math.max(0, evaluation.localThreatScore) * 0.02, 0.12, 0.98);
}
function rankEnemy(evaluation) {
    return (evaluation.priorityScore +
        evaluation.attackScore * 0.34 +
        evaluation.localThreatScore * 0.24 +
        evaluation.mistakeScore * 0.9 +
        (evaluation.focusSelected ? 2.2 : 0) +
        (evaluation.recentAggressor ? 1.35 : 0));
}
function buildDecisionPool(evaluations, pressure, localThreats) {
    if (evaluations.length <= 1) {
        return evaluations;
    }
    if (localThreats >= 2) {
        const pool = evaluations.filter((evaluation) => evaluation.focusSelected ||
            evaluation.recentAggressor ||
            evaluation.engaged ||
            evaluation.distance <= 4.8 ||
            evaluation.hotEta <= 120);
        if (pool.length > 0) {
            return pool;
        }
    }
    if (localThreats >= 1 || pressure >= 1) {
        const pool = evaluations.filter((evaluation) => evaluation.focusSelected ||
            evaluation.recentAggressor ||
            evaluation.engaged ||
            evaluation.distance <= 5.5 ||
            evaluation.hotEta <= 148);
        if (pool.length > 0) {
            return pool;
        }
    }
    const campPressurePool = evaluations.filter((evaluation) => (evaluation.campScore >= 3.6 || evaluation.mistakeScore >= 3.8) &&
        evaluation.distance <= 6.8 &&
        evaluation.pincerRisk <= 2.6);
    if (campPressurePool.length > 0) {
        return campPressurePool;
    }
    return evaluations;
}
function resolveRecentAggressorId(snapshot, selfId) {
    const resolve = snapshot.lastResolve;
    if (!resolve || snapshot.nowTs - resolve.timestamp > 1300) {
        return -1;
    }
    if (resolve.attackerId === selfId) {
        return resolve.defenderId;
    }
    if (resolve.defenderId === selfId) {
        return resolve.attackerId;
    }
    return -1;
}
function shouldStartCommitChain(evaluation, mode, pressure, localThreats) {
    if (mode === "EVADE" || mode === "SEEK" || mode === "RESET" || mode === "CONTROL" || mode === "LURE" || mode === "FEINT" || mode === "STALK") {
        return false;
    }
    if (mode === "TRAP") {
        return (evaluation.distance <= 6.4 &&
            evaluation.pincerRisk <= 3.3 &&
            (!evaluation.entity.moving ||
                evaluation.engaged ||
                evaluation.hotEta <= 118 ||
                evaluation.campScore >= 1.6 ||
                evaluation.mistakeScore >= 3.1));
    }
    if (mode === "PUNISH") {
        return evaluation.distance <= 6.6 && evaluation.pincerRisk <= 3.1 && (!evaluation.entity.moving || evaluation.hotEta <= 112 || evaluation.engaged);
    }
    if (mode === "COMMIT") {
        if (evaluation.entity.moving && !evaluation.recentAggressor && !evaluation.engaged) {
            return evaluation.hotEta <= 72 || evaluation.mistakeScore >= 5.8;
        }
        return (evaluation.hotEta <= (evaluation.entity.moving ? 88 : 122) ||
            evaluation.engaged ||
            evaluation.recentAggressor ||
            evaluation.mistakeScore >= (evaluation.entity.moving ? 4.9 : 3.8) ||
            evaluation.campScore >= 2);
    }
    if (mode === "INTERCEPT") {
        return (!evaluation.entity.moving && evaluation.distance <= 6.6) || evaluation.engaged || evaluation.recentAggressor || evaluation.hotEta <= 112 || localThreats > 1;
    }
    return false;
}
function shouldAbortCommitChain(evaluation, localThreats, pressure, collapse) {
    if (!evaluation.reachable || evaluation.distance > 8.8) {
        return true;
    }
    if (pressure >= 4 && collapse >= 2.8 && evaluation.pincerRisk >= 4 && evaluation.hotEta > 44) {
        return true;
    }
    if (localThreats >= 3 && evaluation.distance > 6.4 && !evaluation.recentAggressor && evaluation.mistakeScore < 4.6) {
        return true;
    }
    return false;
}
function upgradeCommitChainMode(mode, evaluation) {
    if (mode === "TRAP" && (!evaluation.entity.moving || evaluation.recentAggressor || evaluation.engaged) && (evaluation.hotEta <= 92 || evaluation.engaged || evaluation.recentAggressor || evaluation.distance <= 3.5)) {
        return "COMMIT";
    }
    if (mode === "PUNISH" && (!evaluation.entity.moving || evaluation.recentAggressor || evaluation.engaged) && (evaluation.hotEta <= 82 || evaluation.engaged || evaluation.recentAggressor || evaluation.distance <= 2.9)) {
        return "COMMIT";
    }
    if (mode === "INTERCEPT" && ((evaluation.hotEta <= 62 || evaluation.mistakeScore >= 5.4) && (!evaluation.entity.moving || evaluation.recentAggressor || evaluation.engaged))) {
        return "COMMIT";
    }
    if (mode === "FEINT" && (!evaluation.entity.moving || evaluation.recentAggressor || evaluation.engaged) && (evaluation.hotEta <= 74 || evaluation.engaged || evaluation.recentAggressor)) {
        return "COMMIT";
    }
    return mode;
}
function commitChainDuration(mode, evaluation) {
    switch (mode) {
        case "TRAP":
            return 380 + Math.round(Math.max(0, evaluation.mistakeScore - 2.2) * 30);
        case "PUNISH":
            return 500 + Math.round(Math.max(0, evaluation.mistakeScore - 2.8) * 28);
        case "COMMIT":
            return 430 + Math.round(Math.max(0, 132 - evaluation.hotEta) * 0.58);
        case "INTERCEPT":
            return 320 + Math.round(Math.max(0, 144 - evaluation.hotEta) * 0.38);
        default:
            return 240;
    }
}
function extensionDuration(mode, evaluation) {
    switch (mode) {
        case "TRAP":
            return evaluation.hotEta <= 126 ? 180 : 130;
        case "PUNISH":
            return evaluation.hotEta <= 112 ? 220 : 160;
        case "COMMIT":
            return evaluation.hotEta <= 84 ? 200 : 150;
        case "INTERCEPT":
            return 130;
        default:
            return 90;
    }
}
function chebyshev(left, right) {
    return Math.max(Math.abs(left.x - right.x), Math.abs(left.y - right.y));
}
function bandScore(dist, min, max, peak) {
    if (dist >= min && dist <= max) {
        return peak;
    }
    if (dist < min) {
        return -((min - dist) * 2.1);
    }
    return peak - (dist - max) * 0.9;
}
function round2(value) {
    return Math.round(value * 100) / 100;
}
function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}
function planIntentForMode(mode) {
    switch (mode) {
        case "CONTROL":
            return "BOARD_CONTROL";
        case "TRAP":
            return "CUT_OFF";
        case "LURE":
            return "BAIT";
        case "COMMIT":
        case "PUNISH":
            return "COMMIT";
        case "STALK":
            return "SHADOW";
        case "INTERCEPT":
            return "INTERCEPT";
        case "FEINT":
            return "FEINT";
        case "EVADE":
            return "RESET_LANE";
        default:
            return "SEEK";
    }
}
function describeTargetReason(evaluation, pressure, localThreats) {
    if (evaluation.recentAggressor) {
        return "ATTACKER";
    }
    if (evaluation.engaged && evaluation.hotEta <= 132) {
        return "HOT_LOCAL";
    }
    if (!evaluation.entity.moving && evaluation.campScore >= 1.4) {
        return "CAMPER";
    }
    if (pressure <= 1 && localThreats <= 1 && evaluation.mistakeScore >= 2.8) {
        return "EXPOSED";
    }
    return "COMMITTED";
}
function isCornerLike(enemy, scene) {
    if (!scene) {
        return false;
    }
    const x = Math.round(enemy.toX);
    const y = Math.round(enemy.toY);
    const nearWall = x <= 1 || y <= 1 || x >= scene.width - 2 || y >= scene.height - 2;
    return nearWall;
}
function computeMistakeScore(input) {
    const isolationBonus = input.cluster <= 0 ? 1.35 :
        input.cluster === 1 ? 0.55 :
            0;
    const stationaryPunish = !input.moving && input.distance <= 6.1
        ? Math.max(0, 6.2 - input.distance) * 0.62 + input.campScore * 0.22
        : 0;
    const approachPunish = input.distance <= 5.9 && input.closing >= 0.4
        ? 1.2 + Math.max(0, input.closing - 0.4) * 3.4
        : 0;
    const cornerPunish = input.corner && input.distance <= 6.5 && input.cluster <= 1
        ? 0.95
        : 0;
    const exposurePunish = input.engaged && input.distance <= 4.8 && input.cluster <= 1
        ? 1.15
        : 0;
    const imminentPunish = input.hotEta <= 118 ? Math.max(0, 118 - input.hotEta) * 0.018 : 0;
    const localBonus = input.localThreats <= 1 && input.distance <= 5.6
        ? 0.55
        : 0;
    const targetBonus = input.focusSelected ? 0.55 : 0;
    const aggressorBonus = input.recentAggressor ? 0.9 : 0;
    return clamp(stationaryPunish +
        approachPunish +
        cornerPunish +
        exposurePunish +
        imminentPunish +
        isolationBonus +
        localBonus +
        targetBonus +
        aggressorBonus -
        input.pincerRisk * 0.34, 0, 8.5);
}
