"use strict";
// Copia el runtime del juego desde HTML5/hub_runtime (donde se desarrolla) a
// electron/game (lo que empaqueta el Hub). Correr antes de `npm run dist`
// cada vez que cambie flash_runtime.page.js o ring_scene.page.js.
const fs = require("fs");
const path = require("path");

const FROM = path.resolve(__dirname, "..", "..", "HTML5", "hub_runtime");
const TO = path.resolve(__dirname, "..", "electron", "game");
const FILES = ["flash_runtime.page.js", "ring_scene.page.js"];

for (const name of FILES) {
  const src = path.join(FROM, name);
  if (!fs.existsSync(src)) {
    console.error(`No existe ${src}`);
    process.exit(1);
  }
  fs.copyFileSync(src, path.join(TO, name));
}
const build = fs.readFileSync(path.join(TO, "flash_runtime.page.js"), "utf8").match(/BRIDGE_BUILD = "([^"]+)"/);
console.log(`Runtime copiado: ${build ? build[1] : "build desconocido"}`);
