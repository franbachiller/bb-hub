"use strict";
const net = require("node:net"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), assert = require("node:assert/strict");
const base = process.env.BB_PACKAGED_APP_DIR ? path.join(process.env.BB_PACKAGED_APP_DIR, "resources/app.asar/electron") : path.resolve(__dirname, "../electron");
const { ControllerCore } = require(path.join(base, "controller-core.cjs"));
const { HubBridge } = require(path.join(base, "game/hub-bridge.cjs"));
const { GameLauncher } = require(path.join(base, "game/game-launcher.cjs"));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "bb-port-conflict-"));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { const end = Date.now() + 3000; while (!fn()) { assert.ok(Date.now() < end, "TCP fixture timed out"); await delay(20); } }
async function run() {
  const blocker = net.createServer();
  let foreignConnections = 0;
  blocker.on("connection", socket => { foreignConnections++; socket.destroy(); });
  await new Promise(resolve => blocker.listen(0, "127.0.0.1", resolve));
  const occupied = blocker.address().port;
  const core = new ControllerCore({ port: occupied, autoPort: true, ringBoard: false, settingsPath: path.join(profile, "settings.json") });
  const legacy = new ControllerCore({ port: occupied, ringBoard: false, settingsPath: path.join(profile, "legacy.json") });
  let bridge;
  try {
    // Binding the same real port reproduces the customer's EADDRINUSE.
    legacy.startTcpServer();
    await assert.rejects(legacy.waitForTcpReady(), /EADDRINUSE/);
    assert.equal(legacy.tcpServer.listening, false);
    core.startTcpServer();
    const actualPort = await core.waitForTcpReady();
    assert.notEqual(actualPort, occupied);
    assert.equal(core.tcpServer.address().address, "127.0.0.1");
    const received = [];
    bridge = new HubBridge({ port: actualPort, onMessage: obj => received.push(obj) });
    // An already booted game reports state without repeating hello.
    bridge.send({ type: "state", selfId: 17, bridgeBuild: "fixture-v68", players: [] });
    bridge.start();
    await until(() => core.snapshot().connected && core.bridgeBuild === "fixture-v68");
    await until(() => received.some(obj => obj.type === "step_walk_config"));
    bridge.send({ type: "hello", selfId: 17, bridgeBuild: "fixture-v68" });
    assert.equal(foreignConnections, 0, "No messages may be sent to the other process");
    const launcher = new GameLauncher({ accountPath: path.join(profile, "account.json"), optionsPath: path.join(profile, "options.json"), captureRoot: profile, clientExe: "", hubPort: occupied,
      resolveHubPort: () => core.waitForTcpReady(),
      isRuntimeConnected: (link, build) => Boolean(core.swfSocket && core.swfAddr?.port === link.socket?.localPort && core.bridgeBuild === build) });
    launcher.hubPort = await launcher.resolveHubPort();
    assert.equal(launcher.hubPort, actualPort);
    launcher.bridge = bridge;
    await launcher.waitForHubConnection("fixture-v68", 500);
    // A TCP connection alone must not mark a wrong/stale runtime ready.
    await assert.rejects(launcher.waitForHubConnection("wrong-build", 150), /no pudo comunicarse/);
    bridge.stop();
    await until(() => !core.snapshot().connected);
    await assert.rejects(launcher.waitForHubConnection("fixture-v68", 150), /no pudo comunicarse/);
    await new Promise(resolve => core.tcpServer.close(resolve));
    await assert.rejects(core.waitForTcpReady(), /detenida/);
    // Resuming the controller gets a fresh readiness promise and live port.
    core.startTcpServer();
    assert.equal(await core.waitForTcpReady(), actualPort);
    assert.ok(core.logs.some(row => String(row.text || row.message || row).includes("ocupado")) || core.port !== occupied);
    console.log(`PASS ${process.env.BB_PACKAGED_APP_DIR ? "protected ASAR" : "source"}: actual EADDRINUSE fallback, own-port relay, hello/config round trip, no foreign traffic, readiness checks and restart.`);
  } finally {
    bridge?.stop(); core.stop(); legacy.stop();
    await new Promise(resolve => blocker.close(resolve));
  }
}
if (process.versions.electron) {
  const { app } = require("electron");
  app.whenReady().then(run).then(() => app.exit(0), error => { console.error(error); app.exit(1); });
} else run().catch(error => { console.error(error); process.exitCode = 1; });
