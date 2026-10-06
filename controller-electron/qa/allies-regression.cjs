"use strict";
// Allies (06/10): accounts instead of a comma list, one-click toggles from the
// room, exact names with commas, name -> account binding and portrait storage.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ControllerCore } = require("../electron/controller-core.cjs");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-allies-"));
const settingsPath = path.join(dir, "settings.json");
// A profile saved by the old Hub: names and an account id typed as text.
fs.writeFileSync(settingsPath, JSON.stringify({ allies: ["Flee", "10812707", "flee", " "] }));

const core = new ControllerCore({ port: 0, autoPort: true, ringBoard: false, settingsPath });
const sent = [];
core.sendToSwf = (msg) => { sent.push(msg); return true; };
const lastAllyConfig = () => sent.filter((m) => m.type === "ally_config").at(-1);

try {
  assert.deepEqual(core.snapshot().allies, [{ accountId: null, name: "Flee" }, { accountId: 10812707, name: "" }], "old list migrated, duplicates and blanks dropped");

  // One click on a room player (name with a comma) adds it by account.
  core.toggleAlly({ accountId: 10940645, name: "Chucky, el muñeco" });
  assert.deepEqual(lastAllyConfig(), { type: "ally_config", accounts: [10812707, 10940645], names: ["Flee"] });
  assert.equal(core.snapshot().allies.at(-1).name, "Chucky, el muñeco", "comma kept inside the name");
  // A second click removes it.
  core.toggleAlly({ accountId: 10940645, name: "Chucky, el muñeco" });
  assert.deepEqual(lastAllyConfig().accounts, [10812707]);

  // Typed exact name, not in the room: kept by name.
  core.addAllyByName("  Pepe, el Grande ");
  assert.ok(core.snapshot().allies.some((a) => a.name === "Pepe, el Grande" && a.accountId === null));
  assert.ok(lastAllyConfig().names.includes("Pepe, el Grande"));

  // The players arrive: the name-only allies bind to their accounts, the
  // account-only ally gets its current name.
  core.selfId = 4;
  core.handleSwfMessage({ type: "state", selfId: 4, players: [
    { id: 4, userId: 11008488, name: "Herbert", self: true },
    { id: 1, userId: 10144347, name: "flee" },
    { id: 2, userId: 10812707, name: "Rauw" },
    { id: 3, userId: 10999999, name: "Pepe, el Grande" }
  ] });
  const bound = core.snapshot().allies;
  assert.deepEqual(bound.find((a) => a.accountId === 10144347), { accountId: 10144347, name: "Flee" });
  assert.deepEqual(bound.find((a) => a.accountId === 10812707), { accountId: 10812707, name: "Rauw" });
  assert.ok(bound.some((a) => a.accountId === 10999999 && a.name === "Pepe, el Grande"));
  assert.deepEqual(lastAllyConfig().names, [], "every ally matched by account once bound");

  // Ring-board never receives allies: keys are account ids.
  const keys = core.boardAllyKeys();
  assert.ok(keys.has("10144347") && keys.has("10812707"));

  // Removing by account.
  core.removeAlly({ accountId: 10812707 });
  assert.ok(!core.snapshot().allies.some((a) => a.accountId === 10812707));

  // Portraits: a better angle replaces a worse one, never the reverse; allies'
  // portraits survive a restart, other players' do not.
  const png = (n) => `data:image/png;base64,${Buffer.from(`img${n}`).toString("base64")}`;
  core.notePortrait({ accountId: 10144347, name: "Flee", url: png(1), quality: 0 });
  core.notePortrait({ accountId: 10144347, name: "Flee", url: png(2), quality: 2 });
  core.notePortrait({ accountId: 10144347, name: "Flee", url: png(3), quality: 1 });
  core.notePortrait({ accountId: 10555555, name: "Otro", url: png(4), quality: 2 });
  core.notePortrait({ accountId: 10555556, name: "Malo", url: "javascript:alert(1)", quality: 2 });
  assert.equal(core.getPortraits()[10144347], png(2));
  assert.equal(core.getPortraits()[10555555], png(4));
  assert.equal(core.getPortraits()[10555556], undefined, "only data:image URLs are kept");
  assert.ok(core.snapshot().portraitVersion >= 2);
} finally {
  clearTimeout(core.portraitSaveTimer);
  core.saveAllyPortraits();
}

setTimeout(() => {
  try {
    clearTimeout(core.portraitSaveTimer);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, "ally-portraits.json"), "utf8"));
    assert.deepEqual(Object.keys(saved), ["10144347"], "only allies' portraits on disk");
    const again = new ControllerCore({ port: 0, autoPort: true, ringBoard: false, settingsPath });
    assert.equal(again.getPortraits()[10144347], `data:image/png;base64,${Buffer.from("img2").toString("base64")}`);
    assert.ok(again.snapshot().allies.some((a) => a.accountId === 10144347 && a.name === "Flee"));
    console.log("PASS allies: legacy list migrated, one-click toggle by account, names with commas, name->account binding, board keys, removal, portraits kept for allies only");
    process.exit(0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}, 1300);
