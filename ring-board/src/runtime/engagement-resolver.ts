import type {
  EntityStatePayload,
  PredictedWindow,
  ResolveEventPayload,
  ServerStateSnapshot
} from "../shared/protocol.js";
import { predictWindowForEntities, ringTargetDistance } from "../solver/contact-solver.js";

export interface FocusResolution {
  focusTargetId: number;
  attackerTargetId: number;
  preferredWindow: PredictedWindow | null;
  localThreatCount: number;
  engagedIds: number[];
  attackerIds: number[];
}

interface Candidate {
  entity: EntityStatePayload;
  dist: number;
  cheb: number;
  window: PredictedWindow | null;
  engaged: boolean;
  attacker: boolean;
  imminent: boolean;
  recentAggressor: boolean;
  selected: boolean;
  closing: number;
  standby: boolean;
  standbyRole: "ATTACKER" | "DEFENDER" | "NONE";
  standbyRemaining: number;
  score: number;
  attackerScore: number;
}

export function resolveFocusResolution(snapshot: ServerStateSnapshot): FocusResolution {
  const self = snapshot.entities.find((entity) => entity.isSelf) ?? null;
  if (!self) {
    return {
      focusTargetId: -1,
      attackerTargetId: -1,
      preferredWindow: null,
      localThreatCount: 0,
      engagedIds: [],
      attackerIds: []
    };
  }

  const recentAggressorId = resolveRecentAggressorId(snapshot.lastResolve, self.id, snapshot.nowTs);
  const candidates = snapshot.entities
    .filter((entity) => isCandidateTarget(self, entity))
    .map((entity) => {
      const dist = ringTargetDistance(self, entity);
      const cheb = chebyshev(self, entity);
      const window = predictWindowForEntities(self, entity, snapshot.nowTs);
      const closing = closingTowardSelf(self, entity);
      const recentAggressor = entity.id === recentAggressorId;
      const selected = entity.id === snapshot.targetId;
      const standbyRemaining = entity.standbyRemainingMs ?? 0;
      const standbyRole: Candidate["standbyRole"] = entity.standbyRole ?? "NONE";
      const standby = standbyRemaining > 0;
      const imminent =
        (window?.bestAt ?? 999) <= 84 ||
        (dist <= 3.25) ||
        (dist <= 4.4 && closing >= 0.18) ||
        (cheb <= 3.2 && closing >= 0.12);
      const engaged =
        recentAggressor ||
        imminent ||
        dist <= 4.95 ||
        cheb <= 4.4 ||
        (window?.bestAt ?? 999) <= 148 ||
        closing >= 0.24 ||
        (standby && dist <= 5.4) ||
        (selected && dist <= 5.4);
      const attacker =
        recentAggressor ||
        (!standby && imminent) ||
        (!standby && dist <= 5.2 && closing >= 0.28) ||
        (!standby && dist <= 4.8 && (window?.bestAt ?? 999) <= 104) ||
        (!standby && dist <= 3.45) ||
        (cheb <= 3 && closing >= 0.08);
      return {
        entity,
        dist,
        cheb,
        window,
        engaged,
        attacker,
        imminent,
        recentAggressor,
        selected,
        closing,
        standby,
        standbyRole,
        standbyRemaining,
        score: 0,
        attackerScore: 0
      };
    });

  if (candidates.length === 0) {
    return {
      focusTargetId: -1,
      attackerTargetId: -1,
      preferredWindow: null,
      localThreatCount: 0,
      engagedIds: [],
      attackerIds: []
    };
  }

  const localThreatCount = candidates.filter((candidate) => candidate.engaged).length;
  const engagedIds = candidates
    .filter((candidate) => candidate.engaged)
    .map((candidate) => candidate.entity.id);
  const attackerIds = candidates
    .filter((candidate) => candidate.attacker)
    .map((candidate) => candidate.entity.id);

  for (const candidate of candidates) {
    candidate.score = candidateFocusScore(candidate, localThreatCount);
    candidate.attackerScore = candidateAttackerScore(candidate);
  }

  const focus = [...candidates].sort((left, right) =>
    right.score - left.score ||
    right.attackerScore - left.attackerScore ||
    left.dist - right.dist ||
    left.cheb - right.cheb ||
    compareWindowPriority(left.window, right.window)
  )[0];
  const attackerFocus = attackerIds.length > 0
    ? [...candidates]
        .filter((candidate) => candidate.attacker)
        .sort((left, right) =>
          right.attackerScore - left.attackerScore ||
          right.score - left.score ||
          left.dist - right.dist ||
          left.cheb - right.cheb ||
          compareWindowPriority(left.window, right.window)
        )[0]
    : null;

  const preferredPool =
    attackerIds.length > 0
      ? candidates.filter((candidate) => candidate.attacker || candidate.recentAggressor)
      : localThreatCount > 0
      ? candidates.filter(
          (candidate) =>
            candidate.engaged ||
            candidate.recentAggressor ||
            (candidate.selected && candidate.dist <= 5.5)
        )
      : candidates;

  const preferredWindow = preferredPool
    .filter((candidate) => candidate.window)
    .sort((left, right) => compareWindowPriority(left.window, right.window) || right.score - left.score)
    .map((candidate) => candidate.window)[0] ?? null;

  return {
    focusTargetId: focus?.entity.id ?? -1,
    attackerTargetId: attackerFocus?.entity.id ?? -1,
    preferredWindow,
    localThreatCount,
    engagedIds,
    attackerIds
  };
}

function candidateFocusScore(candidate: Candidate, localThreatCount: number): number {
  let score = 0;
  score += Math.max(0, 5.8 - candidate.dist) * 1.75;
  score += Math.max(0, 4.8 - candidate.cheb) * 0.95;
  score += candidate.engaged ? 4.2 : 0;
  score += candidate.attacker ? 4.4 : 0;
  score += candidate.imminent ? 3.2 : 0;
  score += candidate.recentAggressor ? 3.2 : 0;
  score += candidate.selected ? 1.15 : 0;
  score += candidate.closing * 2.8;
  score += candidate.standby
    ? candidate.standbyRole === "DEFENDER"
      ? 3.8 + Math.max(0, 5.6 - candidate.dist) * 0.85
      : 2.4 + Math.max(0, 5.2 - candidate.dist) * 0.65
    : 0;
  if (candidate.window) {
    score += windowKindWeight(candidate.window.kind);
    score += Math.max(0, (168 - candidate.window.bestAt) * 0.03);
    score += candidate.window.confidence * 2.7;
  }
  if (localThreatCount > 0) {
    if (!candidate.engaged) {
      score -= 4.2;
    }
    if (!candidate.attacker) {
      score -= 1.15;
    }
    if (candidate.dist > 5.1) {
      score -= 5.6 + (candidate.dist - 5.1) * 1.45;
    }
    if (candidate.cheb > 5) {
      score -= 1.2 + (candidate.cheb - 5) * 0.75;
    }
  }
  return score;
}

function candidateAttackerScore(candidate: Candidate): number {
  let score = 0;
  score += candidate.attacker ? 6.8 : 0;
  score += candidate.imminent ? 3.4 : 0;
  score += candidate.recentAggressor ? 3.8 : 0;
  score += Math.max(0, 5.8 - candidate.dist) * 2.2;
  score += Math.max(0, 4.8 - candidate.cheb) * 1.1;
  score += Math.max(0, candidate.closing) * 4.6;
  if (candidate.window) {
    score += windowKindWeight(candidate.window.kind) * 1.05;
    score += Math.max(0, (138 - candidate.window.bestAt) * 0.04);
    score += candidate.window.confidence * 2.8;
  }
  if (candidate.standby) {
    score -= candidate.standbyRole === "DEFENDER" ? 4.6 : 2.6;
  }
  return score;
}

function compareWindowPriority(left: PredictedWindow | null, right: PredictedWindow | null): number {
  if (!left && !right) {
    return 0;
  }
  if (!left) {
    return 1;
  }
  if (!right) {
    return -1;
  }
  const kindDiff = windowKindRank(left.kind) - windowKindRank(right.kind);
  if (kindDiff !== 0) {
    return kindDiff;
  }
  if (left.bestAt !== right.bestAt) {
    return left.bestAt - right.bestAt;
  }
  if (left.confidence !== right.confidence) {
    return right.confidence - left.confidence;
  }
  return left.targetId - right.targetId;
}

function resolveRecentAggressorId(
  resolve: ResolveEventPayload | null,
  selfId: number,
  nowTs: number
): number {
  if (!resolve || nowTs - resolve.timestamp > 1300) {
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

function closingTowardSelf(self: EntityStatePayload, entity: EntityStatePayload): number {
  const moveDx =
    entity.dirX !== 0 || entity.dirY !== 0
      ? entity.dirX
      : clamp(entity.toX - entity.fromX, -1, 1);
  const moveDy =
    entity.dirX !== 0 || entity.dirY !== 0
      ? entity.dirY
      : clamp(entity.toY - entity.fromY, -1, 1);
  const dxToSelf = self.x - entity.x;
  const dyToSelf = self.y - entity.y;
  const mag = Math.hypot(dxToSelf, dyToSelf);
  if (mag <= 0.001) {
    return 0;
  }
  return ((moveDx * dxToSelf + moveDy * dyToSelf) / mag);
}

function windowKindWeight(kind: PredictedWindow["kind"]): number {
  switch (kind) {
    case "HOT":
      return 4.8;
    case "DIAG":
      return 3.5;
    case "STAGE":
      return 2.2;
    case "APPROACH":
      return 1.2;
    default:
      return 0;
  }
}

function windowKindRank(kind: PredictedWindow["kind"]): number {
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

function isCandidateTarget(self: EntityStatePayload, target: EntityStatePayload): boolean {
  if (target.id === self.id || target.isSelf) {
    return false;
  }
  if (target.combatState?.busy || target.combatState?.react) {
    return false;
  }
  if (
    target.toX === 0 &&
    target.toY === 0 &&
    target.fromX === 0 &&
    target.fromY === 0 &&
    Math.round(target.x) === 0 &&
    Math.round(target.y) === 0
  ) {
    return false;
  }
  return true;
}

function chebyshev(
  left: Pick<EntityStatePayload, "x" | "y">,
  right: Pick<EntityStatePayload, "x" | "y">
): number {
  return Math.max(Math.abs(left.x - right.x), Math.abs(left.y - right.y));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
