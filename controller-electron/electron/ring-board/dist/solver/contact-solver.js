const CONTACT_HORIZON_MS = 224;
const CONTACT_STEP_MS = 1;
const CONTACT_REFINE_MS = 14;
export function entityToContinuousState(entity, nowTs) {
    const rawAge = entity.stepStartAt > 0 ? Math.max(0, nowTs - entity.stepStartAt) : 0;
    const dur = entity.stepDur > 0 ? entity.stepDur : 550;
    const rawPhase = clamp(entity.phase, 0, 1);
    const progress = entity.moving
        ? clamp(rawPhase > 0 ? rawPhase : rawAge / dur, 0, 1)
        : 1;
    const remain = entity.moving ? Math.max(0, dur * (1 - progress)) : 0;
    const dir = makePoint(entity.dirX, entity.dirY);
    const from = makePoint(entity.fromX, entity.fromY);
    const to = makePoint(entity.toX, entity.toY);
    const pos = entity.moving && from && to
        ? makePoint(from.x + (to.x - from.x) * progress, from.y + (to.y - from.y) * progress)
        : makePoint(entity.x, entity.y);
    const next = entity.moving && dir && to
        ? makePoint(to.x + dir.x, to.y + dir.y)
        : null;
    return {
        id: entity.id,
        moving: entity.moving,
        from,
        to,
        pos,
        dir,
        dur,
        remain,
        age: entity.moving ? Math.round(progress * dur) : 0,
        p: progress,
        nextDur: dur,
        future: next ? [next] : []
    };
}
export function statePosAt(state, offsetMs) {
    if (!state.pos) {
        return null;
    }
    if (offsetMs <= 0) {
        return makePoint(state.pos.x, state.pos.y);
    }
    let cursor = makePoint(state.pos.x, state.pos.y);
    let remaining = offsetMs;
    if (state.moving && state.remain > 0 && state.to) {
        if (remaining <= state.remain) {
            const t = remaining / state.remain;
            return makePoint(cursor.x + (state.to.x - cursor.x) * t, cursor.y + (state.to.y - cursor.y) * t);
        }
        cursor = makePoint(state.to.x, state.to.y);
        remaining -= state.remain;
    }
    if (!state.future.length || state.nextDur <= 0) {
        return cursor;
    }
    for (let index = 0; index < state.future.length; index += 1) {
        const next = state.future[index];
        if (remaining <= state.nextDur) {
            const t = Math.min(1, Math.max(0, remaining / state.nextDur));
            return makePoint(cursor.x + (next.x - cursor.x) * t, cursor.y + (next.y - cursor.y) * t);
        }
        cursor = makePoint(next.x, next.y);
        remaining -= state.nextDur;
    }
    return cursor;
}
export function contactClass(dx, dy) {
    const metrics = ringLateralMetrics(dx, dy);
    const absX = metrics.absX;
    const absY = metrics.absY;
    const gap = metrics.laneGap;
    let score = 0;
    // Ring contact is lateral only. In board-space that lives on the same-sign
    // isometric band; opposite-sign diagonals and orthogonal neighbors are not
    // valid striking contact even if they look "adjacent" in generic grid terms.
    if (!metrics.validSideLane) {
        return null;
    }
    if (absX >= 0.88 && absY >= 0.88 && absX <= 1.22 && absY <= 1.22 && gap <= 0.22) {
        score = Math.max(Math.abs(absX - 1), Math.abs(absY - 1), gap);
        return { kind: "HOT", priority: 0, score, dx, dy };
    }
    if (absX >= 0.72 && absY >= 0.72 && absX <= 1.42 && absY <= 1.42 && gap <= 0.34) {
        score = Math.max(Math.abs(absX - 1), Math.abs(absY - 1), gap);
        return { kind: "DIAG", priority: 1, score, dx, dy };
    }
    if (absX >= 1.55 && absY >= 1.55 && absX <= 2.45 && absY <= 2.45 && gap <= 0.5) {
        score = Math.max(Math.abs(absX - 2), Math.abs(absY - 2), gap);
        return { kind: "STAGE", priority: 2, score, dx, dy };
    }
    if (absX >= 0.62 && absY >= 0.62 && absX <= 2.2 && absY <= 2.2 && gap <= 0.85) {
        score = Math.max(Math.abs(absX - 1.5), Math.abs(absY - 1.5), gap);
        return { kind: "APPROACH", priority: 3, score, dx, dy };
    }
    return null;
}
export function ringLateralMetrics(dx, dy) {
    const absX = Math.abs(dx);
    const absY = Math.abs(dy);
    const laneGap = Math.abs(absX - absY);
    const validSideLane = dx !== 0 && dy !== 0 && dx * dy > 0;
    const orientationPenalty = validSideLane ? 0 : 6;
    const sideDistance = Math.max(absX, absY) + laneGap * 1.5 + orientationPenalty;
    return {
        validSideLane,
        absX,
        absY,
        laneGap,
        sideDistance
    };
}
export function ringTargetDistance(left, right) {
    const metrics = ringLateralMetrics(right.x - left.x, right.y - left.y);
    return metrics.sideDistance;
}
export function predictContactWindow(self, target, horizonMs = CONTACT_HORIZON_MS, stepMs = CONTACT_STEP_MS) {
    let best = null;
    for (let offset = 0; offset <= horizonMs; offset += stepMs) {
        const selfPos = statePosAt(self, offset);
        const targetPos = statePosAt(target, offset);
        if (!selfPos || !targetPos) {
            continue;
        }
        const candidate = contactClass(targetPos.x - selfPos.x, targetPos.y - selfPos.y);
        if (candidate &&
            (!best ||
                candidate.priority < best.priority ||
                (candidate.priority === best.priority &&
                    (candidate.score < best.score - 0.035 ||
                        (Math.abs(candidate.score - best.score) <= 0.035 && offset < best.bestAt))))) {
            best = {
                ...candidate,
                startAt: offset,
                bestAt: offset,
                endAt: offset
            };
        }
    }
    if (!best) {
        return null;
    }
    let startAt = best.bestAt;
    let endAt = best.bestAt;
    const refineStart = Math.max(0, best.bestAt - Math.max(stepMs, CONTACT_REFINE_MS));
    const refineEnd = Math.min(horizonMs, best.bestAt + Math.max(stepMs, CONTACT_REFINE_MS));
    for (let offset = refineStart; offset <= refineEnd; offset += 1) {
        const selfPos = statePosAt(self, offset);
        const targetPos = statePosAt(target, offset);
        const current = selfPos && targetPos ? contactClass(targetPos.x - selfPos.x, targetPos.y - selfPos.y) : null;
        if (current && current.kind === best.kind) {
            startAt = Math.min(startAt, offset);
            endAt = Math.max(endAt, offset);
        }
    }
    if (startAt > best.bestAt) {
        startAt = best.bestAt;
    }
    if (endAt < best.bestAt) {
        endAt = best.bestAt;
    }
    return {
        ...best,
        startAt,
        endAt
    };
}
export function predictWindowForEntities(self, target, nowTs) {
    const selfState = entityToContinuousState(self, nowTs);
    const targetState = entityToContinuousState(target, nowTs);
    return predictWindowForStates(selfState, targetState, target.id);
}
export function predictWindowForStates(selfState, targetState, targetId, hypothesis = "LIVE", planAligned = false, timingProfile = "default") {
    const raw = predictContactWindow(selfState, targetState, CONTACT_HORIZON_MS, CONTACT_STEP_MS);
    if (!raw) {
        return null;
    }
    const nowSelf = statePosAt(selfState, 0);
    const nowTarget = statePosAt(targetState, 0);
    const futureSelf = statePosAt(selfState, raw.bestAt);
    const futureTarget = statePosAt(targetState, raw.bestAt);
    if (!nowSelf || !nowTarget || !futureSelf || !futureTarget) {
        return null;
    }
    const deltaNowX = nowTarget.x - nowSelf.x;
    const deltaNowY = nowTarget.y - nowSelf.y;
    const deltaFutureX = futureTarget.x - futureSelf.x;
    const deltaFutureY = futureTarget.y - futureSelf.y;
    const relVelX = (futureTarget.x - nowTarget.x) - (futureSelf.x - nowSelf.x);
    const relVelY = (futureTarget.y - nowTarget.y) - (futureSelf.y - nowSelf.y);
    const signX = sign(deltaFutureX);
    const signY = sign(deltaFutureY);
    const fireDelay = predictFireDelay(raw, relVelX, relVelY, timingProfile);
    const widthMs = Math.max(0, raw.endAt - raw.startAt);
    const confidence = predictWindowConfidence(raw.kind, widthMs, hypothesis, planAligned);
    return {
        kind: raw.kind,
        reason: `${raw.kind}_${signX}_${signY}`,
        targetId,
        sourceTargetId: targetId,
        startAt: raw.startAt,
        bestAt: raw.bestAt,
        endAt: raw.endAt,
        fireDelay,
        deltaNowX,
        deltaNowY,
        deltaFutureX,
        deltaFutureY,
        relVelX,
        relVelY,
        signX,
        signY,
        score: raw.score,
        confidence,
        hypothesis,
        planAligned,
        widthMs
    };
}
export function predictBestWindowForSelf(self, entities, nowTs, preferredTargetId = -1) {
    if (!self) {
        return null;
    }
    let best = null;
    for (const candidate of entities) {
        if (!isCandidateTarget(self, candidate)) {
            continue;
        }
        const window = predictWindowForEntities(self, candidate, nowTs);
        if (!window) {
            continue;
        }
        if (!best ||
            compareWindows(window, best, preferredTargetId) < 0) {
            best = window;
        }
    }
    return best;
}
export function predictFireDelay(window, relVelX = 0, relVelY = 0, timingProfile = "default") {
    const relSpeed = Math.abs(relVelX) + Math.abs(relVelY);
    const width = Math.max(0, window.endAt - window.startAt);
    if (timingProfile === "nearest_exact") {
        switch (window.kind) {
            case "HOT":
                return clamp(Math.round(window.startAt - 10 - Math.min(6, relSpeed * 3.3) - Math.min(2, width * 0.24)), 0, window.endAt + 8);
            case "DIAG":
                return clamp(Math.round(window.startAt - 11 - Math.min(7, relSpeed * 3.6) - Math.min(2, width * 0.28)), 0, window.endAt + 8);
            default:
                break;
        }
    }
    switch (window.kind) {
        case "HOT":
            return clamp(Math.round(window.startAt - 3 - Math.min(3, relSpeed * 2.1) - Math.min(1, width * 0.12)), 0, window.endAt + 10);
        case "DIAG":
            return clamp(Math.round(window.startAt - 4 - Math.min(4, relSpeed * 2.5) - Math.min(1, width * 0.16)), 0, window.endAt + 10);
        case "STAGE":
            return clamp(Math.round(window.startAt - 11 - Math.min(7, relSpeed * 3.4) - Math.min(5, width * 0.3)), 0, window.endAt + 12);
        case "APPROACH":
            return clamp(Math.round(window.startAt - 14 - Math.min(9, relSpeed * 4.1) - Math.min(7, width * 0.4)), 0, window.endAt + 12);
        default:
            return clamp(Math.round(window.startAt - 8), 0, window.endAt + 10);
    }
}
function compareWindows(left, right, preferredTargetId) {
    const kindDiff = kindRank(left.kind) - kindRank(right.kind);
    if (kindDiff !== 0) {
        return kindDiff;
    }
    // If both are same class and close in time, prefer explicitly selected target.
    const leftPreferred = left.targetId === preferredTargetId;
    const rightPreferred = right.targetId === preferredTargetId;
    const bestAtDiff = left.bestAt - right.bestAt;
    if (Math.abs(bestAtDiff) <= 18 && leftPreferred !== rightPreferred) {
        return leftPreferred ? -1 : 1;
    }
    const fireDelayDiff = left.fireDelay - right.fireDelay;
    if (fireDelayDiff !== 0) {
        return fireDelayDiff;
    }
    if (left.confidence !== right.confidence) {
        return right.confidence - left.confidence;
    }
    if (bestAtDiff !== 0) {
        return bestAtDiff;
    }
    if (left.score !== right.score) {
        return left.score - right.score;
    }
    return left.targetId - right.targetId;
}
export function withFuturePath(state, future) {
    return {
        ...state,
        future: future.map((point) => makePoint(point.x, point.y))
    };
}
function predictWindowConfidence(kind, widthMs, hypothesis, planAligned) {
    const base = kind === "HOT" ? 0.92 :
        kind === "DIAG" ? 0.82 :
            kind === "STAGE" ? 0.68 :
                0.56;
    const widthBoost = Math.min(0.12, widthMs * 0.012);
    const hypothesisPenalty = hypothesis.includes("GLIDE") ? 0.12 :
        hypothesis.includes("CONTINUE") ? 0.06 :
            0;
    const alignmentBoost = planAligned ? 0.08 : 0;
    return clamp(base + widthBoost + alignmentBoost - hypothesisPenalty, 0.08, 0.99);
}
function kindRank(kind) {
    switch (kind) {
        case "HOT":
            return 0;
        case "DIAG":
            return 1;
        case "STAGE":
            return 2;
        case "APPROACH":
            return 3;
        default:
            return 9;
    }
}
function isCandidateTarget(self, target) {
    if (target.id === self.id || target.isSelf) {
        return false;
    }
    // Ignore dummy placeholders (common for despawn/unknown entities).
    if (target.toX === 0 &&
        target.toY === 0 &&
        target.fromX === 0 &&
        target.fromY === 0 &&
        Math.round(target.x) === 0 &&
        Math.round(target.y) === 0) {
        return false;
    }
    return true;
}
function makePoint(x, y) {
    return { x, y };
}
function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}
function sign(value) {
    if (value < 0) {
        return -1;
    }
    if (value > 0) {
        return 1;
    }
    return 0;
}
