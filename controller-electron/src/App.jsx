import { useEffect, useMemo, useState } from "react";
import logoUrl from "../electron/assets/icon.png";
import { AlertTriangle, ArrowUpRight, ArrowRight, Check, Crosshair, Gauge, Grid2X2, ListFilter, RotateCcw, ScrollText, ShieldCheck, Smile, Square, Target, Trash2, UserPlus, Users, X, Zap } from "lucide-react";
import { createDemoApi } from "./demo.js";
import { selectStepCrossing, stepCrossingPhase, stepClickDraft, stepClickPhases, validStepClickDraft } from "./step-click-metrics.js";

const fallbackSnapshot = {
  controllerBuild: "-",
  connected: false,
  timingHotkey: "F2",
  bridgeBuild: "-",
  selfId: -1,
  selectedTarget: -1,
  serverPingMs: null,
  bridgePingMs: null,
  lastStateAgeMs: null,
  players: [],
  timing: {
    enabled: false,
    targetMode: "AUTO",
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
      offsetMs: 10,
      shots: 4,
      spacingMs: 110,
      blind: true,
      reactive: true,
      autoCal: true,
      burst: 1,
      burstGapMs: 4
    }
  },
  tick: null,
  exit: null,
  exitMode: { enabled: true, punch: true },
  combat: { hits: 0, gotHit: 0 },
  moveDelay: { enabled: false, delayMs: 0, minMoveMs: 0 },
  dropHunter: {
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
  },
  ringBoard: {
    licensed: false,
    url: "http://127.0.0.1:18445",
    bridgeConnected: false,
    armed: false,
    highPower: false,
    moveAssist: false,
    stepCadenceAlways: false,
    pulseClick: false,
    sceneHash: "",
    lastSensorAgeMs: null,
    lastCommand: ""
  },
  punchPackets: 1,
  desiredMode: null,
  logs: []
};

const stubApi = {
  getSnapshot: async () => fallbackSnapshot,
  applyTiming: async () => {},
  setTimingHotkey: async () => {},
  checkUpdates: async () => {},
  installUpdate: async () => {},
  applyMovePunch: async () => {},
  applyDropHunter: async () => {},
  saveDraftConfig: async () => {},
  resetTickAuto: async () => {},
  setTickAim: async () => {},
  applyExit: async () => {},
  applyStepWalk: async () => {},
  applyFreeFire: async () => {},
  setAllies: async () => {},
  toggleAlly: async () => {},
  applySimon: async () => {},
  applyStepClick: async () => {},
  addAllyByName: async () => {},
  removeAlly: async () => {},
  getPortraits: async () => ({}),
  setAutoRun: async () => {},
  setAdvanced: async () => {},
  setRequeueKey: async () => {},
  requeueNow: async () => {},
  resetExit: async () => {},
  setRingBoardArmed: async () => {},
  ringBoardAction: async () => {},
  setPunchPackets: async () => {},
  selectTarget: async () => {},
  rawPunch: async () => {},
  stopModes: async () => {},
  clearLogs: async () => {},
  launchGame: async () => {},
  submitGameCode: async () => {},
  saveGameAccount: async () => {},
  forgetGameAccount: async () => {},
  findGameClient: async () => {},
  selectGameClient: async () => {},
  setCombatLog: async () => {},
  openCombatLogs: async () => {},
  onSnapshot: () => () => {}
};

// Electron always provides window.ringController (preload). Demo data only in the vite dev server.
const api = window.ringController || (import.meta.env.DEV ? createDemoApi(fallbackSnapshot) : stubApi);

const navItems = [
  { id: "dashboard", label: "Inicio", icon: Gauge },
  { id: "timing", label: "Timing", icon: Zap },
  { id: "board", label: "Board", icon: Grid2X2 },
  { id: "dropHunter", label: "Drops", icon: Crosshair },
  { id: "players", label: "Jugadores", icon: Users },
  { id: "allies", label: "Aliados", icon: ShieldCheck },
  { id: "simon", label: "Simon Dice", icon: Smile },
  { id: "logs", label: "Registro", icon: ScrollText }
];

function dropHunterFromSnapshot(snapshot) {
  const hunter = snapshot?.dropHunter || fallbackSnapshot.dropHunter;
  return { enabled: Boolean(hunter.enabled), autoClaim: hunter.autoClaim == null ? true : Boolean(hunter.autoClaim) };
}
function signedMs(value) {
  return value == null || !Number.isFinite(Number(value)) ? "—" : `T${Number(value) >= 0 ? "+" : ""}${Number(value)} ms`;
}
// Fixed phase only exists in the isolated diagnostic launcher (BB_TIMING_PUNCH_ISOLATION=1).
function timingFixedPhase(snapshot) {
  const phase = snapshot.punchIsolationPhase;
  return phase != null && Number.isFinite(Number(phase)) ? Number(phase) : null;
}
const TICK_AIM_DEFAULT = 8;
const TICK_AIM_MAX = 100;
const BURST_DEFAULT = 1;
const BURST_MAX = 100;
const ADVANCED_FACTORY = { repeatMs: 105, sweep: true, reactive: true };
function tickAimOf(snapshot) {
  const aim = Number(snapshot.tickAim);
  return Number.isFinite(aim) ? aim : TICK_AIM_DEFAULT;
}
function hunterState(value) {
  return ({ IDLE: "En espera", SEARCHING: "Buscando", MOVING: "En camino", CLAIMING: "Reclamando", RETURNING: "Volviendo", WAITING: "Esperando" })[value] || value || "En espera";
}
function App() {
  const [snapshot, setSnapshot] = useState(fallbackSnapshot);
  const [activeTab, setActiveTab] = useState("dashboard");
  const [dropHunterForm, setDropHunterForm] = useState(dropHunterFromSnapshot(fallbackSnapshot));
  const [dropHunterDirty, setDropHunterDirty] = useState(false);
  const [playerFilter, setPlayerFilter] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [portraits, setPortraits] = useState({});

  useEffect(() => {
    let mounted = true;
    api.getSnapshot().then((next) => { if (mounted) setSnapshot(next); }).catch(() => { if (mounted) setNotice("No se pudo leer el estado del controller."); }).finally(() => { if (mounted) setLoading(false); });
    const off = api.onSnapshot((next) => { if (mounted) setSnapshot(next); });
    return () => { mounted = false; off?.(); };
  }, []);
  // Keko portraits travel apart from the snapshot (images): fetched when their version moves.
  useEffect(() => {
    let mounted = true;
    api.getPortraits?.().then((next) => { if (mounted && next && typeof next === "object") setPortraits(next); }).catch(() => {});
    return () => { mounted = false; };
  }, [snapshot.portraitVersion]);
  const dropHunterKey = JSON.stringify(snapshot.dropHunter || {});
  useEffect(() => { if (!dropHunterDirty) setDropHunterForm(dropHunterFromSnapshot(snapshot)); }, [dropHunterKey, dropHunterDirty]);

  const players = snapshot.players || [];
  const filteredPlayers = useMemo(() => {
    const needle = playerFilter.trim().toLowerCase();
    return needle ? players.filter((p) => [p.name, p.id, p.userId].some((v) => String(v ?? "").toLowerCase().includes(needle))) : players;
  }, [players, playerFilter]);
  const selectedPlayer = players.find((p) => p.id === snapshot.selectedTarget);
  const timingSelectedMode = snapshot.timing?.targetMode === "SELECTED";
  const timingTargetId = timingSelectedMode ? snapshot.tick?.selectedTargetId : snapshot.tick?.lastTargetId;
  const automaticPlayer = snapshot.connected ? players.find((p) => !p.self && p.id !== snapshot.selfId && p.id === timingTargetId) : null;
  const timingTargetName = timingSelectedMode ? snapshot.connected && snapshot.tick?.selectedTargetId >= 0 ? snapshot.tick.selectedTargetName || automaticPlayer?.name || "Fichado" : "Sin ficha" : automaticPlayer?.name || "Sin disparos";
  const targetPresent = snapshot.stepClick?.enabled ? snapshot.stepClick.status?.targetId >= 0 : timingSelectedMode ? snapshot.connected && snapshot.tick?.selectedTargetId >= 0 : Boolean(automaticPlayer);
  const selfPlayer = players.find((p) => p.self || p.id === snapshot.selfId);
  const ping = [snapshot.serverPingMs, snapshot.bridgePingMs].find((value) => value != null && Number.isFinite(Number(value)) && Number(value) >= 0);
  const status = !snapshot.connected ? "Sin conexión" : snapshot.lastStateAgeMs > 2500 ? "Señal demorada" : "Conectado";
  const statusTone = !snapshot.connected ? "muted" : snapshot.lastStateAgeMs > 2500 ? "warn" : "good";
  const runAction = async (action) => {
    try { await action(); setNotice(""); return true; }
    catch (error) { setNotice(`No se pudo completar la acción. ${error?.message || "Vuelve a intentarlo."}`); return false; }
  };
  const applyTiming = (enabled) => runAction(() => api.applyTiming({ enabled: Boolean(enabled) }));
  const updateDropHunter = (patch) => { setDropHunterDirty(true); setDropHunterForm((value) => ({ ...value, ...patch })); };
  const applyDropHunter = async (enabled = dropHunterForm.enabled) => {
    const payload = { ...dropHunterForm, enabled };
    if (await runAction(() => api.applyDropHunter(payload))) { setDropHunterForm(payload); setDropHunterDirty(false); }
  };
  const stopModes = async () => {
    if (await runAction(async () => {
      const results = await Promise.allSettled([api.stopModes(), api.setRingBoardArmed(false)]);
      const failed = results.find((result) => result.status === "rejected");
      if (failed) throw failed.reason;
    })) setDropHunterDirty(false);
  };
  const openPlayer = async (id) => { await runAction(() => api.selectTarget(id)); setActiveTab("players"); };
  const context = { snapshot, portraits, selectedPlayer, automaticPlayer, selfPlayer, players, filteredPlayers, playerFilter, setPlayerFilter, dropHunterForm, dropHunterDirty, updateDropHunter, applyDropHunter, applyTiming, runAction, openPlayer, setActiveTab, status, statusTone };

  const combat = snapshot.combat || fallbackSnapshot.combat;
  const winRate = snapshot.tick?.auto?.recentWinRate;
  const cocoActive = Boolean(snapshot.exit?.cocoActive);
  const timingOn = Boolean(snapshot.timing?.enabled);

  return (
    <div className="shell">
      <aside className="rail">
        <button className="wordmark" onClick={() => setActiveTab("dashboard")} aria-label="BB Hub, inicio">
          <img className="wordmark-logo" src={logoUrl} alt="" aria-hidden="true" />
          <span className="wordmark-text" aria-hidden="true">BB Hub</span>
        </button>
        <nav className="rail-nav" aria-label="Navegación principal">
          {navItems.map((item) => { const Icon = item.icon; return <button key={item.id} className={`rail-link ${activeTab === item.id ? "is-current" : ""}`} aria-current={activeTab === item.id ? "page" : undefined} onClick={() => setActiveTab(item.id)} title={item.id === "timing" && timingOn ? `${item.label} · activo` : item.label}><Icon aria-hidden="true" size={17} strokeWidth={1.6} /><span className="rail-label">{item.label}</span>{item.id === "timing" && timingOn && <span className="rail-live">activo</span>}</button>; })}
        </nav>
        <p className="rail-foot"><span className="rail-signature">by bachi</span><span>Controller</span><span className="mono" title={snapshot.controllerBuild}>{snapshot.controllerBuild !== "-" ? snapshot.controllerBuild : "—"}</span><span>Runtime</span><span className="mono" title={snapshot.bridgeBuild}>{snapshot.connected && snapshot.bridgeBuild !== "-" ? snapshot.bridgeBuild : "—"}</span></p>
      </aside>
      <div className="main">
        <header className="strip" aria-busy={loading}>
          <div className="strip-link">
            <span className={`dot dot-${statusTone}`} aria-hidden="true" />
            <span className="strip-status">{loading ? "Conectando…" : status}</span>
            <span className="strip-ping"><b className="num">{ping == null ? "—" : Math.round(ping)}</b> ms</span>
          </div>
          <dl className="strip-stats">
            <div className="stat"><dt>Golpes</dt><dd className="num">{combat.hits ?? 0}</dd></div>
            <div className="stat"><dt>Recibidos</dt><dd className="num">{combat.gotHit ?? 0}</dd></div>
            <div className="stat stat-wins"><dt><span className="label-long">Carreras ganadas</span><span className="label-short">Ganadas</span></dt><dd className="num">{winRate == null ? "—" : `${winRate} %`}</dd></div>
            <div className="stat stat-coco"><dt>Coco</dt><dd className={cocoActive ? "num is-warn" : "num"}>{cocoActive ? `${(snapshot.exit.cocoRemainingMs / 1000).toFixed(1)} s` : "Libre"}</dd></div>
          </dl>
          <div className="strip-actions">
            <button className={`target ${targetPresent ? "has-target" : ""}`} onClick={() => setActiveTab("players")} title={snapshot.stepClick?.enabled ? "Ficha actual de Autoclick por paso" : timingSelectedMode ? "Ficha actual de Timing" : "Último disparo de Timing"}>
              <Target aria-hidden="true" size={15} strokeWidth={1.8} />
              <span className="target-name">{snapshot.stepClick?.enabled ? snapshot.stepClick.status?.targetName || "Sin ficha" : timingTargetName}</span>
            </button>
            <button className="btn btn-danger" onClick={stopModes}><Square aria-hidden="true" size={11} fill="currentColor" /><span>Detener todo</span></button>
          </div>
        </header>
        <main className={`view view-${activeTab}`} key={activeTab}>
          <UpdateNotice updates={snapshot.updates} runAction={runAction} />
          {notice && <div className="notice" role="alert"><AlertTriangle aria-hidden="true" size={16} strokeWidth={1.8} /><span>{notice}</span><button className="icon-btn" onClick={() => setNotice("")} aria-label="Cerrar aviso"><X aria-hidden="true" size={16} /></button></div>}
          {activeTab === "dashboard" && <DashboardView {...context} />}
          {activeTab === "timing" && <TimingView {...context} />}
          {activeTab === "board" && <BoardView {...context} />}
          {activeTab === "dropHunter" && <DropHunterView {...context} />}
          {activeTab === "players" && <PlayersView {...context} />}
          {activeTab === "allies" && <AlliesView {...context} />}
          {activeTab === "simon" && <SimonView {...context} />}
          {activeTab === "logs" && <LogsView logs={snapshot.logs || []} runAction={runAction} />}
        </main>
      </div>
    </div>
  );
}

function DashboardView({ snapshot, selfPlayer, players, selectedPlayer, automaticPlayer, applyTiming, applyDropHunter, dropHunterForm, runAction, openPlayer, setActiveTab }) {
  const ring = snapshot.ringBoard || fallbackSnapshot.ringBoard;
  const hunter = snapshot.dropHunter || fallbackSnapshot.dropHunter;
  const combat = snapshot.combat || fallbackSnapshot.combat;
  const auto = snapshot.tick?.auto;
  const fixedPhase = timingFixedPhase(snapshot);
  const avatarUrl = snapshot.game?.avatarUrl || "";
  const timingSelectedMode = snapshot.timing?.targetMode === "SELECTED";
  const timingTargetName = timingSelectedMode ? snapshot.connected && snapshot.tick?.selectedTargetId >= 0 ? snapshot.tick.selectedTargetName || automaticPlayer?.name || "Fichado" : "Sin ficha" : automaticPlayer?.name || "Sin disparos";
  return <>
    <PageHeading title="Inicio" description={selfPlayer ? <>Sesión de <strong>{selfPlayer.name}</strong> · {snapshot.connected ? "cliente conectado" : "cliente sin conexión"}.</> : "Esperando al cliente del juego."} action={<button className="btn" onClick={() => setActiveTab("timing")}>Abrir Timing <ArrowUpRight aria-hidden="true" size={15} /></button>} />
    <ProfileCard snapshot={snapshot} selfPlayer={selfPlayer} avatarUrl={avatarUrl} players={players} />
    <GameSection game={snapshot.game} connected={snapshot.connected} runAction={runAction} />
    <section className="section" aria-label="Modos de operación">
      <h2 id="modes-title" className="section-title">Modos</h2>
      <div className="spec">
        <Operation title="Timing" description={snapshot.timing?.targetMode === "SELECTED" ? "Solo el fichado" : "Objetivo por proximidad"} checked={Boolean(snapshot.timing?.enabled)} onChange={applyTiming} onOpen={() => setActiveTab("timing")} tone="ember" />
        <Operation title="Board" description={ring.bridgeConnected ? "Tablero conectado" : "Tablero en espera"} disabled={!ring.licensed} checked={ring.armed} onChange={(value) => runAction(() => api.setRingBoardArmed(value))} onOpen={() => setActiveTab("board")} tone="ember" />
        <Operation title="Drops" description={hunter.enabled ? hunterState(hunter.state) : "Captura de eventos"} checked={Boolean(hunter.enabled)} onChange={() => applyDropHunter(!dropHunterForm.enabled)} onOpen={() => setActiveTab("dropHunter")} />
      </div>
    </section>
    <div className="split">
      <section className="section" aria-labelledby="session-title">
        <h2 id="session-title" className="section-title">Sesión <span className="section-meta">{snapshot.connected ? "en vivo" : "en espera"}</span></h2>
        <div className="lead-figure lead-figure-inline"><span>{fixedPhase != null ? "Fase principal" : "Llegada del golpe"}</span><b className="num">{signedMs(fixedPhase != null ? fixedPhase : tickAimOf(snapshot))}</b></div>
        <dl className="readout"><div><dt>{timingSelectedMode ? "Ficha actual de Timing" : "Último disparo de Timing"}</dt><dd className={automaticPlayer ? "is-accent" : ""}>{timingTargetName}</dd></div><div><dt>Frontera del server</dt><dd className="mono">{auto ? `${signedMs(auto.boundaryMs)} · ${auto.samples} muestras` : "—"}</dd></div><div><dt>Variación</dt><dd className="mono">{auto?.sigmaMs == null ? "—" : `${auto.sigmaMs} ms`}</dd></div></dl>
      </section>
      <section className="section" aria-labelledby="room-title">
        <h2 id="room-title" className="section-title">En sala <span className="section-meta">{players.length} jugadores</span></h2>
        {players.length ? <ul className="roster">{players.slice(0, 5).map((p) => <li key={p.id}><button className={`roster-row ${p.id === automaticPlayer?.id ? "is-target" : ""}`} onClick={() => openPlayer(p.id)}>{p.self && avatarUrl && <img src={avatarUrl} alt="" className="roster-avatar" />}<span className="roster-name">{p.name || `Jugador ${p.id}`}</span><span className="roster-meta mono">{p.self ? "tú" : `#${p.id}`} · {p.x}, {p.y}</span>{p.id === automaticPlayer?.id && <span className="flag flag-accent">Timing</span>}{p.selected && <span className="flag">Fichado</span>}{p.self && <span className="flag">Tú</span>}<ArrowUpRight aria-hidden="true" size={15} className="roster-arrow" /></button></li>)}</ul> : <EmptyState icon={Users} title="Sin jugadores en la sala." text="Aparecen al conectar el cliente." compact />}
        <button className="link" onClick={() => setActiveTab("players")}>Ver jugadores <ArrowRight aria-hidden="true" size={14} /></button>
      </section>
    </div>
  </>;
}

// Our character as the game draws it, read by the launcher from the game page.
function ProfileCard({ snapshot, selfPlayer, avatarUrl, players }) {
  const [broken, setBroken] = useState("");
  const name = selfPlayer?.name || snapshot.game?.username || "Tu keko";
  const showImage = avatarUrl && broken !== avatarUrl;
  const meta = !snapshot.connected ? "Esperando al cliente del juego."
    : selfPlayer ? `En sala con ${Math.max(0, players.length - 1)} jugadores · posición ${selfPlayer.x}, ${selfPlayer.y}.`
    : "Cliente conectado, todavía sin sala.";
  return <section className="profile" aria-label="Tu personaje">
    <div className="profile-avatar">
      {showImage ? <img src={avatarUrl} alt={`Personaje de ${name}`} onError={() => setBroken(avatarUrl)} /> : <span aria-hidden="true">{name.slice(0, 2).toUpperCase()}</span>}
    </div>
    <div className="profile-text">
      <p className="profile-name">{name}</p>
      <p className="profile-meta"><span className={`dot dot-${snapshot.connected ? "good" : "muted"}`} aria-hidden="true" />{snapshot.connected ? "Conectado al juego" : "Sin conexión"}<span className="profile-sep" aria-hidden="true">·</span>{meta}</p>
    </div>
  </section>;
}

// The Hub opens BoomBang itself (it used to take ABRIR_HUB_Y_CONTROLLER.cmd).
const GAME_BUSY = ["login", "launching", "injecting"];
function GameSection({ game, connected, runAction }) {
  const [editing, setEditing] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  if (!game) return null;
  const busy = GAME_BUSY.includes(game.state);
  const showForm = !game.hasAccount || editing;
  const saveAndLaunch = async () => {
    if (await runAction(() => api.saveGameAccount(username, password))) {
      setPassword("");
      setEditing(false);
      runAction(() => api.launchGame());
    }
  };
  const meta = game.state === "ready" || connected ? "conectado" : busy ? "abriendo" : game.state === "twofa" ? "verificación" : "cerrado";
  return <section className="section" aria-labelledby="game-title">
    <h2 id="game-title" className="section-title">Juego <span className="section-meta">{meta}</span></h2>
    <div className="spec">
      <Setting title={game.clientFound ? "BoomBang HTML5 encontrado" : "No se encontró BoomBang HTML5"} text={game.clientFound ? "El Hub usará esta instalación para abrir el juego." : "Abre HTML5 una vez desde el launcher oficial y vuelve a buscar. Si está en otra carpeta, selecciona su archivo BoomBangHTML5.exe."}>
        <div className="controls">
          {!game.clientFound && <button className="btn" disabled={busy || game.state === "ready"} onClick={() => runAction(() => api.findGameClient())}>Buscar de nuevo</button>}
          <button className="btn btn-quiet" disabled={busy || game.state === "ready" || game.state === "twofa"} onClick={() => runAction(() => api.selectGameClient())}>{game.clientFound ? "Elegir otra instalación" : "Elegir BoomBang HTML5"}</button>
        </div>
      </Setting>
      {showForm ? <Setting title="Cuenta de BoomBang" text="Se guarda cifrada en este equipo. El Hub la usa para abrir el juego y conectarse solo." stack>
        <form className="controls" onSubmit={(e) => { e.preventDefault(); saveAndLaunch(); }}>
          <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Usuario" autoComplete="username" aria-label="Usuario de BoomBang" />
          <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Contraseña" autoComplete="current-password" aria-label="Contraseña de BoomBang" />
          <button className="btn btn-primary" type="submit" disabled={!username.trim() || !password}>Guardar y abrir el juego</button>
          {game.hasAccount && <button className="btn btn-quiet" type="button" onClick={() => setEditing(false)}>Cancelar</button>}
          {game.hasAccount && <button className="btn btn-quiet" type="button" onClick={async () => { if (await runAction(() => api.forgetGameAccount())) setEditing(false); }}>Borrar cuenta guardada</button>}
        </form>
      </Setting> : game.state === "twofa" ? <Setting title="Código de verificación" text="BoomBang te envió un código. Escríbelo para terminar de iniciar sesión." stack>
        <form className="controls" onSubmit={(e) => { e.preventDefault(); runAction(() => api.submitGameCode(code)).then(() => setCode("")); }}>
          <input className="input" value={code} onChange={(e) => setCode(e.target.value)} placeholder="Código" autoComplete="one-time-code" inputMode="numeric" aria-label="Código de verificación" />
          <button className="btn btn-primary" type="submit" disabled={!code.trim()}>Verificar</button>
        </form>
      </Setting> : <Setting title={game.state === "ready" ? "Juego conectado" : busy ? "Abriendo el juego" : "Abrir el juego"} text={<>{game.state === "ready" ? "El Hub está conectado al juego." : game.message || (connected ? "El cliente está conectado al Hub." : "El Hub abre BoomBang con tu cuenta y se conecta solo.")} Cuenta: <strong>{game.username}</strong>.</>}>
        <div className="controls">
          {game.state !== "ready" && <button className="btn btn-primary" disabled={busy || !game.clientFound} onClick={() => runAction(() => api.launchGame())}>{busy ? "Abriendo…" : "Abrir juego"}</button>}
          <button className="btn btn-quiet" disabled={busy} onClick={() => { setUsername(game.username); setEditing(true); }}>Cambiar cuenta</button>
        </div>
      </Setting>}
      {game.hasAccount && <Setting title="Registro de combate" text={game.diagnostics ? "Grabando cada pelea (paquetes, disparos y decisiones del timing) para revisarla después." : "Apagado. Actívalo para guardar las peleas y analizar por qué el timing hizo lo que hizo."}>
        <div className="controls">
          <button className="btn btn-quiet" onClick={() => runAction(() => api.openCombatLogs())}>Abrir carpeta</button>
          <Toggle label="Registro de combate" checked={Boolean(game.diagnostics)} onChange={(value) => runAction(() => api.setCombatLog(value))} />
        </div>
      </Setting>}
    </div>
  </section>;
}

function Operation({ title, description, checked, onChange, onOpen, tone, disabled }) {
  return <div className={`spec-row op ${checked ? "is-on" : ""}`}>
    <button className="op-title" onClick={onOpen}>{title}<ArrowUpRight aria-hidden="true" size={15} /></button>
    <span className="op-desc">{description}</span>
    <span className={`op-state ${checked && tone === "ember" ? "is-accent" : ""}`}>{checked ? "Activo" : "Apagado"}</span>
    <Toggle disabled={disabled} label={`Activar ${title}`} checked={checked} onChange={onChange} tone={tone} />
  </div>;
}

function UpdateNotice({ updates, runAction }) {
  if (!updates || !["available", "downloading", "installing"].includes(updates.status)) return null;
  return <div className="notice" role="status"><span>{updates.message}</span>{updates.status === "available" && <button className="btn" onClick={() => runAction(() => api.installUpdate())}>Descargar e instalar</button>}</div>;
}

function TimingView({ snapshot, applyTiming, runAction, setActiveTab }) {
  const on = Boolean(snapshot.timing?.enabled);
  const live = snapshot.tick;
  const auto = live?.auto;
  const fixedPhase = timingFixedPhase(snapshot);
  const combat = snapshot.combat || fallbackSnapshot.combat;
  const state = !on ? "En pausa" : !snapshot.connected ? "Esperando al cliente" : live?.synced ? "Sincronizado" : "Esperando el tick";
  const stateTone = !on ? "muted" : !snapshot.connected ? "warn" : live?.synced ? "good" : "warn";
  return <>
    <PageHeading title="Timing" description="Anticipa el golpe con el motor de Timing. Elige cómo seleccionar al rival." />
    <div className="columns">
      <div className="col-main">
        <section className="section" aria-labelledby="engine-title">
          <h2 id="engine-title" className="section-title">Motor</h2>
          <div className="master">
            <div><span className="master-label">Timing automático</span><b className={`master-state tone-${stateTone}`}>{state}</b></div>
            <Toggle label="Activar Timing automático" checked={on} onChange={applyTiming} large tone="ember" />
          </div>
          <div className="spec">
            <Setting title="Objetivo de Timing" text={snapshot.timing?.targetMode === "SELECTED" ? "Usa el mismo motor de Timing, exclusivamente contra el fichado. Sin ficha válida no golpea a otro jugador." : "Timing elige al rival por proximidad. Fichar en el juego no cambia su elección."} stack>
              <div className="segmented" role="group" aria-label="Objetivo de Timing">{[["AUTO", "Objetivo automático"], ["SELECTED", "Solo el fichado"]].map(([value, label]) => <button key={value} className={`seg ${(snapshot.timing?.targetMode || "AUTO") === value ? "is-on" : ""}`} aria-pressed={(snapshot.timing?.targetMode || "AUTO") === value} onClick={() => runAction(() => api.applyTiming({ targetMode: value }))}>{label}</button>)}</div>
            </Setting>
            <TimingHotkeyRow snapshot={snapshot} runAction={runAction} />
            <Setting title="Modo automático" text="Se mueve, golpea, sale al perder y se vuelve a inscribir al Ring (paga la entrada)."><Toggle label="Modo automático" disabled={!snapshot.ringBoard?.licensed} checked={snapshot.autoRun === true} onChange={(checked) => runAction(() => api.setAutoRun(checked))} /></Setting>
            <CocoSelfRow snapshot={snapshot} runAction={runAction} />
          </div>
        </section>
        <ShotSection snapshot={snapshot} runAction={runAction} />
        <section className="section" aria-labelledby="requeue-title">
          <h2 id="requeue-title" className="section-title">Reinscripción</h2>
          <div className="spec"><RequeueKeyRow snapshot={snapshot} runAction={runAction} /></div>
        </section>
        <section className="section" aria-labelledby="allies-title">
          <h2 id="allies-title" className="section-title">Objetivos</h2>
          <div className="spec"><AlliesRow snapshot={snapshot} setActiveTab={setActiveTab} /></div>
        </section>
        <section className="section" aria-labelledby="move-title">
          <h2 id="move-title" className="section-title">Movimiento</h2>
          <div className="spec"><Setting title="Caminar paso a paso" text="Avanzar una casilla por vez."><Toggle label="Caminar paso a paso" checked={snapshot.stepWalk !== false} onChange={(checked) => runAction(() => api.applyStepWalk({ enabled: checked }))} /></Setting></div>
        </section>
        {fixedPhase == null && <section className="section" aria-labelledby="exp-title">
          <h2 id="exp-title" className="section-title">Experimental</h2>
          <div className="spec"><Setting title="Disparo libre" text="Ignora el espaciado de 100 ms: dispara continuo en todo el tick. Puede rendir peor — es para medir."><Toggle label="Disparo libre" checked={snapshot.freeFire === true} onChange={(checked) => runAction(() => api.applyFreeFire({ enabled: checked }))} /></Setting></div>
        </section>}
        {fixedPhase == null && <AdvancedTiming snapshot={snapshot} runAction={runAction} />}
      </div>
      <aside className="col-side" aria-label="Lectura de sesión">
        <section className="panel"><h2 className="section-title">Actualizaciones</h2><p className="note">Versión {snapshot.updates?.version || "0.1.3"}. Se comprueban automáticamente al abrir el Hub.</p><p className="note" role="status">{snapshot.updates?.message}</p><button className="btn" disabled={["checking", "downloading", "installing"].includes(snapshot.updates?.status)} onClick={() => runAction(() => api.checkUpdates())}>Buscar actualizaciones</button></section>
        <section className="panel">
          <h2 className="section-title">Lectura de sesión <span className="section-meta">{on ? "activo" : "en pausa"}</span></h2>
          <div className="lead-figure"><span>{fixedPhase != null ? "Fase principal" : "Llegada del golpe"}</span><b className="num">{signedMs(fixedPhase != null ? fixedPhase : tickAimOf(snapshot))}</b></div>
          <dl className="figures figures-2">
            <Metric label="Carreras ganadas" value={auto?.recentWinRate == null ? "—" : `${auto.recentWinRate} %`} />
            <Metric label="Golpes / recibidos" value={`${combat.hits ?? 0} / ${combat.gotHit ?? 0}`} />
            <Metric label="Coco" value={snapshot.exit?.cocoActive ? `${(snapshot.exit.cocoRemainingMs / 1000).toFixed(1)} s` : "Libre"} tone={snapshot.exit?.cocoActive ? "warn" : ""} />
          </dl>
          <details className="disclosure">
            <summary><span>Diagnóstico del motor</span><span className="chev" aria-hidden="true" /></summary>
            <dl className="readout">
              <div><dt>Clics / reacciones</dt><dd className="mono">{live ? `${live.fired} / ${live.reactFired ?? 0}` : "—"}</dd></div>
              <div><dt>Frontera</dt><dd className="mono">{auto ? `${signedMs(auto.boundaryMs)} · ${auto.samples}` : "—"}</dd></div>
              <div><dt>Variación</dt><dd className="mono">{auto ? `${auto.sigmaMs} ms` : "—"}</dd></div>
              <div><dt>Llegada del rival</dt><dd className="mono">{auto?.rivalMedianMs == null ? "—" : signedMs(auto.rivalMedianMs)}</dd></div>
            </dl>
            {live?.lastSkip && <p className="note">Último tick sin clic: <span className="mono">{live.lastSkip}</span></p>}
            <div className="disclosure-foot"><p className="note">Reiniciar borra las mediciones guardadas.</p><button className="btn" onClick={() => runAction(() => Promise.all([api.resetTickAuto(), api.resetExit()]))}><RotateCcw aria-hidden="true" size={14} />Reiniciar mediciones</button></div>
          </details>
        </section>
        <p className="note">El estado y las mediciones se actualizan con tu sesión.</p>
      </aside>
    </div>
  </>;
}

// Advanced Timing (29/09): the knobs the server respects. Factory = measured best.
function AdvancedTiming({ snapshot, runAction }) {
  const a = snapshot.advanced || { burst: BURST_DEFAULT, ...ADVANCED_FACTORY };
  const set = (patch) => runAction(() => api.setAdvanced(patch));
  const factory = a.repeatMs === ADVANCED_FACTORY.repeatMs && a.sweep === ADVANCED_FACTORY.sweep && a.reactive === ADVANCED_FACTORY.reactive;
  return <details className="section advanced" open={!factory}><summary className="section-title"><span>Avanzado</span>{factory ? <span className="section-meta">de fábrica</span> : <span className="flag flag-warn">Modificado</span>}<span className="chev" aria-hidden="true" /></summary>
    <div className="spec">
      <Setting title="Segundo click al mismo rival" text="Otro click al mismo objetivo, N ms después del primero (desde 100: antes el server lo descarta). Reemplaza al barrido." stack>
        <div className="segmented" role="group" aria-label="Segundo click al mismo rival">{[0, 105, 110, 115, 120, 140].map((v) => <button key={v} className={`seg ${a.repeatMs === v ? "is-on" : ""}`} aria-pressed={a.repeatMs === v} onClick={() => set({ repeatMs: v })}>{v ? `+${v}` : "No"}</button>)}</div>
      </Setting>
      <Setting title="Barrido" text="Si el primer click fue a otro, un segundo click al otro candidato (~T+122)."><Toggle label="Barrido" checked={a.sweep !== false} onChange={(checked) => set({ sweep: checked })} /></Setting>
      <Setting title="Reacción" text="Click apenas se ve un contacto nuevo (llega ~T+175 por el ping)."><Toggle label="Reacción" checked={a.reactive !== false} onChange={(checked) => set({ reactive: checked })} /></Setting>
      <div className="spec-row spec-foot"><p className={factory ? "note" : "note is-warn"}>{factory ? "Valores de fábrica (lo que mejor midió)." : "Hay valores cambiados."}</p><button className="btn" onClick={() => set(ADVANCED_FACTORY)}><RotateCcw aria-hidden="true" size={14} />Valores de fábrica</button></div>
    </div>
  </details>;
}

// Re-queue key (29/09): pressed in the game window, leaves the Ring and joins again.
function TimingHotkeyRow({ snapshot, runAction }) {
  const [draft, setDraft] = useState(snapshot.timingHotkey ?? "F2");
  useEffect(() => { setDraft(snapshot.timingHotkey ?? "F2"); }, [snapshot.timingHotkey]);
  return <Setting title="Atajo para activar o pausar Timing" text="Funciona también con el juego en primer plano. Usa F1–F24 o una combinación como Ctrl+F3 o Alt+T." stack>
    <div className="controls">
      <input className="input" value={draft} maxLength={80} placeholder="F2" aria-label="Atajo de Timing" onChange={e => setDraft(e.target.value)} />
      <button className="btn" onClick={() => runAction(() => api.setTimingHotkey(draft))}>Guardar atajo</button>
      <button className="btn btn-quiet" onClick={() => runAction(() => api.setTimingHotkey(""))}>Quitar</button>
    </div>
  </Setting>;
}

function keyLabel(code) {
  if (!code) return "Ninguna";
  return code.replace(/^Key/, "").replace(/^Digit/, "").replace(/^Numpad/, "Num ");
}
// Self coco (01/10): auto fallback of the unlock guard, hotkey and manual throw.
function CocoSelfRow({ snapshot, runAction }) {
  const [capturing, setCapturing] = useState(false);
  const code = snapshot.cocoSelfKey || "";
  useEffect(() => {
    if (!capturing) return undefined;
    const onKey = (e) => {
      e.preventDefault();
      e.stopPropagation();
      setCapturing(false);
      if (e.code === "Escape") return;
      runAction(() => api.setCocoSelfKey(e.code));
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [capturing]);
  return <Setting title="Coco propio" text={<>{snapshot.cocoSelfMode !== "off" ? "Si el guardia no puede cubrir el desbloqueo (sin cocos, o el rival entró al contacto después de la última decisión), se tira el coco a sí mismo: 7 s sin recibir golpes, y al salir el turno se pelea con la fase configurada. Gasta uno de los 3 cocos de la ronda." : "El auto está apagado: el coco propio sale solo con la tecla o el botón."}{code ? ` Pulsa ${keyLabel(code)} en el juego para tirarlo al instante.` : ""}{capturing ? " Pulsa la tecla que quieras (Esc cancela)." : ""}</>} stack>
    <div className="controls">
      <div className="segmented" role="group" aria-label="Coco propio">
        <button className={`seg ${snapshot.cocoSelfMode !== "off" ? "is-on" : ""}`} aria-pressed={snapshot.cocoSelfMode !== "off"} onClick={() => runAction(() => api.setCocoSelf("auto"))}>Auto</button>
        <button className={`seg ${snapshot.cocoSelfMode === "off" ? "is-on" : ""}`} aria-pressed={snapshot.cocoSelfMode === "off"} onClick={() => runAction(() => api.setCocoSelf("off"))}>Apagado</button>
      </div>
      <kbd className={`key ${capturing ? "is-capturing" : ""} ${code ? "" : "is-empty"}`}>{capturing ? "…" : keyLabel(code)}</kbd>
      <button className={capturing ? "btn btn-primary" : "btn"} onClick={() => setCapturing(!capturing)}>{capturing ? "Esperando tecla" : "Elegir tecla"}</button>
      {code && <button className="btn btn-quiet" onClick={() => runAction(() => api.setCocoSelfKey(""))}>Quitar</button>}
      <button className="btn controls-end" onClick={() => runAction(() => api.cocoSelfNow())}>Tirarse coco ahora</button>
    </div>
  </Setting>;
}

function RequeueKeyRow({ snapshot, runAction }) {
  const [capturing, setCapturing] = useState(false);
  const code = snapshot.requeueKey || "";
  useEffect(() => {
    if (!capturing) return undefined;
    const onKey = (e) => {
      e.preventDefault();
      e.stopPropagation();
      setCapturing(false);
      if (e.code === "Escape") return;
      runAction(() => api.setRequeueKey(e.code));
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [capturing]);
  return <Setting title="Tecla para reinscribirse" text={<>{code ? `Pulsa ${keyLabel(code)} en el juego: sale del Ring al instante, va al lobby y se inscribe (paga la entrada).` : "Elige una tecla: en el juego, sale del Ring y se vuelve a inscribir."}{capturing ? " Pulsa la tecla que prefieras (Esc cancela)." : ""}</>} stack>
    <div className="controls">
      <kbd className={`key ${capturing ? "is-capturing" : ""} ${code ? "" : "is-empty"}`}>{capturing ? "…" : keyLabel(code)}</kbd>
      <button className={capturing ? "btn btn-primary" : "btn"} onClick={() => setCapturing(!capturing)}>{capturing ? "Esperando tecla" : "Elegir tecla"}</button>
      {code && <button className="btn btn-quiet" onClick={() => runAction(() => api.setRequeueKey(""))}>Quitar</button>}
      <button className="btn controls-end" onClick={() => runAction(() => api.requeueNow())}>Reinscribir ahora</button>
    </div>
  </Setting>;
}
const STEP_CLICK_DEFAULTS = { enabled: false, source: "PAIR", pattern: "SINGLE", momentMs: 375, startMs: 350, endMs: 400, intervalMs: 10 };
const STEP_CLICK_SOURCES = [["PAIR", "Yo o fichado"], ["SELF", "Mi keko"], ["SELECTED", "Fichado"], ["ROOM", "Movimiento en sala"]];
const STEP_CLICK_REASONS = {
  off: "Apagado", disconnected: "Esperando el juego", waiting_step: "Esperando un paso",
  no_selection: "Ficha a un enemigo en el juego", ally: "El fichado es un aliado",
  window_outside_step: "El envío queda fuera del paso", late: "Pedido tardío omitido",
  interval_too_small: "Máximo 256 pedidos por paso", no_sender: "El juego todavía no está listo",
  not_sent: "El cliente no envió el pedido", worker_error: "Error al programar el envío",
  send_error: "Falló el envío", ready: "Listo"
};
const STEP_MOTION_LABELS = { BOTH: "Ambos en movimiento", SELF: "Tú en movimiento · fichado quieto", SELECTED: "Tú quieto · fichado en movimiento", STILL: "Ambos quietos" };

function StepClickView({ snapshot, runAction }) {
  const config = stepClickDraft(snapshot.stepClick);
  const st = config.status;
  const [form, setForm] = useState(() => stepClickDraft(snapshot.stepClick));
  const [dirty, setDirty] = useState(false);
  const [phase, setPhase] = useState(null);
  const configKey = JSON.stringify([config.source, config.pattern, config.momentMs, config.startMs, config.endMs, config.intervalMs]);
  useEffect(() => { if (!dirty) setForm(stepClickDraft(snapshot.stepClick)); }, [configKey, dirty]);
  useEffect(() => {
    let raf;
    const received = performance.now();
    const animate = () => {
      const elapsed = performance.now() - received + (config.sampleAgeMs || 0);
      setPhase(snapshot.connected && st?.phaseMs != null && st.durationMs > 0 && elapsed < 2500
        ? Math.min(st.durationMs, st.phaseMs + (st.running ? elapsed : 0)) : null);
      raf = requestAnimationFrame(animate);
    };
    animate();
    return () => cancelAnimationFrame(raf);
  }, [st?.sampleAt, snapshot.connected, config.sampleAgeMs]);
  const valid = validStepClickDraft(form);
  const update = (key, value) => { setDirty(true); setForm(v => ({ ...v, [key]: value })); };
  const apply = async (enabled = config.enabled) => {
    if (enabled && !valid) return;
    const payload = enabled === false && !valid ? { enabled: false } : {
      enabled, source: form.source, pattern: form.pattern, momentMs: Number(form.momentMs),
      startMs: Number(form.startMs), endMs: Number(form.endMs), intervalMs: Number(form.intervalMs)
    };
    if (await runAction(() => api.applyStepClick(payload))) setDirty(false);
  };
  const duration = st?.durationMs > 0 ? st.durationMs : 600;
  const preparedPhases = stepClickPhases(form, duration);
  const allPhases = stepClickPhases(form);
  const running = phase != null && phase < duration;
  const state = !config.enabled ? "Apagado" : !snapshot.connected ? "Esperando el juego" : st && !st.enabled ? "Sin activar en el juego" : STEP_CLICK_REASONS[st?.reason] || "Esperando un paso";
  const number = value => value == null ? "—" : Math.round(value * 10) / 10;
  const crossing = selectStepCrossing(st);
  const crossingPhase = stepCrossingPhase(crossing);
  const comparable = Boolean(crossing && crossing.durationMs === duration && (!crossing.source || crossing.source === form.source));
  const sourceName = value => STEP_CLICK_SOURCES.find(([id]) => id === value)?.[1] || "Sin referencia";
  const referenceName = crossing ? crossing.referenceId === snapshot.selfId ? "tu keko" : crossing.referenceId === st?.targetId ? "el fichado" : `#${crossing.referenceId}` : "";
  const pct = value => `${Math.max(0, Math.min(100, value / duration * 100))}%`;
  const phasesLabel = allPhases.length <= 3 ? allPhases.map(value => `${value} ms`).join(" · ") : `${allPhases[0]}–${allPhases.at(-1)} ms · cada ${form.intervalMs} ms`;
  return <>
    <PageHeading title="Autoclick por paso" description="Elige cuándo enviar el golpe. Siempre va al enemigo que fichas en el juego." />
    <section className="section step-click-config">
      <div className="master">
        <div><span className="master-label">Autoclick independiente</span><b className={`master-state tone-${config.enabled ? "good" : "muted"}`}>{state}</b></div>
        <Toggle label="Activar Autoclick por paso" checked={config.enabled} disabled={!config.enabled && !valid} onChange={apply} large tone="ember" />
      </div>
      <p className="note">Al activarlo se apagan Timing, Board y Simon. Sin ficha válida no dispara; se respetan los aliados.</p>
      <form onSubmit={event => { event.preventDefault(); apply(); }}>
        <div className="spec">
          <Setting title="Envío por paso" text="Un golpe envía un único pedido en el momento elegido. Tres intentos agrega uno 20 ms antes y otro 20 ms después." stack>
            <div className="segmented" role="group" aria-label="Envío por paso">{[["SINGLE", "Un golpe"], ["TRIPLE", "3 intentos"], ["CUSTOM", "Personalizado"]].map(([value, label]) => <button type="button" key={value} className={`seg ${form.pattern === value ? "is-on" : ""}`} aria-pressed={form.pattern === value} onClick={() => update("pattern", value)}>{label}</button>)}</div>
          </Setting>
          {form.pattern !== "CUSTOM" ? <Setting title="Momento" text={form.pattern === "TRIPLE" ? "El pedido central sale aquí; los otros salen 20 ms antes y después." : "Milisegundos desde el inicio del paso recibido. Un único pedido se programa aquí."} stack>
            <label className="step-click-moment"><span className="sr-only">Momento de envío en ms</span><input className="input mono" type="number" required step="1" min="0" max="4999" value={form.momentMs} onChange={event => update("momentMs", event.target.value)} /><span>ms</span></label>
          </Setting> : <Setting title="Ventana personalizada" text="Tu configuración anterior se conserva. El primer pedido sale al inicio; el final queda excluido." stack>
            <div className="step-click-fields">{[["startMs", "Inicio (ms)", 0, 4999], ["endMs", "Final (ms)", 1, 5000], ["intervalMs", "Intervalo (ms)", 1, 5000]].map(([key, label, min, max]) => <label key={key}>{label}<input className="input" type="number" required step="1" min={min} max={max} value={form[key]} onChange={event => update(key, event.target.value)} /></label>)}</div>
          </Setting>}
        </div>
        <div className="step-click-plan"><b>{valid ? phasesLabel : "Revisa los valores"}</b><span>{valid ? `${allPhases.length} pedido${allPhases.length === 1 ? "" : "s"} por paso, si caben en su duración.` : form.pattern === "CUSTOM" ? "Final mayor al inicio, intervalo de 1 a 5000 ms y máximo 256 pedidos." : "Usa un momento entero de 0 a 4999 ms."}</span></div>
        <div className="controls"><button type="submit" className="btn btn-primary" disabled={!dirty || !valid}>Aplicar cambios</button><span className="note">{dirty ? "Vista previa · cambios sin aplicar." : "Configuración aplicada."}</span></div>
        <details className="disclosure step-click-options">
          <summary><span>Opciones · referencia del paso</span><span className="chev" aria-hidden="true" /></summary>
          <div className="spec"><Setting title="Referencia" text="Yo o fichado sigue a cualquiera de los dos, incluso si uno está quieto. Cada paso nuevo renueva el reloj." stack>
            <div className="segmented" role="group" aria-label="Referencia del paso">{STEP_CLICK_SOURCES.map(([value, label]) => <button type="button" key={value} className={`seg ${form.source === value ? "is-on" : ""}`} aria-pressed={form.source === value} onClick={() => update("source", value)}>{label}</button>)}</div>
          </Setting></div>
        </details>
      </form>
    </section>
    <section className="section" aria-labelledby="step-live-title">
      <h2 id="step-live-title" className="section-title">Paso y envíos <span className="section-meta">{sourceName(form.source)}</span></h2>
      <div className="step-click-clock"><b className="num">{number(phase)} <small>/ {st?.durationMs || "—"} ms</small></b><span>{st?.targetId >= 0 ? st.targetName || `Fichado #${st.targetId}` : "Sin enemigo fichado"} · {running ? "en movimiento" : "esperando paso"}</span></div>
      <div className="step-click-track" role="progressbar" aria-label="Milisegundos del paso" aria-valuemin={0} aria-valuemax={duration} aria-valuenow={Math.round(phase || 0)}>
        {form.pattern === "CUSTOM" && valid && <span className="step-click-window" style={{ left: pct(Number(form.startMs)), width: pct(Math.max(0, Math.min(duration, Number(form.endMs)) - Math.min(duration, Number(form.startMs)))) }} />}
        {preparedPhases.map(value => <span key={value} className="step-click-send-point" style={{ left: pct(value) }} title={`Pedido configurado: ${value} ms`} />)}
        {comparable && <span className="step-click-cross-point" style={{ left: pct(crossingPhase) }} title={`Último cruce visual completo: ${number(crossingPhase)} ms`} />}
        {phase != null && <span className="step-click-needle" style={{ left: pct(phase) }} />}
      </div>
      <div className="step-click-axis"><span>0 ms</span><span>{duration / 2} ms</span><span>{duration} ms</span></div>
      <div className="step-click-legend"><span>Rojo · pedidos configurados</span><span>Azul · último cruce visual completo</span></div>
      {valid && preparedPhases.length < allPhases.length && st?.durationMs > 0 && <p className="note is-warn">{allPhases.length - preparedPhases.length} pedido(s) quedan fuera de este paso de {duration} ms y se omiten.</p>}
      <div className="step-click-cross-label" aria-live="polite">{crossing ? <>
        <b>Cruce visual completo: {number(crossingPhase)} ms en un paso de {number(crossing.durationMs)} ms</b>
        <span>{STEP_MOTION_LABELS[crossing.motionKind] || "Movimiento medido"} · referencia: {sourceName(crossing.source)}{crossing.referenceId != null ? ` (${referenceName})` : ""}{crossing.clockSource === "native_animation" ? " · animación nativa" : crossing.clockSource ? " · paso recibido" : ""}</span>
        {!comparable && <span>La referencia o duración es distinta; su azul no se superpone a este paso.</span>}
      </> : <span>Esperando un cruce completo con el fichado. Las muestras parciales no cambian el azul.</span>}</div>
      <p className="note">El azul mide cercanía visual, no un golpe aceptado. Puede variar según cómo se muevan ambos; se conserva hasta terminar el siguiente cruce.</p>
      <dl className="readout step-click-readout">
        <div><dt>Pedidos enviados</dt><dd className="num">{st?.sent ?? 0}</dd></div>
        <div><dt>Pedidos omitidos</dt><dd className="num">{st?.skipped ?? 0}</dd></div>
        <div><dt>Último envío</dt><dd className="num">{number(st?.last?.phaseMs)} ms</dd></div>
        {st?.errors > 0 && <div><dt>Errores de envío</dt><dd className="num is-warn">{st.errors}</dd></div>}
      </dl>
      {st?.last && !st.last.sent && <p className="note">Último pedido: {STEP_CLICK_REASONS[st.last.reason] || st.last.reason}.</p>}
    </section>
  </>;
}


// Simon Dice (06/10): the runtime reads each cartel and touches the asked face.
const SIMON_DELAYS = [[0, "Al instante"], [150, "150 ms"], [300, "300 ms"], [600, "600 ms"]];
function SimonView({ snapshot, runAction }) {
  const simon = snapshot.simon || { enabled: false, delayMs: 0, status: null };
  const st = simon.status;
  const last = st?.last;
  const on = simon.enabled === true;
  const state = !on ? "Apagado" : !snapshot.connected ? "Esperando el juego" : st?.inRoom ? "Jugando" : "Listo";
  const tone = !on ? "muted" : !snapshot.connected ? "warn" : "good";
  const lastText = !last ? "Todavía no hubo carteles." : last.error ? `Ronda ${last.round}: no se pudo leer el cartel (${last.error}).` : last.go === false ? `Ronda ${last.round}: banda roja, no tocó nada.` : `Ronda ${last.round}: tocó la casilla ${(last.cell ?? 0) + 1} de 8${last.totalMs != null ? ` en ${last.totalMs} ms` : ""}.`;
  return <>
    <PageHeading title="Simon Dice" description="Lee cada cartel y toca la cara pedida. Con la banda roja a rayas no toca nada." />
    <section className="section" aria-labelledby="simon-title">
      <div className="master">
        <div><span className="master-label">Simon Dice automático</span><b className={`master-state tone-${tone}`}>{state}</b></div>
        <Toggle label="Activar Simon Dice automático" checked={on} onChange={(checked) => runAction(() => api.applySimon({ enabled: checked }))} large tone="ember" />
      </div>
      <div className="spec">
        <Setting title="Espera antes de tocar" text="Al instante gana el duelo final, donde cae el más lento. Con espera se ve más humano; cada ronda da menos tiempo (de 6 s a ~1 s)." stack>
          <div className="segmented" role="group" aria-label="Espera antes de tocar">{SIMON_DELAYS.map(([v, label]) => <button key={v} className={`seg ${(simon.delayMs || 0) === v ? "is-on" : ""}`} aria-pressed={(simon.delayMs || 0) === v} onClick={() => runAction(() => api.applySimon({ delayMs: v }))}>{label}</button>)}</div>
        </Setting>
      </div>
    </section>
    <section className="section" aria-labelledby="simon-stats-title">
      <h2 id="simon-stats-title" className="section-title">Esta sesión <span className="section-meta">{st?.inRoom ? "en la sala de Simon" : "fuera de la sala"}</span></h2>
      <dl className="readout">
        <div><dt>Partidas</dt><dd className="num">{st?.games ?? 0}</dd></div>
        <div><dt>Caras tocadas</dt><dd className="num">{st?.answered ?? 0}</dd></div>
        <div><dt>Rojas sin tocar</dt><dd className="num">{st?.skippedRed ?? 0}</dd></div>
        <div><dt>Victorias</dt><dd className="num">{st?.wins ?? 0}</dd></div>
        <div><dt>Errores de lectura</dt><dd className={`num ${st?.errors ? "is-warn" : ""}`}>{st?.errors ?? 0}</dd></div>
      </dl>
      <p className="note">{lastText}</p>
    </section>
  </>;
}

// Allies (06/10): the players the bot never punches live in their own view.
function allyLabel(ally) { return ally.name || `Cuenta ${ally.accountId}`; }
function AlliesRow({ snapshot, setActiveTab }) {
  const allies = Array.isArray(snapshot.allies) ? snapshot.allies : [];
  const text = allies.length ? `Nunca les pega a ${allies.slice(0, 3).map(allyLabel).join(" · ")}${allies.length > 3 ? ` y ${allies.length - 3} más` : ""}.` : "No hay aliados excluidos.";
  return <Setting title="Aliados" text={text}>
    <button className="btn" onClick={() => setActiveTab("allies")}>Elegir aliados <ArrowRight aria-hidden="true" size={14} /></button>
  </Setting>;
}

// The keko as the room draws it; the name's initial until the game hands it over.
function Keko({ url, name, size }) {
  return <span className={`keko ${size === "lg" ? "keko-lg" : ""}`} aria-hidden="true">{url ? <img src={url} alt="" draggable="false" /> : <b>{String(name || "?").trim().charAt(0).toUpperCase() || "?"}</b>}</span>;
}

// Real account ids are 7-8 digits; without one the game falls back to the slot id.
const isAccountId = (value) => Number.isSafeInteger(Number(value)) && Number(value) >= 1000;

function AlliesView({ snapshot, players, portraits, runAction }) {
  const allies = Array.isArray(snapshot.allies) ? snapshot.allies : [];
  const [name, setName] = useState("");
  const allyFor = (p) => allies.find((a) => (a.accountId && a.accountId === p.userId) || (!a.accountId && a.name && a.name.toLowerCase() === String(p.name || "").trim().toLowerCase()));
  const room = players.filter((p) => !p.self && p.id !== snapshot.selfId && isAccountId(p.userId));
  const hereIds = new Set(room.map((p) => p.userId));
  const toggle = (p) => runAction(() => api.toggleAlly({ accountId: p.userId, name: p.name }));
  const add = async () => { if (await runAction(() => api.addAllyByName(name))) setName(""); };
  const roomAllies = room.filter((p) => allyFor(p)).length;
  return <>
    <PageHeading title="Aliados" description="El bot nunca les pega. Toca un jugador de la sala para sumarlo o quitarlo." />
    <section className="section" aria-labelledby="room-allies-title">
      <h2 id="room-allies-title" className="section-title">En la sala <span className="section-meta">{snapshot.connected ? `${room.length} ${room.length === 1 ? "jugador" : "jugadores"} · ${roomAllies} ${roomAllies === 1 ? "aliado" : "aliados"}` : "sin juego conectado"}</span></h2>
      {room.length ? <ul className="keko-grid">{room.map((p) => { const on = Boolean(allyFor(p)); return <li key={p.id}>
        <button type="button" className={`keko-pick ${on ? "is-ally" : ""}`} aria-pressed={on} onClick={() => toggle(p)} title={on ? `Quitar a ${p.name} de aliados` : `Sumar a ${p.name} como aliado`}>
          <Keko url={portraits[p.userId]} name={p.name} size="lg" />
          <span className="keko-name">{p.name || `Jugador ${p.id}`}</span>
          <span className="keko-meta mono">#{p.id}</span>
          <span className={`keko-state ${on ? "is-on" : ""}`}>{on ? <><Check aria-hidden="true" size={13} strokeWidth={2.2} />Aliado</> : "Sumar"}</span>
        </button>
      </li>; })}</ul> : <EmptyState icon={Users} title={snapshot.connected ? "No hay otros jugadores en la sala." : "Conecta el juego para ver la sala."} text="Los jugadores de la sala aparecen acá con su keko." compact />}
    </section>
    <section className="section" aria-labelledby="saved-allies-title">
      <h2 id="saved-allies-title" className="section-title">Tus aliados <span className="section-meta">{allies.length}</span></h2>
      {allies.length ? <ul className="ally-list">{allies.map((a) => { const key = a.accountId ? `a${a.accountId}` : `n${a.name}`; const here = a.accountId ? hereIds.has(a.accountId) : room.some((p) => String(p.name || "").trim().toLowerCase() === a.name.toLowerCase()); return <li key={key} className="ally-row">
        <Keko url={a.accountId ? portraits[a.accountId] : ""} name={a.name} />
        <span className="ally-text"><span className="ally-name">{allyLabel(a)}</span><span className="ally-meta mono">{a.accountId ? `cuenta ${a.accountId}` : "por nombre exacto"}</span></span>
        {here && <span className="flag">En la sala</span>}
        <button type="button" className="icon-btn" onClick={() => runAction(() => api.removeAlly({ accountId: a.accountId, name: a.name }))} aria-label={`Quitar a ${allyLabel(a)} de aliados`} title="Quitar"><X aria-hidden="true" size={15} /></button>
      </li>; })}</ul> : <EmptyState icon={ShieldCheck} title="Todavía no tienes aliados." text="Tócalos en la sala o agrégalos por nombre." compact />}
      <div className="spec"><Setting title="Agregar por nombre" text="Para alguien que no está en la sala. Nombre exacto, uno por vez; se vincula a su cuenta cuando aparezca." stack>
        <form className="controls" onSubmit={(e) => { e.preventDefault(); add(); }}>
          <input className="input" value={name} maxLength={40} placeholder="Nombre exacto" onChange={(e) => setName(e.target.value)} aria-label="Nombre del aliado" />
          <button type="submit" className={name.trim() ? "btn btn-primary" : "btn"} disabled={!name.trim()}><UserPlus aria-hidden="true" size={15} />Agregar</button>
        </form>
      </Setting></div>
    </section>
  </>;
}

// Disparo (0.1.25): when the tick click lands (T+0..100, T+8 by default) and how
// many requests each shot sends (1..100, 1 by default). Both are manual.
function ShotSection({ snapshot, runAction }) {
  const fixedPhase = timingFixedPhase(snapshot);
  const aim = tickAimOf(snapshot);
  const burst = Number(snapshot.advanced?.burst) || BURST_DEFAULT;
  const aimTone = aim < 5 || aim > 20 ? "warn" : "";
  const burstTone = burst > 20 ? "warn" : "";
  return <section className="section" aria-labelledby="shot-title">
    <h2 id="shot-title" className="section-title">Disparo</h2>
    {fixedPhase != null ? <div className="spec"><Setting title="Fase principal" text={<>Perfil de diagnóstico: un pedido por paso con fase fija {signedMs(fixedPhase)}.</>}><b className="mono">{signedMs(fixedPhase)}</b></Setting></div>
      : <div className="dial-grid">
        <Dial label="Llegada del golpe" prefix="T+" unit="ms" value={aim} min={0} max={TICK_AIM_MAX} defaultValue={TICK_AIM_DEFAULT} presets={[0, 5, 8, 10, 15, 20]} tone={aimTone} onCommit={(value) => runAction(() => api.setTickAim(value))} />
        <Dial label="Clicks por disparo" unit={burst === 1 ? "click" : "clicks"} value={burst} min={1} max={BURST_MAX} defaultValue={BURST_DEFAULT} presets={[1, 2, 3, 5, 10]} tone={burstTone} onCommit={(value) => runAction(() => api.setAdvanced({ burst: value }))} />
      </div>}
  </section>;
}

// A number the user sets by hand: slider, field, -/+ and quick values. Commits on release.
function Dial({ label, prefix = "", unit, value, min, max, defaultValue, presets, tone, onCommit }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => { setDraft(String(value)); }, [value]);
  const fit = (n) => Math.min(max, Math.max(min, Math.round(n)));
  const shown = draft !== "" && Number.isFinite(Number(draft)) ? fit(Number(draft)) : value;
  const commit = (raw) => {
    const n = Number(raw);
    if (raw === "" || !Number.isFinite(n)) { setDraft(String(value)); return; }
    const next = fit(n);
    setDraft(String(next));
    if (next !== value) onCommit(next);
  };
  const fill = `${((shown - min) / (max - min)) * 100}%`;
  return <div className={`dial ${tone === "warn" ? "is-warn" : ""}`}>
    <div className="dial-head">
      <span className="dial-label">{label}</span>
      {value !== defaultValue && <button type="button" className="dial-reset" onClick={() => commit(defaultValue)}><RotateCcw aria-hidden="true" size={12} />{prefix}{defaultValue}</button>}
    </div>
    <p className="dial-value num"><span className="dial-prefix">{prefix}</span>{shown}<span className="dial-unit">{unit}</span></p>
    <input className="dial-range" type="range" min={min} max={max} step={1} value={shown} style={{ "--fill": fill }} aria-label={label}
      onChange={(event) => setDraft(event.target.value)} onPointerUp={(event) => commit(event.currentTarget.value)} onKeyUp={(event) => commit(event.currentTarget.value)} onBlur={(event) => commit(event.currentTarget.value)} />
    <div className="dial-scale mono" aria-hidden="true"><span>{prefix}{min}</span><span>{prefix}{max}</span></div>
    <div className="dial-row">
      <div className="stepper">
        <button type="button" className="stepper-btn" aria-label={`Restar 1 a ${label}`} disabled={value <= min} onClick={() => commit(value - 1)}>−</button>
        <input className="dial-number mono" type="number" inputMode="numeric" min={min} max={max} value={draft} aria-label={`${label} (número)`}
          onChange={(event) => setDraft(event.target.value)} onBlur={(event) => commit(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") commit(event.currentTarget.value); }} />
        <button type="button" className="stepper-btn" aria-label={`Sumar 1 a ${label}`} disabled={value >= max} onClick={() => commit(value + 1)}>+</button>
      </div>
      <div className="segmented" role="group" aria-label={`${label}: valores rápidos`}>{presets.map((v) => <button type="button" key={v} className={`seg ${value === v ? "is-on" : ""}`} aria-pressed={value === v} onClick={() => commit(v)}>{prefix}{v}</button>)}</div>
    </div>
  </div>;
}

function BoardView({ snapshot, runAction }) {
  const ring = snapshot.ringBoard || fallbackSnapshot.ringBoard;
  const [showBoard, setShowBoard] = useState(false);
  const flags = [["moveAssist", "set_move_assist", "Asistir movimiento"], ["highPower", "set_high_power", "Alta potencia"]];
  return <div className="board">
    <PageHeading title="Board" description={<span className="board-line"><span className="board-line-state"><span className={`dot dot-${ring.bridgeConnected ? "good" : "muted"}`} aria-hidden="true" />{!ring.licensed ? "Vista previa" : ring.bridgeConnected ? "Tablero conectado" : "Tablero sin conexión"}</span><span>Escena <b className="mono">{ring.sceneHash || "—"}</b></span><span>Sensor <b className="mono">{ring.lastSensorAgeMs == null ? "—" : `${Math.round(ring.lastSensorAgeMs)} ms`}</b></span><span>Último <b className="mono">{ring.lastCommand || "—"}</b></span></span>} action={<button disabled={!ring.licensed} className={ring.armed ? "btn btn-danger" : "btn btn-outline-accent"} onClick={() => runAction(() => api.setRingBoardArmed(!ring.armed))}><span className="tile-mark" aria-hidden="true" />{ring.armed ? "Desarmar Board" : "Armar Board"}</button>} />
    {!ring.licensed && <p className="board-license-note">Necesitas una licencia Pro para activar Board. Contacta con tu distribuidor para ampliar tu licencia.</p>}
    <fieldset className="board-tools" disabled={!ring.licensed} aria-label="Controles de Board Pro">
      {flags.map(([key, action, label]) => <button key={key} className={`check ${ring[key] ? "is-on" : ""}`} aria-pressed={Boolean(ring[key])} onClick={() => runAction(() => api.ringBoardAction(action, !ring[key]))}><span className="check-box" aria-hidden="true" />{label}</button>)}
      <MoveBrainRow ring={ring} runAction={runAction} />
      <div className="board-tools-end"><button className="btn" onClick={() => runAction(() => api.ringBoardAction("mark_scene_allowed", true))}>Permitir sala<ArrowUpRight aria-hidden="true" size={14} /></button><button className="btn icon-only" aria-label="Reiniciar Board" title="Reiniciar Board" onClick={() => runAction(() => api.ringBoardAction("reset_runtime", true))}><RotateCcw aria-hidden="true" size={15} /></button></div>
    </fieldset>
    <div className="board-stage">{ring.licensed ? <><iframe className="board-frame" title="Ring Board" src={ring.url || "http://127.0.0.1:18445"} />{!ring.bridgeConnected && !showBoard && <div className="board-empty"><EmptyState icon={Grid2X2} title="Tablero sin conexión." text="Se muestra cuando el bridge del tablero conecta." action={<button className="btn" onClick={() => setShowBoard(true)}>Mostrar tablero <ArrowUpRight aria-hidden="true" size={14} /></button>} /></div>}</> : <BoardPreview />}</div>
  </div>;
}

function BoardPreview() {
  const tiles = [];
  for (let x = 0; x < 11; x++) for (let y = 0; y < 11; y++) {
    if ([0, 10].includes(x) && [0, 10].includes(y)) continue;
    const cx = 340 + (x - y) * 26, cy = 35 + (x + y) * 13;
    const contact = x >= 5 && x <= 7 && y >= 4 && y <= 6;
    tiles.push(<polygon key={`${x}-${y}`} className={contact ? "preview-tile is-contact" : "preview-tile"} points={`${cx},${cy-12} ${cx+25},${cy} ${cx},${cy+12} ${cx-25},${cy}`} />);
  }
  return <div className="board-preview">
    <aside className="preview-readout"><h3 className="section-title">Lectura del Ring</h3><p className="note">Ejemplo sin conexión</p><dl className="readout"><div><dt>Jugador</dt><dd>Tu personaje</dd></div><div><dt>Objetivo</dt><dd>Rival</dd></div><div><dt>Movimiento</dt><dd>Próxima casilla</dd></div><div><dt>Contacto</dt><dd>Zona marcada</dd></div></dl></aside>
    <div className="preview-map"><svg viewBox="0 0 680 340" role="img" aria-label="Vista previa de ejemplo del Ring, con jugadores y trayectoria. No está conectada al juego.">{tiles}<path className="preview-path" d="M 314 152 L 340 165 L 366 152" /><g className="preview-self"><circle cx="314" cy="152" r="8" /><text x="314" y="131" textAnchor="middle">TÚ</text></g><g className="preview-rival"><circle cx="366" cy="178" r="8" /><text x="366" y="207" textAnchor="middle">RIVAL</text></g></svg><div className="preview-legend"><span><i className="preview-self-dot" />Tu posición</span><span><i className="preview-rival-dot" />Objetivo</span><span>··· Próximo paso</span><span>Zona de contacto</span></div></div>
  </div>;
}

// Live movement brain (27/09): compare them session by session against real rivals.
function MoveBrainRow({ ring, runAction }) {
  const options = [["planner", 0, "Planner", "Planificación del movimiento."], ["tile", 1, "Tile", "Lectura del tablero por tick."], ["tile2", 2, "Tile2", "Evaluación de posiciones y probabilidades."], ["tile3", 3, "Ofensivo", "Movimiento orientado al contacto."]];
  const current = ring.moveBrain || "planner";
  const pending = ring.moveBrainWanted && ring.moveBrainWanted !== current;
  const info = options.find((o) => o[0] === (ring.moveBrainWanted || current));
  return <div className="brain"><span className="brain-label">Cerebro</span>
    <div className="segmented" role="group" aria-label="Cerebro de movimiento">{options.map(([key, value, label]) => <button key={key} className={`seg ${(ring.moveBrainWanted || current) === key ? "is-on" : ""}`} aria-pressed={(ring.moveBrainWanted || current) === key} onClick={() => runAction(() => api.ringBoardAction("set_move_brain", value))}>{label}</button>)}</div>
    <p className="brain-info" title={info ? info[3] : ""}>{info ? info[3] : ""}{pending ? <span className="is-warn"> Aplicando…</span> : ""}</p></div>;
}

function DropHunterView({ snapshot, dropHunterForm, updateDropHunter, applyDropHunter, dropHunterDirty }) {
  const hunter = snapshot.dropHunter || fallbackSnapshot.dropHunter;
  const hasDrop = hunter.dropId >= 0;
  const age = hunter.lastAt ? `${Math.max(0, Math.round((Date.now() - hunter.lastAt) / 1000))} s` : "—";
  return <><PageHeading title="Drops" description="Captura de drops y eventos de la sala." />
    <div className="columns">
      <section className="section col-main" aria-labelledby="drops-title">
        <h2 id="drops-title" className="section-title">Captura <span className={`section-meta ${dropHunterDirty ? "is-warn" : ""}`}>{dropHunterDirty ? "sin aplicar" : "configuración"}</span></h2>
        <div className="spec">
          <Setting title="Activar captura" text="Buscar drops en la sala."><Toggle label="Activar captura de drops" checked={dropHunterForm.enabled} onChange={(checked) => updateDropHunter({ enabled: checked })} /></Setting>
          <Setting title="Reclamar automáticamente" text="Recoger el drop al llegar."><Toggle label="Reclamar automáticamente" checked={dropHunterForm.autoClaim} onChange={(checked) => updateDropHunter({ autoClaim: checked })} /></Setting>
          <div className="spec-row spec-foot"><div className="controls"><button className="btn btn-primary" onClick={() => applyDropHunter(dropHunterForm.enabled)}>{dropHunterDirty ? "Aplicar cambios" : "Aplicar"}<ArrowRight aria-hidden="true" size={15} /></button><button className="btn" onClick={() => applyDropHunter(false)}>Apagar</button></div><p className={dropHunterDirty ? "note is-warn" : "note"}>{dropHunterDirty ? "Tienes cambios pendientes de aplicar." : "La configuración está al día."}</p></div>
        </div>
      </section>
      <aside className="col-side">
        <section className="panel" aria-labelledby="signal-title">
          <h2 id="signal-title" className="section-title">Señal del cliente <span className="section-meta">{hunter.enabled ? "activo" : "en pausa"}</span></h2>
          <p className="lead-state"><span className={`dot dot-${hunter.enabled ? "good" : "muted"}`} aria-hidden="true" />{hunterState(hunter.state)}</p>
          <dl className="figures figures-3"><Metric label="Drop" value={hasDrop ? `#${hunter.dropId}` : "—"} /><Metric label="Posición" value={hasDrop ? `${hunter.x}, ${hunter.y}` : "—"} /><Metric label="Hace" value={age} /></dl>
          <dl className="readout"><div><dt>Palabra clave</dt><dd className="mono">{hunter.keyword || "—"}</dd></div><div><dt>Regreso automático</dt><dd>{hunter.autoReturn === false ? "No" : "Sí"}</dd></div><div><dt>Reclamo automático</dt><dd>{hunter.autoClaim === false ? "No" : "Sí"}</dd></div></dl>
          <pre className="event">{hunter.lastEvent || "Todavía no hay eventos."}</pre>
        </section>
      </aside>
    </div>
  </>;
}

function PlayersView({ snapshot, filteredPlayers, selectedPlayer, playerFilter, setPlayerFilter, runAction }) {
  return <><PageHeading title="Jugadores" description={`${(snapshot.players || []).length} en la sala. Fichar un personaje no cambia los golpes automáticos de Timing.`} />
    <div className="toolbar"><Search value={playerFilter} onChange={setPlayerFilter} label="Buscar jugadores" placeholder="Nombre, ID o usuario" /><p className={`toolbar-note ${selectedPlayer ? "has-target" : ""}`}><Target aria-hidden="true" size={14} strokeWidth={1.8} />{selectedPlayer ? <>Fichado <b>{selectedPlayer.name}</b> <span className="mono">#{selectedPlayer.id}</span></> : "Fichar es opcional"}</p></div>
    <div className="table-surface"><table><thead><tr><th scope="col"><span className="sr-only">Marca</span></th><th scope="col">Jugador</th><th scope="col">ID</th><th scope="col">Usuario</th><th scope="col">Estado</th><th scope="col">Skin</th><th scope="col" className="num-col">X</th><th scope="col" className="num-col">Y</th><th scope="col" className="num-col">Dir.</th><th scope="col" className="num-col">Coco</th></tr></thead><tbody>{filteredPlayers.map((p) => { const isTarget = p.selected || p.id === snapshot.selectedTarget; const mark = ({ SELF: "TÚ", SEL: "FICHADO", TARGET: "FICHADO" })[p.mark] || p.mark; return <tr key={p.id} className={`${p.self ? "is-self" : ""} ${isTarget ? "is-target" : ""}`} onClick={() => runAction(() => api.selectTarget(p.id))}><td className="mark-cell">{mark && <span className={`flag ${p.self ? "" : "flag-accent"}`}>{mark === "TÚ" ? "Tú" : mark === "FICHADO" ? "Fichado" : mark}</span>}</td><td className="name-cell"><button onClick={(event) => { event.stopPropagation(); runAction(() => api.selectTarget(p.id)); }} aria-label={`Seleccionar a ${p.name || p.id}`} aria-pressed={p.selected || p.id === snapshot.selectedTarget}>{p.name || `Jugador ${p.id}`}{p.self && <small>tú</small>}</button></td><td className="mono">{p.id}</td><td className="mono">{p.userId}</td><td className="mono">{p.state}</td><td>{p.skin}</td><td className="num-col mono">{p.x}</td><td className="num-col mono">{p.y}</td><td className="num-col mono">{p.orient}</td><td className={`num-col mono ${p.cocoMs > 0 ? "is-warn" : ""}`}>{p.cocoMs > 0 ? `${(p.cocoMs / 1000).toFixed(1)} s` : "—"}</td></tr>; })}</tbody></table>{!filteredPlayers.length && <EmptyState icon={Users} title={playerFilter ? "Ninguna coincidencia." : "Todavía no hay nadie."} text={playerFilter ? "Prueba otro nombre o identificador." : "Los jugadores aparecen al conectar el cliente."} action={playerFilter && <button className="btn" onClick={() => setPlayerFilter("")}>Quitar filtro <X aria-hidden="true" size={14} /></button>} />}</div>
  </>;
}

// Presentation only: how a log line reads (losses first, then hits, then warnings).
function logKind(text) {
  const t = String(text || "").toLowerCase();
  if (/recibid|perdid|no se pudo|error|fall[oó]|rechaz/.test(t)) return "loss";
  if (/golpe a|aceptad/.test(t)) return "hit";
  if (/coco|sin clic|demorad|aviso/.test(t)) return "warn";
  return "info";
}
function LogsView({ logs, runAction }) {
  const [filter, setFilter] = useState("");
  const filtered = useMemo(() => logs.filter((entry) => `${entry.ts} ${entry.text}`.toLowerCase().includes(filter.trim().toLowerCase())), [logs, filter]);
  return <><PageHeading title="Registro" description="Lo que pasa en la sesión, en orden." /><div className="toolbar"><Search value={filter} onChange={setFilter} label="Filtrar registro" placeholder="Buscar en el registro" /><div className="toolbar-end"><span className="toolbar-note mono">{filtered.length}{filter ? ` / ${logs.length}` : ""} líneas</span><button className="btn" onClick={() => runAction(() => api.clearLogs())}><Trash2 aria-hidden="true" size={14} />Limpiar</button></div></div><div className="log" aria-label="Registro de actividad">{filtered.map((entry, i) => <div className={`log-line is-${logKind(entry.text)}`} key={`${entry.ts}-${i}`}><time className="mono">{entry.ts}</time><span className="log-mark" aria-hidden="true" /><p className="mono">{entry.text}</p></div>)}{!filtered.length && <EmptyState icon={ScrollText} title={filter ? "Ninguna coincidencia." : "Registro vacío."} text={filter ? "Prueba otra búsqueda." : "La actividad de la sesión aparece aquí."} />}</div></>;
}

function PageHeading({ title, description, action }) { return <div className="page-head"><div className="page-head-text"><h1>{title}</h1><p>{description}</p></div>{action && <div className="page-head-action">{action}</div>}</div>; }
function Setting({ title, text, stack, children }) { return <div className={`spec-row ${stack ? "is-stacked" : ""}`}><div className="spec-text"><b>{title}</b><p>{text}</p></div><div className="spec-control">{children}</div></div>; }
function Metric({ label, value, big, tone }) { return <div className={`metric ${big ? "is-big" : ""}`}><dt>{label}</dt><dd className={`num ${tone ? `is-${tone}` : ""}`}>{value}</dd></div>; }
function EmptyState({ icon: Icon, title, text, action, compact }) { return <div className={`empty ${compact ? "is-compact" : ""}`}><Icon size={compact ? 18 : 22} strokeWidth={1.5} aria-hidden="true" /><p className="empty-title">{title}</p><p className="empty-text">{text}</p>{action}</div>; }
function Toggle({ checked, onChange, label, large, tone, disabled }) { return <button disabled={disabled} className={`switch ${checked ? "is-on" : ""} ${large ? "is-large" : ""} ${tone === "ember" ? "is-accent" : ""}`} type="button" role="switch" aria-checked={Boolean(checked)} aria-label={label} onClick={() => onChange(!checked)}><span /></button>; }
function Search({ value, onChange, label, placeholder }) { return <label className="search"><ListFilter size={15} aria-hidden="true" /><span className="sr-only">{label}</span><input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />{value && <button className="icon-btn" onClick={() => onChange("")} aria-label={`Limpiar ${label.toLowerCase()}`} type="button"><X aria-hidden="true" size={13} /></button>}</label>; }

export default App;
