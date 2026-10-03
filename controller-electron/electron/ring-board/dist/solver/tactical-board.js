import { predictWindowForEntities, ringLateralMetrics, ringTargetDistance } from "./contact-solver.js";
import { keyOf } from "./control-map.js";
export function buildTacticalBoard(snapshot, control, mode) {
    const self = snapshot.entities.find((entity) => entity.isSelf) ?? null;
    const target = snapshot.entities.find((entity) => entity.id === snapshot.targetId) ?? null;
    if (!self || !target) {
        return null;
    }
    const window = predictWindowForEntities(self, target, snapshot.nowTs);
    const targetDistance = chebyshev(self, target);
    const targetTile = control.targetTile;
    const targetPathDistance = targetTile ? (control.selfDistances.get(keyOf(targetTile.x, targetTile.y)) ?? targetDistance) : targetDistance;
    const targetRing = ringTargetDistance(self, target);
    const metrics = ringLateralMetrics(target.x - self.x, target.y - self.y);
    const localThreatCount = snapshot.entities.filter((entity) => isLocalThreat(self, entity)).length;
    const directChallengerCount = snapshot.entities.filter((entity) => entity.id !== target.id && isDirectChallenger(self, entity)).length;
    const targetIsCamper = !target.moving && control.targetCampFactor >= 1.35;
    const targetIsCornered = (control.targetDegree ?? 4) <= 2 || (control.targetEscapeLong ?? control.targetEscapeNow ?? 4) <= 2;
    const targetCanBeCutOff = targetIsCornered || control.targetPunishFactor >= 2.45 || control.targetVulnerability >= 2.7;
    const laneState = resolveLaneState(metrics.sideDistance, targetPathDistance, localThreatCount);
    const planIntent = resolvePlanIntent(mode, targetIsCamper, targetCanBeCutOff);
    return {
        mode,
        targetId: target.id,
        isDuel: snapshot.round.enemyCount <= 1,
        localThreatCount,
        directChallengerCount,
        targetDistance,
        targetPathDistance,
        targetRingDistance: targetRing,
        targetHotEta: window?.bestAt ?? 999,
        targetIsCamper,
        targetIsCornered,
        targetCanBeCutOff,
        targetIsEngaged: window != null || targetRing <= 2.45,
        laneState,
        planIntent
    };
}
function resolveLaneState(sideDistance, targetPathDistance, localThreatCount) {
    if (localThreatCount >= 2) {
        return "PRESSURE";
    }
    if (sideDistance <= 1.35) {
        return "SIDE";
    }
    if (targetPathDistance <= 3.5 && sideDistance <= 3.15) {
        return "STAGE";
    }
    if (sideDistance <= 2.45) {
        return "STAGE";
    }
    return "FAR";
}
function resolvePlanIntent(mode, targetIsCamper, targetCanBeCutOff) {
    if (mode === "COMMIT" || mode === "PUNISH") {
        return "COMMIT";
    }
    if (mode === "TRAP") {
        return "CUT";
    }
    if (mode === "LURE" || mode === "FEINT" || (targetIsCamper && !targetCanBeCutOff)) {
        return "BAIT";
    }
    return "CONTROL";
}
function isLocalThreat(self, entity) {
    if (!isEnemy(self, entity)) {
        return false;
    }
    return ringTargetDistance(self, entity) <= 4.8 || chebyshev(self, entity) <= 2.8;
}
function isDirectChallenger(self, entity) {
    if (!isEnemy(self, entity)) {
        return false;
    }
    return ringTargetDistance(self, entity) <= 3.35 || chebyshev(self, entity) <= 2;
}
function isEnemy(self, entity) {
    return entity.id !== self.id && !entity.isSelf;
}
function chebyshev(left, right) {
    return Math.max(Math.abs(left.x - right.x), Math.abs(left.y - right.y));
}
