import { entityToContinuousState, ringLateralMetrics, ringTargetDistance, statePosAt } from "./contact-solver.js";
export function buildControlMap(scene, entities, selfId, targetId, nowTs) {
    const self = entities.find((entity) => entity.id === selfId) ?? null;
    if (!self) {
        return null;
    }
    const selfTile = resolveEntityTile(self, scene);
    if (!selfTile) {
        return null;
    }
    const selfDistances = buildDistanceMap(scene, selfTile);
    const walkable = new Set(selfDistances.keys());
    const target = targetId >= 0 ? entities.find((entity) => entity.id === targetId) ?? null : null;
    const targetTile = target ? resolveEntityTile(target, scene) : null;
    const targetDegree = targetTile ? tileDegree(targetTile.x, targetTile.y, scene, walkable) : null;
    const targetOpenness = targetTile ? localReach(scene, targetTile, 2, walkable) : null;
    const targetEscapeNow = targetTile ? escapeOptions(scene, targetTile, walkable) : null;
    const targetCampFactor = targetTile && targetDegree != null && targetOpenness != null
        ? Math.max(0, 3 - targetDegree) * 1.45 + Math.max(0, 7 - targetOpenness) * 0.1
        : 0;
    const targetState = target ? entityToContinuousState(target, nowTs) : null;
    const targetShortTile = targetState ? pointFromFloat(statePosAt(targetState, 88)) : targetTile;
    const targetLongTile = targetState ? pointFromFloat(statePosAt(targetState, 154)) : targetShortTile;
    const targetNowDistances = targetTile ? buildDistanceMap(scene, targetTile) : null;
    const targetShortDistances = targetShortTile && (!targetTile || targetShortTile.x !== targetTile.x || targetShortTile.y !== targetTile.y)
        ? buildDistanceMap(scene, targetShortTile)
        : targetNowDistances;
    const targetLongDistances = targetLongTile &&
        (!targetShortTile || targetLongTile.x !== targetShortTile.x || targetLongTile.y !== targetShortTile.y)
        ? buildDistanceMap(scene, targetLongTile)
        : targetShortDistances;
    const targetEscapeLong = targetLongTile ? escapeOptions(scene, targetLongTile, walkable) : targetEscapeNow;
    const targetVulnerability = targetTile && targetDegree != null && targetOpenness != null
        ? Math.max(0, 3 - targetDegree) * 1.35 +
            Math.max(0, 7 - targetOpenness) * 0.12 +
            Math.max(0, 3 - (targetEscapeLong ?? targetEscapeNow ?? 4)) * 1.1
        : 0;
    const targetPunishFactor = targetCampFactor * 0.7 + targetVulnerability * 0.95;
    const enemies = entities
        .filter((entity) => entity.id !== selfId && !entity.isSelf)
        .map((entity) => {
        const tile = resolveEntityTile(entity, scene);
        if (!tile) {
            return null;
        }
        const state = entityToContinuousState(entity, nowTs);
        return {
            entity,
            tile,
            shortTile: pointFromFloat(statePosAt(state, 88)) ?? tile,
            longTile: pointFromFloat(statePosAt(state, 154)) ?? tile
        };
    })
        .filter((item) => item !== null);
    const tiles = new Map();
    for (const [key, selfSteps] of selfDistances) {
        const tile = pointFromKey(key);
        const degree = tileDegree(tile.x, tile.y, scene, walkable);
        const openness = localReach(scene, tile, 2, walkable);
        const lane = straightLane(scene, tile, walkable);
        const pressureNow = sumEnemyPressure(tile, enemies.map((enemy) => enemy.tile));
        const pressureShort = sumEnemyPressure(tile, enemies.map((enemy) => enemy.shortTile));
        const pressureLong = sumEnemyPressure(tile, enemies.map((enemy) => enemy.longTile));
        const dangerNow = pressureNow;
        const dangerShort = pressureShort * 0.95 + Math.max(0, 2.4 - minEnemyDist(tile, enemies.map((enemy) => enemy.shortTile))) * 0.8;
        const dangerLong = pressureLong * 0.9 + Math.max(0, 2.8 - minEnemyDist(tile, enemies.map((enemy) => enemy.longTile))) * 0.65;
        const closestEnemyNow = minEnemyDist(tile, enemies.map((enemy) => enemy.tile));
        const closestEnemyLong = minEnemyDist(tile, enemies.map((enemy) => enemy.longTile));
        const targetDistNow = targetTile ? ringTargetDistance(tile, targetTile) : 99;
        const targetDistShort = targetShortTile ? ringTargetDistance(tile, targetShortTile) : targetDistNow;
        const targetDistLong = targetLongTile ? ringTargetDistance(tile, targetLongTile) : targetDistShort;
        const targetPathNow = targetTile ? pathDistanceAt(tile, targetNowDistances, targetTile) : 99;
        const targetPathShort = targetShortTile ? pathDistanceAt(tile, targetShortDistances, targetShortTile) : targetPathNow;
        const targetPathLong = targetLongTile ? pathDistanceAt(tile, targetLongDistances, targetLongTile) : targetPathShort;
        const targetLateralLong = targetLongTile ? lateralOpportunity(tile, targetLongTile) : 0;
        const vulnerabilityNow = targetTile
            ? vulnerabilityAtTile(tile, targetTile, targetEscapeNow ?? 4, targetVulnerability, dangerNow, dangerShort, targetDistNow, targetLateralLong)
            : 0;
        const vulnerabilityShort = targetShortTile
            ? vulnerabilityAtTile(tile, targetShortTile, targetEscapeNow ?? 4, targetVulnerability, dangerShort, dangerLong, targetDistShort, targetLateralLong)
            : vulnerabilityNow;
        const vulnerabilityLong = targetLongTile
            ? vulnerabilityAtTile(tile, targetLongTile, targetEscapeLong ?? targetEscapeNow ?? 4, targetVulnerability, dangerLong, dangerLong, targetDistLong, targetLateralLong)
            : vulnerabilityShort;
        const pincerRisk = pincerRiskAt(tile, enemies.map((enemy) => enemy.shortTile));
        const safeLaneScore = openness * 0.62 +
            lane * 1.12 +
            closestEnemyLong * 0.78 -
            dangerNow * 0.35 -
            dangerShort * 0.45 -
            dangerLong * 0.95 -
            pincerRisk * 0.5 -
            Math.max(0, pressureNow - 1) * 0.22;
        const deadEndPenalty = Math.max(0, 2 - degree) * 1.6 +
            Math.max(0, 4 - openness) * 0.2 +
            pincerRisk * 0.18;
        const baitRingScore = bandScore(targetDistNow, 2, 3, 3.8) +
            bandScore(targetDistShort, 2, 4, 2.2) +
            targetLateralLong * 0.35 +
            targetCampFactor * 0.48 +
            safeLaneScore * 0.24 -
            dangerNow * 0.12 -
            dangerShort * 0.6 -
            pincerRisk * 0.82;
        const trapScore = contactBandScore(targetDistLong) +
            bandScore(targetDistShort, 1, 2, 2.6) +
            targetLateralLong * 0.75 +
            targetCampFactor * 0.38 -
            dangerLong * 0.8 -
            pincerRisk * 0.95 -
            deadEndPenalty * 0.55;
        const interceptScore = bandScore(targetDistShort, 1, 2, 3.4) +
            bandScore(targetDistLong, 1, 2, 2.4) +
            targetCampFactor * 0.34 +
            safeLaneScore * 0.2 -
            dangerLong * 0.68 -
            deadEndPenalty * 0.35;
        const escapeScore = openness * 0.9 +
            degree * 0.7 +
            lane * 0.65 +
            closestEnemyLong * 1.2 -
            pressureNow * 0.4 -
            pressureShort * 0.6 -
            pressureLong * 1.62 -
            pincerRisk * 0.7;
        const baitScore = bandScore(targetDistNow, 2, 3, 4.5) +
            bandScore(targetDistShort, 2, 3, 2.1) +
            targetCampFactor * 0.72 +
            openness * 0.45 +
            lane * 0.25 +
            targetLateralLong * 0.4 -
            pressureNow * 0.2 -
            pressureLong * 0.95;
        const commitScore = contactBandScore(targetDistLong) +
            bandScore(targetDistShort, 1, 2, 2.8) +
            targetCampFactor * 0.72 +
            vulnerabilityLong * 0.62 +
            targetLateralLong * 0.65 +
            degree * 0.2 -
            pressureLong * 1.05 -
            pressureShort * 0.45;
        const punishScore = vulnerabilityNow * 0.36 +
            vulnerabilityShort * 0.82 +
            vulnerabilityLong * 1.28 +
            targetPunishFactor * 0.72 +
            contactBandScore(targetDistLong) * 0.58 +
            bandScore(targetDistShort, 1, 2, 2.4) +
            targetLateralLong * 0.48 +
            safeLaneScore * 0.14 -
            dangerLong * 0.55 -
            pincerRisk * 0.7 -
            deadEndPenalty * 0.18;
        tiles.set(key, {
            tile,
            selfSteps,
            degree,
            openness,
            lane,
            dangerNow,
            dangerShort,
            dangerLong,
            pincerRisk,
            safeLaneScore,
            deadEndPenalty,
            baitRingScore,
            trapScore,
            interceptScore,
            pressureNow,
            pressureShort,
            pressureLong,
            closestEnemyNow,
            closestEnemyLong,
            targetDistNow,
            targetDistShort,
            targetDistLong,
            targetPathNow,
            targetPathShort,
            targetPathLong,
            targetLateralLong,
            vulnerabilityNow,
            vulnerabilityShort,
            vulnerabilityLong,
            punishScore,
            escapeScore,
            baitScore,
            commitScore
        });
    }
    return {
        scene,
        walkable,
        selfTile,
        targetTile,
        targetShortTile,
        targetLongTile,
        targetDegree,
        targetOpenness,
        targetEscapeNow,
        targetEscapeLong,
        targetVulnerability,
        targetPunishFactor,
        targetCampFactor,
        enemyCount: enemies.length,
        selfDistances,
        tiles,
        enemyTiles: enemies.map((enemy) => enemy.tile)
    };
}
function pathDistanceAt(tile, distances, fallbackTarget) {
    if (!distances) {
        return chebyshev(tile, fallbackTarget);
    }
    return distances.get(keyOf(tile.x, tile.y)) ?? chebyshev(tile, fallbackTarget) + 3;
}
export function buildDistanceMap(scene, start) {
    const matrix = scene.walkableMatrix ?? scene.matrix;
    const distances = new Map();
    distances.set(keyOf(start.x, start.y), 0);
    const queue = [start];
    let cursor = 0;
    while (cursor < queue.length) {
        const current = queue[cursor++];
        const currentDist = distances.get(keyOf(current.x, current.y)) ?? 0;
        for (const next of neighborsOf(current)) {
            if (!inBounds(next, scene)) {
                continue;
            }
            if (!isWalkableTile(matrix[next.y]?.[next.x] ?? 1)) {
                continue;
            }
            const key = keyOf(next.x, next.y);
            if (distances.has(key)) {
                continue;
            }
            distances.set(key, currentDist + 1);
            queue.push(next);
        }
    }
    return distances;
}
export function resolveEntityTile(entity, scene) {
    const candidates = [
        { x: entity.toX, y: entity.toY },
        { x: Math.round(entity.x), y: Math.round(entity.y) },
        { x: entity.fromX, y: entity.fromY }
    ];
    for (const candidate of candidates) {
        if (!inBounds(candidate, scene)) {
            continue;
        }
        if (isWalkableTile((scene.walkableMatrix ?? scene.matrix)[candidate.y]?.[candidate.x] ?? 1)) {
            return candidate;
        }
    }
    return null;
}
export function sameTile(left, right) {
    return left.x === right.x && left.y === right.y;
}
export function keyOf(x, y) {
    return `${x},${y}`;
}
export function pointFromKey(key) {
    const [x, y] = key.split(",").map((value) => Number(value));
    return { x, y };
}
function pointFromFloat(point) {
    if (!point) {
        return null;
    }
    return { x: Math.round(point.x), y: Math.round(point.y) };
}
function neighborsOf(tile) {
    return [
        { x: tile.x + 1, y: tile.y },
        { x: tile.x - 1, y: tile.y },
        { x: tile.x, y: tile.y + 1 },
        { x: tile.x, y: tile.y - 1 }
    ];
}
function sumEnemyPressure(tile, enemies) {
    return enemies.reduce((sum, enemy) => sum + enemyPressure(enemy, tile), 0);
}
function minEnemyDist(tile, enemies) {
    if (enemies.length === 0) {
        return 8;
    }
    let best = 99;
    for (const enemy of enemies) {
        best = Math.min(best, chebyshev(tile, enemy));
    }
    return best;
}
function enemyPressure(enemy, tile) {
    const dist = chebyshev(enemy, tile);
    if (dist <= 1) {
        return 3.4;
    }
    if (dist === 2) {
        return 1.8;
    }
    if (dist === 3) {
        return 0.8;
    }
    if (dist === 4) {
        return 0.25;
    }
    return 0;
}
function pincerRiskAt(tile, enemies) {
    if (enemies.length <= 1) {
        return enemies.length * 0.4;
    }
    let oppositePairs = 0;
    const quadrants = new Set();
    for (let i = 0; i < enemies.length; i += 1) {
        const dx = enemies[i].x - tile.x;
        const dy = enemies[i].y - tile.y;
        quadrants.add(`${dx >= 0 ? "R" : "L"}${dy >= 0 ? "D" : "U"}`);
        const magA = Math.hypot(dx, dy);
        for (let j = i + 1; j < enemies.length; j += 1) {
            const odx = enemies[j].x - tile.x;
            const ody = enemies[j].y - tile.y;
            const magB = Math.hypot(odx, ody);
            if (magA < 0.001 || magB < 0.001) {
                continue;
            }
            const dot = (dx * odx + dy * ody) / (magA * magB);
            if (dot < -0.18) {
                oppositePairs += 1;
            }
        }
    }
    return enemies.length * 0.7 + oppositePairs * 0.95 + Math.max(0, quadrants.size - 2) * 0.25;
}
function localReach(scene, start, maxSteps, walkable) {
    const seen = new Set([keyOf(start.x, start.y)]);
    const queue = [{ tile: start, steps: 0 }];
    let cursor = 0;
    while (cursor < queue.length) {
        const current = queue[cursor++];
        if (current.steps >= maxSteps) {
            continue;
        }
        for (const next of neighborsOf(current.tile)) {
            if (!inBounds(next, scene)) {
                continue;
            }
            const key = keyOf(next.x, next.y);
            if (!walkable.has(key) || seen.has(key)) {
                continue;
            }
            seen.add(key);
            queue.push({ tile: next, steps: current.steps + 1 });
        }
    }
    return seen.size;
}
function straightLane(scene, tile, walkable) {
    let best = 0;
    const dirs = [
        { x: 1, y: 0 },
        { x: -1, y: 0 },
        { x: 0, y: 1 },
        { x: 0, y: -1 }
    ];
    for (const dir of dirs) {
        let len = 0;
        let cursor = { x: tile.x + dir.x, y: tile.y + dir.y };
        while (inBounds(cursor, scene) && walkable.has(keyOf(cursor.x, cursor.y)) && len < 5) {
            len += 1;
            cursor = { x: cursor.x + dir.x, y: cursor.y + dir.y };
        }
        best = Math.max(best, len);
    }
    return best;
}
function tileDegree(x, y, scene, walkable) {
    let degree = 0;
    for (const next of neighborsOf({ x, y })) {
        if (!inBounds(next, scene)) {
            continue;
        }
        if (walkable.has(keyOf(next.x, next.y))) {
            degree += 1;
        }
    }
    return degree;
}
function escapeOptions(scene, tile, walkable) {
    let exits = 0;
    for (const next of neighborsOf(tile)) {
        if (!inBounds(next, scene)) {
            continue;
        }
        if (walkable.has(keyOf(next.x, next.y))) {
            exits += 1;
        }
    }
    return exits;
}
function vulnerabilityAtTile(tile, targetTile, targetEscapes, targetVulnerability, dangerNear, dangerFar, targetDist, targetLateral) {
    const pressureBand = targetDist <= 1
        ? 3.8
        : targetDist === 2
            ? 2.35
            : targetDist === 3
                ? 1.05
                : -Math.max(0, targetDist - 3) * 0.55;
    const escapeClamp = Math.max(0, 3 - targetEscapes) * 0.95;
    const cutoffCoverage = coveragePressure(tile, targetTile);
    return (pressureBand +
        targetVulnerability * 0.55 +
        escapeClamp +
        cutoffCoverage * 0.68 +
        targetLateral * 0.18 -
        dangerNear * 0.16 -
        dangerFar * 0.24);
}
function coveragePressure(tile, targetTile) {
    const dist = ringTargetDistance(tile, targetTile);
    if (dist <= 1.15) {
        return 2.4;
    }
    if (dist <= 2.25) {
        return 1.45;
    }
    if (dist <= 3.25) {
        return 0.55;
    }
    return 0;
}
function contactBandScore(dist) {
    if (dist <= 1.12) {
        return 5.8;
    }
    if (dist <= 2.25) {
        return 2.4;
    }
    if (dist <= 0.2) {
        return -5;
    }
    return -dist * 1.15;
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
function lateralOpportunity(tile, targetTile) {
    const metrics = ringLateralMetrics(targetTile.x - tile.x, targetTile.y - tile.y);
    if (metrics.validSideLane) {
        if (metrics.sideDistance <= 1.15) {
            return 3.4;
        }
        if (metrics.sideDistance <= 2.25) {
            return 2.3;
        }
        if (metrics.sideDistance <= 3.4) {
            return 1.15;
        }
        return Math.max(0, 1.15 - (metrics.sideDistance - 3.4) * 0.45);
    }
    return -0.65 - Math.min(2.6, metrics.laneGap * 0.6 + Math.max(0, metrics.sideDistance - 3.2) * 0.22);
}
function chebyshev(left, right) {
    return Math.max(Math.abs(left.x - right.x), Math.abs(left.y - right.y));
}
function isWalkableTile(tile) {
    return tile === 0 || tile === 2;
}
function inBounds(tile, scene) {
    return tile.x >= 0 && tile.y >= 0 && tile.x < scene.width && tile.y < scene.height;
}
