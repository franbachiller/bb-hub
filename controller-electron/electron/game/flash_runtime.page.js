(() => {
  "use strict";

  const KEY = "__BBFlashRuntime";
  if (window[KEY]?.__installed) return;

  const BRIDGE_BUILD = "06102026_html5_hub_v6_62_og_simon2";
  // Contact switch, measured to the millisecond in the duel lab (26/09, two
  // accounts on one PC, harness/run_duel_lab.js): in the batch-arrival frame
  // a punch is rejected up to T-2 and accepted from T-1 whoever walks in (for
  // the other account even from T-6). The July estimate (6) came from a noisy
  // ping and made us land ~8 ms late in every race. Defined here: the initial
  // state (tickAutoInit) needs it.
  const TICK_B_PRIOR = 0;
  // 28/09: the learned switch reached B=-150 (saved), so Auto aimed at T-140 and
  // every click would bounce. Samples far from T come from clicks aimed at another
  // tick, not from this switch: they are dropped, and B stays where the duel lab
  // and live data put it (T-2..T+4, with margin).
  const TICK_B_MIN = -10;
  const TICK_B_MAX = 20;
  const TICK_SAMPLE_MIN = -40;
  const TICK_SAMPLE_MAX = 80;
  const tickSampleOk = (p) => Number.isFinite(p) && p >= TICK_SAMPLE_MIN && p <= TICK_SAMPLE_MAX;
  // Live (official Ring, ping ~173) the switch is fuzzier than in the duel lab:
  // 26/09, shots landing at T-2..T+2 on a new contact were rejected 5 times in
  // 16, from T+4 on almost never. A reject loses the race and locks 100 ms,
  // while 4 ms later costs little against a 50-150 ms random hold.
  const TICK_MARGIN_FLOOR = 10; // 26/09 later: jitter ~±8 ms still bounced aims at T+6/7 (144 at T+0, T-3)
  // 26/09 night: the 69-47 session ran at margin 10; a few "rescued"/"early"
  // races (+3/+4 each) then pushed it to 39 and it was saved, so clicks landed
  // at T+31 against rivals at T+6-8. It may not climb past this.
  const TICK_MARGIN_MAX = 16;
  // 01/10: a dispatch this late reads as landing error (one-sided); those
  // rejects are excluded from corr/sigma instead of calibrating on them.
  const TICK_CAL_MAX_LATE_MS = 5;
  // Hub UI still configures windows on the Flash 0..750 scale.
  // HTML5 Ring step duration is ~600ms — scale Hub values onto the live stepMs.
  const STEP_HUB_REF_MS = 750;
  const HTML5_STEP_MS = 600;
  const STEP_WINDOW_MAX_MS = STEP_HUB_REF_MS;
  const RING_ROWS_FALLBACK = new Map([
    [7, [9, 12]],
    [8, [9, 15]],
    [9, [8, 17]],
    [10, [8, 18]],
    [11, [8, 18]],
    [12, [9, 19]],
    [13, [10, 19]],
    [14, [10, 20]],
    [15, [10, 19]],
    [16, [9, 18]],
    [17, [9, 17]],
    [18, [11, 15]],
    [19, [12, 16]],
    [20, [14, 16]]
  ]);

  const state = {
    ready: false,
    selfId: -1,
    selfUsername: "",
    selectedId: -1,
    punchPackets: 1,
    serverPingMs: -1,
    diagnostics: { enabled: false, lastConfigKey: null },
    outboundUpperSeq: 0,
    activeFireReason: null,
    lastFireResult: null,
    providers: {
      upper: null,
      socket: null,
      renderer: null,
      walk: null,
      selection: null,
      ping: null,
      space: null,
      map: null
    },
    timing: {
      enabled: false,
      source: "STEP",
      stepAnchor: "SELF",
      start: 435,
      end: 750,
      dualWindow: false,
      start2: 700,
      end2: 750,
      rate: 33,
      mult: 1,
      randomInterval: false,
      intervalMin: 1,
      intervalMax: 33,
      randomMultiplier: false,
      multMin: 1,
      multMax: 50,
      clicks: 0,
      gap: 1,
      profile: "LINEAR",
      power: false,
      stepScale: true,
      animSync: false,
      preFace: false,
      // Per-fire timing_metric to the Hub; off unless a lab/test asks for it.
      fireMetrics: false,
      contactGate: false,
      landing: {
        // Off by default: when on, STEP ignores start/end/rate/mult/clicks.
        enabled: false,
        offsetMs: 0,
        jitterMs: 25,
        secondShot: true,
        secondDelayMs: 120,
        adaptive: true,
        adaptiveStepMs: 10
      },
      tick: {
        // Off by default: when on, STEP fires on the server tick grid instead of
        // step windows. offsetMs = intended arrival after tick T at the server.
        enabled: false,
        offsetMs: 10,
        shots: 4,
        spacingMs: 110,
        blind: true,
        reactive: true,
        autoCal: true,
        // Autotune (see tickEffective): offset, burst and spacing are learned.
        auto: true,
        // One click per tick at the learned phase (the Hub's only mode).
        single: false,
        // Dense burst on the first shot: burst requests burstGapMs apart, all
        // after T, all to the fichado.
        burst: 5,
        burstGapMs: 4
      }
    },
    // EXPERIMENTAL (02/10, pedido del usuario): "disparo libre". Vive FUERA de
    // timing.tick a proposito (no debe romper la invariante Hub<->runtime del
    // clamp del tick). Cuando enabled, el tick rellena TODA su ventana con
    // disparos cada gapMs al mejor objetivo (threatPick se re-evalua por tiro),
    // ignorando el espaciado interno de ~100 ms, el sweep/repeat y la guarda de
    // cooldown. El hueco de 100 ms del SERVER sigue existiendo (los tiros de mas
    // se dropean), asi que PUEDE rendir peor: es para medir. OFF por defecto.
    freeFire: { enabled: false, gapMs: 25 },
    simon: { enabled: false, delayMs: 0, rooms: new Set(), roomsLoaded: false, sendName: "", games: 0, rounds: 0, answered: 0, skippedRed: 0, errors: 0, wins: 0, punchesHeld: 0, last: null },
    stateCfg: {
      enabled: false,
      delay: 0
    },
    grid: {
      enabled: false,
      lead: 0,
      gap: 1,
      burst: 1,
      spacing: 16,
      pingComp: false,
      pingCompMs: 0
    },
    pulse: {
      enabled: false,
      interval: 33,
      burst: 1,
      spacing: 16,
      gap: 1,
      pattern: "FLAT",
      microBursts: 0,
      microGap: 0,
      jitter: 0,
      requireSelected: true,
      multiTarget: false,
      autoTarget: false,
      autoRange: 1,
      contactOnly: false,
      autoTargetId: -1,
      preFace: false,
      lastFireCount: 0,
      nextAt: 0,
      lastFireAt: 0,
      seq: 0
    },
    moveDelay: {
      enabled: false,
      delayMs: 0,
      minMoveMs: 0,
      seq: 0,
      lastFireKey: ""
    },
    resolveLock: {
      enabled: false,
      observer: false,
      tickPhaseClean: false,
      alpha: 0.2,
      clientObservedResolveDelayMs: 0,
      clientObservedResolveDelaySamples: 0,
      enemyObservedResolveDelayMs: 0,
      enemyObservedResolveDelaySamples: 0,
      slotPeriodMs: 0,
      slotPeriodSamples: 0,
      confidence: "none"
    },
    preFace: {
      enabled: false,
      sent: 0,
      lastOrient: 0,
      lastAt: 0,
      lastKey: ""
    },
    packetBus: {
      enabled: false,
      in: 0,
      out: 0,
      lastOpcode: -1,
      lastDir: "",
      lastAt: 0
    },
    // Rolling tap of every packet (in+out) for the shell server-REPL. In memory
    // only, never written to disk by the runtime; the harness pulls it via CDP.
    rawTap: { on: false, ring: [], max: 4000 },
    performance: {
      stateMs: 250,
      sceneMs: 2000,
      configMs: 3000
    },
    dropHunter: {
      enabled: false,
      autoReturn: false,
      autoClaim: false,
      state: "IDLE",
      keyword: "",
      lastEvent: "",
      dropId: -1,
      x: -1,
      y: -1,
      origin: null,
      drop: null,
      timer: null
    },
    lead: {
      ms: 0,
      estimate: 0,
      samples: 0,
      lastAt: 0,
      lastDelay: 0,
      lastResidual: 0,
      lastAccepted: false
    },
    contactEdge: {
      wasContact: false,
      lastTarget: -1,
      lastAxis: "",
      lastFireAt: 0,
      lastMoveKey: ""
    },
    landingC: {
      wasContact: false,
      lastTarget: -1,
      lastFireAt: 0
    },
    landingEliminated: false,
    lab: { running: false, replies: [] },
    exitMode: exitInit(),
    react: { pending: false, pendingAt: 0, lastKey: "", fired: 0, lateral: new Set() },
    tickEngine: {
      batches: [],
      origin: null,
      coherence: 0,
      lastBatchAt: -1e9,
      lastBatchTick: null,
      armedTick: null,
      plans: new Map(),
      shots: [],
      // Every punch any engine dispatched (firePunch success path): lets a 144
      // know when another engine's request could own it (attribution gate).
      allShots: [],
      errs: [],
      corr: 0,
      lastErr: null,
      cont: new Map(),
      down: new Map(),
      selfDest: null,
      pausedUntil: 0,
      gridResets: 0,
      lastReset: "",
      bursts: [],
      auto: tickAutoInit(),
      tickTargets: new Map(), // tick n -> enemy our click for that tick went to
      tickTargets2: new Map(), // tick n -> runner-up of a near tie (second click)
      selfWalkAt: 0,
      walkReqs: [], // our walk requests the server keeps (see WALK_THROTTLE_MS)
      walkAcceptedAt: -1e9,
      // Every 211 eliminates the defender: in the Ring it stays as a spectator
      // until the round ends (grid reset on gong / room load); on an island it
      // is thrown out of the room and must come back in. Clicks at it (or ours
      // while we are out) are ignored by the server without a reply.
      out: new Set(),
      outGone: new Set(), // out players that already left the room
      selfOut: false,
      // Targets the server never answers (no 144, no 211): skipped for a while.
      silentPending: [], // { id, at } engine clicks waiting for a reply
      silentCount: new Map(),
      mutedUntil: new Map(),
      // Landing a hit locks the attacker's punches for ~13.8 s (July: 0 of 587
      // follow-ups answered before it, nobody ever hit twice within 14 s).
      selfLockEnd: 0, // local landing time before which our clicks are ignored
      lockUntil: new Map(), // rival id -> local time its clicks start counting again
      unlock: { end: 0, fired: 0, noTarget: 0, lastTarget: -1 },
      // Rivals whose punch animation or coco ends at a known moment: one click
      // lands right then if they stand next to us (id -> { end, landing }).
      runlock: new Map(),
      runlockStats: { armed: 0, fired: 0, noContact: 0, lastTarget: -1 },
      sweepStats: { fired: 0 },
      stats: { planned: 0, fired: 0, blocked: 0, skipped: 0, blind: 0, reactive: 0, replies: 0, hits: 0, calibrated: 0, calSkippedLate: 0, calSkippedAmbiguous: 0, hitsUnmatched: 0, lastSkip: "" }
    },
    // Step walk: our walks go to the server one tile per tick (see stepWalkIntercept).
    stepWalk: { enabled: true, goal: null, internal: false, sentAt: 0, from: null, retries: 0, steps: 0, walks: 0, gaveUp: 0 },
    // Attention per player (for the ring-board's "distracted" read): its last
    // turn (135: the client turns the avatar towards the mouse), its facing
    // (1..8, from that turn or its last step), and whether it did anything
    // (a step or a turn) since the room loaded.
    attention: new Map(),
    // Ring-board walks go through rbGateMove (newest decision, server gap).
    rbGate: { pending: null, timer: null, lastTile: null, lastAt: 0, received: 0, sent: 0, replaced: 0, repeats: 0 },
    // 28/09: 20 requests per shot did not shorten our holds (hold < 30 ms: 1 req
    // 29%, 5 req 25%, 8 req 34%, 20 req 18%) and fights went 37-36: back to 5.
    // tick_burst_config {count} changes it; {ab: true} alternates 5 / 8.
    tickBurst: 5,
    // 29/09 advanced knobs (tick_advanced_config): the sweep at the runner-up, and a
    // repeat click at the SAME target repeatMs after the first (0 = off; it replaces
    // the sweep, both would share the server's 100 ms gap).
    tickAdv: { sweep: true, repeatMs: 0, repeats: 0 },
    // 29/09 low-ping mode (low_ping_config): "auto" = on while RTT < LOW_PING_MS.
    // 29/09: off by default. On cryptic (ping ~25) 20 of 29 ticks a rival hit us without
    // a click from us had been skipped as "ping_bajo": the reaction never came in time.
    lowPing: { mode: "off", skipped: 0 },
    noThrottle: { enabled: true, installed: false, skipped: 0 },
    burstAB: false,
    burstRound: 0,
    // 27/09 coco guard: a coco at the rival waiting next to us, landing before our
    // upper animation ends (cocos can be thrown during it and are not held).
    // 01/10: leadMs 300 -> 60. The ambusher of our unlock often steps in at the
    // last tick before the lock ends (live: Glotona entered at end-240); at
    // +300 the guard judged adjacency one tick too early (23x "nadie_pegado",
    // 0 throws today). At +60 its check runs after that batch. selfMode
    // "auto": the self-coco fallback when the guard can no longer cover the
    // unlock (see cocoSelfOnStep).
    cocoGuard: { enabled: true, upperEnd: 0, leadMs: 60, max: 3, used: 0, fired: 0, noTarget: 0, lastTarget: -1, selfMode: "auto", selfEnd: 0, selfKey: "", selfKeyInstalled: false, thrown: [], pending: new Map() },
    // 28/09 reach probe: one click at a rival 1-2 tiles away but not beside us.
    // Off (28/09 night): 0 accepted of ~420 (pc and android-app), and every bounce
    // costs 100 ms of server gap. reach_probe_config turns it back on.
    reachProbe: { enabled: false, lastAt: -1e9, count: 0, pendingAt: -1e9 },
    // 29/09 ally account (a second account playing next to the user's): accounts
    // (avatarInfo.id) and usernames the engine never targets (ally_config).
    allies: { accounts: new Set(), names: new Set(), blocked: 0 },
    // 29/09 auto Ring: outside the Ring, ask the queue status and join when out.
    autoRing: { enabled: false, lastAskAt: -1e9, lastJoinAt: -1e9, joins: 0, lastStatus: "",
      outSince: 0, awaySince: 0, exits: 0, lastLeaveAt: -1e9, lastNavAt: -1e9, leaves: 0, lobbyTrips: 0,
      // 29/09 re-queue key (requeue_hotkey_config): KeyboardEvent.code, "" = off.
      // oneShotUntil: the cycle runs once, without its waits, until we are queued.
      hotkey: "", oneShotUntil: 0, requeues: 0 },
    // 29/09 random emotes (emote_config): one every minMs..maxMs, never with a rival close in the Ring.
    emotes: { enabled: false, minMs: 25000, maxMs: 70000, nextAt: 0, sent: 0, skipped: 0, last: 0 },
    // 29/09 render off: the game logic runs, PIXI stops drawing (CPU for timing).
    renderOff: { enabled: false, orig: null, app: null, patched: 0 },
    seq: 1,
    // Duel lab (harness/run_duel_lab.js): packet log on the shared epoch clock
    // and actions scheduled to the millisecond. Off in normal play.
    duel: { on: false, buf: [], results: [], composeAt: 0, composeZones: [] },
    burstPlans: [],
    lastBurstKey: "",
    lastStepDur: HTML5_STEP_MS,
    lastSceneHash: "",
    sceneCache: null,
    sceneCacheAt: 0,
    gridPlan: null,
    gridLastFireKey: "",
    gridLastFireAt: 0,
    stateArmKey: "",
    stateArmAt: 0,
    pumpTimer: null,
    pumpMode: null,
    nextBurstTimer: null,
    timingWorker: null,
    timingWorkerUrl: null,
    workerPlans: new Map(),
    workerPlanSeq: 0,
    metricBudget: {
      windowStart: 0,
      count: 0
    },
    idleSoft: false,
    actors: new Map(),
    lastPunch: {
      at: 0,
      targetId: -1,
      seq: 0,
      reason: "",
      orient: 0,
      selfX: -999,
      selfY: -999,
      targetX: -999,
      targetY: -999
    },
    sendTimer: null,
    lastStateAt: 0,
    lastConfigAt: 0,
    lastSceneAt: 0,
    hubConnected: false,
    stats: {
      fires: 0,
      fireAttempts: 0,
      blockedFires: 0,
      sendErrors: 0,
      arms: 0,
      hubIn: 0,
      hubOut: 0,
      rejects: 0,
      resolves: 0
    }
  };

  function now() {
    return performance.now();
  }

  function asId(value) {
    const n = Number(value);
    return Number.isFinite(n) ? (n | 0) : null;
  }

  function clamp(n, lo, hi) {
    n = n | 0;
    if (n < lo) return lo;
    if (n > hi) return hi;
    return n;
  }

  function providerInstance(provider) {
    if (!provider) return null;
    return (
      provider.instance ||
      (provider.exported && (provider.exported.instance || provider.exported._instance)) ||
      null
    );
  }

  function is2dNumberMatrix(value) {
    if (!Array.isArray(value) || !value.length || !Array.isArray(value[0])) return false;
    return Number.isFinite(Number(value[0][0]));
  }

  function findModuleUrls() {
    const urls = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .filter((url) => /\/betahtml5\/_astro\/.*\.js(?:[?#].*)?$/.test(url));
    return Array.from(new Set(urls)).sort((a, b) => {
      const aKnown = /BuitkjVD|JuPwHUqq|BM23OEo0/.test(a) ? 0 : 1;
      const bKnown = /BuitkjVD|JuPwHUqq|BM23OEo0/.test(b) ? 0 : 1;
      return aKnown - bKnown;
    });
  }

  function findMapFromInstance(instance) {
    if (!instance || typeof instance !== "object") return null;
    if (is2dNumberMatrix(instance.map)) return { map: instance.map, source: "map" };
    const sm = instance.spaceModel || instance.escenario || instance.scenario;
    if (sm) {
      if (is2dNumberMatrix(sm.map)) return { map: sm.map, source: "spaceModel.map" };
      if (sm.escenario && is2dNumberMatrix(sm.escenario.matrix)) {
        return { map: sm.escenario.matrix, source: "spaceModel.escenario.matrix" };
      }
      if (is2dNumberMatrix(sm.matrix)) return { map: sm.matrix, source: "spaceModel.matrix" };
    }
    if (instance.escenario && is2dNumberMatrix(instance.escenario.matrix)) {
      return { map: instance.escenario.matrix, source: "escenario.matrix" };
    }
    return null;
  }

  function findProviders(moduleObject) {
    const found = {
      upper: null,
      socket: null,
      renderer: null,
      walk: null,
      selection: null,
      ping: null,
      space: null,
      map: null,
      nav: null,
      packet: null,
      game: null,
      pixi: null,
      action: null
    };
    for (const [exportName, exported] of Object.entries(moduleObject || {})) {
      const instance = exported && (exported.instance || exported._instance);
      const prototype = exported && exported.prototype;
      const method = (name) =>
        typeof instance?.[name] === "function" ||
        typeof prototype?.[name] === "function";
      if (!found.upper && method("upperRequest")) {
        found.upper = { exportName, exported, instance };
      }
      if (!found.socket && method("sendServerMessage") && method("handleReceivedBytes")) {
        found.socket = { exportName, exported, instance };
      }
      if (!found.renderer && method("moveUser") && method("punchUsers")) {
        found.renderer = { exportName, exported, instance };
      }
      if (!found.walk && method("walk") && method("exitSpace")) {
        found.walk = { exportName, exported, instance };
      }
      // avatarFichado is a getter on the prototype since the 25/09 client, and
      // the singleton may not exist yet when boot runs on the loading screen.
      if (
        !found.selection &&
        ((instance && "avatarFichado" in instance) ||
          (prototype && "avatarFichado" in prototype))
      ) {
        found.selection = { exportName, exported, instance };
      }
      // Island navigation (duel lab rejoin): islandRequest(isArea, zoneId, pwd).
      // The game's packet class (duel lab raw requests): new P(id[, type]) + appendParameter.
      if (!found.packet && typeof exported === "function" && typeof prototype?.appendParameter === "function" && typeof prototype?.toByteArray === "function") {
        found.packet = { exportName, exported, instance: null };
      }
      if (!found.nav && method("islandRequest") && method("clearPendingNavigation")) {
        found.nav = { exportName, exported, instance };
      }
      // Ring queue: gameRequest(1, 1) = 160/121 [1,1]; gameStatusRequest = 160/123 [0].
      if (!found.game && method("gameRequest") && method("gameStatusRequest")) {
        found.game = { exportName, exported, instance };
      }
      if (!found.pixi && method("loadPIXIScene") && method("applyResolution")) {
        found.pixi = { exportName, exported, instance };
      }
      // Emotes: actionRequest(id) = 134 ["", id] (the emote wheel).
      if (!found.action && method("actionRequest") && method("changeUpperRequest")) {
        found.action = { exportName, exported, instance };
      }
      if (!found.ping && instance && "latency" in instance && method("sendPing")) {
        found.ping = { exportName, exported, instance };
      }
      if (
        !found.space &&
        instance &&
        "currentSpaceId" in instance &&
        "currentSpaceName" in instance
      ) {
        found.space = { exportName, exported, instance };
      }
      if (!found.map && instance) {
        const mapHit = findMapFromInstance(instance);
        if (mapHit) {
          found.map = { exportName, exported, instance, mapInfo: mapHit };
        }
      }
    }
    return found;
  }

  function providersComplete(providers) {
    return Boolean(
      providers &&
        providers.upper &&
        providers.renderer &&
        providers.socket &&
        providers.walk
    );
  }

  function sendToHub(obj) {
    if (!obj || typeof obj !== "object") return false;
    state.stats.hubOut++;
    try {
      if (typeof window.__bbHubSend === "function") {
        window.__bbHubSend(obj);
        return true;
      }
    } catch {}
    return false;
  }

  function refreshPing() {
    const ping = providerInstance(state.providers.ping);
    if (ping && Number.isFinite(Number(ping.latency))) {
      state.serverPingMs = Math.round(Number(ping.latency));
    }
  }

  function sendDiagnostic(event, data = {}) {
    if (!state.diagnostics.enabled) return;
    const socket = providerInstance(state.providers.socket);
    sendToHub({
      type: "diagnostic_event",
      event,
      ts: now(),
      bridgeBuild: BRIDGE_BUILD,
      selfId: inferSelfId(),
      selectedId: selectedId(),
      serverPingMs: state.serverPingMs,
      hidden: typeof document !== "undefined" && Boolean(document.hidden),
      inboundBacklog: Number(socket?.inboundBacklog) || 0,
      ...data
    });
  }

  function inferSelfId() {
    const renderer = providerInstance(state.providers.renderer);
    if (!(renderer?.avatars instanceof Map)) return state.selfId;
    if (state.selfUsername) {
      for (const [id, avatar] of renderer.avatars) {
        const name = String(avatar?.avatarInfo?.username || "").trim();
        if (name && name.toLowerCase() === state.selfUsername.toLowerCase()) {
          state.selfId = asId(id) ?? state.selfId;
          return state.selfId;
        }
      }
    }
    if (state.selfId >= 0 && renderer.avatars.has(state.selfId)) return state.selfId;
    return state.selfId;
  }

  function selectedId() {
    const sel = providerInstance(state.providers.selection);
    const fichado = asId(sel?.avatarFichado?.userSpaceId);
    if (fichado != null && fichado >= 0) {
      state.selectedId = fichado;
      return fichado;
    }
    return state.selectedId;
  }

  function lateralAdjacent(ax, ay, bx, by) {
    const dx = (bx | 0) - (ax | 0);
    const dy = (by | 0) - (ay | 0);
    return dx === dy && Math.abs(dx) === 1;
  }

  function actorFor(id) {
    return state.actors.get(id | 0) || null;
  }

  function ensureActorFromRenderer(id) {
    let actor = actorFor(id);
    if (actor) {
      // Placed on a tile without a step (round start, a teleport): the game's
      // own position wins once no step of ours is in flight (26/09: at round
      // start the ring-board kept walking us to the tile we already stood on).
      if (now() - (actor.startAt || 0) > (actor.stepMs || 600) + 80) {
        const pos = providerInstance(state.providers.renderer)?.avatars?.get?.(id)?.position;
        const x = Number(pos?.x);
        const y = Number(pos?.y);
        if (Number.isFinite(x) && Number.isFinite(y) && ((x | 0) !== actor.toX || (y | 0) !== actor.toY)) {
          actor.fromX = actor.toX = x | 0;
          actor.fromY = actor.toY = y | 0;
          actor.dirX = 0;
          actor.dirY = 0;
          actor.moving = false;
          actor.key = `${id}:${x | 0},${y | 0}`;
        }
      }
      return actor;
    }
    const renderer = providerInstance(state.providers.renderer);
    const avatar = renderer?.avatars?.get?.(id);
    if (!avatar) return null;
    const pos = avatar.position || {};
    const x = Number(pos.x) | 0;
    const y = Number(pos.y) | 0;
    actor = {
      fromX: x,
      fromY: y,
      toX: x,
      toY: y,
      dirX: 0,
      dirY: 0,
      startAt: Math.round(now()),
      endAt: Math.round(now()),
      stepMs: 0,
      moving: false,
      orient: Number(pos.z) || 0,
      key: `${id}:${x},${y}`
    };
    state.actors.set(id | 0, actor);
    return actor;
  }

  // Room ids change every round: log who is behind each id (once per id/name)
  // so a session can be studied per player (tools/analyze_rivals.js).
  const rosterNames = new Map();
  function noteRoster(id) {
    const avatar = providerInstance(state.providers.renderer)?.avatars?.get?.(id);
    const info = avatar?.avatarInfo;
    const name = info?.username;
    if (!name || rosterNames.get(id) === name) return;
    rosterNames.set(id, name);
    sendDiagnostic("roster", { id, name: String(name), accountId: Number(info.id) || -1 });
  }

  function punchLockUntil(id, selfId, acc) {
    const E = state.tickEngine;
    if (id === selfId) return Math.round(Math.max(E.selfLockEnd || 0, state.exitMode.self ? state.exitMode.self.endAt : 0));
    const coco = Number.isFinite(acc) ? state.exitMode.cocoByAccount.get(acc) : null;
    return Math.round(Math.max(E.lockUntil.get(id) || 0, coco ? coco.endAt + 20 : 0));
  }

  function collectPlayers() {
    const renderer = providerInstance(state.providers.renderer);
    const players = [];
    const t = Math.round(now());
    const sel = selectedId();
    const selfId = inferSelfId();
    if (!(renderer?.avatars instanceof Map)) return players;
    for (const [rawId, avatar] of renderer.avatars) {
      const id = asId(rawId);
      if (id == null || ((isStaleAvatar(avatar) || notRingSlot(id)) && id !== selfId)) continue;
      const info = avatar?.avatarInfo || {};
      const pos = avatar?.position || {};
      const x = Number(pos.x);
      const y = Number(pos.y);
      const actor = ensureActorFromRenderer(id);
      const moving = Boolean(actor?.moving && t - (actor.startAt || 0) < (actor.stepMs || 0) + 80);
      players.push({
        id,
        posId: id,
        userId: Number.isFinite(Number(info.id)) ? Number(info.id) : id,
        name: String(info.username || info.name || ""),
        state: Number(avatar?.state) || 0,
        skin: Number(info.skinId ?? info.skin) || 0,
        x: Number.isFinite(x) ? x | 0 : 0,
        y: Number.isFinite(y) ? y | 0 : 0,
        orient: Number(pos.z ?? info.orientation) || 0,
        fromX: actor ? actor.fromX : Number.isFinite(x) ? x | 0 : 0,
        fromY: actor ? actor.fromY : Number.isFinite(y) ? y | 0 : 0,
        toX: actor ? actor.toX : Number.isFinite(x) ? x | 0 : 0,
        toY: actor ? actor.toY : Number.isFinite(y) ? y | 0 : 0,
        dirX: actor ? actor.dirX : 0,
        dirY: actor ? actor.dirY : 0,
        stepStartAt: actor ? actor.startAt : t,
        stepDur: actor ? actor.stepMs : 0,
        phase: actor && actor.stepMs > 0
          ? Math.max(0, Math.min(1, (t - actor.startAt) / actor.stepMs))
          : 1,
        moving,
        selected: id === sel,
        self: id === selfId,
        cocoMs: exitCocoRemaining(Number(info.id), t),
        // When its punches count again (local ms): ours covers the round start,
        // our punch animation and our coco; a rival's its animation and coco.
        lockUntil: punchLockUntil(id, selfId, Number(info.id)),
        // 182 field 6 of its last step: 0 = its path goes on, 1 = last step
        walkFlag: state.tickEngine.cont.has(id) ? state.tickEngine.cont.get(id) : 1,
        lastTurnAt: Math.round(state.attention.get(id)?.turnAt || 0),
        facing: state.attention.get(id)?.facing || 0,
        active: Boolean(state.attention.get(id)?.turnAt || state.attention.get(id)?.active)
      });
    }
    return players;
  }

  function timingSourceMode() {
    return String(state.timing.source || "STEP").toUpperCase();
  }

  function timingModeActive() {
    return Boolean(state.timing.enabled) && !state.pulse.enabled;
  }

  function leadClamp(value) {
    return clamp(value, 0, 120);
  }

  function leadReset() {
    state.lead.ms = 0;
    state.lead.estimate = 0;
    state.lead.samples = 0;
    state.lead.lastAt = 0;
    state.lead.lastDelay = 0;
    state.lead.lastResidual = 0;
    state.lead.lastAccepted = false;
  }

  function leadCurrent() {
    if (state.lead.lastAt > 0 && now() - state.lead.lastAt > 12000) {
      leadReset();
    }
    if (state.lead.samples <= 0) return 0;
    return leadClamp(state.lead.ms);
  }

  function leadNote(plannedAt, firedAt, leadMs) {
    state.lead.lastAccepted = false;
    if (plannedAt <= 0 || firedAt <= 0) return false;
    const lead = leadClamp(leadMs);
    const due = plannedAt - lead;
    let delay = firedAt - due;
    const residual = firedAt - plannedAt;
    state.lead.lastDelay = delay;
    state.lead.lastResidual = residual;
    if (delay < -8 || delay > 160 || residual < -180 || residual > 220) {
      return false;
    }
    if (delay < 0) delay = 0;
    const sample = leadClamp(delay);
    if (state.lead.samples <= 0) {
      state.lead.estimate = sample;
    } else {
      let alpha = state.lead.samples < 4 ? 0.45 : 0.25;
      if (Math.abs(residual) <= 3) alpha = 0.1;
      state.lead.estimate = state.lead.estimate * (1 - alpha) + sample * alpha;
    }
    state.lead.ms = leadClamp(Math.round(state.lead.estimate));
    if (state.lead.samples < 80) state.lead.samples++;
    state.lead.lastAt = Math.round(now());
    state.lead.lastAccepted = true;
    return true;
  }

  function fnv1aHex(text) {
    const ring = window.__BBFlashRingScene;
    if (ring && typeof ring.fnv1aHex === "function") return ring.fnv1aHex(text);
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  function buildRingMatricesFallback() {
    const ring = window.__BBFlashRingScene;
    if (ring && typeof ring.buildRingMatrices === "function") {
      return ring.buildRingMatrices();
    }
    const rows = RING_ROWS_FALLBACK;
    // Absolute client coordinates: map[y][x] on the 28x27 mGame2 grid.
    const width = 28;
    const height = 27;
    const matrix = [];
    const blocked = [];
    for (let y = 0; y < height; y++) {
      const row = [];
      const range = rows.get(y);
      for (let x = 0; x < width; x++) {
        const ok = Boolean(range) && x >= range[0] && x <= range[1];
        row.push(ok ? 0 : 1);
        if (!ok) blocked.push({ x, y });
      }
      matrix.push(row);
    }
    return {
      width,
      height,
      matrix,
      walkableMatrix: matrix.map((row) => row.slice()),
      blocked,
      originX: 0,
      originY: 0
    };
  }

  // Space renderer (class with avatars + spaceModel). The provider found at boot
  // can be the multiuser facade (moveUser/punchUsers delegate to it), and in
  // the lobby spaceModel is not loaded yet, so resolve it on every build.
  function sceneRenderer() {
    const renderer = providerInstance(state.providers.renderer);
    if (renderer && "spaceModel" in renderer) return renderer;
    try {
      const smr = window.BoomBang?.smr?.();
      if (smr && "spaceModel" in smr) return smr;
    } catch {}
    return renderer || null;
  }

  function collectOccupied(renderer) {
    const occupied = [];
    if (renderer?.avatars instanceof Map) {
      for (const [rawId, avatar] of renderer.avatars) {
        const id = asId(rawId);
        const pos = avatar?.position || {};
        if (id == null || !Number.isFinite(Number(pos.x)) || !Number.isFinite(Number(pos.y))) continue;
        occupied.push({ x: Number(pos.x) | 0, y: Number(pos.y) | 0, id });
      }
    }
    return occupied;
  }

  // Static walk matrix of the current room, same source as the client's
  // getStaticWalkMatrix(): spaceModel.escenario.matrix.rows[].data ("0, 1, ...").
  // 0 = walkable, 1 = blocked. Indexed map[y][x] in client tile coordinates.
  function liveStaticMatrix(renderer) {
    const model = renderer?.spaceModel;
    if (!model) return null;
    let rows = null;
    try {
      if (typeof renderer.getStaticWalkMatrix === "function") rows = renderer.getStaticWalkMatrix();
    } catch {}
    if (!is2dNumberMatrix(rows)) {
      const raw = model.escenario?.matrix?.rows;
      if (Array.isArray(raw) && raw.length) {
        rows = raw.map((row) => String(row?.data ?? "").split(",").map((v) => Number(v)));
      }
    }
    if (!is2dNumberMatrix(rows)) return null;
    return {
      model,
      name: String(model.name || ""),
      matrix: rows.map((row) => row.map((v) => (Number(v) === 0 ? 0 : 1)))
    };
  }

  // Occupancy copy (client-side, not authoritative): static + 1 under avatars.
  function liveOccupancyMatrix(model, width, height) {
    const map = model?.map;
    if (!is2dNumberMatrix(map) || map.length !== height || (map[0]?.length || 0) !== width) return null;
    return map.map((row) => row.map((v) => (Number(v) === 0 ? 0 : 1)));
  }

  function buildSceneData() {
    const renderer = sceneRenderer();
    const occupied = collectOccupied(renderer);

    let matrix = null;
    let walkableMatrix = null;
    let occupancyMatrix = null;
    let blocked = [];
    let width = 0;
    let height = 0;
    let originX = 0;
    let originY = 0;
    let source = "fallback_ring";
    let modelRef = null;
    let spaceName = "";

    const live = liveStaticMatrix(renderer);
    const mapProv = state.providers.map;
    const mapHit = live ? null : mapProv?.mapInfo || findMapFromInstance(providerInstance(mapProv));
    if (live) {
      matrix = live.matrix;
      height = matrix.length;
      width = matrix[0]?.length || 0;
      walkableMatrix = matrix.map((row) => row.slice());
      occupancyMatrix = liveOccupancyMatrix(live.model, width, height);
      source = "live_static";
      modelRef = live.model;
      spaceName = live.name;
    } else if (mapHit?.map && is2dNumberMatrix(mapHit.map)) {
      matrix = mapHit.map.map((row) => row.map((v) => Number(v) | 0));
      height = matrix.length;
      width = matrix[0]?.length || 0;
      walkableMatrix = matrix.map((row) => row.map((v) => (v === 0 || v === 2 ? 0 : 1)));
      source = "provider_map";
    } else {
      const ring = buildRingMatricesFallback();
      matrix = ring.matrix;
      walkableMatrix = ring.walkableMatrix;
      width = ring.width;
      height = ring.height;
      originX = ring.originX || 0;
      originY = ring.originY || 0;
    }
    if (!blocked.length) {
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          if (walkableMatrix[y][x] !== 0) blocked.push({ x: x + originX, y: y + originY });
        }
      }
    }

    // Hash only the static layout so it stays stable while avatars move.
    const hashParts = [];
    for (let y = 0; y < height; y++) {
      hashParts.push((matrix[y] || []).join(","));
    }
    return {
      sceneHash: fnv1aHex(`${width}:${height}:${hashParts.join("|")}`),
      width,
      height,
      matrix,
      walkableMatrix,
      occupancyMatrix: occupancyMatrix || matrix,
      occupied,
      blocked,
      originX,
      originY,
      sceneSource: source,
      spaceName,
      modelRef,
      overlayPoints: [],
      projection: { originX, originY, tileW: 0, tileH: 0 }
    };
  }

  function sendHello() {
    refreshPing();
    sendToHub({
      type: "hello",
      bridgeBuild: BRIDGE_BUILD,
      selfId: inferSelfId(),
      serverPingMs: state.serverPingMs,
      proxyRemoteHost: "",
      proxyRemotePort: "",
      ts: Math.round(now())
    });
  }

  function sendState() {
    refreshPing();
    sendToHub({
      type: "state",
      bridgeBuild: BRIDGE_BUILD,
      selfId: inferSelfId(),
      selectedId: selectedId(),
      serverPingMs: state.serverPingMs,
      players: collectPlayers(),
      tick: tickHubSummary(),
      simon: simonSummary(),
      exit: exitSummary(),
      ts: Math.round(now())
    });
  }

  function sendConfig() {
    if (state.diagnostics.enabled) {
      const config = {
        timing: { ...state.timing }, state: { ...state.stateCfg },
        grid: { ...state.grid }, punchPackets: state.punchPackets,
        pulse: { enabled: state.pulse.enabled, interval: state.pulse.interval, burst: state.pulse.burst, spacing: state.pulse.spacing },
        moveDelay: { enabled: state.moveDelay.enabled, delayMs: state.moveDelay.delayMs }
      };
      const key = JSON.stringify(config);
      if (key !== state.diagnostics.lastConfigKey) {
        state.diagnostics.lastConfigKey = key;
        sendDiagnostic("config", config);
      }
    }
    const src = timingSourceMode();
    const t = state.timing;
    const timingEnabled = timingModeActive() && src === "STEP";
    const stateEnabled = timingModeActive() && src === "STATE";
    const gridEnabled = timingModeActive() && src === "GRID";
    sendToHub({
      type: "config",
      bridgeBuild: BRIDGE_BUILD,
      selfId: inferSelfId(),
      serverPingMs: state.serverPingMs,
      punchPackets: state.punchPackets,
      timing: {
        ...t,
        enabled: timingEnabled,
        preFace: state.preFace.enabled || t.preFace,
        autoLead: leadCurrent()
      },
      state: {
        enabled: stateEnabled,
        delay: state.stateCfg.delay
      },
      grid: {
        enabled: gridEnabled,
        lead: state.grid.lead,
        gap: t.gap,
        burst: state.grid.burst,
        spacing: state.grid.spacing,
        pingComp: state.grid.pingComp,
        pingCompMs: state.grid.pingCompMs,
        autoLead: leadCurrent()
      },
      resolver: {
        enabled: false,
        mode: "INLINE",
        lead: state.grid.lead,
        slot: 0,
        gap: t.gap,
        burst: 1,
        spacing: 1,
        pingComp: false,
        pingCompMs: 0,
        autoLead: leadCurrent()
      },
      pulse: {
        enabled: Boolean(state.pulse.enabled),
        interval: state.pulse.interval,
        burst: state.pulse.burst,
        spacing: state.pulse.spacing,
        gap: state.pulse.gap,
        pattern: state.pulse.pattern,
        microBursts: state.pulse.microBursts,
        microGap: state.pulse.microGap,
        jitter: state.pulse.jitter,
        requireSelected: state.pulse.requireSelected,
        multiTarget: state.pulse.multiTarget,
        autoTarget: state.pulse.autoTarget,
        autoRange: state.pulse.autoRange,
        contactOnly: state.pulse.contactOnly,
        autoTargetId: state.pulse.autoTargetId,
        preFace: state.preFace.enabled || state.pulse.preFace,
        lastFireCount: state.pulse.lastFireCount
      },
      preFace: {
        enabled: Boolean(state.preFace.enabled || t.preFace),
        sent: state.preFace.sent,
        lastOrient: state.preFace.lastOrient,
        lastAt: state.preFace.lastAt
      },
      packetBus: { ...state.packetBus },
      tickPhase: {
        enabled: false,
        lock: false,
        phaseMs: 0,
        confidence: 0,
        samples: 0,
        periodMs: 600
      },
      resolveLock: {
        enabled: false,
        observer: state.resolveLock.observer,
        tickPhaseClean: state.resolveLock.tickPhaseClean,
        alpha: state.resolveLock.alpha,
        clientObservedResolveDelayMs: state.resolveLock.clientObservedResolveDelayMs,
        clientObservedResolveDelaySamples: state.resolveLock.clientObservedResolveDelaySamples,
        enemyObservedResolveDelayMs: state.resolveLock.enemyObservedResolveDelayMs,
        enemyObservedResolveDelaySamples: state.resolveLock.enemyObservedResolveDelaySamples,
        slotPeriodMs: state.resolveLock.slotPeriodMs,
        slotPeriodSamples: state.resolveLock.slotPeriodSamples,
        serverPingHintMs: state.serverPingMs,
        confidence: state.resolveLock.confidence
      },
      moveDelay: {
        enabled: Boolean(state.moveDelay.enabled),
        delayMs: state.moveDelay.delayMs,
        minMoveMs: state.moveDelay.minMoveMs
      },
      dropHunter: {
        enabled: Boolean(state.dropHunter.enabled),
        autoReturn: Boolean(state.dropHunter.autoReturn),
        autoClaim: Boolean(state.dropHunter.autoClaim),
        state: state.dropHunter.state,
        keyword: state.dropHunter.keyword,
        lastEvent: state.dropHunter.lastEvent,
        dropId: state.dropHunter.dropId,
        x: state.dropHunter.x,
        y: state.dropHunter.y
      },
      performance: { ...state.performance },
      ts: Math.round(now())
    });
  }

  function sendSceneSnapshot(force) {
    const t = Math.round(now());
    if (!force && t - state.lastSceneAt < state.performance.sceneMs) {
      return;
    }
    // Reuse cached static matrices; only refresh occupancy each tick.
    const scene = buildSceneDataCached(force);
    if (!scene) return;
    if (!force && scene.sceneHash === state.lastSceneHash && t - state.lastSceneAt < state.performance.sceneMs) {
      return;
    }
    state.lastSceneHash = scene.sceneHash;
    state.lastSceneAt = t;
    const { modelRef, baseHash, ...payload } = scene;
    sendToHub({
      ...payload,
      type: "scene_snapshot",
      bridgeBuild: BRIDGE_BUILD,
      selfId: inferSelfId(),
      serverPingMs: state.serverPingMs,
      timestamp: t,
      allowed: true,
      ts: t
    });
  }

  function buildSceneDataCached(force) {
    const t = Math.round(now());
    const renderer = sceneRenderer();
    const model = renderer?.spaceModel || null;
    // Rebuild on room change (new spaceModel) or when the live matrix appears
    // after the fallback was cached; otherwise refresh only avatar positions.
    const stale =
      !state.sceneCache ||
      t - state.sceneCacheAt >= 5000 ||
      state.sceneCache.modelRef !== model ||
      (model && state.sceneCache.sceneSource !== "live_static");
    if (!force && !stale) {
      const occupied = collectOccupied(renderer);
      const occupancyMatrix =
        liveOccupancyMatrix(model, state.sceneCache.width, state.sceneCache.height) || state.sceneCache.matrix;
      return {
        ...state.sceneCache,
        occupied,
        occupancyMatrix,
        sceneHash: state.sceneCache.baseHash
      };
    }
    const full = buildSceneData();
    if (!full) return null;
    state.sceneCache = {
      width: full.width,
      height: full.height,
      matrix: full.matrix,
      walkableMatrix: full.walkableMatrix,
      blocked: full.blocked,
      originX: full.originX,
      originY: full.originY,
      projection: full.projection,
      sceneSource: full.sceneSource,
      spaceName: full.spaceName,
      modelRef: full.modelRef,
      baseHash: full.sceneHash
    };
    state.sceneCacheAt = t;
    return full;
  }


  function sendTimingMetric(phase, mode, targetId, plannedMs, actualMs, lateMs, stepMs, count, ok, detail, extra) {
    if (!state.timing.fireMetrics) return;
    // Cap metric flood during dense bursts (Hub UI used to choke on these).
    const t = Math.round(now());
    if (phase === "fire") {
      if (t - state.metricBudget.windowStart > 1000) {
        state.metricBudget.windowStart = t;
        state.metricBudget.count = 0;
      }
      state.metricBudget.count++;
      if (state.metricBudget.count > 40) return;
    }
    const msg = {
      type: "timing_metric",
      bridgeBuild: BRIDGE_BUILD,
      phase,
      mode,
      selfId: inferSelfId(),
      targetId,
      plannedMs,
      actualMs,
      lateMs,
      stepMs,
      count,
      ok: Boolean(ok),
      detail: detail || "",
      ts: t
    };
    if (extra && typeof extra === "object") Object.assign(msg, extra);
    sendToHub(msg);
  }

  function sendResolveEvent(attackerId, defenderId) {
    const t = Math.round(now());
    const selfId = inferSelfId();
    const selfActor = actorFor(selfId);
    const targetActor = actorFor(selectedId());
    const selfStepAge = selfActor ? t - (selfActor.startAt || t) : -1;
    const targetStepAge = targetActor ? t - (targetActor.startAt || t) : -1;
    const lastPunchAge = state.lastPunch.at > 0 ? t - state.lastPunch.at : -1;
    sendToHub({
      type: "resolve_event",
      bridgeBuild: BRIDGE_BUILD,
      selfId,
      attackerId,
      defenderId,
      winner: attackerId,
      contested: false,
      targetId: selectedId(),
      timestamp: t,
      selfStepAgeMs: selfStepAge,
      targetStepAgeMs: targetStepAge,
      lastPunchAgeMs: lastPunchAge,
      lastPunchTargetId: state.lastPunch.targetId,
      lastPunchSeq: state.lastPunch.seq,
      lastPunchReason: state.lastPunch.reason,
      lastPunchOrient: state.lastPunch.orient,
      lastPunchSelfX: state.lastPunch.selfX,
      lastPunchSelfY: state.lastPunch.selfY,
      lastPunchTargetX: state.lastPunch.targetX,
      lastPunchTargetY: state.lastPunch.targetY,
      ts: t
    });
    state.stats.resolves++;
  }

  function sendPrefaceEvent(targetId, orient, reason) {
    sendToHub({
      type: "preface_event",
      bridgeBuild: BRIDGE_BUILD,
      selfId: inferSelfId(),
      targetId,
      orient,
      reason: reason || "",
      sent: state.preFace.sent,
      ts: Math.round(now())
    });
  }

  function sendPacketEvent(direction, packet) {
    if (!state.packetBus.enabled || !packet) return;
    sendToHub({
      type: "packet_event",
      bridgeBuild: BRIDGE_BUILD,
      dir: direction,
      opcode: packet.id,
      packetType: packet.type || 0,
      subType: packet.subType || 0,
      fields: [...(packet.fields || [])],
      ts: Math.round(now())
    });
  }

  function sendDropHunterEvent(eventName) {
    sendToHub({
      type: "drop_hunter_event",
      bridgeBuild: BRIDGE_BUILD,
      enabled: Boolean(state.dropHunter.enabled),
      event: eventName,
      state: state.dropHunter.state,
      keyword: state.dropHunter.keyword,
      lastEvent: state.dropHunter.lastEvent,
      dropId: state.dropHunter.dropId,
      x: state.dropHunter.x,
      y: state.dropHunter.y,
      ts: Math.round(now())
    });
  }

  function scaleWindowMs(value, stepMs) {
    if (!state.timing.stepScale) return value | 0;
    const dur = stepMs > 0 ? stepMs : HTML5_STEP_MS;
    return Math.round((value * dur) / STEP_HUB_REF_MS) | 0;
  }

  function randomInt(min, max) {
    if (max < min) max = min;
    return min + ((Math.random() * (max - min + 1)) | 0);
  }

  function resolvedRate() {
    return state.timing.randomInterval
      ? randomInt(state.timing.intervalMin, state.timing.intervalMax)
      : state.timing.rate | 0;
  }

  function resolvedMult() {
    return state.timing.randomMultiplier
      ? randomInt(state.timing.multMin, state.timing.multMax)
      : Math.max(1, state.timing.mult | 0);
  }

  function profileOffset(span, index, total) {
    if (state.timing.profile === "TRIPLE") {
      if (total <= 1) return 0;
      if (index <= 0) return 0;
      if (index >= total - 1) return span;
      return Math.round(span * 0.5);
    }
    if (total <= 1) {
      if (state.timing.profile === "FRONT" || state.timing.profile === "EDGE") return 0;
      if (state.timing.profile === "END") return span;
      return Math.round(span * 0.5);
    }
    let t = index / (total - 1);
    if (state.timing.profile === "FRONT") t = Math.pow(t, 1.75);
    else if (state.timing.profile === "END") t = 1 - Math.pow(1 - t, 1.75);
    else if (state.timing.profile === "CENTER") t = 0.5 + (t - 0.5) * 0.55;
    else if (state.timing.profile === "EDGE") t = index % 2 === 0 ? t * 0.5 : 0.5 + t * 0.5;
    return Math.round(span * t);
  }

  function applyMinGap(offsets, gap) {
    const g = Math.max(0, gap | 0);
    const sorted = offsets.slice().sort((a, b) => a - b);
    if (!sorted.length) return [0];
    const out = [];
    let last = -999999;
    for (const off of sorted) {
      const v = off | 0;
      if (v - last >= g) {
        out.push(v);
        last = v;
      }
    }
    return out.length ? out : [0];
  }

  function limitOffsets(offsets, max) {
    if (offsets.length <= max) return offsets;
    const out = [];
    let prev = -1;
    for (let i = 0; i < max; i++) {
      const idx = max <= 1 ? offsets.length - 1 : Math.round((i * (offsets.length - 1)) / (max - 1));
      if (idx !== prev || i === 0) out.push(offsets[idx] | 0);
      prev = idx;
    }
    return out.length ? out : [0];
  }

  function buildOffsets(spanMs) {
    let span = spanMs | 0;
    if (span < 0) span = 0;
    const clicks = state.timing.clicks | 0;
    let rate = resolvedRate();
    const mult = resolvedMult();
    const gap = state.timing.gap | 0;
    const out = [];

    if (span === 0) return [0];
    if (state.timing.profile === "TRIPLE") {
      return limitOffsets(applyMinGap([0, Math.round(span * 0.5), span], gap), 3);
    }

    if (clicks > 0) {
      const total = Math.max(1, clicks * mult);
      for (let i = 0; i < total; i++) out.push(profileOffset(span, i, total));
    } else if (rate > 0) {
      if (state.timing.power) rate = 1;
      else if (mult > 1) rate = Math.max(1, Math.round(rate / mult));
      const total = Math.max(1, Math.ceil(span / rate) + 1);
      for (let i = 0; i < total; i++) out.push(profileOffset(span, i, total));
    } else {
      const total = (state.timing.power ? 64 : 24) * mult;
      for (let i = 0; i < total; i++) out.push(profileOffset(span, i, total));
    }

    if (!out.length || out.indexOf(span) < 0) out.push(span);
    const max = state.timing.stepAnchor === "BOTH" ? 12 : 16;
    return limitOffsets(applyMinGap(out, gap), max);
  }

  // Same rule as the client's moveUser (live bundle 21/09): screen-space facing.
  // 1 right, 2 left, 3 up, 4 down/camera, 5 up-right, 6 up-left, 7 down-right, 8 down-left.
  function computeOrient(selfX, selfY, targetX, targetY) {
    const c = Math.sign((targetX | 0) - (selfX | 0));
    const o = Math.sign((targetY | 0) - (selfY | 0));
    if (c === 0 && o === 0) return 0;
    const l = c + o;
    const z = o - c;
    if (z < 0) return l < 0 ? 6 : l > 0 ? 5 : 3;
    if (z > 0) return l < 0 ? 8 : l > 0 ? 7 : 4;
    return l < 0 ? 2 : l > 0 ? 1 : 4;
  }

  // The official client turns our avatar towards the mouse (rotationRequest on
  // every mouse move), so when an engine clicks we may be facing away. July
  // recordings: requests while facing away from the target never landed (0 of
  // 28). An engine click first turns us towards the side the target is (or
  // will be, after our own step) on; the server applies a rotation at once.
  function faceSide(meX, meY, tX, tY) {
    const s = (tX - meX) + (tY - meY); // horizontal screen component
    if (s > 0) return 1;
    if (s < 0) return 2;
    return computeOrient(meX, meY, tX, tY);
  }

  // Off (26/09, user's call): facing does not matter live ("da igual donde
  // mires"); the July 0-of-28 were rivals standing idle, not the turn.
  const FACE_BEFORE_CLICK = false;
  function faceBeforeClick(orient) {
    if (!FACE_BEFORE_CLICK || !(orient > 0)) return false;
    const upper = providerInstance(state.providers.upper);
    if (!upper || typeof upper.rotationRequest !== "function") return false;
    try {
      upper.rotationRequest(orient);
      state.stats.faced = (state.stats.faced || 0) + 1;
      return true;
    } catch {
      return false;
    }
  }

  function preFaceTarget(targetId, reason) {
    if (!(state.preFace.enabled || state.timing.preFace || state.pulse.preFace)) return;
    const selfId = inferSelfId();
    const self = ensureActorFromRenderer(selfId);
    const target = ensureActorFromRenderer(targetId);
    if (!self || !target) return;
    const orient = computeOrient(self.toX, self.toY, target.toX, target.toY);
    if (orient <= 0) return;
    const t = Math.round(now());
    const key = `${selfId}:${targetId}:${orient}:${target.toX},${target.toY}`;
    if (key === state.preFace.lastKey && t - state.preFace.lastAt < 80) return;
    const upper = providerInstance(state.providers.upper);
    if (!upper || typeof upper.rotationRequest !== "function") return;
    try {
      upper.rotationRequest(orient);
      state.preFace.lastKey = key;
      state.preFace.lastAt = t;
      state.preFace.lastOrient = orient;
      state.preFace.sent++;
      sendPrefaceEvent(targetId, orient, reason || "");
    } catch {}
  }

  function notePunch(targetId, reason) {
    // Report only (Hub "Último disparo de Timing"): no decision reads it.
    if (reason && !["native", "CTRL", "manual"].includes(reason)) {
      const changed = state.lastAutomaticPunch?.targetId !== (targetId | 0);
      state.lastAutomaticPunch = { targetId: targetId | 0, reason, at: Math.round(now()) };
      // The request is already on the socket: tell the Hub now instead of with
      // the next state (250-700 ms), so its target field follows the engine.
      if (changed) sendToHub({ type: "timing_target", targetId: targetId | 0, reason });
    }
    const self = ensureActorFromRenderer(inferSelfId());
    const target = ensureActorFromRenderer(targetId);
    state.lastPunch.seq++;
    state.lastPunch.at = Math.round(now());
    state.lastPunch.targetId = targetId | 0;
    state.lastPunch.reason = reason || "";
    state.lastPunch.orient = state.preFace.lastOrient;
    state.lastPunch.selfX = self ? self.toX : -999;
    state.lastPunch.selfY = self ? self.toY : -999;
    state.lastPunch.targetX = target ? target.toX : -999;
    state.lastPunch.targetY = target ? target.toY : -999;
  }

  // options.bypassThrottle: reset only the client's local 100 ms guard; the
  // server still decides what it accepts.
  function firePunch(targetId, reason, options) {
    let id = asId(targetId);
    if (id == null || id < 0) id = selectedId();
    if (id == null || id < 0 || id === inferSelfId()) return false;
    if (isAlly(id)) { state.allies.blocked++; return false; }
    // Simon Dice rooms: no automatic punches (they hit the others mid-game).
    if (!["CTRL", "manual"].includes(reason) && simonRoomActive()) { state.simon.punchesHeld++; return false; }
    const upper = providerInstance(state.providers.upper);
    if (!upper || typeof upper.upperRequest !== "function") return false;
    noThrottleInstall();
    // Engine shots that would land inside our coco are ignored by the server.
    if (!["CTRL", "manual"].includes(reason) && state.tickEngine.selfOut) {
      state.stats.outHeld = (state.stats.outHeld || 0) + 1;
      return false;
    }
    if (!["CTRL", "manual", "EXIT"].includes(reason) && exitBlocksLanding(now() + rttEstimateMs() + state.tickEngine.corr)) {
      state.stats.cocoHeld = (state.stats.cocoHeld || 0) + 1;
      return false;
    }
    // Engine shots that would land inside our post-hit lock are ignored too.
    // Not the unlock click: it is aimed at the lock's edge on purpose (a
    // request inside the lock is ignored by the server at no cost), and the
    // ping may have moved a few ms since it was armed 14 s before (26/09:
    // with the edge at end+1 the guard dropped an unlock click at #4, who hit
    // us 133 ms after the end).
    if (!["CTRL", "manual", "UNLOCK"].includes(reason) && selfLocked(now() + rttEstimateMs() + state.tickEngine.corr)) {
      state.stats.lockHeld = (state.stats.lockHeld || 0) + 1;
      return false;
    }
    preFaceTarget(id, reason || "punch");
    const bypass = Boolean(options?.bypassThrottle);
    // Engine shots go out as a burst 1 ms apart (26/09, user's call: test whether
    // near-simultaneous requests each get their own hold; measure our holds).
    // options.packets forces the count (27/09: the unlock click goes out alone).
    const packets = options?.packets ? clamp(options.packets, 1, 8) : bypass ? clamp(state.tickBurst, 1, TICK_BURST_MAX) : clamp(state.punchPackets, 1, 8);
    const before = state.outboundUpperSeq;
    const previousReason = state.activeFireReason;
    state.stats.fireAttempts++;
    state.activeFireReason = reason || "CTRL";
    let errors = 0;
    try {
      for (let i = 0; i < packets; i++) {
        if (i > 0) spinUntil(now() + TICK_BURST_GAP_MS);
        try {
          if (bypass) upper.lastUpperAt = -1e9;
          upper.upperRequest(id);
        } catch {
          errors++;
          state.stats.sendErrors++;
        }
      }
    } finally {
      state.activeFireReason = previousReason;
    }
    const sentCount = state.outboundUpperSeq - before;
    if (sentCount === 0) state.stats.blockedFires++;
    else {
      // (A tie's second click may be dropped by the server's gap after the
      // first one's 144: its silence says nothing about the target. Same for any
      // click within SILENT_GAP_MS of our previous click or of a reply, 29/09.)
      const E = state.tickEngine;
      const t = now();
      const inGap = t - (E.silentLastClickAt ?? -1e9) < SILENT_GAP_MS || t - (E.silentLastReplyAt ?? -1e9) < SILENT_GAP_MS;
      E.silentLastClickAt = t;
      if (!inGap && !["CTRL", "manual", "TICK_DUAL", "TICK_SWEEP", "TICK_REPEAT", "REACH_PROBE", "RETRY"].includes(reason)) {
        E.silentPending.push({ id, at: t });
        while (E.silentPending.length > 20) E.silentPending.shift();
      }
      // Common registry of every punch (28/09): a 144 names no request, so the
      // tick calibration must know when another engine's could own it.
      E.allShots.push({ at: t, targetId: id, reason: reason || "CTRL" });
      while (E.allShots.length > 40) E.allShots.shift();
    }
    state.lastFireResult = { targetId: id, reason: reason || "CTRL", calls: packets, sentCount, errors, ts: now() };
    sendDiagnostic("fire_attempt", state.lastFireResult);
    // This is an observed dispatch to the native socket API, not server acceptance.
    return sentCount > 0;
  }

  function moveTo(x, y) {
    const walk = providerInstance(state.providers.walk);
    if (!walk || typeof walk.walk !== "function") return false;
    try {
      walk.walk({ x: x | 0, y: y | 0 });
      return true;
    } catch {
      return false;
    }
  }

  // ---- Ring-board walk gate ----------------------------------------------------
  // The server drops a walk request sent < 100 ms after the one it kept, and
  // the ring-board decides on every state update (pairs 10-40 ms apart). 26/09,
  // 2 h session: 20,761 requests, 48% dropped (6,143 of them another tile), and
  // in 56% of ticks the server walked a tile other than its latest decision.
  // The gate keeps only its newest decision and sends it as soon as the gap
  // allows; a tile already sent is not sent again. Same session, simulated:
  // 2.5% of ticks off its latest decision, half the requests.
  const RB_GAP_MS = 102;
  const RB_REPEAT_MS = 700;

  function rbGateMove(msg) {
    const G = state.rbGate;
    if (G.pending) G.replaced++;
    G.pending = {
      x: msg.x | 0,
      y: msg.y | 0,
      bx: "backupX" in msg ? msg.backupX | 0 : null,
      by: "backupY" in msg ? msg.backupY | 0 : null
    };
    rbGateArm();
  }

  function rbGateArm() {
    const G = state.rbGate;
    if (G.timer) return; // the timer sends whatever is newest when it fires
    const wait = state.tickEngine.walkAcceptedAt + RB_GAP_MS - now();
    if (wait <= 0) {
      rbGateFlush();
      return;
    }
    G.timer = setTimeout(rbGateFlush, Math.ceil(wait));
  }

  function rbGateFlush() {
    const G = state.rbGate;
    G.timer = null;
    const p = G.pending;
    if (!p) return;
    // A request of ours went out meanwhile (step walk, the user): wait again.
    if (now() - state.tickEngine.walkAcceptedAt < RB_GAP_MS - 2) {
      rbGateArm();
      return;
    }
    G.pending = null;
    const key = `${p.x},${p.y}`;
    if (key === G.lastTile && now() - G.lastAt < RB_REPEAT_MS) {
      G.repeats++;
      return;
    }
    if (!moveTo(p.x, p.y) && p.bx != null && p.bx >= 0) moveTo(p.bx, p.by);
    G.lastTile = key;
    G.lastAt = now();
    G.sent++;
  }

  function selfTile() {
    const self = ensureActorFromRenderer(inferSelfId());
    if (!self) return null;
    return { x: self.toX | 0, y: self.toY | 0 };
  }

  function bumpSeq() {
    state.seq = (state.seq + 1) | 0;
    state.burstPlans = [];
    state.lastBurstKey = "";
    state.gridPlan = null;
    clearTimingWorker("bump");
  }

  // ---- Step walk ---------------------------------------------------------------
  // The server holds a hit on a defender that is in the middle of a path much
  // less than on one that stands or ends its walk there: July, our clicks at a
  // defender that kept walking resolved in <50 ms 38 times in 76, at one that
  // ended its walk on that step 10 in 46, at one standing 6 in 35 (live 26/09
  // and ~5,000 hits agree). In the Ring we are almost always walking, so every
  // walk of ours goes out one tile at a time: same path and speed (each tile is
  // requested right after the previous step arrives, ~430 ms before the next
  // tick), but for the server every step is the last one.
  const STEP_WALK_STALL_MS = 900;

  function stepWalkIntercept(packet) {
    const W = state.stepWalk;
    if (!W.enabled || W.internal) return false;
    const pk = coercePacket(packet);
    if (!pk || pk.id !== 182 || (pk.type || 0) !== 0) return false;
    const dest = String(pk.fields?.[0] || "");
    if (!/^\d{5}$/.test(dest)) return false;
    const goal = { x: Number(dest.slice(0, 2)), y: Number(dest.slice(2, 4)) };
    const me = ensureActorFromRenderer(inferSelfId());
    if (!me || state.tickEngine.selfOut) return false;
    const from = { x: me.toX | 0, y: me.toY | 0 };
    W.walks++;
    if (Math.max(Math.abs(goal.x - from.x), Math.abs(goal.y - from.y)) <= 1) {
      W.goal = null; // one tile: it already is a last step
      return false;
    }
    const next = stepWalkNext(from, goal);
    if (!next) {
      W.goal = null; // let the server find the path
      return false;
    }
    W.goal = goal;
    W.retries = 0;
    return stepWalkSend(next, from);
  }

  function stepWalkSend(tile, from) {
    const W = state.stepWalk;
    const P = state.providers.packet?.exported;
    const socket = providerInstance(state.providers.socket);
    if (typeof P !== "function" || !socket) return false;
    const pad = (v) => String(v | 0).padStart(2, "0");
    W.internal = true;
    try {
      const pk = new P(182);
      pk.appendParameter(`${pad(tile.x)}${pad(tile.y)}4`);
      pk.appendParameter("");
      socket.sendServerMessage(pk);
      W.sentAt = now();
      W.from = from;
      W.steps++;
      const sentAt = W.sentAt;
      setTimeout(() => stepWalkWatchdog(sentAt), STEP_WALK_STALL_MS);
      return true;
    } catch {
      return false;
    } finally {
      W.internal = false;
    }
  }

  // Our step arrived: ask for the next tile now, well before the next tick.
  function stepWalkOnSelfStep(x, y) {
    const W = state.stepWalk;
    if (!W.enabled || !W.goal) return;
    if (state.tickEngine.selfOut || (x === W.goal.x && y === W.goal.y)) {
      W.goal = null;
      return;
    }
    const next = stepWalkNext({ x, y }, W.goal);
    if (!next) {
      stepWalkGiveUp();
      return;
    }
    W.retries = 0;
    stepWalkSend(next, { x, y });
  }

  // A step that never came (tile taken, request lost): retry once from where
  // we are, then hand the whole walk to the server.
  function stepWalkWatchdog(sentAt) {
    const W = state.stepWalk;
    if (!W.goal || W.sentAt !== sentAt) return;
    const me = ensureActorFromRenderer(inferSelfId());
    if (!me) return;
    const from = { x: me.toX | 0, y: me.toY | 0 };
    if (from.x === W.goal.x && from.y === W.goal.y) {
      W.goal = null;
      return;
    }
    if (W.retries++ < 1) {
      const next = stepWalkNext(from, W.goal);
      if (next) {
        stepWalkSend(next, from);
        return;
      }
    }
    stepWalkGiveUp();
  }

  function stepWalkGiveUp() {
    const W = state.stepWalk;
    const goal = W.goal;
    W.goal = null;
    W.gaveUp++;
    if (!goal) return;
    const P = state.providers.packet?.exported;
    const socket = providerInstance(state.providers.socket);
    if (typeof P !== "function" || !socket) return;
    const pad = (v) => String(v | 0).padStart(2, "0");
    W.internal = true;
    try {
      const pk = new P(182);
      pk.appendParameter(`${pad(goal.x)}${pad(goal.y)}4`);
      pk.appendParameter("");
      socket.sendServerMessage(pk);
    } catch {} finally {
      W.internal = false;
    }
  }

  // Next tile towards the goal: straight at it (diagonal first) when free,
  // else the first step of a shortest 8-way path over the walkable matrix.
  // Tiles under other avatars count as taken (except the goal).
  function stepWalkNext(from, goal) {
    const selfId = inferSelfId();
    const taken = new Set();
    for (const rawId of sceneRenderer()?.avatars?.keys?.() || []) {
      const id = asId(rawId);
      if (id == null || id === selfId) continue;
      const a = ensureActorFromRenderer(id);
      if (a) taken.add(`${a.toX | 0},${a.toY | 0}`);
    }
    const free = (x, y) => tickWalkable(x, y) && (!taken.has(`${x},${y}`) || (x === goal.x && y === goal.y));
    const sx = Math.sign(goal.x - from.x);
    const sy = Math.sign(goal.y - from.y);
    for (const [dx, dy] of [[sx, sy], [sx, 0], [0, sy]]) {
      if (!dx && !dy) continue;
      const dist0 = Math.max(Math.abs(goal.x - from.x), Math.abs(goal.y - from.y));
      const x = from.x + dx;
      const y = from.y + dy;
      if (Math.max(Math.abs(goal.x - x), Math.abs(goal.y - y)) >= dist0) continue;
      if (free(x, y)) return { x, y };
    }
    // BFS from the goal back to us: the neighbour of `from` closest to it.
    const key = (x, y) => `${x},${y}`;
    const dist = new Map([[key(goal.x, goal.y), 0]]);
    const queue = [goal];
    while (queue.length && dist.size < 2000) {
      const c = queue.shift();
      const d = dist.get(key(c.x, c.y));
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          if (!dx && !dy) continue;
          const x = c.x + dx;
          const y = c.y + dy;
          const k = key(x, y);
          if (dist.has(k)) continue;
          if (!(x === from.x && y === from.y) && !free(x, y)) continue;
          dist.set(k, d + 1);
          queue.push({ x, y });
        }
      }
      if (dist.has(key(from.x, from.y))) break;
    }
    if (!dist.has(key(from.x, from.y))) return null;
    let best = null;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (!dx && !dy) continue;
        const d = dist.get(key(from.x + dx, from.y + dy));
        if (d != null && (!best || d < best.d)) best = { x: from.x + dx, y: from.y + dy, d };
      }
    }
    return best ? { x: best.x, y: best.y } : null;
  }

  function softResetCombat(reason) {
    state.lastAutomaticPunch = null;
    state.stepWalk.goal = null;
    state.burstPlans = [];
    state.gridPlan = null;
    state.lastBurstKey = "";
    state.stateArmKey = "";
    state.contactEdge.wasContact = false;
    state.landingC.wasContact = false;
    state.landingEliminated = false;
    state.idleSoft = true;
    state.sceneCache = null;
    state.sceneCacheAt = 0;
    if (state.nextBurstTimer) {
      clearTimeout(state.nextBurstTimer);
      state.nextBurstTimer = null;
    }
    clearTimingWorker(reason || "soft_reset");
    syncPump();
  }

  function markActivity() {
    state.idleSoft = false;
  }

  function contactGateOk(targetId) {
    const self = ensureActorFromRenderer(inferSelfId());
    const target = ensureActorFromRenderer(targetId);
    if (!self || !target) return false;
    return lateralAdjacent(self.toX, self.toY, target.toX, target.toY);
  }

  function contactEdgeActive() {
    if (!timingModeActive() || timingSourceMode() !== "STEP") return false;
    if (state.timing.landing?.enabled || state.timing.tick?.enabled) return false;
    if (!state.timing.contactGate || state.timing.dualWindow) return false;
    return (state.timing.start | 0) <= 2 && (state.timing.end | 0) <= 2;
  }

  function landingEnabled() {
    return (
      timingModeActive() &&
      timingSourceMode() === "STEP" &&
      Boolean(state.timing.landing?.enabled) &&
      !state.timing.tick?.enabled
    );
  }

  function rttEstimateMs() {
    const ping = Number(state.serverPingMs);
    return Number.isFinite(ping) && ping > 0 && ping < 1000 ? ping : 160;
  }

  // Legacy predictive heuristic: stepStart + stepMs - RTT + offset.
  // Observed client arrival times do not establish a server acceptance window.
  function landingTrySchedule(movedId, actor, contFlag, direction) {
    if (!landingEnabled() || state.landingEliminated) return;
    if (!actor || contFlag !== 0) return;
    const selfId = inferSelfId();
    if (selfId < 0 || movedId === selfId) return;
    const targetId = selectedId();
    if (targetId < 0 || targetId !== movedId) return;
    const self = ensureActorFromRenderer(selfId);
    if (!self) return;
    if (!lateralAdjacent(self.toX, self.toY, actor.toX, actor.toY)) return;

    const L = state.timing.landing;
    const stepMs = Math.max(1, actor.stepMs | 0);
    const rtt = rttEstimateMs();
    const jitter = (L.jitterMs | 0) > 0 ? randomInt(0, L.jitterMs | 0) : 0;
    const base = actor.startAt + stepMs - rtt;
    const fireAt = base + (L.offsetMs | 0) + jitter;
    const key = `LAND:${targetId}:${actor.key}`;
    if (key === state.lastBurstKey) return;
    state.lastBurstKey = key;

    const offsets = L.secondShot ? [0, clamp(L.secondDelayMs | 0, 50, 400)] : [0];
    state.stats.arms++;
    sendTimingMetric(
      "arm",
      "LANDING",
      targetId,
      Math.round(fireAt - actor.startAt),
      -1,
      0,
      stepMs,
      offsets.length,
      true,
      `fire≈${Math.round(fireAt - actor.startAt)}ms rtt=${rtt} off=${L.offsetMs | 0} jit=${jitter} ${direction || ""}`,
      { rttMs: rtt, offsetMs: L.offsetMs | 0, jitterMs: jitter, secondShot: Boolean(L.secondShot) }
    );
    queueBurst(targetId, state.seq, actor.startAt, fireAt, offsets, stepMs, "LAND");
  }

  function landingContactPump() {
    if (!landingEnabled() || state.landingEliminated) {
      state.landingC.wasContact = false;
      return;
    }
    const target = selectedId();
    if (target < 0 || target === inferSelfId()) {
      state.landingC.wasContact = false;
      return;
    }
    if (!contactGateOk(target)) {
      state.landingC.wasContact = false;
      return;
    }
    const t = Math.round(now());
    const fresh = !state.landingC.wasContact || target !== state.landingC.lastTarget;
    if (fresh && t - state.lastPunch.at >= 120) {
      const ok = firePunch(target, "LANDING_CONTACT");
      state.landingC.lastFireAt = t;
      sendTimingMetric("fire", "LANDING", target, 0, 0, 0, 0, 1, ok, "contact", {});
    }
    state.landingC.wasContact = true;
    state.landingC.lastTarget = target;
  }

  // 144 = "arrived too early" per Dual Lab. Nudge the next shots later.
  function landingAdaptOnReject() {
    const L = state.timing.landing;
    if (!landingEnabled() || !L.adaptive) return;
    const t = Math.round(now());
    if (t - state.lastPunch.at > 500) return;
    if (state.lastPunch.reason !== "LAND" && state.lastPunch.reason !== "LANDING_CONTACT") return;
    const before = L.offsetMs | 0;
    L.offsetMs = clamp(before + Math.max(1, L.adaptiveStepMs | 0), 0, 250);
    if (L.offsetMs !== before) {
      sendTimingMetric(
        "adapt",
        "LANDING",
        state.lastPunch.targetId,
        before,
        -1,
        0,
        0,
        0,
        true,
        `144 -> offset ${before}+${L.adaptiveStepMs | 0}=${L.offsetMs}`,
        { reason144: true }
      );
    }
  }

  function landingAdaptOnResolve(attackerId) {
    const L = state.timing.landing;
    if (!landingEnabled() || !L.adaptive) return;
    if (asId(attackerId) !== inferSelfId()) return;
    const before = L.offsetMs | 0;
    L.offsetMs = clamp(before - 5, 0, 250);
    if (L.offsetMs !== before) {
      sendTimingMetric(
        "adapt",
        "LANDING",
        state.lastPunch.targetId,
        before,
        -1,
        0,
        0,
        0,
        true,
        `resolve -> offset ${before}-5=${L.offsetMs}`,
        { resolved: true }
      );
    }
  }

  function ensureTimingWorker() {
    if (state.timingWorker) return state.timingWorker;
    const source = `
      const timers = new Map();
      function clearPlan(planId) {
        const list = timers.get(planId);
        if (!list) return;
        for (let i = 0; i < list.length; i++) clearTimeout(list[i]);
        timers.delete(planId);
      }
      function clearAll() {
        for (const id of Array.from(timers.keys())) clearPlan(id);
      }
      self.onmessage = function (ev) {
        const msg = ev.data || {};
        if (msg.type === "clear_all") {
          clearAll();
          return;
        }
        if (msg.type === "clear") {
          clearPlan(String(msg.planId || ""));
          return;
        }
        if (msg.type !== "arm") return;
        const planId = String(msg.planId || "");
        clearPlan(planId);
        const fires = Array.isArray(msg.fires) ? msg.fires : [];
        const ids = [];
        for (let i = 0; i < fires.length; i++) {
          const fire = fires[i] || {};
          const delayMs = Math.max(0, Number(fire.delayMs) || 0);
          const index = fire.index | 0;
          const tid = setTimeout(function () {
            self.postMessage({
              type: "fire",
              planId: planId,
              index: index,
              dueAt: fire.dueAt,
              leadMs: msg.leadMs,
              targetId: msg.targetId,
              stepAt: msg.stepAt,
              stepMs: msg.stepMs,
              seq: msg.seq,
              window: msg.window || "A"
            });
          }, delayMs);
          ids.push(tid);
        }
        timers.set(planId, ids);
      };
    `;
    const blob = new Blob([source], { type: "application/javascript" });
    const url = URL.createObjectURL(blob);
    const worker = new Worker(url);
    worker.onmessage = onTimingWorkerMessage;
    worker.onerror = () => {};
    state.timingWorker = worker;
    state.timingWorkerUrl = url;
    return worker;
  }

  function clearTimingWorker(reason) {
    for (const planId of Array.from(state.workerPlans.keys())) {
      state.workerPlans.delete(planId);
    }
    // clear_all also drops TICK timers: re-arm from the next pump.
    state.tickEngine.plans.clear();
    state.tickEngine.armedTick = null;
    if (state.timingWorker) {
      try {
        state.timingWorker.postMessage({ type: "clear_all", reason: reason || "" });
      } catch {}
    }
    // The coco exit does not depend on the timing config: re-arm it.
    const exitPlan = state.exitMode.plan;
    if (exitPlan && !exitPlan.done && state.exitMode.self) {
      exitPlan.armed = false;
      exitArm();
    }
    // 28/09: neither do our unlock, the rivals' unlocks and the coco guard. A
    // timing_config (an aim change) during our lock dropped them for good (9 aim
    // changes with a lock pending, 0 unlock clicks).
    const E = state.tickEngine;
    const t = now();
    if (E.unlock.end && E.unlock.end === E.selfLockEnd && E.selfLockEnd > t) {
      E.unlock.end = 0;
      unlockArm();
    }
    for (const [id, r] of Array.from(E.runlock)) {
      E.runlock.delete(id);
      if (r.end > t) runlockArm(id, r.end);
    }
    if (state.cocoGuard.upperEnd > t) cocoGuardArm(state.cocoGuard.upperEnd, "UPPER");
  }

  function onTimingWorkerMessage(event) {
    const msg = event && event.data;
    if (!msg || msg.type !== "fire") return;
    if (msg.window === "TICK") {
      tickOnWorkerFire(msg);
      return;
    }
    if (msg.window === "EXIT") {
      exitOnWorkerFire(msg);
      return;
    }
    if (msg.window === "UNLOCK") {
      unlockOnWorkerFire(msg);
      return;
    }
    if (msg.window === "CGUARD") {
      cocoGuardOnWorkerFire(msg);
      return;
    }
    if (msg.window === "RUNLOCK") {
      runlockOnWorkerFire(msg);
      return;
    }
    if (msg.window === "GUARD") {
      guardOnWorkerFire(msg);
      return;
    }
    const planId = String(msg.planId || "");
    const plan = state.workerPlans.get(planId);
    if (!plan) return;
    if (plan.seq !== state.seq) {
      state.workerPlans.delete(planId);
      return;
    }
    if (!timingModeActive() || timingSourceMode() !== "STEP") {
      state.workerPlans.delete(planId);
      return;
    }

    const t = now();
    const due = Number(msg.dueAt);
    const leadMs = leadClamp(msg.leadMs | 0);
    const targetId = asId(msg.targetId);
    const index = msg.index | 0;
    const isLand = String(msg.window || "") === "LAND";

    if (isLand) {
      // Native server throttle: 211s <100 ms apart are wasted (RING_LAB_211).
      if (t - state.lastPunch.at < 100) {
        plan.fired += 1;
        if (plan.fired >= plan.total) state.workerPlans.delete(planId);
        return;
      }
    }

    if (state.timing.contactGate && !contactGateOk(targetId)) {
      if (state.timing.fireMetrics && !plan.leadSampled) {
        sendTimingMetric(
          "fire",
          "STEP",
          targetId,
          Math.round(due - plan.stepAt),
          Math.round(t - plan.stepAt),
          Math.round(t - due),
          plan.stepMs,
          0,
          false,
          `contact gate skip lead=${leadMs} worker`,
          { leadMs, fireDelayMs: Math.round(t - (due - leadMs)), scheduler: "worker" }
        );
      }
      plan.fired += 1;
      if (plan.fired >= plan.total) state.workerPlans.delete(planId);
      return;
    }

    const sampleLead = !plan.leadSampled;
    const ok = firePunch(targetId, isLand ? "LAND" : "STEP");
    if (sampleLead) {
      leadNote(due, t, leadMs);
      plan.leadSampled = true;
    }
    sendTimingMetric(
      "fire",
      "STEP",
      targetId,
      Math.round(due - plan.stepAt),
      Math.round(t - plan.stepAt),
      Math.round(t - due),
      plan.stepMs,
      1,
      ok,
      `idx=${index} lead=${leadMs}>${leadCurrent()} worker`,
      {
        leadMs,
        effectiveLeadMs: leadCurrent(),
        fireDelayMs: Math.round(t - (due - leadMs)),
        window: msg.window || "A",
        scheduler: "worker"
      }
    );
    plan.fired += 1;
    if (plan.fired >= plan.total) state.workerPlans.delete(planId);
  }

  function syncPump() {
    const src = timingSourceMode();
    // STEP bursts are scheduled on the Worker — main pump only for grid/pulse/edge.
    const need =
      state.pulse.enabled ||
      (timingModeActive() && src === "GRID" && state.gridPlan) ||
      (timingModeActive() && src === "STEP" && Boolean(state.timing.landing?.enabled)) ||
      tickEnabled() ||
      (contactEdgeActive() && !state.idleSoft);
    if (need) {
      if (!state.pumpTimer) {
        state.pumpTimer = setInterval(enginePump, 8);
        state.pumpMode = "interval";
      }
    } else if (state.pumpTimer) {
      clearInterval(state.pumpTimer);
      state.pumpTimer = null;
      state.pumpMode = null;
    }
    if (state.nextBurstTimer) {
      clearTimeout(state.nextBurstTimer);
      state.nextBurstTimer = null;
    }
  }

  function queueBurst(targetId, seq, stepAt, baseAt, offsets, stepMs, windowName) {
    if (!offsets?.length) return;
    const t = now();
    const leadMs = leadCurrent();
    const worker = ensureTimingWorker();
    state.workerPlanSeq = (state.workerPlanSeq + 1) | 0;
    const planId = `${seq}:${state.workerPlanSeq}:${targetId}:${Math.round(baseAt)}`;

    // Drop stale bookkeeping if we piled up too many arms.
    while (state.workerPlans.size >= 8) {
      const oldest = state.workerPlans.keys().next().value;
      state.workerPlans.delete(oldest);
      try {
        worker.postMessage({ type: "clear", planId: oldest });
      } catch {}
    }

    const fires = [];
    for (let i = 0; i < offsets.length; i++) {
      const due = baseAt + (offsets[i] | 0);
      const fireAt = due - leadMs;
      fires.push({
        index: i,
        dueAt: due,
        delayMs: Math.max(0, fireAt - t)
      });
    }

    state.workerPlans.set(planId, {
      seq,
      targetId,
      stepAt,
      stepMs,
      leadMs,
      leadSampled: false,
      total: fires.length,
      fired: 0,
      window: windowName || "A"
    });

    try {
      worker.postMessage({
        type: "arm",
        planId,
        targetId,
        stepAt,
        stepMs,
        seq,
        leadMs,
        window: windowName || "A",
        fires
      });
    } catch {
      // Fallback: immediate main-thread timeouts if Worker fails.
      for (const fire of fires) {
        setTimeout(() => {
          onTimingWorkerMessage({
            data: {
              type: "fire",
              planId,
              index: fire.index,
              dueAt: fire.dueAt,
              leadMs,
              targetId,
              stepAt,
              stepMs,
              seq,
              window: windowName || "A"
            }
          });
        }, fire.delayMs);
      }
    }
  }

  function scheduleStepWindow(targetId, stepMs, moveKey, reason) {
    if (!timingModeActive() || timingSourceMode() !== "STEP") return;
    if (targetId < 0 || targetId === inferSelfId()) return;
    if (contactEdgeActive()) {
      syncPump();
      return;
    }

    let dur = stepMs | 0;
    if (dur <= 0 || dur > 2000) dur = HTML5_STEP_MS;
    state.lastStepDur = dur;

    let start = scaleWindowMs(state.timing.start, dur);
    let end = scaleWindowMs(state.timing.end, dur);
    if (end > dur) end = dur;
    if (start > end) start = end;

    const stepAt = now();
    const winStart = stepAt + start;
    const winEnd = stepAt + end;
    const t = now();
    const dual = Boolean(state.timing.dualWindow);

    let start2 = 0;
    let end2 = 0;
    let winStart2 = 0;
    let winEnd2 = 0;
    if (dual) {
      start2 = scaleWindowMs(state.timing.start2, dur);
      end2 = scaleWindowMs(state.timing.end2, dur);
      if (end2 > dur) end2 = dur;
      if (start2 > end2) start2 = end2;
      winStart2 = stepAt + start2;
      winEnd2 = stepAt + end2;
    }

    if (t > winEnd + 60 && (!dual || t > winEnd2 + 60)) return;

    const key = `${targetId}:${moveKey}:${start}:${end}:${dual ? `d:${start2}:${end2}` : "s"}`;
    if (key === state.lastBurstKey) return;
    state.lastBurstKey = key;

    const seq = state.seq;
    if (t <= winEnd + 60) {
      const offsets = buildOffsets(end - start);
      state.stats.arms++;
      sendTimingMetric(
        "arm",
        "STEP",
        targetId,
        start,
        -1,
        0,
        dur,
        offsets.length,
        true,
        `win=A start=${start} end=${end} lead=${leadCurrent()}ms step=${dur} worker ${reason || ""}`,
        {
          window: "A",
          windowStartAbs: Math.round(winStart),
          windowEndAbs: Math.round(winEnd),
          leadMs: leadCurrent(),
          scheduler: "worker",
          hubRefMs: STEP_HUB_REF_MS,
          html5StepMs: HTML5_STEP_MS
        }
      );
      queueBurst(targetId, seq, stepAt, winStart, offsets, dur, "A");
    }
    if (dual && t <= winEnd2 + 60) {
      const offsets = buildOffsets(end2 - start2);
      sendTimingMetric(
        "arm",
        "STEP",
        targetId,
        start2,
        -1,
        0,
        dur,
        offsets.length,
        true,
        `win=B start=${start2} end=${end2} lead=${leadCurrent()}ms step=${dur} worker ${reason || ""}`,
        {
          window: "B",
          windowStartAbs: Math.round(winStart2),
          windowEndAbs: Math.round(winEnd2),
          leadMs: leadCurrent(),
          scheduler: "worker"
        }
      );
      queueBurst(targetId, seq, stepAt, winStart2, offsets, dur, "B");
    }
  }

  function contactEdgePump() {
    if (!contactEdgeActive()) {
      state.contactEdge.wasContact = false;
      return;
    }
    const target = selectedId();
    if (target < 0 || target === inferSelfId()) {
      state.contactEdge.wasContact = false;
      return;
    }
    if (!contactGateOk(target)) {
      state.contactEdge.wasContact = false;
      return;
    }
    const t = Math.round(now());
    const becoming = !state.contactEdge.wasContact || target !== state.contactEdge.lastTarget;
    if (becoming && (target !== state.contactEdge.lastTarget || t - state.contactEdge.lastFireAt >= 12)) {
      firePunch(target, "CONTACT_EDGE");
      state.contactEdge.lastFireAt = t;
      sendTimingMetric("fire", "STEP", target, 0, 0, 0, 0, 1, true, "contact-edge", {});
    }
    state.contactEdge.wasContact = true;
    state.contactEdge.lastTarget = target;
    state.contactEdge.lastAxis = "PUNCH_SIDE";
  }

  function moveDelaySchedule(moveStartAt, moveDur) {
    const pulseMove = state.pulse.enabled && state.moveDelay.enabled;
    const timingMove = timingModeActive() && timingSourceMode() === "MOVE_DELAY";
    if (!pulseMove && !timingMove && !state.moveDelay.enabled) return;
    if ((moveDur | 0) < (state.moveDelay.minMoveMs | 0)) return;
    const target = selectedId();
    if (target < 0) return;
    const key = `MD:${Math.round(moveStartAt)}:${target}`;
    if (key === state.moveDelay.lastFireKey) return;
    state.moveDelay.lastFireKey = key;

    const fireAt = moveStartAt + (moveDur | 0) + (state.moveDelay.delayMs | 0);
    let wait = fireAt - now();
    if (wait < 0) wait = 0;
    if (wait > 5000) return;
    state.moveDelay.seq++;
    const seq = state.moveDelay.seq;
    sendTimingMetric(
      "arm",
      "MOVE_DELAY",
      target,
      state.moveDelay.delayMs,
      Math.round(fireAt),
      0,
      moveDur,
      1,
      true,
      `delay=${state.moveDelay.delayMs} moveDur=${moveDur} plannedIn=${Math.round(wait)}`,
      { moveStartAt: Math.round(moveStartAt), moveDur: moveDur | 0, delayMs: state.moveDelay.delayMs }
    );
    setTimeout(() => {
      if (seq !== state.moveDelay.seq) return;
      const still =
        (state.pulse.enabled && state.moveDelay.enabled) ||
        (timingModeActive() && timingSourceMode() === "MOVE_DELAY") ||
        state.moveDelay.enabled;
      if (!still) return;
      const firedAt = now();
      const ok = firePunch(target, "MOVE_DELAY");
      sendTimingMetric(
        "fire",
        "MOVE_DELAY",
        target,
        state.moveDelay.delayMs,
        Math.round(firedAt),
        Math.round(firedAt - fireAt),
        state.moveDelay.delayMs,
        1,
        ok,
        `delay=${state.moveDelay.delayMs}`,
        { fireDelayMs: Math.round(firedAt - fireAt), delayMs: state.moveDelay.delayMs }
      );
    }, wait);
  }

  function gridTrySchedule(targetId, reason) {
    if (!timingModeActive() || timingSourceMode() !== "GRID") return;
    if (targetId < 0 || targetId === inferSelfId()) return;
    const self = ensureActorFromRenderer(inferSelfId());
    const target = ensureActorFromRenderer(targetId);
    if (!self || !target) return;

    const fromAdj = lateralAdjacent(self.fromX, self.fromY, target.fromX, target.fromY);
    const toAdj = lateralAdjacent(self.toX, self.toY, target.toX, target.toY);
    if (!toAdj || fromAdj || (!self.moving && !target.moving)) return;

    const selfEnd = self.moving ? self.endAt : now();
    const targetEnd = target.moving ? target.endAt : now();
    const plannedAt = Math.max(selfEnd, targetEnd);
    const stepAt = Math.min(self.moving ? self.startAt : now(), target.moving ? target.startAt : now());
    const stepMs = Math.max(self.stepMs | 0, target.stepMs | 0);
    const t = now();
    if (t > plannedAt + 120) return;

    const manualLead = state.grid.lead | 0;
    const autoLead = leadCurrent();
    const pingComp = state.grid.pingComp ? state.grid.pingCompMs | 0 : 0;
    const leadMs = manualLead + autoLead + pingComp;
    const desiredAt = plannedAt - leadMs;
    const key = `${targetId}:${self.key}:${target.key}:${self.toX},${self.toY}:${target.toX},${target.toY}`;
    if (state.gridPlan && state.gridPlan.key === key) return;
    if (key === state.gridLastFireKey && t - state.gridLastFireAt < 500) return;

    const burst = clamp(state.grid.burst, 1, 4);
    const spacing = clamp(state.grid.spacing, 1, 60);
    state.gridPlan = {
      target: targetId,
      seq: state.seq,
      key,
      plannedAt,
      desiredAt,
      armedAt: t,
      stepAt,
      stepMs,
      leadMs,
      burstIndex: 0,
      burstCount: burst,
      burstSpacingMs: spacing,
      selfToX: self.toX,
      selfToY: self.toY,
      targetToX: target.toX,
      targetToY: target.toY
    };
    state.stats.arms++;
    sendTimingMetric(
      "arm",
      "GRID",
      targetId,
      Math.round(plannedAt - stepAt),
      Math.round(t - stepAt),
      Math.max(0, Math.round(t - desiredAt)),
      stepMs,
      burst,
      true,
      `lead=${leadMs} ${reason || ""}`,
      { leadMs, desiredMs: Math.round(desiredAt - stepAt), burstCount: burst, spacingMs: spacing }
    );
    syncPump();
    gridPump();
  }

  function gridPlanStillValid(plan) {
    if (!plan) return false;
    const self = ensureActorFromRenderer(inferSelfId());
    const target = ensureActorFromRenderer(plan.target);
    if (!self || !target) return false;
    if (
      self.toX !== plan.selfToX ||
      self.toY !== plan.selfToY ||
      target.toX !== plan.targetToX ||
      target.toY !== plan.targetToY
    ) {
      return false;
    }
    return lateralAdjacent(self.toX, self.toY, target.toX, target.toY);
  }

  function gridPump() {
    if (!timingModeActive() || timingSourceMode() !== "GRID") {
      state.gridPlan = null;
      return;
    }
    const plan = state.gridPlan;
    if (!plan) return;
    const burstCount = clamp(plan.burstCount, 1, 4);
    const spacing = clamp(plan.burstSpacingMs, 1, 60);
    let guard = 0;
    while (state.gridPlan && state.gridPlan.burstIndex < burstCount && guard < 8) {
      const t = now();
      const idx = state.gridPlan.burstIndex;
      const due = state.gridPlan.desiredAt + idx * spacing;
      if (t < due) return;
      if (idx > 0 && t - state.gridLastFireAt < spacing) return;
      if (t - state.gridLastFireAt < (state.timing.gap | 0)) return;
      const valid = gridPlanStillValid(state.gridPlan);
      const ok = valid ? firePunch(state.gridPlan.target, "GRID") : false;
      if (idx === 0) leadNote(state.gridPlan.plannedAt, t, state.gridPlan.leadMs);
      sendTimingMetric(
        "fire",
        "GRID",
        state.gridPlan.target,
        Math.round(state.gridPlan.plannedAt - state.gridPlan.stepAt),
        Math.round(t - state.gridPlan.stepAt),
        Math.round(t - due),
        state.gridPlan.stepMs,
        1,
        ok,
        `burst=${idx + 1}/${burstCount}`,
        { leadMs: state.gridPlan.leadMs, burstIndex: idx, burstCount }
      );
      state.gridLastFireAt = t;
      state.gridLastFireKey = state.gridPlan.key;
      state.gridPlan.burstIndex++;
      guard++;
    }
    if (state.gridPlan && state.gridPlan.burstIndex >= burstCount) {
      state.gridPlan = null;
    }
    syncPump();
  }

  function scheduleStatePunch(movedId, reason) {
    if (!timingModeActive() || timingSourceMode() !== "STATE") return;
    if (!state.stateCfg.enabled && timingSourceMode() !== "STATE") return;
    const sel = selectedId();
    if (sel < 0) return;
    const selfId = inferSelfId();
    if (movedId !== sel && movedId !== selfId) {
      // enemy move: also arm when any non-self moves toward selected combat
      if (movedId === selfId) return;
    }
    const key = `${sel}:${movedId}:${reason}`;
    const t = Math.round(now());
    if (key === state.stateArmKey && t - state.stateArmAt < 80) return;
    state.stateArmKey = key;
    state.stateArmAt = t;
    const delay = Math.max(0, state.stateCfg.delay | 0);
    sendTimingMetric("arm", "STATE", sel, delay, -1, 0, 0, 1, true, reason || "move", {
      actorId: movedId,
      delay
    });
    setTimeout(() => {
      if (!timingModeActive() || timingSourceMode() !== "STATE") return;
      const firedAt = now();
      const ok = firePunch(sel, "STATE");
      sendTimingMetric(
        "fire",
        "STATE",
        sel,
        delay,
        Math.round(firedAt - t),
        Math.round(firedAt - t - delay),
        0,
        1,
        ok,
        reason || "move",
        { actorId: movedId }
      );
    }, delay);
  }

  function pulseNearestLateral() {
    const self = ensureActorFromRenderer(inferSelfId());
    if (!self) return -1;
    const renderer = providerInstance(state.providers.renderer);
    if (!(renderer?.avatars instanceof Map)) return -1;
    let best = -1;
    let bestDist = 999;
    for (const [rawId] of renderer.avatars) {
      const id = asId(rawId);
      if (id == null || id === inferSelfId()) continue;
      const actor = ensureActorFromRenderer(id);
      if (!actor) continue;
      if (state.pulse.contactOnly && !lateralAdjacent(self.toX, self.toY, actor.toX, actor.toY)) {
        continue;
      }
      const dist = Math.abs(actor.toX - self.toX) + Math.abs(actor.toY - self.toY);
      if (dist < bestDist && dist <= Math.max(1, state.pulse.autoRange | 0) * 2) {
        bestDist = dist;
        best = id;
      }
    }
    return best;
  }

  function pulseTargetId() {
    if (state.pulse.requireSelected || !state.pulse.autoTarget) {
      const sel = selectedId();
      if (sel >= 0) {
        state.pulse.autoTargetId = sel;
        return sel;
      }
      if (!state.pulse.autoTarget) return -1;
    }
    const auto = pulseNearestLateral();
    state.pulse.autoTargetId = auto;
    return auto;
  }

  function pulsePump() {
    if (!state.pulse.enabled) return;
    const t = now();
    if (state.pulse.nextAt <= 0) state.pulse.nextAt = t;
    if (t < state.pulse.nextAt) return;
    if (state.pulse.lastFireAt > 0 && t - state.pulse.lastFireAt < (state.pulse.gap | 0)) {
      state.pulse.nextAt = state.pulse.lastFireAt + (state.pulse.gap | 0);
      return;
    }
    const target = pulseTargetId();
    if (target < 0 || target === inferSelfId()) {
      state.pulse.nextAt = t + (state.pulse.interval | 0);
      return;
    }
    if (state.pulse.contactOnly && !contactGateOk(target)) {
      state.pulse.nextAt = t + (state.pulse.interval | 0);
      return;
    }
    state.pulse.seq++;
    const burst = clamp(state.pulse.burst, 1, 8);
    const spacing = clamp(state.pulse.spacing, 0, 200);
    let maxOff = 0;
    state.pulse.lastFireCount = 0;
    const attempt = () => {
      const ok = firePunch(target, "PULSE");
      const sentCount = ok ? state.lastFireResult.sentCount : 0;
      state.pulse.lastFireCount += sentCount;
      sendTimingMetric("fire", "PULSE", target, state.pulse.interval, Math.round(now()), 0, state.pulse.interval, sentCount, ok, "pulse attempt", {
        burstCount: burst, spacingMs: spacing, sentCount
      });
    };
    for (let i = 0; i < burst; i++) {
      const off = i * spacing;
      if (off > maxOff) maxOff = off;
      if (off <= 0) {
        attempt();
      } else {
        setTimeout(() => {
          if (!state.pulse.enabled) return;
          attempt();
        }, off);
      }
    }
    state.pulse.lastFireAt = t;
    state.pulse.nextAt = t + Math.max(state.pulse.interval | 0, maxOff + (state.pulse.gap | 0));
  }

  function enginePump() {
    tickPump();
    tickAutoPump();
    contactEdgePump();
    landingContactPump();
    gridPump();
    pulsePump();
  }

  // 182 orient -> step direction; exact in 78k July steps, so the direction
  // is known from a rival's first visible step.
  const ORIENT_DIR = { 1: [1, 1], 2: [-1, -1], 3: [1, -1], 4: [-1, 1], 5: [1, 0], 6: [0, -1], 7: [0, 1], 8: [-1, 0] };

  function noteActorStep(movedId, x, y, stepMs, orient) {
    const id = asId(movedId);
    if (id == null) return null;
    const prev = state.actors.get(id);
    const known = prev && Math.abs(prev.toX - x) <= 1 && Math.abs(prev.toY - y) <= 1;
    const od = ORIENT_DIR[Number(orient) | 0];
    const fromX = known ? prev.toX : od ? x - od[0] : x;
    const fromY = known ? prev.toY : od ? y - od[1] : y;
    const startAt = Math.round(now());
    const dur = stepMs | 0;
    const actor = {
      fromX,
      fromY,
      toX: x | 0,
      toY: y | 0,
      dirX: x > fromX ? 1 : x < fromX ? -1 : 0,
      dirY: y > fromY ? 1 : y < fromY ? -1 : 0,
      startAt,
      endAt: startAt + Math.max(0, dur),
      stepMs: dur,
      moving: dur > 0,
      orient: Number(orient) || (prev ? prev.orient : 0),
      key: `${id}:${startAt}:${x},${y}`
    };
    state.actors.set(id, actor);
    return actor;
  }

  function dropHunterSetState(next, eventName, detail) {
    state.dropHunter.state = next;
    if (detail) state.dropHunter.lastEvent = detail;
    if (eventName) sendDropHunterEvent(eventName);
  }

  function dropHunterEnsureTimer() {
    if (state.dropHunter.timer) return;
    const period = 25 + ((Math.random() * 26) | 0);
    state.dropHunter.timer = setInterval(dropHunterTick, period);
  }

  function dropHunterStopTimer() {
    if (state.dropHunter.timer) {
      clearInterval(state.dropHunter.timer);
      state.dropHunter.timer = null;
    }
  }

  function dropHunterAtTile(x, y) {
    const tile = selfTile();
    return tile && tile.x === (x | 0) && tile.y === (y | 0);
  }

  function dropHunterOnDrop(x, y, dropId) {
    if (!state.dropHunter.enabled) return;
    const origin = selfTile();
    state.dropHunter.origin = origin;
    state.dropHunter.drop = {
      id: dropId | 0,
      x: x | 0,
      y: y | 0,
      spawnAt: Math.round(now()),
      keywordSent: false,
      claimed: false
    };
    state.dropHunter.dropId = dropId | 0;
    state.dropHunter.x = x | 0;
    state.dropHunter.y = y | 0;
    state.dropHunter.keyword = "";
    const moved = moveTo(x, y);
    dropHunterSetState(
      "MOVING",
      "drop",
      `drop id=${dropId} tile=${x},${y} move=${moved ? "OK" : "WAIT"}`
    );
    dropHunterEnsureTimer();
  }

  function dropHunterClaim() {
    const drop = state.dropHunter.drop;
    if (!drop || drop.keywordSent) return;
    drop.keywordSent = true;
    drop.claimed = true;
    dropHunterSetState("WAIT_SEND", "claimed", `claim id=${drop.id}`);
    if (state.dropHunter.autoReturn) {
      setTimeout(dropHunterReturnHome, 160);
    } else {
      dropHunterSetState("READY", "ready", "claim done");
    }
  }

  function dropHunterReturnHome() {
    const origin = state.dropHunter.origin;
    if (!origin) {
      dropHunterStopTimer();
      return;
    }
    if (dropHunterAtTile(origin.x, origin.y)) {
      dropHunterSetState("RETURNED", "returned", "return done");
      dropHunterStopTimer();
      return;
    }
    moveTo(origin.x, origin.y);
    dropHunterSetState("RETURN", "return", `return ${origin.x},${origin.y}`);
  }

  function dropHunterTick() {
    if (!state.dropHunter.enabled || !state.dropHunter.drop) {
      dropHunterStopTimer();
      return;
    }
    const drop = state.dropHunter.drop;
    const age = Math.round(now()) - (drop.spawnAt || 0);
    if (age > 20000) {
      dropHunterSetState("TIMEOUT", "timeout", "drop timeout");
      dropHunterStopTimer();
      return;
    }
    if (!dropHunterAtTile(drop.x, drop.y)) {
      if (state.dropHunter.state === "RETURN" || state.dropHunter.state === "RETURNED") {
        dropHunterReturnHome();
        return;
      }
      if (age > 600) {
        moveTo(drop.x, drop.y);
        drop.spawnAt = Math.round(now());
        dropHunterSetState("MOVING", "moving", `retry move ${drop.x},${drop.y}`);
      }
      return;
    }
    if (state.dropHunter.state === "MOVING" || state.dropHunter.state === "WAIT_KEYWORD") {
      if (state.dropHunter.autoClaim) {
        dropHunterSetState("READY", "ready", "at drop tile");
        dropHunterClaim();
      } else {
        dropHunterSetState("WAIT_KEYWORD", "wait_keyword", "await keyword");
      }
      return;
    }
    if (state.dropHunter.state === "RETURN") {
      dropHunterReturnHome();
    }
  }

  function maybeDropFromPacket(packet) {
    if (!state.dropHunter.enabled || !packet) return;
    const id = packet.id | 0;
    // Best-effort: contest/drop-ish opcodes seen in BB family (160 subtypes / room props).
    if (id === 160 || id === 150 || id === 151 || id === 152) {
      const fields = packet.fields || [];
      const nums = fields.map((f) => Number(f)).filter((n) => Number.isFinite(n));
      if (nums.length >= 2) {
        const x = nums[nums.length - 2] | 0;
        const y = nums[nums.length - 1] | 0;
        if (x >= 0 && y >= 0 && x < 40 && y < 40) {
          dropHunterOnDrop(x, y, nums[0] | 0);
        }
      }
    }
    for (const field of packet.fields || []) {
      const token = String(field || "").trim().toUpperCase();
      if (token.length === 4 && /^[A-Z0-9]+$/.test(token)) {
        state.dropHunter.keyword = token;
        dropHunterSetState("READY", "keyword", `keyword=${token}`);
        if (state.dropHunter.autoClaim) dropHunterClaim();
      }
    }
  }

  // ---- TICK engine ---------------------------------------------------------
  // The server moves everyone on a 600 ms tick T and a new contact only exists
  // from T on. Upper requests are resolved on arrival, with a 100 ms cooldown
  // per player. The grid comes from 182 batch arrivals (T + downlink); phases
  // measured against it cancel the downlink, so a shot sent at
  //   arrival(T) + phase - RTT - corr
  // reaches the server at T + phase. No fichado needed: every shot goes to
  // the best threat (threatPick), so 2-vs-1 and 3-vs-1 are covered. The first
  // shot is a dense burst. Before batch T is known they fire at whoever can be
  // in lateral contact at T (projected); after it, only at real contact.
  // 144/211 replies calibrate corr.
  const TICK_MS = 600;
  // The worker wakes the main thread this early and the click waits for its
  // exact moment in a short spin: main-thread lateness (p90 9 ms, max 11 in
  // the 25/09 session) no longer moves the landing.
  const SPIN_EARLY_MS = 12;
  // Punch animation after a landed hit: the attacker stands still, its punches
  // are ignored without a reply and nobody can hit it (July: nobody was hit
  // within 14 s of its own hit). It starts when the hit resolves (the 211), not
  // when the request landed: in the arrival frame of that 211, July rotations
  // are accepted again from 14.00 s (sharp, 17 at the edge). 25/09 live,
  // punches landing at 211 + 13.74, 13.84 and 13.86 s were all ignored, and
  // the ambushers' hits came at 211 + 14.14-14.18 s (their landing + hold).
  const DUAL_TIE = false;
  // Sweep: in single mode a second blind click lands right after the server's
  // 100 ms gap of a rejected first one, at the runner-up. With ping ~173 a
  // reaction lands at T+178; the sweep reaches the runner-up at ~T+110 and,
  // if the first click was valid, the server simply ignores it.
  const SWEEP_MIN_SCORE = 0.05;
  const TICK_BLIND_MIN_P = 0.0005;
  // 01/10: the July model gives a STANDING rival one diagonal step from contact
  // (|dx|,|dy| = 1 and 2) P = 0 - measured on a crowd that rarely stepped in.
  // The smart ones exploit it: they stand one step out and step+click on the
  // tick they choose (7 deaths today: the killer was the best candidate at P=0).
  // Their punch processes at T+60-90 (held train), our tick click at T+10 beats
  // it - but only if we actually fire. The floor makes them a real candidate.
  const THREAT_STEP_FLOOR = 0.03;
  const LOW_PING_MS = 60;
  const LOW_PING_BLIND_MIN = 0.9; // a standing rival already beside us: 0.975
  function lowPingActive() {
    const m = state.lowPing.mode;
    if (m === "on") return true;
    if (m === "off") return false;
    const r = rttEstimateMs();
    return r > 0 && r < LOW_PING_MS;
  }
  const WALKER_BONUS = 1.3; // threatPick: a walking rival is hit ~40 ms faster
  const SWEEP_EXTRA_MS = 4;
  const TICK_BURST_GAP_MS = 1;
  const TICK_BURST_MAX = 20;
  // The server gap starts at the burst's last request.
  const burstSpanMs = () => (clamp(state.tickBurst, 1, TICK_BURST_MAX) - 1) * TICK_BURST_GAP_MS;
  let HIT_LOCK_MS = 14000; // hit_lock_config (tests) can change it

  function spinUntil(due) {
    let guard = 0;
    while (now() < due && ++guard < 5e6) {
      // busy wait: at most SPIN_EARLY_MS, only right before a click
    }
  }

  function tickEnabled() {
    return timingModeActive() && timingSourceMode() === "STEP" && Boolean(state.timing.tick?.enabled);
  }

  function tickWrap(value) {
    const p = ((value % TICK_MS) + TICK_MS) % TICK_MS;
    return p >= TICK_MS / 2 ? p - TICK_MS : p;
  }

  function tickResetGrid(reason) {
    const E = state.tickEngine;
    tickAutoFlush();
    E.batches = [];
    E.origin = null;
    E.coherence = 0;
    E.lastBatchAt = -1e9;
    E.lastBatchTick = null;
    E.armedTick = null;
    E.plans.clear();
    E.shots = [];
    E.allShots = [];
    E.cont.clear();
    E.down.clear();
    E.selfDest = null;
    E.walkReqs = [];
    E.gridResets++;
    E.lastReset = reason || "";
    // Contact history and pending replies are per grid; learned values stay.
    E.auto.contact.clear();
    E.auto.replies = [];
    E.auto.rivalHits = [];
    E.auto.thirdParty = [];
    E.auto.lastContactN = null;
    E.auto.lastRaceN = null;
    E.tickTargets.clear();
    E.tickTargets2.clear();
    E.out.clear();
    E.outGone.clear();
    E.selfOut = false;
    E.silentPending = [];
    E.silentCount.clear();
    E.mutedUntil.clear();
    // corr is kept: it describes our path to the server, not the room.
  }

  // Tick phase differs per room and per Ring round, and drifts slowly against
  // the local clock: estimate it from the last batches only.
  function tickNoteBatch(t) {
    const E = state.tickEngine;
    if (t - E.lastBatchAt < 120) return;
    E.lastBatchAt = t;
    E.batches.push(t);
    while (E.batches.length > 16 || (E.batches.length && t - E.batches[0] > 12000)) E.batches.shift();
    let s = 0;
    let c = 0;
    for (const b of E.batches) {
      const a = (2 * Math.PI * (((b % TICK_MS) + TICK_MS) % TICK_MS)) / TICK_MS;
      s += Math.sin(a);
      c += Math.cos(a);
    }
    E.origin = ((((Math.atan2(s, c) * TICK_MS) / (2 * Math.PI)) % TICK_MS) + TICK_MS) % TICK_MS;
    E.coherence = Math.hypot(s, c) / E.batches.length;
    E.lastBatchTick = Math.round((t - E.origin) / TICK_MS);
  }

  function tickWalkable(x, y) {
    const scene = state.sceneCache;
    const m = scene?.walkableMatrix;
    if (!m) return true;
    const row = m[(y | 0) - (scene.originY || 0)];
    return Boolean(row) && row[(x | 0) - (scene.originX || 0)] === 0;
  }

  // Where we stand after the tick that arrives at tickLocal. The server applies
  // a walk request at the first tick after receiving it (July recordings:
  // requests sent before phase ~600-RTT step at the next tick, always), and a
  // request that is too late for that tick leaves the previous one in force.
  // Live 26/09 with the ring-board walking (2-3 requests per tick, in pairs
  // 15-35 ms apart): the server drops a request sent < ~100 ms after the one
  // it kept. "Latest kept request that reaches the tick" called 98.6% of our
  // steps; "latest request, stay if it is late" (v6_11) only 17%.
  const WALK_THROTTLE_MS = 100;

  function tickNoteWalkRequest(x, y, t) {
    const E = state.tickEngine;
    if (t - E.walkAcceptedAt < WALK_THROTTLE_MS) return; // the server drops it
    E.walkAcceptedAt = t;
    E.walkReqs.push({ x, y, t });
    if (E.walkReqs.length > 8) E.walkReqs.shift();
    E.selfDest = { x, y };
    E.selfWalkAt = t;
    tickPreflightInvalidate();
  }

  function tickProjectSelf(actor, tickLocal) {
    const E = state.tickEngine;
    const pos = { x: actor.toX | 0, y: actor.toY | 0 };
    const rtt = rttEstimateMs();
    let dest = null;
    for (const r of E.walkReqs) if (tickLocal == null || r.t + rtt + 5 <= tickLocal) dest = r;
    if (!dest || (dest.x === pos.x && dest.y === pos.y)) return pos;
    const next = { x: pos.x + Math.sign(dest.x - pos.x), y: pos.y + Math.sign(dest.y - pos.y) };
    return tickWalkable(next.x, next.y) ? next : pos;
  }

  // ---- Threat targeting ------------------------------------------------------
  // P(lateral contact at the landing) for every enemy within 3 tiles:
  //  - no server tick before the landing: contact can not change: 1 or 0;
  //  - a tick before it: measured probability (tools/build_contact_model.js,
  //    64k ticks of July recordings) keyed by the rival offset from our tile
  //    after that tick and the rival step in the latest batch (orient, 0 if it
  //    did not move). A lateral rival that stood still stays 98% of the time;
  //    one that just stepped in leaves 86-98% of the time; entering contact
  //    from nearby is 0-36% depending on where it is and where it went.
  // Highest probability wins, then the nearest. Knocked rivals are skipped.
  const CONTACT_MODEL = /*CONTACT_MODEL*/{"full":{"3,3,0":0,"-3,3,1":0,"-2,2,3":0,"-3,3,4":0,"-2,3,1":0,"-3,2,2":0,"-2,3,7":0,"-2,1,3":0,"-1,2,1":0,"-2,3,4":0,"2,2,2":0.239,"1,2,8":0.077,"0,1,2":0.113,"1,2,1":0.064,"-3,3,0":0,"2,2,5":0.169,"2,2,0":0.002,"1,3,4":0,"0,3,8":0,"1,3,5":0,"-1,3,2":0,"-3,2,3":0,"-3,0,3":0,"-2,1,1":0,"-2,2,2":0,"-3,0,2":0,"-3,1,8":0,"-2,2,1":0,"-1,3,1":0,"-2,-3,5":0,"-1,-2,7":0.167,"0,-3,5":0,"1,-3,6":0,"0,-3,4":0,"0,-2,4":0.162,"0,-1,5":0.098,"-1,-1,4":0.067,"-3,-1,8":0,"-3,-3,6":0,"-3,-2,5":0,"-3,0,4":0,"-2,-2,3":0.243,"-1,-1,7":0.041,"-2,-1,6":0.123,"0,-2,5":0.273,"2,-2,1":0,"-2,-3,1":0,"3,-1,7":0,"3,0,7":0,"3,1,7":0,"-1,0,7":0.128,"3,2,7":0,"-1,0,0":0.003,"-3,2,0":0,"3,-2,0":0,"2,-1,4":0,"2,-3,1":0,"1,-1,8":0,"2,-2,7":0,"-2,1,0":0,"1,-3,2":0,"2,-3,8":0,"-2,0,0":0.004,"2,-3,5":0,"1,-3,4":0,"3,-3,4":0,"3,-3,0":0,"-1,-3,4":0,"-2,-1,7":0.13,"-1,-3,3":0,"-1,-2,1":0.078,"-1,-2,3":0.128,"-2,-2,4":0.257,"-2,-3,3":0,"0,3,0":0,"-3,-3,4":0,"-1,3,0":0,"-3,-2,4":0,"2,-1,0":0,"-2,-1,4":0.15,"3,-1,0":0,"-2,-2,7":0.143,"0,-3,3":0,"0,-1,4":0.045,"0,0,4":0.059,"1,3,0":0,"0,-2,3":0.197,"1,0,7":0.289,"3,-2,3":0,"2,0,4":0.297,"2,-1,3":0,"2,1,4":0.08,"1,1,4":0.049,"1,1,3":0.044,"2,-2,0":0,"1,2,3":0.07,"2,-3,0":0,"0,1,8":0.125,"2,0,3":0.233,"3,-2,2":0,"3,-1,8":0,"3,-1,4":0,"3,-2,6":0,"2,-2,5":0,"3,-2,5":0,"2,0,0":0.002,"3,0,0":0,"-3,-3,8":0,"3,1,0":0,"2,-1,2":0,"1,-1,4":0,"-2,-3,2":0,"-3,1,1":0,"-1,3,8":0,"-2,3,8":0,"-3,1,0":0,"-2,2,5":0,"-2,3,2":0,"1,3,3":0,"3,2,3":0,"3,-3,2":0,"1,-3,1":0,"-1,0,8":0.108,"-2,0,4":0.217,"-3,1,7":0,"-2,-1,3":0.102,"-3,-1,0":0,"-1,0,5":0.103,"1,-2,3":0,"1,0,4":0.145,"-1,-2,5":0.047,"0,-1,1":0.09,"0,1,1":0.114,"-1,-1,8":0.081,"2,3,0":0,"3,-1,2":0,"3,2,0":0,"1,-3,0":0,"3,-2,7":0,"2,0,2":0.242,"1,0,6":0.095,"0,2,4":0.203,"1,2,6":0.206,"-1,2,8":0,"-1,2,6":0,"0,2,6":0.188,"0,2,5":0.25,"0,2,3":0.333,"-2,1,2":0,"-3,-1,5":0,"2,1,1":0.123,"-3,2,7":0,"3,2,1":0,"3,3,4":0,"3,-3,3":0,"-2,-1,2":0.024,"3,2,4":0,"-3,-2,8":0,"2,2,4":0.208,"-3,-3,3":0,"1,2,0":0.002,"0,2,0":0.004,"-1,2,0":0,"2,0,8":0.114,"0,0,0":0,"1,-1,0":0,"0,-1,0":0.002,"-2,0,1":0.219,"-2,1,7":0,"-3,0,7":0,"-2,0,5":0.145,"3,-1,1":0,"-2,-3,0":0,"-1,-3,0":0,"0,1,6":0.05,"1,-2,4":0,"1,-3,3":0,"2,-1,7":0,"3,0,1":0,"2,3,8":0,"3,3,5":0,"0,-2,1":0.279,"3,2,2":0,"3,2,8":0,"-3,0,6":0,"-3,-2,6":0,"-3,-2,7":0,"-3,-2,2":0,"-1,-3,8":0,"3,3,3":0,"2,2,6":0.091,"-1,-3,6":0,"3,1,6":0,"-1,-2,4":0.091,"3,2,5":0,"1,0,1":0.076,"3,1,5":0,"0,1,7":0.094,"-1,2,2":0,"0,1,5":0.325,"0,3,4":0,"1,3,1":0,"-3,0,0":0,"0,2,2":0.223,"-1,0,6":0.188,"-1,0,3":0.039,"-1,-1,3":0.064,"-3,-3,2":0,"-2,-3,7":0,"-2,-2,6":0.281,"-2,-1,1":0.105,"-1,-2,2":0.094,"-2,-2,8":0.217,"-2,-1,5":0.161,"2,1,7":0.077,"-2,2,8":0,"-2,3,0":0,"-3,-1,3":0,"0,-2,0":0.004,"1,-2,8":0,"-1,-3,1":0,"-2,-3,8":0,"-2,-1,0":0.012,"-3,-2,0":0,"-3,-1,7":0,"-3,0,8":0,"1,3,2":0,"0,-3,0":0,"1,-2,0":0,"2,3,3":0,"-1,3,4":0,"1,-1,7":0,"1,2,5":0.082,"-1,0,2":0.029,"-2,0,7":0.186,"-1,1,5":0,"0,-1,7":0.162,"-1,1,2":0,"-3,2,4":0,"-2,0,3":0.282,"1,1,0":0.986,"-1,1,0":0,"-3,-1,6":0,"-1,-1,0":0.975,"-2,-3,6":0,"-1,-1,2":0.024,"-1,-1,6":0.118,"1,-1,2":0,"1,2,4":0.082,"2,1,0":0.001,"-3,2,1":0,"1,-3,5":0,"0,-2,7":0.057,"-2,-3,4":0,"-3,-3,0":0,"0,-3,1":0,"-2,-2,5":0.141,"2,-2,2":0,"1,-2,7":0,"0,-3,6":0,"3,1,2":0,"2,3,7":0,"1,0,8":0.081,"3,2,6":0,"3,-3,8":0,"3,-2,4":0,"1,0,0":0.001,"1,1,7":0.133,"3,1,3":0,"2,1,6":0.125,"2,-1,6":0,"0,1,4":0.117,"0,-1,3":0.074,"-2,1,4":0,"1,1,5":0.143,"1,3,7":0,"1,1,6":0.089,"2,-1,5":0,"-3,-3,1":0,"0,2,7":0.216,"3,1,4":0,"2,1,2":0.074,"3,0,6":0,"2,1,8":0.2,"-2,-2,0":0.001,"2,2,1":0.109,"3,3,1":0,"2,-2,8":0,"2,-3,3":0,"2,-3,2":0,"0,-3,8":0,"2,-3,4":0,"1,-3,7":0,"3,-1,5":0,"-3,0,1":0,"-1,1,1":0,"-1,0,1":0.1,"0,1,0":0.001,"-1,1,7":0,"-1,-1,1":0.047,"1,-1,5":0,"-1,-1,5":0.121,"2,3,4":0,"-3,-3,7":0,"-2,2,0":0,"-1,-3,7":0,"1,2,2":0.117,"2,2,8":0.118,"3,-3,6":0,"2,2,3":0.143,"3,3,7":0,"3,0,5":0,"2,-2,3":0,"2,0,6":0.359,"3,3,8":0,"3,0,2":0,"3,-1,3":0,"1,-2,6":0,"0,-1,2":0.132,"1,-2,5":0,"-2,1,8":0,"0,1,3":0.068,"1,-1,3":0,"0,3,3":0,"1,0,2":0.111,"1,1,1":0.055,"1,-1,6":0,"-3,-1,4":0,"2,0,1":0.167,"-1,0,4":0.176,"-1,1,8":0,"1,-2,1":0,"2,-2,4":0,"0,-3,7":0,"2,-2,6":0,"0,-2,2":0.118,"1,-1,1":0,"1,2,7":0.103,"1,0,3":0.113,"3,-3,5":0,"-3,1,3":0,"1,1,2":0.04,"-1,1,3":0,"-2,2,4":0,"-2,-2,2":0.239,"-3,1,4":0,"2,3,5":0,"0,3,5":0,"3,1,1":0,"2,-1,1":0,"3,-2,1":0,"-3,-1,1":0,"2,1,3":0.064,"3,0,8":0,"-1,1,4":0,"-3,-1,2":0,"-1,2,4":0,"2,3,2":0,"3,1,8":0,"2,2,7":0.19,"-3,1,2":0,"2,3,1":0,"0,-2,6":0.296,"-1,-2,0":0.001,"0,3,2":0,"-3,-2,3":0,"0,-3,2":0,"-3,1,5":0,"-1,2,3":0,"1,-2,2":0,"2,0,7":0.118,"2,-1,8":0,"-1,2,5":0,"0,3,1":0,"1,3,8":0,"0,2,8":0.128,"3,0,4":0,"-1,3,5":0,"-3,0,5":0,"-1,3,3":0,"-2,1,5":0,"1,3,6":0,"-2,-1,8":0.125,"2,-3,6":0,"3,0,3":0,"-2,0,2":0.121,"-1,-3,5":0,"1,-3,8":0,"-2,-2,1":0.269,"-1,-2,8":0.037,"0,0,2":0.333,"-1,2,7":0,"0,0,1":0.188,"-1,3,7":0,"0,3,7":0,"-1,-3,2":0,"0,2,1":0.296,"-2,0,6":0.179,"3,3,2":0,"2,0,5":0.245,"1,1,8":0.127,"3,-1,6":0,"-2,1,6":0,"2,1,5":0.043,"-2,2,7":0,"-1,1,6":0,"2,3,6":0,"-1,-2,6":0.081,"-3,-2,1":0,"0,-1,6":0.179,"3,-3,1":0,"-3,-3,5":0,"1,0,5":0.173,"2,-3,7":0},"rel":{"3,3":0,"-2,3":0,"-3,3":0,"-2,2":0,"-1,3":0,"-3,2":0,"-2,1":0,"-1,2":0,"2,2":0.035,"1,2":0.025,"0,1":0.031,"1,3":0,"0,3":0,"-3,0":0,"-3,1":0,"-2,-3":0,"-1,-2":0.026,"0,-3":0,"1,-3":0,"0,-2":0.043,"0,-1":0.029,"-1,-1":0.676,"-3,-1":0,"-3,-3":0,"-3,-2":0,"-2,-2":0.08,"-2,-1":0.075,"2,-2":0,"3,-1":0,"3,0":0,"3,1":0,"-1,0":0.046,"3,2":0,"3,-2":0,"2,-1":0,"2,-3":0,"1,-1":0,"-2,0":0.051,"3,-3":0,"-1,-3":0,"0,0":0.027,"1,0":0.048,"2,0":0.072,"2,1":0.025,"1,1":0.755,"1,-2":0,"2,3":0,"0,2":0.067,"-1,1":0}}/*END_CONTACT_MODEL*/;
  const DIR_ORIENT = { "1,1": 1, "-1,-1": 2, "1,-1": 3, "-1,1": 4, "1,0": 5, "0,-1": 6, "0,1": 7, "-1,0": 8 };

  function contactProb(dx, dy, lastOrient) {
    const full = CONTACT_MODEL.full[`${dx},${dy},${lastOrient}`];
    if (full != null) return full;
    const rel = CONTACT_MODEL.rel[`${dx},${dy}`];
    return rel != null ? rel : 0;
  }

  function threatPick(landingLocal, minProb = 0.2, exclude = null) {
    const E = state.tickEngine;
    const selfId = inferSelfId();
    if (selfId == null || selfId < 0) return null;
    const selfActor = ensureActorFromRenderer(selfId);
    if (!selfActor) return null;
    const t = now();
    let tickBetween = false;
    let nextTick = null;
    if (E.origin != null && E.batches.length >= 1) {
      nextTick = E.origin + Math.ceil((t + 20 - E.origin) / TICK_MS) * TICK_MS;
      tickBetween = nextTick < landingLocal;
    }
    const me = tickBetween ? tickProjectSelf(selfActor, nextTick) : { x: selfActor.toX, y: selfActor.toY };
    // Our own step is a guess too: a new walk click can replace the path right
    // before the tick (25/09 live: we stayed, the rival walked into the tile
    // next to where we stood). Judge every rival from both tiles; staying is
    // the less likely one (weight 0.3).
    const spots = [{ ...me, w: 1 }];
    if (tickBetween && (me.x !== selfActor.toX || me.y !== selfActor.toY)) spots.push({ x: selfActor.toX, y: selfActor.toY, w: 0.3 });
    const renderer = sceneRenderer();
    let best = null;
    let second = null;
    for (const rawId of renderer?.avatars?.keys?.() || []) {
      const id = asId(rawId);
      if (id == null || id === selfId || id === exclude || E.out.has(id) || isMuted(id) || isAlly(id) || isStale(id)) continue;
      if ((E.down.get(id) || 0) > t) continue;
      const a = ensureActorFromRenderer(id);
      if (!a) continue;
      let p = -1;
      let dist = 99;
      let from = me;
      for (const spot of spots) {
        const dx = a.toX - spot.x;
        const dy = a.toY - spot.y;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        if (d > 3) continue;
        let q;
        if (!tickBetween) {
          q = lateralAdjacent(spot.x, spot.y, a.toX, a.toY) ? 1 : 0;
        } else {
          const movedLast = a.startAt >= E.lastBatchAt - 30 && (a.dirX || a.dirY);
          q = contactProb(dx, dy, movedLast ? DIR_ORIENT[`${a.dirX},${a.dirY}`] || 0 : 0);
          // One diagonal step from contact is one step from killing us.
          if (d === 2 && dx !== 0 && dy !== 0 && q < THREAT_STEP_FLOOR) q = THREAT_STEP_FLOOR;
        }
        q *= spot.w;
        if (q > p) { p = q; dist = d; from = spot; }
      }
      if (p < 0 || p < minProb) continue;
      // A rival in its punch animation can not be hit (nor hit us) yet.
      if (rivalLocked(id, landingLocal)) continue;
      // A defender that is walking gets hit faster: live 26/09, our hold on a
      // standing rival was 69-138 ms (median 118), on a walking one ~76 with
      // some near 0 (July, all players: median 139-165 vs 92-100 after contact).
      const walking = a.startAt >= E.lastBatchAt - 30 && Boolean(a.dirX || a.dirY);
      const rank = p * 1000 * (walking ? WALKER_BONUS : 1) - dist;
      const cand = { id, score: Number(p.toFixed(3)), dist, rank, walking, face: faceSide(from.x, from.y, a.toX, a.toY) };
      if (!best || rank > best.rank) {
        second = best;
        best = cand;
      } else if (!second || rank > second.rank) {
        second = cand;
      }
    }
    if (best) best.second = second;
    return best;
  }

  // ---- Instant reaction --------------------------------------------------------
  // A batch that leaves an enemy in lateral contact with us is the one moment
  // that contact is certain, and a rival who just stepped in leaves at the next
  // tick 86-98% of the time. So we fire as soon as the batch is processed, at
  // whoever is in contact (the one who stepped in first), landing one RTT later.
  // If our last request is under 100 ms old, the shot waits for the server lock
  // to end and goes out with a twin 6 ms later.
  // ---- Reach probe (28/09) ----------------------------------------------------
  // The 28/09 client draws punches in any direction and "lunges" at 2+ tiles
  // (punchUsers / lungePunch), and on 27/09 the server resolved a hit between
  // vertical neighbours (FreeSh -> DinoLand), never seen in thousands before: the
  // reach may have grown, maybe only for some platforms (the mobile app is new).
  // After a batch, with nobody beside us, one click at a rival 1-2 tiles away but
  // not beside us; its reply (144 / 211 / silence) says what the server accepts.
  const REACH_PROBE_GAP_MS = 2500;
  const REACH_PROBE_MAX = 8;
  function reachProbeSchedule() {
    const R = state.reachProbe;
    // One check per batch; a timer that never runs (throttled) does not block the next.
    if (!R.enabled || now() - R.pendingAt < 200) return;
    R.pendingAt = now();
    setTimeout(() => { R.pendingAt = -1e9; reachProbeRun(); }, 15);
  }

  function reachProbeRun() {
    const R = state.reachProbe;
    const E = state.tickEngine;
    const t = now();
    if (!tickEnabled() || E.selfOut || R.count >= REACH_PROBE_MAX || t - R.lastAt < REACH_PROBE_GAP_MS) return;
    if (sceneRenderer()?.spaceModel?.name !== "mGame2") return;
    const landing = t + rttEstimateMs() + E.corr;
    if (selfLocked(landing) || exitBlocksLanding(landing)) return;
    const selfId = inferSelfId();
    const me = ensureActorFromRenderer(selfId);
    if (!me) return;
    let pick = null;
    for (const rawId of sceneRenderer()?.avatars?.keys?.() || []) {
      const id = asId(rawId);
      if (id == null || id === selfId || E.out.has(id) || isAlly(id) || isStale(id) || rivalLocked(id, landing)) continue;
      const a = ensureActorFromRenderer(id);
      if (!a) continue;
      if (lateralAdjacent(me.toX, me.toY, a.toX, a.toY)) return; // a real fight: leave it to the engine
      const dx = a.toX - me.toX;
      const dy = a.toY - me.toY;
      const cheb = Math.max(Math.abs(dx), Math.abs(dy));
      if (cheb >= 1 && cheb <= 2 && (!pick || cheb < pick.cheb)) pick = { id, dx, dy, cheb };
    }
    if (!pick) return;
    if (firePunch(pick.id, "REACH_PROBE", { bypassThrottle: true, packets: 1 })) {
      R.lastAt = t;
      R.count++;
      sendDiagnostic("reach_probe", { targetId: pick.id, dx: pick.dx, dy: pick.dy, cheb: pick.cheb, self: [me.toX, me.toY], phase: Math.round(landing - E.lastBatchAt) });
    }
  }

  function reactSchedule() {
    // One check per batch; a lost timer never blocks the next one.
    if (state.react.pending && now() - state.react.pendingAt < 50) return;
    state.react.pending = true;
    state.react.pendingAt = now();
    setTimeout(() => {
      state.react.pending = false;
      const bounced = state.tickEngine.pendingBounce;
      if (bounced && bounced.n === state.tickEngine.lastBatchTick) {
        state.tickEngine.pendingBounce = null;
        tickBounceRetry(bounced);
      }
      reactCheck();
    }, 0);
  }

  // Lateral enemies now; `fresh` = not lateral at the previous check (the
  // contact is new with this batch). A standing neighbour is the tick click's.
  function reactPick(update = false) {
    const E = state.tickEngine;
    const selfId = inferSelfId();
    const me = ensureActorFromRenderer(selfId);
    if (!me) return null;
    const t = now();
    const lateralNow = new Set();
    let best = null;
    for (const rawId of sceneRenderer()?.avatars?.keys?.() || []) {
      const id = asId(rawId);
      if (id == null || id === selfId || E.out.has(id) || isMuted(id) || isAlly(id) || isStale(id)) continue;
      if ((E.down.get(id) || 0) > t) continue;
      const a = ensureActorFromRenderer(id);
      if (!a || !lateralAdjacent(me.toX, me.toY, a.toX, a.toY)) continue;
      lateralNow.add(id);
      if (state.react.lateral.has(id)) continue;
      if (rivalLocked(id, t + rttEstimateMs() + E.corr)) continue; // in its punch animation: not hittable
      const rank = a.startAt >= E.lastBatchAt - 30 ? 1 : 0; // stepped in with this batch
      if (!best || rank > best.rank) best = { id, rank };
    }
    if (update) state.react.lateral = lateralNow;
    return best;
  }

  function reactCheck() {
    if (!tickEnabled() || !state.timing.tick.reactive || state.tickEngine.selfOut) return;
    if (selfLocked(now() + rttEstimateMs() + state.tickEngine.corr)) {
      reactPick(true); // keep the contact set current for when the lock ends
      return;
    }
    const pick = reactPick(true);
    if (!pick) return;
    const E = state.tickEngine;
    // This tick's click already went to it and lands after the switch.
    if (E.lastBatchTick != null && (E.tickTargets.get(E.lastBatchTick) === pick.id || E.tickTargets2.get(E.lastBatchTick) === pick.id)) return;
    const key = `${pick.id}:${Math.round(E.lastBatchAt)}`;
    if (state.react.lastKey === key) return; // one reaction per rival and batch
    state.react.lastKey = key;
    const fire = () => {
      // Still in contact and still in play when the shot leaves.
      const me = ensureActorFromRenderer(inferSelfId());
      const a = ensureActorFromRenderer(pick.id);
      if (!me || !a || E.out.has(pick.id) || !lateralAdjacent(me.toX, me.toY, a.toX, a.toY)) return;
      if (state.timing.tick.single) faceBeforeClick(faceSide(me.toX, me.toY, a.toX, a.toY));
      if (firePunch(pick.id, "REACT", { bypassThrottle: true })) state.react.fired++;
    };
    const t = now();
    const free = (state.lastPunch.at || -1e9) + GUARD_LOCK_MS + 1;
    if (t >= free) {
      fire();
    } else {
      setTimeout(fire, free - t);
      setTimeout(fire, free - t + 6);
    }
  }

  // Target for a TICK shot landing at `landing`, decided at send time. Before
  // batch n is known: anyone who can be lateral at T. After: real contact only.
  function tickPickTarget(n, t, landing) {
    const E = state.tickEngine;
    const cfg = state.timing.tick;
    const selfId = inferSelfId();
    if (selfId == null || selfId < 0 || !ensureActorFromRenderer(selfId)) return { skip: "no_self" };
    const known = t - (E.origin + n * TICK_MS) > 30;
    if (known && !cfg.reactive) return { skip: "reactive_off" };
    if (!known && !cfg.blind) return { skip: "blind_off" };
    // A blind click that finds no contact costs a 144 and a 100 ms lock that
    // ends (T+aim+100) before the reaction could land (T+RTT): clicking on any
    // real chance is free.
    // Single mode: 0.02 (July: the top pick then catches 95% of walk-ins, vs
    // 92% at 0.05; 25/09 live, 3 of 12 lost races were walk-ins at P 0.01-0.04
    // while we stood still). A blind 144 costs a 100 ms gap that ends before
    // the reaction lands.
    // 28/09 (26-28/09 captures): 88 fights began in a tick skipped as "sin_amenaza"
    // whose best candidate WAS the rival, at p < 0.005 (a standing rival one step
    // from our contact tile: the July model says 0.001-0.004, September says ~5.5%);
    // they went 48-40 on the reaction alone. Only ticks with no candidate at 0.02
    // change (the pick order does not); a silent id gets muted after 3 clicks.
    const pick = threatPick(landing, known ? 0.99 : cfg.single ? TICK_BLIND_MIN_P : 0.2);
    if (!pick) return { skip: known ? "no_contact" : "sin_amenaza" };
    // Low ping: do not guess; the reaction to the batch lands in time, at the right id.
    if (!known && lowPingActive() && pick.score < LOW_PING_BLIND_MIN) {
      state.lowPing.skipped++;
      return { skip: "ping_bajo" };
    }
    // A near tie between two rivals walking in (July: the top one is right
    // 56% of the time): the runner-up gets a second click 3 ms later.
    const two = pick.second;
    // Off: 25/09 live, the second click was never answered in 14 ties (the
    // server ignores a request 3 ms after another).
    const dual = DUAL_TIE && !known && cfg.single && two && two.score >= 0.1 && two.score >= pick.score * 0.5 && pick.score < 0.9 ? two : null;
    return { id: pick.id, reactive: known, score: pick.score, face: pick.face, dual };
  }

  // 01/10: the tick decision reads only what the batch already delivered, so it
  // runs when the batch settles (setTimeout 0 after its last step) and the fire
  // path keeps only timestamp checks and the request itself. Same data, ~500 ms
  // of slack instead of the 12 ms the fire wake gets - that margin of dispatch
  // is what lets the aim ride closer to the boundary.
  let tickPreflightPendingAt = 0; // a lost timer must not switch the preflight off
  function tickPreflightSchedule() {
    if (tickPreflightPendingAt && now() - tickPreflightPendingAt < 100) return;
    tickPreflightPendingAt = now();
    setTimeout(() => {
      tickPreflightPendingAt = 0;
      const E = state.tickEngine;
      if (!tickEnabled() || E.lastBatchTick == null || E.origin == null) return;
      const plan = E.plans.get(`TICK:${E.lastBatchTick + 1}`);
      if (!plan || plan.pre) return;
      const phase = plan.shots[0]?.phase;
      if (phase == null) return;
      const landing = E.origin + plan.n * TICK_MS + phase;
      const t0 = now();
      const pick = tickPickTarget(plan.n, t0, landing);
      const best = !pick || pick.skip ? threatPick(landing, 0) : null;
      plan.pre = { pick, best, ms: Math.round((now() - t0) * 10) / 10 };
    }, 0);
  }

  // 01/10 (v6_60): the preflight is only "same data" until something changes
  // between the batch and the shot. Our own walk request is the big one: 20 of
  // 26 sweep-late deaths today were a preflight made before we stepped next to a
  // standing rival (P 0.986) - the shot went to the old pick at P 0.03 and the
  // killer only got the sweep, 110 ms late. Same for a 211/coco that locks a rival.
  function tickPreflightInvalidate() {
    for (const plan of state.tickEngine.plans.values()) if (plan.pre) plan.pre = null;
    tickPreflightSchedule();
  }

  function tickPump() {
    if (!tickEnabled()) return;
    const E = state.tickEngine;
    const t = now();
    if (E.origin == null || E.batches.length < 1 || t - E.lastBatchAt > 15000) return;
    const cfg = state.timing.tick;
    const eff = tickEffective();
    const lead = rttEstimateMs() + E.corr;
    const offset = eff.offset;
    let n = Math.ceil((t + lead - offset - E.origin) / TICK_MS);
    if (E.origin + n * TICK_MS + offset - lead < t + 2) n++;
    if (E.armedTick != null && E.armedTick >= n) return;
    E.armedTick = n;
    // shot k lands at T + offset + k*spacing; shot 0 expands into a dense
    // burst (b = 0..burst-1, burstGapMs apart), all of it after T.
    const shots = [];
    if (state.freeFire.enabled) {
      // EXPERIMENTAL: ignora el espaciado de ~100 ms. Rellena la ventana entera
      // del tick con disparos cada gapMs al mejor objetivo (sin la guarda de
      // cooldown ni el sweep/repeat). El hueco del server sigue; es para medir.
      const gapMs = clamp(state.freeFire.gapMs | 0, 4, 200);
      let k = 0;
      for (let phase = offset; phase < offset + TICK_MS; phase += gapMs, k++) {
        shots.push({ phase, k: k === 0 ? 0 : k, b: 0, free: true });
      }
    } else {
      for (let k = 0; k < eff.shots; k++) {
        const base = offset + k * eff.spacing;
        // Keep the server cooldown clear for the next tick's first shot.
        if (base > TICK_MS - 110 + offset) break;
        const count = k === 0 ? eff.burst : 1;
        for (let b = 0; b < count; b++) shots.push({ phase: base + b * eff.gap, k, b });
      }
      const adv = state.tickAdv;
      if (cfg.single && eff.shots === 1 && cfg.blind && adv.repeatMs > 0) shots.push({ phase: offset + adv.repeatMs + burstSpanMs(), k: 1, b: 0, repeat: true });
      else if (cfg.single && eff.shots === 1 && cfg.blind && adv.sweep && !lowPingActive()) shots.push({ phase: offset + eff.spacing + SWEEP_EXTRA_MS + burstSpanMs(), k: 1, b: 0, sweep: true });
    }
    const fires = [];
    shots.forEach((shot, index) => {
      const at = E.origin + n * TICK_MS + shot.phase - lead;
      fires.push({ index, dueAt: at, delayMs: Math.max(0, at - t - SPIN_EARLY_MS) });
    });
    const planId = `TICK:${n}`;
    // o/lead: the frame the plan was armed in. Replies are judged against it,
    // not against the current origin (a refit in between used to shift err).
    E.plans.set(planId, { n, shots, burst: state.freeFire.enabled ? 1 : eff.burst, fired: 0, burstTarget: null, o: E.origin, lead });
    while (E.plans.size > 4) E.plans.delete(E.plans.keys().next().value);
    E.stats.planned++;
    try {
      ensureTimingWorker().postMessage({
        type: "arm",
        planId,
        targetId: -1,
        stepAt: n,
        stepMs: TICK_MS,
        seq: state.seq,
        leadMs: 0,
        window: "TICK",
        fires
      });
    } catch {}
  }

  function tickOnWorkerFire(msg) {
    const E = state.tickEngine;
    const plan = E.plans.get(String(msg.planId || ""));
    if (!plan) return;
    const index = msg.index | 0;
    plan.fired++;
    if (plan.fired >= plan.shots.length) E.plans.delete(String(msg.planId));
    if (!tickEnabled() || msg.seq !== state.seq) return;
    const t = now();
    const shot = plan.shots[index];
    // Every skip of a tick's first click is logged: the 26/09 audit found
    // contacts with neither a click nor a reason.
    const skip = (reason) => {
      E.stats.skipped++;
      E.stats.lastSkip = reason;
      if (shot && shot.k === 0 && !shot.b && !shot.sweep && state.diagnostics.enabled) sendDiagnostic("tick_skip", { tick: plan.n, reason });
    };
    if (E.selfOut || t < E.pausedUntil) return skip(E.selfOut ? "eliminado" : "self_down");
    if (!shot) return;
    const phase = shot.phase;
    if (exitBlocksLanding(E.origin + plan.n * TICK_MS + phase)) return skip("self_coco");
    if (selfLocked(E.origin + plan.n * TICK_MS + phase)) return skip("traba");
    // The unlock click covers this moment (a second click would only hit the
    // server's 100 ms gap) - only if it has someone to hit: 26/09 it went out
    // with no target 102 times in 117, and the tick click was dropped anyway.
    const unlockLanding = E.unlock.end + UNLOCK_MARGIN_MS;
    if (E.unlock.end && E.unlock.end === E.selfLockEnd && Math.abs(E.origin + plan.n * TICK_MS + phase - unlockLanding) < 120 &&
        (unlockAmbusher(unlockLanding) || threatPick(unlockLanding, UNLOCK_MIN_PROB))) return skip("unlock");
    // A rival's unlock click covers this moment (a standing neighbour waking
    // up is surer than a guess, and a 144 here would block it).
    if (runlockCovers(E.origin + plan.n * TICK_MS + phase)) return skip("runlock");
    let pick;
    if (shot.repeat) {
      // Second click at the first click's target (whatever happened to the first).
      if (plan.burstTarget == null || plan.burstReactive) return;
      pick = { id: plan.burstTarget, reactive: false, score: plan.burstScore, repeat: true };
    } else if (shot.sweep) {
      // Only after a blind first click: the runner-up at the sweep landing.
      if (plan.burstTarget == null || plan.burstReactive) return;
      const second = threatPick(E.origin + plan.n * TICK_MS + phase, SWEEP_MIN_SCORE, plan.burstTarget);
      if (!second) {
        E.stats.skipped++;
        E.stats.lastSkip = "sweep_none";
        return;
      }
      pick = { id: second.id, reactive: false, score: second.score, face: second.face, sweep: true };
    } else if (shot.b > 0) {
      // Rest of the burst: same target and decision as its first request.
      if (plan.burstTarget == null) return;
      pick = { id: plan.burstTarget, reactive: plan.burstReactive, score: plan.burstScore };
    } else {
      // 01/10: precomputed at batch settle (same data); without a preflight
      // (no batch, late arm) the decision happens here, as before.
      const pre = plan.pre;
      pick = pre ? pre.pick : tickPickTarget(plan.n, t, E.origin + plan.n * TICK_MS + phase);
      if (!pick || pick.skip) {
        E.stats.skipped++;
        E.stats.lastSkip = pick?.skip || "none";
        if (state.diagnostics.enabled) {
          const best = pre ? pre.best : threatPick(E.origin + plan.n * TICK_MS + phase, 0);
          sendDiagnostic("tick_skip", { tick: plan.n, reason: pick?.skip || "none", bestId: best ? best.id : -1, bestP: best ? best.score : 0, bestDist: best ? best.dist : null, pre: pre ? 1 : 0 });
        }
        if (shot.k === 0) plan.burstTarget = null;
        return;
      }
      if (shot.k === 0) {
        plan.burstTarget = pick.id;
        plan.burstReactive = pick.reactive;
        plan.burstScore = pick.score;
        if (plan.burst > 1) {
          E.bursts.push({ n: plan.n, at: t, sent: 0, replies: 0, hits: 0 });
          while (E.bursts.length > 40) E.bursts.shift();
        }
      }
    }
    const inBurst = shot.k === 0 && plan.burst > 1;
    // The face goes out ~SPIN_EARLY_MS before the punch: the server processes
    // rotations in order before it, and what is left after the spin is the
    // punch request itself.
    const faced = state.timing.tick.single && !E.selfOut ? faceBeforeClick(pick.face) : false;
    spinUntil(Number(msg.dueAt));
    const sentAt = now();
    const ok = firePunch(pick.id, pick.repeat ? "TICK_REPEAT" : pick.sweep ? "TICK_SWEEP" : pick.reactive ? "TICK_REACT" : "TICK_BLIND", { bypassThrottle: true });
    if (ok && pick.repeat) state.tickAdv.repeats++;
    if (ok && pick.sweep) {
      E.sweepStats.fired++;
      E.tickTargets2.set(plan.n, pick.id); // the reaction leaves it to the sweep
      while (E.tickTargets2.size > 8) E.tickTargets2.delete(E.tickTargets2.keys().next().value);
    } else if (ok) {
      E.tickTargets.set(plan.n, pick.id);
      while (E.tickTargets.size > 8) E.tickTargets.delete(E.tickTargets.keys().next().value);
    }
    const burst = inBurst ? E.bursts.findLast((x) => x.n === plan.n) : null;
    if (burst && ok) burst.sent++;
    const first = { sentAt, dueAt: Number(msg.dueAt), late: 0, o: plan.o, n: plan.n, k: shot.k, b: shot.b, phase, targetId: pick.id, reactive: pick.reactive, ok, matched: false, burst };
    E.shots.push(first);
    if (ok && pick.dual && shot.b === 0) {
      // No turn for it: a valid first click must keep its facing.
      spinUntil(sentAt + 3);
      const okDual = firePunch(pick.dual.id, "TICK_DUAL", { bypassThrottle: true });
      if (okDual) {
        const dualShot = { sentAt: now(), dueAt: sentAt + 3, late: 0, o: plan.o, n: plan.n, k: shot.k, b: 1, dual: true, phase: phase + 3, targetId: pick.dual.id, reactive: false, ok: true, matched: false, burst: null, pair: first };
        first.pair = dualShot;
        E.shots.push(dualShot);
        E.tickTargets2.set(plan.n, pick.dual.id);
        while (E.tickTargets2.size > 8) E.tickTargets2.delete(E.tickTargets2.keys().next().value);
        E.stats.dual = (E.stats.dual || 0) + 1;
      }
      sendDiagnostic("tick_dual", { tick: plan.n, firstId: pick.id, firstScore: pick.score, dualId: pick.dual.id, dualScore: pick.dual.score, ok: okDual });
    }
    while (E.shots.length > 40) E.shots.shift();
    if (ok) E.stats.fired++;
    else E.stats.blocked++;
    if (pick.reactive) E.stats.reactive++;
    else E.stats.blind++;
    const late = Math.round(sentAt - Number(msg.dueAt));
    first.late = late;
    sendTimingMetric("fire", "STEP", pick.id, phase, phase + late, late, TICK_MS, 1, ok,
      `tick n=${plan.n} k=${shot.k} b=${shot.b} ${pick.reactive ? "react" : "blind"} score=${pick.score} corr=${Math.round(E.corr)}`,
      { window: "TICK", scheduler: "worker", tickPhase: phase, corrMs: Math.round(E.corr), rttMs: rttEstimateMs(), reactive: pick.reactive });
    sendDiagnostic("tick_fire", {
      tick: plan.n, index, k: shot.k, b: shot.b, phase, targetId: pick.id, reactive: pick.reactive, score: pick.score, ok, face: faced ? pick.face : 0,
      lateMs: late, corrMs: E.corr, origin: E.origin, rttMs: rttEstimateMs(), burst: state.tickBurst, pre: plan.pre ? 1 : 0, preMs: plan.pre?.ms ?? null
    });
  }

  // 144 (rejected) or 211 by us (hit): the reply's phase on the grid is when
  // the server processed the shot, so it measures our landing error.
  function tickOnServerReply(t, kind, targetId = -1) {
    const E = state.tickEngine;
    if (E.origin == null) return;
    // The server handles requests in order: a reply belongs to the earliest
    // unanswered shot whose expected reply time is close to it. Expected times
    // use each shot's saved origin (the frame it was planned in): a refit
    // between arming and reply used to shift err by the drift (28/09).
    const tol = 60 + 2 * E.auto.sigma;
    const shotO = (s) => (s.o == null ? E.origin : s.o);
    let best = null;
    for (const s of E.shots) {
      if (s.matched || !s.ok || s.sentAt > t) continue;
      // A hit names its defender: only a shot aimed at him can own the reply
      // (28/09: 6 of 25 hits were matched to a shot aimed at someone else).
      if (kind === "hit" && targetId >= 0 && s.targetId !== targetId) continue;
      if (Math.abs(t - (shotO(s) + s.n * TICK_MS + s.phase)) > tol) continue;
      if (!best || s.sentAt < best.sentAt) best = s;
    }
    if (kind === "hit" && targetId >= 0 && !best) E.stats.hitsUnmatched++;
    // Near-tie pair: a 144 belongs to the one that did not end next to us.
    if (best && kind === "reject") {
      const other = best.pair && !best.pair.matched ? best.pair : null;
      if (other) {
        const me = ensureActorFromRenderer(inferSelfId());
        const lat = (id) => { const a = ensureActorFromRenderer(id); return Boolean(me && a && lateralAdjacent(me.toX, me.toY, a.toX, a.toY)); };
        if (lat(best.targetId) && !lat(other.targetId)) best = other;
      }
    }
    // A 144 carries no target: it is the matched shot's.
    tickAutoNoteReply(t, kind, kind === "hit" ? targetId : best ? best.targetId : -1);
    if (!best) return;
    best.matched = true;
    if (best.burst) {
      best.burst.replies++;
      if (kind === "hit") best.burst.hits++;
    }
    const observed = tickWrap(t - shotO(best));
    const err = tickWrap(observed - best.phase);
    const errAdj = tickWrap(err - (best.late || 0));
    E.stats.replies++;
    if (kind === "hit") E.stats.hits++;
    // Only a 144 measures the landing: it is answered on arrival, while a hit
    // is held 50-160 ms before its 211. Hits used to push corr up ~10 ms each
    // and inflate sigma (26/09 live: we then landed 9 ms early, at T+1..3).
    if (kind !== "reject") {
      sendDiagnostic("tick_reply", { kind, tick: best.n, k: best.k, b: best.b, phase: best.phase, observed, errMs: err, errAdjMs: errAdj, corrMs: E.corr, lateMs: best.late || 0, oDriftMs: Math.round(E.origin - shotO(best)) });
      return;
    }
    // Calibration gate (28/09): a late dispatch lands late and reads as
    // landing error - one-sided, it biased corr up and inflated sigma (33 of
    // 625 rejects; one took corr 13.8 -> 25.9). And a 144 names no request:
    // when another engine's punch (REACT, GUARD, UNLOCK, RETRY, probes...) or
    // a tick shot outside this burst cluster could own it, err is not ours.
    // The reply is still consumed in FIFO order; only learning is gated.
    if (best.late >= TICK_CAL_MAX_LATE_MS) {
      E.stats.calSkippedLate++;
      sendDiagnostic("tick_reply", { kind, tick: best.n, k: best.k, b: best.b, phase: best.phase, observed, errMs: err, errAdjMs: errAdj, corrMs: E.corr, lateMs: best.late, late: true, oDriftMs: Math.round(E.origin - shotO(best)) });
      tickBounceRetry(best);
      return;
    }
    let rivals = 0;
    for (const s of E.shots) {
      if (s === best || s === best.pair || s.matched || !s.ok || s.sentAt > t) continue;
      if (Math.abs(t - (shotO(s) + s.n * TICK_MS + s.phase)) > tol) continue;
      // The rest of best's own burst (same tick, same target, sent right
      // after) is the same click to the server: not a competing candidate.
      if (s.targetId === best.targetId && s.n === best.n && Math.abs(s.sentAt - best.sentAt) <= 30) continue;
      rivals++;
    }
    const rtt = rttEstimateMs() + E.corr;
    for (const r of E.allShots) {
      if (String(r.reason || "").startsWith("TICK")) continue; // covered above
      if (Math.abs(t - (r.at + rtt)) > tol) continue;
      rivals++;
    }
    if (rivals > 0) {
      E.stats.calSkippedAmbiguous++;
      sendDiagnostic("tick_reply", { kind, tick: best.n, k: best.k, b: best.b, phase: best.phase, observed, errMs: err, errAdjMs: errAdj, corrMs: E.corr, lateMs: best.late || 0, ambiguous: true, rivals, oDriftMs: Math.round(E.origin - shotO(best)) });
      tickBounceRetry(best);
      return;
    }
    E.lastErr = Math.round(errAdj);
    E.errs.push(Math.round(errAdj));
    while (E.errs.length > 30) E.errs.shift();
    E.stats.calibrated++;
    E.auto.sigma = Math.max(2, Math.min(80, 0.92 * E.auto.sigma + 0.08 * 1.2533 * Math.abs(errAdj)));
    if (state.timing.tick.autoCal && Math.abs(errAdj) < 150) {
      // Outliers (a lost request, a stall) move corr only a bounded step.
      const lim = 10 + 2.5 * E.auto.sigma;
      E.corr = Math.max(-150, Math.min(150, E.corr + 0.25 * Math.max(-lim, Math.min(lim, errAdj))));
    }
    sendDiagnostic("tick_reply", { kind, tick: best.n, k: best.k, b: best.b, phase: best.phase, observed, errMs: err, errAdjMs: errAdj, corrMs: E.corr, lateMs: best.late || 0, oDriftMs: Math.round(E.origin - shotO(best)) });
    tickBounceRetry(best);
  }

  // The tick click bounced (144) but its target IS next to us after the batch:
  // it landed a hair before the switch (jitter, 26/09: 144s at T+0 and T-3).
  // An autoclick would click again after the server gap; so do we, once per
  // tick, landing after the gap of every click we already sent for that tick.
  function tickBounceRetry(shot) {
    const E = state.tickEngine;
    if (shot.k !== 0 || shot.reactive || E.bounceRetryTick === shot.n) return;
    if (!tickEnabled() || E.selfOut) return;
    // Bounced before the batch of its tick came in (landed at T-x): judge it
    // once the batch shows who is next to us.
    if (E.lastBatchTick != null && shot.n === E.lastBatchTick + 1) {
      E.pendingBounce = shot;
      return;
    }
    if (shot.n !== E.lastBatchTick) return;
    const id = shot.targetId;
    const me = ensureActorFromRenderer(inferSelfId());
    const a = ensureActorFromRenderer(id);
    if (!me || !a || E.out.has(id) || isMuted(id) || !lateralAdjacent(me.toX, me.toY, a.toX, a.toY)) return;
    const lead = rttEstimateMs() + E.corr;
    let landAfter = 0;
    for (const x of E.shots) {
      if (x.n === shot.n && x.ok) landAfter = Math.max(landAfter, E.origin + x.n * TICK_MS + x.phase + 104 + burstSpanMs());
    }
    const landing = Math.max(now() + lead, landAfter);
    if (selfLocked(landing) || rivalLocked(id, landing) || exitBlocksLanding(landing)) return;
    E.bounceRetryTick = shot.n;
    const fire = () => {
      const m = ensureActorFromRenderer(inferSelfId());
      const b = ensureActorFromRenderer(id);
      if (E.selfOut || !m || !b || E.out.has(id) || !lateralAdjacent(m.toX, m.toY, b.toX, b.toY)) return;
      if (firePunch(id, "RETRY", { bypassThrottle: true })) E.stats.bounceRetries = (E.stats.bounceRetries || 0) + 1;
    };
    const wait = landing - lead - now();
    if (wait <= 1) fire();
    else setTimeout(fire, wait);
  }

  // ---- TICK autotune ---------------------------------------------------------
  // Learns while playing and aims the first shot of every tick at B + margin:
  //  - B: phase (ms after T, server side) where the server switches contact.
  //    Samples come only from ticks where the contact with the fichado
  //    changed: there each reply says whether it was processed before or after
  //    the switch (new contact: 211 = after, 144 = before; lost contact: the
  //    reverse). A 211 from the fichado on us at a new contact is also "after".
  //  - margin: squeezed on every race we win (-1) and on every race lost by
  //    landing late (-3); pushed back when the first shot lands before the
  //    switch (+4 lost, +3 when a later shot still won: "rescued").
  //    It settles where early shots and late losses balance, as close to B as
  //    our jitter allows.
  //  - sigma: landing jitter (robust EW of the landing error).
  //  - cooldown: from replies per burst. Global cooldown: an early request
  //    locks the next 100 ms, so the burst shrinks to 2. No cooldown: the
  //    burst widens to cover the jitter and may start before B.
  // Learned values persist in the game localStorage between sessions.
  const TICK_AUTO_KEY = "bbhub.tickAuto.v5"; // v5 (02/10): v6_58-60 saved B at -10 (144s read an RTT early); v4 (27/09): B no longer fed with 211 phases (landing + hold); v3 samples were inflated
  const TICK_AUTO_SAMPLES = 60;

  function tickAutoInit() {
    return {
      B: TICK_B_PRIOR,
      margin: TICK_MARGIN_FLOOR,
      sigma: 4,
      cooldown: "unknown",
      samples: [],
      rival: [],
      races: [],
      contact: new Map(),
      replies: [],
      rivalHits: [],
      thirdParty: [],
      lastContactN: null,
      lastRaceN: null,
      wins: 0,
      rescued: 0,
      early: 0,
      late: 0,
      lastOutcome: "",
      dirty: false,
      savedAt: 0,
      loaded: false
    };
  }

  function tickAutoNum(value, lo, hi, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fallback;
  }

  function tickAutoLoad() {
    const A = state.tickEngine.auto;
    if (A.loaded) return;
    A.loaded = true;
    try {
      const raw = window.localStorage?.getItem(TICK_AUTO_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      A.B = tickAutoNum(saved.B, TICK_B_MIN, TICK_B_MAX, A.B);
      const savedMargin = tickAutoNum(saved.margin, -40, 80, A.margin);
      // A margin saved above the cap had drifted: start again from the floor.
      A.margin = savedMargin > TICK_MARGIN_MAX ? TICK_MARGIN_FLOOR : Math.max(TICK_MARGIN_FLOOR, savedMargin);
      // Saved before v6_0, sigma and corr were inflated by held hits: cap them
      // (live, 144s alone give sigma ~4 and corr ~5).
      A.sigma = Math.min(saved.v6 ? 80 : 6, tickAutoNum(saved.sigma, 2, 80, A.sigma));
      if (["global", "partial", "none"].includes(saved.cooldown)) A.cooldown = saved.cooldown;
      if (Array.isArray(saved.samples)) {
        A.samples = saved.samples
          .filter((s) => tickSampleOk(Number(s?.p)))
          .slice(-TICK_AUTO_SAMPLES)
          .map((s) => ({ p: Number(s.p), after: Boolean(s.after) }));
      }
      // Refit from the samples that survive the filter (28/09: a saved B of -150).
      if (A.samples.length) A.B = tickAutoFitBoundary(A.samples);
      if (Array.isArray(saved.rival)) A.rival = saved.rival.filter((v) => Number.isFinite(v)).slice(-20);
      // Live, the real lead is ping + 4..7 ms in every session: start there
      // when nothing trustworthy is saved (26/09: corr 0 put the first click at T+16).
      state.tickEngine.corr = saved.v6 ? tickAutoNum(saved.corr, -150, 150, 5) : 5;
    } catch {}
  }

  function tickAutoSave(t, force = false) {
    const A = state.tickEngine.auto;
    if (!force && (!A.dirty || t - A.savedAt < 15000)) return;
    A.savedAt = t;
    A.dirty = false;
    try {
      window.localStorage?.setItem(TICK_AUTO_KEY, JSON.stringify({
        v: 1,
        v6: true, // saved after the held-hit fix (sigma/corr from 144s only)
        B: Math.round(A.B),
        margin: Math.round(A.margin),
        sigma: Math.round(A.sigma),
        cooldown: A.cooldown,
        corr: Math.round(state.tickEngine.corr),
        samples: A.samples.map((s) => ({ p: Math.round(s.p), after: s.after })),
        rival: A.rival
      }));
    } catch {}
  }

  function tickAutoReset() {
    state.tickEngine.auto = { ...tickAutoInit(), loaded: true };
    state.tickEngine.corr = 0;
    state.tickEngine.errs = [];
    try {
      window.localStorage?.removeItem(TICK_AUTO_KEY);
    } catch {}
  }

  // Shot plan for the next tick: manual values, or the learned ones.
  function tickEffective() {
    const cfg = state.timing.tick;
    if (!cfg.auto) {
      // 28/09: manual only fixes the arrival. The Hub sends spacing 110, which put the
      // sweep at T+128; after a bounced primary, auto (104) got every sweep answered
      // (32 of 32 at T+122) and 6 ms earlier is what the sweep loses races by.
      const spacing = cfg.single ? tickAutoSpacing() : cfg.spacingMs;
      return { auto: false, offset: cfg.offsetMs | 0, burst: cfg.single ? 1 : cfg.burst, gap: cfg.burstGapMs, spacing, shots: cfg.single ? 1 : cfg.shots };
    }
    const A = state.tickEngine.auto;
    const s = A.sigma;
    let burst = cfg.burst;
    let gap = cfg.burstGapMs;
    if (A.cooldown === "global" || A.cooldown === "partial") {
      burst = 2;
      gap = 3;
    } else if (A.cooldown === "none") {
      burst = clamp(Math.ceil(s / 2) + 1, 2, 8);
      gap = clamp(Math.round((2 * s) / (burst - 1)), 2, 20);
    }
    // The server cooldown (100 ms) restarts on each processed request; the
    // next shot must land after it even when both land late.
    const spacing = tickAutoSpacing();
    const offset = Math.round(Math.max(-120, Math.min(150, A.B + A.margin)));
    if (cfg.single) return { auto: true, offset, burst: 1, gap, spacing, shots: 1 };
    return { auto: true, offset, burst, gap, spacing, shots: cfg.shots };
  }

  function tickAutoSpacing() {
    const A = state.tickEngine.auto;
    return A.cooldown === "none" ? 100 : clamp(100 + Math.max(4, Math.round(A.sigma / 2)), 100, 200);
  }

  function tickAutoMarginBounds() {
    const A = state.tickEngine.auto;
    const eff = tickEffective();
    // With no server cooldown an early request costs nothing: the burst may
    // straddle B. Otherwise an early request wastes the next 100 ms.
    // 01/10: the floor follows the measured jitter instead of the constant 10.
    // With the decision off the fire path, a clean session (sigma ~4) may aim
    // T+5; a messy one keeps today's 10 (26/09: sigma 8 bounced aims at T+6/7).
    // The absolute floor 4 keeps the aim inside the acceptance window.
    const lo = A.cooldown === "none" ? -Math.max(5, (eff.burst - 1) * eff.gap)
      : Math.max(4, Math.min(TICK_MARGIN_FLOOR, Math.round(1.25 * A.sigma)), Math.round(A.sigma / 2));
    return [Math.min(lo, TICK_MARGIN_MAX), TICK_MARGIN_MAX];
  }

  // Server phase of a reply that reaches us at t: the downlink cancels
  // against the batch grid. p is relative to the nearest tick.
  function tickAutoPhase(t) {
    const E = state.tickEngine;
    const n = Math.round((t - E.origin) / TICK_MS);
    return { n, p: t - E.origin - n * TICK_MS };
  }

  function tickAutoNoteReply(t, kind, targetId) {
    const E = state.tickEngine;
    if (E.origin == null) return;
    const { n, p } = tickAutoPhase(t);
    E.auto.replies.push({ n, p, kind, target: targetId });
    while (E.auto.replies.length > 80) E.auto.replies.shift();
  }

  // A 211 on us, or on another player by someone else (its 144s mean nothing).
  function tickAutoNoteHit(t, attacker, defender, selfId) {
    const E = state.tickEngine;
    if (E.origin == null) return;
    const { n, p } = tickAutoPhase(t);
    if (defender === selfId) {
      E.auto.rivalHits.push({ n, p, attacker });
      while (E.auto.rivalHits.length > 40) E.auto.rivalHits.shift();
    } else if (attacker !== selfId) {
      E.auto.thirdParty.push({ n, id: defender });
      while (E.auto.thirdParty.length > 40) E.auto.thirdParty.shift();
    }
  }

  // Lateral contact with every enemy within 4 tiles (a rival can not cross
  // more than one tile per tick, so contact changes are always seen).
  function tickAutoContactNow() {
    const selfId = inferSelfId();
    if (selfId == null || selfId < 0) return null;
    const me = ensureActorFromRenderer(selfId);
    if (!me) return null;
    const out = new Map();
    for (const rawId of sceneRenderer()?.avatars?.keys?.() || []) {
      const id = asId(rawId);
      if (id == null || id === selfId) continue;
      const a = ensureActorFromRenderer(id);
      if (!a) continue;
      if (Math.max(Math.abs(a.toX - me.toX), Math.abs(a.toY - me.toY)) > 4) continue;
      out.set(id, lateralAdjacent(me.toX, me.toY, a.toX, a.toY));
    }
    return out;
  }

  // Threshold that best separates "before" from "after" samples (recent ones
  // weigh more), with a weak pull towards T when the evidence is thin.
  function tickAutoFitBoundary(samples, prior = TICK_B_PRIOR) {
    if (!samples.length) return prior;
    const n = samples.length;
    const pts = samples.map((s, i) => ({ p: s.p, after: s.after, w: Math.pow(0.97, n - 1 - i) }));
    const sorted = pts.map((s) => s.p).sort((a, b) => a - b);
    const cands = new Set([prior, sorted[0] - 5, sorted[n - 1] + 5]);
    for (let i = 1; i < n; i++) cands.add((sorted[i - 1] + sorted[i]) / 2);
    let best = [];
    let bestCost = Infinity;
    for (const b of cands) {
      let cost = 0.3 * Math.min(1, Math.abs(b - prior) / 40);
      for (const s of pts) {
        if (s.after ? s.p < b : s.p >= b) cost += s.w;
      }
      if (cost < bestCost - 1e-9) {
        bestCost = cost;
        best = [b];
      } else if (Math.abs(cost - bestCost) <= 1e-9) {
        best.push(b);
      }
    }
    best.sort((a, b) => a - b);
    return Math.max(TICK_B_MIN, Math.min(TICK_B_MAX, best[Math.floor((best.length - 1) / 2)]));
  }

  function tickAutoSample(p, after) {
    const A = state.tickEngine.auto;
    if (!tickSampleOk(p)) return;
    A.samples.push({ p, after });
    while (A.samples.length > TICK_AUTO_SAMPLES) A.samples.shift();
  }

  function tickAutoRace(outcome, n, ourP, rivalP, step = null) {
    const A = state.tickEngine.auto;
    A.races.push({ n, outcome, ourP, rivalP });
    while (A.races.length > 40) A.races.shift();
    if (outcome === "win") A.wins++;
    else if (outcome === "rescued") A.rescued++;
    else if (outcome === "early") A.early++;
    else A.late++;
    A.lastOutcome = outcome;
    if (state.timing.tick.auto) {
      const delta = step == null ? { win: -1, rescued: 3, early: 4, late: -3 }[outcome] : step;
      const [lo, hi] = tickAutoMarginBounds();
      A.margin = Math.max(lo, Math.min(hi, A.margin + delta));
    }
    A.dirty = true;
    sendDiagnostic("tick_race", {
      tick: n, outcome, ourPhase: ourP, rivalPhase: rivalP,
      boundary: Math.round(A.B), margin: A.margin, sigma: Math.round(A.sigma), cooldown: A.cooldown
    });
  }

  // Runs once every reply of tick n can have arrived: every enemy whose
  // contact with us changed at tick n is a sample (and maybe a race).
  function tickAutoClassify(n) {
    const A = state.tickEngine.auto;
    const prev = A.contact.get(n - 1);
    const cur = A.contact.get(n);
    if (!prev || !cur) return;
    const changed = [];
    for (const [id, on] of cur) {
      if ((prev.get(id) ?? false) !== on) changed.push(id);
    }
    if (!changed.length) return;
    for (const id of changed) {
      // Someone else hit it nearby: its 144s mean nothing here.
      if (A.thirdParty.some((m) => m.id === id && m.n >= n - 5 && m.n <= n)) continue;
      // A 144 we could not match goes to the only enemy that changed.
      const ours = A.replies
        .filter((r) => r.n === n && (r.target === id || (r.target < 0 && r.kind === "reject" && changed.length === 1)))
        .sort((a, b) => a.p - b.p);
      const rival = A.rivalHits
        .filter((r) => r.n === n && r.attacker === id)
        .sort((a, b) => a.p - b.p)[0] || null;
      if (cur.get(id)) tickAutoNewContact(n, ours, rival, id);
      else tickAutoLostContact(ours);
    }
    A.B = tickAutoFitBoundary(A.samples);
    A.dirty = true;
  }

  function tickAutoNewContact(n, ours, rival, id = null) {
    const A = state.tickEngine.auto;
    // 02/10 (v6_61): reply phases are read on the batch grid, which already
    // carries the downlink. A 144 is answered on landing and comes back one
    // downlink later - like the batch - so its grid phase IS its landing (the
    // reply matcher finds our 144s at the aimed phase +-3 ms live). v6_58
    // subtracted the RTT again: before-samples fell outside the window and late
    // 144s (REACT/RETRY, ~T+170) became after-samples at ~T-10, so B sank to its
    // floor (-10) and Auto aimed at T-3.
    // After our hit the enemy is down, after its hit we are: later 144s say
    // nothing about the switch.
    const firstHit = ours.find((r) => r.kind === "hit") || null;
    const stop = Math.min(firstHit ? firstHit.p : Infinity, rival ? rival.p : Infinity);
    const early = ours.filter((r) => r.kind === "reject" && r.p < stop);
    for (const r of early) tickAutoSample(r.p, false);
    // 27/09: a 211 phase is landing + hold (0-150 ms), not the switch: it pushed B
    // to ~12 when the switch is ~T+0..4. Sample the landing of our accepted click
    // instead; the rival 211 is skipped (its landing is unknown).
    const accepted = firstHit ? tickAutoAcceptedLanding(n, id, firstHit.p) : null;
    if (accepted != null) tickAutoSample(accepted, true);
    if (rival) {
      A.rival.push(Math.round(rival.p));
      while (A.rival.length > 20) A.rival.shift();
    }
    // Only rejects near T come from the shots aimed at this tick; an older
    // follow-up (T-260) says nothing about our aim.
    const aimedEarly = early.filter((r) => r.p >= -150);
    let outcome = "";
    if (firstHit && (!rival || firstHit.p < rival.p)) outcome = aimedEarly.length ? "rescued" : "win";
    else if (rival) outcome = aimedEarly.length && A.cooldown !== "none" ? "early" : "late";
    else if (aimedEarly.length) outcome = "early";
    if (!outcome) return;
    // Only the click aimed at this tick says something about the aim: a late
    // reaction that wins, or a tick we did not click, must not move it.
    const E = state.tickEngine;
    const aimed = E.shots.find((x) => x.n === n && x.k === 0 && x.b === 0 && x.ok && !x.reactive);
    // A valid hit is held 50-160 ms before its 211 (dual-lab July: 185 of 185,
    // idle defender) and held hits resolve in landing order (who fires 30+ ms
    // first wins 95%). So a hit phase is aim + hold, and a rival hit while our
    // aimed click drew no 144 means the rival landed before our aim.
    let step = 0;
    if (aimed) {
      const window = 3 * A.sigma + 15;
      const rejected = A.replies.some((r) => r.n === n && r.kind === "reject" && r.target === aimed.targetId && Math.abs(r.p - aimed.phase) <= window);
      if (aimedEarly.some((r) => Math.abs(r.p - aimed.phase) <= window)) step = 4; // our aim was before the switch
      else if (firstHit && (id == null || aimed.targetId === id) && firstHit.p - aimed.phase >= -window && firstHit.p - aimed.phase <= 200 && (!rival || firstHit.p < rival.p)) step = -1;
      else if (rival && (rival.p < aimed.phase || !rejected)) step = -3; // the rival landed before our aim
    }
    tickAutoRace(outcome, n, firstHit ? firstHit.p : early[0] ? early[0].p : null, rival ? rival.p : null, step);
  }

  // Lost contact: hits were processed before the switch. With no hit at all,
  // every 144 was processed after it.
  function tickAutoLostContact(ours) {
    const hits = ours.filter((r) => r.kind === "hit");
    // 27/09: a hit landed before the switch, but its 211 phase adds the hold: no sample.
    if (hits.length) return;
    for (const r of ours) tickAutoSample(r.p, true); // grid phase = landing (see tickAutoNewContact)
  }

  // Landing phase of the click aimed at tick n that drew no 144 and whose hit
  // resolved after it (hold 0-200 ms): that click landed after the switch.
  function tickAutoAcceptedLanding(n, id, hitPhase) {
    const E = state.tickEngine;
    const A = E.auto;
    const window = 3 * A.sigma + 15;
    const s = E.shots.find((x) => x.n === n && x.k === 0 && x.b === 0 && x.ok && !x.reactive && (id == null || x.targetId === id));
    if (!s) return null;
    if (A.replies.some((r) => r.n === n && r.kind === "reject" && r.target === s.targetId && Math.abs(r.p - s.phase) <= window)) return null;
    const hold = hitPhase - s.phase;
    return hold >= -window && hold <= 200 ? s.phase : null;
  }

  function tickAutoCooldown(t) {
    const E = state.tickEngine;
    const done = E.bursts.filter((b) => t - b.at > 1500 && b.sent >= 2 && b.replies >= 1).slice(-20);
    if (done.length < 6) return;
    const sent = done.reduce((s, b) => s + b.sent, 0) / done.length;
    const replies = done.reduce((s, b) => s + b.replies, 0) / done.length;
    const verdict = replies <= 1.25 ? "global" : replies >= 0.8 * sent ? "none" : "partial";
    if (verdict !== E.auto.cooldown) {
      E.auto.cooldown = verdict;
      E.auto.dirty = true;
    }
  }

  function tickAutoPump() {
    if (!tickEnabled()) return;
    const E = state.tickEngine;
    if (E.origin == null || E.batches.length < 1) return;
    const A = E.auto;
    const t = now();
    // Positions valid for tick n are in once its batch has been processed.
    const known = Math.floor((t - 40 - E.origin) / TICK_MS);
    if (A.lastContactN == null || known - A.lastContactN > 4) A.lastContactN = known - 1;
    while (A.lastContactN < known) {
      A.lastContactN++;
      A.contact.set(A.lastContactN, tickAutoContactNow());
    }
    for (const n of A.contact.keys()) if (n < known - 8) A.contact.delete(n);
    // Replies up to T+300 belong to tick n; after that they count for n+1.
    const done = Math.min(known, Math.floor((t - 330 - E.origin) / TICK_MS));
    if (A.lastRaceN == null || done - A.lastRaceN > 4) A.lastRaceN = done - 1;
    while (A.lastRaceN < done) {
      A.lastRaceN++;
      tickAutoClassify(A.lastRaceN);
    }
    A.replies = A.replies.filter((r) => r.n > done - 4);
    A.rivalHits = A.rivalHits.filter((r) => r.n > done - 4);
    tickAutoCooldown(t);
    tickAutoSave(t);
  }

  // In the Ring the deciding 211 ends the round (160/126 a few ms later): judge
  // the ticks still waiting before the reset wipes their contacts and replies,
  // or lost races would never teach the aim anything.
  function tickAutoFlush() {
    const E = state.tickEngine;
    const A = E.auto;
    if (!tickEnabled() || E.origin == null || A.lastRaceN == null || E.lastBatchTick == null) return;
    const last = E.lastBatchTick;
    if (A.lastContactN != null && A.lastContactN < last && last - A.lastContactN <= 4) {
      while (A.lastContactN < last) {
        A.lastContactN++;
        A.contact.set(A.lastContactN, tickAutoContactNow());
      }
    }
    while (A.lastRaceN < Math.min(last, A.lastContactN ?? last)) {
      A.lastRaceN++;
      tickAutoClassify(A.lastRaceN);
    }
  }

  function tickAutoSummary() {
    const A = state.tickEngine.auto;
    const st = state.tickEngine.stats;
    const eff = tickEffective();
    const recent = A.races.slice(-20);
    const rival = A.rival.slice().sort((a, b) => a - b);
    return {
      enabled: Boolean(state.timing.tick.auto),
      aimMs: eff.offset,
      burst: eff.burst,
      burstGapMs: eff.gap,
      spacingMs: eff.spacing,
      boundaryMs: Math.round(A.B),
      samples: A.samples.length,
      marginMs: Math.round(A.margin),
      sigmaMs: Math.round(A.sigma),
      corrMs: Math.round(state.tickEngine.corr),
      calibrated: st.calibrated,
      calSkippedLate: st.calSkippedLate,
      calSkippedAmbiguous: st.calSkippedAmbiguous,
      hitsUnmatched: st.hitsUnmatched,
      cooldown: A.cooldown,
      races: A.wins + A.rescued + A.early + A.late,
      wins: A.wins + A.rescued,
      rescued: A.rescued,
      early: A.early,
      late: A.late,
      recentWinRate: recent.length
        ? Math.round((100 * recent.filter((r) => r.outcome === "win" || r.outcome === "rescued").length) / recent.length)
        : null,
      rivalMedianMs: rival.length ? rival[rival.length >> 1] : null,
      lastOutcome: A.lastOutcome
    };
  }

  // ---- EXIT: burst at the end of our coco -------------------------------------
  // 184/120 [accountId, type, type] starts a coco effect on that account and
  // [accountId, 0, 0] ends it (type 35: exactly 7000 ms in the July recordings).
  // While it lasts the server ignores every upper of that player (123 requests,
  // 0 replies) but it can still walk; right after it ends, requests are
  // processed again (E+5..E+21 seen) and the fastest rivals land at E+74..176.
  // At our own coco end we fire a dense burst whose first request lands at the
  // learned unlock phase U (server side, relative to E): the first one after U
  // is processed. Frames: every time is a local arrival time (server time +
  // downlink), like the TICK grid, so a shot sent at E_local + phase - RTT -
  // corr lands at E + phase. Engine shots that would land inside the coco are
  // held back: they are ignored anyway and may cost the server cooldown.
  const EXIT_KEY = "bbhub.exit.v2";
  const EXIT_DEFAULT_COCO_MS = 7000;

  function exitInit() {
    return {
      enabled: true,
      punch: true,
      guard: guardInit(),
      loaded: false,
      U: 0,
      samples: [],
      durByType: {},
      cocoByAccount: new Map(), // accountId -> { type, start, endAt }
      self: null, // { type, start, endAt, id }
      plan: null, // { endAt, shots, target, armed, replies, done }
      exits: 0,
      wins: 0,
      lost: 0,
      processed: 0,
      silent: 0,
      noTarget: 0,
      lastPhase: null,
      lastOutcome: "",
      dirty: false,
      savedAt: 0
    };
  }

  function exitLoad() {
    const X = state.exitMode;
    if (X.loaded) return;
    X.loaded = true;
    try {
      const raw = window.localStorage?.getItem(EXIT_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      X.U = tickAutoNum(saved.U, -60, 120, 0);
      if (Array.isArray(saved.samples)) {
        X.samples = saved.samples
          .filter((s) => tickSampleOk(Number(s?.p)))
          .slice(-40)
          .map((s) => ({ p: Number(s.p), after: Boolean(s.after) }));
      }
      if (saved.durByType && typeof saved.durByType === "object") {
        for (const [type, ms] of Object.entries(saved.durByType)) {
          const v = tickAutoNum(ms, 1000, 30000, null);
          if (v != null) X.durByType[type] = v;
        }
      }
    } catch {}
  }

  function exitSave(t, force = false) {
    const X = state.exitMode;
    if (!force && (!X.dirty || t - X.savedAt < 15000)) return;
    X.savedAt = t;
    X.dirty = false;
    try {
      window.localStorage?.setItem(EXIT_KEY, JSON.stringify({
        v: 1,
        U: Math.round(X.U),
        samples: X.samples.map((s) => ({ p: Math.round(s.p), after: s.after })),
        durByType: X.durByType
      }));
    } catch {}
  }

  function selfAccountId() {
    const renderer = sceneRenderer();
    const avatar = renderer?.avatars?.get?.(inferSelfId());
    const id = Number(avatar?.avatarInfo?.id);
    return Number.isFinite(id) ? id : null;
  }

  function exitCocoRemaining(accountId, t) {
    const c = state.exitMode.cocoByAccount.get(accountId);
    return c ? Math.max(0, Math.round(c.endAt - t)) : 0;
  }

  function exitCocoMs(type) {
    return state.exitMode.durByType[type] || EXIT_DEFAULT_COCO_MS;
  }

  // Engine shots landing before our coco ends are useless: hold them back.
  function exitBlocksLanding(landingLocal) {
    const self = state.exitMode.self;
    return Boolean(self) && landingLocal < self.endAt + state.exitMode.U - 5;
  }

  function exitBurstShape() {
    const X = state.exitMode;
    const s = state.tickEngine.auto.sigma;
    if (state.timing.tick.single) {
      // One click just after the unlock (processed from E+5 in July), plus a
      // backup after the server gap. 05/10 Ring final: the only exit click
      // landed a hair before the unlock (no 144, no 211), the reaction was held
      // because it landed inside the coco, and the rival waiting at the edge hit
      // at E+230 with nothing of ours in between.
      const lead = -Math.max(6, Math.round(s));
      const first = Math.round(X.U - lead);
      return { shots: [{ phase: first, k: 0, b: 0 }, { phase: first + GUARD_LOCK_MS + 5, k: 1, b: 0 }], lead, gap: 3, count: 1 };
    }
    // Up to 8 requests spread over U - lead .. U + lead (+6 ms of slack).
    const lead = Math.max(4, Math.round(1.5 * s));
    const span = 2 * lead + 6;
    const count = clamp(Math.ceil(span / 3) + 1, 3, 8);
    const gap = Math.max(3, Math.ceil(span / (count - 1)));
    const shots = [];
    for (let b = 0; b < count; b++) shots.push({ phase: Math.round(X.U - lead + b * gap), k: 0, b });
    // Two follow-ups after the server cooldown of the first processed request.
    const follow = 100 + Math.max(4, Math.round(s / 2));
    shots.push({ phase: Math.round(X.U + follow), k: 1, b: 0 });
    shots.push({ phase: Math.round(X.U + 2 * follow), k: 2, b: 0 });
    return { shots, lead, gap, count };
  }

  function exitArm() {
    const X = state.exitMode;
    const self = X.self;
    if (!X.enabled || !self) return;
    const t = now();
    const rtt = rttEstimateMs() + state.tickEngine.corr;
    if (!X.plan || X.plan.endAt !== self.endAt) {
      const shape = exitBurstShape();
      X.plan = { endAt: self.endAt, shots: shape.shots, gap: shape.gap, target: null, sent: [], replies: [], done: false, armed: false };
      X.exits++;
    }
    if (X.plan.armed || X.plan.done) return;
    const fires = [];
    X.plan.shots.forEach((shot, index) => {
      const at = X.plan.endAt + shot.phase - rtt;
      if (at >= t - 2) fires.push({ index, dueAt: at, delayMs: Math.max(0, at - t - SPIN_EARLY_MS) });
    });
    X.plan.armed = true;
    cocoGuardArm(X.plan.endAt, "COCO");
    try {
      ensureTimingWorker().postMessage({
        type: "arm",
        planId: `EXIT:${Math.round(X.plan.endAt)}`,
        targetId: -1,
        stepAt: 0,
        stepMs: 0,
        seq: 0,
        leadMs: 0,
        window: "EXIT",
        fires
      });
    } catch {}
  }

  // The best threat at the landing (threatPick); if nobody can be in contact,
  // the enemy closest to us within 2 tiles.
  function exitPickTarget(landing) {
    // 02/10 (v6_62): same bar as the tick engine's blind click. At 0.2 the exit
    // missed the rival walking in at the unlock and fell back to the closest one:
    // 7 of 19 coco-exit deaths since 01/10 were an exit click at another id, and
    // the tick click (often at the killer) left 3 ms later, inside the 100 ms gap.
    const pick = threatPick(landing, state.timing.tick.single ? TICK_BLIND_MIN_P : 0.2);
    if (pick) return pick.id;
    const selfId = inferSelfId();
    const self = ensureActorFromRenderer(selfId);
    if (!self) return null;
    let best = null;
    for (const rawId of sceneRenderer()?.avatars?.keys?.() || []) {
      const id = asId(rawId);
      if (id == null || id === selfId || state.tickEngine.out.has(id) || isAlly(id) || isStale(id) || rivalLocked(id, landing)) continue;
      const a = ensureActorFromRenderer(id);
      if (!a) continue;
      const dist = Math.max(Math.abs(a.toX - self.toX), Math.abs(a.toY - self.toY));
      if (!best || dist < best.dist) best = { id, dist };
    }
    return best && best.dist <= 2 ? best.id : null;
  }

  function exitOnWorkerFire(msg) {
    const X = state.exitMode;
    const plan = X.plan;
    if (!plan || plan.done || `EXIT:${Math.round(plan.endAt)}` !== String(msg.planId || "")) return;
    const shot = plan.shots[msg.index | 0];
    if (!shot) return;
    if (shot.k > 0 && plan.target != null) {
      // Follow-up: not after our hit (we are in the punch animation), and at
      // whoever is the threat now if the first target left or went down.
      if (plan.replies.some((r) => r.kind === "hit") || state.tickEngine.selfOut) return;
      const E = state.tickEngine;
      const landing = now() + rttEstimateMs() + E.corr;
      const me = ensureActorFromRenderer(inferSelfId());
      const a = ensureActorFromRenderer(plan.target);
      const stillThere = me && a && !E.out.has(plan.target) && !rivalLocked(plan.target, landing) && lateralAdjacent(me.toX, me.toY, a.toX, a.toY);
      if (!stillThere) {
        const again = exitPickTarget(landing);
        if (again == null) return;
        plan.target = again;
      }
    }
    if (plan.target == null) {
      // Judged when our coco ends: a rival stunned with us wakes up with us.
      plan.target = exitPickTarget(Math.max(plan.endAt + shot.phase, plan.endAt + 25));
      if (plan.target == null) {
        plan.done = true;
        X.noTarget++;
        X.lastOutcome = "sin_contacto";
        return;
      }
    }
    spinUntil(Number(msg.dueAt));
    if (state.timing.tick.single) {
      const me = ensureActorFromRenderer(inferSelfId());
      const a = ensureActorFromRenderer(plan.target);
      if (me && a) faceBeforeClick(faceSide(me.toX, me.toY, a.toX, a.toY));
    }
    const ok = firePunch(plan.target, "EXIT", { bypassThrottle: true });
    plan.sent.push({ phase: shot.phase, ok, at: now() });
    sendDiagnostic("exit_fire", { endAt: plan.endAt, phase: shot.phase, k: shot.k, b: shot.b, targetId: plan.target, ok, U: X.U });
  }

  // 184/120 [accountId, type, type]: coco on (type > 0) or off (type 0).
  function exitNoteCoco(t, fields) {
    const X = state.exitMode;
    const acc = Number(fields?.[0]);
    const type = Number(fields?.[1]);
    if (!Number.isFinite(acc) || !Number.isFinite(type)) return;
    const self = acc === selfAccountId();
    if (type > 0) {
      const endAt = t + exitCocoMs(type);
      cocoThrowConfirmed(acc, t);
      X.cocoByAccount.set(acc, { type, start: t, endAt });
      if (self) {
        X.self = { type, start: t, endAt };
        X.plan = null;
        exitArm();
      } else {
        const id = accountToId(acc);
        if (id != null) runlockArm(id, endAt + 20);
      }
      return;
    }
    const was = X.cocoByAccount.get(acc);
    X.cocoByAccount.delete(acc);
    if (was && t - was.start > 1000) {
      const prev = X.durByType[was.type] || EXIT_DEFAULT_COCO_MS;
      X.durByType[was.type] = Math.round(0.7 * prev + 0.3 * (t - was.start));
      X.dirty = true;
    }
    if (self && X.self) {
      // The real end is here: if it drifted, fire from this reference.
      if (X.plan && !X.plan.done && Math.abs(t - X.plan.endAt) > 25) {
        X.self.endAt = t;
        X.plan.endAt = t;
        X.plan.noLearn = true;
        X.plan.armed = false;
        exitArm();
      }
      X.self = null;
    }
  }

  // A reply after our coco ended: processing phase relative to E.
  function exitNoteReply(t, kind, targetId) {
    const X = state.exitMode;
    const plan = X.plan;
    if (!plan || plan.done || !plan.sent.length) return;
    const p = t - plan.endAt;
    if (p < -60 || p > 700) return;
    plan.replies.push({ p, kind, targetId });
  }

  function exitNoteHitOnUs(t) {
    const X = state.exitMode;
    const plan = X.plan;
    if (!plan || plan.done) return;
    const p = t - plan.endAt;
    if (p >= -60 && p <= 700) plan.rivalP = plan.rivalP == null ? p : Math.min(plan.rivalP, p);
  }

  // Once the burst's replies are all in: learn U and score the exit.
  function exitPump() {
    const X = state.exitMode;
    const plan = X.plan;
    const t = now();
    if (X.self && t > X.self.endAt + 3000) X.self = null; // end packet lost
    if (!plan || plan.done || t < plan.endAt + 750) {
      exitSave(t);
      return;
    }
    plan.done = true;
    const burst = plan.sent.filter((s) => s.ok && s.phase < X.U + 90);
    // The single-mode backup lands at U+111: its replies say nothing about U.
    // A reject answers on landing (< U+90); a hit of the first click comes after
    // its hold (50-160 ms), a hit of the backup not before U+160.
    const first = plan.replies
      .filter((r) => (r.kind === "reject" ? r.p < X.U + 90 : r.p < X.U + 160))
      .sort((a, b) => a.p - b.p)[0] || null;
    if (!plan.sent.length) return;
    if (first) X.processed++;
    else X.silent++;
    if (first) X.lastPhase = Math.round(first.p);
    if (plan.noLearn) {
      // Shots were aimed at a predicted end that was off: score only.
    } else if (first) {
      // Requests that landed clearly before the first processed one were
      // ignored: they were before the unlock.
      const margin = Math.max(3, plan.gap / 2);
      for (const s of burst) if (s.phase < first.p - margin) X.samples.push({ p: s.phase, after: false });
      X.samples.push({ p: first.p, after: true });
    } else {
      for (const s of burst) X.samples.push({ p: s.phase, after: false });
    }
    while (X.samples.length > 40) X.samples.shift();
    X.U = tickAutoFitBoundary(X.samples, 0);
    const hit = plan.replies.filter((r) => r.kind === "hit").sort((a, b) => a.p - b.p)[0];
    if (hit && (plan.rivalP == null || hit.p < plan.rivalP)) {
      X.wins++;
      X.lastOutcome = "ganada";
    } else if (plan.rivalP != null) {
      X.lost++;
      X.lastOutcome = "perdida";
    } else {
      X.lastOutcome = first ? "procesada" : "silencio";
    }
    X.dirty = true;
    sendDiagnostic("exit_result", {
      endAt: plan.endAt, first: first ? first.p : null, rivalP: plan.rivalP ?? null, U: X.U, outcome: X.lastOutcome
    });
    exitSave(t);
  }

  function exitSummary() {
    const X = state.exitMode;
    const t = now();
    const shape = exitBurstShape();
    return {
      enabled: X.enabled,
      cocoActive: Boolean(X.self),
      cocoRemainingMs: X.self ? Math.max(0, Math.round(X.self.endAt - t)) : 0,
      unlockMs: Math.round(X.U),
      samples: X.samples.length,
      burst: shape.count,
      burstGapMs: shape.gap,
      startMs: Math.round(X.U - shape.lead),
      exits: X.exits,
      wins: X.wins,
      lost: X.lost,
      processed: X.processed,
      silent: X.silent,
      noTarget: X.noTarget,
      lastPhaseMs: X.lastPhase,
      lastOutcome: X.lastOutcome,
      cocoMs: exitCocoMs(35),
      punch: X.punch,
      guardFired: X.guard.fired,
      guardHits: X.guard.hits,
      guardSkipped: X.guard.skipped
    };
  }

  // ---- GUARD: punch exit ----------------------------------------------------
  // The server takes our next upper 100 ms after the previous processed one
  // (July recordings: none earlier, most at 100-130 ms), whatever the punch
  // animation shows. After every request we send, two shots are armed to land
  // right after that lock (+3 and +9 ms): they go out only if an enemy is, or
  // will be at the landing, in lateral contact, and they go to that enemy. The
  // classic 2-vs-1 trick (one leaves at the last tick, the other walks in
  // while we are "punching") meets a hit at the first instant we can land one.
  const GUARD_LOCK_MS = 100;
  const GUARD_OFFSETS = [3, 9];

  function guardInit() {
    return { firing: -1, armedFrom: 0, fired: 0, hits: 0, skipped: 0, streak: 0, lastAt: 0, lastTarget: -1, lastScore: 0 };
  }

  function guardArm(sentAt, reason) {
    const X = state.exitMode;
    if (!X.enabled || !X.punch) return;
    // The first guard shot does not re-arm: its twin must still go out.
    if (reason === "GUARD" && X.guard.firing === 0) return;
    X.guard.armedFrom = sentAt;
    const fires = GUARD_OFFSETS.map((off, index) => {
      const at = sentAt + GUARD_LOCK_MS + off;
      return { index, dueAt: at, delayMs: Math.max(0, at - now()) };
    });
    try {
      ensureTimingWorker().postMessage({
        type: "arm", planId: "GUARD", targetId: -1, stepAt: 0, stepMs: 0, seq: 0, leadMs: 0, window: "GUARD", fires
      });
    } catch {}
  }

  function guardOnWorkerFire(msg) {
    const X = state.exitMode;
    if (!X.enabled || !X.punch) return;
    const index = msg.index | 0;
    const landing = now() + rttEstimateMs() + state.tickEngine.corr;
    const pick = threatPick(landing, 0.2);
    if (!pick) {
      X.guard.skipped++;
      X.guard.streak = 0;
      return;
    }
    // Four guard shots in a row without a hit: the server does not see that
    // contact; rest 300 ms instead of spamming.
    if (X.guard.streak >= 4 && now() - X.guard.lastAt < 300) {
      X.guard.skipped++;
      return;
    }
    X.guard.firing = index;
    let ok = false;
    try {
      ok = firePunch(pick.id, "GUARD", { bypassThrottle: true });
    } finally {
      X.guard.firing = -1;
    }
    if (ok) {
      X.guard.fired++;
      X.guard.streak++;
      X.guard.lastAt = now();
      X.guard.lastTarget = pick.id;
      X.guard.lastScore = pick.score;
    }
    sendDiagnostic("guard_fire", { index, targetId: pick.id, score: pick.score, ok });
  }

  // Our 211 shortly after a guard shot: count it for the guard.
  function guardNoteHit(t) {
    const g = state.exitMode.guard;
    if (g.lastAt && t - g.lastAt < rttEstimateMs() + 150) g.hits++;
    g.streak = 0;
  }

  // ---- Cooldown probe (lab, console/CDP only) --------------------------------
  // Measures the server's upper cooldown on HTML5: official upperRequest with the
  // local 100 ms throttle reset, aimed only at players NOT in contact with us,
  // so every processed request comes back as a harmless 144 and a request the
  // server drops on cooldown comes back as nothing.
  //   same:   3 requests to one target, gapMs apart  -> 3 replies = no cooldown
  //   split:  target A then B, gapMs apart           -> 2 replies = per target
  //   control: 2 requests to one target, 150 ms apart -> expect 2
  function labProbeTargets() {
    const selfId = inferSelfId();
    const self = ensureActorFromRenderer(selfId);
    if (!self) return [];
    const renderer = sceneRenderer();
    const out = [];
    for (const rawId of renderer?.avatars?.keys?.() || []) {
      const id = asId(rawId);
      if (id == null || id === selfId) continue;
      const a = ensureActorFromRenderer(id);
      if (!a) continue;
      // Two tiles of margin: nobody can step into contact during a trial.
      const dist = Math.max(Math.abs(a.toX - self.toX), Math.abs(a.toY - self.toY));
      if (dist >= 3) out.push({ id, dist });
    }
    return out.sort((a, b) => a.dist - b.dist).map((o) => o.id);
  }

  async function labCooldownProbe(options = {}) {
    if (state.lab.running) return { error: "busy" };
    const upper = providerInstance(state.providers.upper);
    if (!upper || typeof upper.upperRequest !== "function") return { error: "no_upper" };
    const gapMs = Math.max(5, Math.min(90, Number(options.gapMs) || 30));
    const rounds = Math.max(1, Math.min(10, Number(options.rounds) || 5));
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const send = (id) => {
      upper.lastUpperAt = -1e9; // local throttle only; the server decides
      const before = state.outboundUpperSeq;
      upper.upperRequest(id);
      return state.outboundUpperSeq > before;
    };
    state.lab.running = true;
    const results = { gapMs, rounds, same: [], split: [], control: [], aborted: "" };
    try {
      for (let r = 0; r < rounds; r++) {
        for (const kind of ["same", "split", "control"]) {
          const targets = labProbeTargets();
          if (targets.length < (kind === "split" ? 2 : 1)) {
            results.aborted = "need_targets_3_tiles_away";
            return results;
          }
          const plan =
            kind === "same" ? [[0, targets[0]], [gapMs, targets[0]], [2 * gapMs, targets[0]]] :
            kind === "split" ? [[0, targets[0]], [gapMs, targets[1]]] :
            [[0, targets[0]], [150, targets[0]]];
          state.lab.replies = [];
          const start = now();
          let sent = 0;
          for (const [at, id] of plan) {
            const wait = start + at - now();
            if (wait > 0) await sleep(wait);
            if (send(id)) sent++;
          }
          await sleep(1200);
          const replies = state.lab.replies.filter((x) => x.t >= start);
          results[kind].push({ sent, replies: replies.length, hits: replies.filter((x) => x.id === 211).length });
          sendDiagnostic("lab_cooldown", { kind, gapMs, sent, replies: replies.length });
          await sleep(400);
        }
      }
      return results;
    } finally {
      state.lab.running = false;
      state.lab.replies = [];
      results.summary = Object.fromEntries(["same", "split", "control"].map((k) => [
        k,
        `${results[k].reduce((s, x) => s + x.replies, 0)}/${results[k].reduce((s, x) => s + x.sent, 0)} respuestas/enviados`
      ]));
    }
  }

  // ---- Structure probe (30/09) -------------------------------------------------
  // Reverse the server's 211 parser by firing STRUCTURAL variants of the upper at
  // players NOT in contact with us (3+ tiles away), exactly like labCooldownProbe:
  // every accepted request comes back as a harmless 144, a rejected/dropped one
  // is silent, and nobody is actually punched. This never runs by itself; it is
  // driven from harness/run_struct_probe.js and does not touch real fights.
  //
  // The money hypothesis: the wire packet has no length prefix (177 id .. 176),
  // so the server may parse SEVERAL 211 frames glued into one WSS message in a
  // single pass, before the 100 ms gap updates. If `glued2` gets 2 replies while
  // `base` gets 1, that is a candidate to land two held punches from one gap.
  // Variants:
  //   base        one 211[id]                         -> expect 1 reply (sanity)
  //   glued2      two 211[id] frames in ONE message   -> 2 replies = multi-parse
  //   glued3      three 211[id] frames in ONE message
  //   twomsg      two 211[id] as two messages, 0 ms   -> control for glued2
  //   extra_param 211[id, "1"]                         -> 144 = lax parse, silent = strict
  //   type1       new P(211, 1)[id]                    -> routed elsewhere?
  //   two_ids     211[idA, idB] one frame (2 targets)  -> does one frame carry two?
  function structFrameString(P, id, { type = 0, sub = 0, params } = {}) {
    const pk = type > 0 ? (sub > 0 ? new P(211, type, sub) : new P(211, type)) : new P(211);
    const list = params || [id];
    for (const p of list) pk.appendParameter(p);
    return pk.toString();
  }

  async function labStructProbe(options = {}) {
    if (state.lab.running) return { error: "busy" };
    const P = state.providers.packet?.exported;
    const socket = providerInstance(state.providers.socket);
    if (!P || !socket || typeof socket.sendServerMessage !== "function") return { error: "no_socket" };
    const rounds = Math.max(1, Math.min(20, Number(options.rounds) || 6));
    const gapMs = Math.max(160, Math.min(600, Number(options.gapMs) || 220)); // > server gap, so no cooldown bleed
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const sendRaw = (str) => socket.sendServerMessage({ id: 211, toString: () => str });
    const variants = ["base", "glued2", "glued3", "twomsg", "extra_param", "type1", "two_ids"];
    // clean trials only (not locked, not in real contact) feed the verdict; the
    // rest are kept apart so a session where the user is being hunted still
    // produces a readable table. per = raw per-trial reply counts.
    const acc = Object.fromEntries(variants.map((v) => [v, { trials: 0, clean: 0, sent: 0, r144: 0, r211: 0, cleanR144: 0, cleanR211: 0, max1msg: 0, per: [] }]));
    state.lab.running = true;
    let aborted = "";
    const selfId0 = inferSelfId();
    const nearContact = () => {
      const me = ensureActorFromRenderer(selfId0);
      if (!me) return true;
      for (const rawId of sceneRenderer()?.avatars?.keys?.() || []) {
        const id = asId(rawId);
        if (id == null || id === selfId0) continue;
        const a = ensureActorFromRenderer(id);
        if (a && Math.max(Math.abs(a.toX - me.toX), Math.abs(a.toY - me.toY)) <= 1) return true;
      }
      return false;
    };
    try {
      for (let r = 0; r < rounds; r++) {
        for (const v of variants) {
          const targets = labProbeTargets();
          if (targets.length < (v === "two_ids" ? 2 : 1)) { aborted = "need_targets_3_tiles_away"; continue; }
          const id = targets[0], id2 = targets[1] ?? targets[0];
          const one = structFrameString(P, id);
          let sends; // each element is one WSS message (a string)
          if (v === "base") sends = [one];
          else if (v === "glued2") sends = [one + one];
          else if (v === "glued3") sends = [one + one + one];
          else if (v === "twomsg") sends = [one, one];
          else if (v === "extra_param") sends = [structFrameString(P, id, { params: [id, "1"] })];
          else if (v === "type1") sends = [structFrameString(P, id, { type: 1 })];
          else if (v === "two_ids") sends = [structFrameString(P, id, { params: [id, id2] })];
          const dirty = state.tickEngine.selfOut || selfLocked(now()) || nearContact();
          state.lab.replies = [];
          const start = now();
          for (const s of sends) { try { sendRaw(s); } catch {} }
          await sleep(900);
          const replies = state.lab.replies.filter((x) => x.t >= start);
          const r144 = replies.filter((x) => x.id === 144).length;
          const r211 = replies.filter((x) => x.id === 211).length;
          const a = acc[v];
          a.trials++;
          a.sent += sends.length;
          a.r144 += r144;
          a.r211 += r211;
          if (!dirty) { a.clean++; a.cleanR144 += r144; a.cleanR211 += r211; a.max1msg = Math.max(a.max1msg, Math.round((r144 + r211) / sends.length)); }
          a.per.push({ d: dirty ? 1 : 0, s: sends.length, r144, r211 });
          sendDiagnostic("lab_struct", { variant: v, targetId: id, dirty: dirty ? 1 : 0, sends: sends.length, r144, r211 });
          await sleep(gapMs);
        }
      }
      return { rounds, gapMs, aborted, variants: acc };
    } finally {
      state.lab.running = false;
      state.lab.replies = [];
    }
  }

  function tickHubSummary() {
    const E = state.tickEngine;
    return {
      lastTargetId: state.lastAutomaticPunch?.targetId ?? -1,
      lastTargetReason: state.lastAutomaticPunch?.reason || "",
      enabled: tickEnabled(),
      synced: E.origin != null && E.batches.length >= 1,
      coherence: Number(E.coherence.toFixed(2)),
      fired: E.stats.fired,
      replies: E.stats.replies,
      hits: E.stats.hits,
      lastSkip: E.stats.lastSkip,
      reactFired: state.react.fired,
      auto: tickAutoSummary()
    };
  }

  function tickStatus() {
    const E = state.tickEngine;
    const errs = E.errs.slice().sort((a, b) => a - b);
    // Replies per burst: ~1 = the server keeps a global cooldown (only the
    // first request counts); ~sent = no server cooldown.
    const t = now();
    const done = E.bursts.filter((b) => t - b.at > 1500 && b.sent > 0).slice(-20);
    const avg = (key) => (done.length ? Number((done.reduce((s, b) => s + b[key], 0) / done.length).toFixed(2)) : null);
    return {
      bursts: done.length,
      burstSentAvg: avg("sent"),
      burstRepliesAvg: avg("replies"),
      burstHits: done.reduce((s, b) => s + b.hits, 0),
      enabled: tickEnabled(),
      origin: E.origin == null ? null : Math.round(E.origin),
      coherence: Number(E.coherence.toFixed(3)),
      batches: E.batches.length,
      corrMs: Math.round(E.corr),
      lastErrMs: E.lastErr,
      medianErrMs: errs.length ? errs[Math.floor(errs.length / 2)] : null,
      gridResets: E.gridResets,
      lastReset: E.lastReset,
      eliminated: [...E.out],
      selfOut: E.selfOut,
      muted: [...E.mutedUntil].filter(([, u]) => u > now()).map(([id]) => id),
      lockMs: Math.max(0, Math.round(E.selfLockEnd - now() - rttEstimateMs() - E.corr)),
      unlock: { ...E.unlock },
      runlock: { ...E.runlockStats, pending: E.runlock.size },
      stepWalk: { enabled: state.stepWalk.enabled, goal: state.stepWalk.goal, walks: state.stepWalk.walks, steps: state.stepWalk.steps, gaveUp: state.stepWalk.gaveUp },
      rbGate: { received: state.rbGate.received, sent: state.rbGate.sent, replaced: state.rbGate.replaced, repeats: state.rbGate.repeats },
      sweep: { ...E.sweepStats },
      auto: tickAutoSummary(),
      ...E.stats
    };
  }

  function onMoveStep(movedId, x, y, stepMs, orient, direction, contFlag) {
    const actor = noteActorStep(movedId, x, y, stepMs, orient);
    if (!actor) return;
    const dur = actor.stepMs > 0 ? actor.stepMs : 600;
    const selfId = inferSelfId();
    const sel = selectedId();

    if (direction === "out" && movedId === selfId) {
      moveDelaySchedule(actor.startAt, dur);
    } else if (state.moveDelay.enabled && movedId === selfId) {
      moveDelaySchedule(actor.startAt, dur);
    }

    if (timingModeActive() && timingSourceMode() === "STATE") {
      if (movedId === sel || (movedId !== selfId && sel >= 0)) {
        scheduleStatePunch(movedId, direction === "out" ? "out_move" : "in_move");
      }
    }

    if (timingModeActive() && timingSourceMode() === "GRID") {
      if (sel >= 0 && (movedId === selfId || movedId === sel)) {
        gridTrySchedule(sel, `move=${movedId}`);
      }
    }

    if (timingModeActive() && timingSourceMode() === "STEP" && !state.timing.tick?.enabled) {
      if (state.timing.landing?.enabled) {
        landingTrySchedule(movedId, actor, contFlag, direction);
      } else {
        const anchor = String(state.timing.stepAnchor || "SELF").toUpperCase();
        const isSelf = movedId === selfId;
        const isTarget = sel >= 0 && movedId === sel;
        let shouldArm = false;
        let targetId = sel;
        if (anchor === "SELF" && isSelf) {
          shouldArm = sel >= 0;
          targetId = sel;
        } else if (anchor === "TARGET" && isTarget) {
          shouldArm = true;
          targetId = sel;
        } else if (anchor === "BOTH" && (isSelf || isTarget)) {
          shouldArm = sel >= 0;
          targetId = sel;
        }
        if (shouldArm && targetId >= 0) {
          scheduleStepWindow(
            targetId,
            dur,
            `${movedId}:${x},${y}:${actor.startAt}`,
            direction
          );
        }
      }
    }

    if (contactEdgeActive() && (movedId === selfId || movedId === sel)) {
      syncPump();
      contactEdgePump();
    }
  }

  // Early inbound stamps (01/10): the client queues worker frames and drains
  // them on requestAnimationFrame - the full tap sees each frame up to ~16 ms
  // after the socket worker decrypted it (250 ms when the tab is hidden). The
  // grid origin and the reply matcher want the true arrival time; the full
  // state tap stays where it is (renderer consistency). Worker shapes:
  // {type:"received", bytes: ArrayBuffer} / {type:"received-batch", packets}.
  const earlyStamps = new Map(); // opcode -> FIFO of worker-arrival times
  let pendingRoundStartAt = 0;
  function earlyInboundTap(data) {
    if (!data || typeof data !== "object") return;
    let frames = null;
    if (data.type === "received" && data.bytes) frames = [data.bytes];
    else if (data.type === "received-batch" && Array.isArray(data.packets)) frames = data.packets;
    if (!frames) return;
    const t = now();
    let sawStep = false;
    for (const bytes of frames) {
      let pkt = null;
      try { pkt = parsePacket(bytes); } catch {}
      if (!pkt) continue;
      if (pkt.id === 182) { sawStep = true; continue; }
      if (pkt.id === 144 || pkt.id === 211) {
        let q = earlyStamps.get(pkt.id);
        if (!q) { q = []; earlyStamps.set(pkt.id, q); }
        q.push(t);
        if (q.length > 24) q.shift();
      }
    }
    if (sawStep) tickNoteBatch(t);
  }

  function shiftEarlyStamp(id) {
    const q = earlyStamps.get(id);
    if (!q || !q.length) return null;
    const t = q.shift();
    return Number.isFinite(t) ? t : null;
  }

  function hookSocketWorkerEarly(instance, attempt = 0) {
    try {
      const worker = instance && instance.socketWorker;
      if (!worker || worker.__bbEarlyTap) return true;
      const original = worker.onmessage;
      if (typeof original !== "function") return false;
      worker.__bbEarlyTap = true;
      worker.onmessage = function (ev) {
        try { earlyInboundTap(ev && ev.data); } catch {}
        return original.call(this, ev);
      };
      return true;
    } catch {}
    if (attempt < 4) setTimeout(() => hookSocketWorkerEarly(instance, attempt + 1), 2000);
    return false;
  }

  function onPacket(packet, direction) {
    if (!packet) return;
    if (state.rawTap.on) {
      const r = state.rawTap.ring;
      r.push({ t: Math.round(now()), dir: direction, id: packet.id | 0, type: packet.type | 0, sub: packet.subType | 0, fields: Array.isArray(packet.fields) ? packet.fields.slice(0, 12) : [] });
      if (r.length > state.rawTap.max) r.splice(0, r.length - state.rawTap.max);
    }
    if (state.duel.on) duelRecord(packet, direction);
    state.packetBus.lastOpcode = packet.id | 0;
    state.packetBus.lastDir = direction;
    state.packetBus.lastAt = Math.round(now());
    if (direction === "in") state.packetBus.in++;
    else state.packetBus.out++;
    sendPacketEvent(direction, packet);

    if (direction === "out" && packet.id === 149) cocoThrowPending(packet.fields?.[1]); // budget only when its 184 confirms
    if (direction === "out" && packet.id === 211) {
      state.outboundUpperSeq++;
      state.stats.fires++;
      const target = asId(packet.fields?.[0]);
      if (target != null && target >= 0) notePunch(target, state.activeFireReason || "native");
      guardArm(now(), state.activeFireReason || "native");
    }
    // Only capture combat/movement traffic; never auth, tickets or chat.
    if ([182, 211, 144, 215, 184, 135, 149, 160].includes(packet.id)) { // 149: coco request, 160: round (alive, start, winner) (27/09)
      sendDiagnostic("packet", {
        direction,
        stage: direction === "in" ? "before_client_dispatch" : "after_socket_api",
        packet
      });
    }
    if (direction === "in" && ((packet.id === 128 && [120, 123].includes(packet.type)) || packet.id === 160)) {
      sendDiagnostic("room_boundary", { opcode: packet.id, packetType: packet.type, subType: packet.subType });
    }

    // 29/09: the avatars of the room we are leaving; see isStale.
    // (-1 = the load failed, e.g. a full area: we stay where we are.)
    if (direction === "in" && packet.id === 128 && packet.type === 120 && String(packet.fields?.[0]) !== "-1") { staleAvatarsNote(); staleLoadAt = now(); }
    // (v6_40 marked again at the roster 128/121: it also caught a real Ring player
    // created before it, 29/09. Lobby adds that sneak into the Ring: see notRingSlot.)
    // The tick phase is per room and per Ring round (23/09 capture).
    if (direction === "in" && ((packet.id === 128 && packet.type === 120) || (packet.id === 160 && packet.type === 126))) {
      tickResetGrid(packet.id === 128 ? "room" : "gong");
      if (packet.id === 128) {
        state.tickEngine.lockUntil.clear();
        state.tickEngine.runlock.clear();
        state.attention.clear();
        state.actors.clear();
        state.exitMode.self = null;
        state.exitMode.plan = null;
        state.exitMode.cocoByAccount.clear();
      }
    }

    if (direction === "in" && packet.id === 160 && packet.type === 123) autoRingOnStatus(packet.fields);
    // Room leave / pop — stop combat pumps so lobby doesn't keep spinning.
    // 01/10: the round-END gong (160/126 one ms after 160/130 [1,0], before the
    // winner) used to arm a wasted unlock click ~5 s before the real next gong.
    // The start gong is the one followed by 160/130 [N, 300]; the end gong by
    // 160/129. softReset stays for both (state hygiene); roundStartNote waits
    // for the 300 confirmation (or a 250 ms fallback).
    simonOnPacket(packet, direction);
    if (packet.id === 160 && packet.type === 126) {
      softResetCombat("room_126");
      if (direction === "in") {
        pendingRoundStartAt = now();
        setTimeout(() => {
          if (!pendingRoundStartAt) return;
          roundStartNote(pendingRoundStartAt);
          pendingRoundStartAt = 0;
        }, 250);
      }
      return;
    }
    if (packet.id === 160 && packet.type === 125) {
      softResetCombat("room_125");
      return;
    }
    if (packet.id === 160 && packet.type === 130) {
      if (pendingRoundStartAt && String((packet.fields || [])[1] ?? "") === "300") {
        roundStartNote(pendingRoundStartAt);
        pendingRoundStartAt = 0;
      }
      return;
    }
    if (packet.id === 160 && packet.type === 129) {
      pendingRoundStartAt = 0; // end gong: the round is over, not starting
      if (direction === "in") state.landingEliminated = false;
      return;
    }

    if (packet.id === 135 && direction === "in") {
      const f = packet.fields || [];
      const id = asId(f[0]);
      const o = Number(f[3]);
      if (id != null) state.attention.set(id, { turnAt: now(), facing: o >= 1 && o <= 8 ? o : (state.attention.get(id)?.facing || 0) });
    }

    if (packet.id === 182) {
      markActivity();
      const fields = packet.fields || [];
      if (direction === "out") {
        // Own walk request: ["XXYY4", ""] = destination tile.
        const dest = String(fields[0] || "");
        if (/^\d{5}$/.test(dest)) tickNoteWalkRequest(Number(dest.slice(0, 2)), Number(dest.slice(2, 4)), now());
        return;
      }
      tickNoteBatch(now());
      // Walk mode: 1 = user, 2 = pet, 3 = NPC. Pet/NPC ids can collide with users.
      const mode = asId(fields[0]);
      if (mode != null && mode !== 1) return;
      const movedId = asId(fields[1]);
      const x = Number(fields[2]);
      const y = Number(fields[3]);
      const orient = Number(fields[4]);
      const stepMs = Number(fields[5]);
      const contFlag = Number(fields[6]) | 0;
      if (movedId != null) state.tickEngine.cont.set(movedId, contFlag);
      if (movedId != null) noteRoster(movedId);
      if (movedId != null && direction === "in") {
        const prev = ensureActorFromRenderer(movedId);
        const dx = prev ? Math.sign(Number(fields[2]) - prev.toX) : 0;
        const dy = prev ? Math.sign(Number(fields[3]) - prev.toY) : 0;
        const was = state.attention.get(movedId);
        state.attention.set(movedId, { turnAt: was ? was.turnAt : 0, facing: DIR_ORIENT[`${dx},${dy}`] || (was ? was.facing : 0), active: true });
      }
      if (movedId != null && movedId === inferSelfId() && Number.isFinite(x) && Number.isFinite(y)) stepWalkOnSelfStep(x, y);
      if (movedId != null && Number.isFinite(x) && Number.isFinite(y)) {
        const dur = Number.isFinite(stepMs) && stepMs > 0 ? stepMs : 600;
        onMoveStep(movedId, x, y, dur, orient, direction, contFlag);
        reactSchedule();
        reachProbeSchedule();
        cocoSelfOnStep(movedId);
        tickPreflightSchedule();
      }
      return;
    }

    if (packet.id === 184 && packet.type === 120 && direction === "in") {
      exitNoteCoco(now(), packet.fields || []);
      tickPreflightInvalidate();
      return;
    }

    if (packet.id === 211 && direction === "in") {
      const fields = packet.fields || [];
      const attacker = asId(fields[2]);
      const defender = asId(fields[6]);
      if (attacker != null && defender != null) {
        noteRoster(attacker);
        noteRoster(defender);
        sendResolveEvent(attacker, defender);
        landingAdaptOnResolve(attacker);
        const t = shiftEarlyStamp(211) ?? now();
        const selfId = inferSelfId();
        if (state.lab.running && attacker === selfId) state.lab.replies.push({ t, id: 211 });
        state.tickEngine.down.set(defender, t + 2500);
        state.tickEngine.out.add(defender);
        hitLockNote(attacker, t, selfId);
        tickPreflightInvalidate();
        if (defender === selfId) state.tickEngine.selfOut = true;
        tickAutoNoteHit(t, attacker, defender, selfId);
        if (attacker === selfId) silentAnswered();
        if (attacker === selfId) exitNoteReply(t, "hit", defender);
        if (attacker === selfId) guardNoteHit(t);
        if (defender === selfId) exitNoteHitOnUs(t);
        if (attacker === selfId) tickOnServerReply(t, "hit", defender);
        if (defender === selfId) state.tickEngine.pausedUntil = t + 2500;
      }
      return;
    }

    if (packet.id === 144) {
      const t = shiftEarlyStamp(144) ?? now();
      silentAnswered();
      state.stats.rejects++;
      if (state.lab.running) state.lab.replies.push({ t, id: 144 });
      exitNoteReply(t, "reject", -1);
      tickOnServerReply(t, "reject");
      landingAdaptOnReject();
      return;
    }

    // 32 = coco/eliminación [n, accountId] — lock firing if WE got eliminated.
    if (packet.id === 32 && direction === "in") {
      const fields = packet.fields || [];
      const selfId = inferSelfId();
      if (selfId >= 0 && selfId < 8 && asId(fields[1]) === selfId) {
        state.landingEliminated = true;
      }
      return;
    }

    // Round boundary (gong/winner) — clear elimination lock.
    if (packet.id === 160 && (packet.type === 129 || packet.type === 123)) {
      state.landingEliminated = false;
    }

    if (direction === "in") maybeDropFromPacket(packet);
  }

  function parsePacket(bytes) {
    try {
      const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      const raw = new TextDecoder("windows-1252").decode(view);
      if (!raw || raw.charCodeAt(0) !== 177) return null;
      // Headers are raw bytes; CP1252 is only for textual parameters.
      const id = view[1];
      const typeByte = view.length > 3 ? view[3] : 178;
      const type = typeByte === 178 ? 0 : typeByte;
      const subTypeByte = view.length > 5 ? view[5] : 178;
      const subType = type && subTypeByte !== 178 ? subTypeByte : 0;
      const separator = String.fromCharCode(179) + String.fromCharCode(178);
      const fields = raw.split(separator).slice(1, -1).map((field) => {
        const end = field.indexOf(String.fromCharCode(176));
        return end >= 0 ? field.slice(0, end) : field;
      });
      return { id, type, subType, fields };
    } catch {
      return null;
    }
  }

  function coercePacket(packetLike) {
    if (!packetLike) return null;
    // Official builders expose mBody, not fields. Read a copy without calling
    // toByteArray()/finish(), which would mutate the message being sent.
    if (Array.isArray(packetLike.mBody) || ArrayBuffer.isView(packetLike.mBody)) {
      return parsePacket(Uint8Array.from(packetLike.mBody));
    }
    if (typeof packetLike === "object" && Number.isFinite(Number(packetLike.id))) {
      return {
        id: Number(packetLike.id) | 0,
        type: Number(packetLike.type) || 0,
        subType: Number(packetLike.subType) || 0,
        fields: Array.isArray(packetLike.fields)
          ? packetLike.fields.map((f) => String(f))
          : []
      };
    }
    if (packetLike instanceof Uint8Array || ArrayBuffer.isView(packetLike) || Array.isArray(packetLike)) {
      return parsePacket(packetLike);
    }
    return null;
  }

  function safeWrap(owner, methodName, flag, factory) {
    if (!owner || typeof owner[methodName] !== "function") return false;
    if (owner[flag]) return true;
    const original = owner[methodName];
    owner[methodName] = factory(original);
    owner[flag] = true;
    return true;
  }

  function hookSocket(provider) {
    const owner = provider.exported && provider.exported.prototype;
    if (provider.instance) hookSocketWorkerEarly(provider.instance);
    safeWrap(owner, "sendServerMessage", "__bbFlashSendHook", (original) =>
      function hookedSend(packet) {
        try {
          if (stepWalkIntercept(packet)) return undefined;
        } catch {}
        const result = original.apply(this, arguments);
        try {
          onPacket(coercePacket(packet), "out");
        } catch {}
        return result;
      }
    );
    safeWrap(owner, "handleReceivedBytes", "__bbFlashRecvHook", (original) =>
      function hookedRecv(bytes) {
        try {
          onPacket(parsePacket(bytes), "in");
        } catch {}
        return original.apply(this, arguments);
      }
    );
  }

  function hookRenderer(provider) {
    const owner = provider.exported && provider.exported.prototype;
    safeWrap(owner, "moveUser", "__bbFlashMoveUserHook", (original) =>
      function hookedMoveUser(userSpaceId, x, y, orientation, stepMs) {
        try {
          const id = asId(userSpaceId);
          if (id != null && Number.isFinite(Number(x)) && Number.isFinite(Number(y))) {
            const dur = Number(stepMs) > 0 ? Number(stepMs) : 600;
            onMoveStep(id, Number(x), Number(y), dur, Number(orientation) || 0, "in");
          }
        } catch {}
        return original.apply(this, arguments);
      }
    );
  }

  function applyTimingConfig(msg) {
    const t = state.timing;
    if ("enabled" in msg) t.enabled = Boolean(msg.enabled);
    if ("source" in msg) {
      let src = String(msg.source || "STEP").toUpperCase();
      if (src === "ADJ") src = "GRID";
      if (src === "MD" || src === "MOVEDELAY") src = "MOVE_DELAY";
      t.source = src;
    }
    if ("stepAnchor" in msg) t.stepAnchor = String(msg.stepAnchor || "SELF").toUpperCase();
    if ("start" in msg) t.start = clamp(msg.start, 0, STEP_WINDOW_MAX_MS);
    if ("end" in msg) t.end = clamp(msg.end, t.start, STEP_WINDOW_MAX_MS);
    if ("dualWindow" in msg) t.dualWindow = Boolean(msg.dualWindow);
    if ("start2" in msg) t.start2 = clamp(msg.start2, 0, STEP_WINDOW_MAX_MS);
    if ("end2" in msg) t.end2 = clamp(msg.end2, t.start2, STEP_WINDOW_MAX_MS);
    if ("rate" in msg) t.rate = clamp(msg.rate, 0, 500);
    if ("mult" in msg) t.mult = clamp(msg.mult, 1, 50);
    if ("randomInterval" in msg) t.randomInterval = Boolean(msg.randomInterval);
    if ("intervalMin" in msg) t.intervalMin = clamp(msg.intervalMin, 1, 500);
    if ("intervalMax" in msg) t.intervalMax = clamp(msg.intervalMax, t.intervalMin, 500);
    if ("randomMultiplier" in msg || "randomMult" in msg) {
      t.randomMultiplier = Boolean(msg.randomMultiplier ?? msg.randomMult);
    }
    if ("multMin" in msg) t.multMin = clamp(msg.multMin, 1, 50);
    if ("multMax" in msg) t.multMax = clamp(msg.multMax, t.multMin, 50);
    // Same limits as the Hub; a different clamp makes the echoed config mismatch,
    // the Hub re-pushes timing_config and every push clears the armed plans.
    if ("clicks" in msg) t.clicks = clamp(msg.clicks, 0, 100);
    if ("gap" in msg) t.gap = clamp(msg.gap, 0, 1000);
    if ("profile" in msg) t.profile = String(msg.profile || "LINEAR").toUpperCase();
    if ("power" in msg) t.power = Boolean(msg.power);
    if ("stepScale" in msg) t.stepScale = Boolean(msg.stepScale);
    if ("animSync" in msg) t.animSync = Boolean(msg.animSync);
    if ("preFace" in msg) {
      t.preFace = Boolean(msg.preFace);
      state.preFace.enabled = Boolean(msg.preFace);
    }
    if ("fireMetrics" in msg || "diag" in msg) {
      t.fireMetrics = Boolean(msg.fireMetrics ?? msg.diag);
    }
    if ("contactGate" in msg) t.contactGate = Boolean(msg.contactGate);
    if ((!msg.landing || typeof msg.landing !== "object") && "start" in msg) {
      // Packaged Hub builds predate LANDING and never send it: a full STEP
      // config without `landing` means plain window timing.
      t.landing.enabled = false;
    }
    if (msg.landing && typeof msg.landing === "object") {
      const L = t.landing;
      if ("enabled" in msg.landing) L.enabled = Boolean(msg.landing.enabled);
      if ("offsetMs" in msg.landing) L.offsetMs = clamp(msg.landing.offsetMs, 0, 250);
      if ("jitterMs" in msg.landing) L.jitterMs = clamp(msg.landing.jitterMs, 0, 150);
      if ("secondShot" in msg.landing) L.secondShot = Boolean(msg.landing.secondShot);
      if ("secondDelayMs" in msg.landing) L.secondDelayMs = clamp(msg.landing.secondDelayMs, 50, 400);
      if ("adaptive" in msg.landing) L.adaptive = Boolean(msg.landing.adaptive);
      if ("adaptiveStepMs" in msg.landing) L.adaptiveStepMs = clamp(msg.landing.adaptiveStepMs, 1, 50);
    }
    if ((!msg.tick || typeof msg.tick !== "object") && "start" in msg) {
      // Hub builds before TICK never send it: plain STEP windows.
      t.tick.enabled = false;
    }
    if (msg.tick && typeof msg.tick === "object") {
      // Same limits as the Hub (normalizeTickConfig).
      const K = t.tick;
      if ("enabled" in msg.tick) K.enabled = Boolean(msg.tick.enabled);
      if ("offsetMs" in msg.tick) K.offsetMs = clamp(msg.tick.offsetMs, 0, 120);
      if ("shots" in msg.tick) K.shots = clamp(msg.tick.shots, 1, 5);
      if ("spacingMs" in msg.tick) K.spacingMs = clamp(msg.tick.spacingMs, 100, 200);
      if ("blind" in msg.tick) K.blind = Boolean(msg.tick.blind);
      if ("reactive" in msg.tick) K.reactive = Boolean(msg.tick.reactive);
      if ("autoCal" in msg.tick) K.autoCal = Boolean(msg.tick.autoCal);
      if ("auto" in msg.tick) K.auto = Boolean(msg.tick.auto);
      if ("single" in msg.tick) K.single = Boolean(msg.tick.single);
      if ("burst" in msg.tick) K.burst = clamp(msg.tick.burst, 1, 8);
      if ("burstGapMs" in msg.tick) K.burstGapMs = clamp(msg.tick.burstGapMs, 2, 20);
    }
    if ("lead" in msg) state.grid.lead = clamp(msg.lead, 0, 500);
    if ("burst" in msg) state.grid.burst = clamp(msg.burst, 1, 8);
    if ("spacing" in msg) state.grid.spacing = clamp(msg.spacing, 1, 200);
    if ("pingComp" in msg) state.grid.pingComp = Boolean(msg.pingComp);
    if ("pingCompMs" in msg || "pingMs" in msg) {
      state.grid.pingCompMs = clamp(msg.pingCompMs ?? msg.pingMs ?? 0, 0, 500);
    }
    if (t.source === "GRID") state.grid.enabled = t.enabled;
    if (t.source === "STATE") state.stateCfg.enabled = t.enabled;
    if (t.source === "MOVE_DELAY") {
      state.moveDelay.enabled = t.enabled;
    } else if (t.enabled && t.source !== "MOVE_DELAY") {
      // keep moveDelay independent unless pulse/move_punch sets it
    }
    if (t.enabled) {
      state.pulse.enabled = false;
    }
    bumpSeq();
    leadReset();
    syncPump();
    sendConfig();
  }

  function applyStateConfig(msg) {
    if ("enabled" in msg) {
      state.stateCfg.enabled = Boolean(msg.enabled);
      if (state.stateCfg.enabled) {
        state.timing.enabled = true;
        state.timing.source = "STATE";
        state.pulse.enabled = false;
      }
    }
    if ("delay" in msg) state.stateCfg.delay = clamp(msg.delay, 0, 2000);
    bumpSeq();
    sendConfig();
  }

  function applyPulseConfig(msg) {
    if ("enabled" in msg) state.pulse.enabled = Boolean(msg.enabled);
    if ("interval" in msg) state.pulse.interval = clamp(msg.interval, 1, 5000);
    if ("burst" in msg) state.pulse.burst = clamp(msg.burst, 1, 16);
    if ("spacing" in msg) state.pulse.spacing = clamp(msg.spacing, 0, 500);
    if ("gap" in msg) state.pulse.gap = clamp(msg.gap, 0, 500);
    if ("pattern" in msg) state.pulse.pattern = String(msg.pattern || "FLAT").toUpperCase();
    if ("microBursts" in msg) state.pulse.microBursts = clamp(msg.microBursts, 0, 8);
    if ("microGap" in msg || "microGapMs" in msg) {
      state.pulse.microGap = clamp(msg.microGap ?? msg.microGapMs ?? 0, 0, 200);
    }
    if ("jitter" in msg) state.pulse.jitter = clamp(msg.jitter, 0, 100);
    if ("requireSelected" in msg) state.pulse.requireSelected = Boolean(msg.requireSelected);
    if ("multiTarget" in msg) state.pulse.multiTarget = Boolean(msg.multiTarget);
    if ("autoTarget" in msg) state.pulse.autoTarget = Boolean(msg.autoTarget);
    if ("autoRange" in msg) state.pulse.autoRange = clamp(msg.autoRange, 1, 8);
    if ("contactOnly" in msg) state.pulse.contactOnly = Boolean(msg.contactOnly);
    if ("preFace" in msg) {
      state.pulse.preFace = Boolean(msg.preFace);
      state.preFace.enabled = Boolean(msg.preFace);
    }
    if ("moveDelay" in msg) state.moveDelay.enabled = Boolean(msg.moveDelay);
    if ("moveDelayMs" in msg) state.moveDelay.delayMs = clamp(msg.moveDelayMs, 0, 500);
    if (state.pulse.autoTarget) {
      state.pulse.requireSelected = true;
      state.pulse.multiTarget = false;
    }
    if (state.pulse.enabled) {
      state.timing.enabled = false;
      bumpSeq();
      state.pulse.nextAt = now();
    }
    syncPump();
    if (state.pulse.enabled) pulsePump();
    sendConfig();
  }

  function applyResolveLockConfig(msg) {
    if ("observer" in msg) state.resolveLock.observer = Boolean(msg.observer);
    if ("tickPhaseClean" in msg) state.resolveLock.tickPhaseClean = Boolean(msg.tickPhaseClean);
    if ("alpha" in msg) state.resolveLock.alpha = Math.max(0.01, Math.min(1, Number(msg.alpha) || 0.2));
    if ("clientObservedResolveDelaySamples" in msg) {
      const samples = Number(msg.clientObservedResolveDelaySamples) | 0;
      if (samples > state.resolveLock.clientObservedResolveDelaySamples) {
        state.resolveLock.clientObservedResolveDelaySamples = samples;
        state.resolveLock.clientObservedResolveDelayMs = Number(msg.clientObservedResolveDelayMs) || 0;
      }
    }
    if ("enemyObservedResolveDelaySamples" in msg) {
      const samples = Number(msg.enemyObservedResolveDelaySamples) | 0;
      if (samples > state.resolveLock.enemyObservedResolveDelaySamples) {
        state.resolveLock.enemyObservedResolveDelaySamples = samples;
        state.resolveLock.enemyObservedResolveDelayMs = Number(msg.enemyObservedResolveDelayMs) || 0;
      }
    }
    sendConfig();
  }

  function applyDropHunterConfig(msg) {
    if ("enabled" in msg) state.dropHunter.enabled = Boolean(msg.enabled);
    if ("autoReturn" in msg) state.dropHunter.autoReturn = Boolean(msg.autoReturn);
    if ("autoClaim" in msg) state.dropHunter.autoClaim = Boolean(msg.autoClaim);
    if (!state.dropHunter.enabled) {
      state.dropHunter.drop = null;
      state.dropHunter.keyword = "";
      state.dropHunter.state = "IDLE";
      state.dropHunter.dropId = -1;
      state.dropHunter.x = -1;
      state.dropHunter.y = -1;
      dropHunterStopTimer();
      sendDropHunterEvent("off");
    } else {
      sendDropHunterEvent("armed");
    }
    sendConfig();
  }

  function onHubMessage(msg) {
    if (!msg || typeof msg !== "object") return;
    state.stats.hubIn++;
    switch (String(msg.type || "")) {
      case "timing_config":
        applyTimingConfig(msg);
        break;
      case "state_config":
        applyStateConfig(msg);
        break;
      case "pulse_config":
        applyPulseConfig(msg);
        break;
      case "resolve_lock_config":
        applyResolveLockConfig(msg);
        break;
      case "punch_config":
        if ("packets" in msg) state.punchPackets = clamp(msg.packets, 1, 8);
        sendConfig();
        break;
      case "move_punch_config":
        if ("enabled" in msg) state.moveDelay.enabled = Boolean(msg.enabled);
        if ("delayMs" in msg) state.moveDelay.delayMs = clamp(msg.delayMs, 0, 2000);
        if ("minMoveMs" in msg) state.moveDelay.minMoveMs = clamp(msg.minMoveMs, 0, 2000);
        sendConfig();
        break;
      case "drop_hunter_config":
        applyDropHunterConfig(msg);
        break;
      case "performance_config":
        if ("stateMs" in msg) state.performance.stateMs = clamp(msg.stateMs, 50, 3000);
        if ("sceneMs" in msg) state.performance.sceneMs = clamp(msg.sceneMs, 200, 10000);
        if ("configMs" in msg) state.performance.configMs = clamp(msg.configMs, 500, 20000);
        if ("packetBus" in msg) state.packetBus.enabled = Boolean(msg.packetBus);
        sendConfig();
        break;
      case "ally_config":
        allySet(msg);
        sendConfig();
        break;
      case "auto_ring_config":
        state.autoRing.enabled = Boolean(msg.enabled);
        flagSave(AUTO_RING_KEY, state.autoRing.enabled);
        sendConfig();
        break;
      case "ring_slots_config":
        ringSlotsOnly = Boolean(msg.enabled);
        break;
      case "low_ping_config":
        if (["auto", "on", "off"].includes(msg.mode)) state.lowPing.mode = msg.mode;
        sendConfig();
        break;
      case "tick_advanced_config":
        if ("sweep" in msg) state.tickAdv.sweep = Boolean(msg.sweep);
        if ("repeatMs" in msg) state.tickAdv.repeatMs = Number(msg.repeatMs) > 0 ? clamp(Number(msg.repeatMs), 100, 400) : 0;
        sendConfig();
        break;
      case "simon_config":
        if ("enabled" in msg) state.simon.enabled = Boolean(msg.enabled);
        if ("delayMs" in msg) state.simon.delayMs = clamp(Number(msg.delayMs) || 0, 0, 2000);
        break;
      case "free_fire_config":
        // EXPERIMENTAL: disparo libre del tick (ignora el espaciado interno de ~100 ms).
        if ("enabled" in msg) state.freeFire.enabled = Boolean(msg.enabled);
        if ("gapMs" in msg) state.freeFire.gapMs = clamp(Number(msg.gapMs) || 25, 4, 200);
        sendConfig();
        break;
      case "requeue_hotkey_config":
        state.autoRing.hotkey = typeof msg.code === "string" ? msg.code.slice(0, 32) : "";
        if (state.autoRing.hotkey) requeueKeyInstall();
        sendConfig();
        break;
      case "requeue_now":
        requeueNow();
        break;
      case "emote_config":
        if ("enabled" in msg) state.emotes.enabled = Boolean(msg.enabled);
        if ("minMs" in msg) state.emotes.minMs = clamp(Number(msg.minMs) || 0, 5000, 600000);
        if ("maxMs" in msg) state.emotes.maxMs = clamp(Number(msg.maxMs) || 0, state.emotes.minMs, 900000);
        state.emotes.nextAt = 0;
        sendConfig();
        break;
      case "render_off_config":
        state.renderOff.enabled = Boolean(msg.enabled);
        flagSave(RENDER_OFF_KEY, state.renderOff.enabled);
        renderOffApply();
        sendConfig();
        break;
      case "reach_probe_config":
        if ("enabled" in msg) state.reachProbe.enabled = Boolean(msg.enabled);
        break;
      case "coco_guard_config":
        if ("enabled" in msg) state.cocoGuard.enabled = Boolean(msg.enabled);
        if ("leadMs" in msg) state.cocoGuard.leadMs = clamp(Number(msg.leadMs) || 0, 50, 2000);
        if ("max" in msg) state.cocoGuard.max = clamp(Number(msg.max) || 0, 0, 3);
        if ("selfMode" in msg) state.cocoGuard.selfMode = msg.selfMode === "auto" ? "auto" : "off";
        break;
      case "coco_self":
        // Manual self-coco from the Hub (the 3-per-round budget still applies).
        if (state.tickEngine.selfOut || state.cocoGuard.used >= state.cocoGuard.max) {
          sendDiagnostic("coco_self", { why: "manual", used: state.cocoGuard.used, ok: false, whyBlocked: state.tickEngine.selfOut ? "eliminado" : "sin_cocos" });
          break;
        }
        throwSelfCoco("manual");
        break;
      case "coco_self_key_config":
        state.cocoGuard.selfKey = typeof msg.code === "string" ? msg.code.slice(0, 32) : "";
        if (state.cocoGuard.selfKey) cocoSelfKeyInstall();
        sendConfig();
        break;
      case "no_throttle_config":
        state.noThrottle.enabled = Boolean(msg.enabled);
        flagSave(NO_THROTTLE_KEY, state.noThrottle.enabled);
        noThrottleInstall();
        break;
      case "tick_burst_config":
        if (msg.ab) { state.burstAB = true; break; }
        state.burstAB = false;
        state.tickBurst = clamp(Number(msg.count) || 1, 1, TICK_BURST_MAX);
        break;
      case "step_walk_config":
        state.stepWalk.enabled = Boolean(msg.enabled);
        if (!state.stepWalk.enabled) state.stepWalk.goal = null;
        break;
      case "exit_config":
        if ("enabled" in msg) state.exitMode.enabled = Boolean(msg.enabled);
        if ("punch" in msg) state.exitMode.punch = Boolean(msg.punch);
        if (!state.exitMode.enabled) state.exitMode.plan = null;
        else if (state.exitMode.self) exitArm();
        sendState();
        break;
      case "exit_reset":
        state.exitMode.U = 0;
        state.exitMode.samples = [];
        try {
          window.localStorage?.removeItem(EXIT_KEY);
        } catch {}
        sendState();
        break;
      case "hit_lock_config":
        HIT_LOCK_MS = Math.max(0, Math.min(30000, Number(msg.ms) || 0));
        if (!HIT_LOCK_MS) state.tickEngine.selfLockEnd = 0;
        break;
      case "tick_auto_test": // tests only: start the aim from a given margin
        if (Number.isFinite(Number(msg.margin))) state.tickEngine.auto.margin = Number(msg.margin);
        break;
      case "tick_auto_reset":
        tickAutoReset();
        sendState();
        break;
      case "diagnostic_config":
        state.diagnostics.enabled = Boolean(msg.enabled);
        state.diagnostics.lastConfigKey = null;
        sendConfig();
        break;
      case "fire":
      case "raw_punch":
        firePunch(msg.targetId, "CTRL");
        break;
      case "move":
        if ("x" in msg && "y" in msg) {
          state.rbGate.received++;
          if (state.diagnostics.enabled) sendDiagnostic("rb_move", { x: msg.x | 0, y: msg.y | 0, targetId: msg.targetId, reason: String(msg.reason || "") });
          rbGateMove(msg);
        }
        break;
      case "select_target": {
        const id = asId(msg.targetId);
        if (id != null) state.selectedId = id;
        sendState();
        break;
      }
      case "ping":
        sendToHub({ type: "pong", ts: Math.round(now()) });
        break;
      default:
        break;
    }
  }

  // Optional providers (selection, space, ping, map) can be missing at boot
  // because the client creates those singletons after login. Look again
  // until they appear; import() of an already loaded module is cheap.
  const OPTIONAL_PROVIDERS = ["selection", "space", "ping", "map", "nav", "game", "pixi", "action"];
  function refreshOptionalProviders() {
    const missing = OPTIONAL_PROVIDERS.filter(
      (key) => !state.providers[key] || !providerInstance(state.providers[key])
    );
    if (!missing.length || state.providerRefreshBusy) return;
    const t = now();
    if (t - (state.providerRefreshAt || 0) < 2000) return;
    state.providerRefreshAt = t;
    state.providerRefreshBusy = true;
    (async () => {
      let urls = [];
      try {
        urls = findModuleUrls();
      } catch {}
      for (const url of urls) {
        let found;
        try {
          found = findProviders(await import(url));
        } catch {
          continue;
        }
        for (const key of missing) {
          if (found[key] && providerInstance(found[key]) && !providerInstance(state.providers[key])) {
            state.providers[key] = found[key];
          }
        }
      }
    })()
      .catch(() => {})
      .finally(() => {
        state.providerRefreshBusy = false;
      });
  }

  const SILENT_GAP_MS = 130; // server per-player gap (~100 ms) + jitter
  const RING_MUTE_MS = 1800; // 3 ticks: in the Ring nobody is protected for long
  // ---- No local 100 ms guard (30/09) ----------------------------------------------
  // upperRequest: if (now - lastUpperAt < 100) return. With the guard off, lastUpperAt
  // always reads as long ago, so no punch is dropped in the client (the server's own
  // ~100 ms gap after a processed request still applies).
  const NO_THROTTLE_KEY = "bb5.noThrottle";
  function noThrottleInstall() {
    const upper = providerInstance(state.providers.upper);
    if (!upper || typeof upper !== "object" || upper.__bbNoThrottle) return;
    let stored = Number(upper.lastUpperAt) || 0;
    try {
      Object.defineProperty(upper, "lastUpperAt", {
        configurable: true,
        get() { return state.noThrottle.enabled ? -1e9 : stored; },
        set(v) { stored = v; if (state.noThrottle.enabled) state.noThrottle.skipped++; }
      });
      Object.defineProperty(upper, "__bbNoThrottle", { value: true });
      state.noThrottle.installed = true;
    } catch {}
  }

  function silentAnswered() {
    const E = state.tickEngine;
    E.silentLastReplyAt = now();
    const c = E.silentPending.shift();
    if (c) E.silentCount.delete(c.id);
  }

  // Engine clicks with no reply after RTT + 250 ms: three in a row at the same
  // target and it is muted for 8 s (protected, NPC, a room without punches...).
  // Not while we are out: then every click is ignored.
  function refreshSilent() {
    const E = state.tickEngine;
    const t = now();
    const limit = rttEstimateMs() + 250;
    while (E.silentPending.length && t - E.silentPending[0].at > limit) {
      const c = E.silentPending.shift();
      if (E.selfOut || E.out.has(c.id)) continue;
      if (rivalLocked(c.id, c.at - 600) || c.at < E.selfLockEnd + 600) continue; // animation, not a silent target
      const n = (E.silentCount.get(c.id) || 0) + 1;
      E.silentCount.set(c.id, n);
      if (n >= 3) {
        E.mutedUntil.set(c.id, t + (roomKind() === "ring" ? RING_MUTE_MS : 8000));
        E.silentCount.delete(c.id);
        sendDiagnostic("target_muted", { targetId: c.id });
      }
    }
  }

  // After the gong (160/126) the next round starts ROUND_START_MS later, with
  // no packet to mark it: punches landing before are ignored without a reply
  // (25/09-26/09 live: silent up to gong + 4.61 s, answered from 4.67 s; nobody
  // hit before 5.0 s). Rivals wait next to us for it, like after our punch
  // animation: same lock, same one click the moment it ends.
  // 28/09, 26-28/09 captures (landing = send + ping + 5, vs the gong arrival): 0 of
  // 106 punches answered before gong+4990; from gong+5000 almost all (first 144 of
  // anyone at 5008, first 211 at 5048). The 4.66 s edge was wrong: every round
  // start click and its retry were ignored (0 of 149 answered).
  const ROUND_START_MS = 5000;
  // 27/09: with a 5-burst our holds exit early from 0 ms (vs ~50 ms alone on a
  // standing defender): if each request draws its own hold, more requests are more
  // tickets. Engine bursts alternate 5 / 8 by round to measure it on real races.
  const BURST_AB = [5, 8];
  function roundStartNote(t) {
    const E = state.tickEngine;
    state.cocoGuard.used = 0;
    state.cocoGuard.thrown = [];
    state.reachProbe.count = 0;
    if (state.burstAB) {
      state.burstRound = (state.burstRound | 0) + 1;
      state.tickBurst = BURST_AB[state.burstRound % 2];
      sendDiagnostic("burst_ab", { round: state.burstRound, burst: state.tickBurst });
    }
    E.selfLockEnd = Math.max(E.selfLockEnd, t + ROUND_START_MS);
    E.unlock.end = 0; // the gong cleared the armed plans: arm it again
    unlockArm();
  }

  // A 211 locks its attacker for HIT_LOCK_MS from its arrival (the batch
  // frame our landings are calibrated in).
  function hitLockNote(attacker, t, selfId) {
    const E = state.tickEngine;
    if (attacker === selfId) {
      E.selfLockEnd = Math.max(E.selfLockEnd, t + HIT_LOCK_MS);
      unlockArm();
      cocoGuardArm();
    } else {
      E.lockUntil.set(attacker, t + HIT_LOCK_MS);
      runlockArm(attacker, t + HIT_LOCK_MS);
    }
  }

  // Would a click landing at `landing` (local) fall in our punch lock?
  function selfLocked(landing) {
    return landing < state.tickEngine.selfLockEnd;
  }

  // Not hittable at `at`: in its punch animation, or stunned by a coco (184/120;
  // 25/09 live: three clicks at a rival in coco went unanswered, and the hit
  // came as soon as the coco ended).
  function rivalLocked(id, at) {
    const until = state.tickEngine.lockUntil.get(id);
    if (until != null && until > at) return true;
    if ((state.cocoGuard.pending.get(id) || 0) > at) return true; // our coco on its way
    const acc = Number(sceneRenderer()?.avatars?.get?.(id)?.avatarInfo?.id);
    const coco = Number.isFinite(acc) ? state.exitMode.cocoByAccount.get(acc) : null;
    return Boolean(coco) && coco.endAt + 20 > at;
  }

  // One click that lands the moment our lock ends, at the enemy in contact
  // then (a standing neighbour is 98% sure). The TICK engine takes over after.
  // 26/09 v6_12 session (69-47): after our animation, rivals hit us at end+7
  // and end+8 (and won holds from end+59) while our click landed at end+10;
  // every click of ours that landed at end+0..9 was processed (7 of 7). A
  // request inside the lock is ignored silently, so the burst (1 ms apart)
  // starting at end+1 straddles the edge: the first one past it counts.
  // 28/09, 26-28/09 captures (first unlock click, landing vs our lock end):
  // end+0..4: 46 of 54 ignored, fight after it 13-22; end+5..9: 17-10;
  // end+10..19: 9-4. The edge sits past end+4 (jitter of our 211 downlink
  // and of the uplink), so +1 mostly landed inside the lock.
  const UNLOCK_MARGIN_MS = 10;
  // 27/09: our lock edge comes from our 211 arrival (one downlink sample), so it
  // is sometimes later than we think: 18 of 53 unlock clicks drew no reply at
  // all, 10 of them at a target out of contact (a processed request would get a
  // 144). A second click lands UNLOCK_RETRY_MS later: if the first one was
  // processed, the server gap (100 ms) drops it; if the lock ignored the first,
  // it is our valid shot.
  // 29/09 (265 pairs, 26-29/09): the +30 retry was never the one processed. A
  // request ignored by the lock seems to open the server gap too (18 cases, 0
  // against), so +30 always fell inside it. +105 clears the gap of either.
  const UNLOCK_RETRY_MS = 105;
  // 27/09: with nobody next to us at the unlock, the click goes to whoever can
  // step in, at the blind threshold (was 0.2: the one entering at the first tick
  // after our unlock was never clicked, 7-6 in those fights).
  // 28/09: same floor as the blind tick click (a standing rival one step away).
  const UNLOCK_MIN_PROB = 0.0005;
  function unlockArm() {
    const E = state.tickEngine;
    if (!tickEnabled() || E.unlock.end === E.selfLockEnd) return;
    E.unlock.end = E.selfLockEnd;
    const t = now();
    const at = E.selfLockEnd + UNLOCK_MARGIN_MS - rttEstimateMs() - E.corr;
    try {
      ensureTimingWorker().postMessage({
        type: "arm",
        planId: `UNLOCK:${Math.round(E.selfLockEnd)}`,
        targetId: -1,
        stepAt: 0,
        stepMs: 0,
        seq: state.seq,
        leadMs: 0,
        window: "UNLOCK",
        fires: [
          { index: 0, dueAt: at, delayMs: Math.max(0, at - t - SPIN_EARLY_MS) },
          { index: 1, dueAt: at + UNLOCK_RETRY_MS, delayMs: Math.max(0, at + UNLOCK_RETRY_MS - t - SPIN_EARLY_MS) },
          // 01/10 live: both rungs landed inside the true lock edge (frames
          // shift with the one-way) and were silenced; a third rung at +210
          // clears the second one's gap the same way the second clears the first.
          { index: 2, dueAt: at + 2 * UNLOCK_RETRY_MS, delayMs: Math.max(0, at + 2 * UNLOCK_RETRY_MS - t - SPIN_EARLY_MS) }
        ]
      });
    } catch {}
  }

  function unlockOnWorkerFire(msg) {
    const E = state.tickEngine;
    if (`UNLOCK:${Math.round(E.unlock.end)}` !== String(msg.planId || "") || E.unlock.end !== E.selfLockEnd) return;
    if (!tickEnabled() || E.selfOut || msg.seq !== state.seq) return;
    const step = msg.index | 0;
    const retry = step > 0;
    const landing = E.selfLockEnd + UNLOCK_MARGIN_MS + step * UNLOCK_RETRY_MS;
    if (exitBlocksLanding(landing)) return;
    // Whoever stands next to us now waited through our animation to ambush us
    // (25/09 live: #0 stepped next to us 0.7 s before our unlock and hit at
    // unlock + 0.47 s; the July model gave it 6% because rivals who just step
    // in usually leave). They go first; the model only when nobody is there.
    const pick = unlockAmbusher(landing) || threatPick(landing, UNLOCK_MIN_PROB);
    if (!pick) {
      E.unlock.noTarget++;
      sendDiagnostic("unlock_fire", { targetId: -1, lockEnd: Math.round(E.selfLockEnd), retry });
      return;
    }
    // Armed with the ping of 14 s ago: aim with the current one.
    spinUntil(Math.max(Number(msg.dueAt), landing - rttEstimateMs() - E.corr));
    if (state.timing.tick.single) faceBeforeClick(pick.face);
    // 27/09: one request, not the 5-burst. Unlock clicks sent alone: 8% silent,
    // won 8-1 (n=12); as a burst: 29% silent, won 16-20 (n=56). A burst at the
    // lock edge seems to lose itself (and the retry) when its first request lands
    // a hair early; normal engine bursts are fine (10% silent).
    if (firePunch(pick.id, "UNLOCK", { bypassThrottle: true, packets: 1 })) {
      E.unlock.fired++;
      E.unlock.lastTarget = pick.id;
    }
    sendDiagnostic("unlock_fire", { targetId: pick.id, score: pick.score, lockEnd: Math.round(E.selfLockEnd), lateMs: Math.round(now() - Number(msg.dueAt)), retry });
  }

  // ---- Coco guard (27/09) ------------------------------------------------------
  // Leaving our upper animation next to a rival that waited for it is a coin flip
  // (live: 48-57% in every version of the unlock click) because both punches are
  // held by the server. A coco is not held and can be thrown during our animation
  // (user 27/09: 3 per ring; not at a rival in its upper or already in coco): it
  // lands leadMs before our lock ends, so that rival can not punch for ~7 s and
  // the unlock click skips it (rivalLocked sees its coco). Ring only: in islands
  // a coco costs coins.
  // kind UPPER: the end of our upper animation; COCO: the end of our own coco
  // (user 27/09: they also wait next to us for it).
  function cocoGuardArm(end = state.tickEngine.selfLockEnd, kind = "UPPER") {
    const E = state.tickEngine;
    const G = state.cocoGuard;
    if (!G.enabled || !tickEnabled() || !end) return;
    const landing = end - G.leadMs;
    const at = landing - rttEstimateMs() - E.corr;
    const t = now();
    if (at <= t) return;
    if (kind === "UPPER") G.upperEnd = end;
    try {
      ensureTimingWorker().postMessage({
        type: "arm", planId: `CGUARD:${kind}:${Math.round(end)}`, targetId: -1, stepAt: 0, stepMs: 0,
        seq: state.seq, leadMs: 0, window: "CGUARD",
        fires: [{ index: 0, dueAt: at, delayMs: Math.max(0, at - t - SPIN_EARLY_MS) }]
      });
    } catch {}
  }

  function cocoGuardOnWorkerFire(msg) {
    const E = state.tickEngine;
    const G = state.cocoGuard;
    const [, kind, endKey] = String(msg.planId || "").split(":");
    const end = kind === "COCO" ? state.exitMode.self?.endAt : E.selfLockEnd;
    if (!end || String(Math.round(end)) !== endKey || msg.seq !== state.seq) return;
    // In our own coco selfOut is set by design; for the upper guard it means we are out.
    if (!G.enabled || !tickEnabled() || (kind !== "COCO" && E.selfOut)) return;
    if (sceneRenderer()?.spaceModel?.name !== "mGame2") return;
    // A self-coco took this window: we are immune and can not punch anyway.
    if (G.selfEnd && Math.abs(end - G.selfEnd) < 700) {
      sendDiagnostic("coco_guard", { kind, targetId: -1, why: "self_coco", used: G.used, lockEnd: Math.round(end) });
      return;
    }
    if (G.used >= G.max) { sendDiagnostic("coco_guard", { kind, targetId: -1, why: "sin_cocos", used: G.used, lockEnd: Math.round(end) }); return; }
    const landing = end - G.leadMs;
    const pick = unlockAmbusher(landing);
    if (!pick) { G.noTarget++; sendDiagnostic("coco_guard", { kind, targetId: -1, why: "nadie_pegado", used: G.used, lockEnd: Math.round(end) }); return; }
    const upper = providerInstance(state.providers.upper);
    if (!upper || typeof upper.cocoRequest !== "function") return;
    spinUntil(Math.max(Number(msg.dueAt), landing - rttEstimateMs() - E.corr));
    try { upper.cocoRequest(pick.id); } catch { return; }
    // Stunned from now on for our clicks, even if its 184 comes late: the unlock
    // click and its retry go to the next rival (user 27/09: they come 2-3 at once).
    G.pending.set(pick.id, landing + G.leadMs + 300);
    G.fired++;
    G.lastTarget = pick.id;
    sendDiagnostic("coco_guard", { kind, targetId: pick.id, waitedMs: Math.round(pick.since), used: G.used, lockEnd: Math.round(end), lateMs: Math.round(now() - Number(msg.dueAt)) });
  }

  function unlockAmbusher(landing) {
    const E = state.tickEngine;
    const selfId = inferSelfId();
    const me = ensureActorFromRenderer(selfId);
    if (!me) return null;
    let best = null;
    for (const rawId of sceneRenderer()?.avatars?.keys?.() || []) {
      const id = asId(rawId);
      if (id == null || id === selfId || E.out.has(id) || isMuted(id) || isAlly(id) || isStale(id) || rivalLocked(id, landing)) continue;
      const a = ensureActorFromRenderer(id);
      if (!a || !lateralAdjacent(me.toX, me.toY, a.toX, a.toY)) continue;
      const since = now() - (a.startAt || 0); // the longer it has waited there, the surer
      if (!best || since > best.since) best = { id, score: 1, since, face: faceSide(me.toX, me.toY, a.toX, a.toY) };
    }
    return best;
  }

  // ---- Self coco (01/10) ------------------------------------------------------
  // The guard freezes the waiter before our unlock, but it decides once, needs
  // budget, and its throw must be processed before the rival's punch. When none
  // of that holds - the rival stepped adjacent after the guard's dispatch - the
  // coco goes to OURSELVES instead: nobody can punch us for ~7 s (we can not
  // punch either, so the unlock click is skipped), and when our coco ends the
  // exit machinery fires at the learned phase at whoever waited through it.
  function cocoSelfAdjacentThreat(at) {
    const E = state.tickEngine;
    const selfId = inferSelfId();
    const me = ensureActorFromRenderer(selfId);
    if (!me) return null;
    for (const rawId of sceneRenderer()?.avatars?.keys?.() || []) {
      const id = asId(rawId);
      if (id == null || id === selfId || E.out.has(id) || isMuted(id) || isAlly(id) || isStale(id)) continue;
      const a = ensureActorFromRenderer(id);
      if (!a || !lateralAdjacent(me.toX, me.toY, a.toX, a.toY)) continue;
      if (rivalLocked(id, at)) continue; // free only after our coco: runlock covers it
      return { id, face: faceSide(me.toX, me.toY, a.toX, a.toY) };
    }
    return null;
  }

  function throwSelfCoco(why) {
    const G = state.cocoGuard;
    // Already stunned: the server ignores the request (01/10 live: three throws
    // in a row, one 184) and the request would burn budget for nothing.
    if (exitBlocksLanding(now() + rttEstimateMs() + state.tickEngine.corr)) {
      sendDiagnostic("coco_self", { why, used: G.used, ok: false, whyBlocked: "en_coco" });
      return false;
    }
    const upper = providerInstance(state.providers.upper);
    if (!upper || typeof upper.cocoRequest !== "function") return false;
    const selfId = inferSelfId();
    if (selfId == null || selfId < 0) return false;
    try {
      upper.cocoRequest(selfId);
    } catch {
      return false;
    }
    // The outbound-149 tap counts it against the 3-per-round budget; the 184
    // that comes back sets exitMode.self and re-arms the exit at its end.
    G.selfEnd = state.tickEngine.selfLockEnd;
    sendDiagnostic("coco_self", { why, used: G.used, lockEnd: Math.round(state.tickEngine.selfLockEnd || 0) });
    return true;
  }

  // Called on every inbound user step. The ambusher of our unlock usually
  // enters at the last tick before the lock ends (01/10 live: end-240), after
  // the guard already made its decision - this is the second and last chance.
  function cocoSelfOnStep(movedId) {
    const E = state.tickEngine;
    const G = state.cocoGuard;
    if (G.selfMode !== "auto" || !tickEnabled() || E.selfOut || movedId === inferSelfId()) return;
    if (sceneRenderer()?.spaceModel?.name !== "mGame2") return;
    // Stunned: nothing to cover, and a throw would be ignored anyway.
    if (exitBlocksLanding(now() + rttEstimateMs() + state.tickEngine.corr)) return;
    const end = E.selfLockEnd;
    if (!end || G.selfEnd === end) return; // already covered this lock
    const left = end - now();
    if (left <= 0 || left > 600) return;
    const threat = cocoSelfAdjacentThreat(end + 900);
    if (!threat) return;
    // Before the guard's dispatch it decides with the same or better info.
    const guardFiresAt = end - G.leadMs - rttEstimateMs() - E.corr;
    if (now() < guardFiresAt) return;
    if (G.used >= G.max) return; // the guard and we share the 3-coco budget
    // The guard already went: if it covered this rival, its pending coco does.
    if ((G.pending.get(threat.id) || 0) > end + 900) return;
    throwSelfCoco("ambush");
  }

  // Hotkey (01/10): the owner throws their own coco from inside the game,
  // without reaching for the Hub. Same guards as the manual Hub button.
  function cocoSelfOnKey(event) {
    const G = state.cocoGuard;
    if (!G.selfKey || event.code !== G.selfKey || event.repeat) return;
    const el = event.target;
    const tag = String(el?.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || el?.isContentEditable) return; // typing in the chat
    event.preventDefault();
    event.stopPropagation();
    if (state.tickEngine.selfOut || G.used >= G.max) {
      sendDiagnostic("coco_self", { why: "hotkey", used: G.used, ok: false, whyBlocked: state.tickEngine.selfOut ? "eliminado" : "sin_cocos" });
      return;
    }
    throwSelfCoco("hotkey");
  }

  function cocoSelfKeyInstall() {
    if (state.cocoGuard.selfKeyInstalled || typeof window.addEventListener !== "function") return;
    state.cocoGuard.selfKeyInstalled = true;
    window.addEventListener("keydown", cocoSelfOnKey, true);
  }

  // Budget accounting (01/10): a 149 that leaves says nothing - the server
  // silently ignores throws from a stunned player (and from one without cocos).
  // A throw only counts against the 3-per-round budget when its 184 comes back:
  // each confirmed start stuns exactly the target it was thrown at.
  function cocoThrowPending(targetId) {
    const G = state.cocoGuard;
    const id = asId(targetId);
    let acc = -1;
    if (id != null && id === inferSelfId()) acc = Number(selfAccountId());
    else if (id != null) acc = Number(sceneRenderer()?.avatars?.get?.(id)?.avatarInfo?.id);
    G.thrown.push({ t: now(), acc: Number.isFinite(acc) ? acc : -1 });
    while (G.thrown.length > 8) G.thrown.shift();
  }

  function cocoThrowConfirmed(acc, t) {
    const G = state.cocoGuard;
    const i = G.thrown.findIndex((p) => p.acc === acc && t - p.t < 3000);
    if (i < 0) return; // someone else's throw (or older than the window)
    G.thrown.splice(i, 1);
    G.used++;
    sendDiagnostic("coco_used", { used: G.used, acc });
  }

  // ---- Rival unlock ------------------------------------------------------------
  // A rival's punch animation (HIT_LOCK_MS from its 211) and coco (its end + 20)
  // end at moments we know to the millisecond, off the tick grid. Our own
  // unlock click at that kind of moment never lost live (26/09): nobody else
  // aims there. One click lands UNLOCK_MARGIN_MS after it if the rival stands
  // next to us when the click leaves.
  function runlockArm(id, end) {
    const E = state.tickEngine;
    if (!tickEnabled() || id == null || id < 0) return;
    const prev = E.runlock.get(id);
    if (prev && Math.abs(prev.end - end) < 5) return;
    const landing = end + UNLOCK_MARGIN_MS;
    E.runlock.set(id, { end, landing });
    while (E.runlock.size > 12) E.runlock.delete(E.runlock.keys().next().value);
    E.runlockStats.armed++;
    const t = now();
    const at = landing - rttEstimateMs() - E.corr;
    if (at < t) {
      E.runlock.delete(id);
      return;
    }
    try {
      ensureTimingWorker().postMessage({
        type: "arm",
        planId: `RUNLOCK:${id}:${Math.round(end)}`,
        targetId: id,
        stepAt: 0,
        stepMs: 0,
        seq: state.seq,
        leadMs: 0,
        window: "RUNLOCK",
        fires: [{ index: 0, dueAt: at, delayMs: Math.max(0, at - t - SPIN_EARLY_MS) }]
      });
    } catch {}
  }

  // Will a rival's unlock click fire (it stands next to us now) with its
  // landing inside the server gap around `landing`?
  function runlockCovers(landing) {
    const E = state.tickEngine;
    if (!E.runlock.size) return false;
    const me = ensureActorFromRenderer(inferSelfId());
    if (!me) return false;
    for (const [id, r] of E.runlock) {
      if (Math.abs(r.landing - landing) >= 110) continue;
      const a = ensureActorFromRenderer(id);
      if (a && !E.out.has(id) && lateralAdjacent(me.toX, me.toY, a.toX, a.toY)) return true;
    }
    return false;
  }

  function runlockOnWorkerFire(msg) {
    const E = state.tickEngine;
    const [, rawId, rawEnd] = String(msg.planId || "").split(":");
    const id = Number(rawId);
    const r = E.runlock.get(id);
    if (!r || Math.round(r.end) !== Number(rawEnd)) return;
    E.runlock.delete(id);
    if (!tickEnabled() || E.selfOut || msg.seq !== state.seq) return;
    const landing = r.landing;
    if (selfLocked(landing) || exitBlocksLanding(landing)) return;
    const me = ensureActorFromRenderer(inferSelfId());
    const a = ensureActorFromRenderer(id);
    // Still locked for another reason (a coco on top of the animation), gone,
    // or not next to us: nothing to do.
    if (!me || !a || E.out.has(id) || isMuted(id) || rivalLocked(id, landing) || !lateralAdjacent(me.toX, me.toY, a.toX, a.toY)) {
      E.runlockStats.noContact++;
      return;
    }
    spinUntil(Math.max(Number(msg.dueAt), landing - rttEstimateMs() - E.corr));
    if (state.timing.tick.single) faceBeforeClick(faceSide(me.toX, me.toY, a.toX, a.toY));
    const ok = firePunch(id, "RUNLOCK", { bypassThrottle: true });
    if (ok) {
      E.runlockStats.fired++;
      E.runlockStats.lastTarget = id;
    }
    sendDiagnostic("runlock_fire", { targetId: id, end: Math.round(r.end), ok, lateMs: Math.round(now() - Number(msg.dueAt)) });
  }

  function accountToId(acc) {
    const avatars = sceneRenderer()?.avatars;
    if (!(avatars instanceof Map)) return null;
    for (const [rawId, av] of avatars) {
      if (Number(av?.avatarInfo?.id) === acc) return asId(rawId);
    }
    return null;
  }

  function isMuted(id) {
    const until = state.tickEngine.mutedUntil.get(id);
    return until != null && until > now();
  }

  // ---- Ally (29/09) --------------------------------------------------------------
  // A second account plays next to the user's: neither ever targets the other.
  // ---- Stale avatars (29/09) ------------------------------------------------------
  let staleAvatars = new WeakSet();
  let staleCount = 0;
  let staleLoadAt = -1e9;
  function staleAvatarsNote() {
    const avatars = sceneRenderer()?.avatars;
    staleAvatars = new WeakSet();
    staleCount = 0;
    if (!(avatars instanceof Map)) return;
    for (const av of avatars.values()) if (av && typeof av === "object") { staleAvatars.add(av); staleCount++; }
  }
  function isStaleAvatar(av) {
    return Boolean(av && typeof av === "object" && staleAvatars.has(av));
  }
  // 29/09: when the Ring calls right after paying, the lobby roster lands in the Ring
  // scene too. Ring players are slots 0..7 (see the coco rule, selfId < 8): in the Ring,
  // any id >= 8 is a lobby leftover.
  let ringSlotsOnly = true; // the test fixture uses free ids inside mGame2
  function notRingSlot(id) {
    const n = Number(id);
    return ringSlotsOnly && Number.isFinite(n) && n >= 8 && roomKind() === "ring";
  }
  function isStale(id) {
    if (notRingSlot(id)) return true;
    const avatars = sceneRenderer()?.avatars;
    return isStaleAvatar(avatars?.get?.(id) ?? avatars?.get?.(String(id)));
  }

  function isAlly(id) {
    const A = state.allies;
    if (!A.accounts.size && !A.names.size) return false;
    const avatars = sceneRenderer()?.avatars;
    const av = avatars?.get?.(id) ?? avatars?.get?.(String(id));
    const info = av?.avatarInfo;
    if (!info) return false;
    if (A.accounts.has(Number(info.id))) return true;
    const name = String(info.username || "").trim().toLowerCase();
    return Boolean(name) && A.names.has(name);
  }

  // ---- Simon Dice (06/10) -------------------------------------------------------
  // The server shows a cartel as an image: 160/143 [round, timeMs, webp base64]
  // (then 160/143 [0, ...] clears it). Top band: the asked face; green with a
  // tick = touch it, red striped with the face crossed = touch nothing. Below,
  // the 8 faces shuffled per player (4 x 2). A touch is 160/143/122 [round, cell]
  // with cell 0..7 by rows. Each round gives less time and the final duel drops
  // the slowest, so the answer leaves as soon as the cartel is read.
  // Automatic punches are held in rooms where a Simon cartel was seen.
  const SIMON_ROOMS_KEY = "bbhub.simonRooms.v1";
  function simonRoomName() {
    return String(sceneRenderer()?.spaceModel?.name || "");
  }
  function simonRoomsLoad() {
    const S = state.simon;
    if (S.roomsLoaded) return;
    S.roomsLoaded = true;
    try {
      const saved = JSON.parse(window.localStorage?.getItem(SIMON_ROOMS_KEY) || "[]");
      if (Array.isArray(saved)) for (const r of saved) if (r) S.rooms.add(String(r));
    } catch {}
  }
  function simonRoomActive() {
    simonRoomsLoad();
    const room = simonRoomName();
    return Boolean(room) && state.simon.rooms.has(room);
  }
  function simonNoteRoom() {
    simonRoomsLoad();
    const room = simonRoomName();
    if (!room || state.simon.rooms.has(room)) return;
    state.simon.rooms.add(room);
    try { window.localStorage?.setItem(SIMON_ROOMS_KEY, JSON.stringify([...state.simon.rooms].slice(-20))); } catch {}
  }

  // The game's own sender of 160/143/122 (its method takes round and cell).
  function simonSendFn() {
    const S = state.simon;
    const inst = providerInstance(state.providers.game);
    if (!inst) return null;
    if (S.sendName && typeof inst[S.sendName] === "function") return (round, cell) => inst[S.sendName](round, cell);
    // The client names it simonAnswerRequest(round, cell) (06/10); fall back to its body if renamed.
    if (typeof inst.simonAnswerRequest === "function") { S.sendName = "simonAnswerRequest"; return (round, cell) => inst.simonAnswerRequest(round, cell); }
    for (let proto = Object.getPrototypeOf(inst); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
      for (const name of Object.getOwnPropertyNames(proto)) {
        let fn = null;
        try { fn = proto[name]; } catch {}
        if (typeof fn !== "function" || name === "constructor") continue;
        let src = "";
        try { src = Function.prototype.toString.call(fn); } catch {}
        if (/160\s*,\s*143\s*,\s*122\b/.test(src)) { S.sendName = name; return (round, cell) => inst[name](round, cell); }
      }
    }
    return null;
  }
  function simonSend(round, cell) {
    const viaGame = simonSendFn();
    if (viaGame) { viaGame(round, cell); return "game"; }
    const P = state.providers.packet?.exported;
    const socket = providerInstance(state.providers.socket);
    if (!P || !socket) return "";
    const pk = new P(160, 143, 122);
    pk.appendParameter(round);
    pk.appendParameter(cell);
    socket.sendServerMessage(pk);
    return "raw";
  }

  async function simonOnCartel(fields) {
    const S = state.simon;
    const round = Number(fields[0]);
    const timeMs = Number(fields[1]);
    const b64 = String(fields[2] || "");
    if (!(round > 0) || !b64) return;
    simonNoteRoom();
    if (round === 1) S.games++;
    S.rounds++;
    if (!S.enabled) return;
    const t0 = now();
    let result;
    try {
      const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
      const bmp = await createImageBitmap(new Blob([bytes], { type: "image/webp" }));
      const canvas = new OffscreenCanvas(bmp.width, bmp.height);
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0);
      const img = ctx.getImageData(0, 0, bmp.width, bmp.height);
      result = simonSolve(img.data, bmp.width, bmp.height);
    } catch (error) {
      S.errors++;
      S.last = { round, timeMs, error: String(error?.message || error).slice(0, 80), at: Math.round(now()) };
      sendDiagnostic("simon", S.last);
      return;
    }
    const readMs = Math.round((now() - t0) * 10) / 10;
    // The Hub keeps each read cartel with its answer (after the touch leaves).
    setTimeout(() => sendToHub({
      type: "simon_cartel", round, timeMs, b64, go: result.go !== false, cell: Number.isInteger(result.cell) ? result.cell : null,
      sep: result.sep ?? null, conf: result.conf ?? null, scores: result.scores || null, error: result.error || "", readMs
    }), 30 + (S.delayMs | 0));
    if (result.error) {
      S.errors++;
      S.last = { round, timeMs, error: result.error, readMs, at: Math.round(now()) };
      sendDiagnostic("simon", S.last);
      return;
    }
    if (!result.go) {
      S.skippedRed++;
      S.last = { round, timeMs, go: false, readMs, at: Math.round(now()) };
      sendDiagnostic("simon", S.last);
      return;
    }
    const fire = () => {
      let via = "";
      try { via = simonSend(round, result.cell); } catch (error) { via = ""; }
      if (via) S.answered++; else S.errors++;
      S.last = { round, timeMs, go: true, cell: result.cell, conf: result.conf, sep: result.sep, readMs, totalMs: Math.round(now() - t0), via, at: Math.round(now()) };
      sendDiagnostic("simon", S.last);
    };
    const delay = clamp(S.delayMs | 0, 0, 2000);
    if (delay > 0) setTimeout(fire, delay); else fire();
  }

  function simonOnPacket(packet, direction) {
    if (direction !== "in" || packet.id !== 160) return;
    const f = packet.fields || [];
    if (packet.type === 143 && f[2]) { void simonOnCartel(f); return; }
    // 160/129 [_, accountId, name, prize]: the game's winner.
    if (packet.type === 129 && simonRoomActive() && Number(f[1]) === selfAccountId()) state.simon.wins++;
  }

  function simonSummary() {
    const S = state.simon;
    return {
      enabled: S.enabled, delayMs: S.delayMs, inRoom: simonRoomActive(), games: S.games, rounds: S.rounds,
      answered: S.answered, skippedRed: S.skippedRed, errors: S.errors, wins: S.wins,
      punchesHeld: S.punchesHeld, sender: S.sendName ? "game" : "", last: S.last
    };
  }

  // Simon Dice cartel solver v2 (runs in the game page).
  // Input: RGBA pixels of the cartel (a band with the asked face on top, a 4x2
  // grid of shuffled faces below). Output: { go, cell, conf, ... }.
  // Every face is drawn with its own size and rotation, so each one is sampled
  // in polar coordinates around its disc (radius = disc size) and compared with
  // the asked face at every rotation; the best rotation counts.
  function simonSolve(px, w, h) {
    const at = (x, y) => (y * w + x) * 4;
    const rgb = (x, y) => { const i = at(x, y); return [px[i], px[i + 1], px[i + 2]]; };
    const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    // Band: from the top until the first row that looks like the beige grid.
    const isBeige = ([r, g, b]) => r > 200 && g > 190 && b > 170 && r - b < 45 && Math.abs(r - g) < 25;
    let bandH = 0;
    for (let y = 0; y < h; y++) {
      let beige = 0;
      for (let x = 0; x < w; x += 4) if (isBeige(rgb(x, y))) beige++;
      if (beige > (w / 4) * 0.6) { bandH = y; break; }
    }
    if (bandH < 20) return { error: "no_band" };
    // Band colour from its left edge (never under the face).
    let gr = 0, rd = 0;
    for (let y = 4; y < bandH - 4; y += 2) for (let x = 2; x < Math.min(40, w); x += 2) {
      const [r, g, b] = rgb(x, y);
      if (g > r + 30 && g > b) gr++;
      else if (r > g + 40 && r > b + 20) rd++;
    }
    const go = gr > rd * 2;
    if (!go) return { go: false, bandH, green: gr, red: rd };

    const mean = (pts) => { const s = [0, 0, 0]; for (const c of pts) { s[0] += c[0]; s[1] += c[1]; s[2] += c[2]; } return s.map((v) => v / Math.max(1, pts.length)); };
    const bandRef = (() => { const p = []; for (let y = 4; y < bandH - 4; y++) for (let x = 2; x < 30; x++) p.push(rgb(x, y)); return mean(p); })();
    const gridRef = (() => { const p = []; for (let y = bandH + 2; y < h; y += 3) for (let x = 0; x < w; x += 3) { const c = rgb(x, y); if (isBeige(c)) p.push(c); } return mean(p); })();
    // Disc of a face: its warm saturated pixels (yellow or red body, hearts).
    const isBody = ([r, g, b]) => r > 150 && r - b > 60 && Math.max(r, g, b) - Math.min(r, g, b) > 55;
    // Band pixels near the band green read as the grid beige, so both regions share a background.
    const bandColor = (x, y) => { const c = rgb(x, y); return dist(c, bandRef) < 70 ? gridRef : c; };
    const gridColor = (x, y) => rgb(x, y);

    const RS = 16, AS = 64;
    const target = polar(Math.round(w * 0.22), 4, Math.round(w * 0.52), bandH - 4, bandColor);
    if (!target) return { go: true, error: "no_target_face", bandH };
    const cells = [];
    const gh = h - bandH;
    for (let row = 0; row < 2; row++) for (let col = 0; col < 4; col++) {
      const x0 = Math.round((col * w) / 4) + 3, x1 = Math.round(((col + 1) * w) / 4) - 3;
      const y0 = bandH + Math.round((row * gh) / 2) + 3, y1 = bandH + Math.round(((row + 1) * gh) / 2) - 3;
      cells.push(polar(x0, y0, x1, y1, gridColor));
    }
    const scores = cells.map((c) => (c ? compare(target, c) : Infinity));
    const order = scores.map((s, i) => [s, i]).sort((a, b) => a[0] - b[0]);
    const best = order[0], second = order[1];
    // sep: gap to the runner-up against the gap to the middle of the pack (0..1);
    // a low value means two faces read almost alike.
    const sep = (second[0] - best[0]) / Math.max(1e-6, order[4][0] - best[0]);
    return { go: true, cell: best[1], score: +best[0].toFixed(1), conf: +(second[0] / Math.max(1e-6, best[0])).toFixed(2), sep: +sep.toFixed(2), scores: scores.map((s) => +s.toFixed(1)), bandH };

    function polar(x0, y0, x1, y1, colorAt) {
      let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (isBody(rgb(x, y))) {
        if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
      if (maxX < 0 || maxX - minX < 6 || maxY - minY < 6) return null;
      const cx = (minX + maxX + 1) / 2, cy = (minY + maxY + 1) / 2, R = (maxX - minX + maxY - minY + 2) / 4;
      const out = new Float32Array(RS * AS * 3);
      for (let k = 0; k < RS; k++) {
        const r = R * (0.05 + (1.4 * k) / (RS - 1));
        for (let a = 0; a < AS; a++) {
          const th = (2 * Math.PI * a) / AS;
          const fx = cx + r * Math.cos(th) - 0.5, fy = cy + r * Math.sin(th) - 0.5, ix = Math.floor(fx), iy = Math.floor(fy), u = fx - ix, v = fy - iy;
          const pick = (x, y) => (x < x0 || x >= x1 || y < y0 || y >= y1 ? gridRef : colorAt(x, y));
          const c00 = pick(ix, iy), c10 = pick(ix + 1, iy), c01 = pick(ix, iy + 1), c11 = pick(ix + 1, iy + 1);
          const c = [0, 1, 2].map((j) => (c00[j] * (1 - u) + c10[j] * u) * (1 - v) + (c01[j] * (1 - u) + c11[j] * u) * v);
          const i = (k * AS + a) * 3;
          out[i] = c[0]; out[i + 1] = c[1]; out[i + 2] = c[2];
        }
      }
      return out;
    }
    function compare(a, b) {
      let best = Infinity;
      for (let s = 0; s < AS; s++) {
        let sum = 0;
        for (let k = 0; k < RS && sum < best; k++) for (let i = 0; i < AS; i++) {
          const p = (k * AS + i) * 3, q = (k * AS + ((i + s) % AS)) * 3;
          const dr = a[p] - b[q], dg = a[p + 1] - b[q + 1], db = a[p + 2] - b[q + 2];
          sum += Math.sqrt(dr * dr + dg * dg + db * db);
        }
        if (sum < best) best = sum;
      }
      return best / (RS * AS);
    }
  }


  // ---- Portraits for the Hub's ally list (06/10) -------------------------------
  // The keko as the room draws it, rendered by the game's own PIXI renderer.
  // Called by the Hub launcher (never by the combat path), one avatar per call.
  // A GPU readback blocks the main thread ~15 ms, so with Timing on it only runs
  // right after a batch (the next tick click leaves ~435 ms after it).
  // Only the account id, name and image leave the page.
  const PORTRAIT_FRONT = { 4: 2, 1: 1, 7: 1, 8: 1 }; // orient -> quality (4 = facing us)
  async function portraitNext(have = {}) {
    const E = state.tickEngine;
    const t = now();
    const since = t - E.lastBatchAt;
    if (tickEnabled() && E.origin != null && !(since >= 40 && since <= 300)) return { wait: true };
    const renderer = providerInstance(state.providers.pixi)?.app?.renderer;
    if (!renderer?.extract?.base64) return { error: "no_renderer" };
    for (const [, avatar] of sceneRenderer()?.avatars || []) {
      const info = avatar?.avatarInfo;
      const accountId = Number(info?.id);
      if (!Number.isFinite(accountId) || accountId <= 0 || !avatar?.movieClip || isStaleAvatar(avatar)) continue;
      const quality = PORTRAIT_FRONT[Number(avatar.position?.z) | 0] || 0;
      const prev = have[accountId];
      if (prev != null && Number(prev) >= quality) continue;
      let url = "";
      try { url = await renderer.extract.base64({ target: avatar.movieClip, resolution: 1 }); } catch { continue; }
      if (typeof url !== "string" || !url.startsWith("data:image/") || url.length > 200000) continue;
      return { accountId, name: String(info.username || "").slice(0, 40), url, quality };
    }
    return { none: true };
  }

  const ALLY_KEY = "bbhub.allies.v1";
  function allySet(msg, save = true) {
    const A = state.allies;
    A.accounts = new Set((msg.accounts || []).map(Number).filter((n) => Number.isFinite(n) && n > 0));
    A.names = new Set((msg.names || []).map((n) => String(n).trim().toLowerCase()).filter(Boolean));
    if (save) {
      try { window.localStorage?.setItem(ALLY_KEY, JSON.stringify({ accounts: [...A.accounts], names: [...A.names] })); } catch {}
    }
  }
  function allyLoad() {
    try {
      const raw = window.localStorage?.getItem(ALLY_KEY);
      if (raw) allySet(JSON.parse(raw), false);
    } catch {}
  }

  // ---- Auto Ring (29/09) ---------------------------------------------------------
  // Outside the Ring, ask the queue status every AUTO_RING_ASK_MS; the reply
  // 160/123 [0,..] means we are not queued: join with the client's own
  // gameRequest(1, 1), the Ring button's request.
  const AUTO_RING_ASK_MS = 4000;
  const AUTO_RING_KEY = "bbhub.autoRing.v1";
  // 29/09 live (ally account): a raw 128/124 after being hit takes us out of the
  // Ring room; the Games tab "Ring" (navigator id 100) is 128/120 [true, 100, ""].
  // A 128/120 straight from the Ring after a hit did not always leave it.
  const RING_GAME_ID = 100;
  const AUTO_RING_EXIT_MS = 3000; // eliminated this long: leave the room
  const AUTO_RING_RETRY_MS = 8000;
  const AUTO_RING_AWAY_MS = 6000; // in another room this long: go to the Ring lobby
  const AUTO_RING_AFTER_LEAVE_MS = 2000; // ... or this long right after our own leave
  function inRingRoom() {
    return sceneRenderer()?.spaceModel?.name === "mGame2";
  }
  // The scene model keeps the last room (with no avatars) in areas it does not
  // draw, like flowerpower: only a room with avatars counts.
  function roomKind() {
    const r = sceneRenderer();
    const name = r?.avatars?.size > 0 ? r?.spaceModel?.name : null;
    return name === "mGame2" ? "ring" : name === "escenario404" ? "lobby" : "other";
  }
  function autoRingNav(t, leave) {
    const R = state.autoRing;
    R.lastNavAt = t;
    // 29/09: through the client's own exitSpace / islandRequest, never raw packets:
    // islandRequest also fires the client's roomNavigateEvent, which tears the old
    // room down. With raw 128/120 the old Ring avatars stayed in the scene as ghosts
    // (13 "players" in a lobby with 2) that the engine and the ring-board saw as rivals.
    const walk = providerInstance(state.providers.walk);
    const nav = providerInstance(state.providers.nav);
    if (leave) {
      R.lastLeaveAt = t;
      R.leaves++;
      if (walk && typeof walk.exitSpace === "function") { try { walk.exitSpace(); } catch { duelSendRaw(128, 124, []); } }
      else duelSendRaw(128, 124, []);
    } else {
      R.lobbyTrips++;
      if (nav && typeof nav.islandRequest === "function") {
        try { nav.clearPendingNavigation?.(); nav.islandRequest(true, RING_GAME_ID, ""); } catch { duelSendRaw(128, 120, [true, RING_GAME_ID, ""]); }
      } else duelSendRaw(128, 120, [true, RING_GAME_ID, ""]);
    }
    sendDiagnostic("auto_ring", { step: leave ? "leave" : "lobby", joins: R.joins });
  }
  const QUICK_RETRY_MS = 1500;
  function autoRingPump(t) {
    const R = state.autoRing;
    const quick = R.oneShotUntil > t;
    if (!R.enabled && !quick) return;
    const kind = roomKind();
    if (quick && kind === "ring") {
      // The key asked to leave: keep asking (leave, then the lobby request) until out.
      if (t - R.lastNavAt > QUICK_RETRY_MS) autoRingNav(t, R.exits++ % 2 === 0);
      return;
    }
    if (quick && kind === "other") {
      if (t - R.lastNavAt > QUICK_RETRY_MS || t - R.lastLeaveAt < 15000) { R.lastLeaveAt = -1e9; autoRingNav(t, false); }
      return;
    }
    if (kind === "ring") {
      R.awaySince = 0;
      if (!state.tickEngine.selfOut) { R.outSince = 0; R.exits = 0; return; }
      if (!R.outSince) R.outSince = t;
      // First leave the room; still inside RETRY later: the lobby request, and so on.
      if (t - R.outSince > AUTO_RING_EXIT_MS && t - R.lastNavAt > AUTO_RING_RETRY_MS) autoRingNav(t, R.exits++ % 2 === 0);
      return;
    }
    R.outSince = 0;
    R.exits = 0;
    if (kind === "other") {
      if (!R.awaySince) R.awaySince = t;
      const justLeft = t - R.lastLeaveAt < 15000;
      if (t - R.awaySince > (justLeft ? AUTO_RING_AFTER_LEAVE_MS : AUTO_RING_AWAY_MS) && (justLeft || t - R.lastNavAt > AUTO_RING_RETRY_MS)) {
        R.lastLeaveAt = -1e9;
        autoRingNav(t, false);
      }
      return;
    }
    R.awaySince = 0;
    const game = providerInstance(state.providers.game);
    if (!game || typeof game.gameStatusRequest !== "function") return;
    const askEvery = quick ? QUICK_RETRY_MS : AUTO_RING_ASK_MS;
    if (t - R.lastAskAt < askEvery || t - R.lastJoinAt < askEvery) return;
    R.lastAskAt = t;
    try { game.gameStatusRequest(); } catch {}
  }
  function requeueNow() {
    const R = state.autoRing;
    const t = now();
    R.oneShotUntil = t + 25000;
    R.requeues++;
    R.exits = 0;
    R.lastNavAt = -1e9;
    R.lastAskAt = -1e9;
    R.lastJoinAt = -1e9;
    const kind = roomKind();
    sendDiagnostic("requeue", { room: kind });
    if (kind === "ring") { R.exits = 1; autoRingNav(t, true); }
    else if (kind === "other") autoRingNav(t, false);
    else {
      R.lastAskAt = t;
      try { providerInstance(state.providers.game)?.gameStatusRequest?.(); } catch {}
    }
    return kind;
  }
  function requeueOnKey(event) {
    const R = state.autoRing;
    if (!R.hotkey || event.code !== R.hotkey || event.repeat) return;
    const el = event.target;
    const tag = String(el?.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || el?.isContentEditable) return; // typing in the chat
    event.preventDefault();
    event.stopPropagation();
    requeueNow();
  }
  function requeueKeyInstall() {
    if (state.autoRing.keyInstalled || typeof window.addEventListener !== "function") return;
    state.autoRing.keyInstalled = true;
    window.addEventListener("keydown", requeueOnKey, true);
  }

  function autoRingOnStatus(fields) {
    const R = state.autoRing;
    R.lastStatus = (fields || []).join(",");
    const quick = R.oneShotUntil > now();
    // Queued (or in a game): the one-shot is done.
    if (quick && String(fields?.[0]) !== "0") { R.oneShotUntil = 0; return; }
    if ((!R.enabled && !quick) || roomKind() !== "lobby" || String(fields?.[0]) !== "0") return;
    const game = providerInstance(state.providers.game);
    if (!game || typeof game.gameRequest !== "function") return;
    R.lastJoinAt = now();
    R.joins++;
    try { game.gameRequest(1, 1); } catch {}
    sendDiagnostic("auto_ring", { joins: R.joins });
  }

  // ---- Random emotes (29/09) -----------------------------------------------------
  const EMOTE_IDS = [1, 2, 3, 4, 7]; // risa1, risa2, pedo, escupir, llorar
  const EMOTE_SAFE_TILES = 4; // in the Ring, only with no free rival this close
  function emotePump(t) {
    const M = state.emotes;
    if (!M.enabled) return;
    if (!M.nextAt) M.nextAt = t + M.minMs + Math.random() * (M.maxMs - M.minMs);
    if (t < M.nextAt) return;
    const next = () => { M.nextAt = t + M.minMs + Math.random() * (M.maxMs - M.minMs); };
    const action = providerInstance(state.providers.action);
    if (!action || typeof action.actionRequest !== "function") return next();
    if (roomKind() === "ring") {
      const E = state.tickEngine;
      const selfId = inferSelfId();
      const me = ensureActorFromRenderer(selfId);
      if (!me || E.selfOut) return next();
      if (selfLocked(t) || exitBlocksLanding(t)) { M.skipped++; return next(); }
      for (const rawId of sceneRenderer()?.avatars?.keys?.() || []) {
        const id = asId(rawId);
        if (id == null || id === selfId || E.out.has(id) || isAlly(id) || isStale(id)) continue;
        const a = ensureActorFromRenderer(id);
        if (a && Math.max(Math.abs(a.toX - me.toX), Math.abs(a.toY - me.toY)) <= EMOTE_SAFE_TILES) {
          M.skipped++;
          M.nextAt = t + 3000; // try again soon, once the area is clear
          return;
        }
      }
    }
    const id = EMOTE_IDS[Math.floor(Math.random() * EMOTE_IDS.length)];
    try { action.actionRequest(id); M.sent++; M.last = id; } catch {}
    sendDiagnostic("emote", { id });
    next();
  }

  // ---- Render off (29/09) --------------------------------------------------------
  // PIXI keeps ticking (tweens, avatar moves, the client's logic) but its
  // renderer draws nothing: software WebGL was eating the CPU the timing needs.
  const RENDER_OFF_KEY = "bbhub.renderOff.v1";
  // Only the main stage stops: render-to-texture calls (the client bakes avatars and
  // scenery that way) go through, or players end up as bare shadows once drawing resumes.
  const noRender = function (...args) {
    const o = args[0];
    const orig = state.renderOff.orig;
    if (orig && o && typeof o === "object" && (o.target || o.renderTexture)) return orig.apply(this, args);
  };
  function renderOffApply() {
    const R = state.renderOff;
    const app = providerInstance(state.providers.pixi)?.app;
    const renderer = app?.renderer;
    if (!renderer) return;
    if (R.enabled) {
      if (renderer.render !== noRender) {
        R.orig = renderer.render;
        R.app = app;
        renderer.render = noRender;
        R.patched++;
      }
    } else if (renderer.render === noRender && R.orig) {
      renderer.render = R.orig;
    }
  }
  function flagLoad(key, target) {
    try { if (window.localStorage?.getItem(key) === "1") target.enabled = true; } catch {}
  }
  function flagSave(key, on) {
    try { window.localStorage?.setItem(key, on ? "1" : "0"); } catch {}
  }

  // An eliminated player that left the room (island) and walked back in is
  // in play again; in the Ring spectators stay in the room and stay out.
  function refreshEliminated() {
    const E = state.tickEngine;
    if (!E.out.size) return;
    const avatars = sceneRenderer()?.avatars;
    if (!(avatars instanceof Map)) return;
    for (const id of E.out) {
      if (!avatars.has(id)) E.outGone.add(id);
      else if (E.outGone.has(id)) {
        E.out.delete(id);
        E.outGone.delete(id);
      }
    }
  }

  function sendTick() {
    const t = now();
    refreshOptionalProviders();
    noThrottleInstall();
    if (!state.persistLoaded) {
      state.persistLoaded = true;
      allyLoad();
      flagLoad(AUTO_RING_KEY, state.autoRing);
      try { if (window.localStorage?.getItem(NO_THROTTLE_KEY) === "0") state.noThrottle.enabled = false; } catch {}
      flagLoad(RENDER_OFF_KEY, state.renderOff);
    }
    autoRingPump(t);
    emotePump(t);
    if (state.renderOff.enabled || state.renderOff.orig) renderOffApply();
    refreshEliminated();
    refreshSilent();
    exitPump();
    const players = collectPlayers();
    const inCombat =
      (state.timing.enabled || state.pulse.enabled || state.moveDelay.enabled) &&
      (players.length > 1 || state.burstPlans.length > 0 || state.gridPlan);
    const stateEvery = inCombat ? state.performance.stateMs : Math.max(state.performance.stateMs, 700);
    const sceneEvery = inCombat ? state.performance.sceneMs : Math.max(state.performance.sceneMs, 5000);
    const configEvery = state.performance.configMs;

    if (t - state.lastStateAt >= stateEvery) {
      state.lastStateAt = t;
      sendState();
    }
    if (t - state.lastConfigAt >= configEvery) {
      state.lastConfigAt = t;
      sendConfig();
    }
    if (t - state.lastSceneAt >= sceneEvery) {
      sendSceneSnapshot(false);
    }
  }

  async function discoverProviders() {
    const moduleUrls = findModuleUrls();
    if (!moduleUrls.length) {
      return { providers: null, modulesTried: 0, lastError: "no_module_urls" };
    }

    let merged = {
      upper: null,
      socket: null,
      renderer: null,
      walk: null,
      selection: null,
      ping: null,
      space: null,
      map: null,
      nav: null,
      packet: null,
      game: null,
      pixi: null,
      action: null
    };
    let lastError = null;
    let sameModule = null;

    for (const url of moduleUrls) {
      try {
        const mod = await import(url);
        const found = findProviders(mod);
        if (providersComplete(found)) {
          sameModule = found;
          break;
        }
        for (const key of Object.keys(merged)) {
          if (!merged[key] && found[key]) merged[key] = found[key];
        }
      } catch (error) {
        lastError = error && error.message ? error.message : String(error);
      }
    }

    const providers = sameModule || (providersComplete(merged) ? merged : null);
    return {
      providers,
      modulesTried: moduleUrls.length,
      lastError,
      partial: {
        upper: Boolean(merged.upper),
        socket: Boolean(merged.socket),
        renderer: Boolean(merged.renderer),
        walk: Boolean(merged.walk),
        selection: Boolean(merged.selection),
        ping: Boolean(merged.ping),
        map: Boolean(merged.map)
      }
    };
  }

  async function loadProvidersWithRetry(timeoutMs = 120000) {
    const deadline = Date.now() + Math.max(5000, timeoutMs | 0);
    let last = null;
    while (Date.now() < deadline) {
      last = await discoverProviders();
      if (last.providers) return last.providers;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const detail = last
      ? `modules=${last.modulesTried} partial=${JSON.stringify(last.partial)} err=${last.lastError || "-"}`
      : "no_attempt";
    throw new Error(`Flash runtime providers incomplete (${detail})`);
  }

  async function boot(options = {}) {
    if (state.ready) {
      if (options.selfUsername) state.selfUsername = String(options.selfUsername);
      return status();
    }
    if (options.selfUsername) state.selfUsername = String(options.selfUsername);
    const timeoutMs = Number(options.timeoutMs || 120000);
    const providers = await loadProvidersWithRetry(timeoutMs);

    state.providers = providers;
    if (providers.socket) hookSocket(providers.socket);
    if (providers.renderer) hookRenderer(providers.renderer);

    state.ready = true;
    tickAutoLoad();
    exitLoad();
    inferSelfId();
    sendHello();
    sendConfig();
    sendState();
    sendSceneSnapshot(true);

    if (state.sendTimer) clearInterval(state.sendTimer);
    state.sendTimer = setInterval(sendTick, 100);

    return status();
  }

  function status() {
    return {
      ready: state.ready,
      bridgeBuild: BRIDGE_BUILD,
      selfId: state.selfId,
      selectedId: state.selectedId,
      punchPackets: state.punchPackets,
      allies: { accounts: [...state.allies.accounts], names: [...state.allies.names], blocked: state.allies.blocked },
      autoRing: { enabled: state.autoRing.enabled, hotkey: state.autoRing.hotkey, requeues: state.autoRing.requeues, oneShot: state.autoRing.oneShotUntil > now(), joins: state.autoRing.joins, leaves: state.autoRing.leaves, lobbyTrips: state.autoRing.lobbyTrips, room: roomKind(), lastStatus: state.autoRing.lastStatus, provider: Boolean(providerInstance(state.providers.game)) },
      lowPing: { mode: state.lowPing.mode, active: lowPingActive(), skipped: state.lowPing.skipped },
      noThrottle: { enabled: state.noThrottle.enabled, installed: state.noThrottle.installed, sends: state.noThrottle.skipped },
      tickAdv: { sweep: state.tickAdv.sweep, repeatMs: state.tickAdv.repeatMs, repeats: state.tickAdv.repeats, burst: state.tickBurst },
      simon: simonSummary(),
      freeFire: { enabled: state.freeFire.enabled, gapMs: state.freeFire.gapMs },
      stale: { remembered: staleCount, listed: (() => { let n = 0; const av = sceneRenderer()?.avatars; if (av instanceof Map) for (const a of av.values()) if (isStaleAvatar(a)) n++; return n; })(), outOfRing: (() => { let n = 0; const av = sceneRenderer()?.avatars; if (av instanceof Map) for (const k of av.keys()) if (notRingSlot(asId(k))) n++; return n; })() },
      emotes: { enabled: state.emotes.enabled, sent: state.emotes.sent, skipped: state.emotes.skipped, last: state.emotes.last, provider: Boolean(providerInstance(state.providers.action)) },
      renderOff: { enabled: state.renderOff.enabled, patched: state.renderOff.patched, provider: Boolean(providerInstance(state.providers.pixi)?.app) },
      timing: { ...state.timing, autoLead: leadCurrent() },
      state: { ...state.stateCfg },
      grid: { ...state.grid, autoLead: leadCurrent() },
      pulse: {
        enabled: state.pulse.enabled,
        interval: state.pulse.interval,
        burst: state.pulse.burst,
        spacing: state.pulse.spacing,
        gap: state.pulse.gap,
        requireSelected: state.pulse.requireSelected,
        autoTarget: state.pulse.autoTarget,
        contactOnly: state.pulse.contactOnly,
        autoTargetId: state.pulse.autoTargetId
      },
      moveDelay: {
        enabled: state.moveDelay.enabled,
        delayMs: state.moveDelay.delayMs,
        minMoveMs: state.moveDelay.minMoveMs
      },
      dropHunter: {
        enabled: state.dropHunter.enabled,
        autoReturn: state.dropHunter.autoReturn,
        autoClaim: state.dropHunter.autoClaim,
        state: state.dropHunter.state,
        dropId: state.dropHunter.dropId,
        x: state.dropHunter.x,
        y: state.dropHunter.y
      },
      hubConnected: state.hubConnected,
      serverPingMs: state.serverPingMs,
      scheduler: {
        step: "worker",
        html5StepMs: HTML5_STEP_MS,
        hubRefMs: STEP_HUB_REF_MS,
        workerAlive: Boolean(state.timingWorker),
        pendingPlans: state.workerPlans.size
      },
      scene: state.sceneCache
        ? {
            source: state.sceneCache.sceneSource,
            space: state.sceneCache.spaceName,
            width: state.sceneCache.width,
            height: state.sceneCache.height,
            hash: state.sceneCache.baseHash
          }
        : null,
      tick: tickStatus(),
      exit: exitSummary(),
      providers: Object.fromEntries(
        Object.entries(state.providers).map(([k, v]) => [k, Boolean(v)])
      ),
      stats: { ...state.stats },
      diagnostics: { ...state.diagnostics },
      lastFireResult: state.lastFireResult && { ...state.lastFireResult },
      burstPlans: state.burstPlans.length,
      leadMs: leadCurrent()
    };
  }

  // ---- Duel lab ---------------------------------------------------------------
  // Both clients run on one PC: performance.timeOrigin + now() is the same
  // epoch clock in both, to the sub-millisecond.
  function epochNow() {
    return performance.timeOrigin + performance.now();
  }

  // The client opens (composes) an island before it can enter one of its zones;
  // after a kick it composes the island again by itself (July lab rejoin).
  if (typeof window.addEventListener === "function") {
    window.addEventListener("islandComposeEvent", (event) => {
      const detail = event?.detail || {};
      state.duel.composeAt = epochNow();
      state.duel.composeZones = Array.isArray(detail.zones) ? detail.zones.map((z) => Number(z?.id)).filter(Number.isFinite) : [];
    });
  }

  function duelRecord(packet, direction) {
    const D = state.duel;
    D.buf.push({ t: epochNow(), dir: direction, id: packet.id | 0, type: packet.type | 0, fields: (packet.fields || []).slice(0, 12) });
    if (D.buf.length > 20000) D.buf.splice(0, D.buf.length - 20000);
  }

  function duelSnapshot() {
    const selfId = inferSelfId();
    const spaceInst = providerInstance(state.providers.space);
    const players = [];
    for (const [rawId, avatar] of sceneRenderer()?.avatars || []) {
      const id = asId(rawId);
      const actor = ensureActorFromRenderer(id);
      players.push({
        id,
        username: String(avatar?.avatarInfo?.username || ""),
        accountId: Number(avatar?.avatarInfo?.id) || null,
        x: actor ? actor.toX : Number(avatar?.position?.x),
        y: actor ? actor.toY : Number(avatar?.position?.y)
      });
    }
    return {
      selfId,
      space: spaceInst ? { id: Number(spaceInst.currentSpaceId) || null, name: String(spaceInst.currentSpaceName || ""), type: Number(spaceInst.spaceType) || null } : null,
      players,
      nav: Boolean(providerInstance(state.providers.nav)),
      packet: Boolean(state.providers.packet?.exported),
      composeAt: state.duel.composeAt,
      composeZones: state.duel.composeZones,
      pingMs: rttEstimateMs()
    };
  }

  // actions: [{ tag, at (epoch ms), kind: "punch" | "walk" | "face", targetId, x, y, face }]
  function duelSchedule(actions) {
    const upper = () => providerInstance(state.providers.upper);
    for (const action of actions || []) {
      const due = Number(action.at) - performance.timeOrigin;
      const run = () => {
        spinUntil(due);
        const sentAt = epochNow();
        let ok = false;
        try {
          if (action.kind === "walk") {
            ok = moveTo(action.x, action.y);
          } else if (action.kind === "raw") {
            ok = duelSendRaw(action.id, action.type, action.params);
          } else if (action.kind === "rawbytes") {
            ok = duelSendBytes(action.bytes, action.id || 211);
          } else {
            const u = upper();
            if (action.face > 0 && u && typeof u.rotationRequest === "function") u.rotationRequest(action.face);
            if (action.kind === "punch" && u) {
              u.lastUpperAt = -1e9; // the lab decides the spacing, not the native 100 ms throttle
              u.upperRequest(action.targetId);
              ok = true;
            } else if (action.kind === "face") {
              ok = true;
            }
          }
        } catch {}
        state.duel.results.push({ tag: action.tag, kind: action.kind, targetId: action.targetId, planned: Number(action.at), sent: sentAt, ok });
      };
      setTimeout(run, Math.max(0, due - performance.now() - SPIN_EARLY_MS));
    }
    return actions?.length || 0;
  }

  // A request built like the client builds them, with parameters of our choice.
  function duelSendRaw(id, type, params) {
    const P = state.providers.packet?.exported;
    const socket = providerInstance(state.providers.socket);
    if (typeof P !== "function" || !socket) return false;
    try {
      const pk = type ? new P(id, type) : new P(id);
      for (const v of params || []) pk.appendParameter(v);
      socket.sendServerMessage(pk);
      return true;
    } catch {
      return false;
    }
  }

  // Send an exact byte string (latin1) as one WSS message — hand-crafted,
  // possibly malformed frames the client class would never build (duel exploit).
  function duelSendBytes(latin1, idForLog = 211) {
    const socket = providerInstance(state.providers.socket);
    if (!socket || typeof latin1 !== "string") return false;
    try { socket.sendServerMessage({ id: idForLog | 0, toString: () => latin1 }); return true; } catch { return false; }
  }

  function duelJoinZone(zoneId) {
    const nav = providerInstance(state.providers.nav);
    if (!nav || typeof nav.islandRequest !== "function") return false;
    try {
      nav.clearPendingNavigation?.();
      nav.islandRequest(false, Number(zoneId), "");
      return true;
    } catch {
      return false;
    }
  }

  window[KEY] = {
    __installed: true,
    boot,
    status,
    onHubMessage,
    setHubConnected(connected) {
      state.hubConnected = Boolean(connected);
    },
    fire: (targetId) => firePunch(targetId, "manual"),
    portraitNext,
    lab: {
      cooldownProbe: (options) => labCooldownProbe(options),
      structProbe: (options) => labStructProbe(options),
      targets: () => labProbeTargets()
    },
    // Server-REPL for the shell (drive via CDP). Turns the authenticated client
    // into a raw packet pipe: send any opcode, then read every reply from the tap.
    debug: {
      tap(on = true) { state.rawTap.on = Boolean(on); if (on) state.rawTap.ring = []; return state.rawTap.on; },
      clear() { state.rawTap.ring = []; return true; },
      capture(sinceMs = 1500) { const cut = now() - sinceMs; return state.rawTap.ring.filter((x) => x.t >= cut); },
      self() { return { id: inferSelfId(), acc: selfAccountId(), rtt: Math.round(rttEstimateMs()), room: sceneRenderer()?.spaceModel?.name || "" }; },
      // Send one raw packet built with the game's own class. params is an array.
      sendRaw({ op, type = 0, sub = 0, params = [] } = {}) {
        const P = state.providers.packet?.exported;
        const socket = providerInstance(state.providers.socket);
        if (!P || !socket) return { error: "no_socket" };
        const pk = type > 0 ? (sub > 0 ? new P(op, type, sub) : new P(op, type)) : new P(op);
        for (const p of params) pk.appendParameter(typeof p === "number" ? p : String(p));
        try { socket.sendServerMessage(pk); } catch (e) { return { error: String(e && e.message || e) }; }
        return { sent: true };
      },
      // Send an exact byte string (latin1) as one WSS message, id for logging only.
      sendBytes(latin1, idForLog = 0) {
        const socket = providerInstance(state.providers.socket);
        if (!socket) return { error: "no_socket" };
        try { socket.sendServerMessage({ id: idForLog | 0, toString: () => latin1 }); } catch (e) { return { error: String(e && e.message || e) }; }
        return { sent: true, bytes: latin1.length };
      },
      // Build one 211[id] frame string (latin1) so the shell can glue/craft.
      frame211(id, opts) { const P = state.providers.packet?.exported; return P ? structFrameString(P, id, opts) : null; }
    },
    move: (x, y) => moveTo(x, y),
    requeue: () => requeueNow(),
    duel: {
      enable(on = true) {
        state.duel.on = Boolean(on);
        return state.duel.on;
      },
      clock: () => ({ origin: performance.timeOrigin, now: performance.now(), epoch: epochNow() }),
      drain() {
        const out = { packets: state.duel.buf, results: state.duel.results };
        state.duel.buf = [];
        state.duel.results = [];
        return out;
      },
      schedule: (actions) => duelSchedule(actions),
      snapshot: () => duelSnapshot(),
      joinZone: (zoneId) => duelJoinZone(zoneId)
    },
    select: (id) => {
      state.selectedId = asId(id) ?? -1;
      sendState();
      return state.selectedId;
    },
    dropHunter: {
      simulateDrop(x, y, id) {
        dropHunterOnDrop(x | 0, y | 0, id == null ? 1 : id | 0);
        return {
          state: state.dropHunter.state,
          x: state.dropHunter.x,
          y: state.dropHunter.y,
          dropId: state.dropHunter.dropId
        };
      }
    }
  };
})();
