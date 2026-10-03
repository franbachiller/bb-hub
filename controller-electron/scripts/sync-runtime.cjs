"use strict";
// Copia el runtime del juego desde HTML5/hub_runtime (donde se desarrolla) a
// electron/game (lo que empaqueta el Hub). Correr antes de `npm run dist`
// cada vez que cambie flash_runtime.page.js o ring_scene.page.js.
const fs = require("fs");
const path = require("path");

const FROM = path.resolve(__dirname, "..", "..", "HTML5", "hub_runtime");
const TO = path.resolve(__dirname, "..", "electron", "game");
const FILES = ["flash_runtime.page.js", "ring_scene.page.js"];

// 03/10: Gemini cambió HTML5/hub_runtime/flash_runtime.page.js sin cambiarle el
// build (v6_62): disparo por paso contra cualquiera que se mueva, +5000 al
// seleccionado en threatPick, coco a cualquiera en diagonal y el avatar en cada
// state. Esa copia no se vuelve a empaquetar.
const GEMINI_MARKERS = ["cocoGuardOnEnemyStep", "BoomBangFlowerPowerAvatar", "isSelected ? 5000"];

for (const name of FILES) {
  const src = path.join(FROM, name);
  if (!fs.existsSync(src)) {
    console.error(`No existe ${src}`);
    process.exit(1);
  }
  const text = fs.readFileSync(src, "utf8");
  const marker = GEMINI_MARKERS.find((m) => text.includes(m));
  if (marker) {
    console.error(`${src} tiene los cambios de Gemini del 03/10 (${marker}). No se copió.`);
    console.error("Restaurá HTML5/hub_runtime con el runtime de electron/game.");
    process.exit(1);
  }
}
for (const name of FILES) fs.copyFileSync(path.join(FROM, name), path.join(TO, name));
const build = fs.readFileSync(path.join(TO, "flash_runtime.page.js"), "utf8").match(/BRIDGE_BUILD = "([^"]+)"/);
console.log(`Runtime copiado: ${build ? build[1] : "build desconocido"}`);
