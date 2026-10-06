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
