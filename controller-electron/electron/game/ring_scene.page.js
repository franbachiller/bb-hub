(() => {
  "use strict";
  // Ring (mGame2) walkable ranges (y -> [minX, maxX]): 117 tiles after the 22–23/09
  // update, read live from spaceModel.escenario.matrix
  // (recon/live-20260923/ring_mGame2_static_20260923.json).
  window.__BBFlashRingScene = {
    RING_ROWS: new Map([
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
    ]),
    buildRingMatrices() {
      const rows = this.RING_ROWS;
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
    },
    fnv1aHex(text) {
      let hash = 0x811c9dc5;
      for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
      }
      return (hash >>> 0).toString(16).padStart(8, "0");
    }
  };
})();
