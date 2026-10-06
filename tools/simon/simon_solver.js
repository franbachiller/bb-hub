// Simon Dice cartel solver (prototype, runs in the game page).
// Input: RGBA pixels of the cartel (a band with the asked face on top, a 4x2
// grid of shuffled faces below). Output: { go, cell, conf, ... }.
// The grid faces change size and position per cell and the grid background
// carries noise specks, so faces are compared after cropping each one to its
// own bounding box and resampling to a fixed size.
function simonSolve(px, w, h) {
  const at = (x, y) => (y * w + x) * 4;
  const rgb = (x, y) => { const i = at(x, y); return [px[i], px[i + 1], px[i + 2]]; };
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

  // Asked face: in the band, left of the white tick circle (right ~45%).
  const bandRef = (() => { let n = 0, s = [0, 0, 0]; for (let y = 4; y < bandH - 4; y++) for (let x = 2; x < 30; x++) { const c = rgb(x, y); s[0] += c[0]; s[1] += c[1]; s[2] += c[2]; n++; } return s.map((v) => v / n); })();
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  // Face pixels: saturated. In the band also far from the band's own green
  // (the fart cloud is a much lighter green); the band crop stops before the tick.
  const faceLike = ([r, g, b]) => Math.max(r, g, b) - Math.min(r, g, b) > 55;
  const target = crop(Math.round(w * 0.22), 4, Math.round(w * 0.52), bandH - 4, (c) => faceLike(c) && dist(c, bandRef) > 60);
  if (!target) return { go: true, error: "no_target_face", bandH };

  // Grid cells: 4 columns x 2 rows below the band.
  const cells = [];
  const gh = h - bandH;
  for (let row = 0; row < 2; row++) for (let col = 0; col < 4; col++) {
    const x0 = Math.round((col * w) / 4) + 3, x1 = Math.round(((col + 1) * w) / 4) - 3;
    const y0 = bandH + Math.round((row * gh) / 2) + 3, y1 = bandH + Math.round(((row + 1) * gh) / 2) - 3;
    // Face pixels: saturated (the beige background and its specks are not).
    cells.push(crop(x0, y0, x1, y1, faceLike));
  }
  const scores = cells.map((c) => (c ? compare(target, c) : Infinity));
  const order = scores.map((s, i) => [s, i]).sort((a, b) => a[0] - b[0]);
  const best = order[0], second = order[1];
  return { go: true, cell: best[1], score: +best[0].toFixed(1), conf: +(second[0] / Math.max(1e-6, best[0])).toFixed(2), scores: scores.map((s) => +s.toFixed(1)), bandH };

  // Bounding box of the matching pixels, resampled to N x N RGB + mask.
  function crop(x0, y0, x1, y1, isFace) {
    let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (isFace(rgb(x, y))) {
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    if (maxX < 0 || maxX - minX < 6 || maxY - minY < 6) return null;
    const N = 20, out = new Float32Array(N * N * 4);
    const dark = new Float32Array(N * N); // eyes and mouth: dark strokes inside the face
    const bw = maxX - minX + 1, bh = maxY - minY + 1, side = Math.max(bw, bh);
    const cx = minX + bw / 2, cy = minY + bh / 2;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      let s = [0, 0, 0], m = 0, n = 0, d = 0;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const x = Math.floor(cx - side / 2 + ((i + (dx + 0.5) / 2) * side) / N);
        const y = Math.floor(cy - side / 2 + ((j + (dy + 0.5) / 2) * side) / N);
        n++;
        if (x < x0 || x >= x1 || y < y0 || y >= y1) continue;
        const c = rgb(x, y);
        if (isFace(c)) { s[0] += c[0]; s[1] += c[1]; s[2] += c[2]; m++; }
        else if (Math.max(c[0], c[1], c[2]) < 120) d++;
      }
      const k = (j * N + i) * 4;
      out[k] = m ? s[0] / m : 0; out[k + 1] = m ? s[1] / m : 0; out[k + 2] = m ? s[2] / m : 0; out[k + 3] = m / n;
      dark[j * N + i] = d / n;
    }
    out.dark = dark;
    // Colour mix of the whole face (scale-free): 4 levels per channel.
    const hist = new Float32Array(64);
    let total = 0;
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
      const c = rgb(x, y);
      if (!isFace(c)) continue;
      hist[(c[0] >> 6) * 16 + (c[1] >> 6) * 4 + (c[2] >> 6)]++;
      total++;
    }
    for (let i = 0; i < 64; i++) hist[i] /= total || 1;
    out.hist = hist;
    return out;
  }

  // Mean colour distance over the union of both masks (+ mask mismatch).
  function compare(a, b) {
    let sum = 0, n = 0;
    for (let k = 0; k < a.length; k += 4) {
      const ma = a[k + 3], mb = b[k + 3];
      if (ma < 0.25 && mb < 0.25) continue;
      n++;
      if (ma >= 0.25 && mb >= 0.25) sum += Math.hypot(a[k] - b[k], a[k + 1] - b[k + 1], a[k + 2] - b[k + 2]);
      else sum += 160;
    }
    if (!n) return Infinity;
    let h = 0;
    for (let i = 0; i < 64; i++) h += Math.abs(a.hist[i] - b.hist[i]);
    // Shape/colour per pixel + overall colour mix (0..2, weighted).
    let dk = 0;
    for (let i = 0; i < a.dark.length; i++) dk += Math.abs(a.dark[i] - b.dark[i]);
    // Shape/colour per pixel + overall colour mix + eyes/mouth strokes.
    return sum / n + 40 * h + 400 * (dk / a.dark.length);
  }
}
