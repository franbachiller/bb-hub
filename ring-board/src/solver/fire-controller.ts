import type { FireCommandMessage, FireControlOptions, ServerStateSnapshot } from "../shared/protocol.js";

export class FireController {
  private activeWindowId = "";

  private activeTargetId = -1;

  private activeReason = "";

  private activeSceneHash = "";

  private activeFireAtTs = 0;

  private activeIssuedAtTs = 0;

  private activeExpiresAtTs = 0;

  private activeBurstOffsetsMs: number[] = [];

  private activeFireAtWall = 0;

  private activeExpiresAtWall = 0;

  private nextRetryAtWall = 0;

  public evaluate(
    snapshot: ServerStateSnapshot,
    nowWall: number,
    options: FireControlOptions = DEFAULT_FIRE_OPTIONS
  ): FireCommandMessage | null {
    if (!snapshot.armed || !snapshot.scene || snapshot.scene.policy !== "allowed") {
      this.reset();
      return null;
    }
    if (snapshot.round.phase !== "LIVE") {
      this.reset();
      return null;
    }

    const plan =
      options.pulseClick
        ? resolvePulsePlan(snapshot, options)
        : options.stepCadenceAlways
          ? resolveStepCadencePlan(snapshot, options)
          : null;
    if (!plan) {
      this.clearWindow();
      return null;
    }

    const swfNow = estimateSwfClock(snapshot);
    if (swfNow == null) {
      this.clearWindow();
      return null;
    }

    const fireDelay = Math.max(0, Math.round(plan.fireDelay));
    const planBurstOffsetsMs = normalizeBurstOffsets(plan.burstOffsetsMs);
    const lastBurstOffset = planBurstOffsetsMs[planBurstOffsetsMs.length - 1] ?? 0;
    const fireAtTs = swfNow + fireDelay;
    const expiresAtTs = swfNow + Math.max(plan.windowEndAt + 72, fireDelay + lastBurstOffset + 56);
    const fireAtWall = Math.max(nowWall, snapshot.frameWall + fireDelay);
    const expiresAtWall = fireAtWall + Math.max(96, lastBurstOffset + 56, plan.windowEndAt + 72);

    const sameWindow =
      plan.windowId === this.activeWindowId &&
      plan.targetId === this.activeTargetId &&
      snapshot.scene.sceneHash === this.activeSceneHash &&
      offsetsEqual(planBurstOffsetsMs, this.activeBurstOffsetsMs);

    if (!sameWindow) {
      this.setActivePlan({
        windowId: plan.windowId,
        targetId: plan.targetId,
        reason: plan.reason,
        sceneHash: snapshot.scene.sceneHash,
        fireAtTs,
        issuedAtTs: swfNow,
        expiresAtTs,
        burstOffsetsMs: planBurstOffsetsMs,
        fireAtWall,
        expiresAtWall,
        nextRetryAtWall: nowWall + retryIntervalMs()
      });
      return this.buildFireMessage(nowWall);
    }

    if (nowWall > this.activeExpiresAtWall) {
      this.clearWindow();
      return null;
    }

    const pendingDelivery = nowWall + 4 < this.activeFireAtWall;
    const fireAtDrift = Math.abs(fireAtWall - this.activeFireAtWall);
    if (pendingDelivery && fireAtDrift >= 6 && nowWall >= this.nextRetryAtWall) {
      this.setActivePlan({
        windowId: plan.windowId,
        targetId: plan.targetId,
        reason: plan.reason,
        sceneHash: snapshot.scene.sceneHash,
        fireAtTs,
        issuedAtTs: swfNow,
        expiresAtTs,
        burstOffsetsMs: planBurstOffsetsMs,
        fireAtWall,
        expiresAtWall,
        nextRetryAtWall: nowWall + retryIntervalMs()
      });
      return this.buildFireMessage(nowWall);
    }

    return null;
  }

  public reset(): void {
    this.clearWindow();
  }

  private clearWindow(): void {
    this.activeWindowId = "";
    this.activeTargetId = -1;
    this.activeReason = "";
    this.activeSceneHash = "";
    this.activeFireAtTs = 0;
    this.activeIssuedAtTs = 0;
    this.activeExpiresAtTs = 0;
    this.activeBurstOffsetsMs = [];
    this.activeFireAtWall = 0;
    this.activeExpiresAtWall = 0;
    this.nextRetryAtWall = 0;
  }

  private setActivePlan(plan: {
    windowId: string;
    targetId: number;
    reason: string;
    sceneHash: string;
    fireAtTs: number;
    issuedAtTs: number;
    expiresAtTs: number;
    burstOffsetsMs: number[];
    fireAtWall: number;
    expiresAtWall: number;
    nextRetryAtWall: number;
  }): void {
    this.activeWindowId = plan.windowId;
    this.activeTargetId = plan.targetId;
    this.activeReason = plan.reason;
    this.activeSceneHash = plan.sceneHash;
    this.activeFireAtTs = plan.fireAtTs;
    this.activeIssuedAtTs = plan.issuedAtTs;
    this.activeExpiresAtTs = plan.expiresAtTs;
    this.activeBurstOffsetsMs = plan.burstOffsetsMs;
    this.activeFireAtWall = plan.fireAtWall;
    this.activeExpiresAtWall = plan.expiresAtWall;
    this.nextRetryAtWall = plan.nextRetryAtWall;
  }

  private buildFireMessage(nowWall: number): FireCommandMessage {
    return {
      type: "fire",
      targetId: this.activeTargetId,
      reason: this.activeReason,
      windowId: this.activeWindowId,
      fireAt: Math.max(nowWall, this.activeFireAtWall),
      fireAtTs: this.activeFireAtTs,
      burstOffsetsMs: this.activeBurstOffsetsMs,
      requireSelection: false,
      sceneHash: this.activeSceneHash,
      issuedAtTs: this.activeIssuedAtTs,
      expiresAtTs: this.activeExpiresAtTs
    };
  }
}

const DEFAULT_FIRE_OPTIONS: FireControlOptions = {
  highPower: false,
  moveAssist: false,
  stepCadenceAlways: false,
  pulseClick: false,
  initiativeStrike: false,
  timingStartPct: 79,
  timingEndPct: 100,
  timingIntervalMs: 33,
  timingMultiplier: 1
};

interface FirePlanInput {
  targetId: number;
  windowId: string;
  reason: string;
  fireDelay: number;
  windowEndAt: number;
  burstOffsetsMs: number[];
}

function resolvePulsePlan(snapshot: ServerStateSnapshot, options: FireControlOptions): FirePlanInput | null {
  if (!snapshot.scene) {
    return null;
  }
  const self = snapshot.entities.find((entity) => entity.isSelf) ?? null;
  if (!self) {
    return null;
  }
  const target = resolveBotFireTarget(snapshot, self);
  if (!target) {
    return null;
  }

  const tileMs = medianStepMs(self.stepDur, target.stepDur);
  const burstOffsetsMs = buildTimingBurstOffsets(
    tileMs,
    options.timingStartPct,
    options.timingEndPct,
    options.timingIntervalMs,
    options.timingMultiplier
  );
  const pulseBucket = Math.floor(snapshot.nowTs / 10);
  return {
    targetId: target.id,
    windowId: [snapshot.scene.sceneHash, target.id, "PULSE_CLICK", pulseBucket].join(":"),
    reason: "BRAIN_PULSE_CLICK",
    fireDelay: 0,
    windowEndAt: 120 + (burstOffsetsMs[burstOffsetsMs.length - 1] ?? 0),
    burstOffsetsMs
  };
}

function resolveStepCadencePlan(snapshot: ServerStateSnapshot, options: FireControlOptions): FirePlanInput | null {
  if (!snapshot.scene) {
    return null;
  }
  const self = snapshot.entities.find((entity) => entity.isSelf) ?? null;
  if (!self) {
    return null;
  }
  const target = resolveBotFireTarget(snapshot, self);
  if (!target) {
    return null;
  }

  const selfRemain = stepRemainingMs(self);
  const targetRemain = stepRemainingMs(target);
  let cadenceRemain = Number.POSITIVE_INFINITY;
  if (Number.isFinite(selfRemain)) {
    cadenceRemain = selfRemain;
  }
  if (Number.isFinite(targetRemain)) {
    cadenceRemain = Number.isFinite(cadenceRemain) ? Math.min(cadenceRemain, targetRemain) : targetRemain;
  }
  if (!Number.isFinite(cadenceRemain)) {
    return null;
  }

  const tileMs = medianStepMs(self.stepDur, target.stepDur);
  const burstOffsetsMs = buildTimingBurstOffsets(
    tileMs,
    options.timingStartPct,
    options.timingEndPct,
    options.timingIntervalMs,
    options.timingMultiplier
  );
  const fireDelay = resolveTimingCadenceDelay(tileMs, cadenceRemain, options.timingStartPct);
  const selfStepKey = self.stepStartAt > 0 ? Math.floor(self.stepStartAt / 8) : 0;
  const targetStepKey = target.stepStartAt > 0 ? Math.floor(target.stepStartAt / 8) : 0;
  const lastBurstOffset = burstOffsetsMs[burstOffsetsMs.length - 1] ?? 0;
  return {
    targetId: target.id,
    windowId: [snapshot.scene.sceneHash, target.id, "STEP_CADENCE", selfStepKey, targetStepKey].join(":"),
    reason: "BRAIN_STEP_CADENCE_ALWAYS",
    fireDelay,
    windowEndAt: Math.max(196, fireDelay + lastBurstOffset),
    burstOffsetsMs
  };
}

function resolveBotFireTarget(
  snapshot: ServerStateSnapshot,
  self: ServerStateSnapshot["entities"][number]
): ServerStateSnapshot["entities"][number] | null {
  const ids = [
    snapshot.targetId,
    snapshot.brain?.strikeTargetId ?? -1,
    snapshot.brain?.committedTargetId ?? -1,
    snapshot.brain?.targetId ?? -1,
    snapshot.brain?.anchorTargetId ?? -1,
    snapshot.lastFire && snapshot.nowTs - snapshot.lastFire.issuedAtTs <= 1200 ? snapshot.lastFire.targetId : -1,
    snapshot.selection?.lockedTarget ?? -1,
    snapshot.selection?.punchTarget ?? -1,
    snapshot.selection?.pendingTarget ?? -1,
    snapshot.selection?.derivedTarget ?? -1,
    snapshot.selection?.rawSelectedTarget ?? -1
  ];

  for (const id of ids) {
    const target = snapshot.entities.find((entity) => entity.id === id) ?? null;
    if (target && target.id !== self.id && !target.isSelf) {
      return target;
    }
  }

  return null;
}

function stepRemainingMs(entity: ServerStateSnapshot["entities"][number]): number {
  if (!entity.moving || entity.stepDur <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  const progress = clamp(entity.phase > 0 ? entity.phase : 0, 0, 1);
  return Math.max(0, Math.round((1 - progress) * entity.stepDur));
}

function medianStepMs(...durations: number[]): number {
  const values = durations
    .filter((value) => isUsableStepMs(value))
    .sort((left, right) => left - right);
  if (values.length === 0) {
    return 550;
  }
  const mid = Math.floor(values.length / 2);
  if (values.length % 2 === 1) {
    return values[mid]!;
  }
  return Math.round((values[mid - 1]! + values[mid]!) / 2);
}

function resolveTimingCadenceDelay(tileMs: number, cadenceRemain: number, startPct: number): number {
  const normalizedTileMs = normalizeStepMs(tileMs);
  const start = clamp(Math.round(startPct), 0, 99);
  const leadMs = clamp(Math.round(normalizedTileMs * (100 - start) / 100), 0, Math.min(520, normalizedTileMs));
  return clamp(Math.round(cadenceRemain - leadMs), 0, 520);
}

function buildTimingBurstOffsets(
  tileMs: number,
  startPct: number,
  endPct: number,
  intervalMs: number,
  multiplier: number
): number[] {
  const normalizedTileMs = normalizeStepMs(tileMs);
  const start = clamp(Math.round(startPct), 0, 99);
  const end = clamp(Math.round(endPct), start + 1, 100);
  const interval = clamp(Math.round(intervalMs), 1, 200);
  const normalizedMultiplier = clamp(Math.round(multiplier), 1, 4);
  const effectiveInterval = clamp(Math.round(interval / normalizedMultiplier), 1, 200);
  const duration = clamp(Math.round(normalizedTileMs * (end - start) / 100), 1, Math.min(520, normalizedTileMs));
  const offsets: number[] = [];
  for (let offset = 0; offset <= duration; offset += effectiveInterval) {
    offsets.push(offset);
  }
  if (offsets.length === 0 || offsets[offsets.length - 1] !== duration) {
    offsets.push(duration);
  }
  return offsets;
}

function isUsableStepMs(value: number): boolean {
  return Number.isFinite(value) && value > 0 && value <= 2000;
}

function normalizeStepMs(value: number): number {
  return isUsableStepMs(value) ? Math.round(value) : 550;
}

export function estimateSwfClock(snapshot: ServerStateSnapshot): number | null {
  const baseFrameTs = snapshot.frameTs > 0 ? snapshot.frameTs : snapshot.nowTs;
  const candidates = snapshot.entities
    .filter((entity) => entity.stepStartAt > 0 && entity.stepDur > 0)
    .map((entity) => {
      const progress = clamp(entity.phase > 0 ? entity.phase : 0, 0, 1);
      const nowEstimate = entity.stepStartAt + Math.round(progress * entity.stepDur);
      return {
        entity,
        nowEstimate,
        moving: entity.moving
      };
    })
    .filter((candidate) => candidate.moving || candidate.entity.isSelf);

  if (candidates.length === 0) {
    return baseFrameTs > 0 ? baseFrameTs : null;
  }

  candidates.sort(
    (left, right) =>
      Number(right.moving) - Number(left.moving) ||
      right.nowEstimate - left.nowEstimate ||
      left.entity.id - right.entity.id
  );
  const estimate = candidates[0]?.nowEstimate ?? baseFrameTs;
  return clamp(estimate, baseFrameTs - 60, baseFrameTs + 60);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function retryIntervalMs(): number {
  return 4;
}

function normalizeBurstOffsets(value: number[] | undefined): number[] {
  const input = Array.isArray(value) ? value : [];
  const output: number[] = [];
  for (const candidate of input) {
    const parsed = Number(candidate);
    if (!Number.isFinite(parsed)) {
      continue;
    }
    const normalized = Math.max(0, Math.min(600, Math.round(parsed)));
    if (!output.includes(normalized)) {
      output.push(normalized);
    }
  }
  output.sort((left, right) => left - right);
  if (output.length > 48) {
    return output.slice(0, 48);
  }
  if (output.length === 0) {
    return buildTimingBurstOffsets(
      550,
      DEFAULT_FIRE_OPTIONS.timingStartPct,
      DEFAULT_FIRE_OPTIONS.timingEndPct,
      DEFAULT_FIRE_OPTIONS.timingIntervalMs,
      DEFAULT_FIRE_OPTIONS.timingMultiplier
    );
  }
  return output;
}

function offsetsEqual(left: number[], right: number[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((value, index) => value === right[index]);
}
