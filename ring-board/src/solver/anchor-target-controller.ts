import type { PredictedWindow } from "../shared/protocol.js";

export interface AnchorContext {
  nowWall: number;
  mode: "CONTROL" | "STALK" | "LURE" | "FEINT" | "TRAP" | "PUNISH" | "INTERCEPT" | "COMMIT" | "EVADE" | "SEEK" | "RESET";
  pressure: number;
  localThreats: number;
  collapse: number;
}

export interface AnchorCandidate {
  id: number;
  confidence: number;
  window: PredictedWindow | null;
  utility: number;
  localThreatScore: number;
  pincerRisk: number;
  reachable: boolean;
  distance: number;
  engaged: boolean;
  recentAggressor: boolean;
}

export interface AnchorState {
  targetId: number;
  sinceWall: number;
  lockedUntil: number;
}

export class AnchorTargetController {
  private state: AnchorState = {
    targetId: -1,
    sinceWall: 0,
    lockedUntil: 0
  };

  private contenderId = -1;

  private contenderSinceWall = 0;

  public reset(): void {
    this.state = {
      targetId: -1,
      sinceWall: 0,
      lockedUntil: 0
    };
    this.contenderId = -1;
    this.contenderSinceWall = 0;
  }

  public current(): AnchorState {
    return { ...this.state };
  }

  public choose(candidates: AnchorCandidate[], context: AnchorContext): AnchorState {
    const valid = candidates.filter((candidate) => candidate.id >= 0);
    if (valid.length === 0) {
      this.reset();
      return this.current();
    }

    const pool = buildPriorityPool(valid, context);
    const best = [...pool].sort((left, right) =>
      scoreCandidate(right, context) - scoreCandidate(left, context) ||
      right.confidence - left.confidence ||
      compareWindowEta(left.window, right.window)
    )[0];
    const current = valid.find((candidate) => candidate.id === this.state.targetId) ?? null;
    const baseLock = lockDurationByMode(context.mode);

    if (!current) {
      this.state = {
        targetId: best.id,
        sinceWall: context.nowWall,
        lockedUntil: context.nowWall + baseLock
      };
      return this.current();
    }

    const bestScore = scoreCandidate(best, context);
    const currentScore = scoreCandidate(current, context);
    const challengerMargin = switchMargin(context, current, best);
    const challengerHold = contenderHoldMs(context, current, best);
    const challengerLead = bestScore - currentScore;
    const bestWindowHotter =
      best.window &&
      current.window &&
      compareWindowEta(best.window, current.window) <= -90;
    const bestWindowClearlyBetter =
      best.window &&
      current.window &&
      best.window.bestAt <= current.window.bestAt - 10 &&
      best.confidence >= current.confidence + 0.12;
    const currentLocal = current.recentAggressor || current.engaged || current.localThreatScore >= 1.1;
    const bestLocal = best.recentAggressor || best.engaged || best.localThreatScore >= 1.1;
    const currentPinnedLocal =
      current.recentAggressor ||
      (current.engaged && current.distance <= 4.9) ||
      current.localThreatScore >= 2.2;
    const bestPinnedLocal =
      best.recentAggressor ||
      (best.engaged && best.distance <= 4.9) ||
      best.localThreatScore >= 2.2;
    const localThreatOverride =
      context.localThreats > 0 &&
      bestLocal &&
      (!currentLocal || best.distance + 0.8 < current.distance || best.recentAggressor);
    const farCurrentPenalty =
      context.localThreats > 0 &&
      current.distance > 5.1 &&
      best.distance <= 4.8;
    const currentUtilityBad =
      !current.reachable ||
      (current.pincerRisk >= 3.2 && !current.engaged) ||
      current.utility < best.utility - 1.85;
    const refuseFarSwitch =
      context.localThreats > 0 &&
      currentPinnedLocal &&
      !bestPinnedLocal &&
      best.distance > current.distance + 0.8;
    const immediatePinnedUpgrade =
      best.id !== current.id &&
      bestPinnedLocal &&
      (!currentPinnedLocal || best.recentAggressor || current.distance > 5.2);

    if (this.contenderId !== best.id) {
      this.contenderId = best.id;
      this.contenderSinceWall = context.nowWall;
    }

    const contenderMature = context.nowWall - this.contenderSinceWall >= challengerHold;
    const shouldSwitch =
      best.id !== current.id &&
      !refuseFarSwitch &&
      (immediatePinnedUpgrade ||
        localThreatOverride ||
        farCurrentPenalty ||
        currentUtilityBad ||
        (contenderMature && challengerLead >= challengerMargin) ||
        (context.nowWall >= this.state.lockedUntil &&
          (challengerLead >= challengerMargin || bestWindowClearlyBetter || bestWindowHotter)));

    if (shouldSwitch) {
      this.state = {
        targetId: best.id,
        sinceWall: context.nowWall,
        lockedUntil: context.nowWall + baseLock
      };
      this.contenderId = -1;
      this.contenderSinceWall = 0;
    } else {
      const extension = Math.max(110, baseLock / 2 + (context.localThreats > 0 ? 35 : 0));
      this.state.lockedUntil = Math.max(this.state.lockedUntil, context.nowWall + extension);
    }

    return this.current();
  }
}

function lockDurationByMode(mode: AnchorContext["mode"]): number {
  switch (mode) {
    case "CONTROL":
      return 560;
    case "STALK":
    case "COMMIT":
      return 700;
    case "TRAP":
      return 480;
    case "PUNISH":
      return 620;
    case "EVADE":
      return 340;
    default:
      return 520;
  }
}

function compareWindowEta(left: PredictedWindow | null, right: PredictedWindow | null): number {
  const leftEta = left?.bestAt ?? 9999;
  const rightEta = right?.bestAt ?? 9999;
  return leftEta - rightEta;
}

function buildPriorityPool(candidates: AnchorCandidate[], context: AnchorContext): AnchorCandidate[] {
  if (context.localThreats <= 0) {
    return candidates;
  }
  const local = candidates.filter(
    (candidate) =>
      candidate.distance <= 5.2 ||
      candidate.recentAggressor ||
      candidate.engaged ||
      candidate.localThreatScore >= 1.1
  );
  return local.length > 0 ? local : candidates;
}

function scoreCandidate(candidate: AnchorCandidate, context: AnchorContext): number {
  const localityBonus = candidate.localThreatScore * 1.7;
  const aggressiveBonus =
    (candidate.engaged ? 2.15 : 0) +
    (candidate.recentAggressor ? 2.1 : 0) +
    (candidate.distance <= 3.4 ? 0.9 : 0);
  const rangePenalty = Math.max(0, candidate.distance - 4.6) * (context.localThreats > 0 ? 1.35 : 0.9);
  const deadZonePenalty =
    context.localThreats > 0 && candidate.distance > 5 && !candidate.recentAggressor ? 3.4 : 0;
  return (
    candidate.utility +
    localityBonus +
    aggressiveBonus -
    rangePenalty -
    deadZonePenalty -
    (!candidate.reachable ? 3.5 : 0) -
    candidate.pincerRisk * 0.18
  );
}

function switchMargin(context: AnchorContext, current: AnchorCandidate, best: AnchorCandidate): number {
  let margin = context.mode === "EVADE" ? 0.7 : 1.0;
  if (context.localThreats > 0) {
    margin += 0.55;
  }
  if (current.distance <= 4.5 && best.distance > current.distance + 1.5) {
    margin += 0.9;
  }
  if (current.distance > 5.5 && best.distance <= 4.8) {
    margin -= 0.45;
  }
  if (best.recentAggressor) {
    margin -= 0.2;
  }
  return clamp(margin, 0.45, 2.2);
}

function contenderHoldMs(context: AnchorContext, current: AnchorCandidate, best: AnchorCandidate): number {
  let hold = context.mode === "COMMIT" || context.mode === "STALK" ? 110 : 90;
  if (context.localThreats >= 2) {
    hold = 55;
  } else if (context.localThreats >= 1) {
    hold = 70;
  }
  if (current.distance > 5.6 && best.distance <= 4.8) {
    hold = 35;
  }
  if (best.recentAggressor || best.engaged) {
    hold -= 10;
  }
  return clamp(hold, 25, 150);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
