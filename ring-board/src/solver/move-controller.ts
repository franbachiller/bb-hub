import type {
  AdaptiveTuning,
  BrainMode,
  EntityStatePayload,
  MovePlanCommandMessage,
  ServerStateSnapshot,
  TilePoint
} from "../shared/protocol.js";
import {
  buildControlMap,
  buildDistanceMap,
  keyOf,
  resolveEntityTile,
  sameTile,
  type ControlMap,
  type ControlTile
} from "./control-map.js";
import { predictWindowForEntities, ringLateralMetrics, ringTargetDistance } from "./contact-solver.js";
import { buildTacticalBoard } from "./tactical-board.js";
import { rerankPlansByTacticalBoard } from "./tactical-planner.js";

interface PlanCandidate {
  first: ControlTile;
  second: ControlTile;
  third: ControlTile;
  score: number;
}

interface SearchBudget {
  firstMax: number;
  secondMax: number;
  thirdMax: number;
  beamWidth: number;
}

interface PlannerRuntimeOptions {
  highPower?: boolean;
}

export class MoveController {
  private lastSentAt = 0;

  private lastKey = "";

  private selfBusy = false;

  private movementTargetId = -1;

  private movementLockUntil = 0;

  private recentPrimaryKeys: string[] = [];

  public evaluate(
    snapshot: ServerStateSnapshot,
    nowWall: number,
    options: PlannerRuntimeOptions = {}
  ): MovePlanCommandMessage | null {
    if (!snapshot.armed || !snapshot.scene || snapshot.scene.policy !== "allowed") {
      return null;
    }
    if (snapshot.round.phase !== "LIVE") {
      return null;
    }

    const self = snapshot.entities.find((entity) => entity.isSelf) ?? null;
    if (!self) {
      return null;
    }
    const mode = resolveMode(snapshot);

    const nowBusy = Boolean(self.combatState?.busy) || Boolean(self.combatState?.react);
    if (nowBusy) {
      this.selfBusy = true;
      return null;
    }
    if (this.selfBusy && !nowBusy) {
      this.lastKey = "";
      this.lastSentAt = 0;
      this.selfBusy = false;
    }

    const targetChoice = selectMovementTarget(snapshot, self, mode, this.movementTargetId, this.movementLockUntil);
    if (!targetChoice) {
      return null;
    }
    const target = targetChoice.entity;
    this.movementTargetId = target.id;
    this.movementLockUntil = targetChoice.lockedUntil;

    const control = buildControlMap(
      snapshot.scene,
      snapshot.entities,
      self.id,
      target.id,
      snapshot.frameTs
    );
    if (!control) {
      return null;
    }

    const occupied = buildOccupiedSet(snapshot.entities, self.id, snapshot.scene);
    const boardState = buildTacticalBoard(snapshot, control, mode);
    const plans = rerankPlansByTacticalBoard(
      searchPlans(snapshot, control, boardState, target, mode, occupied, this.recentPrimaryKeys, Boolean(options.highPower)),
      control,
      boardState,
      mode,
      Boolean(options.highPower)
    );
    if (plans.length === 0) {
      return null;
    }

    const best = selectCommittedPlan(snapshot, plans, control, boardState, target, mode, Boolean(options.highPower));
    const planTiles = uniquePlanTiles([best.first.tile, best.second.tile, best.third.tile]);
    const execution = chooseExecutionTiles(best, plans, boardState, target, mode);
    const primaryTile = execution.primary;
    const backupPrimary = execution.backup;

    const key = [
      snapshot.scene.sceneHash,
      target.id,
      mode,
      `${primaryTile.x},${primaryTile.y}`,
      ...planTiles.map((tile) => `${tile.x},${tile.y}`),
      backupPrimary?.x ?? -1,
      backupPrimary?.y ?? -1
    ].join(":");

    const minInterval = moveIntervalByMode(mode, self.moving);
    if (key === this.lastKey && nowWall - this.lastSentAt < minInterval) {
      return null;
    }

    this.lastKey = key;
    this.lastSentAt = nowWall;
    rememberPrimaryKey(this.recentPrimaryKeys, keyOf(primaryTile.x, primaryTile.y));

    return {
      type: "move_plan",
      targetId: target.id,
      reason: buildReason(snapshot, mode, best, backupPrimary, targetChoice.reason, primaryTile),
      mode,
      moveAt: Math.max(nowWall, snapshot.frameWall + 1),
      primaryTile,
      backupTile: backupPrimary,
      planTiles,
      sceneHash: snapshot.scene.sceneHash,
      issuedAtTs: snapshot.frameTs,
      expiresAtTs: snapshot.frameTs + 320
    };
  }

  public reset(): void {
    this.lastSentAt = 0;
    this.lastKey = "";
    this.selfBusy = false;
    this.movementTargetId = -1;
    this.movementLockUntil = 0;
    this.recentPrimaryKeys = [];
  }
}

interface MovementTargetChoice {
  entity: EntityStatePayload;
  score: number;
  reason: string;
  lockedUntil: number;
}

function selectMovementTarget(
  snapshot: ServerStateSnapshot,
  self: EntityStatePayload,
  mode: BrainMode,
  heldTargetId: number,
  heldUntil: number
): MovementTargetChoice | null {
  const scene = snapshot.scene;
  if (!scene) {
    return null;
  }
  const enemies = snapshot.entities.filter((entity) => isLiveEnemy(self, entity));
  if (enemies.length === 0) {
    return null;
  }
  const nowWall = snapshot.nowWall;
  const explicitTarget =
    snapshot.targetId >= 0 ? enemies.find((entity) => entity.id === snapshot.targetId) ?? null : null;
  if (explicitTarget) {
    const explicitScore = scoreMovementTarget(
      snapshot,
      self,
      explicitTarget,
      mode,
      snapshot.targetId,
      heldTargetId,
      enemies.filter((enemy) => isLocalRingThreat(self, enemy)).length
    );
    return {
      entity: explicitTarget,
      score: explicitScore,
      reason: buildTargetReason("LOCK", explicitTarget, explicitScore, isCornerLike(explicitTarget, scene), 0, mode),
      lockedUntil: nowWall + 52
    };
  }
  const localThreatCount = enemies.filter((enemy) => isLocalRingThreat(self, enemy)).length;
  const nearestImmediate = enemies
    .map((entity) => ({
      entity,
      cheb: chebyshev(self, entity),
      ring: ringTargetDistance(self, entity),
      hotEta: predictWindowForEntities(self, entity, snapshot.nowTs)?.bestAt ?? 999,
      toward: movementTowardSelf(self, entity),
    }))
    .filter(
      ({ cheb, ring, hotEta, toward }) =>
        cheb <= 5.4 &&
        ring <= 5.1 &&
        (cheb <= 4.2 || ring <= 4.1 || hotEta <= 156 || toward >= 0.09)
    )
    .sort(
      (left, right) =>
        Number(right.ring <= 3.2) - Number(left.ring <= 3.2) ||
        left.cheb - right.cheb ||
        left.ring - right.ring ||
        left.hotEta - right.hotEta ||
        right.toward - left.toward ||
        left.entity.id - right.entity.id
    )[0];
  if (nearestImmediate) {
    return {
      entity: nearestImmediate.entity,
      score: 1000,
      reason: buildTargetReason(
        "LOCK",
        nearestImmediate.entity,
        1000,
        isCornerLike(nearestImmediate.entity, scene),
        localThreatCount,
        mode
      ),
      lockedUntil: nowWall + 120
    };
  }
  const nearest = enemies
    .map((entity) => ({
      entity,
      cheb: chebyshev(self, entity),
      distance: ringTargetDistance(self, entity),
      hotEta: predictWindowForEntities(self, entity, snapshot.nowTs)?.bestAt ?? 999,
      toward: movementTowardSelf(self, entity)
    }))
    .filter(
      ({ cheb, distance, toward, hotEta }) =>
        cheb <= 5.8 &&
        distance <= 5.4 &&
        (distance <= 4.6 || cheb <= 4.8 || toward >= 0.08 || hotEta <= 168)
    )
    .sort(
      (left, right) =>
        Number(right.distance <= 3.3) - Number(left.distance <= 3.3) ||
        left.cheb - right.cheb ||
        left.distance - right.distance ||
        left.hotEta - right.hotEta ||
        right.toward - left.toward ||
        left.entity.id - right.entity.id
    )[0];
  if (nearest) {
    const lockedUntil = snapshot.nowWall + 80;
    return {
      entity: nearest.entity,
      score: 999,
      reason: buildTargetReason("LOCK", nearest.entity, 999, isCornerLike(nearest.entity, scene), 0, mode),
      lockedUntil
    };
  }

  const anchorTargetId = snapshot.targetId >= 0 ? snapshot.targetId : (snapshot.brain?.anchorTargetId ?? -1);
  const forcedFocus =
    anchorTargetId >= 0 ? enemies.find((entity) => entity.id === anchorTargetId) ?? null : null;
  const forcedDistance = forcedFocus ? chebyshev(self, forcedFocus) : 99;
  const forcedHotEta =
    forcedFocus ? (predictWindowForEntities(self, forcedFocus, snapshot.nowTs)?.bestAt ?? 999) : 999;
  const frontlineTarget = enemies
    .map((entity) => ({
      entity,
      distance: chebyshev(self, entity),
      hotEta: predictWindowForEntities(self, entity, snapshot.nowTs)?.bestAt ?? 999,
      toward: movementTowardSelf(self, entity),
      stationary: !entity.moving
    }))
    .filter(
      ({ distance, hotEta, stationary }) =>
        distance <= 6.6 &&
        (distance <= 5.8 || hotEta <= 176 || (stationary && distance <= 5.2))
    )
    .sort(
      (left, right) =>
        Number(right.distance <= 4.8) - Number(left.distance <= 4.8) ||
        left.distance - right.distance ||
        left.hotEta - right.hotEta ||
        Number(right.stationary && right.distance <= 5.5) - Number(left.stationary && left.distance <= 5.5) ||
        right.toward - left.toward ||
        left.entity.id - right.entity.id
    )[0] ?? null;
  if (
    frontlineTarget &&
    (
      !forcedFocus ||
      forcedDistance > frontlineTarget.distance + 0.6 ||
      forcedHotEta > frontlineTarget.hotEta + 22
    )
  ) {
    const frontScore = scoreMovementTarget(
      snapshot,
      self,
      frontlineTarget.entity,
      mode,
      anchorTargetId,
      heldTargetId,
      localThreatCount
    );
    return {
      entity: frontlineTarget.entity,
      score: frontScore,
      reason: buildTargetReason("LOCK", frontlineTarget.entity, frontScore, isCornerLike(frontlineTarget.entity, scene), localThreatCount, mode),
      lockedUntil: nowWall + Math.max(150, holdDuration(mode, localThreatCount, snapshot.adaptiveTuning))
    };
  }
  const localAggressor = enemies
    .map((entity) => ({
      entity,
      distance: ringTargetDistance(self, entity),
      toward: movementTowardSelf(self, entity),
      hotEta: predictWindowForEntities(self, entity, snapshot.nowTs)?.bestAt ?? 999
    }))
    .filter(
      ({ entity, distance, toward, hotEta }) =>
        distance <= 5.35 &&
        (
          toward >= 0.08 ||
          hotEta <= 132 ||
          distance <= 4.45 ||
          entity.id === heldTargetId ||
          entity.id === anchorTargetId
        )
    )
    .sort(
      (left, right) =>
        Number(right.distance <= 4.15) - Number(left.distance <= 4.15) ||
        left.hotEta - right.hotEta ||
        left.distance - right.distance ||
        right.toward - left.toward ||
        left.entity.id - right.entity.id
    )[0] ?? null;
  if (
    localAggressor &&
    (
      !forcedFocus ||
      forcedDistance > 5.15 ||
      localAggressor.distance + 0.6 < forcedDistance ||
      localAggressor.hotEta + 18 < forcedHotEta
    )
  ) {
    const localScore = scoreMovementTarget(
      snapshot,
      self,
      localAggressor.entity,
      mode,
      anchorTargetId,
      heldTargetId,
      localThreatCount
    );
    return {
      entity: localAggressor.entity,
      score: localScore,
      reason: buildTargetReason("LOCK", localAggressor.entity, localScore, isCornerLike(localAggressor.entity, scene), localThreatCount, mode),
      lockedUntil: nowWall + Math.max(120, holdDuration(mode, localThreatCount, snapshot.adaptiveTuning))
    };
  }
  if (
    forcedFocus &&
    (
      (localThreatCount > 0 && forcedDistance <= 6.2) ||
      (localThreatCount === 0 &&
        (
          forcedDistance <= 5.3 ||
          ((mode === "PUNISH" || mode === "COMMIT" || mode === "INTERCEPT" || mode === "EVADE") && forcedDistance <= 6.6) ||
          ((snapshot.brain?.campScore ?? 0) >= 2.8 && forcedDistance <= 7.2)
        ))
    )
  ) {
    const forcedScore = scoreMovementTarget(
      snapshot,
      self,
      forcedFocus,
      mode,
      anchorTargetId,
      heldTargetId,
      localThreatCount
    );
    return {
      entity: forcedFocus,
      score: forcedScore,
      reason: buildTargetReason("LOCK", forcedFocus, forcedScore, isCornerLike(forcedFocus, scene), localThreatCount, mode),
      lockedUntil: nowWall + Math.max(130, holdDuration(mode, localThreatCount, snapshot.adaptiveTuning))
    };
  }

  const scoredBase = enemies.map((entity) => {
    const score = scoreMovementTarget(snapshot, self, entity, mode, anchorTargetId, heldTargetId, localThreatCount);
    return { entity, score };
  });
  const scored =
    localThreatCount > 0
      ? scoredBase.filter(
          ({ entity }) =>
            ringTargetDistance(self, entity) <= 5.45 ||
            movementTowardSelf(self, entity) >= 0.18 ||
            entity.id === heldTargetId ||
            entity.id === anchorTargetId
        )
      : scoredBase;
  scored.sort((left, right) => right.score - left.score || left.entity.id - right.entity.id);

  const current =
    (heldTargetId >= 0 ? scored.find((candidate) => candidate.entity.id === heldTargetId) : null) ??
    (anchorTargetId >= 0 ? scored.find((candidate) => candidate.entity.id === anchorTargetId) : null) ??
    scored[0];
  const best = scored[0];
  if (!current || !best) {
    return null;
  }

  const brainLockUntil = snapshot.brain?.switchLockedUntil ?? 0;
  const holdActive = nowWall < heldUntil || nowWall < brainLockUntil;
  const currentDistance = ringTargetDistance(self, current.entity);
  const bestDistance = ringTargetDistance(self, best.entity);
  const currentCorner = isCornerLike(current.entity, scene);
  const bestCorner = isCornerLike(best.entity, scene);
  const emergency = localThreatCount >= 2 || (snapshot.brain?.threatCount ?? 0) >= 2 || mode === "EVADE";
  const currentScore = current.score;
  const bestScore = best.score;
  const currentBad =
    currentDistance > 5.6 ||
    (!currentCorner && localThreatCount >= 2 && currentDistance > 4.55) ||
    (snapshot.brain?.mode === "FEINT" && currentDistance > 5.25 && bestDistance + 0.75 < currentDistance);
  const keepCurrentPressure =
    (current.entity.id === anchorTargetId && currentDistance <= 4.55) ||
    (movementTowardSelf(self, current.entity) >= 0.22 && currentDistance <= 4.8);
  const shouldTakeBest =
    best.entity.id !== current.entity.id &&
    (!holdActive || emergency) &&
    !keepCurrentPressure &&
    (bestScore > currentScore + switchThreshold(mode, localThreatCount, snapshot.adaptiveTuning) || (emergency && bestDistance <= 4.75 && bestScore >= currentScore - 0.25) || currentBad);

  if (shouldTakeBest) {
    const lockedUntil = nowWall + holdDuration(mode, localThreatCount, snapshot.adaptiveTuning);
    return {
      entity: best.entity,
      score: bestScore,
      reason: buildTargetReason("SWITCH", best.entity, bestScore, bestCorner, localThreatCount, mode),
      lockedUntil
    };
  }

  const lockedUntil = Math.max(heldUntil, nowWall + Math.max(90, Math.floor(holdDuration(mode, localThreatCount, snapshot.adaptiveTuning) * 0.55)));
  return {
    entity: current.entity,
    score: currentScore,
    reason: buildTargetReason("HOLD", current.entity, currentScore, currentCorner, localThreatCount, mode),
    lockedUntil
  };
}

function scoreMovementTarget(
  snapshot: ServerStateSnapshot,
  self: EntityStatePayload,
  enemy: EntityStatePayload,
  mode: BrainMode,
  anchorTargetId: number,
  heldTargetId: number,
  localThreatCount: number
): number {
  const attackMode =
    mode === "COMMIT" || mode === "INTERCEPT" || mode === "PUNISH" || mode === "TRAP" || mode === "EVADE";
  const distance = ringTargetDistance(self, enemy);
  const ringDistance = ringTargetDistance(self, enemy);
  const towardSelf = movementTowardSelf(self, enemy);
  const standbyRemaining = enemy.standbyRemainingMs ?? 0;
  const standbyRole = enemy.standbyRole ?? "NONE";
  const standby = standbyRemaining > 0;
  const cluster = clusterAround(enemy, snapshot.entities, self.id);
  const cornerLike = isCornerLike(enemy, snapshot.scene);
  const anchorBonus =
    enemy.id === anchorTargetId
      ? localThreatCount > 0 || attackMode
        ? 5.8
        : 1.9
      : 0;
  const heldBonus =
    enemy.id === heldTargetId
      ? localThreatCount > 0 ? 4.6 : 2.9
      : 0;
  const proximityBonus = Math.max(0, 6.1 - distance) * (attackMode ? 2.85 : 1.8);
  const closePressureBonus = Math.max(0, 4.2 - distance) * (attackMode ? 2.55 : 1.52);
  const ringCloseBonus =
    Math.max(0, 5.2 - ringDistance) * (attackMode ? 2.35 : 1.18) +
    (ringDistance <= 3.2 ? (attackMode ? 4.8 : 1.4) : 0);
  const towardBonus = towardSelf > 0 ? towardSelf * (attackMode ? 3.2 : 1.72) : towardSelf * 0.08;
  const movingBonus = enemy.moving ? 0.24 : -0.08;
  const cornerBonus =
    cornerLike && (mode === "LURE" || mode === "STALK" || mode === "FEINT")
      ? 1.35
      : cornerLike
        ? 0.66
        : 0;
  const clusterPenalty = cluster * (attackMode ? 0.28 : 0.46);
  const farPenalty =
    Math.max(0, distance - 4.25) * (attackMode ? 3.1 : 2.45) +
    Math.max(0, ringDistance - 3.2) * (attackMode ? 3.8 : 1.9) +
    (localThreatCount > 0 && (distance > 4.4 || ringDistance > 3.6) ? 9.6 : 0);
  const localBonus =
    localThreatCount >= 2 && distance <= 4.4 ? 1.9 :
    localThreatCount >= 1 && distance <= 4.05 ? 1.05 :
    0;
  const runnerPenalty =
    enemy.moving && towardSelf < -0.1 && distance > 2.7
      ? Math.max(0, -towardSelf - 0.1) * (localThreatCount > 0 ? 8.2 : 4.4) + Math.max(0, distance - 2.7) * 0.9
      : 0;
  const attackerBonus =
    towardSelf >= 0.5 && distance <= 5 ? 6.9 :
    towardSelf >= 0.25 && distance <= 4.4 ? 4.9 :
    0;
  const campCommitBonus =
    enemy.id === anchorTargetId && (snapshot.brain?.campScore ?? 0) >= 3.4
      ? (mode === "COMMIT" || mode === "INTERCEPT" || mode === "PUNISH"
          ? (snapshot.brain?.campScore ?? 0) * 0.42
          : (snapshot.brain?.campScore ?? 0) * 0.18)
      : 0;
  const punishModeBonus =
    mode === "PUNISH"
      ? Math.max(0, 7.1 - distance) * 1.25 + (!enemy.moving ? 3.4 : 0) + (cornerLike ? 1.4 : 0)
      : 0;
  const stationaryCommitBonus =
    !enemy.moving && ringDistance <= 4.8 && (attackMode || mode === "LURE" || mode === "CONTROL")
      ? (mode === "PUNISH" || mode === "COMMIT" ? 7.2 : 3.4)
      : 0;
  const stationarySpacingPenalty =
    !enemy.moving
      ? Math.max(0, 2.15 - ringDistance) * (mode === "PUNISH" || mode === "COMMIT" ? 1.8 : 4.2) +
        Math.max(0, 2.55 - distance) * (mode === "PUNISH" || mode === "COMMIT" ? 0.8 : 1.9)
      : 0;
  const standbyBonus =
    standby
      ? standbyRole === "DEFENDER"
        ? 9.6 + Math.max(0, 6 - distance) * 1.15
        : 6.1 + Math.max(0, 5.5 - distance) * 0.82
      : 0;
  const exposedPunishBonus = computePunishBonus(distance, towardSelf, cluster, cornerLike, enemy.moving, mode);
  const modeBias =
    mode === "EVADE"
      ? (distance <= 5.8 ? 1.8 : -Math.max(0, distance - 5.8) * 0.12)
      : mode === "TRAP"
        ? (distance <= 6.2 ? 2.3 : -Math.max(0, distance - 6.2) * 0.18)
        : mode === "CONTROL"
          ? (distance <= 6.5 ? 1.4 : -Math.max(0, distance - 6.5) * 0.12)
      : attackMode
        ? (distance <= 5.2 ? 2.6 : -Math.max(0, distance - 5.2) * 0.32)
        : 0;

  return (
    anchorBonus +
    heldBonus +
    proximityBonus +
    closePressureBonus +
    ringCloseBonus +
    towardBonus +
    movingBonus +
    cornerBonus +
    localBonus +
    attackerBonus +
    campCommitBonus +
    punishModeBonus +
    stationaryCommitBonus +
    standbyBonus +
    exposedPunishBonus +
    modeBias -
    clusterPenalty -
    runnerPenalty -
    stationarySpacingPenalty -
    farPenalty
  );
}

function buildTargetReason(
  action: "HOLD" | "SWITCH" | "LOCK",
  entity: EntityStatePayload,
  score: number,
  cornerLike: boolean,
  localThreatCount: number,
  mode: BrainMode
): string {
  const cornerText = cornerLike ? "C" : "N";
  return `${action}_${mode}_E${entity.id}_S${score.toFixed(2)}_${cornerText}_L${localThreatCount}`;
}

function switchThreshold(mode: BrainMode, localThreatCount: number, tuning: AdaptiveTuning | null): number {
  const base =
    mode === "EVADE"
      ? 0.32
      : mode === "COMMIT" || mode === "INTERCEPT" || mode === "PUNISH" || mode === "TRAP"
        ? 0.45
        : mode === "CONTROL"
          ? 0.52
          : 0.72;
  return base + Math.max(0, localThreatCount - 1) * 0.12 + clampAdaptive((tuning?.switchBias ?? 0) * 0.28, -0.18, 0.18);
}

function holdDuration(mode: BrainMode, localThreatCount: number, tuning: AdaptiveTuning | null): number {
  const base =
    mode === "EVADE"
      ? 60
      : mode === "COMMIT" || mode === "INTERCEPT" || mode === "PUNISH" || mode === "TRAP"
        ? 64
        : mode === "CONTROL"
          ? 70
        : mode === "LURE" || mode === "STALK"
          ? 74
          : 70;
  return Math.round((base + Math.max(0, localThreatCount - 1) * 14) * clampAdaptive(tuning?.targetHoldScale ?? 1, 0.7, 1.6));
}

function isCornerLike(entity: EntityStatePayload, scene: ServerStateSnapshot["scene"]): boolean {
  if (!scene) {
    return false;
  }
  const tile = resolveEntityTile(entity, scene);
  if (!tile) {
    return false;
  }
  let degree = 0;
  for (const next of neighborsOf(tile)) {
    if (!inBounds(next, scene)) {
      continue;
    }
    if (isWalkableTile((scene.walkableMatrix ?? scene.matrix)[next.y]?.[next.x] ?? 1)) {
      degree += 1;
    }
  }
  return degree <= 2;
}

function neighborsOf(tile: TilePoint): TilePoint[] {
  return [
    { x: tile.x + 1, y: tile.y },
    { x: tile.x - 1, y: tile.y },
    { x: tile.x, y: tile.y + 1 },
    { x: tile.x, y: tile.y - 1 }
  ];
}

function inBounds(tile: TilePoint, scene: ServerStateSnapshot["scene"]): boolean {
  if (!scene) {
    return false;
  }
  return tile.x >= 0 && tile.y >= 0 && tile.x < scene.width && tile.y < scene.height;
}

function isWalkableTile(tile: number): boolean {
  return tile === 0 || tile === 2;
}

function clusterAround(entity: EntityStatePayload, entities: EntityStatePayload[], selfId: number): number {
  const origin = { x: entity.x, y: entity.y };
  return entities.reduce((count, other) => {
    if (other.id === entity.id || other.id === selfId || other.isSelf) {
      return count;
    }
    return chebyshev(origin, other) <= 2 ? count + 1 : count;
  }, 0);
}

function isLocalRingThreat(self: EntityStatePayload, enemy: EntityStatePayload): boolean {
  return ringTargetDistance(self, enemy) <= 4.6 || chebyshev(self, enemy) <= 2.6;
}

function movementTowardSelf(self: EntityStatePayload, enemy: EntityStatePayload): number {
  const dx = self.x - enemy.x;
  const dy = self.y - enemy.y;
  const moveX = enemy.dirX !== 0 ? enemy.dirX : Math.sign(enemy.toX - enemy.fromX);
  const moveY = enemy.dirY !== 0 ? enemy.dirY : Math.sign(enemy.toY - enemy.fromY);
  const magnitude = Math.hypot(dx, dy);
  if (magnitude < 0.001) {
    return 0;
  }
  return (moveX * dx + moveY * dy) / magnitude;
}

function movementTowardTile(selfTile: TilePoint, enemy: EntityStatePayload): number {
  const dx = selfTile.x - enemy.x;
  const dy = selfTile.y - enemy.y;
  const moveX = enemy.dirX !== 0 ? enemy.dirX : Math.sign(enemy.toX - enemy.fromX);
  const moveY = enemy.dirY !== 0 ? enemy.dirY : Math.sign(enemy.toY - enemy.fromY);
  const magnitude = Math.hypot(dx, dy);
  if (magnitude < 0.001) {
    return 0;
  }
  return (moveX * dx + moveY * dy) / magnitude;
}

function chebyshev(left: { x: number; y: number }, right: { x: number; y: number }): number {
  return Math.max(Math.abs(left.x - right.x), Math.abs(left.y - right.y));
}

function searchPlans(
  snapshot: ServerStateSnapshot,
  control: ControlMap,
  boardState: ReturnType<typeof buildTacticalBoard>,
  target: EntityStatePayload,
  mode: BrainMode,
  occupied: Set<string>,
  recentPrimaryKeys: string[],
  highPower: boolean
): PlanCandidate[] {
  const budget = budgetByMode(mode, highPower);
  const firstPool = [...control.tiles.values()]
    .filter((tile) => tile.selfSteps >= 1 && tile.selfSteps <= budget.firstMax)
    .filter((tile) => !occupied.has(keyOf(tile.tile.x, tile.tile.y)))
    .sort((left, right) => baseFirstScore(mode, left) - baseFirstScore(mode, right));
  const limitedFirstPool = firstPool.filter(
    (tile) => !wouldExceedRepeatLimit(keyOf(tile.tile.x, tile.tile.y), recentPrimaryKeys)
  );
  const firstCandidates = (limitedFirstPool.length > 0 ? limitedFirstPool : firstPool).slice(0, budget.beamWidth);

  const plans: PlanCandidate[] = [];
  const distanceCache = new Map<string, Map<string, number>>();

  for (const first of firstCandidates) {
    const firstDistances = ensureDistances(distanceCache, control, first.tile);
    const secondCandidates = [...control.tiles.values()]
      .map((tile) => ({ tile, hopSteps: firstDistances.get(keyOf(tile.tile.x, tile.tile.y)) }))
      .filter(
        (item) =>
          item.hopSteps != null &&
          item.hopSteps <= budget.secondMax &&
          (!occupied.has(keyOf(item.tile.tile.x, item.tile.tile.y)) || sameTile(item.tile.tile, first.tile))
      )
      .sort((left, right) => secondPreScore(mode, first, left.tile) - secondPreScore(mode, first, right.tile))
      .slice(0, Math.max(highPower ? 24 : 8, Math.ceil(budget.beamWidth * (highPower ? 0.96 : 0.65))));

    for (const secondItem of secondCandidates) {
      const second = secondItem.tile;
      const secondDistances = ensureDistances(distanceCache, control, second.tile);
      let bestThird: PlanCandidate | null = null;
      for (const third of control.tiles.values()) {
        const thirdKey = keyOf(third.tile.x, third.tile.y);
        const hopSteps = secondDistances.get(thirdKey);
        if (hopSteps == null || hopSteps > budget.thirdMax) {
          continue;
        }
        if (occupied.has(thirdKey) && !sameTile(third.tile, second.tile)) {
          continue;
        }
        const score = planScore(
          snapshot,
          control,
          boardState,
          target,
          mode,
          first,
          second,
          third,
          secondItem.hopSteps ?? 0,
          hopSteps,
          recentPrimaryKeys
        );
        const plan: PlanCandidate = { first, second, third, score };
        if (!bestThird || plan.score > bestThird.score) {
          bestThird = plan;
        }
      }
      if (bestThird) {
        plans.push(bestThird);
      }
    }
  }

  plans.sort((left, right) =>
    right.score - left.score ||
    left.first.selfSteps - right.first.selfSteps ||
    left.second.selfSteps - right.second.selfSteps
  );
  return plans.slice(0, Math.max(1, budget.beamWidth));
}

function ensureDistances(
  cache: Map<string, Map<string, number>>,
  control: ControlMap,
  tile: TilePoint
): Map<string, number> {
  const key = keyOf(tile.x, tile.y);
  let distances = cache.get(key);
  if (!distances) {
    distances = buildDistanceMap(control.scene, tile);
    cache.set(key, distances);
  }
  return distances;
}

function planScore(
  snapshot: ServerStateSnapshot,
  control: ControlMap,
  boardState: ReturnType<typeof buildTacticalBoard>,
  target: EntityStatePayload,
  mode: BrainMode,
  first: ControlTile,
  second: ControlTile,
  third: ControlTile,
  hopFirst: number,
  hopSecond: number,
  recentPrimaryKeys: string[]
): number {
  const firstPenalty = first.selfSteps * 0.52;
  const secondPenalty = hopFirst * 0.32;
  const thirdPenalty = hopSecond * 0.28;
  const repetitionPenalty =
    (sameTile(first.tile, second.tile) ? 0.8 : 0) +
    (sameTile(second.tile, third.tile) ? 0.7 : 0);
  const recentPenalty = recentLoopPenalty(first, second, third, recentPrimaryKeys);
  const approachGain =
    Math.max(0, first.targetDistNow - third.targetDistLong) +
    Math.max(0, first.targetPathNow - third.targetPathLong) * 0.95;
  const nonProgressPenalty =
    Math.max(0, third.targetDistLong - first.targetDistNow) * 0.95 +
    Math.max(0, third.targetPathLong - first.targetPathNow) * 1.65;
  const directContactBonus =
    third.targetDistLong <= 1 ? 1.8 :
    third.targetDistLong <= 2 ? 0.8 :
    -Math.max(0, third.targetDistLong - 2) * 0.35;
  const directPressure = directPressureBias(first, second, third);
  const orbitPenalty = orbitPlanPenalty(first, second, third);
  const camperCommit = camperCommitBonus(control, first, second, third);
  const endDistancePressure =
    Math.max(0, 4 - third.targetDistLong) * 2.2 +
    Math.max(0, 5 - third.targetPathLong) * 0.95;
  const endDistancePenalty = Math.max(0, third.targetDistLong - 2) * 4.1;
  const secondDistancePenalty =
    Math.max(0, second.targetDistShort - 2) * 1.7 +
    Math.max(0, second.targetPathShort - 4.2) * 1.15;
  const firstDistancePenalty =
    Math.max(0, first.targetDistNow - 3) * 1.1 +
    Math.max(0, first.targetPathNow - 5.1) * 0.75;
  const closeTrackBonus =
    Math.max(0, 5 - first.targetDistNow) * 0.55 +
    Math.max(0, 5 - second.targetDistShort) * 0.8 +
    Math.max(0, 5 - third.targetDistLong) * 1.4 +
    Math.max(0, 6 - first.targetPathNow) * 0.42 +
    Math.max(0, 5 - second.targetPathShort) * 0.62 +
    Math.max(0, 4 - third.targetPathLong) * 1.15;
  const retreatPenalty =
    Math.max(0, second.targetDistShort - first.targetDistNow) * 2.8 +
    Math.max(0, third.targetDistLong - second.targetDistShort) * 3.2 +
    Math.max(0, third.targetDistLong - first.targetDistNow) * 3.8 +
    Math.max(0, second.targetPathShort - first.targetPathNow) * 1.95 +
    Math.max(0, third.targetPathLong - second.targetPathShort) * 2.35 +
    Math.max(0, third.targetPathLong - first.targetPathNow) * 2.7;
  const widePatternPenalty =
    (first.targetDistNow > 4 ? 1.2 : 0) +
    (second.targetDistShort > 3.5 ? 1.4 : 0) +
    (third.targetDistLong > 2.5 ? 1.8 : 0) +
    (third.targetPathLong > 5.2 ? 1.4 : 0);
  const chasePenalty = kiteChasePenalty(control, boardState, target, mode, first, second, third);
  const shadowPenalty = isShadowFollowPattern(control, target, { first, second, third, score: 0 }) ? 9.5 : 0;
  const spacingPenalty = spacingHoldPenalty(target, mode, first, second, third);
  const baitRhythm = baitRhythmBonus(target, mode, first, second, third);

  switch (mode) {
    case "CONTROL":
      return (
        first.interceptScore * 0.88 +
        second.interceptScore * 1.04 +
        third.interceptScore * 1.34 +
        third.safeLaneScore * 0.92 +
        third.trapScore * 0.44 +
        directPressure * 0.84 +
        control.targetCampFactor * 0.34 +
        approachGain * 0.9 +
        directContactBonus * 0.55 +
        endDistancePressure * 0.94 +
        closeTrackBonus * 0.88 -
        firstPenalty * 0.82 -
        secondPenalty * 0.92 -
        thirdPenalty -
        firstDistancePenalty * 0.68 -
        secondDistancePenalty * 0.82 -
        endDistancePenalty * 1.1 -
        retreatPenalty * 0.9 -
        chasePenalty * 0.88 -
        shadowPenalty * 0.8 -
        widePatternPenalty * 0.88 -
        nonProgressPenalty * 0.9 -
        repetitionPenalty * 0.9 -
        recentPenalty * 1.08 -
        orbitPenalty * 0.76
      );
    case "TRAP":
      return (
        first.trapScore * 0.72 +
        second.trapScore * 1.04 +
        third.trapScore * 1.48 +
        third.commitScore * 1.02 +
        third.punishScore * 0.28 +
        directPressure * 1.08 +
        camperCommit +
        control.targetCampFactor * 0.82 +
        approachGain * 1.08 +
        directContactBonus * 0.92 +
        endDistancePressure * 1.08 +
        closeTrackBonus * 0.96 -
        firstPenalty * 0.84 -
        secondPenalty * 0.95 -
        thirdPenalty -
        firstDistancePenalty * 0.82 -
        secondDistancePenalty * 1.05 -
        endDistancePenalty * 1.28 -
        retreatPenalty * 1.02 -
        chasePenalty * 0.66 -
        shadowPenalty * 0.68 -
        widePatternPenalty -
        nonProgressPenalty -
        repetitionPenalty * 1.08 -
        recentPenalty * 1.18 -
        orbitPenalty * 0.92
      );
    case "PUNISH":
      return (
        first.punishScore * 0.8 +
        second.punishScore * 1.12 +
        third.punishScore * 1.58 +
        third.commitScore * 0.92 +
        third.vulnerabilityLong * 0.62 +
        directPressure * 1.22 +
        camperCommit * 1.08 +
        control.targetPunishFactor * 0.94 +
        approachGain * 1.34 +
        directContactBonus * 1.18 +
        endDistancePressure * 1.28 +
        closeTrackBonus * 1.04 +
        third.safeLaneScore * 0.12 -
        firstPenalty * 0.88 -
        secondPenalty * 0.96 -
        thirdPenalty -
        firstDistancePenalty * 0.8 -
        secondDistancePenalty * 1.05 -
        endDistancePenalty * 1.22 -
        retreatPenalty * 1.26 -
        chasePenalty * 0.84 -
        shadowPenalty * 0.72 -
        widePatternPenalty * 0.9 -
        nonProgressPenalty * 0.9 -
        repetitionPenalty * 1.18 -
        recentPenalty * 1.25 -
        orbitPenalty * 1.52
      );
    case "COMMIT":
      return (
        first.commitScore * 0.72 +
        second.commitScore * 1.08 +
        third.commitScore * 1.72 +
        third.punishScore * 0.34 +
        third.trapScore * 0.72 +
        directPressure * 1.42 +
        camperCommit * 1.04 +
        control.targetCampFactor * 0.9 +
        approachGain * 1.56 +
        directContactBonus * 1.32 +
        endDistancePressure * 1.52 +
        closeTrackBonus * 1.26 -
        firstPenalty * 0.92 -
        secondPenalty -
        thirdPenalty -
        firstDistancePenalty -
        secondDistancePenalty * 1.2 -
        endDistancePenalty * 1.58 -
        retreatPenalty * 1.42 -
        chasePenalty * 1.08 -
        shadowPenalty -
        widePatternPenalty * 1.1 -
        nonProgressPenalty * 1.12 -
        repetitionPenalty * 1.26 -
        recentPenalty * 1.34 -
        orbitPenalty * 1.46
      );
    case "INTERCEPT":
      return (
        first.interceptScore * 0.92 +
        second.commitScore * 0.68 +
        second.interceptScore * 1.02 +
        third.commitScore * 1.06 +
        third.trapScore * 0.94 +
        directPressure * 0.98 +
        camperCommit * 0.52 +
        control.targetCampFactor * 0.56 +
        approachGain * 0.98 +
        directContactBonus * 0.82 +
        endDistancePressure * 1.1 +
        baitRhythm * 0.55 +
        closeTrackBonus * 0.92 -
        firstPenalty * 0.84 -
        secondPenalty * 0.96 -
        thirdPenalty -
        firstDistancePenalty * 0.72 -
        secondDistancePenalty -
        spacingPenalty * 1.12 -
        endDistancePenalty * 1.18 -
        retreatPenalty * 1.1 -
        chasePenalty * 0.42 -
        shadowPenalty * 0.62 -
        widePatternPenalty -
        nonProgressPenalty -
        repetitionPenalty * 1.02 -
        recentPenalty * 1.18 -
        orbitPenalty
      );
    case "STALK":
      return (
        first.baitScore * 0.76 +
        second.baitScore * 0.92 +
        third.interceptScore * 0.4 +
        directPressure * 0.28 +
        control.targetCampFactor * 0.5 +
        baitRhythm * 1.05 +
        ringBandBias(first, second, third) * 0.94 -
        firstPenalty * 0.76 -
        secondPenalty * 0.84 -
        thirdPenalty -
        spacingPenalty * 1.28 -
        recentPenalty -
        orbitPenalty * 0.82
      );
    case "LURE":
      return (
        first.baitScore * 0.88 +
        second.baitScore * 0.98 +
        third.commitScore * 0.66 +
        third.trapScore * 0.48 +
        directPressure * 0.84 +
        camperCommit * 1.08 +
        control.targetCampFactor * 0.72 +
        approachGain * 0.84 +
        third.safeLaneScore * 0.18 +
        baitRhythm * 0.92 +
        lureSwing(first, second, third) * 0.72 -
        firstPenalty * 0.7 -
        secondPenalty * 0.78 -
        thirdPenalty -
        repetitionPenalty * 0.45 -
        recentPenalty * 0.92 -
        spacingPenalty * 1.34 -
        chasePenalty * 0.38 -
        shadowPenalty * 0.55 -
        orbitPenalty * 1.18
      );
    case "FEINT":
      return (
        first.interceptScore * 0.8 +
        second.trapScore * 0.95 +
        third.safeLaneScore * 0.9 +
        directPressure * 0.45 +
        control.targetCampFactor * 0.12 +
        baitRhythm * 0.88 +
        feintBreak(second, third) * 1.45 -
        firstPenalty * 0.74 -
        secondPenalty * 0.8 -
        thirdPenalty * 0.92 -
        spacingPenalty * 1.18 -
        recentPenalty * 0.45
      );
    case "EVADE":
      return (
        first.safeLaneScore * 0.9 +
        second.safeLaneScore * 1.15 +
        third.safeLaneScore * 1.65 -
        (first.pincerRisk * 0.8 + second.pincerRisk + third.pincerRisk * 1.25) -
        (first.deadEndPenalty * 0.6 + second.deadEndPenalty * 0.9 + third.deadEndPenalty * 1.2) -
        firstPenalty * 0.52 -
        secondPenalty * 0.65 -
        thirdPenalty * 0.76 -
        recentPenalty * 0.6
      );
    case "SEEK":
      return (
        first.baitRingScore * 0.45 +
        second.interceptScore * 0.7 +
        third.commitScore * 0.42 +
        third.trapScore * 0.7 +
        control.targetCampFactor * 0.08 +
        approachGain * 0.38 +
        third.safeLaneScore * 0.25 +
        seekBias(first, second, third, snapshot.brain?.pressure ?? 0) -
        firstPenalty * 0.75 -
        secondPenalty * 0.82 -
        thirdPenalty * 0.88 -
        recentPenalty * 0.75
      );
    case "RESET":
      return (
        first.safeLaneScore * 0.7 +
        second.safeLaneScore * 0.95 +
        third.safeLaneScore * 1.2 -
        firstPenalty -
        secondPenalty -
        thirdPenalty -
        repetitionPenalty -
        recentPenalty
      );
    default:
      return -999;
  }
}

function baseFirstScore(mode: BrainMode, tile: ControlTile): number {
  switch (mode) {
    case "CONTROL":
      return -(tile.interceptScore * 1.02 + tile.safeLaneScore * 0.42 + tile.trapScore * 0.24 - tile.selfSteps * 0.6);
    case "TRAP":
      return -(tile.trapScore * 1.18 + tile.commitScore * 0.64 + tile.interceptScore * 0.16 - tile.selfSteps * 0.6);
    case "PUNISH":
      return -(tile.punishScore * 1.4 + tile.commitScore * 0.62 + tile.trapScore * 0.32 - tile.selfSteps * 0.68);
    case "COMMIT":
      return -(tile.commitScore * 1.34 + tile.trapScore * 0.52 + tile.interceptScore * 0.18 - tile.selfSteps * 0.66);
    case "INTERCEPT":
      return -(tile.interceptScore * 1.14 + tile.commitScore * 0.42 + tile.safeLaneScore * 0.08 - tile.selfSteps * 0.58);
    case "STALK":
      return -(tile.baitScore * 1.1 + tile.safeLaneScore * 0.16 - tile.selfSteps * 0.48);
    case "LURE":
      return -(tile.baitScore * 1.18 + tile.commitScore * 0.12 + tile.safeLaneScore * 0.1 - tile.selfSteps * 0.5);
    case "FEINT":
      return -(tile.interceptScore * 0.95 + tile.baitRingScore * 0.4 - tile.selfSteps * 0.5);
    case "EVADE":
      return -(tile.safeLaneScore * 1.45 - tile.selfSteps * 0.34);
    case "SEEK":
      return -(tile.baitRingScore * 0.5 + tile.interceptScore * 0.58 + tile.safeLaneScore * 0.2 - tile.selfSteps * 0.45);
    case "RESET":
      return -(tile.safeLaneScore * 1.1 - tile.selfSteps * 0.4);
    default:
      return 999;
  }
}

function secondPreScore(mode: BrainMode, first: ControlTile, second: ControlTile): number {
  switch (mode) {
    case "CONTROL":
      return -(second.interceptScore * 0.96 + second.safeLaneScore * 0.18 + second.trapScore * 0.2);
    case "TRAP":
      return -(second.trapScore * 1.02 + second.commitScore * 0.54 + second.interceptScore * 0.1 - first.selfSteps * 0.12);
    case "PUNISH":
      return -(second.punishScore * 1.2 + second.commitScore * 0.58 + second.trapScore * 0.28);
    case "COMMIT":
      return -(second.commitScore * 1.18 + second.trapScore * 0.46 + second.interceptScore * 0.12 - first.selfSteps * 0.16);
    case "INTERCEPT":
      return -(second.interceptScore * 0.98 + second.commitScore * 0.34 + second.safeLaneScore * 0.08);
    case "STALK":
    case "LURE":
      return -(second.baitScore * 1.02 + second.safeLaneScore * 0.16);
    case "FEINT":
      return -(second.trapScore * 0.8 + second.safeLaneScore * 0.32);
    case "EVADE":
      return -(second.safeLaneScore * 1.15 - second.pincerRisk * 0.28);
    default:
      return -(second.interceptScore * 0.4 + second.safeLaneScore * 0.3);
  }
}

function buildReason(
  snapshot: ServerStateSnapshot,
  mode: BrainMode,
  best: PlanCandidate,
  backup: TilePoint | null,
  targetReason: string,
  primaryTile: TilePoint
): string {
  const base =
    snapshot.brain?.reason ??
    (snapshot.window ? `FOLLOW_${snapshot.window.kind}` : "FOLLOW");
  const secondText = `S${best.second.tile.x},${best.second.tile.y}`;
  const thirdText = `T${best.third.tile.x},${best.third.tile.y}`;
  const backupText = backup ? ` B${backup.x},${backup.y}` : "";
  const pushText = !sameTile(primaryTile, best.first.tile) ? `_X${primaryTile.x},${primaryTile.y}` : "";
  return `${mode}_${base}_${targetReason}_P${best.first.tile.x},${best.first.tile.y}_${secondText}_${thirdText}${pushText}${backupText}`;
}

function resolveMode(snapshot: ServerStateSnapshot): BrainMode {
  if (snapshot.brain) {
    if (snapshot.brain.mode === "RESET") {
      return snapshot.targetId >= 0 ? "CONTROL" : "RESET";
    }
    if (snapshot.brain.mode === "SEEK") {
      return snapshot.targetId >= 0 ? "INTERCEPT" : "SEEK";
    }
    return snapshot.brain.mode;
  }
  if (snapshot.window) {
    return snapshot.window.kind === "HOT" || snapshot.window.kind === "DIAG" ? "COMMIT" : "INTERCEPT";
  }
  return "SEEK";
}

function spacingHoldPenalty(
  target: EntityStatePayload,
  mode: BrainMode,
  first: ControlTile,
  second: ControlTile,
  third: ControlTile
): number {
  const passiveMode =
    mode === "CONTROL" || mode === "STALK" || mode === "LURE" || mode === "FEINT" || mode === "INTERCEPT";
  if (!passiveMode) {
    return 0;
  }
  if (!target.moving) {
    return (
      Math.max(0, 3.05 - third.targetDistLong) * 3.2 +
      Math.max(0, 2.85 - second.targetDistShort) * 1.8 +
      Math.max(0, 2.55 - third.targetLateralLong) * 1.45
    );
  }
  return (
    Math.max(0, 2.75 - third.targetDistLong) * 5.4 +
    Math.max(0, 4.15 - third.targetPathLong) * 2.45 +
    Math.max(0, 2.75 - third.targetLateralLong) * 4.1 +
    Math.max(0, 2.95 - second.targetLateralLong) * 1.7 +
    (third.targetLateralLong < 2.75 && third.interceptScore < 4.15 && third.trapScore < 3.95 ? 3.4 : 0) +
    (second.targetPathShort < 4.05 && third.targetPathLong < 3.75 ? 1.9 : 0)
  );
}

function baitRhythmBonus(
  target: EntityStatePayload,
  mode: BrainMode,
  first: ControlTile,
  second: ControlTile,
  third: ControlTile
): number {
  const passiveMode =
    mode === "CONTROL" || mode === "STALK" || mode === "LURE" || mode === "FEINT" || mode === "INTERCEPT";
  if (!passiveMode) {
    return 0;
  }
  if (!target.moving) {
    return bandScore(third.targetDistLong, 3.0, 4.0, 2.1) + bandScore(second.targetDistShort, 2.8, 3.8, 1.2);
  }
  return (
    bandScore(third.targetDistLong, 2.95, 3.95, 2.65) +
    bandScore(second.targetDistShort, 2.55, 3.45, 1.5) +
    Math.max(0, third.targetLateralLong - 2.7) * 0.46 +
    Math.max(0, third.interceptScore - 3.5) * 0.26
  );
}

function buildOccupiedSet(
  entities: EntityStatePayload[],
  selfId: number,
  scene: ServerStateSnapshot["scene"]
): Set<string> {
  const occupied = new Set<string>();
  if (!scene) {
    return occupied;
  }
  for (const entity of entities) {
    if (entity.id === selfId) {
      continue;
    }
    const tile = resolveEntityTile(entity, scene);
    if (!tile) {
      continue;
    }
    occupied.add(keyOf(tile.x, tile.y));
  }
  return occupied;
}

function budgetByMode(mode: BrainMode, highPower: boolean): SearchBudget {
  const base: SearchBudget = (() => {
    switch (mode) {
      case "CONTROL":
        return { firstMax: 5, secondMax: 5, thirdMax: 4, beamWidth: 104 };
      case "TRAP":
        return { firstMax: 5, secondMax: 5, thirdMax: 4, beamWidth: 112 };
      case "PUNISH":
        return { firstMax: 5, secondMax: 5, thirdMax: 4, beamWidth: 128 };
      case "COMMIT":
        return { firstMax: 5, secondMax: 5, thirdMax: 4, beamWidth: 120 };
      case "INTERCEPT":
        return { firstMax: 5, secondMax: 4, thirdMax: 4, beamWidth: 104 };
      case "STALK":
        return { firstMax: 3, secondMax: 3, thirdMax: 2, beamWidth: 48 };
      case "LURE":
        return { firstMax: 4, secondMax: 3, thirdMax: 3, beamWidth: 56 };
      case "FEINT":
        return { firstMax: 3, secondMax: 3, thirdMax: 3, beamWidth: 60 };
      case "EVADE":
        return { firstMax: 4, secondMax: 4, thirdMax: 4, beamWidth: 88 };
      case "SEEK":
        return { firstMax: 4, secondMax: 4, thirdMax: 3, beamWidth: 64 };
      case "RESET":
        return { firstMax: 3, secondMax: 3, thirdMax: 2, beamWidth: 40 };
      default:
        return { firstMax: 4, secondMax: 3, thirdMax: 3, beamWidth: 48 };
    }
  })();
  if (!highPower) {
    return base;
  }
  return {
    firstMax: Math.min(7, base.firstMax + 2),
    secondMax: Math.min(7, base.secondMax + 2),
    thirdMax: Math.min(6, base.thirdMax + 2),
    beamWidth: Math.round(base.beamWidth * 2.35)
  };
}

function moveIntervalByMode(mode: BrainMode, moving: boolean): number {
  switch (mode) {
    case "CONTROL":
      return moving ? 11 : 7;
    case "TRAP":
      return moving ? 10 : 6;
    case "PUNISH":
      return moving ? 10 : 6;
    case "COMMIT":
      return moving ? 10 : 6;
    case "INTERCEPT":
      return moving ? 12 : 7;
    case "STALK":
      return moving ? 16 : 10;
    case "LURE":
      return moving ? 16 : 10;
    case "FEINT":
      return moving ? 12 : 7;
    case "EVADE":
      return moving ? 10 : 6;
    case "SEEK":
      return moving ? 14 : 8;
    case "RESET":
      return moving ? 14 : 8;
    default:
      return moving ? 14 : 8;
  }
}

function ringBandBias(first: ControlTile, second: ControlTile, third: ControlTile): number {
  const secondBand = second.targetDistShort >= 2 && second.targetDistShort <= 3 ? 1.2 : -0.4;
  const thirdBand = third.targetDistLong >= 2 && third.targetDistLong <= 3 ? 1.45 : -0.6;
  return secondBand + thirdBand + third.targetLateralLong * 0.25;
}

function lureSwing(first: ControlTile, second: ControlTile, third: ControlTile): number {
  const swing = Math.abs(first.targetDistNow - second.targetDistLong) + Math.abs(second.targetDistLong - third.targetDistLong);
  return swing * 0.42 + third.safeLaneScore * 0.12;
}

function feintBreak(second: ControlTile, third: ControlTile): number {
  return (
    second.trapScore * 0.2 +
    third.safeLaneScore * 0.65 +
    Math.max(0, third.closestEnemyLong - second.closestEnemyNow) * 0.8
  );
}

function seekBias(first: ControlTile, second: ControlTile, third: ControlTile, pressure: number): number {
  return (
    third.trapScore * 0.18 +
    third.safeLaneScore * 0.15 +
    Math.max(0, 2 - pressure) * 0.4 +
    (third.targetDistLong <= first.targetDistNow ? 0.45 : -0.18) +
    (second.interceptScore - first.interceptScore) * 0.14
  );
}

function directPressureBias(first: ControlTile, second: ControlTile, third: ControlTile): number {
  return (
    (first.targetDistShort - second.targetDistShort) * 0.9 +
    (second.targetDistShort - third.targetDistShort) * 1.1 +
    (first.targetDistLong - third.targetDistLong) * 0.95 +
    Math.max(0, 3 - third.targetDistLong) * 0.45
  );
}

function orbitPlanPenalty(first: ControlTile, second: ControlTile, third: ControlTile): number {
  const widening =
    Math.max(0, second.targetDistLong - first.targetDistLong) +
    Math.max(0, third.targetDistLong - second.targetDistLong);
  const noClose = third.targetDistLong >= first.targetDistLong ? 0.8 : 0;
  const lateralDrift = Math.max(0, third.targetLateralLong - 2.1) * 0.25;
  return widening * 0.9 + noClose + lateralDrift;
}

function camperCommitBonus(control: ControlMap, first: ControlTile, second: ControlTile, third: ControlTile): number {
  if (control.targetCampFactor <= 0) {
    return 0;
  }
  const finishClose = Math.max(0, 2.4 - third.targetDistLong) * 1.35;
  const laneKeep = Math.max(0, third.safeLaneScore) * 0.08;
  const pathPressure = directPressureBias(first, second, third) * 0.32;
  return control.targetCampFactor * 0.22 + finishClose + laneKeep + pathPressure;
}

function uniquePlanTiles(tiles: TilePoint[]): TilePoint[] {
  const result: TilePoint[] = [];
  for (const tile of tiles) {
    if (!result.some((current) => sameTile(current, tile))) {
      result.push(tile);
    }
  }
  return result;
}

function recentLoopPenalty(
  first: ControlTile,
  second: ControlTile,
  third: ControlTile,
  recentPrimaryKeys: string[]
): number {
  if (recentPrimaryKeys.length === 0) {
    return 0;
  }
  const firstKey = keyOf(first.tile.x, first.tile.y);
  const secondKey = keyOf(second.tile.x, second.tile.y);
  const thirdKey = keyOf(third.tile.x, third.tile.y);
  const lastKey = recentPrimaryKeys[recentPrimaryKeys.length - 1] ?? "";
  const prevKey = recentPrimaryKeys[recentPrimaryKeys.length - 2] ?? "";
  let penalty = 0;
  if (firstKey === lastKey) {
    penalty += 1.1;
  }
  if (firstKey === prevKey) {
    penalty += 1.5;
  }
  if (secondKey === lastKey) {
    penalty += 0.65;
  }
  if (thirdKey === prevKey) {
    penalty += 0.35;
  }
  for (let i = Math.max(0, recentPrimaryKeys.length - 4); i < recentPrimaryKeys.length; i += 1) {
    const key = recentPrimaryKeys[i];
    if (key === firstKey) {
      penalty += 0.35;
    }
    if (key === secondKey) {
      penalty += 0.15;
    }
  }
  return penalty;
}

function rememberPrimaryKey(history: string[], key: string): void {
  history.push(key);
  while (history.length > 10) {
    history.shift();
  }
}

function selectCommittedPlan(
  snapshot: ServerStateSnapshot,
  plans: PlanCandidate[],
  control: ControlMap,
  boardState: ReturnType<typeof buildTacticalBoard>,
  target: EntityStatePayload,
  mode: BrainMode,
  highPower: boolean
): PlanCandidate {
  if (plans.length <= 1) {
    return plans[0];
  }

  const tuning = snapshot.adaptiveTuning;
  const aggressiveCommit = shouldForceAggressiveCommit(boardState, target, mode);
  const topCount = Math.min(plans.length, highPower ? 72 : 24);
  const ranked = plans.slice(0, topCount).map((plan) => ({
    plan,
    total: plan.score + (aggressiveCommit ? aggressiveCommitBonus(plan, control, boardState, target, mode, tuning) : 0)
  }));

  let pool = ranked;
  if (aggressiveCommit) {
    const closeCap = preferredCloseLeash(boardState, mode, target, tuning);
    const secondCap = closeCap + 0.9;
    const firstCap = closeCap + 1.6;
    const pathCap = preferredPathLeash(boardState, mode, target, tuning);
    const secondPathCap = pathCap + 1.4;
    const firstPathCap = pathCap + 2.1;
    const closeRanked = ranked.filter(
      (entry) =>
        entry.plan.third.targetDistLong <= closeCap &&
        entry.plan.second.targetDistShort <= secondCap &&
        entry.plan.first.targetDistNow <= firstCap &&
        entry.plan.third.targetPathLong <= pathCap &&
        entry.plan.second.targetPathShort <= secondPathCap &&
        entry.plan.first.targetPathNow <= firstPathCap
    );
    pool = closeRanked.length > 0 ? closeRanked : ranked;
  }
  const frontalSafePool = pool.filter(
    (entry) => !shouldRejectFrontalApproach(control, boardState, target, mode, entry.plan)
  );
  const spacingSafePool = (frontalSafePool.length > 0 ? frontalSafePool : pool).filter(
    (entry) => !shouldRejectSpacingApproach(target, mode, entry.plan, tuning)
  );
  const combatShadowSafePool = (spacingSafePool.length > 0 ? spacingSafePool : frontalSafePool.length > 0 ? frontalSafePool : pool).filter(
    (entry) => !shouldRejectCombatShadowApproach(control, boardState, target, mode, entry.plan)
  );
  const crossThreatSafePool = (
    combatShadowSafePool.length > 0
      ? combatShadowSafePool
      : spacingSafePool.length > 0
        ? spacingSafePool
        : frontalSafePool.length > 0
          ? frontalSafePool
          : pool
  ).filter(
    (entry) => !shouldRejectCrossThreatExposure(snapshot, boardState, target, mode, entry.plan)
  );
  const finalPool =
    crossThreatSafePool.length > 0
      ? crossThreatSafePool
      : combatShadowSafePool.length > 0
        ? combatShadowSafePool
        : spacingSafePool.length > 0
          ? spacingSafePool
          : frontalSafePool.length > 0
            ? frontalSafePool
            : pool;

  finalPool.sort(
    (left, right) =>
      right.total - left.total ||
      right.plan.score - left.plan.score ||
      left.plan.first.selfSteps - right.plan.first.selfSteps
  );

  return finalPool[0]?.plan ?? plans[0];
}

function chooseExecutionTiles(
  best: PlanCandidate,
  plans: PlanCandidate[],
  boardState: ReturnType<typeof buildTacticalBoard>,
  target: EntityStatePayload,
  mode: BrainMode
): { primary: TilePoint; backup: TilePoint | null } {
  const primary = best.first.tile;
  const canPush = shouldUsePushEngine(best, boardState, target, mode);
  if (!canPush) {
    const backup =
      plans.find((plan) => !sameTile(plan.first.tile, primary))?.first.tile ??
      (!sameTile(best.second.tile, primary) ? best.second.tile : null);
    return { primary, backup };
  }

  const thirdEligible =
    !sameTile(best.third.tile, best.second.tile) &&
    best.third.targetPathLong <= best.first.targetPathNow - 2 &&
    best.third.targetDistLong <= best.first.targetDistNow - 0.5 &&
    best.third.pincerRisk <= best.second.pincerRisk + 0.55 &&
    best.third.deadEndPenalty <= best.second.deadEndPenalty + 0.3 &&
    (boardState?.isDuel || mode === "COMMIT" || mode === "PUNISH" || mode === "TRAP");
  const secondEligible =
    !sameTile(best.second.tile, primary) &&
    best.second.targetPathShort <= best.first.targetPathNow - 1 &&
    best.second.targetDistShort <= best.first.targetDistNow - 0.3 &&
    best.second.pincerRisk <= best.first.pincerRisk + 0.65;

  if (thirdEligible) {
    const backup =
      !sameTile(best.second.tile, best.third.tile)
        ? best.second.tile
        : !sameTile(best.first.tile, best.third.tile)
          ? best.first.tile
          : null;
    return {
      primary: best.third.tile,
      backup
    };
  }
  if (secondEligible) {
    return {
      primary: best.second.tile,
      backup: primary
    };
  }
  const backup =
    plans.find((plan) => !sameTile(plan.first.tile, primary))?.first.tile ??
    (!sameTile(best.second.tile, primary) ? best.second.tile : null);
  return { primary, backup };
}

function shouldUsePushEngine(
  best: PlanCandidate,
  boardState: ReturnType<typeof buildTacticalBoard>,
  target: EntityStatePayload,
  mode: BrainMode
): boolean {
  if (!boardState) {
    return false;
  }
  if (target.moving) {
    return false;
  }
  if (mode !== "COMMIT" && mode !== "PUNISH" && !boardState.isDuel) {
    return false;
  }
  if (boardState.localThreatCount >= 2) {
    return false;
  }
  if (best.second.targetPathShort >= best.first.targetPathNow && best.third.targetPathLong >= best.second.targetPathShort) {
    return false;
  }
  if (best.second.deadEndPenalty > best.first.deadEndPenalty + 0.75) {
    return false;
  }
  if (best.second.pincerRisk > best.first.pincerRisk + 1) {
    return false;
  }
  if (isStraightChasePattern(boardState, target, best.first, best.second, best.third)) {
    return false;
  }
  if (!target.moving && mode !== "COMMIT" && mode !== "PUNISH") {
    return false;
  }
  if (!target.moving && best.second.targetDistShort <= 3.6) {
    return true;
  }
  if (boardState.isDuel && (mode === "COMMIT" || mode === "PUNISH") && best.second.targetPathShort <= 4.8) {
    return true;
  }
  return best.second.targetPathShort <= best.first.targetPathNow - 1 && best.second.targetDistShort <= best.first.targetDistNow;
}

function shouldRejectFrontalApproach(
  control: ControlMap,
  boardState: ReturnType<typeof buildTacticalBoard>,
  target: EntityStatePayload,
  mode: BrainMode,
  plan: PlanCandidate
): boolean {
  const targetTile = control.targetLongTile ?? control.targetShortTile ?? control.targetTile;
  if (!targetTile) {
    return false;
  }
  const metrics = ringLateralMetrics(targetTile.x - plan.third.tile.x, targetTile.y - plan.third.tile.y);
  const nonCommitMode =
    mode === "CONTROL" || mode === "STALK" || mode === "LURE" || mode === "FEINT" || mode === "INTERCEPT";
  const frontalClose =
    !metrics.validSideLane &&
    plan.third.targetDistLong <= 2.8 &&
    plan.third.interceptScore < 3.45 &&
    plan.third.trapScore < 3.25;
  if (frontalClose) {
    return true;
  }
  if (!target.moving) {
    const tooTightStationary =
      plan.third.targetDistLong <= (mode === "COMMIT" || mode === "PUNISH" ? 1.7 : 2.55) &&
      plan.third.targetLateralLong < (mode === "COMMIT" || mode === "PUNISH" ? 1.5 : 2.1);
    if (tooTightStationary) {
      return true;
    }
  }
  if (nonCommitMode) {
    const noSpacingBand =
      plan.third.targetDistLong <= 3.05 &&
      plan.third.targetLateralLong < 2.45 &&
      plan.third.interceptScore < 3.7 &&
      plan.third.trapScore < 3.55;
    if (noSpacingBand) {
      return true;
    }
  }
  if (target.moving && nonCommitMode) {
    const tailChase =
      plan.second.targetPathShort <= plan.first.targetPathNow - 0.65 &&
      plan.third.targetPathLong <= plan.second.targetPathShort - 0.35 &&
      plan.third.targetDistLong <= Math.max(3.35, plan.first.targetDistNow + 0.1) &&
      plan.third.targetLateralLong < 2.85 &&
      plan.third.interceptScore < 4 &&
      plan.third.trapScore < 3.85 &&
      movementTowardTile(plan.third.tile, target) < 0.14;
    if (tailChase) {
      return true;
    }
  }
  if (boardState?.isDuel && target.moving) {
    const overStraight =
      plan.second.targetPathShort <= plan.first.targetPathNow - 0.8 &&
      plan.third.targetPathLong <= plan.second.targetPathShort - 0.45 &&
      metrics.sideDistance > 2.35 &&
      plan.third.interceptScore < 3.8;
    if (overStraight) {
      return true;
    }
  }
  if (isShadowFollowPattern(control, target, plan)) {
    return true;
  }
  return false;
}

function shouldRejectSpacingApproach(
  target: EntityStatePayload,
  mode: BrainMode,
  plan: PlanCandidate,
  tuning: AdaptiveTuning | null
): boolean {
  const spacingBias = clampAdaptive(tuning?.spacingBias ?? 0, -0.7, 0.9);
  const passiveMode =
    mode === "CONTROL" || mode === "STALK" || mode === "LURE" || mode === "FEINT" || mode === "INTERCEPT";
  if (!passiveMode) {
    return false;
  }
  if (!target.moving) {
    return (
      plan.third.targetDistLong < 2.85 + spacingBias * 0.4 &&
      plan.third.targetLateralLong < 2.55 + spacingBias * 0.28 &&
      plan.third.interceptScore < 3.6 &&
      plan.third.trapScore < 3.7
    );
  }
  return (
    (
      plan.third.targetDistLong < 2.8 + spacingBias * 0.42 &&
      plan.third.targetLateralLong < 2.75 + spacingBias * 0.32 &&
      plan.third.interceptScore < 4.15 &&
      plan.third.trapScore < 4
    ) ||
    (
      plan.third.targetPathLong < 4.15 + spacingBias * 0.65 &&
      plan.third.targetLateralLong < 2.9 + spacingBias * 0.35 &&
      plan.third.interceptScore < 4 &&
      plan.third.trapScore < 3.9
    )
  );
}

function shouldRejectCombatShadowApproach(
  control: ControlMap,
  boardState: ReturnType<typeof buildTacticalBoard>,
  target: EntityStatePayload,
  mode: BrainMode,
  plan: PlanCandidate
): boolean {
  const activeCombat =
    Boolean(boardState) &&
    target.moving &&
    (Boolean(boardState?.targetIsEngaged) || (boardState?.localThreatCount ?? 0) > 0);
  if (!activeCombat) {
    return false;
  }
  const move = resolveEntityMoveVector(target);
  if (!move) {
    return false;
  }
  const passiveMode =
    mode === "CONTROL" || mode === "STALK" || mode === "LURE" || mode === "FEINT" || mode === "INTERCEPT";
  const selfAdvanceX = plan.third.tile.x - control.selfTile.x;
  const selfAdvanceY = plan.third.tile.y - control.selfTile.y;
  const selfAdvanceLen = Math.hypot(selfAdvanceX, selfAdvanceY);
  const moveLen = Math.hypot(move.x, move.y);
  if (selfAdvanceLen < 0.001 || moveLen < 0.001) {
    return false;
  }
  const directionDot = (selfAdvanceX * move.x + selfAdvanceY * move.y) / (selfAdvanceLen * moveLen);
  const sameTrack =
    directionDot >= (passiveMode ? 0.34 : 0.56) &&
    plan.second.targetPathShort <= plan.first.targetPathNow - 0.35 &&
    plan.third.targetPathLong <= plan.second.targetPathShort - 0.15;
  if (!sameTrack) {
    return false;
  }
  const noAngleGain =
    plan.third.targetLateralLong < (passiveMode ? 3.15 : 2.35) &&
    plan.third.interceptScore < (passiveMode ? 4.35 : 3.7) &&
    plan.third.trapScore < (passiveMode ? 4.2 : 3.55);
  if (!noAngleGain) {
    return false;
  }
  const tooCloseToTail =
    plan.third.targetDistLong <= (passiveMode ? 4.15 : 2.7) ||
    plan.third.targetPathLong <= (passiveMode ? 4.9 : 3.45);
  return tooCloseToTail;
}

function shouldRejectCrossThreatExposure(
  snapshot: ServerStateSnapshot,
  boardState: ReturnType<typeof buildTacticalBoard>,
  target: EntityStatePayload,
  mode: BrainMode,
  plan: PlanCandidate
): boolean {
  if (!boardState || boardState.localThreatCount < 2 || mode === "EVADE") {
    return false;
  }
  const self = snapshot.entities.find((entity) => entity.isSelf) ?? null;
  if (!self) {
    return false;
  }
  const challengers = snapshot.entities.filter(
    (entity) =>
      entity.id !== self.id &&
      !entity.isSelf &&
      entity.id !== target.id &&
      !entity.combatState?.busy &&
      !entity.combatState?.react
  );
  if (challengers.length === 0) {
    return false;
  }

  const targetPressure =
    threatPressureAtTile(plan.third.tile, target, true) +
    threatPressureAtTile(plan.second.tile, target, false) * 0.42;
  let strongestChallenger = 0;
  let combinedThreat = 0;
  let closestChallenger = Number.POSITIVE_INFINITY;

  for (const challenger of challengers) {
    const challengerThreat =
      threatPressureAtTile(plan.third.tile, challenger, false) +
      threatPressureAtTile(plan.second.tile, challenger, false) * 0.5;
    if (challengerThreat <= 0.01) {
      continue;
    }
    strongestChallenger = Math.max(strongestChallenger, challengerThreat);
    combinedThreat += challengerThreat;
    closestChallenger = Math.min(closestChallenger, ringTargetDistance(plan.third.tile, challenger));
  }

  if (!Number.isFinite(closestChallenger)) {
    return false;
  }

  const passiveMode =
    mode === "CONTROL" || mode === "STALK" || mode === "LURE" || mode === "FEINT" || mode === "INTERCEPT";
  const strongestThreshold = passiveMode ? 0.78 : 1.02;
  const combinedThreshold = passiveMode ? 1.42 : 1.75;
  if (strongestChallenger >= targetPressure + strongestThreshold && closestChallenger <= 2.65) {
    return true;
  }
  if (combinedThreat >= targetPressure + combinedThreshold && closestChallenger <= 3.15) {
    return true;
  }
  return false;
}

function threatPressureAtTile(
  tile: TilePoint,
  enemy: EntityStatePayload,
  preferTarget: boolean
): number {
  const ringDistance = ringTargetDistance(tile, enemy);
  const chebDistance = chebyshev(tile, enemy);
  const toward = movementTowardTile(tile, enemy);
  const metrics = ringLateralMetrics(enemy.x - tile.x, enemy.y - tile.y);
  let pressure = 0;

  if (metrics.validSideLane && metrics.sideDistance <= 1.22) {
    pressure += preferTarget ? 3.45 : 3.8;
  } else if (metrics.validSideLane && metrics.sideDistance <= 1.48) {
    pressure += preferTarget ? 2.5 : 2.9;
  } else if (ringDistance <= 1.8) {
    pressure += preferTarget ? 1.7 : 2.15;
  } else if (ringDistance <= 2.3) {
    pressure += preferTarget ? 0.92 : 1.25;
  }

  if (toward >= 0.22) {
    pressure += 0.78;
  } else if (toward >= 0.08) {
    pressure += 0.34;
  }

  if (enemy.moving) {
    pressure += 0.24;
  }
  if (chebDistance <= 2) {
    pressure += 0.24;
  }
  return pressure;
}

function shouldForceAggressiveCommit(
  boardState: ReturnType<typeof buildTacticalBoard>,
  target: EntityStatePayload,
  mode: BrainMode
): boolean {
  if (!boardState) {
    return false;
  }
  if (boardState.isDuel) {
    return boardState.targetIsEngaged || boardState.targetHotEta <= 118 || (!target.moving && boardState.targetCanBeCutOff && boardState.targetRingDistance <= 3.6);
  }
  if (mode === "PUNISH") {
    return boardState.targetHotEta <= 110 || boardState.targetIsEngaged || (!target.moving && boardState.targetCanBeCutOff && boardState.targetRingDistance <= 3.7);
  }
  if (mode === "COMMIT") {
    return boardState.targetIsEngaged || boardState.targetHotEta <= 106 || (!target.moving && boardState.targetCanBeCutOff && boardState.targetRingDistance <= 3.3);
  }
  if (mode === "TRAP") {
    return boardState.targetCanBeCutOff && (boardState.targetHotEta <= 122 || boardState.targetRingDistance <= 3.4);
  }
  return false;
}

function aggressiveCommitBonus(
  plan: PlanCandidate,
  control: ControlMap,
  boardState: ReturnType<typeof buildTacticalBoard>,
  target: EntityStatePayload,
  mode: BrainMode,
  tuning: AdaptiveTuning | null
): number {
  const { first, second, third } = plan;
  const closes =
    Math.max(0, first.targetDistNow - second.targetDistShort) * 1.8 +
    Math.max(0, second.targetDistShort - third.targetDistLong) * 2.4 +
    Math.max(0, first.targetDistNow - third.targetDistLong) * 2.8 +
    Math.max(0, first.targetPathNow - second.targetPathShort) * 1.5 +
    Math.max(0, second.targetPathShort - third.targetPathLong) * 1.95 +
    Math.max(0, first.targetPathNow - third.targetPathLong) * 2.25;
  const finishPressure =
    Math.max(0, 5 - first.targetDistNow) * 0.8 +
    Math.max(0, 4 - second.targetDistShort) * 1.1 +
    Math.max(0, 3 - third.targetDistLong) * 2.6 +
    Math.max(0, 6 - first.targetPathNow) * 0.45 +
    Math.max(0, 5 - second.targetPathShort) * 0.75 +
    Math.max(0, 4 - third.targetPathLong) * 1.45;
  const finishContact =
    third.targetDistLong <= 1 ? 6.2 :
    third.targetDistLong <= 2 ? 3.1 :
    -Math.max(0, third.targetDistLong - 2) * 3.6;
  const punish =
    third.commitScore * 0.44 +
    third.punishScore * 0.34 +
    third.trapScore * 0.22 +
    camperCommitBonus(control, first, second, third) * 0.6;
  const chasePenalty =
    Math.max(0, second.targetDistShort - first.targetDistNow) * 3.4 +
    Math.max(0, third.targetDistLong - second.targetDistShort) * 4.1 +
    Math.max(0, third.targetDistLong - first.targetDistNow) * 4.8 +
    Math.max(0, second.targetPathShort - first.targetPathNow) * 2.4 +
    Math.max(0, third.targetPathLong - second.targetPathShort) * 3.1 +
    Math.max(0, third.targetPathLong - first.targetPathNow) * 3.6;
  const orbitPenalty = orbitPlanPenalty(first, second, third) * 2.1;
  const farPenalty =
    Math.max(0, first.targetDistNow - 4.5) * 1.5 +
    Math.max(0, second.targetDistShort - 3.2) * 1.9 +
    Math.max(0, third.targetDistLong - 2.3) * 2.7 +
    Math.max(0, first.targetPathNow - 7.2) * 0.9 +
    Math.max(0, second.targetPathShort - 5.4) * 1.35 +
    Math.max(0, third.targetPathLong - 4.2) * 2.1;
  const leashPenalty =
    Math.max(0, third.targetDistLong - preferredCloseLeash(boardState, mode, target, tuning)) * 4.8 +
    Math.max(0, second.targetDistShort - (preferredCloseLeash(boardState, mode, target, tuning) + 0.8)) * 2.6 +
    Math.max(0, third.targetPathLong - preferredPathLeash(boardState, mode, target, tuning)) * 3.1 +
    Math.max(0, second.targetPathShort - (preferredPathLeash(boardState, mode, target, tuning) + 1.2)) * 1.55;
  const overRespectPenalty =
    third.safeLaneScore * (mode === "COMMIT" || mode === "PUNISH" || mode === "TRAP" ? 0.04 : 0.08);
  const stationaryPunish =
    !target.moving
      ? bandScore(third.targetDistLong, 1.9, 2.9, 3.2) +
        Math.max(0, 4.8 - second.targetDistShort) * 0.5
      : 0;
  const perfectStepBias =
    bandScore(first.targetDistNow, 2.2, 3.4, 0.8) +
    bandScore(second.targetDistShort, 1.8, 2.8, 1.2) +
    bandScore(third.targetDistLong, 1.2, 2.2, 1.45);
  const localThreatBias =
    boardState && boardState.localThreatCount > 0
      ? Math.max(0, 4.5 - third.targetDistLong) * 0.9
      : 0;
  const duelBias =
    boardState?.isDuel
      ? Math.max(0, 5 - third.targetDistLong) * 1.8 +
        Math.max(0, 4.5 - second.targetDistShort) * 1.1 -
        third.safeLaneScore * 0.12
      : 0;
  const kitePenalty = kiteChasePenalty(control, boardState, target, mode, first, second, third);

  return (
    closes +
    finishPressure +
    finishContact +
    punish +
    stationaryPunish +
    perfectStepBias +
    duelBias +
    localThreatBias -
    chasePenalty -
    kitePenalty * 1.72 -
    orbitPenalty -
    farPenalty -
    leashPenalty -
    overRespectPenalty
  );
}

function kiteChasePenalty(
  control: ControlMap,
  boardState: ReturnType<typeof buildTacticalBoard>,
  target: EntityStatePayload,
  mode: BrainMode,
  first: ControlTile,
  second: ControlTile,
  third: ControlTile
): number {
  if (!target.moving) {
    return 0;
  }
  const towardSelf = movementTowardTile(control.selfTile, target);
  if (towardSelf >= -0.06) {
    return 0;
  }
  if (third.targetDistLong <= 1.1 || third.targetLateralLong >= 2.75 || third.interceptScore >= 4 || third.trapScore >= 3.85) {
    return 0;
  }
  const closing =
    Math.max(0, first.targetDistNow - third.targetDistLong) * 1.8 +
    Math.max(0, first.targetPathNow - third.targetPathLong) * 1.55;
  const lowCut =
    Math.max(0, 2.45 - third.targetLateralLong) * 2.8 +
    Math.max(0, 3.6 - third.interceptScore) * 1.15 +
    Math.max(0, 3.3 - third.trapScore) * 0.88;
  const linearFollow =
    Math.max(0, second.targetPathShort - third.targetPathLong) * 1.15 +
    Math.max(0, 3.7 - third.targetDistLong) * 1.1;
  const duelRelief = boardState?.isDuel ? 0.9 : 1;
  const trapRelief = mode === "TRAP" || mode === "INTERCEPT" ? 0.82 : 1;
  return Math.max(0, -towardSelf - 0.05) * (closing + lowCut + linearFollow) * duelRelief * trapRelief;
}

function isStraightChasePattern(
  boardState: ReturnType<typeof buildTacticalBoard>,
  target: EntityStatePayload,
  first: ControlTile,
  second: ControlTile,
  third: ControlTile
): boolean {
  if (!target.moving) {
    return false;
  }
  if (boardState?.isDuel && third.targetDistLong <= 1.8) {
    return false;
  }
  return (
    second.targetPathShort <= first.targetPathNow - 0.65 &&
    third.targetPathLong <= second.targetPathShort - 0.35 &&
    third.targetLateralLong < 2.6 &&
    third.interceptScore < 3.9 &&
    third.trapScore < 3.7 &&
    third.targetDistLong > 1.15
  );
}

function isShadowFollowPattern(
  control: ControlMap,
  target: EntityStatePayload,
  plan: PlanCandidate
): boolean {
  if (!target.moving) {
    return false;
  }
  const move = resolveEntityMoveVector(target);
  if (!move) {
    return false;
  }
  const selfAdvanceX = plan.third.tile.x - control.selfTile.x;
  const selfAdvanceY = plan.third.tile.y - control.selfTile.y;
  const selfAdvanceLen = Math.hypot(selfAdvanceX, selfAdvanceY);
  const moveLen = Math.hypot(move.x, move.y);
  if (selfAdvanceLen < 0.001 || moveLen < 0.001) {
    return false;
  }
  const directionDot = (selfAdvanceX * move.x + selfAdvanceY * move.y) / (selfAdvanceLen * moveLen);
  const sameTrack =
    directionDot >= 0.42 &&
    plan.second.targetPathShort <= plan.first.targetPathNow - 0.45 &&
    plan.third.targetPathLong <= plan.second.targetPathShort - 0.2;
  const noAngleGain =
    plan.third.targetLateralLong < 3.05 &&
    plan.third.interceptScore < 4.2 &&
    plan.third.trapScore < 4.05;
  const notAlreadyHot = plan.third.targetDistLong > 1.05;
  return sameTrack && noAngleGain && notAlreadyHot;
}

function resolveEntityMoveVector(entity: EntityStatePayload): TilePoint | null {
  const x = entity.dirX !== 0 ? entity.dirX : Math.sign(entity.toX - entity.fromX);
  const y = entity.dirY !== 0 ? entity.dirY : Math.sign(entity.toY - entity.fromY);
  if (x === 0 && y === 0) {
    return null;
  }
  return { x, y };
}

function preferredCloseLeash(
  boardState: ReturnType<typeof buildTacticalBoard>,
  mode: BrainMode,
  target: EntityStatePayload,
  tuning: AdaptiveTuning | null
): number {
  const spacingBias = clampAdaptive(tuning?.spacingBias ?? 0, -0.7, 0.9);
  const commitBias = clampAdaptive(tuning?.commitBias ?? 0, -0.7, 0.7);
  if (boardState?.isDuel) {
    return target.moving ? 2.75 + spacingBias * 0.32 - commitBias * 0.18 : 2.15 + spacingBias * 0.25 - commitBias * 0.12;
  }
  switch (mode) {
    case "COMMIT":
    case "PUNISH":
    case "TRAP":
      return target.moving ? 2.12 + spacingBias * 0.24 - commitBias * 0.22 : 2.22 + spacingBias * 0.18 - commitBias * 0.18;
    case "INTERCEPT":
      return target.moving ? 2.58 + spacingBias * 0.34 - commitBias * 0.16 : 2.36 + spacingBias * 0.24 - commitBias * 0.1;
    case "CONTROL":
      return target.moving ? 2.72 + spacingBias * 0.46 - commitBias * 0.08 : 2.68 + spacingBias * 0.38 - commitBias * 0.06;
    case "LURE":
    case "STALK":
      return target.moving ? 2.92 + spacingBias * 0.52 - commitBias * 0.05 : 2.82 + spacingBias * 0.46 - commitBias * 0.04;
    case "FEINT":
      return target.moving ? 2.72 + spacingBias * 0.42 - commitBias * 0.12 : 2.52 + spacingBias * 0.35 - commitBias * 0.08;
    default:
      return target.moving ? 2.86 + spacingBias * 0.42 - commitBias * 0.1 : 2.84 + spacingBias * 0.36 - commitBias * 0.06;
  }
}

function preferredPathLeash(
  boardState: ReturnType<typeof buildTacticalBoard>,
  mode: BrainMode,
  target: EntityStatePayload,
  tuning: AdaptiveTuning | null
): number {
  const spacingBias = clampAdaptive(tuning?.spacingBias ?? 0, -0.7, 0.9);
  const commitBias = clampAdaptive(tuning?.commitBias ?? 0, -0.7, 0.7);
  if (boardState?.isDuel) {
    return target.moving ? 4.55 + spacingBias * 0.85 - commitBias * 0.35 : 4.05 + spacingBias * 0.65 - commitBias * 0.2;
  }
  switch (mode) {
    case "COMMIT":
    case "PUNISH":
    case "TRAP":
      return target.moving ? 3.95 + spacingBias * 0.45 - commitBias * 0.32 : 4.15 + spacingBias * 0.35 - commitBias * 0.22;
    case "INTERCEPT":
      return target.moving ? 4.65 + spacingBias * 0.72 - commitBias * 0.28 : 4.45 + spacingBias * 0.58 - commitBias * 0.18;
    case "CONTROL":
      return target.moving ? 4.95 + spacingBias * 0.94 - commitBias * 0.12 : 4.95 + spacingBias * 0.82 - commitBias * 0.08;
    case "LURE":
    case "STALK":
      return target.moving ? 5.25 + spacingBias * 1.05 - commitBias * 0.08 : 5.25 + spacingBias * 0.92 - commitBias * 0.05;
    case "FEINT":
      return target.moving ? 4.95 + spacingBias * 0.88 - commitBias * 0.16 : 4.75 + spacingBias * 0.72 - commitBias * 0.1;
    default:
      return target.moving ? 5.05 + spacingBias * 0.88 - commitBias * 0.12 : 5.15 + spacingBias * 0.76 - commitBias * 0.08;
  }
}

function wouldExceedRepeatLimit(key: string, history: string[]): boolean {
  if (history.length < 3) {
    return false;
  }
  let runLength = 0;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index] !== key) {
      break;
    }
    runLength += 1;
  }
  return runLength >= 3;
}

function clampAdaptive(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function computePunishBonus(
  distance: number,
  towardSelf: number,
  cluster: number,
  cornerLike: boolean,
  moving: boolean,
  mode: BrainMode
): number {
  const stationary =
    !moving && distance <= 5.9
      ? Math.max(0, 6 - distance) * (mode === "COMMIT" || mode === "INTERCEPT" ? 0.92 : 0.48) + 1.1
      : 0;
  const overextend =
    towardSelf >= 0.38 && distance <= 5.8
      ? 1.3 + Math.max(0, towardSelf - 0.38) * 4.1
      : 0;
  const isolated =
    cluster <= 0 && distance <= 5.8 ? 1.45 :
    cluster === 1 && distance <= 5.2 ? 0.55 :
    0;
  const trap =
    cornerLike && distance <= 6.3 && cluster <= 1
      ? 1.25
      : 0;
  const modeAmp =
    mode === "COMMIT"
      ? 1.35
      : mode === "INTERCEPT"
        ? 1.18
        : mode === "LURE"
          ? 0.72
          : 1;
  return (stationary + overextend + isolated + trap) * modeAmp;
}

function bandScore(distance: number, min: number, max: number, peak: number): number {
  if (distance >= min && distance <= max) {
    return peak;
  }
  if (distance < min) {
    return -(min - distance) * 1.8;
  }
  return peak - (distance - max) * 1.15;
}

function isLiveEnemy(self: EntityStatePayload, entity: EntityStatePayload): boolean {
  const standby = (entity.standbyRemainingMs ?? 0) > 0;
  return (
    entity.id !== self.id &&
    !entity.isSelf &&
    ((!entity.combatState?.busy && !entity.combatState?.react) || standby)
  );
}
