"use strict";
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

async function analyze(file) {
  const result = {
    file, validRows: 0, malformedRows: 0,
    attempts: 0, nativeCalls: 0, attemptsWithoutDispatch: 0, callErrors: 0,
    observedOutgoing211: 0, incoming144: 0, incoming211: 0,
    selfAttacker: 0, selfDefender: 0, unknownSelfOutcomes: 0,
    resync215: 0, resyncKinds: {}, resyncSamples: [],
    hiddenPackets: 0, maxInboundBacklog: 0, configChanges: 0,
    limitations: [
      "Outgoing means native socket API returned, not a confirmed WebSocket frame or server receipt.",
      "No dispatch does not establish a cause; inspect errors and shared native cooldown.",
      "215 describes animation resynchronization, not a demonstrated advance warning or server cooldown."
    ]
  };
  for await (const line of readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { result.malformedRows++; continue; }
    if (row.type !== "diagnostic_event") continue;
    result.validRows++;
    if (row.event === "config") result.configChanges++;
    if (row.event === "fire_attempt") {
      result.attempts++;
      result.nativeCalls += Number(row.calls) || 0;
      result.callErrors += Number(row.errors) || 0;
      if (row.sentCount === 0) result.attemptsWithoutDispatch++;
    }
    if (row.event !== "packet") continue;
    if (row.hidden) result.hiddenPackets++;
    result.maxInboundBacklog = Math.max(result.maxInboundBacklog, Number(row.inboundBacklog) || 0);
    const packet = row.packet || {};
    if (row.direction === "out") {
      if (packet.id === 211) result.observedOutgoing211++;
      continue;
    }
    if (row.direction !== "in") continue;
    if (packet.id === 144) result.incoming144++;
    if (packet.id === 211) {
      result.incoming211++;
      const fields = packet.fields || [];
      if (!Number.isInteger(row.selfId) || row.selfId < 0) result.unknownSelfOutcomes++;
      else if (Number(fields[2]) === row.selfId) result.selfAttacker++;
      else if (Number(fields[6]) === row.selfId) result.selfDefender++;
    }
    if (packet.id === 215) {
      result.resync215++;
      const fields = (packet.fields || []).map(Number);
      const kind = fields[2];
      result.resyncKinds[kind] = (result.resyncKinds[kind] || 0) + 1;
      if (result.resyncSamples.length < 12) result.resyncSamples.push({
        ts: row.ts, userSpaceId: fields[0], accountId: fields[1], kind,
        parameter: fields[3], peerUserSpaceId: fields[4],
        elapsedMs: fields[5], totalMs: fields[6] ?? null, hidden: Boolean(row.hidden)
      });
    }
  }
  return result;
}

if (require.main === module) {
  if (!process.argv[2]) {
    console.error("Usage: node HTML5/tools/analyze_hub_diagnostics.js <capture-directory-or-ndjson>");
    process.exitCode = 1;
  } else {
    const input = path.resolve(process.argv[2]);
    const file = fs.statSync(input).isDirectory() ? path.join(input, "hub_diagnostics.ndjson") : input;
    analyze(file).then((result) => console.log(JSON.stringify(result, null, 2)))
      .catch((error) => { console.error(error.message); process.exitCode = 1; });
  }
}
module.exports = { analyze };
