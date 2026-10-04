"use strict";
// Copia el runtime del juego desde HTML5/hub_runtime (donde se desarrolla) a
// electron/game (lo que empaqueta el Hub). Correr antes de `npm run dist`
// cada vez que cambie flash_runtime.page.js o ring_scene.page.js.
const fs = require("fs");
const path = require("path");

const FROM = path.resolve(__dirname, "..", "..", "HTML5", "hub_runtime");
const TO = path.resolve(__dirname, "..", "electron", "game");
const FILES = ["flash_runtime.page.js", "ring_scene.page.js"];

// 03/10: la versión experimental cambió HTML5/hub_runtime/flash_runtime.page.js sin cambiarle el
// build (v6_62): disparo por paso contra cualquiera que se mueva, +5000 al
// seleccionado en threatPick, coco a cualquiera en diagonal y el avatar en cada
// state. Esa copia no se vuelve a empaquetar.
const EXPERIMENTAL_MARKERS = ["cocoGuardOnEnemyStep", "BoomBangFlowerPowerAvatar", "isSelected ? 5000"];

for (const name of FILES) {
  const src = path.join(FROM, name);
  if (!fs.existsSync(src)) {
    console.error(`No existe ${src}`);
    process.exit(1);
  }
  const text = fs.readFileSync(src, "utf8");
  const marker = EXPERIMENTAL_MARKERS.find((m) => text.includes(m));
  if (marker) {
    console.error(`${src} tiene los cambios experimentales del 03/10 (${marker}). No se copió.`);
    console.error("Restaurá HTML5/hub_runtime con el runtime de electron/game.");
    process.exit(1);
  }
}
// 04/10: the Hub ships v6_44 (29/09), the timing the user validated; everything
// after it (01/10-04/10) is out. A different build only replaces it with --force.
const build = (text) => (String(text).match(/BRIDGE_BUILD = "([^"]+)"/) || [])[1] || "";
const incoming = build(fs.readFileSync(path.join(FROM, "flash_runtime.page.js"), "utf8"));
const current = build(fs.readFileSync(path.join(TO, "flash_runtime.page.js"), "utf8"));
if (incoming !== current && !process.argv.includes("--force")) {
  console.error(`HTML5/hub_runtime tiene ${incoming || "un build desconocido"}; el Hub empaqueta ${current}. No se copió.`);
  console.error("Para reemplazarlo igual: npm run sync-runtime -- --force");
  process.exit(1);
}
for (const name of FILES) fs.copyFileSync(path.join(FROM, name), path.join(TO, name));
console.log(`Runtime copiado: ${build(fs.readFileSync(path.join(TO, "flash_runtime.page.js"), "utf8")) || "build desconocido"}`);
