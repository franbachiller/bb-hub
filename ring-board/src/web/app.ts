import type {
  BridgeStatusMessage,
  FireCommandMessage,
  MoveCommandMessage,
  MovePlanCommandMessage,
  ServerStateSnapshot,
  StateMessage
} from "../shared/protocol.js";
import { buildControlMap } from "../solver/control-map.js";

type SnapshotFrame = {
  wallAt: number;
  snapshot: ServerStateSnapshot;
};

const WS_URL = "ws://127.0.0.1:18444";
const TILE_SIZE = 28;
const HISTORY_MS = 3000;
// Canvas palette = the design tokens (public/tokens.css, shared with the Hub via design.md).
// Read once at start-up; each token keeps a fallback so the board still draws without the sheet.
function cssToken(name: string, fallback: string): string {
  try {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
  } catch {
    return fallback;
  }
}
// Overlay alpha is a modifier on a token, never a colour of its own: "oklch(L C H)" -> "oklch(L C H / a)".
function withAlpha(color: string, alpha: number): string {
  return /^oklch\([^/]*\)$/.test(color) ? color.replace(/\)$/, ` / ${alpha})`) : color;
}
const TOKENS = {
  paper: cssToken("--color-paper", "oklch(14.5% 0.010 20)"),
  paper2: cssToken("--color-paper-2", "oklch(17.5% 0.011 20)"),
  rule: cssToken("--color-rule", "oklch(27% 0.012 20)"),
  ink: cssToken("--color-ink", "oklch(95% 0.006 20)"),
  ink2: cssToken("--color-ink-2", "oklch(78% 0.010 20)"),
  muted: cssToken("--color-muted", "oklch(64% 0.012 20)"),
  accent: cssToken("--color-accent", "oklch(62% 0.200 22)"),
  warn: cssToken("--color-warn", "oklch(80% 0.140 75)"),
  tile: cssToken("--color-board-tile", "oklch(19.5% 0.010 20)"),
  tile2: cssToken("--color-board-tile-2", "oklch(17% 0.010 20)"),
  rival: cssToken("--color-board-rival", "oklch(70% 0.012 20)"),
  contact: cssToken("--color-board-contact", "oklch(34% 0.120 22)")
};
const UI_COLORS = {
  boardBg: TOKENS.paper,
  boardBgSoft: TOKENS.paper2,
  tile: TOKENS.tile,
  tileAlt: TOKENS.rule,
  grid: TOKENS.rule,
  targetStroke: TOKENS.accent,
  trackStroke: withAlpha(TOKENS.muted, 0.6),
  nextStroke: withAlpha(TOKENS.muted, 0.35),
  selfFill: TOKENS.ink,
  targetFill: TOKENS.accent,
  enemyFill: TOKENS.rival,
  lockFill: TOKENS.warn,
  text: TOKENS.ink,
  textMuted: TOKENS.muted,
  textDim: TOKENS.muted,
  pieceText: TOKENS.paper,
  enemyTag: TOKENS.rival,
  enemyTagAnchor: TOKENS.ink2,
  dangerFill: withAlpha(TOKENS.accent, 0.22),
  planStroke: withAlpha(TOKENS.ink2, 0.8),
  planFill: withAlpha(TOKENS.ink2, 0.08),
  planStep: withAlpha(TOKENS.ink2, 0.55),
  backup: TOKENS.warn,
  labelPlate: withAlpha(TOKENS.paper, 0.86),
  labelText: TOKENS.ink2
} as const;
const FONT_MONO = cssToken("--font-mono", '"Geist Mono", monospace');
const FONT_BODY = cssToken("--font-body", '"Geist Sans", sans-serif');
const FONT_DISPLAY = cssToken("--font-display", '"Geist Sans", sans-serif');

const canvas = document.getElementById("board") as HTMLCanvasElement;
const ctx = canvas.getContext("2d");
const statusEl = document.getElementById("status") as HTMLPreElement;
const summaryEl = document.getElementById("summary") as HTMLDivElement;
const bridgeChipEl = document.getElementById("bridge-chip") as HTMLSpanElement;
const roundChipEl = document.getElementById("round-chip") as HTMLSpanElement;
const brainChipEl = document.getElementById("brain-chip") as HTMLSpanElement;
const targetChipEl = document.getElementById("target-chip") as HTMLSpanElement;
const armBtn = document.getElementById("arm-btn") as HTMLButtonElement;
const recalcBtn = document.getElementById("recalc-btn") as HTMLButtonElement;
const highPowerBtn = document.getElementById("high-power-btn") as HTMLButtonElement;
const moveAssistBtn = document.getElementById("move-assist-btn") as HTMLButtonElement;
const cadenceBtn = document.getElementById("cadence-btn") as HTMLButtonElement;
const pulseBtn = document.getElementById("pulse-btn") as HTMLButtonElement;
const timingStartInput = document.getElementById("timing-start-input") as HTMLInputElement;
const timingEndInput = document.getElementById("timing-end-input") as HTMLInputElement;
const timingIntervalInput = document.getElementById("timing-interval-input") as HTMLInputElement;
const timingMultiplierSelect = document.getElementById("timing-multiplier-input") as HTMLSelectElement;
const replayBtn = document.getElementById("replay-btn") as HTMLButtonElement;
const clearReplayBtn = document.getElementById("clear-replay-btn") as HTMLButtonElement;
const stopReplayBtn = document.getElementById("stop-replay-btn") as HTMLButtonElement;
const clearFreezeBtn = document.getElementById("clear-freeze-btn") as HTMLButtonElement;
const allowBtn = document.getElementById("allow-btn") as HTMLButtonElement;
const ignoreBtn = document.getElementById("ignore-btn") as HTMLButtonElement;
const resetBtn = document.getElementById("reset-btn") as HTMLButtonElement;
const resetMemoryBtn = document.getElementById("reset-memory-btn") as HTMLButtonElement;
const showHashInput = document.getElementById("show-hash") as HTMLInputElement;
const showVectorsInput = document.getElementById("show-vectors") as HTMLInputElement;
const showPlanInput = document.getElementById("show-plan") as HTMLInputElement;
const showDangerInput = document.getElementById("show-danger") as HTMLInputElement;
const rosterMetaEl = document.getElementById("roster-meta") as HTMLSpanElement;
const rosterTableEl = document.getElementById("roster-table") as HTMLDivElement;
const copyRosterTsvBtn = document.getElementById("copy-roster-tsv-btn") as HTMLButtonElement;
const copyRosterJsonBtn = document.getElementById("copy-roster-json-btn") as HTMLButtonElement;

type PersistedUiState = {
  highPower?: boolean;
  timingStartPct?: number;
  timingEndPct?: number;
  timingIntervalMs?: number;
  timingMultiplier?: number;
  showHash?: boolean;
  showVectors?: boolean;
  showPlan?: boolean;
  showDanger?: boolean;
};

let socket: WebSocket | null = null;
let currentSnapshot: ServerStateSnapshot | null = null;
let replayFrames: SnapshotFrame[] | null = null;
let replayStartAt = 0;
let lastBridgeStatus: BridgeStatusMessage | null = null;
let lastFire: FireCommandMessage | null = null;
let lastMove: MoveCommandMessage | MovePlanCommandMessage | null = null;
let lastRosterTsv = "";
let lastRosterJson = "";
const history: SnapshotFrame[] = [];
const UI_STATE_KEY = "ringbrain-ui-state-v1";
let persistedUiState = loadPersistedUiState();

function connect(): void {
  socket = new WebSocket(WS_URL);
  socket.addEventListener("open", () => {
    socket?.send(JSON.stringify({ type: "ui_hello", role: "ui", ts: Date.now() }));
  });
  socket.addEventListener("message", (event) => {
    handleMessage(String(event.data));
  });
  socket.addEventListener("close", () => {
    setTimeout(connect, 1000);
  });
}

function handleMessage(raw: string): void {
  const parsed = JSON.parse(raw) as
    | StateMessage
    | BridgeStatusMessage
    | FireCommandMessage
    | MoveCommandMessage
    | MovePlanCommandMessage;

  if (parsed.type === "state") {
    currentSnapshot = parsed.payload;
    pushHistory(parsed.payload);
  } else if (parsed.type === "bridge_status") {
    lastBridgeStatus = parsed;
  } else if (parsed.type === "fire") {
    lastFire = parsed;
  } else if (parsed.type === "move" || parsed.type === "move_plan") {
    lastMove = parsed;
  }
  markDirty();
}

function pushHistory(snapshot: ServerStateSnapshot): void {
  const frame = { wallAt: Date.now(), snapshot: clone(snapshot) };
  history.push(frame);
  while (history.length > 0 && frame.wallAt - history[0].wallAt > HISTORY_MS) {
    history.shift();
  }
}

function activeSnapshot(): ServerStateSnapshot | null {
  if (replayFrames && replayFrames.length > 0) {
    const elapsed = Date.now() - replayStartAt;
    const first = replayFrames[0].wallAt;
    const last = replayFrames[replayFrames.length - 1].wallAt;
    const playbackAt = first + Math.min(elapsed, last - first);
    let selected = replayFrames[0].snapshot;
    for (const frame of replayFrames) {
      if (frame.wallAt <= playbackAt) {
        selected = frame.snapshot;
      }
    }
    if (playbackAt >= last) {
      replayFrames = null;
    }
    return selected;
  }
  return currentSnapshot;
}

// Redraw only when something changed (a message, a UI event, a replay running),
// plus a 1 s safety refresh. Redrawing every frame burned ~60% of a core next to the game.
let dirty = true;
let lastRenderAt = 0;
const RENDER_IDLE_MS = 1000;

function markDirty(): void {
  dirty = true;
}

function render(): void {
  const now = performance.now();
  if (dirty || replayFrames || now - lastRenderAt >= RENDER_IDLE_MS) {
    dirty = false;
    lastRenderAt = now;
    const snapshot = activeSnapshot();
    draw(snapshot);
    updateSummary(snapshot);
    updateStatus(snapshot);
    updateRoster(snapshot);
  }
  requestAnimationFrame(render);
}

function draw(snapshot: ServerStateSnapshot | null): void {
  if (!ctx) {
    return;
  }
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = UI_COLORS.boardBg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (!snapshot?.scene) {
    ctx.save();
    ctx.textAlign = "center";
    ctx.fillStyle = UI_COLORS.text;
    ctx.font = `600 26px ${FONT_DISPLAY}`;
    ctx.fillText("Ring en espera", canvas.width / 2, canvas.height / 2 - 8);
    ctx.fillStyle = UI_COLORS.textMuted;
    ctx.font = `400 15px ${FONT_BODY}`;
    ctx.fillText("El tablero se dibuja al recibir la primera escena.", canvas.width / 2, canvas.height / 2 + 24);
    ctx.restore();
    return;
  }

  const scene = snapshot.scene;
  const navMatrix = scene.walkableMatrix ?? scene.matrix;
  const walkableMask = buildReachableMask(navMatrix, scene.width, scene.height, snapshot.entities);
  const overlayPoints = scene.overlayPoints ?? null;
  const projection = scene.projection ?? null;
  if (overlayPoints && overlayPoints.length > 0) {
    drawOverlayBoard(snapshot, overlayPoints);
  } else if (projection && projection.tileW > 0 && projection.tileH > 0) {
    drawProjectedBoard(snapshot, walkableMask, projection);
  } else {
    // The HTML5 runtime sends no tile size (0 x 0): draw the board ourselves.
    drawChessBoard(snapshot, walkableMask);
  }
}

// The ring as the game shows it: diamond tiles, +1 x = 40 px right and 20 up,
// +1 y = 40 right and 20 down (read from the live client 26/09), so the
// contact diagonal (x+1, y+1) is the neighbour to the right on screen.
const CHESS_W = 40;
const CHESS_H = 20;
const CHESS_COLORS = {
  light: TOKENS.tile,
  dark: TOKENS.tile2,
  edge: TOKENS.paper,
  contact: TOKENS.contact,
  contactEdge: TOKENS.accent,
  plan: withAlpha(TOKENS.ink2, 0.75)
};

function chessPoint(x: number, y: number): { x: number; y: number } {
  return { x: ((x + y) * CHESS_W) / 2, y: ((y - x) * CHESS_H) / 2 };
}

function drawChessBoard(snapshot: ServerStateSnapshot, walkableMask: Set<string>): void {
  if (!ctx || !snapshot.scene) {
    return;
  }
  const scene = snapshot.scene;
  // Every walkable tile (the Ring has parts joined only diagonally, which the
  // 4-neighbour reachable mask leaves out).
  const matrix = scene.walkableMatrix ?? scene.matrix;
  const walkable = (x: number, y: number) => isWalkableTile(matrix[y]?.[x] ?? 1);
  const tiles: Array<{ x: number; y: number }> = [];
  for (let y = 0; y < scene.height; y += 1) {
    for (let x = 0; x < scene.width; x += 1) {
      if (walkable(x, y)) tiles.push({ x, y });
    }
  }
  if (!tiles.length) {
    drawTopDownBoard(snapshot, walkableMask);
    return;
  }
  const pts = tiles.map((t) => chessPoint(t.x, t.y));
  // Tight margins: half a tile at the sides, room for a piece above and a name below.
  const padX = CHESS_W / 2;
  const padTop = 28;
  const padBottom = 30;
  const minX = Math.min(...pts.map((p) => p.x)) - CHESS_W / 2;
  const maxX = Math.max(...pts.map((p) => p.x)) + CHESS_W / 2;
  const minY = Math.min(...pts.map((p) => p.y)) - CHESS_H / 2;
  const maxY = Math.max(...pts.map((p) => p.y)) + CHESS_H / 2;
  const ox = padX - minX;
  const oy = padTop - minY;
  const rawW = maxX - minX + padX * 2;
  const rawH = maxY - minY + padTop + padBottom;
  // Fill the panel: scale the whole board to the space it has (content box, no padding).
  const box = canvas.parentElement;
  const boxStyle = box ? getComputedStyle(box) : null;
  const boxW = box && boxStyle ? box.clientWidth - parseFloat(boxStyle.paddingLeft) - parseFloat(boxStyle.paddingRight) : 0;
  const boxH = box && boxStyle ? box.clientHeight - parseFloat(boxStyle.paddingTop) - parseFloat(boxStyle.paddingBottom) : 0;
  const k = box ? Math.max(1, Math.min(4, boxW / rawW, boxH / rawH)) : 1;
  canvas.width = Math.ceil(rawW * k);
  canvas.height = Math.ceil(rawH * k);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = UI_COLORS.boardBg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(k, 0, 0, k, 0, 0);
  const at = (x: number, y: number) => {
    const p = chessPoint(x, y);
    return { x: p.x + ox, y: p.y + oy };
  };
  const diamond = (x: number, y: number) => {
    const c = at(x, y);
    ctx!.beginPath();
    ctx!.moveTo(c.x, c.y - CHESS_H / 2);
    ctx!.lineTo(c.x + CHESS_W / 2, c.y);
    ctx!.lineTo(c.x, c.y + CHESS_H / 2);
    ctx!.lineTo(c.x - CHESS_W / 2, c.y);
    ctx!.closePath();
  };

  // Tiles, two colours like a chess board.
  ctx.lineWidth = 1;
  ctx.strokeStyle = CHESS_COLORS.edge;
  for (const t of tiles) {
    diamond(t.x, t.y);
    ctx.fillStyle = (t.x + t.y) % 2 === 0 ? CHESS_COLORS.light : CHESS_COLORS.dark;
    ctx.fill();
    ctx.stroke();
  }

  // Our two contact tiles (the only ones where a punch lands).
  const self = snapshot.entities.find((e) => e.isSelf) ?? null;
  if (self) {
    for (const d of [-1, 1]) {
      const cx = self.toX + d;
      const cy = self.toY + d;
      if (!walkable(cx, cy)) continue;
      diamond(cx, cy);
      ctx.fillStyle = CHESS_COLORS.contact;
      ctx.fill();
      ctx.strokeStyle = CHESS_COLORS.contactEdge;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  // The brain's next step.
  if (self && lastMove && lastMove.type === "move_plan" && lastMove.sceneHash === scene.sceneHash) {
    const from = at(self.toX, self.toY);
    const to = at(lastMove.primaryTile.x, lastMove.primaryTile.y);
    ctx.strokeStyle = CHESS_COLORS.plan;
    ctx.lineWidth = 2.5;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
    ctx.setLineDash([]);
    diamond(lastMove.primaryTile.x, lastMove.primaryTile.y);
    ctx.stroke();
  }

  // Players as pieces: where they stand, where they came from, their number and name.
  // Draw order: rivals, then the objective, then us on top.
  const rank = (e: ServerStateSnapshot["entities"][number]) => (e.isSelf ? 2 : e.id === snapshot.targetId ? 1 : 0);
  const pieces = [...snapshot.entities].sort((a, b) => rank(a) - rank(b)).map((e) => {
    const pos = entityTileRenderPos(e);
    return { e, c: at(pos.x, pos.y), r: e.isSelf ? 11 : 10 };
  });
  ctx.textAlign = "center";
  for (const { e, c, r } of pieces) {
    if (e.fromX !== e.toX || e.fromY !== e.toY) {
      const from = at(e.fromX, e.fromY);
      ctx.strokeStyle = UI_COLORS.trackStroke;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(c.x, c.y);
      ctx.stroke();
    }
    const isTarget = e.id === snapshot.targetId;
    const isLocked = !e.isSelf && !isTarget && e.id === (snapshot.selection?.lockedTarget ?? -1);
    ctx.fillStyle = e.isSelf ? UI_COLORS.selfFill : isTarget ? UI_COLORS.targetFill : isLocked ? UI_COLORS.lockFill : UI_COLORS.enemyFill;
    ctx.strokeStyle = UI_COLORS.boardBg;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(c.x, c.y - 6, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    if (isTarget) {
      // The objective carries a second ring, so it never depends on colour alone.
      ctx.strokeStyle = UI_COLORS.targetStroke;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(c.x, c.y - 6, r + 4, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = UI_COLORS.pieceText;
    ctx.font = `600 10px ${FONT_MONO}`;
    ctx.fillText(String(e.id), c.x, c.y - 2.5);
  }

  // Names: each on a small paper plate, placed where it does not cover another name or piece
  // (below, above, right, left, then further out). Us first, then the objective, then rivals.
  type Box = { x: number; y: number; w: number; h: number };
  const hit = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  const pieceBoxes = pieces.map(({ e, c, r }) => ({ id: e.id, box: { x: c.x - r - 2, y: c.y - 6 - r - 2, w: r * 2 + 4, h: r * 2 + 4 } }));
  const placed: Box[] = [];
  const labelH = 15;
  ctx.font = `500 11px ${FONT_BODY}`;
  ctx.textBaseline = "middle";
  for (const { e, c, r } of [...pieces].reverse()) {
    const name = (e.name || "").slice(0, 12);
    if (!name) continue;
    const w = Math.ceil(ctx.measureText(name).width) + 8;
    const cy = c.y - 6;
    const candidates = [
      { x: c.x, y: cy + r + 4 + labelH / 2 },
      { x: c.x, y: cy - r - 5 - labelH / 2 },
      { x: c.x + r + 5 + w / 2, y: cy },
      { x: c.x - r - 5 - w / 2, y: cy },
      { x: c.x, y: cy + r + 6 + labelH * 1.5 },
      { x: c.x, y: cy - r - 7 - labelH * 1.5 }
    ];
    const toBox = (p: { x: number; y: number }): Box => ({ x: p.x - w / 2, y: p.y - labelH / 2, w, h: labelH });
    const free = (b: Box) => !placed.some((o) => hit(o, b)) && !pieceBoxes.some((o) => o.id !== e.id && hit(o.box, b));
    const spot = candidates.find((p) => free(toBox(p))) ?? candidates[0];
    const plate = toBox(spot);
    placed.push(plate);
    const isTarget = e.id === snapshot.targetId;
    ctx.fillStyle = UI_COLORS.labelPlate;
    ctx.beginPath();
    ctx.roundRect(plate.x, plate.y, plate.w, plate.h, 3);
    ctx.fill();
    ctx.fillStyle = e.isSelf ? UI_COLORS.text : isTarget ? UI_COLORS.targetFill : UI_COLORS.labelText;
    ctx.fillText(name, spot.x, spot.y + 0.5);
  }
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "start";
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  drawFooter(snapshot);
}

function drawOverlayBoard(
  snapshot: ServerStateSnapshot,
  overlayPoints: NonNullable<NonNullable<ServerStateSnapshot["scene"]>["overlayPoints"]>
): void {
  if (!ctx || !snapshot.scene) {
    return;
  }
  const minX = Math.min(...overlayPoints.map((point) => point.plotX));
  const maxX = Math.max(...overlayPoints.map((point) => point.plotX));
  const minY = Math.min(...overlayPoints.map((point) => point.plotY));
  const maxY = Math.max(...overlayPoints.map((point) => point.plotY));
  const pad = 24;
  const offsetX = pad - minX;
  const offsetY = pad - minY;
  canvas.width = Math.max(320, Math.ceil(maxX - minX + pad * 2));
  canvas.height = Math.max(320, Math.ceil(maxY - minY + pad * 2));
  ctx.fillStyle = UI_COLORS.boardBg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  for (const point of overlayPoints) {
    ctx.fillStyle = softenHex(colorToHex(point.color));
    ctx.beginPath();
    ctx.arc(point.plotX + offsetX, point.plotY + offsetY, 4.5, 0, Math.PI * 2);
    ctx.fill();
  }

  for (const entity of snapshot.entities) {
    drawProjectedEntityWithOffset(
      entity,
      snapshot.targetId,
      snapshot.selection?.lockedTarget ?? -1,
      offsetX,
      offsetY,
      snapshot.scene.projection
    );
  }

  drawDanger(snapshot, offsetX, offsetY);
  drawMovePlan(snapshot, undefined, offsetX, offsetY);
  drawFooter(snapshot);
}

function drawProjectedBoard(
  snapshot: ServerStateSnapshot,
  walkableMask: Set<string>,
  projection: NonNullable<NonNullable<ServerStateSnapshot["scene"]>["projection"]>
): void {
  if (!ctx || !snapshot.scene) {
    return;
  }
  const points: Array<{ x: number; y: number }> = [];
  for (let y = 0; y < snapshot.scene.height; y += 1) {
    for (let x = 0; x < snapshot.scene.width; x += 1) {
      if (!walkableMask.has(keyOf(x, y))) {
        continue;
      }
      points.push(projectTile(x, y, projection));
    }
  }
  if (points.length === 0) {
    canvas.width = 960;
    canvas.height = 720;
    return;
  }

  const minX = Math.min(...points.map((point) => point.x));
  const maxX = Math.max(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxY = Math.max(...points.map((point) => point.y));
  const pad = 24;
  const offsetX = pad - minX;
  const offsetY = pad - minY;
  canvas.width = Math.max(320, Math.ceil(maxX - minX + pad * 2));
  canvas.height = Math.max(320, Math.ceil(maxY - minY + pad * 2));
  ctx.fillStyle = UI_COLORS.boardBg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  for (const point of points) {
    ctx.fillStyle = UI_COLORS.tileAlt;
    ctx.beginPath();
    ctx.arc(point.x + offsetX, point.y + offsetY, 4.5, 0, Math.PI * 2);
    ctx.fill();
  }

  for (const entity of snapshot.entities) {
    drawProjectedEntity(entity, snapshot.targetId, snapshot.selection?.lockedTarget ?? -1, projection, offsetX, offsetY);
  }
  drawDanger(snapshot, offsetX, offsetY, projection);
  drawMovePlan(snapshot, projection, offsetX, offsetY);
  drawFooter(snapshot);
}

function drawTopDownBoard(
  snapshot: ServerStateSnapshot,
  walkableMask: Set<string>
): void {
  if (!ctx || !snapshot.scene) {
    return;
  }
  const scene = snapshot.scene;
  canvas.width = Math.max(320, scene.width * TILE_SIZE + 1);
  canvas.height = Math.max(320, scene.height * TILE_SIZE + 1);
  ctx.fillStyle = UI_COLORS.boardBg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  for (let y = 0; y < scene.height; y += 1) {
    for (let x = 0; x < scene.width; x += 1) {
      if (!walkableMask.has(keyOf(x, y))) {
        continue;
      }
      ctx.fillStyle = UI_COLORS.tile;
      ctx.fillRect(x * TILE_SIZE, y * TILE_SIZE, TILE_SIZE - 1, TILE_SIZE - 1);
    }
  }

  for (const entity of snapshot.entities) {
    drawEntity(entity, snapshot.targetId, snapshot.selection?.lockedTarget ?? -1);
  }
  drawDanger(snapshot);
  drawMovePlan(snapshot);
  drawFooter(snapshot);
}

function drawEntity(
  entity: ServerStateSnapshot["entities"][number],
  targetId: number,
  lockedTarget: number
): void {
  if (!ctx) {
    return;
  }
  const fromX = entity.fromX * TILE_SIZE + TILE_SIZE / 2;
  const fromY = entity.fromY * TILE_SIZE + TILE_SIZE / 2;
  const toX = entity.toX * TILE_SIZE + TILE_SIZE / 2;
  const toY = entity.toY * TILE_SIZE + TILE_SIZE / 2;
  const renderPos = entityTileRenderPos(entity);
  const posX = renderPos.x * TILE_SIZE + TILE_SIZE / 2;
  const posY = renderPos.y * TILE_SIZE + TILE_SIZE / 2;
  const nextX = (entity.toX + entity.dirX) * TILE_SIZE + TILE_SIZE / 2;
  const nextY = (entity.toY + entity.dirY) * TILE_SIZE + TILE_SIZE / 2;

  ctx.strokeStyle = entity.id === targetId ? UI_COLORS.targetStroke : UI_COLORS.trackStroke;
  ctx.lineWidth = entity.id === targetId ? 3 : 1;
  ctx.beginPath();
  ctx.moveTo(fromX, fromY);
  ctx.lineTo(toX, toY);
  ctx.stroke();

  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = UI_COLORS.nextStroke;
  ctx.beginPath();
  ctx.moveTo(toX, toY);
  ctx.lineTo(nextX, nextY);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = entity.isSelf ? UI_COLORS.selfFill : entity.id === targetId ? UI_COLORS.targetFill : UI_COLORS.enemyFill;
  if (entity.id === lockedTarget) {
    ctx.fillStyle = UI_COLORS.lockFill;
  }
  ctx.beginPath();
  ctx.arc(posX, posY, entity.isSelf ? 9 : 8, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = UI_COLORS.pieceText;
  ctx.fillText(String(entity.id), posX - 4, posY + 4);
  if (currentSnapshot?.brain?.enemyTags) {
    const tag = currentSnapshot.brain.enemyTags.find((item) => item.id === entity.id);
    if (tag && !entity.isSelf) {
      ctx.fillStyle = tag.anchored ? UI_COLORS.enemyTagAnchor : UI_COLORS.enemyTag;
      ctx.fillText(tag.archetype, posX - 14, posY - 12);
    }
  }
}

function drawDanger(
  snapshot: ServerStateSnapshot,
  offsetX = 0,
  offsetY = 0,
  projection?: NonNullable<NonNullable<ServerStateSnapshot["scene"]>["projection"]>
): void {
  if (!ctx || !showDangerInput.checked || !snapshot.scene) {
    return;
  }
  const self = snapshot.entities.find((entity) => entity.isSelf) ?? null;
  if (!self || snapshot.targetId < 0) {
    return;
  }
  const control = buildControlMap(snapshot.scene, snapshot.entities, self.id, snapshot.targetId, snapshot.frameTs);
  if (!control) {
    return;
  }
  for (const tile of control.tiles.values()) {
    const danger = Math.min(1, tile.dangerLong / 6.5);
    if (danger <= 0.1) {
      continue;
    }
    const alpha = 0.08 + danger * 0.22;
    ctx.fillStyle = alpha >= 0.2 ? UI_COLORS.dangerFill : withAlpha(TOKENS.accent, Number(alpha.toFixed(3)));
    if (projection) {
      const point = projectTile(tile.tile.x, tile.tile.y, projection);
      ctx.beginPath();
      ctx.arc(point.x + offsetX, point.y + offsetY, 5 + danger * 4, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillRect(tile.tile.x * TILE_SIZE + 5, tile.tile.y * TILE_SIZE + 5, TILE_SIZE - 10, TILE_SIZE - 10);
    }
  }
}

function drawProjectedEntity(
  entity: ServerStateSnapshot["entities"][number],
  targetId: number,
  lockedTarget: number,
  projection: NonNullable<NonNullable<ServerStateSnapshot["scene"]>["projection"]>,
  offsetX: number,
  offsetY: number
): void {
  drawProjectedEntityWithOffset(entity, targetId, lockedTarget, offsetX, offsetY, projection);
}

function drawProjectedEntityWithOffset(
  entity: ServerStateSnapshot["entities"][number],
  targetId: number,
  lockedTarget: number,
  offsetX: number,
  offsetY: number,
  projection?: NonNullable<NonNullable<ServerStateSnapshot["scene"]>["projection"]>
): void {
  if (!ctx) {
    return;
  }
  const activeProjection = projection ?? currentSnapshot?.scene?.projection;
  if (!activeProjection) {
    return;
  }
  const from = projectTile(entity.fromX, entity.fromY, activeProjection);
  const to = projectTile(entity.toX, entity.toY, activeProjection);
  const renderPos = entityTileRenderPos(entity);
  const pos = projectFloatTile(renderPos.x, renderPos.y, activeProjection);
  const next = projectTile(entity.toX + entity.dirX, entity.toY + entity.dirY, activeProjection);

  ctx.strokeStyle = entity.id === targetId ? UI_COLORS.targetStroke : UI_COLORS.trackStroke;
  ctx.lineWidth = entity.id === targetId ? 3 : 1;
  ctx.beginPath();
  ctx.moveTo(from.x + offsetX, from.y + offsetY);
  ctx.lineTo(to.x + offsetX, to.y + offsetY);
  ctx.stroke();

  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = UI_COLORS.nextStroke;
  ctx.beginPath();
  ctx.moveTo(to.x + offsetX, to.y + offsetY);
  ctx.lineTo(next.x + offsetX, next.y + offsetY);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = entity.isSelf ? UI_COLORS.selfFill : entity.id === targetId ? UI_COLORS.targetFill : UI_COLORS.enemyFill;
  if (entity.id === lockedTarget) {
    ctx.fillStyle = UI_COLORS.lockFill;
  }
  ctx.beginPath();
  ctx.arc(pos.x + offsetX, pos.y + offsetY, entity.isSelf ? 9 : 8, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = UI_COLORS.pieceText;
  ctx.fillText(String(entity.id), pos.x + offsetX - 4, pos.y + offsetY + 4);
}

function drawFooter(snapshot: ServerStateSnapshot): void {
  if (!ctx) {
    return;
  }
  if (snapshot.window && showVectorsInput.checked) {
    ctx.font = `400 11px ${FONT_MONO}`;
    ctx.fillStyle = UI_COLORS.textDim;
    ctx.fillText(
      `window=${snapshot.window.kind} dNow=(${snapshot.window.deltaNowX.toFixed(2)},${snapshot.window.deltaNowY.toFixed(2)}) relV=(${snapshot.window.relVelX.toFixed(2)},${snapshot.window.relVelY.toFixed(2)})`,
      12,
      canvas.height - 16
    );
  }
  if (showHashInput.checked && snapshot.scene) {
    ctx.font = `400 11px ${FONT_MONO}`;
    ctx.fillStyle = UI_COLORS.textMuted;
    ctx.fillText(`${snapshot.scene.sceneHash} [${snapshot.scene.policy}]`, 12, 16);
  }
}

function drawMovePlan(
  snapshot: ServerStateSnapshot,
  projection?: NonNullable<NonNullable<ServerStateSnapshot["scene"]>["projection"]>,
  offsetX = 0,
  offsetY = 0
): void {
  if (!ctx || !showPlanInput.checked) {
    return;
  }
  if (!snapshot.scene || !lastMove || lastMove.type !== "move_plan") {
    return;
  }
  if (lastMove.sceneHash !== snapshot.scene.sceneHash) {
    return;
  }
  const self = snapshot.entities.find((entity) => entity.isSelf) ?? null;
  if (!self) {
    return;
  }
  const selfPos = entityTileRenderPos(self);
  const planTiles = lastMove.planTiles?.length ? lastMove.planTiles : [lastMove.primaryTile];
  const primary = planTiles[0] ?? lastMove.primaryTile;
  const backup = lastMove.backupTile;

  if (projection) {
    const selfPoint = projectFloatTile(selfPos.x, selfPos.y, projection);
    ctx.strokeStyle = UI_COLORS.planStroke;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(selfPoint.x + offsetX, selfPoint.y + offsetY);
    for (const tile of planTiles) {
      const point = projectTile(tile.x, tile.y, projection);
      ctx.lineTo(point.x + offsetX, point.y + offsetY);
    }
    ctx.stroke();
    const primaryPoint = projectTile(primary.x, primary.y, projection);
    ctx.fillStyle = UI_COLORS.planFill;
    ctx.beginPath();
    ctx.arc(primaryPoint.x + offsetX, primaryPoint.y + offsetY, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = UI_COLORS.planStroke;
    ctx.stroke();
    for (let i = 1; i < planTiles.length; i += 1) {
      const point = projectTile(planTiles[i].x, planTiles[i].y, projection);
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = UI_COLORS.planStep;
      ctx.beginPath();
      ctx.arc(point.x + offsetX, point.y + offsetY, 6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (backup) {
      const backupPoint = projectTile(backup.x, backup.y, projection);
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = UI_COLORS.backup;
      ctx.beginPath();
      ctx.arc(backupPoint.x + offsetX, backupPoint.y + offsetY, 7, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    return;
  }

  const selfX = selfPos.x * TILE_SIZE + TILE_SIZE / 2;
  const selfY = selfPos.y * TILE_SIZE + TILE_SIZE / 2;
  ctx.strokeStyle = UI_COLORS.planStroke;
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(selfX, selfY);
  for (const tile of planTiles) {
    ctx.lineTo(tile.x * TILE_SIZE + TILE_SIZE / 2, tile.y * TILE_SIZE + TILE_SIZE / 2);
  }
  ctx.stroke();
  const primaryX = primary.x * TILE_SIZE;
  const primaryY = primary.y * TILE_SIZE;
  ctx.fillStyle = UI_COLORS.planFill;
  ctx.fillRect(primaryX + 3, primaryY + 3, TILE_SIZE - 6, TILE_SIZE - 6);
  ctx.strokeRect(primaryX + 3, primaryY + 3, TILE_SIZE - 6, TILE_SIZE - 6);
  for (let i = 1; i < planTiles.length; i += 1) {
    const tile = planTiles[i];
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = UI_COLORS.planStep;
    ctx.strokeRect(tile.x * TILE_SIZE + 7, tile.y * TILE_SIZE + 7, TILE_SIZE - 14, TILE_SIZE - 14);
    ctx.setLineDash([]);
  }
  if (backup) {
    const backupX = backup.x * TILE_SIZE;
    const backupY = backup.y * TILE_SIZE;
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = UI_COLORS.backup;
    ctx.strokeRect(backupX + 5, backupY + 5, TILE_SIZE - 10, TILE_SIZE - 10);
    ctx.setLineDash([]);
  }
}

function updateSummary(snapshot: ServerStateSnapshot | null): void {
  armBtn.textContent = lastBridgeStatus?.armed ? "Desactivar" : "Activar";
  armBtn.setAttribute("aria-pressed", String(lastBridgeStatus?.armed ?? false));
  const moveAssistOn = lastBridgeStatus?.moveAssist ?? false;
  const cadenceOn = lastBridgeStatus?.stepCadenceAlways ?? false;
  const pulseOn = lastBridgeStatus?.pulseClick ?? false;
  const highPowerOn = lastBridgeStatus?.highPower ?? false;
  syncTimingInputs();
  highPowerBtn.textContent = `Potencia: ${highPowerOn ? "sí" : "no"}`;
  moveAssistBtn.textContent = `Asistencia: ${moveAssistOn ? "sí" : "no"}`;
  cadenceBtn.textContent = `Cadencia: ${cadenceOn ? "sí" : "no"}`;
  pulseBtn.textContent = `Pulsos: ${pulseOn ? "sí" : "no"}`;
  highPowerBtn.setAttribute("aria-pressed", String(highPowerOn));
  moveAssistBtn.setAttribute("aria-pressed", String(moveAssistOn));
  cadenceBtn.setAttribute("aria-pressed", String(cadenceOn));
  pulseBtn.setAttribute("aria-pressed", String(pulseOn));
  highPowerBtn.classList.toggle("accent", highPowerOn);
  highPowerBtn.classList.toggle("danger", false);
  moveAssistBtn.classList.toggle("accent", moveAssistOn);
  cadenceBtn.classList.toggle("accent", cadenceOn);
  pulseBtn.classList.toggle("accent", pulseOn);
  pulseBtn.classList.toggle("danger", pulseOn);
  bridgeChipEl.textContent = lastBridgeStatus?.connected
    ? lastBridgeStatus.armed
      ? "Activo"
      : "Conectado"
    : "Sin conexión";
  roundChipEl.textContent = snapshot?.round ? `${snapshot.round.phase.toLowerCase()} #${snapshot.round.roundId}` : "En espera";
  brainChipEl.textContent = snapshot?.brain?.mode.toLowerCase() ?? "—";
  targetChipEl.textContent = resolveCompactTarget(snapshot);
  setChipTone(
    bridgeChipEl.parentElement as HTMLElement,
    !lastBridgeStatus?.connected ? "danger" : lastBridgeStatus.armed ? "good" : "warn"
  );
  setChipTone(
    roundChipEl.parentElement as HTMLElement,
    snapshot?.round.phase === "LIVE" ? "good" : snapshot?.round.phase === "TRANSITION" ? "warn" : "default"
  );
  setChipTone(
    brainChipEl.parentElement as HTMLElement,
    snapshot?.brain?.mode === "COMMIT" ? "good" :
    snapshot?.brain?.mode === "PUNISH" ? "good" :
    snapshot?.brain?.mode === "EVADE" ? "warn" :
    snapshot?.brain?.mode ? "default" : "danger"
  );
  setChipTone(
    targetChipEl.parentElement as HTMLElement,
    snapshot?.targetId != null && snapshot.targetId >= 0 ? "good" : "default"
  );

  const sceneText = snapshot?.scene
    ? `${snapshot.scene.policy} ${snapshot.scene.width}x${snapshot.scene.height}`
    : "Sin escena";
  const planText =
    lastMove && lastMove.type === "move_plan"
      ? compactPlanText(lastMove)
      : "Sin plan";
  const fireText = lastFire ? `#${lastFire.targetId} ${lastFire.reason}` : "Sin golpes";
  const brainText = snapshot?.brain
    ? `${snapshot.brain.mode} | t${snapshot.brain.targetId} | a${snapshot.brain.anchorTargetId}`
    : "En espera";

  summaryEl.innerHTML = [
    summaryItem("Escena", sceneText, snapshot?.scene?.policy === "allowed" ? "good" : snapshot?.scene ? "warn" : "default", showHashInput.checked && snapshot?.scene ? snapshot.scene.sceneHash : ""),
    summaryItem("Estado", brainText, snapshot?.brain?.mode === "COMMIT" || snapshot?.brain?.mode === "PUNISH" ? "good" : snapshot?.brain?.mode === "EVADE" ? "warn" : "default", snapshot?.brain ? `timing ${snapshot.brain.timingConfidence.toFixed(2)}` : ""),
    summaryItem("Plan", planText, lastMove?.type === "move_plan" ? "good" : "default", lastMove?.type === "move_plan" ? lastMove.mode : ""),
    summaryItem(
      "Golpe",
      fireText,
      lastFire ? "good" : "default",
      lastFire
        ? `w ${lastFire.windowId} · ${formatAgo(lastFire.fireAtTs)} · ráfaga ${lastFire.burstOffsetsMs.join("/")}`
        : `timing ${lastBridgeStatus?.timingStartPct ?? 79}-${lastBridgeStatus?.timingEndPct ?? 100} @ ${lastBridgeStatus?.timingIntervalMs ?? 33}ms x${lastBridgeStatus?.timingMultiplier ?? 1}${lastBridgeStatus?.highPower ? " | HP" : ""}${lastBridgeStatus?.moveAssist ? " | MOVE" : ""}`
    )
  ].join("");
}

// fireAtTs is a wall-clock epoch in ms: show it as "hace 2,3 s" instead of 13 digits.
function formatAgo(ts: number): string {
  if (!Number.isFinite(ts) || ts < 1e12) return String(ts);
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return `hace ${s.toFixed(1).replace(".", ",")} s`;
  if (s < 3600) return `hace ${Math.round(s / 60)} min`;
  return `hace ${Math.round(s / 3600)} h`;
}

function summaryItem(label: string, value: string, tone: "default" | "good" | "warn" | "danger", meta = ""): string {
  const toneClass = tone === "default" ? "" : ` is-${tone}`;
  const metaHtml = meta ? `<small>${escapeHtml(meta)}</small>` : "";
  return `<div class="summary-item${toneClass}"><strong>${escapeHtml(label)}</strong><span>${escapeHtml(value)}</span>${metaHtml}</div>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function updateRoster(snapshot: ServerStateSnapshot | null): void {
  const entities = snapshot
    ? [...snapshot.entities]
        .filter((entity) => entity.isSelf || !isAnchorPlaceholder(entity))
        .sort((left, right) => {
          if (left.isSelf !== right.isSelf) {
            return left.isSelf ? -1 : 1;
          }
          return entitySceneId(left) - entitySceneId(right);
        })
    : [];

  if (!snapshot || entities.length === 0) {
    lastRosterTsv = "";
    lastRosterJson = "[]";
    rosterMetaEl.textContent = "Esperando jugadores";
    rosterTableEl.innerHTML = '<div class="roster-empty">Sin datos de escena</div>';
    return;
  }

  const exportRows = entities.map((entity) => ({
    scene_id: entitySceneId(entity),
    account_id: entity.accountId ?? null,
    name: entityName(entity),
    skin_id: entity.skinId ?? null,
    x: roundCoord(entity.x),
    y: roundCoord(entity.y),
    orientation: entity.orientation ?? inferOrientation(entity),
    moving: entity.moving,
    state: entity.combatState?.state ?? null
  }));

  lastRosterJson = JSON.stringify(exportRows, null, 2);
  lastRosterTsv = buildRosterTsv(exportRows);
  rosterMetaEl.textContent = `${entities.length} en escena · tú #${entitySceneId(entities[0])}`;
  rosterTableEl.innerHTML = `
    <table class="roster-table">
      <thead>
        <tr>
          <th>Escena</th>
          <th>UserID</th>
          <th>Nombre</th>
          <th>Skin</th>
          <th>X</th>
          <th>Y</th>
          <th>O</th>
          <th>Estado</th>
        </tr>
      </thead>
      <tbody>
        ${entities
          .map((entity) => {
            const toneClass = entity.isSelf ? ' class="is-self"' : "";
            return `<tr${toneClass}>
              <td>${escapeHtml(String(entitySceneId(entity)))}</td>
              <td>${escapeHtml(formatCell(entity.accountId))}</td>
              <td>${escapeHtml(entityName(entity))}</td>
              <td>${escapeHtml(formatCell(entity.skinId))}</td>
              <td>${escapeHtml(formatCell(roundCoord(entity.x)))}</td>
              <td>${escapeHtml(formatCell(roundCoord(entity.y)))}</td>
              <td>${escapeHtml(formatCell(entity.orientation ?? inferOrientation(entity)))}</td>
              <td>${escapeHtml(formatCell(entity.combatState?.state ?? "-"))}</td>
            </tr>`;
          })
          .join("")}
      </tbody>
    </table>
  `;
}

function buildRosterTsv(
  rows: Array<{
    scene_id: number;
    account_id: number | null;
    name: string;
    skin_id: number | null;
    x: number;
    y: number;
    orientation: number;
    moving: boolean;
    state: number | null;
  }>
): string {
  const header = ["scene_id", "account_id", "name", "skin_id", "x", "y", "orientation", "moving", "state"].join("\t");
  const body = rows.map((row) =>
    [
      row.scene_id,
      row.account_id ?? "",
      row.name,
      row.skin_id ?? "",
      row.x,
      row.y,
      row.orientation,
      row.moving ? 1 : 0,
      row.state ?? ""
    ].join("\t")
  );
  return [header, ...body].join("\n");
}

function entitySceneId(entity: ServerStateSnapshot["entities"][number]): number {
  return entity.sceneId ?? entity.id;
}

function entityName(entity: ServerStateSnapshot["entities"][number]): string {
  const raw = entity.name?.trim();
  return raw && raw.length > 0 ? raw : "-";
}

function formatCell(value: unknown): string {
  if (value == null || value === "") {
    return "-";
  }
  return String(value);
}

function roundCoord(value: number): number {
  return Math.round(value * 100) / 100;
}

function inferOrientation(entity: ServerStateSnapshot["entities"][number]): number {
  if (entity.dirX > 0 && entity.dirY === 0) {
    return 1;
  }
  if (entity.dirX < 0 && entity.dirY === 0) {
    return 5;
  }
  if (entity.dirY > 0 && entity.dirX === 0) {
    return 7;
  }
  if (entity.dirY < 0 && entity.dirX === 0) {
    return 3;
  }
  return 0;
}

function updateStatus(snapshot: ServerStateSnapshot | null): void {
  const self = snapshot?.entities.find((entity) => entity.isSelf) ?? null;
  const selfText = self
    ? `#${entitySceneId(self)} uid=${formatCell(self.accountId)} ${entityName(self)} (${self.x.toFixed(2)},${self.y.toFixed(2)}) ${self.moving ? `p=${self.phase.toFixed(2)}` : "idle"}`
    : "none";
  const selectionText = snapshot?.selection
    ? `raw=${snapshot.selection.rawSelectedTarget} pending=${snapshot.selection.pendingTarget} lock=${snapshot.selection.lockedTarget} d=${snapshot.selection.derivedTarget} ready=${lastFire ? (snapshot.selection.rawSelectedTarget === lastFire.targetId ? "yes" : "no") : "-"}`
    : "none";
  const brainText = snapshot?.brain
    ? `${snapshot.brain.mode} t=${snapshot.brain.targetId} a=${snapshot.brain.anchorTargetId} sc=${snapshot.brain.score.toFixed(2)} pr=${snapshot.brain.pressure}`
    : "none";
  const fireText = lastFire
    ? `${lastFire.targetId} w=${lastFire.windowId} at=${lastFire.fireAtTs} b=[${lastFire.burstOffsetsMs.join(",")}] sel=${lastFire.requireSelection ? "yes" : "no"}`
    : "none";
  const timingText = lastBridgeStatus
    ? `${lastBridgeStatus.timingStartPct}-${lastBridgeStatus.timingEndPct} @ ${lastBridgeStatus.timingIntervalMs}ms x${lastBridgeStatus.timingMultiplier}${lastBridgeStatus.highPower ? " HP" : ""}`
    : "79-100 @ 33ms x1";
  const timingPreview = lastBridgeStatus?.burstPreviewOffsetsMs?.join("/") ?? "-";

  statusEl.textContent = [
    `bridge=${lastBridgeStatus?.connected ? "on" : "off"} armed=${lastBridgeStatus?.armed ? "yes" : "no"}`,
    `timing=${timingText} offsets=${timingPreview}`,
    `self=${selfText}`,
    `target=${resolveCompactTarget(snapshot)}`,
    `selection=${selectionText}`,
    `brain=${brainText}`,
    `move=${formatLastMove(lastMove)}`,
    `fire=${fireText}`
  ].join("\n");
}

function formatLastMove(message: MoveCommandMessage | MovePlanCommandMessage | null): string {
  if (!message) {
    return "none";
  }
  if (message.type === "move_plan") {
    const backup = message.backupTile ? ` b=(${message.backupTile.x},${message.backupTile.y})` : "";
    return `${message.targetId} ${message.mode} ${formatPlanTiles(message.planTiles ?? [message.primaryTile])}${backup}`;
  }
  return `${message.targetId} ${message.reason}`;
}

function compactPlanText(message: MovePlanCommandMessage): string {
  const tiles = message.planTiles?.length ? message.planTiles : [message.primaryTile];
  const first = tiles[0];
  const second = tiles[1];
  if (!first) {
    return "no plan";
  }
  if (!second) {
    return `${message.mode} (${first.x},${first.y})`;
  }
  return `${message.mode} (${first.x},${first.y}) -> (${second.x},${second.y})`;
}

function resolveCompactTarget(snapshot: ServerStateSnapshot | null): string {
  if (snapshot?.targetId != null && snapshot.targetId >= 0) {
    return `#${snapshot.targetId}`;
  }
  return "-";
}

function formatPlanTiles(tiles: Array<{ x: number; y: number }>): string {
  return tiles.map((tile) => `(${tile.x},${tile.y})`).join(" -> ");
}

function syncTimingInputs(): void {
  if (!lastBridgeStatus) {
    return;
  }
  syncNumberInput(timingStartInput, lastBridgeStatus.timingStartPct);
  syncNumberInput(timingEndInput, lastBridgeStatus.timingEndPct);
  syncNumberInput(timingIntervalInput, lastBridgeStatus.timingIntervalMs);
  syncSelectInput(timingMultiplierSelect, String(lastBridgeStatus.timingMultiplier));
  persistUiState();
}

function syncNumberInput(input: HTMLInputElement, value: number): void {
  if (document.activeElement === input) {
    return;
  }
  const nextValue = String(value);
  if (input.value !== nextValue) {
    input.value = nextValue;
  }
}

function syncSelectInput(input: HTMLSelectElement, value: string): void {
  if (document.activeElement === input) {
    return;
  }
  if (input.value !== value) {
    input.value = value;
  }
}

function setChipTone(element: HTMLElement, tone: "default" | "good" | "warn" | "danger"): void {
  element.classList.remove("is-good", "is-warn", "is-danger");
  if (tone !== "default") {
    element.classList.add(`is-${tone}`);
  }
}

function sendTimingAction(
  action:
    | "set_timing_start_pct"
    | "set_timing_end_pct"
    | "set_timing_interval_ms"
    | "set_timing_multiplier",
  input: HTMLInputElement,
  min: number,
  max: number
): void {
  const numeric = Number(input.value);
  if (!Number.isFinite(numeric)) {
    syncTimingInputs();
    return;
  }
  const value = Math.max(min, Math.min(max, Math.round(numeric)));
  input.value = String(value);
  persistUiState();
  socket?.send(JSON.stringify({ type: "ui_action", action, value }));
}

function loadPersistedUiState(): PersistedUiState {
  try {
    const raw = window.localStorage.getItem(UI_STATE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as PersistedUiState;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function persistUiState(): void {
  persistedUiState = {
    highPower: lastBridgeStatus?.highPower,
    timingStartPct: clampNumber(timingStartInput.value, 40, 99),
    timingEndPct: clampNumber(timingEndInput.value, 41, 100),
    timingIntervalMs: clampNumber(timingIntervalInput.value, 1, 200),
    timingMultiplier: clampNumber(timingMultiplierSelect.value, 1, 4),
    showHash: showHashInput.checked,
    showVectors: showVectorsInput.checked,
    showPlan: showPlanInput.checked,
    showDanger: showDangerInput.checked
  };
  try {
    window.localStorage.setItem(UI_STATE_KEY, JSON.stringify(persistedUiState));
  } catch {
    // Ignore storage failures; the panel still works without persistence.
  }
}

function applyPersistedUiState(): void {
  applyNumberValue(timingStartInput, persistedUiState.timingStartPct, 40, 99);
  applyNumberValue(timingEndInput, persistedUiState.timingEndPct, 41, 100);
  applyNumberValue(timingIntervalInput, persistedUiState.timingIntervalMs, 1, 200);
  applySelectValue(timingMultiplierSelect, persistedUiState.timingMultiplier, 1, 4);
  applyCheckboxValue(showHashInput, persistedUiState.showHash);
  applyCheckboxValue(showVectorsInput, persistedUiState.showVectors);
  applyCheckboxValue(showPlanInput, persistedUiState.showPlan);
  applyCheckboxValue(showDangerInput, persistedUiState.showDanger);
}

function applyNumberValue(
  input: HTMLInputElement,
  value: number | undefined,
  min: number,
  max: number
): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return;
  }
  input.value = String(Math.max(min, Math.min(max, Math.round(value))));
}

function applySelectValue(
  input: HTMLSelectElement,
  value: number | undefined,
  min: number,
  max: number
): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return;
  }
  input.value = String(Math.max(min, Math.min(max, Math.round(value))));
}

function applyCheckboxValue(input: HTMLInputElement, value: boolean | undefined): void {
  if (typeof value !== "boolean") {
    return;
  }
  input.checked = value;
}

function clampNumber(raw: string, min: number, max: number): number {
  const numeric = Number(raw);
  if (!Number.isFinite(numeric)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.round(numeric)));
}

armBtn.addEventListener("click", () => {
  const nextValue = !(lastBridgeStatus?.armed ?? false);
  socket?.send(
    JSON.stringify({ type: "ui_action", action: "set_armed", value: nextValue })
  );
});

highPowerBtn.addEventListener("click", () => {
  const nextValue = !(lastBridgeStatus?.highPower ?? false);
  socket?.send(
    JSON.stringify({ type: "ui_action", action: "set_high_power", value: nextValue })
  );
});

moveAssistBtn.addEventListener("click", () => {
  const nextValue = !(lastBridgeStatus?.moveAssist ?? false);
  socket?.send(
    JSON.stringify({ type: "ui_action", action: "set_move_assist", value: nextValue })
  );
});

cadenceBtn.addEventListener("click", () => {
  const nextValue = !(lastBridgeStatus?.stepCadenceAlways ?? false);
  socket?.send(
    JSON.stringify({ type: "ui_action", action: "set_step_cadence_always", value: nextValue })
  );
});

pulseBtn.addEventListener("click", () => {
  const nextValue = !(lastBridgeStatus?.pulseClick ?? false);
  socket?.send(
    JSON.stringify({ type: "ui_action", action: "set_pulse_click", value: nextValue })
  );
});

timingStartInput.addEventListener("change", () => {
  sendTimingAction("set_timing_start_pct", timingStartInput, 40, 99);
});

timingEndInput.addEventListener("change", () => {
  const min = Math.max(41, Number(timingStartInput.value || "40") + 1);
  sendTimingAction("set_timing_end_pct", timingEndInput, min, 100);
});

timingIntervalInput.addEventListener("change", () => {
  sendTimingAction("set_timing_interval_ms", timingIntervalInput, 1, 200);
});

timingMultiplierSelect.addEventListener("change", () => {
  const value = Number(timingMultiplierSelect.value);
  if (!Number.isFinite(value)) {
    syncTimingInputs();
    return;
  }
  const clamped = Math.max(1, Math.min(4, Math.round(value)));
  timingMultiplierSelect.value = String(clamped);
  persistUiState();
  socket?.send(JSON.stringify({ type: "ui_action", action: "set_timing_multiplier", value: clamped }));
});

recalcBtn.addEventListener("click", () => {
  socket?.send(JSON.stringify({ type: "ui_action", action: "reset_runtime" }));
  replayFrames = null;
});

replayBtn.addEventListener("click", () => {
  if (history.length === 0) {
    return;
  }
  replayFrames = history.map((frame) => ({ wallAt: frame.wallAt, snapshot: clone(frame.snapshot) }));
  replayStartAt = Date.now();
});

clearReplayBtn.addEventListener("click", () => {
  replayFrames = null;
  history.length = 0;
});

stopReplayBtn.addEventListener("click", () => {
  replayFrames = null;
});

clearFreezeBtn.addEventListener("click", () => {
  replayFrames = null;
});

allowBtn.addEventListener("click", () => {
  const sceneHash = currentSnapshot?.scene?.sceneHash;
  if (!sceneHash) {
    return;
  }
  socket?.send(
    JSON.stringify({ type: "ui_action", action: "mark_scene_allowed", sceneHash })
  );
});

ignoreBtn.addEventListener("click", () => {
  const sceneHash = currentSnapshot?.scene?.sceneHash;
  if (!sceneHash) {
    return;
  }
  socket?.send(JSON.stringify({ type: "ui_action", action: "ignore_scene", sceneHash }));
});

resetBtn.addEventListener("click", () => {
  socket?.send(JSON.stringify({ type: "ui_action", action: "reset_runtime" }));
  replayFrames = null;
});

resetMemoryBtn.addEventListener("click", () => {
  socket?.send(JSON.stringify({ type: "ui_action", action: "reset_session_memory" }));
});

copyRosterTsvBtn.addEventListener("click", () => {
  void copyToClipboard(lastRosterTsv, copyRosterTsvBtn, "TSV copied");
});

copyRosterJsonBtn.addEventListener("click", () => {
  void copyToClipboard(lastRosterJson, copyRosterJsonBtn, "JSON copied");
});

showHashInput.addEventListener("change", persistUiState);
showVectorsInput.addEventListener("change", persistUiState);
showPlanInput.addEventListener("change", persistUiState);
showDangerInput.addEventListener("change", persistUiState);

applyPersistedUiState();

for (const type of ["click", "change", "input"]) {
  document.addEventListener(type, markDirty, true);
}
window.addEventListener("resize", markDirty);

connect();
render();

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function copyToClipboard(text: string, button: HTMLButtonElement, nextLabel: string): Promise<void> {
  if (!text) {
    return;
  }
  const previous = button.textContent ?? "";
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = nextLabel;
    window.setTimeout(() => {
      button.textContent = previous;
    }, 900);
  } catch {
    button.textContent = "Copy failed";
    window.setTimeout(() => {
      button.textContent = previous;
    }, 900);
  }
}

function isWalkableTile(tile: number): boolean {
  return tile === 0 || tile === 2;
}

function buildReachableMask(
  matrix: number[][],
  width: number,
  height: number,
  entities: ServerStateSnapshot["entities"]
): Set<string> {
  const seed = resolveSeedTile(matrix, width, height, entities);
  const result = new Set<string>();
  if (!seed) {
    return result;
  }

  const queue: Array<{ x: number; y: number }> = [seed];
  result.add(keyOf(seed.x, seed.y));
  let cursor = 0;

  while (cursor < queue.length) {
    const current = queue[cursor++];
    const neighbors = [
      { x: current.x + 1, y: current.y },
      { x: current.x - 1, y: current.y },
      { x: current.x, y: current.y + 1 },
      { x: current.x, y: current.y - 1 }
    ];
    for (const next of neighbors) {
      if (
        next.x < 0 ||
        next.y < 0 ||
        next.x >= width ||
        next.y >= height ||
        !isWalkableTile(matrix[next.y]?.[next.x] ?? 1)
      ) {
        continue;
      }
      const key = keyOf(next.x, next.y);
      if (result.has(key)) {
        continue;
      }
      result.add(key);
      queue.push(next);
    }
  }

  return result;
}

function resolveSeedTile(
  matrix: number[][],
  width: number,
  height: number,
  entities: ServerStateSnapshot["entities"]
): { x: number; y: number } | null {
  const ordered = [...entities].sort((left, right) => {
    if (left.isSelf === right.isSelf) {
      return left.id - right.id;
    }
    return left.isSelf ? -1 : 1;
  });

  const preferred = ordered.filter((entity) => !isAnchorPlaceholder(entity));
  const pools = [preferred, ordered];

  for (const pool of pools) {
    for (const entity of pool) {
      const candidates = [
        { x: Math.round(entity.x), y: Math.round(entity.y) },
        { x: entity.toX, y: entity.toY },
        { x: entity.fromX, y: entity.fromY }
      ];
      for (const candidate of candidates) {
        if (
          candidate.x < 0 ||
          candidate.y < 0 ||
          candidate.x >= width ||
          candidate.y >= height
        ) {
          continue;
        }
        if (isWalkableTile(matrix[candidate.y]?.[candidate.x] ?? 1)) {
          return candidate;
        }
      }
    }
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (isWalkableTile(matrix[y]?.[x] ?? 1)) {
        return { x, y };
      }
    }
  }

  return null;
}

function isAnchorPlaceholder(entity: ServerStateSnapshot["entities"][number]): boolean {
  const currentZero = Math.round(entity.x) === 0 && Math.round(entity.y) === 0;
  const fromZero = entity.fromX === 0 && entity.fromY === 0;
  const toZero = entity.toX === 0 && entity.toY === 0;
  return currentZero && fromZero && toZero;
}

function keyOf(x: number, y: number): string {
  return `${x},${y}`;
}

function projectTile(
  tileX: number,
  tileY: number,
  projection: NonNullable<NonNullable<ServerStateSnapshot["scene"]>["projection"]>
): { x: number; y: number } {
  return {
    x: projection.originX + (projection.tileW * 0.5) * tileX + (projection.tileW * 0.5) * tileY,
    y: projection.originY - (projection.tileH * 0.5) * tileX + (projection.tileH * 0.5) * tileY
  };
}

function projectFloatTile(
  tileX: number,
  tileY: number,
  projection: NonNullable<NonNullable<ServerStateSnapshot["scene"]>["projection"]>
): { x: number; y: number } {
  return projectTile(tileX, tileY, projection);
}

function colorToHex(color: number): string {
  const hex = (color >>> 0).toString(16).padStart(6, "0").slice(-6);
  return `#${hex}`;
}

function softenHex(hex: string): string {
  const value = hex.replace("#", "");
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  const mix = 0.58;
  const nextR = Math.round(r + (255 - r) * mix);
  const nextG = Math.round(g + (255 - g) * mix);
  const nextB = Math.round(b + (255 - b) * mix);
  return `rgb(${nextR}, ${nextG}, ${nextB})`;
}

function entityTileRenderPos(
  entity: ServerStateSnapshot["entities"][number]
): { x: number; y: number } {
  if (entity.moving) {
    const phase = Math.max(0, Math.min(1, entity.phase));
    return {
      x: entity.fromX + (entity.toX - entity.fromX) * phase,
      y: entity.fromY + (entity.toY - entity.fromY) * phase
    };
  }
  return { x: entity.x, y: entity.y };
}
