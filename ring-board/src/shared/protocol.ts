export interface TilePoint {
  x: number;
  y: number;
}

export interface CombatState {
  state: number;
  busy: boolean;
  free: boolean;
  react: boolean;
  attack: boolean;
  frame: number;
  total: number;
  progress: number;
  anim: string;
}

export interface SceneSnapshotPayload {
  sceneHash: string;
  width: number;
  height: number;
  matrix: number[][];
  walkableMatrix: number[][];
  overlayPoints?: Array<{
    x: number;
    y: number;
    plotX: number;
    plotY: number;
    color: number;
  }>;
  projection?: {
    originX: number;
    originY: number;
    tileW: number;
    tileH: number;
  };
  blocked: TilePoint[];
  timestamp: number;
  allowed: boolean;
}

export interface EntityStatePayload {
  id: number;
  sceneId?: number;
  accountId?: number;
  name?: string;
  skinId?: number;
  member?: number;
  petId?: number;
  orientation?: number;
  isSelf: boolean;
  x: number;
  y: number;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  dirX: number;
  dirY: number;
  stepStartAt: number;
  stepDur: number;
  phase: number;
  moving: boolean;
  targetLock: boolean;
  combatState: CombatState | null;
  standbyRole?: "ATTACKER" | "DEFENDER";
  standbyUntilTs?: number;
  standbyRemainingMs?: number;
  standbyTargetId?: number;
  // Runtime: when this player's punches count again (sensor clock). Ours covers
  // the round start (4.66 s after the gong), our animation and our coco.
  lockUntilTs?: number;
  // 182 field 6 of its last step: 0 = its path goes on, 1 = that was the last step.
  walkFlag?: number;
  // Attention (runtime): its last turn (135, sensor clock; 0 = none seen), its
  // facing 1..8 (0 = unknown) and whether it stepped or turned since the room loaded.
  lastTurnTs?: number;
  facing?: number;
  active?: boolean;
}

export interface SelectionStatePayload {
  rawSelectedTarget: number;
  pendingTarget: number;
  lockedTarget: number;
  punchTarget: number;
  derivedTarget: number;
}

export interface ResolveEventPayload {
  attackerId: number;
  defenderId: number;
  winner: number;
  contested: boolean;
  targetId: number;
  timestamp: number;
  timingEnabled?: boolean;
  timingStartMs?: number;
  timingEndMs?: number;
  timingIntervalMs?: number;
  timingMultiplier?: number;
  timingClicks?: number;
  attackerStepAgeMs?: number;
  defenderStepAgeMs?: number;
  selfStepAgeMs?: number;
  targetStepAgeMs?: number;
  lastPunchAgeMs?: number;
  lastPunchTargetId?: number;
}

export interface EnvelopeBase<TType extends string, TPayload> {
  type: TType;
  ts: number;
  sceneHash: string;
  clientId?: string;
  payload: TPayload;
}

export type SceneSnapshotEnvelope = EnvelopeBase<"scene_snapshot", SceneSnapshotPayload>;
export type EntityStateEnvelope = EnvelopeBase<"entity_state", EntityStatePayload>;
export type SelectionStateEnvelope = EnvelopeBase<"selection_state", SelectionStatePayload>;
export type ResolveEventEnvelope = EnvelopeBase<"resolve_event", ResolveEventPayload>;

export type SensorEnvelope =
  | SceneSnapshotEnvelope
  | EntityStateEnvelope
  | SelectionStateEnvelope
  | ResolveEventEnvelope;

export interface BridgeHelloMessage {
  type: "bridge_hello";
  role: "swf_bridge";
  clientId?: string;
  ts: number;
}

export interface UiHelloMessage {
  type: "ui_hello";
  role: "ui";
  ts: number;
}

export interface SensorClientMessage {
  type: "sensor";
  clientId?: string;
  payload: string;
  ts: number;
}

export interface UiActionMessage {
  type: "ui_action";
  action:
    | "set_armed"
    | "set_high_power"
    | "set_move_assist"
    | "set_move_brain"
    | "set_step_cadence_always"
    | "set_pulse_click"
    | "set_timing_start_pct"
    | "set_timing_end_pct"
    | "set_timing_interval_ms"
    | "set_timing_multiplier"
    | "set_initiative_strike"
    | "set_arena_enabled"
    | "reset_arena"
    | "mark_scene_allowed"
    | "ignore_scene"
    | "reset_runtime"
    | "reset_session_memory";
  value?: boolean | number;
  sceneHash?: string;
}

export type ClientMessage =
  | BridgeHelloMessage
  | UiHelloMessage
  | SensorClientMessage
  | UiActionMessage;

export interface BridgeStatusMessage {
  type: "bridge_status";
  connected: boolean;
  moveBrain?: MoveBrain;
  clientId?: string;
  armed: boolean;
  highPower: boolean;
  moveAssist: boolean;
  stepCadenceAlways: boolean;
  pulseClick: boolean;
  initiativeStrike: boolean;
  timingStartPct: number;
  timingEndPct: number;
  timingIntervalMs: number;
  timingMultiplier: number;
  burstPreviewOffsetsMs: number[];
  allowedSceneHashes: string[];
  ignoredHashes: string[];
  arena: ArenaState;
}

export interface FireCommandMessage {
  type: "fire";
  clientId?: string;
  targetId: number;
  reason: string;
  windowId: string;
  fireAt: number;
  fireAtTs: number;
  burstOffsetsMs: number[];
  requireSelection: boolean;
  sceneHash: string;
  issuedAtTs: number;
  expiresAtTs: number;
  wallScheduled?: boolean;
}

// Live movement brain (27/09, Board selector): the planner, the tile brain, or the
// tile brain with the post-fix odds (tile2).
export type MoveBrain = "planner" | "tile" | "tile2" | "tile3";

export interface FireControlOptions {
  moveBrain?: MoveBrain;
  highPower: boolean;
  moveAssist: boolean;
  stepCadenceAlways: boolean;
  pulseClick: boolean;
  initiativeStrike: boolean;
  timingStartPct: number;
  timingEndPct: number;
  timingIntervalMs: number;
  timingMultiplier: number;
}

export interface TimingConfigCommandMessage {
  type: "timing_config";
  clientId: string;
  enabled: boolean;
  startMs: number;
  endMs: number;
  intervalMs: number;
  multiplier: number;
  clicks: number;
  reason: string;
  issuedAtTs: number;
  sceneHash?: string;
}

export interface TimingConfig {
  startPct: number;
  endPct: number;
  intervalMs: number;
}

export interface AdaptiveTuning {
  targetHoldScale: number;
  switchBias: number;
  spacingBias: number;
  commitBias: number;
  timingStartDeltaPct: number;
  timingEndDeltaPct: number;
  timingIntervalDeltaMs: number;
}

export interface MoveCommandMessage {
  type: "move";
  clientId?: string;
  targetId: number;
  reason: string;
  moveAt: number;
  sceneHash: string;
  issuedAtTs: number;
  expiresAtTs: number;
}

export interface MovePlanCommandMessage {
  type: "move_plan";
  clientId?: string;
  targetId: number;
  reason: string;
  mode: BrainState["mode"];
  moveAt: number;
  primaryTile: TilePoint;
  backupTile: TilePoint | null;
  planTiles?: TilePoint[];
  sceneHash: string;
  issuedAtTs: number;
  expiresAtTs: number;
}

export interface PredictedWindow {
  kind: "HOT" | "DIAG" | "STAGE" | "APPROACH";
  reason: string;
  targetId: number;
  sourceTargetId: number;
  startAt: number;
  bestAt: number;
  endAt: number;
  fireDelay: number;
  deltaNowX: number;
  deltaNowY: number;
  deltaFutureX: number;
  deltaFutureY: number;
  relVelX: number;
  relVelY: number;
  signX: number;
  signY: number;
  score: number;
  confidence: number;
  hypothesis: string;
  planAligned: boolean;
  widthMs: number;
}

export type BrainMode =
  | "SEEK"
  | "CONTROL"
  | "STALK"
  | "LURE"
  | "FEINT"
  | "TRAP"
  | "PUNISH"
  | "INTERCEPT"
  | "COMMIT"
  | "EVADE"
  | "RESET";

export type OpponentArchetype =
  | "camper"
  | "chaser"
  | "side-stepper"
  | "hesitant"
  | "collapser";

export interface BrainEnemyTag {
  id: number;
  archetype: OpponentArchetype;
  threat: number;
  campScore: number;
  hotEta: number;
  anchored: boolean;
}

export interface BrainState {
  mode: BrainMode;
  reason: string;
  targetId: number;
  committedTargetId?: number;
  threatOverrideId?: number;
  strikeTargetId?: number;
  targetReason?: string;
  laneState?: string;
  planIntent?: string;
  score: number;
  pressure: number;
  anchorTargetId: number;
  anchorAgeMs: number;
  switchLockedUntil: number;
  timingConfidence: number;
  threatCount: number;
  campScore: number;
  planScore: number;
  enemyTags: BrainEnemyTag[];
}

export type RoundPhase = "IDLE" | "LIVE" | "TRANSITION" | "WON" | "LOST";

export interface RoundState {
  phase: RoundPhase;
  roundId: number;
  sceneHash: string | null;
  sinceTs: number;
  liveForMs: number;
  enemyCount: number;
  selfAlive: boolean;
  summary: string;
}

export type ScenePolicyState = "allowed" | "ignored" | "unknown";

export interface ServerSceneState extends SceneSnapshotPayload {
  policy: ScenePolicyState;
}

export interface ServerStateSnapshot {
  nowTs: number;
  nowWall: number;
  frameTs: number;
  frameWall: number;
  armed: boolean;
  scene: ServerSceneState | null;
  entities: EntityStatePayload[];
  selection: SelectionStatePayload | null;
  lastResolve: ResolveEventPayload | null;
  // Last 211s of the ring, oldest first (lastResolve is only the newest).
  recentResolves?: ResolveEventPayload[];
  round: RoundState;
  targetId: number;
  window: PredictedWindow | null;
  brain: BrainState | null;
  lastFire: FireCommandMessage | null;
  clients: ArenaClientSummary[];
  arena: ArenaState;
  adaptiveTuning: AdaptiveTuning | null;
}

export interface ArenaWindowConfig {
  startMs: number;
  endMs: number;
  intervalMs: number;
  multiplier: number;
  clicks: number;
}

export interface ArenaClientSummary {
  clientId: string;
  label: string;
  sceneHash: string | null;
  selfId: number;
  accountId: number;
  name: string;
  lastSeenAgoMs: number;
  resolves: number;
  wins: number;
  losses: number;
  activeWindow: ArenaWindowConfig | null;
}

export interface ArenaWindowStats extends ArenaWindowConfig {
  samples: number;
  wins: number;
  losses: number;
  winRate: number;
  avgSelfStepAgeMs: number;
  score: number;
}

export interface ArenaState {
  enabled: boolean;
  phase: "OFF" | "WAITING" | "RUNNING";
  pair: string[];
  totalSamples: number;
  lastSampleSummary: string;
  bestWindow: ArenaWindowStats | null;
  clients: ArenaClientSummary[];
  candidates: ArenaWindowStats[];
}

export interface StateMessage {
  type: "state";
  payload: ServerStateSnapshot;
}

export type ServerMessage =
  | BridgeStatusMessage
  | FireCommandMessage
  | MoveCommandMessage
  | MovePlanCommandMessage
  | TimingConfigCommandMessage
  | StateMessage;
