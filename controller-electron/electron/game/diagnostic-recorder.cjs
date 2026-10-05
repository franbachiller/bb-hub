"use strict";

const fs = require("node:fs");
const path = require("node:path");

// Combat evidence only: movement, uppers and replies, coco, and what the
// engines decided. Never auth, tickets or chat.
const EVENTS = new Set([
  "packet", "config", "fire_attempt", "fire_target_blocked", "island_reentry", "room_boundary",
  "tick_fire", "tick_skip", "tick_reply", "tick_race", "target_muted", "exit_fire", "exit_result", "guard_fire", "unlock_fire", "runlock_fire", "tick_dual", "lab_cooldown",
  // who is behind each room id (per ring), and every ring-board move decision with its reason
  "roster", "rb_move", "burst_ab", "coco_guard", "platform", "reach_probe", "auto_ring", "emote", "requeue", "react_fallback"
]);
const PACKETS = new Set([182, 211, 144, 215, 184, 135, 149, 160]); // 149: coco request, 160: round (27/09)

// Separate from the Hub bridge so packet logging works with packaged Hubs too.
function createDiagnosticRecorder(outputDir, { enabled = false, onError = () => {} } = {}) {
  let stream = null;
  let failed = false;
  const file = path.join(outputDir, "hub_diagnostics.ndjson");
  return {
    file,
    record(message) {
      if (!enabled || failed || message?.type !== "diagnostic_event") return false;
      if (!EVENTS.has(message.event)) return false;
      if (message.event === "packet" && !PACKETS.has(message.packet?.id)) return false;
      if (!stream) {
        stream = fs.createWriteStream(file, { flags: "a", encoding: "utf8" });
        stream.on("error", (error) => { failed = true; onError(error); });
      }
      // Bound buffering; diagnostics must not exhaust memory if storage stalls.
      if (stream.writableLength > 1024 * 1024) {
        failed = true;
        stream.end();
        onError(new Error("Diagnostic capture stopped: storage backlog exceeded 1 MiB"));
        return false;
      }
      stream.write(JSON.stringify({ receivedAtUtc: new Date().toISOString(), ...message }) + "\n");
      return true;
    },
    async close() {
      if (!stream || stream.destroyed || stream.writableFinished) return;
      await new Promise((resolve) => {
        stream.once("close", resolve);
        stream.once("error", resolve);
        if (!stream.writableEnded) stream.end();
      });
    }
  };
}

module.exports = { createDiagnosticRecorder };
