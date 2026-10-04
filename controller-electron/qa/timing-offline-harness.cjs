"use strict";
// Run the existing combat fixtures against any source runtime. The fixture's
// clock is frozen; a production busy-wait would hang it forever. Stub only
// spinUntil; the fixture explicitly sets every dispatch time. This suite checks
// decisions and protocol behavior, not wall-clock latency.
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const file = path.resolve(__dirname, "harness/test-hub-runtime.cjs");
const runtime = path.resolve(process.argv[2] || path.join(__dirname, "../electron/game/flash_runtime.page.js"));
let harness = fs.readFileSync(file, "utf8");
const learningKey = fs.readFileSync(runtime, "utf8").match(/const TICK_AUTO_KEY = "([^"]+)"/)?.[1];
if (learningKey) harness = harness.replaceAll("bbhub.tickAuto.v5", learningKey);
harness = harness.replace('const runtimePath = path.resolve(__dirname, "../../electron/game/flash_runtime.page.js");',
  `const runtimePath = ${JSON.stringify(runtime)};`);
harness = harness.replace('const original = fs.readFileSync(runtimePath, "utf8");',
  `const source = fs.readFileSync(runtimePath, "utf8");
   const spinStart = source.indexOf("  function spinUntil(");
   const spinEnd = source.indexOf("\\n  }", spinStart) + 4;
   assert.ok(spinStart >= 0 && spinEnd > spinStart, "spinUntil fixture boundary");
   const original = source.slice(0, spinStart) +
     "  function spinUntil(due) {}" + source.slice(spinEnd);`);
const test = new Module(file, module);
test.filename = file;
test.paths = Module._nodeModulePaths(path.dirname(file));
test._compile(harness, file);
