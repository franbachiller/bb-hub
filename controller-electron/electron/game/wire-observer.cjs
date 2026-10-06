"use strict";

// CDP observes the existing socket. It never wraps, queues or replaces sends.
const fs = require("node:fs");
const path = require("node:path");
const { installCdpWireTap } = require("./wire-tap.cjs");

function wireMetadata(row) {
  if (!/^wire\.websocket\.(sent|received)$/.test(row?.kind || "")) return null;
  return { event: row.kind, cdpMs: row.t, source: row.data.source,
    requestId: row.data.requestId, opcode: row.data.opcode, byteLength: row.data.byteLength };
}

async function observeWire(page, outputDir, onError = () => {}) {
  const file = path.join(outputDir, "wire_metadata.ndjson");
  const stream = fs.createWriteStream(file, { flags: "a", encoding: "utf8" });
  let failed = false;
  stream.on("error", () => { failed = true; onError("No se pudo guardar el registro de conexion."); });
  const append = data => {
    if (failed || stream.destroyed) return;
    if (stream.writableLength > 1024 * 1024) {
      failed = true; stream.end(); onError("Registro de conexion detenido por acumulacion en disco."); return;
    }
    stream.write(JSON.stringify({ receivedAtUtc: new Date().toISOString(), ...data }) + "\n");
  };
  let tap;
  try {
    tap = await installCdpWireTap(page, row => {
      const data = wireMetadata(row);
      if (data) append(data);
    });
  } catch (error) { stream.end(); throw error; }
  return {
    file,
    async anchor(frame) {
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
    async close() {
      await tap.session.detach().catch(() => {});
      if (!stream.destroyed && !stream.writableFinished) {
        await new Promise(resolve => {
          stream.once("close", resolve); stream.once("error", resolve);
          if (!stream.writableEnded) stream.end();
        });
      }
    }
  };
}

module.exports = { observeWire, wireMetadata };
