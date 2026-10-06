"use strict";

// CDP observes the existing socket. It never wraps, queues or replaces sends.
// 06/10: the Hub keeps it attached for the whole game connection (both setups
// that played right had it on: the original launcher and 0.1.18 with the combat
// log); the file is written only while the combat log is on.
const fs = require("node:fs");
const path = require("node:path");
const { installCdpWireTap } = require("./wire-tap.cjs");

function wireMetadata(row) {
  if (!/^wire\.websocket\.(sent|received)$/.test(row?.kind || "")) return null;
  return { event: row.kind, cdpMs: row.t, source: row.data.source,
    requestId: row.data.requestId, opcode: row.data.opcode, byteLength: row.data.byteLength };
}

async function observeWire(page, outputDir, onError = () => {}) {
  let stream = null;
  let file = "";
  let failed = false;
  const endStream = async () => {
    const s = stream;
    stream = null;
    if (!s || s.destroyed || s.writableFinished) return;
    await new Promise(resolve => {
      s.once("close", resolve); s.once("error", resolve);
      if (!s.writableEnded) s.end();
    });
  };
  const open = dir => {
    if (!dir) { file = ""; return; }
    file = path.join(dir, "wire_metadata.ndjson");
    failed = false;
    stream = fs.createWriteStream(file, { flags: "a", encoding: "utf8" });
    stream.on("error", () => { failed = true; onError("No se pudo guardar el registro de conexion."); });
  };
  const append = data => {
    if (!stream || failed || stream.destroyed) return;
    if (stream.writableLength > 1024 * 1024) {
      failed = true; stream.end(); onError("Registro de conexion detenido por acumulacion en disco."); return;
    }
    stream.write(JSON.stringify({ receivedAtUtc: new Date().toISOString(), ...data }) + "\n");
  };
  const tap = await installCdpWireTap(page, row => {
    if (!stream) return;
    const data = wireMetadata(row);
    if (data) append(data);
  });
  open(outputDir);
  const api = {
    get file() { return file; },
    get writing() { return Boolean(stream); },
    async anchor(frame) {
      if (!stream) return;
      await tap.session.send("Performance.enable");
      const before = await tap.session.send("Performance.getMetrics");
      const clock = await frame.evaluate(() => ({ pageMs: performance.now(), timeOrigin: performance.timeOrigin }));
      const after = await tap.session.send("Performance.getMetrics");
      const timestamp = metrics => metrics.metrics.find(m => m.name === "Timestamp")?.value * 1000;
      const a = timestamp(before), b = timestamp(after);
      if (Number.isFinite(a) && Number.isFinite(b) && b >= a) {
        append({ event: "wire.clock", ...clock, cdpMs: (a+b)/2, errorBoundMs: (b-a)/2 });
      }
      await tap.session.send("Performance.disable");
    },
    // Start or stop writing without detaching the observer.
    async setOutput(dir, frame) {
      await endStream();
      open(dir);
      if (dir && frame) await api.anchor(frame).catch(() => onError("No se pudo sincronizar el reloj."));
    },
    async close() {
      await tap.session.detach().catch(() => {});
      await endStream();
    }
  };
  return api;
}

module.exports = { observeWire, wireMetadata };
