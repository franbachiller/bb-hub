"use strict";
// Pipeline de protección de BB Hub.
//
// Para cada archivo sensible del proceso principal:
//   1) lo ofusca (javascript-obfuscator, perfil LIGERO para no castigar el timing),
//   2) lo compila a bytecode V8 (.jsc) con bytenode,
//   3) deja en su lugar un shim mínimo que carga el .jsc.
//
// Produce ./protected/electron/** (copia de electron/ con los .cjs sensibles
// reemplazados por shim + .jsc). electron-builder empaqueta DESDE ahí.
//
// CLAVE: este script DEBE correr bajo Electron (ELECTRON_RUN_AS_NODE=1 electron
// scripts/protect.cjs) para que el bytecode sea el del V8 de Electron, no el del
// Node del sistema. Lo hace el script "protect" del package.json.

const fs = require("fs");
const path = require("path");
const JSObf = require("javascript-obfuscator");
const bytenode = require("bytenode");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "electron");
const OUT = path.join(ROOT, "protected", "electron");

// Archivos del proceso principal a blindar (rutas relativas a electron/).
const PROTECT = [
  "main.cjs",
  "controller-core.cjs",
  "updater.cjs",
  "hotkey.cjs",
  "license/gate.cjs",
  "game/game-launcher.cjs",
  "game/hub-bridge.cjs"
];

// Runtime que se inyecta en la página del juego. Solo renombrado (sin string
// array): corre el timing en tiempo real dentro del cliente.
const PAGE_SCRIPTS = ["game/flash_runtime.page.js", "game/ring_scene.page.js"];

// Los preloads sandboxed solo pueden importar electron y módulos permitidos.
// Se ofuscan en un único archivo, sin el loader Node de bytenode.
const PRELOADS = ["preload.cjs", "license/license-preload.cjs"];

// Perfil ligero: renombrado + string array codificado, SIN
// control-flow-flattening ni dead-code (esos cuestan CPU y el bot es realtime).
// El bytecode ya es la capa fuerte; la ofuscación es el respaldo si lo decompilan.
const OBF_OPTS = {
  compact: true,
  target: "node",
  controlFlowFlattening: false,
  deadCodeInjection: false,
  stringArray: true,
  stringArrayEncoding: ["base64"],
  stringArrayThreshold: 0.8,
  splitStrings: false,
  identifierNamesGenerator: "hexadecimal",
  renameGlobals: false,
  selfDefending: false,
  simplify: true,
  disableConsoleOutput: false,
  sourceMap: false
};

const PAGE_OBF_OPTS = { ...OBF_OPTS, target: "browser", stringArray: false };

// BB_NO_OBF=1 compila solo bytecode (sin ofuscar) para aislar problemas.
const NO_OBF = process.env.BB_NO_OBF === "1";

function log(msg) { process.stdout.write(msg + "\n"); }

function rmrf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  fs.cpSync(from, to, { recursive: true });
}

function shimFor(baseName) {
  // Carga bytenode (registra el handler .jsc) y devuelve el módulo real.
  return `"use strict";\nrequire("bytenode");\nmodule.exports = require("./${baseName}.jsc");\n`;
}

async function protectOne(rel) {
  const srcPath = path.join(SRC, rel);
  const outCjs = path.join(OUT, rel);
  const dir = path.dirname(outCjs);
  const base = path.basename(rel, ".cjs");
  const jscPath = path.join(dir, base + ".jsc");
  const tmpObf = path.join(dir, base + ".obf.tmp.cjs");

  const source = fs.readFileSync(srcPath, "utf8");
  const obf = NO_OBF ? source : JSObf.obfuscate(source, OBF_OPTS).getObfuscatedCode();
  fs.writeFileSync(tmpObf, obf, "utf8");

  // Compila a bytecode con el V8 de Electron. compileFile spawnea un Electron
  // hijo con los flags correctos, para que el .jsc cargue en el proceso GUI.
  await bytenode.compileFile({ filename: tmpObf, output: jscPath, compileAsModule: true, electron: true });
  fs.rmSync(tmpObf, { force: true });

  // Reemplaza el .cjs por el shim.
  fs.writeFileSync(outCjs, shimFor(base), "utf8");

  const kb = (n) => (n / 1024).toFixed(1) + "k";
  log(`  ✓ ${rel.padEnd(30)} src ${kb(source.length).padStart(7)} → jsc ${kb(fs.statSync(jscPath).size)}`);
}

async function main() {
  log("BB Hub — protect (ofuscar + bytecode)");
  log(`  bytenode usando V8: ${process.versions.v8} (electron ${process.versions.electron || "?"})`);
  rmrf(path.join(ROOT, "protected"));
  copyTree(SRC, OUT);
  log("  copiada electron/ → protected/electron/");
  // Sacamos de la copia lo que no debe viajar.
  fs.rmSync(path.join(OUT, "license", "README.md"), { force: true });
  log("  blindando archivos sensibles:");
  for (const rel of PROTECT) await protectOne(rel);
  for (const rel of PRELOADS) {
    const source = fs.readFileSync(path.join(SRC, rel), "utf8");
    const obf = NO_OBF ? source : JSObf.obfuscate(source, OBF_OPTS).getObfuscatedCode();
    fs.writeFileSync(path.join(OUT, rel), obf, "utf8");
    log(`  ✓ ${rel} → preload autónomo (sandbox)`);
  }
  // The bundled Node server and its solver/worker modules contain product
  // logic too. Preserve ESM imports while obfuscating the packaged copy.
  const boardDist = path.join(OUT, "ring-board", "dist");
  function protectTree(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) protectTree(file);
      else if (entry.name.endsWith(".map")) fs.rmSync(file);
      else if (entry.name.endsWith(".js") && path.relative(boardDist, file).split(path.sep)[0] !== "web") {
        const source = fs.readFileSync(file, "utf8");
        fs.writeFileSync(file, NO_OBF ? source : JSObf.obfuscate(source, OBF_OPTS).getObfuscatedCode(), "utf8");
      }
    }
  }
  protectTree(boardDist);
  const runtimeBuild = fs.readFileSync(path.join(SRC, "game", "flash_runtime.page.js"), "utf8").match(/BRIDGE_BUILD = "([^"]+)"/);
  log(`  runtime del juego: ${runtimeBuild ? runtimeBuild[1] : "build desconocido"}`);
  for (const rel of PAGE_SCRIPTS) {
    const file = path.join(OUT, rel);
    const source = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, NO_OBF ? source : JSObf.obfuscate(source, PAGE_OBF_OPTS).getObfuscatedCode(), "utf8");
    log(`  ✓ ${rel} → ofuscado (página del juego)`);
  }
  log("  ✓ ring-board servidor / solver / worker → ofuscados, sin source maps");
  log("listo. electron-builder empaqueta desde protected/electron/");
}

main().catch((error) => {
  process.stderr.write("protect fallo: " + (error.stack || error.message) + "\n");
  process.exit(1);
});
