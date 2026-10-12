// Dev-only demo data for previewing the Hub in a browser (npm run dev).
// Used ONLY when window.ringController does not exist AND import.meta.env.DEV is true;
// inside Electron the preload always provides window.ringController, so this never runs.
// ?demo=empty -> empty session (no client), ?demo=error -> getSnapshot fails.

const RING_PREVIEW_URL = "http://127.0.0.1:18450/";
const DEMO_AVATAR = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="22" r="12" fill="#e8c39e"/><rect x="18" y="34" width="28" height="24" rx="8" fill="#c8102e"/></svg>');

const NAMES = [
  { id: 14, name: "Bachi", userId: 881204, skin: "Boxeador", self: true },
  { id: 3, name: "Flee", userId: 771032, skin: "Ninja" },
  { id: 7, name: "KaosRoto", userId: 650118, skin: "Pirata" },
  { id: 9, name: "ladydinamita", userId: 902377, skin: "Rockera" },
  { id: 21, name: "Tuerca_77", userId: 413390, skin: "Robot" },
  { id: 26, name: "ElPibeCombo", userId: 118845, skin: "Payaso" }
];

function stamp(offsetS = 0) {
  const d = new Date(Date.now() - offsetS * 1000);
  return d.toLocaleTimeString("es-AR", { hour12: false }) + "." + String(d.getMilliseconds()).padStart(3, "0");
}

function buildSnapshot(base) {
  const players = NAMES.map((p, i) => ({
    ...p,
    mark: p.self ? "SELF" : p.id === 7 ? "SEL" : "",
    posId: p.id,
    state: i % 3 === 0 ? 0 : i % 3 === 1 ? 2 : 5,
    x: [12, 14, 15, 10, 17, 11][i],
    y: [13, 14, 16, 11, 12, 18][i],
    orient: [1, 5, 3, 7, 1, 3][i],
    selected: p.id === 7,
    cocoMs: p.id === 21 ? 3400 : 0
  }));
  const logs = [
    "Cliente conectado · build 2026.09.29-a",
    "Ring detectado · escena 794bf3d1 (117 casillas)",
    "Timing activo · llegada automática T+10 ms",
    "Objetivo: KaosRoto #7",
    "Golpe a #7 · aceptado (T+11 ms)",
    "Recibido de #3 · carrera perdida por 6 ms",
    "Golpe a #9 · aceptado (T+9 ms)",
    "Tick sin clic: rival fuera de contacto",
    "Coco activo 7,0 s · salida en espera",
    "Golpe a #7 · aceptado (T+10 ms)",
    "Board armado · cerebro tile2",
    "Reinscripción: tecla F8"
  ].map((text, i, all) => ({ ts: stamp((all.length - i) * 7), text }));
  return {
    ...base,
    controllerBuild: "2026.09.29-a",
    connected: true,
    bridgeBuild: "html5-117",
    selfId: 14,
    selectedTarget: 7,
    serverPingMs: 38,
    bridgePingMs: 4,
    lastStateAgeMs: 120,
    players,
    timing: { ...base.timing, enabled: true },
    tick: {
      enabled: true, synced: true, coherence: 0.92, fired: 184, replies: 171, hits: 52,
      lastSkip: "rival fuera de contacto", reactFired: 23,
      auto: { enabled: true, aimMs: 10, boundaryMs: 4, samples: 212, sigmaMs: 6, recentWinRate: 64, rivalMedianMs: 18, races: 88, wins: 56 }
    },
    tickAim: null,
    exit: { cocoActive: false, cocoRemainingMs: 0 },
    stepWalk: true,
    allies: [{ accountId: 771032, name: "Flee" }, { accountId: null, name: "amigo, con coma" }],
    simon: { enabled: true, delayMs: 0, status: { inRoom: true, games: 2, rounds: 9, answered: 7, skippedRed: 2, errors: 0, wins: 1, punchesHeld: 3, sender: "game", last: { round: 6, timeMs: 1200, go: true, cell: 4, conf: 1.3, readMs: 4.1, totalMs: 6 } } },
    autoRun: false,
    emotes: true,
    advanced: { burst: 5, repeatMs: 0, sweep: true, reactive: true },
    requeueKey: "F8",
    combat: { hits: 12, gotHit: 4 },
    dropHunter: { ...base.dropHunter, enabled: false, state: "IDLE", keyword: "cofre", lastEvent: "" },
    ringBoard: {
      ...base.ringBoard,
      url: RING_PREVIEW_URL,
      bridgeConnected: true,
      armed: false,
      highPower: false,
      moveAssist: true,
      moveBrain: "tile2",
      moveBrainWanted: "tile2",
      sceneHash: "794bf3d1",
      lastSensorAgeMs: 42,
      lastCommand: "move_plan (13,14)"
    },
    logs
  };
}

export function createDemoApi(base) {
  const mode = new URLSearchParams(window.location.search).get("demo");
  let snap = mode === "empty" ? { ...base, ringBoard: { ...base.ringBoard, url: RING_PREVIEW_URL } } : buildSnapshot(base);
  snap.game = mode === "empty"
    ? { state: "idle", message: "", username: "", hasAccount: false, clientFound: true }
    : { state: "ready", message: "Juego conectado.", username: "Bachi", hasAccount: true, clientFound: true, avatarUrl: DEMO_AVATAR };
  const listeners = new Set();
  const emit = () => { snap = { ...snap }; listeners.forEach((fn) => fn(snap)); };
  const log = (text) => { snap.logs = [...(snap.logs || []), { ts: stamp(), text }].slice(-80); };
  const patch = (fn) => async (...args) => { fn(...args); emit(); };

  if (mode !== "empty") {
    setInterval(() => {
      snap.serverPingMs = Math.max(18, Math.round(34 + (Math.random() - 0.5) * 18));
      snap.lastStateAgeMs = Math.round(80 + Math.random() * 90);
      if (snap.ringBoard) snap.ringBoard = { ...snap.ringBoard, lastSensorAgeMs: Math.round(20 + Math.random() * 60) };
      if (snap.timing?.enabled && Math.random() < 0.18) {
        const landed = Math.random() < 0.72;
        snap.combat = { hits: snap.combat.hits + (landed ? 1 : 0), gotHit: snap.combat.gotHit + (landed ? 0 : 1) };
        log(landed ? `Golpe a #7 · aceptado (T+${8 + Math.round(Math.random() * 5)} ms)` : "Recibido de #3 · carrera perdida");
      }
      emit();
    }, 1200);
  }

  return {
    getSnapshot: async () => {
      if (mode === "error") throw new Error("IPC no disponible");
      return snap;
    },
    applyTiming: patch(({ enabled }) => { snap.timing = { ...snap.timing, enabled }; log(`Timing ${enabled ? "activo" : "en pausa"}`); }),
    applyMovePunch: async () => {},
    applyDropHunter: patch((payload) => { snap.dropHunter = { ...snap.dropHunter, ...payload, state: payload.enabled ? "SEARCHING" : "IDLE" }; }),
    saveDraftConfig: async () => {},
    resetTickAuto: patch(() => log("Aprendizaje reiniciado")),
    setTickAim: patch((value) => { snap.tickAim = value; }),
    applyExit: async () => {},
    applyStepWalk: patch(({ enabled }) => { snap.stepWalk = enabled; }),
    setAllies: patch((value) => { snap.allies = String(value).split(",").map((s) => s.trim()).filter(Boolean).map((name) => ({ accountId: null, name })); }),
    applySimon: patch((payload) => { snap.simon = { ...(snap.simon || { enabled: false, delayMs: 0 }), ...payload }; }),
    applyStepClick: patch((payload) => {
      snap.stepClick = { enabled: false, source: "PAIR", startMs: 350, endMs: 400, intervalMs: 10, ...snap.stepClick, ...payload };
      if (snap.stepClick.enabled) {
        snap.timing.enabled = false; snap.simon.enabled = false; snap.autoRun = false; snap.ringBoard.armed = false;
      }
    }),
    toggleAlly: patch((value) => {
      const i = snap.allies.findIndex((a) => a.accountId === value.accountId);
      if (i >= 0) snap.allies.splice(i, 1); else snap.allies.push({ accountId: value.accountId, name: value.name });
    }),
    addAllyByName: patch((name) => { snap.allies.push({ accountId: null, name: String(name).trim() }); }),
    removeAlly: patch((value) => { snap.allies = snap.allies.filter((a) => !(value.accountId ? a.accountId === value.accountId : a.name === value.name)); }),
    getPortraits: async () => Object.fromEntries(NAMES.map((p) => [p.userId, DEMO_AVATAR])),
    setAutoRun: patch((value) => { snap.autoRun = value; }),
    setEmotes: patch((value) => { snap.emotes = value; }),
    setAdvanced: patch((value) => { snap.advanced = value === "defaults" ? { burst: 5, repeatMs: 0, sweep: true, reactive: true } : { ...snap.advanced, ...value }; }),
    setRequeueKey: patch((value) => { snap.requeueKey = value; }),
    requeueNow: patch(() => log("Reinscripción pedida")),
    resetExit: async () => {},
    setRingBoardArmed: patch((value) => { snap.ringBoard = { ...snap.ringBoard, armed: Boolean(value) }; }),
    ringBoardAction: patch((action, value) => {
      const ring = { ...snap.ringBoard };
      if (action === "set_move_assist") ring.moveAssist = Boolean(value);
      if (action === "set_high_power") ring.highPower = Boolean(value);
      if (action === "set_move_brain") { ring.moveBrain = ["planner", "tile", "tile2"][value] || "planner"; ring.moveBrainWanted = ring.moveBrain; }
      ring.lastCommand = action;
      snap.ringBoard = ring;
    }),
    setPunchPackets: async () => {},
    selectTarget: patch((id) => {
      snap.selectedTarget = id;
      snap.players = snap.players.map((p) => ({ ...p, selected: p.id === id, mark: p.self ? "SELF" : p.id === id ? "SEL" : "" }));
    }),
    rawPunch: async () => {},
    stopModes: patch(() => { snap.stepClick = { ...snap.stepClick, enabled: false }; snap.timing = { ...snap.timing, enabled: false }; snap.dropHunter = { ...snap.dropHunter, enabled: false }; log("Detener todo"); }),
    clearLogs: patch(() => { snap.logs = []; }),
    launchGame: patch(() => { snap.game = { ...snap.game, state: "ready", message: "Juego conectado." }; }),
    submitGameCode: async () => {},
    saveGameAccount: patch((username) => { snap.game = { ...snap.game, hasAccount: true, username }; }),
    setCombatLog: patch((value) => { snap.game = { ...snap.game, diagnostics: Boolean(value) }; }),
    openCombatLogs: async () => {},
    findGameClient: patch(() => { snap.game = { ...snap.game, clientFound: true }; }),
    selectGameClient: patch(() => { snap.game = { ...snap.game, clientFound: true }; }),
    forgetGameAccount: patch(() => { snap.game = { ...snap.game, hasAccount: false, username: "", state: "idle", message: "" }; }),
    onSnapshot: (fn) => { listeners.add(fn); return () => listeners.delete(fn); }
  };
}
