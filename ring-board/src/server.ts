import express from "express";
import path from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { WebSocketServer, type WebSocket } from "ws";
import type {
  ArenaClientSummary,
  ArenaState,
  ArenaWindowConfig,
  ArenaWindowStats,
  BridgeStatusMessage,
  ClientMessage,
  FireCommandMessage,
  MoveCommandMessage,
  MovePlanCommandMessage,
  MoveBrain,
  SensorEnvelope,
  ServerStateSnapshot,
  StateMessage,
  TimingConfigCommandMessage,
  UiActionMessage
} from "./shared/protocol.js";
import { SensorStore } from "./store/sensor-store.js";
import { ScenePolicyStore } from "./store/scene-policy.js";
import { buildBoardModel } from "./store/board-model.js";
import { RoundTracker } from "./runtime/round-tracker.js";
import type { BrainWorkerRequest, BrainWorkerResponse } from "./runtime/brain-worker-protocol.js";

const WS_PORT = 18444;
const HTTP_PORT = 18445;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const publicDir = path.join(rootDir, "public");
const distDir = path.join(rootDir, "dist");
const policyFile = path.join(rootDir, "data", "scene-policy.json");

const policy = new ScenePolicyStore(policyFile);
policy.loadSync();

const sensors = new SensorStore(3000);
const roundTracker = new RoundTracker();

const app = express();
app.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  next();
});
app.use(express.static(publicDir));
app.use(express.static(distDir));
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});
app.get("/state", (_req, res) => {
  res.json(lastSnapshot);
});

const httpServer = createServer(app);
httpServer.on("error", (error) => {
  console.warn("[ring-board] HTTP server error", error);
});
httpServer.listen(HTTP_PORT, "127.0.0.1");

const wsServer = new WebSocketServer({ port: WS_PORT, host: "127.0.0.1" });
wsServer.on("error", (error) => {
  console.warn("[ring-board] WS server error", error);
});
const bridgeClients = new Set<WebSocket>();
const uiClients = new Set<WebSocket>();
const bridgeClientIds = new Map<WebSocket, string>();
const bridgeClientsById = new Map<string, Set<WebSocket>>();
const clientSensors = new Map<string, SensorStore>();
const clientTrackers = new Map<string, RoundTracker>();
const arenaClientMeta = new Map<string, ArenaClientMeta>();
const arenaAssignments = new Map<string, ArenaWindowConfig>();
const arenaLastCommandKey = new Map<string, string>();
const arenaLastCommandAt = new Map<string, number>();
const arenaSeenResolveKeys = new Set<string>();
const arenaSamples: ArenaSample[] = [];

const DEFAULT_TIMING_START_PCT = 79;
const DEFAULT_TIMING_END_PCT = 100;
const DEFAULT_TIMING_INTERVAL_MS = 33;
const DEFAULT_TIMING_MULTIPLIER = 1;
const ARENA_ROTATE_EVERY_SAMPLES = 8;
const ARENA_CLIENT_TTL_MS = 6000;
const ARENA_COMMAND_RESEND_MS = 1600;
const ARENA_CANDIDATES: ArenaWindowConfig[] = [
  { startMs: 385, endMs: 430, intervalMs: 5, multiplier: 4, clicks: 12 },
  { startMs: 413, endMs: 458, intervalMs: 5, multiplier: 4, clicks: 12 },
  { startMs: 435, endMs: 480, intervalMs: 5, multiplier: 4, clicks: 12 },
  { startMs: 455, endMs: 500, intervalMs: 5, multiplier: 4, clicks: 12 },
  { startMs: 468, endMs: 525, intervalMs: 5, multiplier: 4, clicks: 12 },
  { startMs: 501, endMs: 545, intervalMs: 5, multiplier: 4, clicks: 12 }
];
let lastMove: MoveCommandMessage | MovePlanCommandMessage | null = null;
let lastFire: FireCommandMessage | null = null;
let highPower = false;
let moveAssist = false;
let moveBrain: MoveBrain = "planner";
let stepCadenceAlways = false;
let pulseClick = false;
let timingStartPct = DEFAULT_TIMING_START_PCT;
let timingEndPct = DEFAULT_TIMING_END_PCT;
let timingIntervalMs = DEFAULT_TIMING_INTERVAL_MS;
let timingMultiplier = DEFAULT_TIMING_MULTIPLIER;
let initiativeStrike = false;
let primaryClientId = "";
let arenaEnabled = false;
let arenaLastSampleSummary = "waiting";
let arenaLastBroadcastAt = 0;
let lastSnapshot: ServerStateSnapshot = emptySnapshot();
let workerSeq = 0;
let runtimeEpoch = 1;
let workerBusy = false;
let inflightSeq = 0;
let inflightEpoch = 0;
let pendingEvaluate: BrainWorkerRequest | null = null;
let scheduledFireTimer: ReturnType<typeof setTimeout> | null = null;
let scheduledFireSeq = 0;

const runtimeExt = path.extname(__filename).toLowerCase();
const workerUrl =
  runtimeExt === ".ts"
    ? new URL("./runtime/brain-worker.ts", import.meta.url)
    : new URL("./runtime/brain-worker.js", import.meta.url);
const workerExecArgv = runtimeExt === ".ts" ? ["--import", "tsx"] : [];

interface ArenaClientMeta {
  clientId: string;
  label: string;
  firstSeenAt: number;
  lastSeenAt: number;
  sceneHash: string | null;
  selfId: number;
  accountId: number;
  name: string;
  resolves: number;
  wins: number;
  losses: number;
}

interface ArenaSample {
  ts: number;
  clientId: string;
  sceneHash: string | null;
  role: "ATTACKER" | "DEFENDER";
  won: boolean;
  window: ArenaWindowConfig;
  selfStepAgeMs: number;
  targetStepAgeMs: number;
  lastPunchAgeMs: number;
}

let worker = createBrainWorker();

wsServer.on("connection", (socket) => {
  let role: "bridge" | "ui" | "unknown" = "unknown";

  socket.on("message", (data) => {
    const message = parseClientMessage(String(data));
    if (!message) {
      return;
    }

    switch (message.type) {
      case "bridge_hello":
        role = "bridge";
        bridgeClients.add(socket);
        registerBridgeClient(socket, sanitizeClientId(message.clientId));
        sendBridgeStatus(socket);
        break;
      case "ui_hello":
        role = "ui";
        uiClients.add(socket);
        sendBridgeStatus(socket);
        sendState(socket);
        break;
      case "sensor":
        handleSensorMessage(message.payload, sanitizeClientId(message.clientId));
        break;
      case "ui_action":
        handleUiAction(message);
        break;
      default:
        break;
    }
  });

  socket.on("close", () => {
    unregisterBridgeClient(socket);
    bridgeClients.delete(socket);
    uiClients.delete(socket);
    if (role === "bridge") {
      resetRuntime(false);
      broadcastBridgeStatus();
      broadcastState(lastSnapshot);
    }
  });
});

function registerBridgeClient(socket: WebSocket, clientId: string): void {
  unregisterBridgeClient(socket);
  bridgeClientIds.set(socket, clientId);
  let sockets = bridgeClientsById.get(clientId);
  if (!sockets) {
    sockets = new Set<WebSocket>();
    bridgeClientsById.set(clientId, sockets);
  }
  sockets.add(socket);
  touchArenaClient(clientId);
}

function unregisterBridgeClient(socket: WebSocket): void {
  const clientId = bridgeClientIds.get(socket);
  if (!clientId) {
    return;
  }
  bridgeClientIds.delete(socket);
  const sockets = bridgeClientsById.get(clientId);
  sockets?.delete(socket);
  if (sockets && sockets.size === 0) {
    bridgeClientsById.delete(clientId);
  }
}

function sanitizeClientId(value: unknown): string {
  const raw = typeof value === "string" ? value : "";
  const normalized = raw.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 48);
  return normalized || `bridge-${Math.random().toString(36).slice(2, 10)}`;
}

function handleSensorMessage(rawPayload: string, clientId: string): void {
  const envelope = parseSensorEnvelope(rawPayload);
  if (!envelope) {
    return;
  }
  const effectiveClientId = sanitizeClientId(envelope.clientId ?? clientId);
  envelope.clientId = effectiveClientId;
  getClientSensors(effectiveClientId).ingest(envelope);
  observeArenaEnvelope(effectiveClientId, envelope);
  if (!primaryClientId) {
    primaryClientId = effectiveClientId;
  }
  if (arenaEnabled) {
    arenaTick();
  }
  if (effectiveClientId !== primaryClientId) {
    maybeBroadcastArenaState();
    return;
  }
  sensors.ingest(envelope);
  const currentTiming = resolveCurrentTimingConfig();
  const snapshot = buildBaseSnapshot();
  lastSnapshot = snapshot;
  const message: BrainWorkerRequest = {
    type: "evaluate",
    seq: ++workerSeq,
    epoch: runtimeEpoch,
    snapshot,
    fireOptions: {
      moveBrain,
      highPower,
      moveAssist,
      stepCadenceAlways,
      pulseClick,
      initiativeStrike,
      timingStartPct: currentTiming.startPct,
      timingEndPct: currentTiming.endPct,
      timingIntervalMs: currentTiming.intervalMs,
      timingMultiplier
    }
  };
  queueWorkerEvaluate(message);
}

function handleUiAction(message: UiActionMessage): void {
  if (message.action === "set_armed") {
    policy.setArmed(Boolean(message.value));
    if (message.value) {
      moveAssist = true;
    }
    resetRuntime(false);
  } else if (message.action === "set_high_power") {
    highPower = Boolean(message.value);
    resetRuntime(false);
  } else if (message.action === "set_move_brain") {
    const n = Number(message.value);
    moveBrain = n === 3 ? "tile3" : n === 2 ? "tile2" : n === 1 ? "tile" : "planner";
    resetRuntime(false);
  } else if (message.action === "set_move_assist") {
    moveAssist = Boolean(message.value);
    if (!moveAssist) {
      lastMove = null;
    }
    resetRuntime(false);
  } else if (message.action === "set_step_cadence_always") {
    stepCadenceAlways = Boolean(message.value);
    if (stepCadenceAlways) {
      pulseClick = false;
    }
    resetRuntime(false);
  } else if (message.action === "set_pulse_click") {
    pulseClick = Boolean(message.value);
    if (pulseClick) {
      stepCadenceAlways = false;
    }
    resetRuntime(false);
  } else if (message.action === "set_timing_start_pct") {
    timingStartPct = clampInt(message.value, 40, 99, timingStartPct);
    if (timingEndPct <= timingStartPct) {
      timingEndPct = Math.min(100, timingStartPct + 1);
    }
    resetRuntime(false);
  } else if (message.action === "set_timing_end_pct") {
    timingEndPct = clampInt(message.value, timingStartPct + 1, 100, timingEndPct);
    resetRuntime(false);
  } else if (message.action === "set_timing_interval_ms") {
    timingIntervalMs = clampInt(message.value, 1, 200, timingIntervalMs);
    resetRuntime(false);
  } else if (message.action === "set_timing_multiplier") {
    timingMultiplier = clampInt(message.value, 1, 4, timingMultiplier);
    resetRuntime(false);
  } else if (message.action === "set_initiative_strike") {
    initiativeStrike = Boolean(message.value);
    if (initiativeStrike) {
      moveAssist = true;
      stepCadenceAlways = false;
      pulseClick = false;
    }
    resetRuntime(false);
  } else if (message.action === "set_arena_enabled") {
    arenaEnabled = Boolean(message.value);
    if (!arenaEnabled) {
      arenaAssignments.clear();
      arenaLastCommandKey.clear();
      arenaLastCommandAt.clear();
    } else {
      arenaTick(true);
    }
  } else if (message.action === "reset_arena") {
    resetArena();
  } else if (message.action === "mark_scene_allowed" && message.sceneHash) {
    policy.markSceneAllowed(message.sceneHash);
    resetRuntime(false);
  } else if (message.action === "ignore_scene" && message.sceneHash) {
    policy.ignoreScene(message.sceneHash);
    resetRuntime(false);
  } else if (message.action === "reset_runtime") {
    resetRuntime(false);
  } else if (message.action === "reset_session_memory") {
    resetRuntime(true);
  }
  broadcastBridgeStatus();
  broadcastState(buildBaseSnapshot());
}

function buildBaseSnapshot(
  sourceSensors = sensors,
  sourceRoundTracker = roundTracker,
  clientId = primaryClientId
): ServerStateSnapshot {
  const board = buildBoardModel(sourceSensors, policy);
  const frameClock = resolveFrameClock(sourceSensors);
  const frameTs = frameClock.ts;
  const frameWall = frameClock.wall;

  return {
    nowTs: frameTs,
    nowWall: frameWall,
    frameTs,
    frameWall,
    armed: policy.isArmed(),
    scene: board.scene,
    entities: board.entities,
    selection: board.selection,
    lastResolve: sourceSensors.getLastResolve(),
    recentResolves: sourceSensors.getRecentResolves(),
    round: sourceRoundTracker.update({
      frameTs,
      frameWall,
      scene: board.scene,
      entities: board.entities,
      lastResolve: sourceSensors.getLastResolve()
    }),
    targetId: board.targetId,
    window: null,
    brain: null,
    lastFire,
    clients: arenaClientSummaries(),
    arena: buildArenaState(),
    adaptiveTuning: null
  };
}

function resolveFrameClock(sourceSensors = sensors): { ts: number; wall: number } {
  const timed = sourceSensors.getTimedEntities();
  if (timed.length === 0) {
    const nowWall = Date.now();
    const nowTs = sourceSensors.getLastSensorTs() || 0;
    return {
      ts: nowTs,
      wall: nowWall
    };
  }
  const tsSorted = timed.map((item) => item.seenTs).sort((a, b) => a - b);
  const wallSorted = timed.map((item) => item.seenWall).sort((a, b) => a - b);
  const ts = tsSorted[Math.floor(tsSorted.length / 2)] ?? sourceSensors.getLastSensorTs();
  const wall = wallSorted[Math.floor(wallSorted.length / 2)] ?? Date.now();
  return { ts, wall };
}

function bridgeStatusPayload(): BridgeStatusMessage {
  return {
    type: "bridge_status",
    connected: bridgeClients.size > 0,
    clientId: primaryClientId || undefined,
    armed: policy.isArmed(),
    moveBrain,
    highPower,
    moveAssist,
    stepCadenceAlways,
    pulseClick,
    initiativeStrike,
    timingStartPct,
    timingEndPct,
    timingIntervalMs,
    timingMultiplier,
    burstPreviewOffsetsMs: buildTimingBurstPreview(
      timingStartPct,
      timingEndPct,
      timingIntervalMs,
      timingMultiplier
    ),
    allowedSceneHashes: policy.getAllowedSceneHashes(),
    ignoredHashes: policy.getIgnoredSceneHashes(),
    arena: buildArenaState()
  };
}

function sendBridgeStatus(socket: WebSocket): void {
  sendJson(socket, bridgeStatusPayload());
}

function broadcastBridgeStatus(): void {
  const payload = bridgeStatusPayload();
  broadcastTo(bridgeClients, payload);
  broadcastTo(uiClients, payload);
}

function sendState(socket: WebSocket): void {
  const payload: StateMessage = {
    type: "state",
    payload: lastSnapshot
  };
  sendJson(socket, payload);
}

function broadcastState(snapshot: ServerStateSnapshot): void {
  const payload: StateMessage = {
    type: "state",
    payload: snapshot
  };
  broadcastTo(uiClients, payload);
}

function broadcastTo(
  sockets: Set<WebSocket>,
  payload:
    | BridgeStatusMessage
    | FireCommandMessage
    | MoveCommandMessage
    | MovePlanCommandMessage
    | TimingConfigCommandMessage
    | StateMessage
): void {
  for (const socket of sockets) {
    sendJson(socket, payload);
  }
}

function sendToBridgeClient(clientId: string, payload: TimingConfigCommandMessage | FireCommandMessage | MoveCommandMessage | MovePlanCommandMessage): void {
  const sockets = bridgeClientsById.get(clientId);
  if (!sockets || sockets.size === 0) {
    return;
  }
  broadcastTo(sockets, {
    ...payload,
    clientId
  });
}

function scheduleBridgeFire(fire: FireCommandMessage): void {
  const outbound: FireCommandMessage = primaryClientId ? { ...fire, clientId: primaryClientId } : fire;
  lastFire = outbound;
  clearScheduledFire();
  if (primaryClientId) {
    sendToBridgeClient(primaryClientId, outbound);
  } else {
    broadcastTo(bridgeClients, outbound);
  }
}

function clearScheduledFire(): void {
  scheduledFireSeq += 1;
  if (scheduledFireTimer) {
    clearTimeout(scheduledFireTimer);
    scheduledFireTimer = null;
  }
}

function sendJson(socket: WebSocket, payload: object): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function parseClientMessage(raw: string): ClientMessage | null {
  try {
    return JSON.parse(raw) as ClientMessage;
  } catch {
    return null;
  }
}

function parseSensorEnvelope(raw: string): SensorEnvelope | null {
  try {
    return JSON.parse(raw) as SensorEnvelope;
  } catch {
    return null;
  }
}

function getClientSensors(clientId: string): SensorStore {
  let store = clientSensors.get(clientId);
  if (!store) {
    store = new SensorStore(3000);
    clientSensors.set(clientId, store);
  }
  return store;
}

function getClientTracker(clientId: string): RoundTracker {
  let tracker = clientTrackers.get(clientId);
  if (!tracker) {
    tracker = new RoundTracker();
    clientTrackers.set(clientId, tracker);
  }
  return tracker;
}

function touchArenaClient(clientId: string): ArenaClientMeta {
  const now = Date.now();
  let meta = arenaClientMeta.get(clientId);
  if (!meta) {
    meta = {
      clientId,
      label: `C${arenaClientMeta.size + 1}`,
      firstSeenAt: now,
      lastSeenAt: now,
      sceneHash: null,
      selfId: -1,
      accountId: -1,
      name: "",
      resolves: 0,
      wins: 0,
      losses: 0
    };
    arenaClientMeta.set(clientId, meta);
  }
  meta.lastSeenAt = now;
  return meta;
}

function observeArenaEnvelope(clientId: string, envelope: SensorEnvelope): void {
  const meta = touchArenaClient(clientId);
  if (envelope.sceneHash) {
    meta.sceneHash = envelope.sceneHash;
  }
  if (envelope.type === "entity_state" && envelope.payload.isSelf) {
    meta.selfId = envelope.payload.id;
    meta.accountId = envelope.payload.accountId ?? -1;
    meta.name = envelope.payload.name ?? "";
  } else if (envelope.type === "scene_snapshot") {
    meta.sceneHash = envelope.payload.sceneHash || envelope.sceneHash || meta.sceneHash;
  } else if (envelope.type === "resolve_event") {
    observeArenaResolve(clientId, envelope);
  }
}

function observeArenaResolve(clientId: string, envelope: Extract<SensorEnvelope, { type: "resolve_event" }>): void {
  const meta = touchArenaClient(clientId);
  const resolve = envelope.payload;
  if (meta.selfId < 0) {
    return;
  }
  const role =
    resolve.attackerId === meta.selfId
      ? "ATTACKER"
      : resolve.defenderId === meta.selfId
        ? "DEFENDER"
        : "OTHER";
  if (role === "OTHER") {
    return;
  }
  const dedupeKey = [
    clientId,
    resolve.attackerId,
    resolve.defenderId,
    Math.round((resolve.timestamp || envelope.ts || 0) / 24),
    role
  ].join(":");
  if (arenaSeenResolveKeys.has(dedupeKey)) {
    return;
  }
  arenaSeenResolveKeys.add(dedupeKey);
  if (arenaSeenResolveKeys.size > 5000) {
    arenaSeenResolveKeys.clear();
  }

  const window = arenaAssignments.get(clientId) ?? windowFromResolve(resolve);
  const won = role === "ATTACKER";
  meta.resolves += 1;
  if (won) {
    meta.wins += 1;
  } else {
    meta.losses += 1;
  }
  const sample: ArenaSample = {
    ts: Date.now(),
    clientId,
    sceneHash: envelope.sceneHash || meta.sceneHash,
    role,
    won,
    window,
    selfStepAgeMs: saneMs(resolve.selfStepAgeMs, -1),
    targetStepAgeMs: saneMs(resolve.targetStepAgeMs, -1),
    lastPunchAgeMs: saneMs(resolve.lastPunchAgeMs, -1)
  };
  arenaSamples.push(sample);
  while (arenaSamples.length > 1200) {
    arenaSamples.shift();
  }
  arenaLastSampleSummary =
    `${meta.label} ${won ? "WIN" : "LOSS"} ${window.startMs}-${window.endMs} ` +
    `selfStep=${sample.selfStepAgeMs >= 0 ? sample.selfStepAgeMs : "?"} punchAge=${sample.lastPunchAgeMs >= 0 ? sample.lastPunchAgeMs : "?"}`;
}

function windowFromResolve(resolve: Extract<SensorEnvelope, { type: "resolve_event" }>["payload"]): ArenaWindowConfig {
  const startMs = clampInt(resolve.timingStartMs, 0, 699, 435);
  const endMs = clampInt(resolve.timingEndMs, startMs + 1, 700, 550);
  return {
    startMs,
    endMs,
    intervalMs: clampInt(resolve.timingIntervalMs, 1, 200, 5),
    multiplier: clampInt(resolve.timingMultiplier, 1, 4, 4),
    clicks: clampInt(resolve.timingClicks, 0, 12, 12)
  };
}

function arenaTick(force = false): void {
  if (!arenaEnabled) {
    return;
  }
  const pair = activeArenaPair();
  if (pair.length < 2) {
    return;
  }
  const cycle = Math.floor(arenaSamples.length / ARENA_ROTATE_EVERY_SAMPLES);
  const firstWindow = ARENA_CANDIDATES[cycle % ARENA_CANDIDATES.length]!;
  const secondWindow = ARENA_CANDIDATES[(cycle + Math.ceil(ARENA_CANDIDATES.length / 2)) % ARENA_CANDIDATES.length]!;
  assignArenaWindow(pair[0]!.clientId, firstWindow, force);
  assignArenaWindow(pair[1]!.clientId, secondWindow, force);
}

function activeArenaPair(): ArenaClientMeta[] {
  const now = Date.now();
  const active = [...arenaClientMeta.values()]
    .filter((client) => now - client.lastSeenAt <= ARENA_CLIENT_TTL_MS && client.sceneHash)
    .sort((left, right) => left.label.localeCompare(right.label));
  const groups = new Map<string, ArenaClientMeta[]>();
  for (const client of active) {
    const key = client.sceneHash ?? "";
    const group = groups.get(key) ?? [];
    group.push(client);
    groups.set(key, group);
  }
  return [...groups.values()]
    .filter((group) => group.length >= 2)
    .sort((left, right) => right.length - left.length)[0]
    ?.slice(0, 2) ?? [];
}

function assignArenaWindow(clientId: string, window: ArenaWindowConfig, force: boolean): void {
  const now = Date.now();
  const key = windowKey(window);
  const lastKey = arenaLastCommandKey.get(clientId);
  const lastAt = arenaLastCommandAt.get(clientId) ?? 0;
  arenaAssignments.set(clientId, window);
  if (!force && lastKey === key && now - lastAt < ARENA_COMMAND_RESEND_MS) {
    return;
  }
  arenaLastCommandKey.set(clientId, key);
  arenaLastCommandAt.set(clientId, now);
  const meta = arenaClientMeta.get(clientId);
  const command: TimingConfigCommandMessage = {
    type: "timing_config",
    clientId,
    enabled: true,
    startMs: window.startMs,
    endMs: window.endMs,
    intervalMs: window.intervalMs,
    multiplier: window.multiplier,
    clicks: window.clicks,
    reason: "ARENA_AB",
    issuedAtTs: now,
    sceneHash: meta?.sceneHash ?? undefined
  };
  sendToBridgeClient(clientId, command);
}

function maybeBroadcastArenaState(): void {
  const now = Date.now();
  if (now - arenaLastBroadcastAt < 250) {
    return;
  }
  arenaLastBroadcastAt = now;
  lastSnapshot = {
    ...lastSnapshot,
    clients: arenaClientSummaries(),
    arena: buildArenaState()
  };
  broadcastBridgeStatus();
  broadcastState(lastSnapshot);
}

function resetArena(): void {
  arenaSamples.length = 0;
  arenaSeenResolveKeys.clear();
  arenaAssignments.clear();
  arenaLastCommandKey.clear();
  arenaLastCommandAt.clear();
  arenaLastSampleSummary = "waiting";
  for (const meta of arenaClientMeta.values()) {
    meta.resolves = 0;
    meta.wins = 0;
    meta.losses = 0;
  }
}

function buildArenaState(): ArenaState {
  const pair = arenaEnabled ? activeArenaPair().map((client) => client.clientId) : [];
  const candidates = arenaWindowStats();
  const bestWindow = candidates.find((candidate) => candidate.samples > 0) ?? null;
  return {
    enabled: arenaEnabled,
    phase: !arenaEnabled ? "OFF" : pair.length >= 2 ? "RUNNING" : "WAITING",
    pair,
    totalSamples: arenaSamples.length,
    lastSampleSummary: arenaLastSampleSummary,
    bestWindow,
    clients: arenaClientSummaries(),
    candidates
  };
}

function arenaClientSummaries(): ArenaClientSummary[] {
  const now = Date.now();
  return [...arenaClientMeta.values()]
    .sort((left, right) => left.label.localeCompare(right.label))
    .map((client) => ({
      clientId: client.clientId,
      label: client.label,
      sceneHash: client.sceneHash,
      selfId: client.selfId,
      accountId: client.accountId,
      name: client.name,
      lastSeenAgoMs: now - client.lastSeenAt,
      resolves: client.resolves,
      wins: client.wins,
      losses: client.losses,
      activeWindow: arenaAssignments.get(client.clientId) ?? null
    }));
}

function arenaWindowStats(): ArenaWindowStats[] {
  const stats = new Map<string, { window: ArenaWindowConfig; samples: ArenaSample[] }>();
  for (const candidate of ARENA_CANDIDATES) {
    stats.set(windowKey(candidate), { window: candidate, samples: [] });
  }
  for (const sample of arenaSamples) {
    const key = windowKey(sample.window);
    const item = stats.get(key) ?? { window: sample.window, samples: [] };
    item.samples.push(sample);
    stats.set(key, item);
  }
  return [...stats.values()]
    .map(({ window, samples }) => {
      const wins = samples.filter((sample) => sample.won).length;
      const losses = samples.length - wins;
      const avgSelfStepAgeMs =
        average(samples.map((sample) => sample.selfStepAgeMs).filter((value) => value >= 0)) ?? -1;
      const winRate = samples.length > 0 ? wins / samples.length : 0;
      const width = window.endMs - window.startMs;
      const score = samples.length > 0 ? winRate * 100 + Math.min(samples.length, 24) - Math.max(0, width - 58) * 0.35 : 0;
      return {
        ...window,
        samples: samples.length,
        wins,
        losses,
        winRate: round2(winRate),
        avgSelfStepAgeMs: avgSelfStepAgeMs >= 0 ? Math.round(avgSelfStepAgeMs) : -1,
        score: round2(score)
      };
    })
    .sort((left, right) => right.score - left.score || right.samples - left.samples || left.startMs - right.startMs);
}

function windowKey(window: ArenaWindowConfig): string {
  return `${window.startMs}-${window.endMs}@${window.intervalMs}x${window.multiplier}c${window.clicks}`;
}

function saneMs(value: unknown, fallback: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > 5000) {
    return fallback;
  }
  return Math.round(numeric);
}

function average(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function resetRuntime(clearSessionMemory: boolean): void {
  clearScheduledFire();
  sensors.reset();
  roundTracker.reset();
  lastMove = null;
  lastFire = null;
  workerBusy = false;
  inflightSeq = 0;
  inflightEpoch = 0;
  pendingEvaluate = null;
  runtimeEpoch += 1;
  lastSnapshot = emptySnapshot();
  restartBrainWorker(clearSessionMemory);
}

function queueWorkerEvaluate(message: BrainWorkerRequest): void {
  if (message.type !== "evaluate") {
    return;
  }
  if (workerBusy) {
    pendingEvaluate = message;
    return;
  }
  dispatchWorkerEvaluate(message);
}

function dispatchWorkerEvaluate(message: BrainWorkerRequest): void {
  if (message.type !== "evaluate") {
    return;
  }
  workerBusy = true;
  inflightSeq = message.seq;
  inflightEpoch = message.epoch;
  worker.postMessage(message);
}

function flushPendingEvaluate(): void {
  if (!pendingEvaluate || pendingEvaluate.type !== "evaluate") {
    return;
  }
  const next = pendingEvaluate;
  pendingEvaluate = null;
  dispatchWorkerEvaluate(next);
}

function createBrainWorker(): Worker {
  const nextWorker = new Worker(workerUrl, {
    execArgv: workerExecArgv
  });

  nextWorker.on("message", (message: BrainWorkerResponse) => {
    if (message.type !== "result") {
      return;
    }
    const completedInflight = message.seq === inflightSeq && message.epoch === inflightEpoch;
    if (completedInflight) {
      workerBusy = false;
      inflightSeq = 0;
      inflightEpoch = 0;
    }
    if (message.epoch !== runtimeEpoch) {
      flushPendingEvaluate();
      return;
    }
    if (completedInflight || message.seq >= workerSeq) {
      if (moveAssist && message.move) {
        lastMove = primaryClientId ? { ...message.move, clientId: primaryClientId } : message.move;
        if (primaryClientId) {
          sendToBridgeClient(primaryClientId, lastMove);
        } else {
          broadcastTo(bridgeClients, lastMove);
        }
      }
      if (message.fire) {
        scheduleBridgeFire(message.fire);
      }
      lastSnapshot = {
        ...message.snapshot,
        lastFire: lastFire ?? message.snapshot.lastFire
      };
      broadcastState(lastSnapshot);
    }
    flushPendingEvaluate();
  });

  nextWorker.on("error", (error) => {
    console.error("[ring-board] brain worker error", error);
    workerBusy = false;
    inflightSeq = 0;
    inflightEpoch = 0;
  });

  if (runtimeEpoch > 0 || pendingEvaluate) {
    const resetMessage: BrainWorkerRequest = {
      type: "reset",
      epoch: runtimeEpoch,
      clearSessionMemory: false
    };
    nextWorker.postMessage(resetMessage);
  }

  return nextWorker;
}

function restartBrainWorker(clearSessionMemory: boolean): void {
  const previousWorker = worker;
  worker = createBrainWorker();
  const resetMessage: BrainWorkerRequest = {
    type: "reset",
    epoch: runtimeEpoch,
    clearSessionMemory
  };
  worker.postMessage(resetMessage);
  void previousWorker.terminate().catch(() => undefined);
}

function emptySnapshot(): ServerStateSnapshot {
  return {
    nowTs: 0,
    nowWall: 0,
    frameTs: 0,
    frameWall: 0,
    armed: policy.isArmed(),
    scene: null,
    entities: [],
    selection: null,
    lastResolve: null,
    round: {
      phase: "IDLE",
      roundId: 0,
      sceneHash: null,
      sinceTs: 0,
      liveForMs: 0,
      enemyCount: 0,
      selfAlive: false,
      summary: "IDLE"
    },
    targetId: -1,
    window: null,
    brain: null,
    lastFire: null,
    clients: arenaClientSummaries(),
    arena: buildArenaState(),
    adaptiveTuning: null
  };
}

function resolveCurrentTimingConfig(): {
  startPct: number;
  endPct: number;
  intervalMs: number;
} {
  return {
    startPct: timingStartPct,
    endPct: timingEndPct,
    intervalMs: timingIntervalMs
  };
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.round(numeric)));
}

function buildTimingBurstPreview(
  startPct: number,
  endPct: number,
  intervalMs: number,
  multiplier: number
): number[] {
  const tileMs = 550;
  const start = Math.max(0, Math.min(99, Math.round(startPct)));
  const end = Math.max(start + 1, Math.min(100, Math.round(endPct)));
  const interval = Math.max(1, Math.min(200, Math.round(intervalMs)));
  const effectiveInterval = Math.max(1, Math.round(interval / Math.max(1, Math.min(4, Math.round(multiplier)))));
  let duration = Math.round(tileMs * (end - start) / 100);
  duration = Math.max(40, Math.min(520, duration));
  const offsets: number[] = [];
  for (let offset = 0; offset <= duration; offset += effectiveInterval) {
    offsets.push(offset);
  }
  if (offsets.length === 0 || offsets[offsets.length - 1] !== duration) {
    offsets.push(duration);
  }
  return offsets;
}
