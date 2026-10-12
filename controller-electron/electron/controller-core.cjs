const net = require("net");
const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");
const WebSocket = require("ws");
const licenseGate = require("./license/gate.cjs");
const { normalizeHotkey } = require("./hotkey.cjs");

// Hub core for the HTML5 runtime (HTML5/hub_runtime/flash_runtime.page.js).
// It keeps only what the runtime and the UI use: the :9999 bridge, TIMING
// (STEP / LANDING / TICK), move punch, drops, punch packets and the Ring Board.
// Nothing is written to disk during play: settings change only on user input.
const TCP_PORT = 9999;
const RING_BOARD_WS_URL = "ws://127.0.0.1:18444";
const RING_BOARD_HTTP_URL = "http://127.0.0.1:18445";
const RING_BOARD_CLIENT_ID = "bbhub-main";
// Ring mGame2 static layout hash (fnv1a of the HTML5 runtime scene). 23/09 update:
// 117 tiles; the 84-tile Ring before it was "681d57fe" (both are allowed).
const RING_BOARD_SCENE_HASH = "794bf3d1";
const CONTROLLER_BUILD = "bb_hub_electron_01102026_coco_self";
const TIMING_WINDOW_MAX = 750;
const TIMING_START_MAX = TIMING_WINDOW_MAX - 1;
const TIMING_RATE_MAX = 200;
const TIMING_MULT_MAX = 50;
const PUNCH_PACKETS_MAX = 8;
const SNAPSHOT_MS = 500;
// Runtime reporting cadence (state / scene / config), in ms.
const RUNTIME_PERFORMANCE = { stateMs: 250, sceneMs: 2000, configMs: 3000 };
// Runtime messages the Hub no longer consumes (older runtimes, labs).
const IGNORED_RUNTIME_MESSAGES = new Set([
  "timing_metric",
  "packet_event",
  "preface_event",
  "resolve_event_ext",
  "resolve_lock_state",
  "tick_phase"
]);

const SKIN_NAMES = {
  1: "Nerd",
  2: "Vieja",
  3: "Rasta",
  4: "Viejo",
  5: "India",
  6: "Mafioso",
  7: "Seta",
  8: "Gata",
  9: "Boomer",
  10: "DJ",
  11: "Bruja",
  12: "Ninja",
  13: "Wraith",
  14: "Fantasma",
  15: "Zombie",
  16: "Werewolf",
  17: "Skeleton",
  18: "God",
  19: "Ninja Blanco",
  20: "Sally",
  21: "Sally 1",
  22: "Sally 2",
  23: "Sally 3",
  24: "Sally 4",
  25: "Sally 5",
  26: "Sally 6",
  27: "Sally 7",
  28: "Sally 8",
  29: "Sally 9",
  30: "Sally 10",
  31: "Rasta Galaxy"
};

const defaultTiming = () => ({
  enabled: false,
  source: "STEP",
  stepAnchor: "BOTH",
  start: 435,
  end: 750,
  dualWindow: false,
  start2: 700,
  end2: 750,
  rate: 1,
  mult: 1,
  randomInterval: false,
  intervalMin: 1,
  intervalMax: 33,
  randomMultiplier: false,
  multMin: 1,
  multMax: 50,
  clicks: 1,
  gap: 1,
  profile: "LINEAR",
  power: false,
  stepScale: true,
  landing: {
    enabled: false,
    offsetMs: 0,
    jitterMs: 25,
    secondShot: true,
    secondDelayMs: 120,
    adaptive: true,
    adaptiveStepMs: 10
  },
  tick: {
    enabled: false,
    auto: true,
    single: true,
    offsetMs: 10,
    shots: 4,
    spacingMs: 110,
    blind: true,
    reactive: true,
    autoCal: true,
    burst: 5,
    burstGapMs: 4
  }
});

const defaultMoveDelay = () => ({
  enabled: false,
  delayMs: 0,
  minMoveMs: 0
});

const defaultDropHunter = () => ({
  enabled: false,
  autoReturn: true,
  autoClaim: true,
  state: "IDLE",
  keyword: "",
  lastEvent: "",
  dropId: -1,
  x: -1,
  y: -1,
  lastAt: 0
});

const defaultCombat = () => ({
  hits: 0,
  gotHit: 0,
  lastAttackerId: -1,
  lastDefenderId: -1,
  lastAt: 0
});

function safeInt(value, fallback = 0) {
  const parsed = Number.parseInt(String(value ?? "").replace(",", "."), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function safeNumber(value, fallback = 0) {
  const parsed = Number(String(value ?? "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeIntRange(minValue, maxValue, fallbackMin, fallbackMax, minAllowed, maxAllowed) {
  let min = clamp(safeInt(minValue, fallbackMin), minAllowed, maxAllowed);
  let max = clamp(safeInt(maxValue, fallbackMax), minAllowed, maxAllowed);
  if (min > max) {
    [min, max] = [max, min];
  }
  return [min, max];
}

function normalizeMatrix(input, width, height, fallback = 1) {
  return Array.from({ length: height }, (_row, y) => {
    const row = Array.isArray(input?.[y]) ? input[y] : [];
    return Array.from({ length: width }, (_col, x) => safeInt(row[x], fallback));
  });
}

function nowStamp() {
  return new Date().toLocaleTimeString("es-AR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
}

function wireBool(value) {
  if (typeof value === "string") {
    return ["1", "true", "yes", "y", "on"].includes(value.trim().toLowerCase());
  }
  return Boolean(value);
}

function normalizeCombatState(rawCombat, fallbackState = -1) {
  const combat = rawCombat && typeof rawCombat === "object" ? rawCombat : {};
  const state = safeInt(combat.state, safeInt(fallbackState, -1));
  const attack = wireBool(combat.attack) || state === 14;
  const react = wireBool(combat.react) || state === 8 || state === 9;
  const busy = wireBool(combat.busy) || attack || react || [7, 8, 9, 10, 14].includes(state);
  const free = !busy && (combat.free == null ? state === 2 || state === 3 : wireBool(combat.free));
  return {
    state,
    busy,
    free,
    react,
    attack,
    frame: safeInt(combat.frame, 0),
    total: safeInt(combat.total, 0),
    progress: clamp(safeNumber(combat.progress, 0), 0, 1),
    anim: String(combat.anim || "")
  };
}

function normalizeStepAnchor(value, fallback = "SELF") {
  const normalized = String(value || fallback || "SELF").toUpperCase();
  return normalized === "TARGET" || normalized === "BOTH" ? normalized : "SELF";
}

function normalizeLandingConfig(config, fallback = defaultTiming().landing) {
  const fb = fallback && typeof fallback === "object" ? fallback : defaultTiming().landing;
  const c = config && typeof config === "object" ? config : fb;
  return {
    enabled: c.enabled == null ? Boolean(fb.enabled) : Boolean(c.enabled),
    offsetMs: clamp(safeInt(c.offsetMs, fb.offsetMs ?? 0), 0, 250),
    jitterMs: clamp(safeInt(c.jitterMs, fb.jitterMs ?? 25), 0, 150),
    secondShot: c.secondShot == null ? Boolean(fb.secondShot) : Boolean(c.secondShot),
    secondDelayMs: clamp(safeInt(c.secondDelayMs, fb.secondDelayMs ?? 120), 50, 400),
    adaptive: c.adaptive == null ? Boolean(fb.adaptive) : Boolean(c.adaptive),
    adaptiveStepMs: clamp(safeInt(c.adaptiveStepMs, fb.adaptiveStepMs ?? 10), 1, 50)
  };
}

// Same limits as flash_runtime.page.js applyTimingConfig (tick): a mismatch
// would make the Hub re-push timing_config forever.
// Manual arrival of the tick click (27/09, user): null = auto (learned boundary +
// margin), a number = every click aimed at T + that many ms (the runtime clamps 0..120).
const MOVE_BRAIN_NAMES = ["planner", "tile", "tile2", "tile3"];

// Whitelist (29/09): names or account ids the bot never punches (the ally account,
// friends). Stored as typed; the runtime matches names case-insensitively.
// Advanced Timing knobs (29/09). Factory values = what measured best (5-request
// burst, sweep on, reaction on, no repeat click).
const ADVANCED_DEFAULTS = Object.freeze({ burst: 5, repeatMs: 0, sweep: true, reactive: true });
function normalizeAdvanced(value) {
  const v = value && typeof value === "object" ? value : {};
  const repeat = Number(v.repeatMs);
  return {
    burst: clamp(safeInt(v.burst, ADVANCED_DEFAULTS.burst), 1, 20),
    repeatMs: Number.isFinite(repeat) && repeat > 0 ? clamp(Math.round(repeat), 100, 400) : 0,
    sweep: v.sweep == null ? ADVANCED_DEFAULTS.sweep : Boolean(v.sweep),
    reactive: v.reactive == null ? ADVANCED_DEFAULTS.reactive : Boolean(v.reactive)
  };
}

// 06/10: each ally is { accountId, name }. The account id is what the runtime
// matches (names can carry commas, spaces or change case); a name-only entry
// (typed by hand, or saved by the old comma list) matches by exact name until
// that player shows up in a room, then it is bound to the account.
const ALLIES_MAX = 100;
function normalizeStepClick(value = {}) {
  const startMs = clamp(safeInt(value.startMs, 350), 0, 4999);
  const endMs = clamp(safeInt(value.endMs, 400), startMs + 1, 5000);
  const legacyInterval = value.clicks != null ? Math.ceil((endMs - startMs) / clamp(safeInt(value.clicks, 6), 1, 64)) : 10;
  return { enabled: value.enabled === true, source: ["PAIR", "SELF", "SELECTED", "ROOM"].includes(value.source) ? value.source : "PAIR",
    startMs, endMs, intervalMs: clamp(safeInt(value.intervalMs, legacyInterval), 1, 5000) };
}

function normalizeStepCrossing(raw) {
  if (!raw || typeof raw !== "object") return null;
  const finite = (v) => v != null && Number.isFinite(Number(v)) ? Number(v) : null;
  return { targetId: safeInt(raw.targetId,-1), durationMs:finite(raw.durationMs),closestMs:finite(raw.closestMs),closestContactMs:finite(raw.closestContactMs),distancePx:finite(raw.distancePx),
    contactFromMs:finite(raw.contactFromMs),contactToMs:finite(raw.contactToMs),resolutionMs:finite(raw.resolutionMs),samples:Math.max(0,safeInt(raw.samples,0)),
    contactWindows:Array.isArray(raw.contactWindows)?raw.contactWindows.slice(-16).map(w=>({fromMs:finite(w?.fromMs),toMs:finite(w?.toMs)})).filter(w=>w.fromMs!=null&&w.toMs!=null&&w.toMs>=w.fromMs):[],
    complete:raw.complete===true,active:raw.active===true };
}

function normalizeStepClickStatus(raw) {
  const finite = (v) => v != null && Number.isFinite(Number(v)) ? Number(v) : null;
  return {
    enabled: raw.enabled === true, running: raw.running === true,
    source: String(raw.source || "").slice(0, 16), reason: String(raw.reason || "").slice(0, 40),
    clockSource: String(raw.clockSource || "").slice(0, 24),
    durationMs: finite(raw.durationMs), phaseMs: finite(raw.phaseMs), sampleAt: finite(raw.sampleAt), intervalMs: finite(raw.intervalMs), latencyMs: finite(raw.latencyMs),
    referenceId: safeInt(raw.referenceId, -1), targetId: safeInt(raw.targetId, -1), targetName: String(raw.targetName || "").slice(0, 40),
    sent: Math.max(0, safeInt(raw.sent, 0)), skipped: Math.max(0, safeInt(raw.skipped, 0)), errors: Math.max(0, safeInt(raw.errors, 0)),
    steps: Math.max(0, safeInt(raw.steps, 0)),
    crossing: normalizeStepCrossing(raw.crossing), lastCrossing: normalizeStepCrossing(raw.lastCrossing), lastEncounter: normalizeStepCrossing(raw.lastEncounter),
    last: raw.last && typeof raw.last === "object" ? {
      targetId: safeInt(raw.last.targetId, -1), phaseMs: finite(raw.last.phaseMs), latenessMs: finite(raw.last.latenessMs),
      plannedPhaseMs: finite(raw.last.plannedPhaseMs), estimatedLandingMs: finite(raw.last.estimatedLandingMs), latencyMs: finite(raw.last.latencyMs),
      sent: raw.last.sent === true, reason: String(raw.last.reason || "").slice(0, 32), at: finite(raw.last.at)
    } : null
  };
}

function normalizeSimon(value) {
  const v = value && typeof value === "object" ? value : {};
  return { enabled: v.enabled === true, delayMs: clamp(safeInt(v.delayMs, 0), 0, 2000) };
}

function normalizeSimonStatus(raw) {
  const n = (v) => Math.max(0, safeInt(v, 0));
  const last = raw.last && typeof raw.last === "object" ? {
    round: n(raw.last.round), timeMs: n(raw.last.timeMs), go: raw.last.go === true ? true : raw.last.go === false ? false : null,
    cell: Number.isInteger(raw.last.cell) ? raw.last.cell : null, conf: Number.isFinite(Number(raw.last.conf)) ? Number(raw.last.conf) : null,
    sep: Number.isFinite(Number(raw.last.sep)) ? Number(raw.last.sep) : null,
    readMs: Number.isFinite(Number(raw.last.readMs)) ? Number(raw.last.readMs) : null,
    totalMs: Number.isFinite(Number(raw.last.totalMs)) ? Number(raw.last.totalMs) : null,
    error: raw.last.error ? String(raw.last.error).slice(0, 80) : ""
  } : null;
  return {
    inRoom: raw.inRoom === true, games: n(raw.games), rounds: n(raw.rounds), answered: n(raw.answered),
    skippedRed: n(raw.skippedRed), errors: n(raw.errors), wins: n(raw.wins), punchesHeld: n(raw.punchesHeld),
    sender: String(raw.sender || ""), last
  };
}

function normalizeAllies(value) {
  const list = Array.isArray(value) ? value : String(value || "").split(",");
  const out = [];
  for (const item of list) {
    let accountId = null;
    let name = "";
    if (item && typeof item === "object") {
      const id = Number(item.accountId);
      accountId = Number.isSafeInteger(id) && id > 0 ? id : null;
      name = String(item.name || "").trim().slice(0, 40);
    } else {
      const v = String(item ?? "").trim();
      if (/^\d+$/.test(v)) accountId = Number(v);
      else name = v.slice(0, 40);
    }
    if (!accountId && !name) continue;
    const dup = out.find((x) => accountId ? x.accountId === accountId : !x.accountId && x.name.toLowerCase() === name.toLowerCase());
    if (dup) {
      if (!dup.name && name) dup.name = name;
      continue;
    }
    out.push({ accountId, name });
  }
  return out.slice(0, ALLIES_MAX);
}

function normalizeTickAim(value) {
  if (value == null || value === "auto" || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? clamp(Math.round(n), 0, 120) : null;
}

function normalizeTickConfig(config, fallback = defaultTiming().tick) {
  const fb = fallback && typeof fallback === "object" ? fallback : defaultTiming().tick;
  const c = config && typeof config === "object" ? config : fb;
  const bool = (key) => (c[key] == null ? Boolean(fb[key] ?? defaultTiming().tick[key]) : Boolean(c[key]));
  return {
    enabled: bool("enabled"),
    offsetMs: clamp(safeInt(c.offsetMs, fb.offsetMs ?? 10), 0, 120),
    shots: clamp(safeInt(c.shots, fb.shots ?? 4), 1, 5),
    spacingMs: clamp(safeInt(c.spacingMs, fb.spacingMs ?? 110), 100, 200),
    blind: bool("blind"),
    reactive: bool("reactive"),
    autoCal: bool("autoCal"),
    auto: bool("auto"),
    single: bool("single"),
    burst: clamp(safeInt(c.burst, fb.burst ?? 5), 1, 8),
    burstGapMs: clamp(safeInt(c.burstGapMs, fb.burstGapMs ?? 4), 2, 20)
  };
}

function normalizeTimingConfig(config = {}, fallback = defaultTiming()) {
  const fb = { ...defaultTiming(), ...(fallback || {}) };
  const c = config && typeof config === "object" ? config : {};
  const start = clamp(safeInt(c.start, fb.start), 0, TIMING_START_MAX);
  const end = clamp(safeInt(c.end, fb.end), start, TIMING_WINDOW_MAX);
  const start2 = clamp(safeInt(c.start2, fb.start2), 0, TIMING_START_MAX);
  const end2 = clamp(safeInt(c.end2, fb.end2), start2, TIMING_WINDOW_MAX);
  const rate = clamp(safeInt(c.rate, fb.rate), 0, TIMING_RATE_MAX);
  const mult = clamp(safeInt(c.mult, fb.mult), 1, TIMING_MULT_MAX);
  const [intervalMin, intervalMax] = normalizeIntRange(c.intervalMin, c.intervalMax, fb.intervalMin, fb.intervalMax, 1, TIMING_RATE_MAX);
  const [multMin, multMax] = normalizeIntRange(c.multMin, c.multMax, fb.multMin, fb.multMax, 1, TIMING_MULT_MAX);
  const flag = (key) => (c[key] == null ? Boolean(fb[key]) : Boolean(c[key]));
  return {
    enabled: flag("enabled"),
    source: "STEP",
    stepAnchor: normalizeStepAnchor(c.stepAnchor, fb.stepAnchor),
    start,
    end,
    dualWindow: flag("dualWindow"),
    start2,
    end2,
    rate,
    mult,
    randomInterval: flag("randomInterval"),
    intervalMin,
    intervalMax,
    randomMultiplier: c.randomMultiplier == null && c.randomMult != null ? Boolean(c.randomMult) : flag("randomMultiplier"),
    multMin,
    multMax,
    clicks: clamp(safeInt(c.clicks, fb.clicks), 0, 100),
    gap: clamp(safeInt(c.gap, fb.gap), 0, 1000),
    profile: ["LINEAR", "CENTER", "EDGE", "TRIPLE"].includes(String(c.profile || "").toUpperCase())
      ? String(c.profile).toUpperCase()
      : fb.profile,
    power: flag("power"),
    stepScale: flag("stepScale"),
    landing: normalizeLandingConfig(c.landing, fb.landing),
    tick: normalizeTickConfig(c.tick, fb.tick)
  };
}

// The timing_config message the runtime understands.
function timingMessage(timing, enabled) {
  return {
    type: "timing_config",
    enabled: Boolean(enabled),
    source: "STEP",
    stepAnchor: timing.stepAnchor,
    start: timing.start,
    end: timing.end,
    dualWindow: timing.dualWindow,
    start2: timing.start2,
    end2: timing.end2,
    rate: timing.rate,
    mult: timing.mult,
    randomInterval: timing.randomInterval,
    intervalMin: timing.intervalMin,
    intervalMax: timing.intervalMax,
    randomMultiplier: timing.randomMultiplier,
    multMin: timing.multMin,
    multMax: timing.multMax,
    clicks: timing.clicks,
    gap: timing.gap,
    profile: timing.profile,
    power: timing.power,
    stepScale: timing.stepScale,
    animSync: false,
    preFace: false,
    fireMetrics: false,
    contactGate: false,
    landing: { ...timing.landing },
    tick: { ...timing.tick }
  };
}

// TICK status as the runtime reports it with every state message.
function normalizeTickStatus(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const a = raw.auto && typeof raw.auto === "object" ? raw.auto : {};
  const num = (value) => (value == null || !Number.isFinite(Number(value)) ? null : Math.round(Number(value)));
  return {
    lastTargetId: safeInt(raw.lastTargetId, -1),
    lastTargetReason: String(raw.lastTargetReason || ""),
    enabled: Boolean(raw.enabled),
    synced: Boolean(raw.synced),
    coherence: safeNumber(raw.coherence, 0),
    fired: safeInt(raw.fired, 0),
    replies: safeInt(raw.replies, 0),
    hits: safeInt(raw.hits, 0),
    lastSkip: String(raw.lastSkip || ""),
    reactFired: safeInt(raw.reactFired, 0),
    auto: {
      enabled: Boolean(a.enabled),
      aimMs: num(a.aimMs),
      burst: num(a.burst),
      burstGapMs: num(a.burstGapMs),
      spacingMs: num(a.spacingMs),
      boundaryMs: num(a.boundaryMs),
      samples: safeInt(a.samples, 0),
      marginMs: num(a.marginMs),
      sigmaMs: num(a.sigmaMs),
      corrMs: num(a.corrMs),
      cooldown: String(a.cooldown || "unknown"),
      races: safeInt(a.races, 0),
      wins: safeInt(a.wins, 0),
      early: safeInt(a.early, 0),
      late: safeInt(a.late, 0),
      lost: safeInt(a.lost, 0),
      learningHeld: safeInt(a.learningHeld, 0),
      recentWinRate: num(a.recentWinRate),
      rivalMedianMs: num(a.rivalMedianMs),
      lastOutcome: String(a.lastOutcome || "")
    }
  };
}

// Coco exit status as the runtime reports it with every state message.
function normalizeExitStatus(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const num = (value) => (value == null || !Number.isFinite(Number(value)) ? null : Math.round(Number(value)));
  return {
    enabled: Boolean(raw.enabled),
    cocoActive: Boolean(raw.cocoActive),
    cocoRemainingMs: safeInt(raw.cocoRemainingMs, 0),
    unlockMs: num(raw.unlockMs),
    samples: safeInt(raw.samples, 0),
    burst: safeInt(raw.burst, 0),
    burstGapMs: safeInt(raw.burstGapMs, 0),
    startMs: num(raw.startMs),
    exits: safeInt(raw.exits, 0),
    wins: safeInt(raw.wins, 0),
    lost: safeInt(raw.lost, 0),
    processed: safeInt(raw.processed, 0),
    silent: safeInt(raw.silent, 0),
    noTarget: safeInt(raw.noTarget, 0),
    lastPhaseMs: num(raw.lastPhaseMs),
    lastOutcome: String(raw.lastOutcome || ""),
    cocoMs: safeInt(raw.cocoMs, 7000),
    punch: Boolean(raw.punch),
    guardFired: safeInt(raw.guardFired, 0),
    guardHits: safeInt(raw.guardHits, 0),
    guardSkipped: safeInt(raw.guardSkipped, 0)
  };
}

class ControllerCore extends EventEmitter {
  constructor(options = {}) {
    super();
    this.settingsPath = options.settingsPath || path.join(process.cwd(), "bbhub-settings.json");
    // A source-launch experiment, never a saved user preference. Keep the
    // regular timing and learning settings intact underneath this overlay.
    const isolationPhase = options.punchIsolationPhase;
    this.punchIsolationPhase = typeof isolationPhase === "number" && Number.isFinite(isolationPhase) &&
      isolationPhase >= -20 && isolationPhase <= 40 ? isolationPhase : null;
    this.port = safeInt(options.port, TCP_PORT);
    this.autoPort = options.autoPort === true;
    this.tcpReady = null;
    this.ringBoardEnabled = options.ringBoard !== false;
    const saved = this.loadSettings();
    try { this.timingHotkey = normalizeHotkey(saved.timingHotkey ?? "F2"); }
    catch { this.timingHotkey = "F2"; }
    this.tickAim = normalizeTickAim(saved.tickAim);
    // Movement brain chosen on the Board (0 planner, 1 tile, 2 tile2): the ring-board
    // starts on the planner, so it is sent again whenever its status says otherwise.
    this.moveBrain = [0, 1, 2, 3].includes(saved.moveBrain) ? saved.moveBrain : 0;
    this.tcpServer = null;
    this.swfSocket = null;
    this.swfAddr = null;
    this.selfId = -1;
    this.bridgeBuild = "-";
    this.serverPingMs = null;
    this.bridgePingMs = null;
    this.bridgePingSentAt = 0;
    this.lastStateAt = 0;
    this.lastSwfTs = 0;
    this.lastSwfWall = 0;
    this.selectedTarget = -1;
    this.players = new Map();
    this.logs = [];
    this.timing = this.singleTiming(false);
    this.moveDelay = {
      ...defaultMoveDelay(),
      delayMs: clamp(safeInt(saved.moveDelay?.delayMs, 0), 0, 250),
      minMoveMs: clamp(safeInt(saved.moveDelay?.minMoveMs, 0), 0, 500)
    };
    this.dropHunter = {
      ...defaultDropHunter(),
      autoClaim: saved.dropHunter?.autoClaim == null ? true : Boolean(saved.dropHunter.autoClaim)
    };
    this.punchPackets = 1;
    this.tick = null;
    this.exit = null;
    // The coco exit follows TIMING; the multi-shot punch exit is not used.
    this.exitMode = { enabled: false, punch: false };
    this.combat = defaultCombat();
    this.desiredMode = null;
    this.desiredTiming = null;
    this.desiredDropHunter = null;
    this.desiredPunchPackets = this.punchPackets;
    this.configAuthoritative = false;
    this.lastConfigPushAt = 0;
    this.configPushTimer = null;
    this.pingTimer = null;
    this.snapshotTimer = null;
    this.snapshotFlushTimer = null;
    this.lastSnapshotEmitAt = 0;
    this.ringBoardSocket = null;
    this.ringBoardConnected = false;
    this.ringBoardStatus = null;
    this.ringBoardReconnectTimer = null;
    this.ringBoardLastSceneAt = 0;
    this.ringBoardLastSceneKey = "";
    this.ringBoardScene = null;
    this.ringBoardLastSensorAt = 0;
    this.ringBoardLastCommand = "";
    this.ringBoardFireTimers = new Set();
    this.ringBoardFireTimerMeta = new Map();
    // The Timing switch survives a restart: on, it is pushed to the runtime as
    // soon as it connects.
    if (saved.timingOn === true) this.setTimingDesired(true);
    // Step walk (runtime): our walks go out one tile per tick. On unless turned off.
    this.stepWalk = saved.stepWalk !== false;
    this.allies = normalizeAllies(saved.allies ?? []);
    // Keko portraits read from the game (accountId -> { url, quality, name }).
    // Only the allies' ones are kept on disk, next to the settings.
    this.portraits = new Map();
    this.portraitVersion = 0;
    this.portraitsPath = path.join(path.dirname(this.settingsPath), "ally-portraits.json");
    // Every Simon cartel the runtime read, with its answer (for reviewing misreads).
    this.simonCartelDir = path.join(path.dirname(this.settingsPath), "simon-carteles");
    this.loadAllyPortraits();
    // Auto mode (29/09): the bot plays on its own and rejoins the Ring after each loss.
    this.autoRun = saved.autoRun === true && this.boardLicensed();
    // Random emotes (29/09): a laugh, a spit... now and then, never with a rival close in the Ring.
    this.emotes = saved.emotes !== false;
    // Self coco (01/10): "auto" throws our own coco when the unlock ambush can no
    // longer be covered by the guard; "off" never does. Default auto.
    this.cocoSelfMode = saved.cocoSelfMode === "off" ? "off" : "auto";
    // Hotkey for it (01/10): KeyboardEvent.code pressed in the game window ("" = off).
    this.cocoSelfKey = typeof saved.cocoSelfKey === "string" ? saved.cocoSelfKey.slice(0, 32) : "";
    this.advanced = normalizeAdvanced(saved.advanced);
    // Re-queue key (29/09): KeyboardEvent.code pressed in the game window ("" = off).
    this.requeueKey = typeof saved.requeueKey === "string" ? saved.requeueKey.slice(0, 32) : "";
    // EXPERIMENTAL "disparo libre" (02/10): el tick ignora el espaciado interno de
    // ~100 ms y dispara continuo en toda la ventana. OFF por defecto (es para medir).
    this.freeFire = saved.freeFire === true;
    // Simon Dice (06/10): the runtime reads each cartel and touches the asked
    // face (never on a red band). Off by default; delayMs = wait before touching.
    this.simon = normalizeSimon(saved.simon);
    this.simonStatus = null;
    this.stepClick = normalizeStepClick({ ...saved.stepClick, enabled: false });
    this.stepClickStatus = null;
    this.stepClickStateAt = 0;
  }

  start() {
    this.startTcpServer();
    this.pingTimer = setInterval(() => this.pingLoop(), 1000);
    this.snapshotTimer = setInterval(() => this.emitSnapshot(), SNAPSHOT_MS);
    if (this.ringBoardEnabled) {
      this.ringBoardReconnectTimer = setInterval(() => this.ensureRingBoardBridge(), 1000);
      setTimeout(() => this.ensureRingBoardBridge(), 600);
    }
    this.log(`Controller build ${CONTROLLER_BUILD}`);
  }

  stop() {
    clearInterval(this.pingTimer);
    clearInterval(this.snapshotTimer);
    clearInterval(this.ringBoardReconnectTimer);
    clearTimeout(this.snapshotFlushTimer);
    clearTimeout(this.configPushTimer);
    this.clearRingBoardFireTimers();
    if (this.ringBoardSocket) {
      this.ringBoardSocket.close();
    }
    if (this.swfSocket) {
      this.swfSocket.destroy();
    }
    if (this.tcpServer) {
      this.tcpServer.close();
    }
  }

  suspendForLicense() {
    this.stopModes();
    this.setRingBoardArmed(false);
    for (const config of [
      { type: "auto_ring_config", enabled: false },
      { type: "emote_config", enabled: false },
      { type: "coco_guard_config", selfMode: "off" },
      { type: "coco_self_key_config", code: "" },
      { type: "requeue_hotkey_config", code: "" },
      { type: "free_fire_config", enabled: false },
      { type: "step_walk_config", enabled: false }
    ]) this.sendToSwf(config);
    this.stop();
  }

  loadSettings() {
    try {
      if (!this.settingsPath || !fs.existsSync(this.settingsPath)) {
        return {};
      }
      const data = JSON.parse(fs.readFileSync(this.settingsPath, "utf8"));
      return data && typeof data === "object" ? data : {};
    } catch {
      return {};
    }
  }

  persistSettings() {
    try {
      const settings = {
        timing: { ...this.timing, enabled: false },
        timingOn: this.desiredMode === "TIMING" && Boolean(this.timing.enabled),
        timingHotkey: this.timingHotkey,
        stepWalk: this.stepWalk !== false,
        allies: this.allies,
        autoRun: this.autoRun === true,
        emotes: this.emotes !== false,
        cocoSelfMode: this.cocoSelfMode === "off" ? "off" : "auto",
        cocoSelfKey: this.cocoSelfKey || "",
        advanced: this.advanced,
        requeueKey: this.requeueKey || "",
        freeFire: this.freeFire === true,
        simon: this.simon,
        stepClick: { ...this.stepClick, enabled: false },
        moveDelay: { delayMs: this.moveDelay.delayMs, minMoveMs: this.moveDelay.minMoveMs },
        dropHunter: { autoClaim: this.dropHunter.autoClaim },
        exit: { enabled: this.exitMode.enabled, punch: this.exitMode.punch },
        punchPackets: clamp(safeInt(this.desiredPunchPackets || this.punchPackets, 1), 1, PUNCH_PACKETS_MAX),
        tickAim: this.tickAim ?? null,
        moveBrain: this.moveBrain
      };
      fs.mkdirSync(path.dirname(this.settingsPath), { recursive: true });
      const tmpPath = `${this.settingsPath}.${process.pid}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 2), "utf8");
      fs.renameSync(tmpPath, this.settingsPath);
    } catch (error) {
      this.log(`No pude guardar settings: ${error.message}`);
    }
  }

  // UI edits before "Aplicar": keep them so a restart does not lose them.
  saveDraftConfig(mode, payload = {}) {
    if (String(mode || "").toUpperCase() !== "TIMING") {
      return false;
    }
    this.timing = normalizeTimingConfig({ ...payload, enabled: this.timing.enabled }, this.timing);
    this.persistSettings();
    this.emitSnapshot();
    return true;
  }

  // ---- :9999 bridge --------------------------------------------------------

  startTcpServer() {
    const server = net.createServer((socket) => this.handleTcpConnection(socket));
    this.tcpServer = server;
    let retried = false;
    this.tcpReady = new Promise((resolve, reject) => {
      server.on("error", (error) => {
        if (this.autoPort && !retried && error.code === "EADDRINUSE") {
          retried = true;
          this.log(`Puerto ${this.port} ocupado; buscando un puerto libre para este Hub.`);
          server.listen(0, "127.0.0.1");
          return;
        }
        this.log(`ERROR: no se pudo abrir el puerto ${this.port}: ${error.message}`);
        reject(new Error(`No se pudo iniciar la conexión del Hub: ${error.message}`));
      });
      server.once("listening", () => {
        this.port = server.address().port;
        this.log(`TCP server en 127.0.0.1:${this.port}`);
        resolve(this.port);
      });
      server.listen(this.port, "127.0.0.1");
    });
    // Startup also serves legacy callers that do not await TCP readiness.
    this.tcpReady.catch(() => {});
  }

  async waitForTcpReady() {
    if (!this.tcpReady) throw new Error("La conexión del Hub todavía no se inició.");
    const port = await this.tcpReady;
    if (!this.tcpServer?.listening) throw new Error("La conexión del Hub está detenida.");
    return port;
  }

  handleTcpConnection(socket) {
    socket.setNoDelay(true);
    const addr = { host: socket.remoteAddress || "127.0.0.1", port: socket.remotePort || 0 };
    let buffer = Buffer.alloc(0);
    let closeReason = "cerrada";
    let registered = false;

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      let splitAt = buffer.indexOf(0);
      while (splitAt >= 0) {
        const raw = buffer.subarray(0, splitAt).toString("utf8").trim();
        buffer = buffer.subarray(splitAt + 1);
        splitAt = buffer.indexOf(0);
        if (!raw || raw.startsWith("<")) {
          continue;
        }
        if (!registered) {
          registered = true;
          this.registerSwfSocket(socket, addr);
        }
        let message = null;
        try {
          message = JSON.parse(raw);
        } catch {
          this.log(`JSON_ERR: ${raw.slice(0, 80)}`);
          continue;
        }
        try {
          this.handleSwfMessage(message);
        } catch (error) {
          this.log(`ERROR procesando ${String(message?.type || "?")}: ${error.message}`);
        }
      }
    });

    socket.on("error", (error) => {
      closeReason = `error socket: ${error.message}`;
    });
    socket.on("close", () => {
      if (this.swfSocket === socket) {
        this.swfSocket = null;
        this.swfAddr = null;
        this.bridgePingSentAt = 0;
        this.serverPingMs = null;
        this.bridgePingMs = null;
        this.tick = null;
        this.exit = null;
        this.disableStepClick();
        this.stepClickStatus = null;
        this.log(`Cliente desconectado (${closeReason})`);
        this.emitSnapshot();
      }
    });
  }

  registerSwfSocket(socket, addr) {
    if (this.swfSocket && this.swfSocket !== socket) {
      this.swfSocket.destroy();
    }
    this.swfSocket = socket;
    if (this.punchIsolationPhase != null) {
      // Establish the overlay before the saved mode/settings can enable a
      // shot, including when the native client reconnects to this Hub.
      this.sendToSwf({ type: "punch_isolation_config", enabled: true, phaseMs: this.punchIsolationPhase });
      this.log(`Timing: T${this.punchIsolationPhase >= 0 ? "+" : ""}${this.punchIsolationPhase} ms; un pedido por paso; fase fija`);
    }
    this.disableStepClick();
    this.stepClickStatus = null;
    this.swfAddr = addr;
    this.bridgePingSentAt = 0;
    this.serverPingMs = null;
    this.bridgePingMs = null;
    this.log(`Cliente conectado desde ${addr.host}:${addr.port}`);
    setTimeout(() => this.pushPerformanceConfig(), 120);
    setTimeout(() => this.sendToSwf({ type: "exit_config", ...this.exitMode }), 160);
    setTimeout(() => this.sendToSwf({ type: "step_walk_config", enabled: this.stepWalk !== false }), 180);
    setTimeout(() => this.pushAllies(), 190);
    setTimeout(() => this.pushAutoRun(), 200);
    setTimeout(() => this.pushEmotes(), 210);
    setTimeout(() => this.pushCocoSelf(), 215);
    setTimeout(() => this.pushCocoSelfKey(), 216);
    setTimeout(() => this.pushAdvanced(), 220);
    setTimeout(() => this.pushRequeueKey(), 230);
    setTimeout(() => this.sendToSwf({ type: "free_fire_config", enabled: this.freeFire === true }), 235);
    setTimeout(() => this.pushSimon(), 245);
    setTimeout(() => this.pushStepClick(), 255);
    setTimeout(() => this.pushDesiredConfig(true), 220);
    this.emitSnapshot();
  }

  handleSwfMessage(data) {
    const type = String(data?.type || "");
    if (type === "step_click_state") {
      this.stepClickStatus = normalizeStepClickStatus(data.status || {});
      this.stepClickStateAt = Date.now();
      this.emitSnapshot(true);
      return;
    }
    if (type === "state") {
      // A game left open across Hub restarts keeps boot() ready and does not
      // repeat hello. Its periodic state still identifies the loaded runtime.
      if (typeof data.bridgeBuild === "string" && data.bridgeBuild && this.bridgeBuild !== data.bridgeBuild) {
        this.bridgeBuild = data.bridgeBuild;
        this.log(`Runtime ${this.bridgeBuild} | selfId=${safeInt(data.selfId, -1)}`);
      }
      this.updateServerPing(data);
      this.selfId = safeInt(data.selfId, this.selfId);
      this.selectedTarget = safeInt(data.selectedId, this.selectedTarget);
      this.noteSwfClock(data);
      this.updatePlayers(Array.isArray(data.players) ? data.players : []);
      if (this.allies.some((a) => !a.accountId)) this.bindAllyNames();
      if (data.simon && typeof data.simon === "object") this.simonStatus = normalizeSimonStatus(data.simon);
      if (data.stepClick && typeof data.stepClick === "object") {
        this.stepClickStatus = normalizeStepClickStatus(data.stepClick);
        this.stepClickStateAt = Date.now();
      }
      if (data.tick) {
        this.tick = normalizeTickStatus(data.tick);
      }
      if (data.exit) {
        this.exit = normalizeExitStatus(data.exit);
      }
      this.pushRingBoardSensors(data);
      return;
    }
    if (type === "simon_cartel") {
      this.saveSimonCartel(data);
      return;
    }
    if (type === "timing_target") {
      // Sent by the runtime as each automatic punch leaves: the UI target field
      // follows the engine without waiting for the next state.
      this.tick = { ...(this.tick || normalizeTickStatus({})), lastTargetId: safeInt(data.targetId, -1), lastTargetReason: String(data.reason || "").slice(0, 32) };
      this.emitSnapshot(true);
      return;
    }
    if (type === "scene_snapshot") {
      this.updateServerPing(data);
      this.noteSwfClock(data);
      this.updateRingBoardScene(data);
      return;
    }
    if (type === "config") {
      this.updateServerPing(data);
      this.noteSwfClock(data);
      this.applyConfigFromSwf(data);
      this.emitSnapshot();
      return;
    }
    if (type === "resolve_event") {
      this.noteSwfClock(data);
      this.noteCombat(data);
      this.pushRingBoardResolve(data);
      return;
    }
    if (type === "drop_hunter_event") {
      this.noteSwfClock(data);
      this.dropHunter = {
        ...this.dropHunter,
        enabled: Boolean(data.enabled ?? this.dropHunter.enabled),
        state: String(data.state || this.dropHunter.state || "IDLE"),
        keyword: String(data.keyword || this.dropHunter.keyword || ""),
        lastEvent: String(data.lastEvent || data.event || ""),
        dropId: safeInt(data.dropId, this.dropHunter.dropId),
        x: safeInt(data.x, this.dropHunter.x),
        y: safeInt(data.y, this.dropHunter.y),
        lastAt: Date.now()
      };
      this.log(`Drops ${this.dropHunter.state}: ${this.dropHunter.lastEvent}`);
      this.emitSnapshot();
      return;
    }
    if (type === "hello") {
      this.updateServerPing(data);
      this.selfId = safeInt(data.selfId, -1);
      this.bridgeBuild = String(data.bridgeBuild || "-");
      this.log(`Runtime ${this.bridgeBuild} | selfId=${this.selfId}`);
      this.pushAllies();
      this.pushAutoRun();
      this.pushEmotes();
      this.pushCocoSelf();
      this.pushCocoSelfKey();
      this.pushAdvanced();
      this.pushRequeueKey();
      this.emitSnapshot();
      return;
    }
    if (type === "pong") {
      this.updateBridgePing();
      return;
    }
    if (IGNORED_RUNTIME_MESSAGES.has(type)) {
      return;
    }
    this.log(`Mensaje del runtime: ${JSON.stringify(data).slice(0, 220)}`);
  }

  updateServerPing(data) {
    if (!Object.prototype.hasOwnProperty.call(data, "serverPingMs")) {
      return;
    }
    const value = safeInt(data.serverPingMs, -1);
    if (value < 0) {
      return;
    }
    this.serverPingMs = this.serverPingMs == null ? value : this.serverPingMs * 0.75 + value * 0.25;
  }

  updateBridgePing() {
    if (!this.bridgePingSentAt) {
      return;
    }
    const rtt = Date.now() - this.bridgePingSentAt;
    this.bridgePingSentAt = 0;
    if (rtt < 0 || rtt > 5000) {
      return;
    }
    this.bridgePingMs = this.bridgePingMs == null ? rtt : this.bridgePingMs * 0.7 + rtt * 0.3;
  }

  noteSwfClock(data) {
    const ts = safeInt(data?.ts, this.lastSwfTs || 0);
    if (ts > 0) {
      this.lastSwfTs = ts;
      this.lastSwfWall = Date.now();
    }
  }

  noteCombat(data) {
    const attackerId = safeInt(data.attackerId, -1);
    const defenderId = safeInt(data.defenderId, -1);
    if (this.selfId < 0 || (attackerId !== this.selfId && defenderId !== this.selfId)) {
      return;
    }
    this.combat = {
      hits: this.combat.hits + (attackerId === this.selfId ? 1 : 0),
      gotHit: this.combat.gotHit + (defenderId === this.selfId ? 1 : 0),
      lastAttackerId: attackerId,
      lastDefenderId: defenderId,
      lastAt: Date.now()
    };
  }

  updatePlayers(players) {
    const seen = new Set();
    for (const raw of players) {
      const id = safeInt(raw.id, -1);
      if (id < 0) {
        continue;
      }
      seen.add(id);
      const skinId = safeInt(raw.skin ?? raw.skinId, NaN);
      const sceneId = safeInt(raw.posId ?? raw.sceneId, id);
      const accountId = safeInt(raw.userId ?? raw.accountId, id);
      const isSelf = wireBool(raw.self ?? raw.isSelf) || id === this.selfId || sceneId === this.selfId || accountId === this.selfId;
      const combatState = normalizeCombatState(raw.combatState, raw.state);
      this.players.set(id, {
        id,
        mark: isSelf ? "SELF" : id === this.selectedTarget || raw.selected ? "SEL" : "",
        name: String(raw.name || ""),
        posId: sceneId,
        userId: accountId,
        state: combatState.state,
        combatState,
        skinId,
        skin: Number.isFinite(skinId) ? SKIN_NAMES[skinId] || `Skin ${skinId}` : String(raw.skin || ""),
        x: safeNumber(raw.x, 0),
        y: safeNumber(raw.y, 0),
        orient: safeInt(raw.orient ?? raw.orientation, 0),
        fromX: safeNumber(raw.fromX, safeNumber(raw.x, 0)),
        fromY: safeNumber(raw.fromY, safeNumber(raw.y, 0)),
        toX: safeNumber(raw.toX, safeNumber(raw.x, 0)),
        toY: safeNumber(raw.toY, safeNumber(raw.y, 0)),
        dirX: safeInt(raw.dirX, 0),
        dirY: safeInt(raw.dirY, 0),
        stepStartAt: safeInt(raw.stepStartAt, this.lastSwfTs || 0),
        stepDur: safeInt(raw.stepDur, 0),
        phase: Number.isFinite(Number(raw.phase)) ? Number(raw.phase) : 1,
        moving: wireBool(raw.moving),
        selected: wireBool(raw.selected) || id === this.selectedTarget,
        self: isSelf,
        cocoMs: safeInt(raw.cocoMs, 0),
        lockUntil: safeInt(raw.lockUntil, 0),
        walkFlag: safeInt(raw.walkFlag, 1),
        lastTurnAt: safeInt(raw.lastTurnAt, 0),
        facing: safeInt(raw.facing, 0),
        active: wireBool(raw.active)
      });
    }
    for (const id of Array.from(this.players.keys())) {
      if (!seen.has(id)) {
        this.players.delete(id);
      }
    }
    this.lastStateAt = Date.now();
  }

  // ---- config sync with the runtime -----------------------------------------

  applyConfigFromSwf(data) {
    if (this.configAuthoritative && !this.swfConfigMatchesDesired(data)) {
      setTimeout(() => this.pushDesiredConfig(), 80);
      return;
    }
    if (data.timing && String(data.timing.source || "STEP").toUpperCase() === "STEP") {
      this.timing = normalizeTimingConfig(data.timing, this.timing);
    }
    if (data.moveDelay) {
      this.moveDelay = {
        enabled: Boolean(data.moveDelay.enabled),
        delayMs: clamp(safeInt(data.moveDelay.delayMs, this.moveDelay.delayMs), 0, 250),
        minMoveMs: clamp(safeInt(data.moveDelay.minMoveMs, this.moveDelay.minMoveMs), 0, 500)
      };
    }
    if (data.dropHunter) {
      this.dropHunter = {
        ...this.dropHunter,
        enabled: Boolean(data.dropHunter.enabled),
        autoClaim: Boolean(data.dropHunter.autoClaim ?? this.dropHunter.autoClaim),
        state: String(data.dropHunter.state || this.dropHunter.state || "IDLE"),
        keyword: String(data.dropHunter.keyword || ""),
        lastEvent: String(data.dropHunter.lastEvent || this.dropHunter.lastEvent || ""),
        dropId: safeInt(data.dropHunter.dropId, this.dropHunter.dropId),
        x: safeInt(data.dropHunter.x, this.dropHunter.x),
        y: safeInt(data.dropHunter.y, this.dropHunter.y),
        lastAt: Date.now()
      };
    }
    this.punchPackets = clamp(safeInt(data.punchPackets, this.punchPackets), 1, PUNCH_PACKETS_MAX);
  }

  swfConfigMatchesDesired(data) {
    const desiredPackets = clamp(safeInt(this.desiredPunchPackets, 1), 1, PUNCH_PACKETS_MAX);
    if (clamp(safeInt(data.punchPackets, desiredPackets), 1, PUNCH_PACKETS_MAX) !== desiredPackets) {
      return false;
    }
    const timing = data.timing || {};
    const moveDelay = data.moveDelay || {};
    if (this.desiredMode === "OFF") {
      return !Boolean(timing.enabled) && !Boolean(moveDelay.enabled) && !Boolean(data.dropHunter?.enabled);
    }
    if (this.desiredMode === "STEP_CLICK") return !Boolean(timing.enabled) && !Boolean(moveDelay.enabled);
    if (this.desiredMode !== "TIMING" || !this.desiredTiming) {
      return true;
    }
    const want = this.desiredTiming;
    const wantTick = want.tick;
    const tick = timing.tick || {};
    return (
      Boolean(timing.enabled) === Boolean(want.enabled) &&
      String(timing.source || "STEP").toUpperCase() === "STEP" &&
      normalizeStepAnchor(timing.stepAnchor, "SELF") === want.stepAnchor &&
      safeInt(timing.start, -1) === want.start &&
      safeInt(timing.end, -1) === want.end &&
      Boolean(timing.dualWindow) === want.dualWindow &&
      safeInt(timing.start2, -1) === want.start2 &&
      safeInt(timing.end2, -1) === want.end2 &&
      safeInt(timing.rate, -1) === want.rate &&
      safeInt(timing.mult, -1) === want.mult &&
      Boolean(timing.randomInterval) === want.randomInterval &&
      safeInt(timing.intervalMin, -1) === want.intervalMin &&
      safeInt(timing.intervalMax, -1) === want.intervalMax &&
      Boolean(timing.randomMultiplier) === want.randomMultiplier &&
      safeInt(timing.multMin, -1) === want.multMin &&
      safeInt(timing.multMax, -1) === want.multMax &&
      safeInt(timing.clicks, -1) === want.clicks &&
      safeInt(timing.gap, -1) === want.gap &&
      String(timing.profile || "") === want.profile &&
      Boolean(timing.power) === want.power &&
      Boolean(timing.stepScale) === want.stepScale &&
      Boolean(timing.landing?.enabled) === want.landing.enabled &&
      Boolean(tick.enabled) === wantTick.enabled &&
      Boolean(tick.auto) === wantTick.auto &&
      Boolean(tick.single) === wantTick.single &&
      safeInt(tick.offsetMs, -1) === wantTick.offsetMs &&
      safeInt(tick.shots, -1) === wantTick.shots &&
      safeInt(tick.spacingMs, -1) === wantTick.spacingMs &&
      safeInt(tick.burst, -1) === wantTick.burst &&
      safeInt(tick.burstGapMs, -1) === wantTick.burstGapMs &&
      Boolean(tick.blind) === wantTick.blind &&
      Boolean(tick.reactive) === wantTick.reactive &&
      Boolean(tick.autoCal) === wantTick.autoCal &&
      Boolean(moveDelay.enabled) === Boolean(this.moveDelay.enabled) &&
      safeInt(moveDelay.delayMs, this.moveDelay.delayMs) === this.moveDelay.delayMs &&
      safeInt(moveDelay.minMoveMs, this.moveDelay.minMoveMs) === this.moveDelay.minMoveMs
    );
  }

  pushDesiredConfig(force = false) {
    if (!this.configAuthoritative || !this.swfSocket) {
      return;
    }
    const now = Date.now();
    if (!force && now - this.lastConfigPushAt < 350) {
      // Throttled, not dropped: push once the window allows it.
      if (!this.configPushTimer) {
        this.configPushTimer = setTimeout(() => {
          this.configPushTimer = null;
          this.pushDesiredConfig();
        }, 350 - (now - this.lastConfigPushAt));
      }
      return;
    }
    clearTimeout(this.configPushTimer);
    this.configPushTimer = null;
    this.lastConfigPushAt = now;
    this.sendToSwf({ type: "punch_config", packets: clamp(safeInt(this.desiredPunchPackets, 1), 1, PUNCH_PACKETS_MAX) });
    if (this.desiredMode === "STEP_CLICK") {
      this.pushOffConfig();
      this.pushStepClick();
      return;
    }
    if (this.desiredMode === "OFF") {
      this.pushOffConfig();
      return;
    }
    if (this.desiredMode === "TIMING" && this.desiredTiming) {
      this.sendToSwf({ ...this.desiredTiming });
      this.sendToSwf({ type: "exit_config", ...this.exitMode });
    }
    this.pushMovePunchConfig();
    if (this.desiredDropHunter) {
      this.sendToSwf({ ...this.desiredDropHunter });
    }
  }

  pushOffConfig() {
    if (!this.swfSocket) {
      return;
    }
    this.sendToSwf({ type: "timing_config", enabled: false, source: "STEP" });
    this.sendToSwf({ type: "move_punch_config", enabled: false, delayMs: this.moveDelay.delayMs, minMoveMs: this.moveDelay.minMoveMs });
    this.sendToSwf({ type: "drop_hunter_config", enabled: false, autoReturn: true, autoClaim: this.dropHunter.autoClaim });
    if (!this.stepClick?.enabled) this.pushStepClick();
  }

  pushMovePunchConfig() {
    if (!this.swfSocket) {
      return;
    }
    this.sendToSwf({
      type: "move_punch_config",
      enabled: Boolean(this.moveDelay.enabled),
      delayMs: this.moveDelay.delayMs,
      minMoveMs: this.moveDelay.minMoveMs
    });
  }

  pushPerformanceConfig() {
    if (!this.swfSocket) {
      return;
    }
    this.sendToSwf({ type: "performance_config", enabled: true, ...RUNTIME_PERFORMANCE, packetBus: false });
  }

  // ---- UI actions -----------------------------------------------------------

  // The Hub has one TIMING mode: one click per tick at the learned phase, at
  // whoever will be in contact, plus the instant reaction and the coco exit.
  // Nothing to configure: on or off.
  singleTiming(enabled) {
    return normalizeTimingConfig({
      ...defaultTiming(),
      enabled: Boolean(enabled),
      landing: { ...defaultTiming().landing, enabled: false },
      tick: { enabled: true, auto: this.tickAim == null, single: true, blind: true, reactive: this.advanced?.reactive !== false, autoCal: true, offsetMs: this.tickAim ?? 10, shots: 1, spacingMs: 110, burst: 1, burstGapMs: 4 }
    });
  }

  setTimingDesired(enabled) {
    const timing = this.singleTiming(enabled);
    this.desiredPunchPackets = 1;
    this.exitMode = { enabled: timing.enabled, punch: false };
    const msg = timingMessage(timing, timing.enabled);
    this.timing = timing;
    this.desiredMode = "TIMING";
    this.desiredTiming = { ...msg, stepAnchor: timing.stepAnchor, landing: { ...timing.landing }, tick: { ...timing.tick } };
    this.configAuthoritative = true;
    return timing;
  }

  applyTiming(payload = {}) {
    if (payload.enabled) this.disableStepClick();
    const timing = this.setTimingDesired(payload.enabled);
    this.sendToSwf({ type: "exit_config", ...this.exitMode });
    this.persistSettings();
    this.pushDesiredConfig(true);
    this.log(`TIMING -> ${timing.enabled ? "ON" : "OFF"}`);
    this.emitSnapshot();
    return true;
  }

  applyMovePunch(payload = {}) {
    if (payload.enabled) this.disableStepClick();
    this.moveDelay = {
      enabled: Boolean(payload.enabled),
      delayMs: clamp(safeInt(payload.delayMs, this.moveDelay.delayMs), 0, 250),
      minMoveMs: clamp(safeInt(payload.minMoveMs ?? payload.minGapMs, this.moveDelay.minMoveMs), 0, 500)
    };
    this.configAuthoritative = true;
    this.persistSettings();
    this.pushMovePunchConfig();
    this.log(`Punch al caminar -> ${this.moveDelay.enabled ? "ON" : "OFF"} delay=${this.moveDelay.delayMs}ms gap=${this.moveDelay.minMoveMs}ms`);
    this.emitSnapshot();
    return true;
  }

  applyDropHunter(payload = {}) {
    const msg = {
      type: "drop_hunter_config",
      enabled: Boolean(payload.enabled),
      autoReturn: true,
      autoClaim: Boolean(payload.autoClaim ?? true)
    };
    this.dropHunter = {
      ...this.dropHunter,
      enabled: msg.enabled,
      autoClaim: msg.autoClaim,
      state: msg.enabled ? this.dropHunter.state || "IDLE" : "IDLE",
      lastEvent: msg.enabled ? "armed" : "off",
      lastAt: Date.now()
    };
    this.desiredDropHunter = { ...msg };
    this.configAuthoritative = true;
    this.persistSettings();
    this.sendToSwf(msg);
    this.log(`Drops -> ${msg.enabled ? "ON" : "OFF"} claim=${msg.autoClaim ? "on" : "off"}`);
    this.emitSnapshot();
    return true;
  }

  setPunchPackets(value) {
    const packets = clamp(safeInt(value, 1), 1, PUNCH_PACKETS_MAX);
    this.punchPackets = packets;
    this.desiredPunchPackets = packets;
    this.persistSettings();
    this.sendToSwf({ type: "punch_config", packets });
    if (this.configAuthoritative) {
      this.pushDesiredConfig();
    }
    this.log(`Punch por disparo -> ${packets}`);
    this.emitSnapshot();
    return true;
  }

  applyStepWalk(payload = {}) {
    this.stepWalk = Boolean(payload.enabled);
    this.persistSettings();
    this.sendToSwf({ type: "step_walk_config", enabled: this.stepWalk });
    this.log(`Caminar paso a paso -> ${this.stepWalk ? "ON" : "OFF"}`);
    this.emitSnapshot();
    return true;
  }

  pushSimon() {
    this.sendToSwf({ type: "simon_config", enabled: this.simon.enabled, delayMs: this.simon.delayMs });
  }

  pushStepClick() {
    this.sendToSwf({ type: "step_click_config", ...this.stepClick });
  }

  disableStepClick() {
    if (!this.stepClick?.enabled) return;
    this.stepClick = { ...this.stepClick, enabled: false };
    this.pushStepClick();
    if (this.desiredMode === "STEP_CLICK") this.desiredMode = "OFF";
  }

  applyStepClick(payload = {}) {
    const defined = Object.fromEntries(Object.entries(payload).filter(([key, value]) => ["enabled", "source", "startMs", "endMs", "intervalMs", "clicks"].includes(key) && value !== undefined));
    const merged = { ...this.stepClick, ...defined };
    if (defined.clicks != null && defined.intervalMs == null) delete merged.intervalMs;
    const next = normalizeStepClick(merged);
    if (next.enabled && this.swfSocket && !this.stepClickStatus) throw new Error("Reabre el juego desde este Hub para cargar Autoclick por paso.");
    const activating = next.enabled && !this.stepClick.enabled;
    if (activating) {
      this.stopModes();
      this.autoRun = false;
      this.pushAutoRun();
      this.clearRingBoardFireTimers();
      this.setRingBoardArmed(false);
      this.simon = { ...this.simon, enabled: false };
      this.pushSimon();
      this.freeFire = false;
      this.sendToSwf({ type: "free_fire_config", enabled: false });
      this.exitMode = { enabled: false, punch: false };
      this.sendToSwf({ type: "exit_config", ...this.exitMode });
    }
    this.stepClick = next;
    if (next.enabled) {
      this.desiredMode = "STEP_CLICK";
      this.desiredTiming = null;
      this.configAuthoritative = true;
    } else if (this.desiredMode === "STEP_CLICK") this.desiredMode = "OFF";
    this.persistSettings();
    this.pushStepClick();
    this.log(`Autoclick por paso -> ${next.enabled ? "ON" : "OFF"} ${next.source} ${next.startMs}-${next.endMs} ms cada ${next.intervalMs} ms (solo fichado)`);
    this.emitSnapshot(true);
    return true;
  }

  applySimon(payload = {}) {
    if (payload.enabled) this.disableStepClick();
    const wasOn = this.simon.enabled;
    this.simon = normalizeSimon({ ...this.simon, ...(payload || {}) });
    this.persistSettings();
    this.pushSimon();
    // Simon on turns the Timing off: nobody gets punched mid game.
    if (this.simon.enabled && !wasOn && this.timing?.enabled) this.applyTiming({ enabled: false });
    this.log(`Simon Dice -> ${this.simon.enabled ? "ON" : "OFF"}${this.simon.delayMs ? ` (espera ${this.simon.delayMs} ms)` : ""}`);
    this.emitSnapshot(true);
    return true;
  }

  // File name: date, round, answer (cell 1-8 or "roja"), separation; "dudoso"
  // when two faces read almost alike. The folder keeps the newest 400.
  saveSimonCartel(data) {
    const b64 = String(data.b64 || "");
    if (!b64 || b64.length > 400000) return;
    const round = Math.max(0, safeInt(data.round, 0));
    const sep = Number.isFinite(Number(data.sep)) ? Number(data.sep) : null;
    const answer = data.error ? "error" : data.go === false ? "roja" : `c${safeInt(data.cell, -1) + 1}`;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23);
    const doubtful = sep != null && sep < 0.35;
    const name = `${stamp}_r${round}_${answer}${sep != null ? `_sep${sep.toFixed(2)}` : ""}${doubtful ? "_dudoso" : ""}`;
    try {
      fs.mkdirSync(this.simonCartelDir, { recursive: true });
      fs.writeFileSync(path.join(this.simonCartelDir, `${name}.webp`), Buffer.from(b64, "base64"));
      fs.appendFileSync(path.join(this.simonCartelDir, "carteles.ndjson"), JSON.stringify({
        at: new Date().toISOString(), file: `${name}.webp`, round, timeMs: safeInt(data.timeMs, 0), go: data.go !== false,
        cell: Number.isInteger(data.cell) ? data.cell : null, sep, conf: Number.isFinite(Number(data.conf)) ? Number(data.conf) : null,
        scores: Array.isArray(data.scores) ? data.scores.slice(0, 8) : null, readMs: Number(data.readMs) || null, error: String(data.error || "").slice(0, 80)
      }) + "\n");
      const files = fs.readdirSync(this.simonCartelDir).filter((f) => f.endsWith(".webp")).sort();
      for (const f of files.slice(0, Math.max(0, files.length - 400))) fs.unlinkSync(path.join(this.simonCartelDir, f));
    } catch (error) {
      this.log(`No se pudo guardar el cartel de Simon: ${error.message}`);
    }
  }

  applyFreeFire(payload = {}) {
    if (payload.enabled) this.disableStepClick();
    this.freeFire = Boolean(payload.enabled);
    this.persistSettings();
    this.sendToSwf({ type: "free_fire_config", enabled: this.freeFire });
    this.log(`Disparo libre (experimental) -> ${this.freeFire ? "ON" : "OFF"}`);
    this.emitSnapshot();
    return true;
  }

  pushAllies() {
    const accounts = this.allies.filter((a) => a.accountId).map((a) => a.accountId);
    const names = this.allies.filter((a) => !a.accountId && a.name).map((a) => a.name);
    this.sendToSwf({ type: "ally_config", accounts, names });
  }

  alliesChanged(reason) {
    this.persistSettings();
    this.saveAllyPortraits();
    this.pushAllies();
    const list = this.allies.map((a) => a.name || `cuenta ${a.accountId}`).join(" · ");
    this.log(`Aliados -> ${list || "(ninguno)"}${reason ? ` (${reason})` : ""}`);
    this.emitSnapshot(true);
    return true;
  }

  // One click in the Hub: a room player becomes an ally or stops being one.
  toggleAlly(value) {
    const accountId = Number(value?.accountId);
    const name = String(value?.name || "").trim().slice(0, 40);
    const hasId = Number.isSafeInteger(accountId) && accountId > 0;
    if (!hasId && !name) throw new Error("Jugador inválido.");
    const isSame = (a) => (hasId && a.accountId === accountId) || (!a.accountId && name && a.name.toLowerCase() === name.toLowerCase());
    if (this.allies.some(isSame)) {
      this.allies = this.allies.filter((a) => !isSame(a));
      return this.alliesChanged(`quitado ${name || accountId}`);
    }
    if (this.allies.length >= ALLIES_MAX) throw new Error(`Máximo ${ALLIES_MAX} aliados.`);
    this.allies = normalizeAllies([...this.allies, { accountId: hasId ? accountId : null, name }]);
    return this.alliesChanged(`agregado ${name || accountId}`);
  }

  // Exact name, typed by hand: bound to the account if that player is here.
  addAllyByName(value) {
    const name = String(value || "").trim().slice(0, 40);
    if (!name) throw new Error("Escribe el nombre exacto del jugador.");
    const here = Array.from(this.players.values()).find((p) => !p.self && String(p.name || "").trim().toLowerCase() === name.toLowerCase());
    const accountId = here && here.userId > 0 ? here.userId : null;
    if (this.allies.some((a) => (accountId && a.accountId === accountId) || a.name.toLowerCase() === name.toLowerCase())) return true;
    if (this.allies.length >= ALLIES_MAX) throw new Error(`Máximo ${ALLIES_MAX} aliados.`);
    this.allies = normalizeAllies([...this.allies, { accountId, name: here ? here.name : name }]);
    return this.alliesChanged(`agregado ${name}`);
  }

  removeAlly(value) {
    const accountId = Number(value?.accountId);
    const name = String(value?.name || "").trim().toLowerCase();
    const before = this.allies.length;
    this.allies = this.allies.filter((a) => !((accountId > 0 && a.accountId === accountId) || (!a.accountId && name && a.name.toLowerCase() === name)));
    return before === this.allies.length ? true : this.alliesChanged("quitado");
  }

  // A name-only ally seen in the room is bound to its account (and an account
  // ally gets its current name), so a rename keeps it an ally.
  bindAllyNames() {
    let changed = false;
    const players = Array.from(this.players.values());
    for (const ally of this.allies) {
      if (ally.accountId) {
        const p = players.find((x) => x.userId === ally.accountId && x.name);
        if (p && p.name.slice(0, 40) !== ally.name) { ally.name = p.name.slice(0, 40); changed = true; }
        continue;
      }
      const p = players.find((x) => !x.self && x.userId > 0 && String(x.name || "").trim().toLowerCase() === ally.name.toLowerCase());
      if (p && !this.allies.some((a) => a.accountId === p.userId)) { ally.accountId = p.userId; changed = true; }
    }
    if (changed) this.alliesChanged("vinculado a la cuenta");
  }

  notePortrait(value) {
    const accountId = Number(value?.accountId);
    const url = String(value?.url || "");
    if (!(Number.isSafeInteger(accountId) && accountId > 0) || !/^data:image\/(png|webp|jpeg);base64,/.test(url) || url.length > 200000) return;
    const quality = Number(value.quality) || 0;
    const prev = this.portraits.get(accountId);
    if (prev && prev.quality > quality) return;
    this.portraits.set(accountId, { url, quality, name: String(value.name || "").slice(0, 40), at: Date.now() });
    // Bounded: drop the oldest non-ally portraits.
    if (this.portraits.size > 300) {
      const allyIds = new Set(this.allies.map((a) => a.accountId).filter(Boolean));
      const old = Array.from(this.portraits.entries()).filter(([id]) => !allyIds.has(id)).sort((a, b) => a[1].at - b[1].at);
      for (const [id] of old.slice(0, this.portraits.size - 300)) this.portraits.delete(id);
    }
    this.portraitVersion++;
    if (this.allies.some((a) => a.accountId === accountId)) this.saveAllyPortraits();
    this.emitSnapshot();
  }

  getPortraits() {
    const out = {};
    for (const [id, p] of this.portraits) out[id] = p.url;
    return out;
  }

  loadAllyPortraits() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.portraitsPath, "utf8"));
      for (const [id, p] of Object.entries(saved || {})) {
        const accountId = Number(id);
        if (Number.isSafeInteger(accountId) && accountId > 0 && /^data:image\//.test(String(p?.url || ""))) {
          this.portraits.set(accountId, { url: String(p.url), quality: Number(p.quality) || 0, name: String(p.name || ""), at: 0 });
        }
      }
    } catch {}
  }

  saveAllyPortraits() {
    clearTimeout(this.portraitSaveTimer);
    this.portraitSaveTimer = setTimeout(() => {
      const out = {};
      for (const ally of this.allies) {
        const p = ally.accountId && this.portraits.get(ally.accountId);
        if (p) out[ally.accountId] = { url: p.url, quality: p.quality, name: ally.name };
      }
      try { fs.writeFileSync(this.portraitsPath, JSON.stringify(out)); } catch (error) { this.log(`No se pudieron guardar los retratos: ${error.message}`); }
    }, 1000);
    this.portraitSaveTimer.unref?.();
  }

  pushRequeueKey() {
    this.sendToSwf({ type: "requeue_hotkey_config", code: this.requeueKey || "" });
  }

  setRequeueKey(code) {
    this.requeueKey = typeof code === "string" ? code.slice(0, 32) : "";
    this.persistSettings();
    this.pushRequeueKey();
    this.log(`Tecla para reinscribirse -> ${this.requeueKey || "(ninguna)"}`);
    this.emitSnapshot();
    return true;
  }

  requeueNow() {
    this.sendToSwf({ type: "requeue_now" });
    this.log("Reinscribirse: salir del Ring y volver a anotarse");
    return true;
  }

  pushAdvanced() {
    const a = this.advanced;
    this.sendToSwf({ type: "tick_burst_config", count: a.burst });
    this.sendToSwf({ type: "tick_advanced_config", sweep: a.sweep, repeatMs: a.repeatMs });
  }

  setAdvanced(value) {
    const reactiveBefore = this.advanced.reactive;
    this.advanced = value === "defaults" ? { ...ADVANCED_DEFAULTS } : normalizeAdvanced({ ...this.advanced, ...(value || {}) });
    this.persistSettings();
    this.pushAdvanced();
    // Reaction on/off travels in the tick config.
    if (this.advanced.reactive !== reactiveBefore) this.applyTiming({ enabled: Boolean(this.timing?.enabled) });
    const a = this.advanced;
    this.log(`Avanzado -> ráfaga ${a.burst}, segundo click ${a.repeatMs ? `+${a.repeatMs} ms` : "no"}, barrido ${a.sweep ? "sí" : "no"}, reacción ${a.reactive ? "sí" : "no"}`);
    this.emitSnapshot();
    return true;
  }

  pushEmotes() {
    this.sendToSwf({ type: "emote_config", enabled: this.emotes !== false, minMs: 25000, maxMs: 70000 });
  }

  setEmotes(value) {
    this.emotes = Boolean(value);
    this.persistSettings();
    this.pushEmotes();
    this.log(`Emotes al azar -> ${this.emotes ? "ON" : "OFF"}`);
    this.emitSnapshot();
    return true;
  }

  pushCocoSelf() {
    this.sendToSwf({ type: "coco_guard_config", selfMode: this.cocoSelfMode === "off" ? "off" : "auto" });
  }

  pushCocoSelfKey() {
    this.sendToSwf({ type: "coco_self_key_config", code: this.cocoSelfKey || "" });
  }

  setCocoSelfKey(code) {
    this.cocoSelfKey = typeof code === "string" ? code.slice(0, 32) : "";
    this.persistSettings();
    this.pushCocoSelfKey();
    this.log(`Coco propio: tecla ${this.cocoSelfKey ? this.cocoSelfKey : "quitada"}`);
    this.emitSnapshot();
    return true;
  }

  setCocoSelf(mode) {
    this.cocoSelfMode = mode === "off" ? "off" : "auto";
    this.persistSettings();
    this.pushCocoSelf();
    this.log(`Coco propio -> ${this.cocoSelfMode === "auto" ? "AUTO" : "OFF"}`);
    this.emitSnapshot();
    return true;
  }

  cocoSelfNow() {
    // Manual throw: the runtime applies the 3-per-round budget and reports.
    this.sendToSwf({ type: "coco_self" });
    this.log("Coco propio: tiro manual pedido");
    return true;
  }

  pushAutoRun() {
    this.sendToSwf({ type: "auto_ring_config", enabled: this.autoRun === true });
  }

  setAutoRun(value) {
    if (value && !this.boardLicensed()) throw new Error("El modo automático requiere Board Pro.");
    this.autoRun = Boolean(value);
    this.persistSettings();
    this.pushAutoRun();
    if (this.autoRun) {
      this.applyTiming({ enabled: true });
      this.setRingBoardArmed(true);
    } else {
      this.setRingBoardArmed(false);
    }
    this.log(`Modo automático -> ${this.autoRun ? "ON (se mueve, pega, sale al perder y se reinscribe)" : "OFF"}`);
    this.emitSnapshot();
    return true;
  }

  setAllies(value) {
    this.allies = normalizeAllies(value);
    return this.alliesChanged("");
  }

  applyExit(payload = {}) {
    if (payload.enabled || payload.punch) this.disableStepClick();
    this.exitMode = {
      enabled: payload.enabled == null ? this.exitMode.enabled : Boolean(payload.enabled),
      punch: payload.punch == null ? this.exitMode.punch : Boolean(payload.punch)
    };
    this.persistSettings();
    this.sendToSwf({ type: "exit_config", ...this.exitMode });
    this.log(`Salidas -> coco ${this.exitMode.enabled ? "ON" : "OFF"}, punch ${this.exitMode.punch ? "ON" : "OFF"}`);
    this.emitSnapshot();
    return true;
  }

  resetExit() {
    this.sendToSwf({ type: "exit_reset" });
    this.log("Salida de coco: aprendizaje reiniciado");
    this.emitSnapshot();
    return true;
  }

  setTickAim(value) {
    this.tickAim = normalizeTickAim(value);
    // 04/10: saved right away. It used to ride on the next unrelated save, so a
    // manual T+N clicked once came back on every start (auto: false, no learning)
    // even after choosing Auto again.
    this.persistSettings();
    this.log(this.tickAim == null ? "TICK llegada -> AUTO" : `TICK llegada -> MANUAL T+${this.tickAim} ms`);
    return this.applyTiming({ enabled: Boolean(this.timing?.enabled) });
  }

  resetTickAuto() {
    this.sendToSwf({ type: "tick_auto_reset" });
    this.log("TICK auto: aprendizaje reiniciado");
    this.emitSnapshot();
    return true;
  }

  stopModes() {
    this.disableStepClick();
    this.desiredMode = "OFF";
    this.desiredTiming = null;
    this.desiredDropHunter = null;
    this.configAuthoritative = true;
    this.timing = this.singleTiming(false);
    this.moveDelay = { ...this.moveDelay, enabled: false };
    this.dropHunter = { ...this.dropHunter, enabled: false, state: "IDLE", lastEvent: "off", lastAt: Date.now() };
    this.exitMode = { ...this.exitMode, enabled: false };
    this.persistSettings();
    this.sendToSwf({ type: "exit_config", enabled: false });
    this.pushOffConfig();
    this.log("TIMING / SALIDA / DROPS -> OFF");
    this.emitSnapshot();
    return true;
  }

  toggleHotkeyMode(mode) {
    if (String(mode || "").toUpperCase() === "TIMING") {
      this.applyTiming({ ...this.timing, enabled: !this.timing.enabled });
    }
  }

  selectTarget(targetId) {
    const id = safeInt(targetId, -1);
    this.selectedTarget = id;
    const player = this.players.get(id);
    this.sendToSwf({ type: "select_target", targetId: id });
    this.log(`Fichar -> ${player ? player.name : "target"} (${id})`);
    this.updatePlayers(Array.from(this.players.values()));
    this.emitSnapshot();
    return true;
  }

  rawPunch() {
    this.sendToSwf({ type: "raw_punch" });
    this.log("RAW 211 -> enviado");
    return true;
  }

  clearLogs() {
    this.logs = [];
    this.emitSnapshot();
    return true;
  }

  pingLoop() {
    if (!this.swfSocket) {
      return;
    }
    const now = Date.now();
    if (!this.bridgePingSentAt) {
      this.bridgePingSentAt = now;
      this.sendToSwf({ type: "ping" });
    } else if (now - this.bridgePingSentAt > 2000) {
      this.bridgePingSentAt = 0;
    }
  }

  sendToSwf(obj) {
    if (!this.swfSocket) {
      return false;
    }
    try {
      this.swfSocket.write(`${JSON.stringify(obj)}\x00`, "utf8");
      return true;
    } catch (error) {
      this.log(`ERROR enviando al runtime: ${error.message}`);
      return false;
    }
  }

  log(text) {
    this.logs.push({ ts: nowStamp(), text: String(text) });
    if (this.logs.length > 200) {
      this.logs.shift();
    }
  }

  // ---- Ring Board -------------------------------------------------------------

  boardLicensed() {
    return this.ringBoardEnabled && licenseGate.hasFeature("ring_board");
  }

  enforceBoardLicense() {
    if (this.boardLicensed()) return true;
    this.clearRingBoardFireTimers();
    this.ringBoardStatus = null;
    this.ringBoardConnected = false;
    const socket = this.ringBoardSocket;
    this.ringBoardSocket = null;
    socket?.close();
    if (this.autoRun) {
      this.autoRun = false;
      this.pushAutoRun();
      this.persistSettings();
    }
    return false;
  }

  ensureRingBoardBridge() {
    if (!this.enforceBoardLicense()) return;
    if (this.ringBoardSocket || this.ringBoardConnected) {
      return;
    }
    const socket = new WebSocket(RING_BOARD_WS_URL);
    this.ringBoardSocket = socket;

    socket.on("open", () => {
      if (!this.enforceBoardLicense()) { socket.close(); return; }
      this.ringBoardConnected = true;
      this.ringBoardSend({
        type: "bridge_hello",
        role: "swf_bridge",
        clientId: RING_BOARD_CLIENT_ID,
        ts: Date.now()
      });
      this.log("Ring Board conectado.");
      if (this.autoRun) setTimeout(() => this.setRingBoardArmed(true), 300);
      this.pushRingBoardSensors();
      this.emitSnapshot();
    });

    socket.on("message", (raw) => {
      try {
        this.handleRingBoardMessage(JSON.parse(String(raw)));
      } catch {
        this.log(`Ring Board JSON_ERR: ${String(raw).slice(0, 80)}`);
      }
    });

    socket.on("error", () => {});

    socket.on("close", () => {
      if (this.ringBoardSocket === socket) {
        this.ringBoardSocket = null;
        this.ringBoardConnected = false;
        this.ringBoardStatus = null;
        this.emitSnapshot();
      }
    });
  }

  ringBoardSend(payload) {
    if (!this.enforceBoardLicense()) return false;
    if (!this.ringBoardSocket || this.ringBoardSocket.readyState !== WebSocket.OPEN) {
      return false;
    }
    this.ringBoardSocket.send(JSON.stringify(payload));
    return true;
  }

  handleRingBoardMessage(message) {
    if (!this.enforceBoardLicense()) return;
    const type = String(message?.type || "");
    if (type === "bridge_status") {
      const prevArmed = Boolean(this.ringBoardStatus?.armed);
      this.ringBoardStatus = message;
      const want = MOVE_BRAIN_NAMES[this.moveBrain] || "planner";
      if ((message.moveBrain || "planner") !== want) {
        this.ringBoardSend({ type: "ui_action", action: "set_move_brain", value: this.moveBrain, sceneHash: this.ringBoardSceneHash(), ts: Date.now() });
      }
      if (prevArmed !== Boolean(message.armed)) {
        this.ringBoardLastSceneKey = "";
        this.ringBoardLastSceneAt = 0;
        if (!message.armed) {
          this.clearRingBoardFireTimers();
        }
        this.log(`Ring Board ${message.armed ? "ARMADO" : "APAGADO"}`);
        if (message.armed) {
          this.pushRingBoardSensors();
        }
      }
      this.emitSnapshot();
      return;
    }
    if (type === "fire") {
      this.scheduleRingBoardFire(message);
      return;
    }
    if (type === "move_plan") {
      this.scheduleRingBoardMove(message);
      return;
    }
    if (type === "move") {
      this.ringBoardLastCommand = `MOVE target=${safeInt(message.targetId, -1)}`;
      this.emitSnapshot();
      return;
    }
    if (type === "timing_config") {
      this.applyRingBoardTiming(message);
    }
  }

  clearRingBoardFireTimers(predicate = null) {
    for (const timer of Array.from(this.ringBoardFireTimers)) {
      const meta = this.ringBoardFireTimerMeta.get(timer) || {};
      if (!predicate || predicate(meta)) {
        clearTimeout(timer);
        this.ringBoardFireTimers.delete(timer);
        this.ringBoardFireTimerMeta.delete(timer);
      }
    }
  }

  applyRingBoardTiming(message) {
    if (this.stepClick?.enabled) return;
    if (!this.enforceBoardLicense()) return;
    const msg = {
      type: "timing_config",
      enabled: Boolean(message.enabled),
      source: "STEP",
      start: safeInt(message.startMs, 435),
      end: safeInt(message.endMs, 750),
      dualWindow: false,
      start2: 700,
      end2: 750,
      rate: clamp(safeInt(message.intervalMs, 33), 1, 200),
      mult: clamp(safeInt(message.multiplier, 1), 1, TIMING_MULT_MAX),
      randomInterval: false,
      intervalMin: 1,
      intervalMax: 33,
      randomMultiplier: false,
      multMin: 1,
      multMax: 50,
      clicks: clamp(safeInt(message.clicks, 0), 0, 48),
      gap: 1,
      profile: "LINEAR",
      power: false,
      stepScale: true
    };
    this.desiredMode = "BOARD";
    this.configAuthoritative = false;
    this.timing = normalizeTimingConfig({ ...this.timing, ...msg, tick: { ...this.timing.tick, enabled: false } }, this.timing);
    this.sendToSwf(msg);
    this.ringBoardLastCommand = `TIMING ${msg.enabled ? "ON" : "OFF"} ${msg.start}-${msg.end} ${msg.rate}ms x${msg.mult}`;
    this.log(`Ring Board timing -> ${msg.enabled ? "ON" : "OFF"} ${msg.start}-${msg.end}ms int=${msg.rate} x${msg.mult}`);
    this.emitSnapshot();
  }

  scheduleRingBoardFire(message) {
    if (this.stepClick?.enabled) return;
    if (!this.enforceBoardLicense()) return;
    const targetId = safeInt(message.targetId, -1);
    if (targetId < 0) {
      return;
    }
    const sceneHash = String(message.sceneHash || "");
    const windowId = String(message.windowId || "");
    this.clearRingBoardFireTimers((meta) =>
      safeInt(meta.targetId, -1) !== targetId ||
      (sceneHash && meta.sceneHash && String(meta.sceneHash) !== sceneHash)
    );
    const offsets = Array.isArray(message.burstOffsetsMs) && message.burstOffsetsMs.length
      ? message.burstOffsetsMs.map((value) => clamp(safeInt(value, 0), 0, 800)).slice(0, 64)
      : [0];
    const baseDelay = this.ringDelayFromSwfTs(safeInt(message.fireAtTs, 0), safeInt(message.fireAt, 0));
    const commandAge = safeInt(message.expiresAtTs, 0) > 0 && this.lastSwfTs > 0 ? safeInt(message.expiresAtTs, 0) - this.lastSwfTs : 200;
    if (commandAge < -80) {
      return;
    }
    this.ringBoardLastCommand = `FIRE #${targetId} in ${baseDelay}ms x${offsets.length}`;
    offsets.forEach((offset) => {
      const delay = Math.max(0, baseDelay + offset);
      const timer = setTimeout(() => {
        this.ringBoardFireTimers.delete(timer);
        this.ringBoardFireTimerMeta.delete(timer);
        if (!this.enforceBoardLicense()) return;
        this.sendToSwf({ type: "fire", targetId });
      }, delay);
      this.ringBoardFireTimers.add(timer);
      this.ringBoardFireTimerMeta.set(timer, { targetId, sceneHash, windowId });
    });
    this.emitSnapshot();
  }

  scheduleRingBoardMove(message) {
    if (!this.enforceBoardLicense()) return;
    const tile = message.primaryTile || message.backupTile || null;
    if (!tile) {
      return;
    }
    const x = safeInt(tile.x, -1);
    const y = safeInt(tile.y, -1);
    if (x < 0 || y < 0) {
      return;
    }
    const backup = message.backupTile || null;
    const backupX = backup ? safeInt(backup.x, -1) : -1;
    const backupY = backup ? safeInt(backup.y, -1) : -1;
    const delay = Math.max(0, safeInt(message.moveAt, Date.now()) - Date.now());
    this.ringBoardLastCommand = `MOVE ${x},${y} target=${safeInt(message.targetId, -1)}`;
    setTimeout(() => {
      if (!this.enforceBoardLicense()) return;
      this.sendToSwf({
        type: "move",
        x,
        y,
        backupX,
        backupY,
        targetId: safeInt(message.targetId, -1),
        reason: String(message.reason || "").slice(0, 60),
        sceneHash: String(message.sceneHash || this.ringBoardSceneHash())
      });
    }, Math.min(delay, 500));
    this.emitSnapshot();
  }

  ringDelayFromSwfTs(swfTs, wallFallback) {
    if (swfTs > 0 && this.lastSwfTs > 0 && this.lastSwfWall > 0) {
      return Math.max(0, Math.round(this.lastSwfWall + (swfTs - this.lastSwfTs) - Date.now()));
    }
    if (wallFallback > 0) {
      return Math.max(0, Math.round(wallFallback - Date.now()));
    }
    return 0;
  }

  setRingBoardArmed(value) {
    if (value && !this.boardLicensed()) throw new Error("Se necesita una licencia Board Pro.");
    if (value) this.disableStepClick();
    this.ringBoardLastSceneKey = "";
    this.ringBoardLastSceneAt = 0;
    if (value) {
      for (const action of ["mark_scene_allowed", "set_move_assist"]) {
        this.ringBoardSend({ type: "ui_action", action, value: true, sceneHash: this.ringBoardSceneHash(), ts: Date.now() });
      }
    }
    this.ringBoardSend({ type: "ui_action", action: "set_armed", value: Boolean(value), ts: Date.now() });
    this.log(`Ring Board -> ${value ? "ARMAR" : "APAGAR"}`);
    this.emitSnapshot();
    return true;
  }

  setRingBoardOption(action, value = true) {
    if (!this.boardLicensed()) throw new Error("Se necesita una licencia Board Pro.");
    if (action === "set_move_brain") {
      this.moveBrain = [0, 1, 2, 3].includes(Number(value)) ? Number(value) : 0;
      this.log(`Movimiento -> ${MOVE_BRAIN_NAMES[this.moveBrain]}`);
      this.persistSettings();
    }
    if (action === "reset_runtime" || action === "mark_scene_allowed") {
      this.ringBoardLastSceneKey = "";
      this.ringBoardLastSceneAt = 0;
    }
    this.ringBoardSend({ type: "ui_action", action, value, sceneHash: this.ringBoardSceneHash(), ts: Date.now() });
    this.emitSnapshot();
    return true;
  }

  ringBoardSceneHash() {
    return this.ringBoardScene?.sceneHash || RING_BOARD_SCENE_HASH;
  }

  updateRingBoardScene(data) {
    const scene = this.normalizeRingBoardScene(data);
    if (!scene) {
      return;
    }
    if (!this.ringBoardScene || this.ringBoardScene.sceneHash !== scene.sceneHash) {
      this.ringBoardLastSceneKey = "";
      this.ringBoardLastSceneAt = 0;
      if (this.ringBoardStatus?.armed) {
        this.ringBoardSend({ type: "ui_action", action: "mark_scene_allowed", value: true, sceneHash: scene.sceneHash, ts: Date.now() });
      }
    }
    this.ringBoardScene = scene;
  }

  normalizeRingBoardScene(data) {
    const width = clamp(safeInt(data.width, 0), 1, 256);
    const height = clamp(safeInt(data.height, 0), 1, 256);
    if (!width || !height || !Array.isArray(data.matrix)) {
      return null;
    }
    const matrix = normalizeMatrix(data.matrix, width, height, 1);
    const walkableMatrix = normalizeMatrix(data.walkableMatrix || data.matrix, width, height, 1);
    const occupancyMatrix = normalizeMatrix(data.occupancyMatrix || data.walkableMatrix || data.matrix, width, height, 1);
    const points = (list, map) => (Array.isArray(list) ? list.map(map) : []);
    const occupied = points(data.occupied, (p) => ({ x: safeInt(p?.x, -1), y: safeInt(p?.y, -1), id: safeInt(p?.id, -1) }))
      .filter((p) => p.x >= 0 && p.y >= 0 && p.id >= 0);
    const overlayPoints = points(data.overlayPoints, (p) => ({
      x: safeInt(p?.x, -1),
      y: safeInt(p?.y, -1),
      plotX: safeInt(p?.plotX, 0),
      plotY: safeInt(p?.plotY, 0),
      color: safeInt(p?.color, 0)
    })).filter((p) => p.x >= 0 && p.y >= 0);
    const blocked = points(data.blocked, (p) => ({ x: safeInt(p?.x, -1), y: safeInt(p?.y, -1) }))
      .filter((p) => p.x >= 0 && p.y >= 0);
    const projection = data.projection && typeof data.projection === "object"
      ? {
          originX: safeInt(data.projection.originX, 0),
          originY: safeInt(data.projection.originY, 0),
          tileW: safeInt(data.projection.tileW, 0),
          tileH: safeInt(data.projection.tileH, 0)
        }
      : undefined;
    return {
      sceneHash: String(data.sceneHash || RING_BOARD_SCENE_HASH),
      width,
      height,
      matrix,
      walkableMatrix,
      occupancyMatrix,
      occupied,
      overlayPoints,
      projection,
      blocked,
      timestamp: safeInt(data.timestamp, safeInt(data.ts, this.lastSwfTs || Date.now())),
      allowed: true
    };
  }

  boardAllyKeys() {
    const list = [
      ...this.allies.map((a) => (a.accountId ? String(a.accountId) : a.name)),
      ...String(process.env.BB_BOARD_IGNORE || "").split(",")
    ];
    return new Set(list.map((v) => String(v).trim().toLowerCase()).filter(Boolean));
  }

  pushRingBoardSensors(sourceState = null) {
    if (!this.ringBoardConnected || this.players.size === 0) {
      return;
    }
    const nowWall = Date.now();
    const swfTs = safeInt(sourceState?.ts, this.lastSwfTs || nowWall);
    // Allies (Hub whitelist + BB_BOARD_IGNORE) are not sent to the ring-board, so
    // its movement brain neither chases nor targets them; we always stay in.
    const allyKeys = this.boardAllyKeys();
    const isAllyPlayer = (p) => !p.self && (allyKeys.has(String(p.name || "").trim().toLowerCase()) || allyKeys.has(String(p.userId)));
    const players = Array.from(this.players.values()).filter((p) => !isAllyPlayer(p));
    // Board chooses from geometry and its own brain. A game ficha must never
    // become a locked target or override its autonomous choice.
    const boardTarget = -1;
    const scene = this.buildRingBoardScene(players, swfTs);
    const sceneKey = `${scene.sceneHash}:${scene.width}x${scene.height}`;
    if (sceneKey !== this.ringBoardLastSceneKey || nowWall - this.ringBoardLastSceneAt > 1000) {
      this.ringBoardLastSceneKey = sceneKey;
      this.ringBoardLastSceneAt = nowWall;
      this.ringBoardSendSensor("scene_snapshot", scene, swfTs, scene.sceneHash);
    }
    this.ringBoardSendSensor(
      "selection_state",
      {
        rawSelectedTarget: boardTarget,
        pendingTarget: boardTarget,
        lockedTarget: boardTarget,
        punchTarget: boardTarget,
        derivedTarget: boardTarget
      },
      swfTs,
      scene.sceneHash
    );
    for (const player of players) {
      this.ringBoardSendSensor("entity_state", this.buildRingBoardEntity(player, swfTs), swfTs, scene.sceneHash);
    }
    this.ringBoardLastSensorAt = nowWall;
  }

  ringBoardSendSensor(type, payload, swfTs, sceneHash = RING_BOARD_SCENE_HASH) {
    const envelope = { type, ts: swfTs, sceneHash, clientId: RING_BOARD_CLIENT_ID, payload };
    this.ringBoardSend({
      type: "sensor",
      clientId: RING_BOARD_CLIENT_ID,
      payload: JSON.stringify(envelope),
      ts: Date.now()
    });
  }

  buildRingBoardScene(players, swfTs) {
    if (this.ringBoardScene) {
      return { ...this.ringBoardScene, timestamp: swfTs, allowed: true };
    }
    const maxX = Math.max(24, ...players.map((player) => safeNumber(player.toX ?? player.x, 0) + 6));
    const maxY = Math.max(24, ...players.map((player) => safeNumber(player.toY ?? player.y, 0) + 6));
    const width = clamp(maxX, 24, 64);
    const height = clamp(maxY, 24, 64);
    const matrix = Array.from({ length: height }, () => Array.from({ length: width }, () => 0));
    return {
      sceneHash: RING_BOARD_SCENE_HASH,
      width,
      height,
      matrix,
      walkableMatrix: matrix,
      blocked: [],
      timestamp: swfTs,
      allowed: true
    };
  }

  buildRingBoardEntity(player, swfTs) {
    const x = safeNumber(player.x, 0);
    const y = safeNumber(player.y, 0);
    const fromX = safeNumber(player.fromX, x);
    const fromY = safeNumber(player.fromY, y);
    const toX = safeNumber(player.toX, x);
    const toY = safeNumber(player.toY, y);
    const stepDur = safeInt(player.stepDur, 0);
    const stepStartAt = safeInt(player.stepStartAt, swfTs);
    const phase = Math.max(0, Math.min(1, Number(player.phase ?? (stepDur > 0 ? (swfTs - stepStartAt) / stepDur : 1))));
    return {
      id: player.id,
      sceneId: player.posId,
      accountId: player.userId,
      name: player.name,
      skinId: Number.isFinite(player.skinId) ? player.skinId : -1,
      orientation: safeInt(player.orient, 0),
      isSelf: wireBool(player.self),
      x,
      y,
      fromX,
      fromY,
      toX,
      toY,
      dirX: safeInt(player.dirX, Math.sign(toX - fromX)),
      dirY: safeInt(player.dirY, Math.sign(toY - fromY)),
      stepStartAt,
      stepDur,
      phase,
      moving: wireBool(player.moving),
      targetLock: false,
      combatState: normalizeCombatState(player.combatState, player.state),
      lockUntilTs: safeInt(player.lockUntil, 0),
      walkFlag: safeInt(player.walkFlag, 1),
      lastTurnTs: safeInt(player.lastTurnAt, 0),
      facing: safeInt(player.facing, 0),
      active: Boolean(player.active)
    };
  }

  pushRingBoardResolve(data) {
    if (!this.ringBoardConnected) {
      return;
    }
    const swfTs = safeInt(data.timestamp, safeInt(data.ts, this.lastSwfTs || Date.now()));
    this.ringBoardSendSensor(
      "resolve_event",
      {
        attackerId: safeInt(data.attackerId, -1),
        defenderId: safeInt(data.defenderId, -1),
        winner: safeInt(data.winner, safeInt(data.attackerId, -1)),
        contested: Boolean(data.contested),
        targetId: safeInt(data.targetId, this.selectedTarget),
        timestamp: swfTs,
        timingEnabled: Boolean(this.timing.enabled),
        timingStartMs: this.timing.start,
        timingEndMs: this.timing.end,
        timingIntervalMs: this.timing.rate,
        timingMultiplier: this.timing.mult,
        timingClicks: this.timing.clicks,
        selfStepAgeMs: safeInt(data.selfStepAgeMs, -1),
        targetStepAgeMs: safeInt(data.targetStepAgeMs, -1),
        lastPunchAgeMs: safeInt(data.lastPunchAgeMs, -1),
        lastPunchTargetId: safeInt(data.lastPunchTargetId, -1)
      },
      swfTs,
      RING_BOARD_SCENE_HASH
    );
    this.ringBoardLastCommand = `RESOLVE ${safeInt(data.attackerId, -1)}>${safeInt(data.defenderId, -1)}`;
  }

  // ---- UI snapshot ------------------------------------------------------------

  snapshot() {
    const players = Array.from(this.players.values()).sort((a, b) => {
      if (a.self !== b.self) {
        return a.self ? -1 : 1;
      }
      if (a.selected !== b.selected) {
        return a.selected ? -1 : 1;
      }
      return a.id - b.id;
    });
    return {
      controllerBuild: CONTROLLER_BUILD,
      connected: Boolean(this.swfSocket),
      bridgeBuild: this.bridgeBuild,
      selfId: this.selfId,
      selectedTarget: this.selectedTarget,
      serverPingMs: this.serverPingMs == null ? null : Math.round(this.serverPingMs),
      bridgePingMs: this.bridgePingMs == null ? null : Math.round(this.bridgePingMs),
      lastStateAgeMs: this.lastStateAt ? Date.now() - this.lastStateAt : null,
      players,
      timing: this.timing,
      timingHotkey: this.timingHotkey,
      tick: this.tick,
      tickAim: this.tickAim ?? null,
      exit: this.exit,
      exitMode: this.exitMode,
      stepWalk: this.stepWalk !== false,
      allies: this.allies,
      portraitVersion: this.portraitVersion,
      autoRun: this.autoRun === true,
      emotes: this.emotes !== false,
      cocoSelfMode: this.cocoSelfMode === "off" ? "off" : "auto",
      cocoSelfKey: this.cocoSelfKey || "",
      advanced: this.advanced,
      requeueKey: this.requeueKey || "",
      freeFire: this.freeFire === true,
      simon: { ...this.simon, status: this.simonStatus },
      stepClick: { ...this.stepClick, status: this.stepClickStatus, sampleAgeMs: this.stepClickStateAt ? Math.max(0, Date.now() - this.stepClickStateAt) : null },
      combat: this.combat,
      moveDelay: this.moveDelay,
      dropHunter: this.dropHunter,
      punchPackets: this.punchPackets,
      desiredMode: this.desiredMode,
      ringBoard: {
        licensed: this.boardLicensed(),
        url: RING_BOARD_HTTP_URL,
        bridgeConnected: this.ringBoardConnected,
        armed: Boolean(this.ringBoardStatus?.armed),
        highPower: Boolean(this.ringBoardStatus?.highPower),
        moveAssist: Boolean(this.ringBoardStatus?.moveAssist),
        moveBrain: this.ringBoardStatus?.moveBrain || "planner",
        moveBrainWanted: MOVE_BRAIN_NAMES[this.moveBrain] || "planner",
        stepCadenceAlways: Boolean(this.ringBoardStatus?.stepCadenceAlways),
        pulseClick: Boolean(this.ringBoardStatus?.pulseClick),
        sceneHash: this.ringBoardSceneHash(),
        lastSensorAgeMs: this.ringBoardLastSensorAt ? Date.now() - this.ringBoardLastSensorAt : null,
        lastCommand: this.ringBoardLastCommand
      },
      logs: this.logs.slice(-80)
    };
  }

  emitSnapshot(force = false) {
    // UI snapshots cost IPC + a React render: at most one per 400 ms, unless forced.
    const minInterval = force ? 80 : 400;
    const now = Date.now();
    if (this.lastSnapshotEmitAt && now - this.lastSnapshotEmitAt < minInterval) {
      if (!this.snapshotFlushTimer) {
        this.snapshotFlushTimer = setTimeout(() => {
          this.snapshotFlushTimer = null;
          this.emitSnapshot(true);
        }, minInterval - (now - this.lastSnapshotEmitAt));
      }
      return;
    }
    if (this.snapshotFlushTimer) {
      clearTimeout(this.snapshotFlushTimer);
      this.snapshotFlushTimer = null;
    }
    this.lastSnapshotEmitAt = now;
    this.emit("snapshot", this.snapshot());
  }
}

module.exports = {
  ControllerCore,
  normalizeStepClick,
  normalizeTimingConfig,
  normalizeTickConfig,
  normalizeTickStatus,
  normalizeExitStatus,
  timingMessage
};
