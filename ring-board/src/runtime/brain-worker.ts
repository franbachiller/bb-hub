import path from "node:path";
import { fileURLToPath } from "node:url";
import { parentPort } from "node:worker_threads";
import type { BrainMode, FireControlOptions, ServerStateSnapshot } from "../shared/protocol.js";
import { predictWindowForEntities, ringTargetDistance } from "../solver/contact-solver.js";
import { MoveController } from "../solver/move-controller.js";
import { TileBrain } from "../solver/tile-brain.js";
import { FinalsBrain } from "../solver/finals-brain.js";
import { Interceptor, type InterceptorParams } from "../solver/interceptor.js";
import { FireController } from "../solver/fire-controller.js";
import { BrainController } from "../solver/brain-controller.js";
import { OpponentMemoryStore } from "../store/opponent-memory.js";
import type { BrainWorkerRequest, BrainWorkerResponse } from "./brain-worker-protocol.js";
import { resolveFocusResolution } from "./engagement-resolver.js";
import { ResolveStandbyTracker } from "./resolve-standby.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..", "..");
const memoryFile = path.join(rootDir, "data", "opponent-memory.json");
const DEFAULT_TIMING_START_PCT = 79;
const DEFAULT_TIMING_END_PCT = 100;
const DEFAULT_TIMING_INTERVAL_MS = 33;
const DEFAULT_TIMING_MULTIPLIER = 1;
const DEFAULT_HIGH_POWER = false;
const TARGET_LOCK_HOLD_MS = 180;
const LOCAL_TARGET_RING_MAX = 5.4;
const LOCAL_TARGET_CHEB_MAX = 5.1;
const TARGET_KEEP_RING_EPS = 0.24;
const TARGET_KEEP_CHEB_EPS = 0.45;
const IMMEDIATE_THREAT_RING_MAX = 5.4;
const IMMEDIATE_THREAT_HOT_ETA = 112;
const IMMEDIATE_THREAT_CHEB_MAX = 4.8;
const IMMEDIATE_TARGET_LOCK_HOLD_MS = 132;
const IMMEDIATE_SWITCH_RING_MARGIN = 0.9;
const IMMEDIATE_SWITCH_HOT_ETA_MARGIN = 24;
const COMMITTED_TARGET_HOLD_MS = 420;
const COMMITTED_TARGET_ATTACK_HOLD_MS = 320;
const COMMITTED_TARGET_KEEP_RING_MAX = 6.35;
const COMMITTED_TARGET_SWITCH_RING_MARGIN = 0.34;
const COMMITTED_TARGET_SWITCH_HOT_ETA_MARGIN = 12;
const PRIMARY_LOCAL_RING_MAX = 4.85;
const PRIMARY_LOCAL_HOT_ETA_MAX = 148;
const SWARM_THREAT_COUNT = 2;
const SWARM_ATTACKER_COUNT = 2;
const SWARM_TARGET_LOCK_HOLD_MS = 84;
const SWARM_COMMITTED_HOLD_MS = 148;
const SWARM_COMMITTED_ATTACK_HOLD_MS = 124;
const SWARM_SWITCH_RING_MARGIN = 0.32;
const SWARM_SWITCH_HOT_ETA_MARGIN = 14;
const SWARM_KEEP_RING_MAX = 4.45;

const memory = new OpponentMemoryStore(memoryFile);
memory.loadSync();
const resolveStandbyTracker = new ResolveStandbyTracker();

const moveController = new MoveController();
// Movement: the tile brain (the ring as a board, one step per tick). The old
// MoveController re-planned modes every few ms and walked in circles.
const tileBrain = new TileBrain();
// Sim only: the tile brain with the live odds after the tick-boundary fix (27/09).
const tileBrainPost = new TileBrain("post");
const tileBrainAttack = new TileBrain("attack");
const USE_TILE_BRAIN = false;
// The simulator (sim/) may ask for the tile brain per request; the live Hub never sends this.
let simTileBrain = false;
let simTileVariant: "base" | "post" | "attack" = "base";
// Sim only: tile brains with a given aggression (fireOptions.simTileKill "a" or "a,b,c").
let simTileKill = "";
const simTileBrains = new Map<string, TileBrain>();
// Finals brain (1v1 at the end of a ring): off live until it beats the planner in
// the simulator and the user approves it. simFinalsBrain plans with no time cap.
const finalsBrain = new FinalsBrain();
const USE_FINALS_BRAIN = true; // user 27/09: finals 69% vs 47% (old) in the simulator
const FINALS_BUDGET_MS = 4;
// The simulator sets it per request (true / false); the live Hub never sends it.
let simFinalsBrain: boolean | undefined;
// Interceptor overlay on the planner's step (whole round): simulator only for now.
const USE_INTERCEPTOR = false; // gym 27/09: k/d 1.43 vs 1.49 without it (old + finals)
let interceptor = new Interceptor();
let interceptorKey = "";
let simInterceptor: InterceptorParams | false | undefined;
const fireController = new FireController();
const brainController = new BrainController(memory);
let lastRoundKey = "";
let targetLockId = -1;
let targetLockUntilTs = 0;
let committedTargetId = -1;
let committedTargetUntilTs = 0;
let currentFireOptions: FireControlOptions = {
  moveBrain: "planner",
  highPower: DEFAULT_HIGH_POWER,
  moveAssist: false,
  stepCadenceAlways: false,
  pulseClick: false,
  initiativeStrike: false,
  timingStartPct: DEFAULT_TIMING_START_PCT,
  timingEndPct: DEFAULT_TIMING_END_PCT,
  timingIntervalMs: DEFAULT_TIMING_INTERVAL_MS,
  timingMultiplier: DEFAULT_TIMING_MULTIPLIER
};

parentPort?.on("message", (message: BrainWorkerRequest) => {
  if (message.type === "reset") {
    resetAll(message.clearSessionMemory ?? false);
    return;
  }
  const wantBrain = message.fireOptions?.moveBrain;
  currentFireOptions = {
    moveBrain: wantBrain === "tile" || wantBrain === "tile2" || wantBrain === "tile3" ? wantBrain : "planner",
    highPower: Boolean(message.fireOptions?.highPower),
    moveAssist: Boolean(message.fireOptions?.moveAssist),
    stepCadenceAlways: Boolean(message.fireOptions?.stepCadenceAlways),
    pulseClick: Boolean(message.fireOptions?.pulseClick),
    initiativeStrike: Boolean(message.fireOptions?.initiativeStrike),
    timingStartPct: clampInt(message.fireOptions?.timingStartPct, 40, 99, DEFAULT_TIMING_START_PCT),
    timingEndPct: clampInt(message.fireOptions?.timingEndPct, 41, 100, DEFAULT_TIMING_END_PCT),
    timingIntervalMs: clampInt(message.fireOptions?.timingIntervalMs, 1, 200, DEFAULT_TIMING_INTERVAL_MS),
    timingMultiplier: clampInt(message.fireOptions?.timingMultiplier, 1, 4, DEFAULT_TIMING_MULTIPLIER)
  };
  if (currentFireOptions.timingEndPct <= currentFireOptions.timingStartPct) {
    currentFireOptions.timingEndPct = Math.min(100, currentFireOptions.timingStartPct + 1);
  }
  if (currentFireOptions.pulseClick) {
    currentFireOptions.stepCadenceAlways = false;
  }
  simTileBrain = Boolean((message.fireOptions as { simTileBrain?: boolean } | undefined)?.simTileBrain);
  const simVar = (message.fireOptions as { simTileVariant?: string } | undefined)?.simTileVariant;
  simTileVariant = simVar === "post" ? "post" : simVar === "attack" ? "attack" : "base";
  simTileKill = String((message.fireOptions as { simTileKill?: string } | undefined)?.simTileKill ?? "");
  simFinalsBrain = (message.fireOptions as { simFinalsBrain?: boolean } | undefined)?.simFinalsBrain;
  simInterceptor = (message.fireOptions as { simInterceptor?: InterceptorParams | false } | undefined)?.simInterceptor;
  if (simInterceptor && JSON.stringify(simInterceptor) !== interceptorKey) {
    interceptorKey = JSON.stringify(simInterceptor);
    interceptor = new Interceptor(simInterceptor);
  }

  const response = evaluate(message.seq, message.epoch, message.snapshot);
  parentPort?.postMessage(response as BrainWorkerResponse);
});

function evaluate(seq: number, epoch: number, snapshot: ServerStateSnapshot): BrainWorkerResponse {
  const trackedSnapshot = resolveStandbyTracker.decorate(snapshot);
  const roundKey = `${snapshot.round.roundId}:${snapshot.round.sceneHash ?? ""}`;
  if (trackedSnapshot.round.phase === "LIVE" && roundKey !== lastRoundKey) {
    brainController.reset();
    moveController.reset();
    fireController.reset();
    resolveStandbyTracker.reset();
    committedTargetId = -1;
    committedTargetUntilTs = 0;
    lastRoundKey = roundKey;
  } else if (trackedSnapshot.round.phase !== "LIVE") {
    moveController.reset();
    fireController.reset();
    resolveStandbyTracker.reset();
    committedTargetId = -1;
    committedTargetUntilTs = 0;
  }

  const activeSnapshot = resolveStandbyTracker.decorate(trackedSnapshot);
  const self = activeSnapshot.entities.find((entity) => entity.isSelf) ?? null;
  const nowWall = Date.now();
  const fireModeActive = currentFireOptions.stepCadenceAlways || currentFireOptions.pulseClick;
  if (!currentFireOptions.moveAssist && !fireModeActive) {
    const manualTarget = self ? findValidCombatTarget(activeSnapshot, self, activeSnapshot.targetId) : null;
    const focusedWindow =
      self && manualTarget
        ? predictWindowForEntities(self, manualTarget, activeSnapshot.nowTs)
        : null;
    const withManualTarget: ServerStateSnapshot = {
      ...activeSnapshot,
      targetId: manualTarget?.id ?? -1,
      window: focusedWindow,
      brain: null
    };
    const finalSnapshot: ServerStateSnapshot = {
      ...withManualTarget
    };
    const fire = fireController.evaluate(finalSnapshot, nowWall, currentFireOptions);
    return {
      type: "result",
      seq,
      epoch,
      snapshot: {
        ...finalSnapshot,
        lastFire: fire ?? finalSnapshot.lastFire
      },
      move: null,
      fire
    };
  }

  const focus = resolveFocusResolution(activeSnapshot);
  const immediateThreat = resolveImmediateThreatTarget(
    self,
    activeSnapshot.entities,
    activeSnapshot.nowTs,
    focus.attackerTargetId,
    activeSnapshot.targetId,
    targetLockId
  );
  const nearestTarget = resolveNearestTargetChoice(
    self,
    activeSnapshot.entities,
    activeSnapshot.nowTs,
    immediateThreat?.entity.id ?? focus.attackerTargetId,
    targetLockId
  );
  const nearestTargetId = immediateThreat?.entity.id ?? nearestTarget?.entity.id ?? -1;
  const fallbackTargetId = resolveFallbackTargetId(
    self,
    activeSnapshot.entities,
    activeSnapshot.nowTs,
    nearestTargetId >= 0 ? nearestTargetId : snapshot.targetId,
    nearestTargetId >= 0 ? nearestTargetId : (focus.attackerTargetId >= 0 ? focus.attackerTargetId : focus.focusTargetId),
    targetLockId
  );
  const bestWindow =
    self && (immediateThreat?.entity ?? nearestTarget?.entity)
      ? predictWindowForEntities(self, (immediateThreat?.entity ?? nearestTarget!.entity), activeSnapshot.nowTs)
      : focus.preferredWindow;

  const preliminary: ServerStateSnapshot = {
    ...activeSnapshot,
    targetId: fallbackTargetId,
    window: bestWindow,
    brain: null
  };

  const brain = brainController.decide(preliminary);
  const effectiveBrain = currentFireOptions.initiativeStrike
    ? applyInitiativeStrikeBrain(snapshot, self, brain, focus)
    : brain;
  const rawTargetId =
    effectiveBrain && effectiveBrain.targetId >= 0
      ? effectiveBrain.targetId
      : nearestTargetId >= 0
        ? nearestTargetId
        : bestWindow?.targetId ?? fallbackTargetId;
  const targetId = stabilizeTargetId(
    activeSnapshot,
    self,
    rawTargetId,
    focus,
    rawTargetId,
    targetLockId,
    immediateThreat?.entity.id ?? -1
  );
  const targetEntity =
    self && targetId >= 0
      ? snapshot.entities.find((entity) => entity.id === targetId) ?? null
      : null;
  const focusedWindow =
    self && targetEntity
      ? predictWindowForEntities(self, targetEntity, activeSnapshot.nowTs)
      : bestWindow;
  const coercedBrain = coerceImmediateThreatBrain(
    snapshot,
    self,
    effectiveBrain,
    focus,
    targetEntity,
    focusedWindow
  );
  const unifiedBrain = coercedBrain
    ? {
        ...coercedBrain,
        targetId,
        anchorTargetId: targetId,
        committedTargetId: targetId,
        strikeTargetId: targetId,
        threatOverrideId: targetId,
        targetReason: coercedBrain.targetReason ?? "COMMITTED"
      }
    : coercedBrain;

  const withBrain: ServerStateSnapshot = {
    ...activeSnapshot,
    targetId,
    window: focusedWindow ?? bestWindow,
    brain: unifiedBrain
  };

  // Movement: the ring-board's own planner (the 69-47 one). The tile brain stays
  // off until it beats this planner in the simulator (user 27/09).
  const finals =
    currentFireOptions.moveAssist && (simFinalsBrain ?? USE_FINALS_BRAIN)
      ? finalsBrain.evaluate(withBrain, simFinalsBrain ? Infinity : FINALS_BUDGET_MS)
      : null;
  const move = currentFireOptions.moveAssist
    ? finals?.active
      ? finals.move
      : USE_TILE_BRAIN || simTileBrain || currentFireOptions.moveBrain !== "planner"
      ? (simTileBrain && simTileKill ? simTileBrainFor(simTileVariant, simTileKill)
        : (simTileBrain ? simTileVariant === "attack" : currentFireOptions.moveBrain === "tile3") ? tileBrainAttack
        : (simTileBrain ? simTileVariant === "post" : currentFireOptions.moveBrain === "tile2") ? tileBrainPost : tileBrain).evaluate(withBrain)
      : (simInterceptor ?? USE_INTERCEPTOR)
      ? interceptor.apply(withBrain, moveController.evaluate(withBrain, nowWall, { highPower: currentFireOptions.highPower }))
      : moveController.evaluate(withBrain, nowWall, { highPower: currentFireOptions.highPower })
    : null;
  const finalSnapshot: ServerStateSnapshot = {
    ...withBrain
  };
  const fire = fireController.evaluate(finalSnapshot, nowWall, currentFireOptions);

  return {
    type: "result",
    seq,
    epoch,
    snapshot: {
      ...finalSnapshot,
      lastFire: fire ?? finalSnapshot.lastFire
    },
    move,
    fire
  };
}

function coerceImmediateThreatBrain(
  snapshot: ServerStateSnapshot,
  self: ServerStateSnapshot["entities"][number] | null,
  brain: ServerStateSnapshot["brain"],
  focus: ReturnType<typeof resolveFocusResolution>,
  targetEntity: ServerStateSnapshot["entities"][number] | null,
  focusedWindow: ReturnType<typeof predictWindowForEntities> | null
): ServerStateSnapshot["brain"] {
  if (!brain || !self || !targetEntity) {
    return brain;
  }

  const urgentAttacker = focus.attackerTargetId >= 0 && targetEntity.id === focus.attackerTargetId;
  const localThreat = focus.localThreatCount > 0 && focus.engagedIds.includes(targetEntity.id);
  if (!urgentAttacker && !localThreat) {
    return brain;
  }

  const distance = chebyshev(self, targetEntity);
  const bestAt = focusedWindow?.bestAt ?? 999;
  const forcedMode =
    focus.localThreatCount >= 3 && bestAt > 52 && distance > 3.8
      ? "EVADE"
      : bestAt <= 108 || distance <= 5.2
        ? "COMMIT"
        : "INTERCEPT";

  if (
    brain.targetId === targetEntity.id &&
    (
      brain.mode === forcedMode ||
      (forcedMode === "INTERCEPT" && brain.mode === "COMMIT") ||
      (forcedMode === "COMMIT" && brain.mode === "PUNISH")
    )
  ) {
    return brain;
  }

  return {
    ...brain,
    mode: forcedMode,
    reason: `AWARE_${forcedMode}_${brain.reason}`,
    targetId: targetEntity.id,
    anchorTargetId: targetEntity.id,
    timingConfidence: Math.max(brain.timingConfidence, focusedWindow?.confidence ?? 0.52),
    score: round2(brain.score + 1.7),
    planScore: round2(brain.planScore + 1.5)
  };
}

function resolveFallbackTargetId(
  self: ServerStateSnapshot["entities"][number] | null,
  entities: ServerStateSnapshot["entities"],
  nowTs: number,
  selectedTargetId: number,
  focusTargetId: number,
  heldTargetId: number
): number {
  if (
    focusTargetId >= 0 &&
    entities.some((entity) => entity.id === focusTargetId)
  ) {
    return focusTargetId;
  }
  if (!self) {
    return -1;
  }

  const nearest = resolveNearestTargetChoice(self, entities, nowTs, focusTargetId, heldTargetId);
  if (nearest) {
    return nearest.entity.id;
  }

  const selfId = self.id;
  if (
    selectedTargetId >= 0 &&
    selectedTargetId !== selfId
  ) {
    const selected = entities.find((entity) => entity.id === selectedTargetId) ?? null;
    if (selected && isValidFallbackTarget(self, selected) && chebyshev(self, selected) <= 6.4) {
      return selectedTargetId;
    }
  }

  let bestId = -1;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const entity of entities) {
    if (!isValidFallbackTarget(self, entity)) {
      continue;
    }
    const dx = entity.x - self.x;
    const dy = entity.y - self.y;
    const dist = dx * dx + dy * dy;
    if (dist < bestDist) {
      bestDist = dist;
      bestId = entity.id;
    }
  }
  return bestId;
}

function resetAll(clearSessionMemory: boolean): void {
  lastRoundKey = "";
  targetLockId = -1;
  targetLockUntilTs = 0;
  committedTargetId = -1;
  committedTargetUntilTs = 0;
  resolveStandbyTracker.reset();
  brainController.reset();
  moveController.reset();
  tileBrain.reset();
  tileBrainPost.reset();
  tileBrainAttack.reset();
  for (const b of simTileBrains.values()) b.reset();
  finalsBrain.reset();
  interceptor.reset();
  fireController.reset();
  if (clearSessionMemory) {
    memory.saveSync();
  }
}

function chebyshev(left: { x: number; y: number }, right: { x: number; y: number }): number {
  return Math.max(Math.abs(left.x - right.x), Math.abs(left.y - right.y));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function stabilizeTargetId(
  snapshot: ServerStateSnapshot,
  self: ServerStateSnapshot["entities"][number] | null,
  fallbackTargetId: number,
  focus: ReturnType<typeof resolveFocusResolution>,
  preferredTargetId: number,
  heldTargetId: number,
  immediateThreatId: number
): number {
  if (!self) {
    return preferredTargetId;
  }

  const swarmPressure = isSwarmPressure(focus);
  const tuning = snapshot.adaptiveTuning;
  const controllerEntity =
    findValidCombatTarget(snapshot, self, preferredTargetId) ??
    findValidCombatTarget(snapshot, self, fallbackTargetId);
  const absoluteNearest = resolveNearestTargetChoice(
    self,
    snapshot.entities,
    snapshot.nowTs,
    focus.attackerTargetId,
    heldTargetId
  );
  const immediateThreat = findValidCombatTarget(snapshot, self, immediateThreatId);
  const committedEntity = findValidCombatTarget(snapshot, self, committedTargetId);
  const nearestOverride =
    absoluteNearest && shouldForceNearestTarget(snapshot, self, absoluteNearest, focus)
      ? absoluteNearest.entity
      : null;
  const localOverride = immediateThreat ?? nearestOverride;
  const preferredChallenger = localOverride ?? controllerEntity ?? absoluteNearest?.entity ?? null;

  if (committedEntity && shouldKeepCommittedTarget(snapshot, self, committedEntity, preferredChallenger, focus)) {
    targetLockId = committedEntity.id;
    targetLockUntilTs = Math.max(targetLockUntilTs, snapshot.nowTs + scaleHoldMs(TARGET_LOCK_HOLD_MS, tuning));
    committedTargetUntilTs = Math.max(
      committedTargetUntilTs,
      snapshot.nowTs + scaleHoldMs(swarmPressure ? 124 : 164, tuning)
    );
    return committedEntity.id;
  }

  const nextEntity = localOverride ?? controllerEntity ?? absoluteNearest?.entity ?? committedEntity ?? null;
  if (!nextEntity) {
    targetLockId = -1;
    targetLockUntilTs = 0;
    committedTargetId = -1;
    committedTargetUntilTs = 0;
    return -1;
  }

  rememberCommittedTarget(
    snapshot,
    self,
    nextEntity.id,
    nextEntity.id === immediateThreat?.id || nextEntity.id === focus.attackerTargetId,
    swarmPressure
  );
  return nextEntity.id;
}

interface CommitTargetEval {
  entity: ServerStateSnapshot["entities"][number];
  ringDist: number;
  cheb: number;
  hotEta: number;
  toward: number;
  recentAggressor: boolean;
  selected: boolean;
  held: boolean;
  engaged: boolean;
  passiveCorner: boolean;
}

function resolvePrimaryLocalTarget(
  snapshot: ServerStateSnapshot,
  self: ServerStateSnapshot["entities"][number],
  focus: ReturnType<typeof resolveFocusResolution>,
  preferredTargetId: number,
  heldTargetId: number
): ServerStateSnapshot["entities"][number] | null {
  const candidates = snapshot.entities
    .filter((entity) => isValidFallbackTarget(self, entity))
    .map((entity) => {
      const ringDist = ringTargetDistance(self, entity);
      const cheb = chebyshev(self, entity);
      const hotEta = predictWindowForEntities(self, entity, snapshot.nowTs)?.bestAt ?? 999;
      const toward = movementTowardSelf(self, entity);
      const recentAggressor = entity.id === focus.attackerTargetId;
      const selected = entity.id === preferredTargetId;
      const held = entity.id === heldTargetId || entity.id === committedTargetId;
      const passiveCorner = isPassiveCornerTarget(snapshot.scene, entity);
      const stationaryLocal =
        !entity.moving &&
        (
          recentAggressor ||
          selected ||
          held ||
          ringDist <= 3.45 ||
          hotEta <= 108
        );
      const engaged =
        recentAggressor ||
        (entity.moving && ringDist <= 4.7) ||
        stationaryLocal ||
        hotEta <= PRIMARY_LOCAL_HOT_ETA_MAX ||
        toward >= 0.16 ||
        selected ||
        held;
      return {
        entity,
        ringDist,
        cheb,
        hotEta,
        toward,
        recentAggressor,
        selected,
        held,
        engaged,
        passiveCorner
      };
    })
    .filter(
      (candidate) =>
        candidate.engaged &&
        (candidate.ringDist <= PRIMARY_LOCAL_RING_MAX || candidate.cheb <= 2.8 || candidate.recentAggressor)
    );

  if (candidates.length === 0) {
    return null;
  }

  const held = candidates.find((candidate) => candidate.held) ?? null;
  const swarmPressure = isSwarmPressure(focus);
  const best = [...candidates].sort(
    (left, right) =>
      Number(right.recentAggressor) - Number(left.recentAggressor) ||
      left.ringDist - right.ringDist ||
      left.cheb - right.cheb ||
      left.hotEta - right.hotEta ||
      right.toward - left.toward ||
      Number(right.entity.moving) - Number(left.entity.moving) ||
      Number(right.selected) - Number(left.selected) ||
      Number(right.held) - Number(left.held) ||
      Number(left.passiveCorner) - Number(right.passiveCorner) ||
      left.entity.id - right.entity.id
  )[0] ?? null;

  if (!best) {
    return null;
  }

  if (held && snapshot.nowTs < committedTargetUntilTs) {
    const switchRingMargin = swarmPressure ? 0.12 : 0.28;
    const switchHotEtaMargin = swarmPressure ? 6 : 12;
    const bestClearlyCloser = best.ringDist + switchRingMargin < held.ringDist;
    const bestClearlyEarlier = best.hotEta + switchHotEtaMargin < held.hotEta && best.ringDist <= held.ringDist + 0.22;
    const bestAttackerOverride = best.recentAggressor && !held.recentAggressor;
    const bestSwarmOverride =
      swarmPressure &&
      (
        (best.recentAggressor && held.ringDist > best.ringDist + 0.08) ||
        (best.ringDist <= 3.45 && held.ringDist > best.ringDist + 0.12) ||
        (best.hotEta + 8 < held.hotEta && best.ringDist <= held.ringDist + 0.18)
      );
    const heldStillGood =
      held.recentAggressor ||
      held.ringDist <= (swarmPressure ? 3.75 : 4.45) ||
      held.hotEta <= (swarmPressure ? 108 : 146) ||
      held.toward >= 0.12;
    if (
      heldStillGood &&
      !bestAttackerOverride &&
      !bestSwarmOverride &&
      !bestClearlyCloser &&
      !bestClearlyEarlier
    ) {
      return held.entity;
    }
  }

  return best.entity;
}

function rememberCommittedTarget(
  snapshot: ServerStateSnapshot,
  self: ServerStateSnapshot["entities"][number],
  targetId: number,
  attackOverride: boolean,
  swarmPressure = false
): void {
  const entity = findValidCombatTarget(snapshot, self, targetId);
  if (!entity) {
    return;
  }
  const tuning = snapshot.adaptiveTuning;
  committedTargetId = entity.id;
  committedTargetUntilTs = snapshot.nowTs + scaleHoldMs(
    attackOverride
      ? (swarmPressure ? SWARM_COMMITTED_ATTACK_HOLD_MS : COMMITTED_TARGET_ATTACK_HOLD_MS)
      : (swarmPressure ? SWARM_COMMITTED_HOLD_MS : COMMITTED_TARGET_HOLD_MS),
    tuning
  );
  targetLockId = entity.id;
  targetLockUntilTs = snapshot.nowTs + scaleHoldMs(
    swarmPressure
      ? SWARM_TARGET_LOCK_HOLD_MS
      : (attackOverride ? IMMEDIATE_TARGET_LOCK_HOLD_MS : TARGET_LOCK_HOLD_MS),
    tuning
  );
}

function resolveCommitAcquisitionTarget(
  snapshot: ServerStateSnapshot,
  self: ServerStateSnapshot["entities"][number],
  focus: ReturnType<typeof resolveFocusResolution>,
  preferredTargetId: number,
  fallbackTargetId: number,
  heldTargetId: number
): ServerStateSnapshot["entities"][number] | null {
  const candidates = snapshot.entities
    .filter((entity) => isValidFallbackTarget(self, entity))
    .map((entity) => evaluateCommitCandidate(snapshot, self, entity, focus, preferredTargetId, fallbackTargetId, heldTargetId));

  if (candidates.length === 0) {
    return null;
  }

  const liveLocal = candidates.filter(
    (candidate) =>
      candidate.recentAggressor ||
      candidate.engaged ||
      candidate.ringDist <= 5.6 ||
      candidate.hotEta <= 176 ||
      candidate.toward >= 0.18
  );
  const activeLocal = liveLocal.filter(
    (candidate) =>
      !candidate.passiveCorner ||
      candidate.recentAggressor ||
      candidate.ringDist <= 4.9
  );
  const nonPassive = candidates.filter((candidate) => !candidate.passiveCorner);
  const pool =
    activeLocal.length > 0 ? activeLocal :
    liveLocal.length > 0 ? liveLocal :
    nonPassive.length > 0 ? nonPassive :
    candidates;

  return pool
    .sort(
      (left, right) =>
        scoreCommitCandidate(right) - scoreCommitCandidate(left) ||
        Number(right.entity.moving) - Number(left.entity.moving) ||
        left.ringDist - right.ringDist ||
        left.hotEta - right.hotEta ||
        left.entity.id - right.entity.id
    )[0]?.entity ?? null;
}

function evaluateCommitCandidate(
  snapshot: ServerStateSnapshot,
  self: ServerStateSnapshot["entities"][number],
  entity: ServerStateSnapshot["entities"][number],
  focus: ReturnType<typeof resolveFocusResolution>,
  preferredTargetId: number,
  fallbackTargetId: number,
  heldTargetId: number
): CommitTargetEval {
  const ringDist = ringTargetDistance(self, entity);
  const cheb = chebyshev(self, entity);
  const hotEta = predictWindowForEntities(self, entity, snapshot.nowTs)?.bestAt ?? 999;
  const toward = movementTowardSelf(self, entity);
  const recentAggressor = entity.id === focus.attackerTargetId;
  const selected = entity.id === preferredTargetId || entity.id === fallbackTargetId;
  const held = entity.id === heldTargetId || entity.id === committedTargetId;
  const passiveCorner = isPassiveCornerTarget(snapshot.scene, entity);
  const stationaryLocal =
    !entity.moving &&
    (
      recentAggressor ||
      selected ||
      held ||
      ringDist <= 3.45 ||
      hotEta <= 108
    );
  const engaged =
    focus.engagedIds.includes(entity.id) ||
    recentAggressor ||
    (entity.moving && ringDist <= 4.9) ||
    stationaryLocal ||
    hotEta <= 156 ||
    toward >= 0.22;
  return {
    entity,
    ringDist,
    cheb,
    hotEta,
    toward,
    recentAggressor,
    selected,
    held,
    engaged,
    passiveCorner
  };
}

function scoreCommitCandidate(candidate: CommitTargetEval): number {
  let score = 0;
  score += candidate.recentAggressor ? 12 : 0;
  score += candidate.engaged ? 7.5 : 0;
  score += candidate.held ? 2.4 : 0;
  score += candidate.selected ? 1.4 : 0;
  score += Math.max(0, 7 - candidate.ringDist) * 3.1;
  score += Math.max(0, 5 - candidate.cheb) * 1.05;
  score += Math.max(0, 170 - candidate.hotEta) * 0.038;
  score += Math.max(0, candidate.toward) * 3.8;
  score += candidate.entity.moving ? 2.4 : -1.2;
  score -= candidate.passiveCorner ? 10.4 : 0;
  if (candidate.passiveCorner && candidate.ringDist <= 4.8) {
    score += 1.1;
  }
  return score;
}

function shouldKeepCommittedTarget(
  snapshot: ServerStateSnapshot,
  self: ServerStateSnapshot["entities"][number],
  current: ServerStateSnapshot["entities"][number],
  challenger: ServerStateSnapshot["entities"][number] | null,
  focus: ReturnType<typeof resolveFocusResolution>
): boolean {
  const switchMargin = clampAdaptive(snapshot.adaptiveTuning?.switchBias ?? 0, -0.6, 0.6);
  const currentRingDist = ringTargetDistance(self, current);
  const currentHotEta = predictWindowForEntities(self, current, snapshot.nowTs)?.bestAt ?? 999;
  const currentRecentAggressor = current.id === focus.attackerTargetId;
  const currentPassiveCorner = isPassiveCornerTarget(snapshot.scene, current);
  const swarmPressure = isSwarmPressure(focus);
  const currentStillGood =
    currentRecentAggressor ||
    currentRingDist <= (swarmPressure ? 3.95 : 4.75) ||
    currentHotEta <= (swarmPressure ? 112 : 148) ||
    movementTowardSelf(self, current) >= 0.16;

  if (!challenger || challenger.id === current.id) {
    return currentRingDist <= (swarmPressure ? SWARM_KEEP_RING_MAX : COMMITTED_TARGET_KEEP_RING_MAX);
  }

  const challengerRingDist = ringTargetDistance(self, challenger);
  const challengerHotEta = predictWindowForEntities(self, challenger, snapshot.nowTs)?.bestAt ?? 999;
  const challengerRecentAggressor = challenger.id === focus.attackerTargetId;
  const challengerPassiveCorner = isPassiveCornerTarget(snapshot.scene, challenger);
  const challengerClearlyCloser =
    challengerRingDist + (swarmPressure ? SWARM_SWITCH_RING_MARGIN : COMMITTED_TARGET_SWITCH_RING_MARGIN) + switchMargin * 0.18 < currentRingDist;
  const challengerClearlyEarlier =
    challengerHotEta + (swarmPressure ? SWARM_SWITCH_HOT_ETA_MARGIN : COMMITTED_TARGET_SWITCH_HOT_ETA_MARGIN) + Math.round(switchMargin * 5) < currentHotEta &&
    challengerRingDist <= currentRingDist + 0.2;
  const challengerLocalPriority =
    challengerRingDist <= (swarmPressure ? 3.8 : 4.2) &&
    (
      challengerRecentAggressor ||
      challengerHotEta <= (swarmPressure ? 76 : 96) ||
      movementTowardSelf(self, challenger) >= 0.28
    ) &&
    currentRingDist > challengerRingDist + (swarmPressure ? 0.1 : 0.22);
  const challengerSwarmOverride =
    swarmPressure &&
    (
      (challengerRecentAggressor && !currentRecentAggressor) ||
      (challengerRingDist <= 3.5 && currentRingDist > challengerRingDist + 0.12) ||
      (challengerHotEta + 8 < currentHotEta && challengerRingDist <= currentRingDist + 0.18)
    );

  if (challengerRecentAggressor && !currentRecentAggressor) {
    return false;
  }
  if (challengerRingDist <= 3.6 && currentRingDist > challengerRingDist + 0.08 && !currentRecentAggressor) {
    return false;
  }
  if (current.id === challenger.id) {
    return true;
  }
  if (snapshot.nowTs < committedTargetUntilTs) {
    if (
      currentStillGood &&
      !challengerClearlyCloser &&
      !challengerClearlyEarlier &&
      !challengerLocalPriority &&
      !challengerSwarmOverride
    ) {
      return true;
    }
  }
  if (currentStillGood && !currentPassiveCorner && challengerPassiveCorner) {
    return true;
  }
  if (currentPassiveCorner && !challengerPassiveCorner && challengerRingDist <= currentRingDist + 0.8) {
    return false;
  }
  if (currentRingDist > (swarmPressure ? SWARM_KEEP_RING_MAX : COMMITTED_TARGET_KEEP_RING_MAX)) {
    return false;
  }
  return currentStillGood && !challengerClearlyCloser && !challengerClearlyEarlier && !challengerLocalPriority && !challengerSwarmOverride;
}

interface ImmediateThreatChoice {
  entity: ServerStateSnapshot["entities"][number];
  ringDist: number;
  cheb: number;
  hotEta: number;
  toward: number;
  recentAggressor: boolean;
  selected: boolean;
  held: boolean;
}

function resolveImmediateThreatTarget(
  self: ServerStateSnapshot["entities"][number] | null,
  entities: ServerStateSnapshot["entities"],
  nowTs: number,
  recentAggressorId: number,
  selectedTargetId: number,
  heldTargetId: number
): ImmediateThreatChoice | null {
  if (!self) {
    return null;
  }

  const candidates = entities
    .filter((entity) => isValidFallbackTarget(self, entity))
    .map((entity) => {
      const ringDist = ringTargetDistance(self, entity);
      const cheb = chebyshev(self, entity);
      const hotEta = predictWindowForEntities(self, entity, nowTs)?.bestAt ?? 999;
      const toward = movementTowardSelf(self, entity);
      return {
        entity,
        ringDist,
        cheb,
        hotEta,
        toward,
        recentAggressor: entity.id === recentAggressorId,
        selected: entity.id === selectedTargetId,
        held: entity.id === heldTargetId
      };
    });

  const hardPool = candidates.filter(
    (candidate) =>
      candidate.recentAggressor ||
      candidate.ringDist <= 3.35 ||
      (candidate.ringDist <= IMMEDIATE_THREAT_RING_MAX && candidate.hotEta <= IMMEDIATE_THREAT_HOT_ETA) ||
      (candidate.cheb <= IMMEDIATE_THREAT_CHEB_MAX && candidate.toward >= 0.22)
  ).filter(
    (candidate) =>
      candidate.entity.moving ||
      candidate.recentAggressor ||
      candidate.ringDist <= 3.1 ||
      candidate.hotEta <= 86
  );
  const softPool = candidates.filter(
    (candidate) =>
      candidate.ringDist <= 4.9 ||
      candidate.cheb <= 4.2 ||
      candidate.hotEta <= 136 ||
      candidate.toward >= 0.3
  ).filter(
    (candidate) =>
      candidate.entity.moving ||
      candidate.recentAggressor ||
      candidate.ringDist <= 3.15 ||
      candidate.hotEta <= 92
  );
  const pool = hardPool.length > 0 ? hardPool : softPool;
  if (pool.length === 0) {
    return null;
  }

  const ordered = pool.sort(
    (left, right) =>
      Number(right.recentAggressor) - Number(left.recentAggressor) ||
      Number(right.entity.moving) - Number(left.entity.moving) ||
      Number(right.ringDist <= 3.2) - Number(left.ringDist <= 3.2) ||
      left.ringDist - right.ringDist ||
      left.cheb - right.cheb ||
      left.hotEta - right.hotEta ||
      right.toward - left.toward ||
      Number(right.selected) - Number(left.selected) ||
      Number(right.held) - Number(left.held) ||
      left.entity.id - right.entity.id
  );
  const best = ordered[0] ?? null;
  if (!best) {
    return null;
  }

  const held = heldTargetId >= 0 ? ordered.find((candidate) => candidate.entity.id === heldTargetId) ?? null : null;
  const lockActive = held != null && nowTs < targetLockUntilTs;
  if (!held || !lockActive) {
    return best;
  }
  const poolCrowded = pool.length >= SWARM_THREAT_COUNT;

  const heldHard =
    held.recentAggressor ||
    held.ringDist <= 3.35 ||
    (held.ringDist <= IMMEDIATE_THREAT_RING_MAX && held.hotEta <= IMMEDIATE_THREAT_HOT_ETA) ||
    (held.cheb <= IMMEDIATE_THREAT_CHEB_MAX && held.toward >= 0.22);
  const bestHard =
    best.recentAggressor ||
    best.ringDist <= 3.35 ||
    (best.ringDist <= IMMEDIATE_THREAT_RING_MAX && best.hotEta <= IMMEDIATE_THREAT_HOT_ETA) ||
    (best.cheb <= IMMEDIATE_THREAT_CHEB_MAX && best.toward >= 0.22);
  const bestClearlyCloser = best.ringDist + IMMEDIATE_SWITCH_RING_MARGIN < held.ringDist;
  const bestClearlyEarlier =
    best.hotEta + IMMEDIATE_SWITCH_HOT_ETA_MARGIN < held.hotEta &&
    best.ringDist <= held.ringDist + 0.5;
  const bestRecentOverride = best.recentAggressor && !held.recentAggressor;
  const bestCrowdedOverride =
    poolCrowded &&
    (
      (best.recentAggressor && held.ringDist > best.ringDist + 0.1) ||
      (best.ringDist <= 3.35 && held.ringDist > best.ringDist + 0.16) ||
      (best.hotEta + 10 < held.hotEta && best.ringDist <= held.ringDist + 0.25)
    );
  const heldStillGood =
    heldHard ||
    held.ringDist <= (poolCrowded ? 3.95 : 4.45) ||
    held.hotEta <= (poolCrowded ? 108 : 136) ||
    held.toward >= 0.22;

  if (
    held.entity.id === best.entity.id ||
    (
      heldStillGood &&
      !bestRecentOverride &&
      !bestClearlyCloser &&
      !bestClearlyEarlier &&
      !bestCrowdedOverride &&
      !(bestHard && !heldHard)
    )
  ) {
    return held;
  }

  return best;
}

interface NearestTargetChoice {
  entity: ServerStateSnapshot["entities"][number];
  ringDist: number;
  cheb: number;
  hotEta: number;
  toward: number;
  attackerTie: number;
}

function resolveNearestTargetChoice(
  self: ServerStateSnapshot["entities"][number] | null,
  entities: ServerStateSnapshot["entities"],
  nowTs: number,
  attackerTargetId = -1,
  heldTargetId = -1
): NearestTargetChoice | null {
  if (!self) {
    return null;
  }
  const allCandidates = entities
    .filter((entity) => isValidFallbackTarget(self, entity))
    .map((entity) => ({
      entity,
      cheb: chebyshev(self, entity),
      hotEta: predictWindowForEntities(self, entity, nowTs)?.bestAt ?? 999,
      toward: movementTowardSelf(self, entity),
      ringDist: ringTargetDistance(self, entity),
      attackerTie: entity.id === attackerTargetId ? 1 : 0
    }));
  const localPool = allCandidates.filter(
    (candidate) =>
      candidate.ringDist <= LOCAL_TARGET_RING_MAX ||
      candidate.cheb <= LOCAL_TARGET_CHEB_MAX ||
      candidate.attackerTie > 0
  );
  const pool = localPool.length > 0 ? localPool : allCandidates;
  const ordered = pool
    .sort(
      (left, right) =>
        left.ringDist - right.ringDist ||
        left.cheb - right.cheb ||
        left.hotEta - right.hotEta ||
        right.attackerTie - left.attackerTie ||
        right.toward - left.toward ||
        Number(right.entity.moving) - Number(left.entity.moving) ||
        left.entity.id - right.entity.id
    );
  const best = ordered[0] ?? null;
  if (!best) {
    return null;
  }

  const locked =
    heldTargetId >= 0 ? ordered.find((candidate) => candidate.entity.id === heldTargetId) ?? null : null;
  const lockActive = heldTargetId >= 0 && nowTs < targetLockUntilTs;
  if (
    lockActive &&
    locked &&
    (
      locked.entity.id === best.entity.id ||
      (
        locked.ringDist <= best.ringDist + 0.06 &&
        locked.cheb <= best.cheb + 0.12 &&
        locked.hotEta <= best.hotEta + 6
      )
    )
  ) {
    return locked;
  }

  return best;
}

function shouldForceNearestTarget(
  snapshot: ServerStateSnapshot,
  self: ServerStateSnapshot["entities"][number],
  nearest: NearestTargetChoice,
  focus: ReturnType<typeof resolveFocusResolution>
): boolean {
  const tuning = snapshot.adaptiveTuning;
  const switchMargin = clampAdaptive(tuning?.switchBias ?? 0, -0.6, 0.6);
  const committed = findValidCombatTarget(snapshot, self, committedTargetId);
  if (!committed) {
    return (
      nearest.ringDist <= 2.35 ||
      nearest.cheb <= 2 ||
      (focus.attackerTargetId >= 0 && nearest.entity.id === focus.attackerTargetId) ||
      (focus.localThreatCount >= 2 && nearest.ringDist <= 3.7) ||
      (nearest.hotEta <= 108 && nearest.ringDist <= 4.1)
    );
  }
  if (nearest.entity.id === committed.id) {
    return true;
  }
  const committedRing = ringTargetDistance(self, committed);
  const committedEta = predictWindowForEntities(self, committed, snapshot.nowTs)?.bestAt ?? 999;
  if (focus.attackerTargetId >= 0 && nearest.entity.id === focus.attackerTargetId && committed.id !== nearest.entity.id) {
    return nearest.ringDist <= committedRing + 0.24 - switchMargin * 0.18;
  }
  if (nearest.ringDist <= 2.2 && committedRing > nearest.ringDist + (0.22 + switchMargin * 0.14)) {
    return true;
  }
  if (focus.localThreatCount >= 2 && nearest.ringDist <= 3.55 && committedRing > nearest.ringDist + (0.26 + switchMargin * 0.14)) {
    return true;
  }
  if (nearest.hotEta <= 76 && committedEta > nearest.hotEta + 18 && nearest.ringDist <= committedRing + 0.22) {
    return true;
  }
  return (
    nearest.ringDist + (0.34 + switchMargin * 0.16) < committedRing ||
    (nearest.cheb + (0.35 + switchMargin * 0.18) < chebyshev(self, committed) && nearest.ringDist <= committedRing + 0.16) ||
    (nearest.hotEta + Math.round(16 + switchMargin * 6) < committedEta && nearest.ringDist <= committedRing + 0.2)
  );
}

function scaleHoldMs(baseMs: number, tuning: ServerStateSnapshot["adaptiveTuning"]): number {
  const holdScale = clampAdaptive(tuning?.targetHoldScale ?? 1, 0.7, 1.6);
  return Math.max(24, Math.round(baseMs * holdScale));
}

function clampAdaptive(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function findValidCombatTarget(
  snapshot: ServerStateSnapshot,
  self: ServerStateSnapshot["entities"][number],
  targetId: number
): ServerStateSnapshot["entities"][number] | null {
  if (targetId < 0) {
    return null;
  }
  const entity = snapshot.entities.find((candidate) => candidate.id === targetId) ?? null;
  if (!entity || entity.id === self.id || entity.isSelf) {
    return null;
  }
  if (entity.combatState?.busy || entity.combatState?.react) {
    return null;
  }
  if (
    entity.toX === 0 &&
    entity.toY === 0 &&
    entity.fromX === 0 &&
    entity.fromY === 0 &&
    Math.round(entity.x) === 0 &&
    Math.round(entity.y) === 0
  ) {
    return null;
  }
  return entity;
}

function isPassiveCornerTarget(
  scene: ServerStateSnapshot["scene"],
  entity: ServerStateSnapshot["entities"][number]
): boolean {
  if (!scene || entity.moving) {
    return false;
  }
  const tileX = Math.round(entity.toX || entity.x);
  const tileY = Math.round(entity.toY || entity.y);
  if (tileX < 0 || tileY < 0 || tileX >= scene.width || tileY >= scene.height) {
    return false;
  }
  const matrix = scene.walkableMatrix ?? scene.matrix;
  let degree = 0;
  const neighbors = [
    { x: tileX + 1, y: tileY },
    { x: tileX - 1, y: tileY },
    { x: tileX, y: tileY + 1 },
    { x: tileX, y: tileY - 1 }
  ];
  for (const next of neighbors) {
    if (next.x < 0 || next.y < 0 || next.x >= scene.width || next.y >= scene.height) {
      continue;
    }
    const value = matrix[next.y]?.[next.x] ?? 1;
    if (value === 0 || value === 2) {
      degree += 1;
    }
  }
  return degree <= 2;
}

function isValidFallbackTarget(
  self: ServerStateSnapshot["entities"][number],
  entity: ServerStateSnapshot["entities"][number]
): boolean {
  if (entity.id === self.id || entity.isSelf) {
    return false;
  }
  if (entity.combatState?.busy || entity.combatState?.react) {
    return false;
  }
  if (
    entity.toX === 0 &&
    entity.toY === 0 &&
    entity.fromX === 0 &&
    entity.fromY === 0 &&
    Math.round(entity.x) === 0 &&
    Math.round(entity.y) === 0
  ) {
    return false;
  }
  return true;
}

function movementTowardSelf(
  self: ServerStateSnapshot["entities"][number],
  enemy: ServerStateSnapshot["entities"][number]
): number {
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

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.round(numeric)));
}

function isSwarmPressure(focus: ReturnType<typeof resolveFocusResolution>): boolean {
  return focus.localThreatCount >= SWARM_THREAT_COUNT || focus.attackerIds.length >= SWARM_ATTACKER_COUNT;
}

function applyInitiativeStrikeBrain(
  snapshot: ServerStateSnapshot,
  self: ServerStateSnapshot["entities"][number] | null,
  brain: ServerStateSnapshot["brain"],
  focus: ReturnType<typeof resolveFocusResolution>
): ServerStateSnapshot["brain"] {
  if (!brain || !self) {
    return brain;
  }
  const passiveModes: BrainMode[] = ["STALK", "LURE", "FEINT", "CONTROL", "SEEK", "RESET"];
  if (!passiveModes.includes(brain.mode)) {
    return brain;
  }
  const targetId = brain.targetId >= 0 ? brain.targetId : focus.focusTargetId;
  if (targetId < 0) {
    return brain;
  }
  const target = snapshot.entities.find((entity) => entity.id === targetId) ?? null;
  if (!target) {
    return brain;
  }
  const window = predictWindowForEntities(self, target, snapshot.nowTs);
  const distance = chebyshev(self, target);
  const ringDist = ringTargetDistance(self, target);
  const hotContact =
    (window?.kind === "HOT" || window?.kind === "DIAG") &&
    (window?.bestAt ?? 999) <= 132;
  const closeApproach =
    distance <= 3.8 &&
    ringDist <= 3.6 &&
    (window?.bestAt ?? 999) <= 148;
  const closingHard = movementTowardSelf(self, target) >= 0.3 && ringDist <= 4.6;

  if (!hotContact && !closeApproach && !closingHard) {
    return brain;
  }

  const newMode: BrainMode =
    hotContact && distance <= 3.2
      ? "COMMIT"
      : hotContact
        ? "INTERCEPT"
        : closeApproach
          ? "INTERCEPT"
          : "CONTROL";

  return {
    ...brain,
    mode: newMode,
    reason: `STRIKE_${newMode}_${brain.reason}`,
    targetId,
    anchorTargetId: targetId,
    timingConfidence: Math.max(brain.timingConfidence, window?.confidence ?? 0.48),
    score: round2(brain.score + 1.8),
    planScore: round2(brain.planScore + 1.2)
  };
}

function simTileBrainFor(variant: "base" | "post" | "attack", kill: string): TileBrain {
  const key = `${variant}:${kill}`;
  let b = simTileBrains.get(key);
  if (!b) {
    const ag = kill.split(",").map(Number).filter((n) => Number.isFinite(n));
    b = new TileBrain(variant, ag.length ? ag : null);
    simTileBrains.set(key, b);
  }
  return b;
}
