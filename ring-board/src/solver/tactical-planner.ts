import type { BrainMode } from "../shared/protocol.js";
import type { ControlMap, ControlTile } from "./control-map.js";
import type { TacticalBoardState } from "./tactical-board.js";

export interface TacticalPlanLike {
  first: ControlTile;
  second: ControlTile;
  third: ControlTile;
  score: number;
}

export function rerankPlansByTacticalBoard<T extends TacticalPlanLike>(
  plans: T[],
  control: ControlMap,
  board: TacticalBoardState | null,
  mode: BrainMode,
  highPower = false
): T[] {
  if (!board || plans.length <= 1) {
    return plans;
  }

  const topCount = Math.min(plans.length, highPower ? 96 : 28);
  const ranked = plans.slice(0, topCount).map((plan) => ({
    plan,
    total: plan.score + tacticalPlanBonus(plan, control, board, mode)
  }));

  ranked.sort(
    (left, right) =>
      right.total - left.total ||
      right.plan.score - left.plan.score ||
      left.plan.first.selfSteps - right.plan.first.selfSteps
  );

  return [...ranked.map((entry) => entry.plan), ...plans.slice(topCount)];
}

function tacticalPlanBonus(
  plan: TacticalPlanLike,
  control: ControlMap,
  board: TacticalBoardState,
  mode: BrainMode
): number {
  const { first, second, third } = plan;
  const closesLine =
    Math.max(0, first.targetDistNow - third.targetDistLong) +
    Math.max(0, first.targetPathNow - third.targetPathLong) * 0.85;
  const holdsBand = bandBonus(third.targetDistLong, 2, 3, 2.2);
  const sideBias = third.targetLateralLong * 0.92;
  const safeExit =
    third.safeLaneScore * 0.18 -
    third.deadEndPenalty * 0.24 -
    third.pincerRisk * 0.28 -
    Math.max(0, third.pressureLong - 2) * 0.34;
  const retreatPenalty =
    Math.max(0, second.targetDistShort - first.targetDistNow) * 1.45 +
    Math.max(0, third.targetDistLong - second.targetDistShort) * 2.15 +
    Math.max(0, third.targetDistLong - first.targetDistNow) * 2.55 +
    Math.max(0, second.targetPathShort - first.targetPathNow) * 1.05 +
    Math.max(0, third.targetPathLong - second.targetPathShort) * 1.55 +
    Math.max(0, third.targetPathLong - first.targetPathNow) * 1.95;
  const staticPunish =
    board.targetIsCamper
      ? Math.max(0, 5.8 - third.targetDistLong) * 1.15 +
        Math.max(0, 6.5 - third.targetPathLong) * 0.85 +
        third.punishScore * 0.12
      : 0;
  const crowdPenalty =
    board.directChallengerCount > 0
      ? Math.max(0, third.pincerRisk - 2.4) * (0.55 + board.directChallengerCount * 0.18)
      : 0;
  const cutoffPressure =
    (board.targetCanBeCutOff ? 1.8 : 0) +
    (board.targetIsCornered ? 1.25 : 0) +
    control.targetPunishFactor * 0.08;
  const movingBaitBonus = !board.targetIsCamper && board.targetIsEngaged ? 0.55 : 0;
  const mobileCutBias = !board.targetIsCamper && board.targetRingDistance <= 5.2 ? 0.7 : 0;

  switch (mode) {
    case "CONTROL":
      return (
        third.interceptScore * 0.24 +
        third.safeLaneScore * 0.16 +
        second.trapScore * 0.2 +
        bandBonus(third.targetDistLong, 1.8, 2.7, 2.45) +
        closesLine * 1.42 +
        cutoffPressure * 0.5 +
        sideBias * 0.74 +
        safeExit * 0.52 -
        retreatPenalty * 0.64 -
        Math.max(0, third.targetDistLong - 3.2) * 2.2 -
        crowdPenalty
      );
    case "TRAP":
      return (
        third.trapScore * 0.76 +
        second.trapScore * 0.34 +
        third.commitScore * 0.48 +
        closesLine * 1.82 +
        cutoffPressure * 1.2 +
        staticPunish * 0.72 +
        mobileCutBias +
        sideBias * 1.1 +
        safeExit * 0.42 -
        retreatPenalty * 0.84 -
        Math.max(0, third.targetDistLong - 2.25) * 2.9 -
        crowdPenalty * 1.08
      );
    case "LURE":
      return (
        first.baitScore * 0.14 +
        second.baitScore * 0.22 +
        third.baitScore * 0.12 +
        bandBonus(third.targetDistLong, 2.45, 3.55, 3.05) +
        safeExit * 0.55 +
        movingBaitBonus +
        (board.targetIsCamper ? 0.8 : 0) -
        Math.max(0, 2 - third.targetDistLong) * 2.35 -
        crowdPenalty * 0.55
      );
    case "FEINT":
      return (
        second.trapScore * 0.2 +
        third.safeLaneScore * 0.3 +
        mobileCutBias * 0.82 +
        safeExit * 1.1 +
        bandBonus(second.targetDistShort, 2.05, 3.05, 1.95) * 0.92 -
        Math.max(0, third.targetDistLong - 2.7) * 1.4
      );
    case "PUNISH":
      return (
        closesLine * 1.52 +
        staticPunish * 1.1 +
        sideBias * 0.62 +
        cutoffPressure * 0.34 +
        safeExit * 0.22 -
        retreatPenalty * 0.72 -
        Math.max(0, third.targetDistLong - 2.35) * 2.05 -
        crowdPenalty * 0.42
      );
    case "COMMIT":
      return (
        closesLine * 1.44 +
        staticPunish * 0.68 +
        sideBias * 0.56 +
        safeExit * (board.isDuel ? 0.04 : 0.16) -
        retreatPenalty * 0.74 -
        Math.max(0, third.targetDistLong - (board.isDuel ? 1.9 : 2.2)) * (board.isDuel ? 2.8 : 2.2) -
        crowdPenalty * 0.34
      );
    case "INTERCEPT":
      return (
        third.interceptScore * 0.2 +
        closesLine * 0.96 +
        bandBonus(third.targetDistLong, 2.2, 3.1, 2.45) +
        safeExit * 0.72 -
        retreatPenalty * 0.46 -
        Math.max(0, third.targetDistLong - 2.8) * 1.2
      );
    case "STALK":
      return (
        bandBonus(third.targetDistLong, 2.55, 3.7, 3.3) +
        third.safeLaneScore * 0.22 +
        safeExit * 0.82 +
        (board.targetIsCamper ? 0.85 : 0) -
        Math.max(0, 1.9 - third.targetDistLong) * 1.55 -
        crowdPenalty * 0.48
      );
    case "SEEK":
    case "RESET":
    case "EVADE":
    default:
      return 0;
  }
}

function bandBonus(distance: number, min: number, max: number, peak: number): number {
  if (distance >= min && distance <= max) {
    return peak;
  }
  if (distance < min) {
    return -(min - distance) * 1.8;
  }
  return peak - (distance - max) * 1.15;
}
