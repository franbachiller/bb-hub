"use strict";
const fs = require("node:fs");
const path = require("node:path");
const CLIENT_NAME = "BoomBangHTML5.exe";

function isHtml5Executable(file) {
  if (typeof file !== "string" || !path.isAbsolute(file) ||
      path.basename(file).toLowerCase() !== CLIENT_NAME.toLowerCase()) return false;
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

// Search only known launcher directories. installed.json belongs to the
// official launcher and can point client 2 at a custom installation folder.
function locateHtml5Client({ preferred, fallback, roots = [] } = {}) {
  for (const file of [preferred, fallback]) if (isHtml5Executable(file)) return file;
  for (const root of [...new Set(roots.filter(r => typeof r === "string" && path.isAbsolute(r)))]) {
    const standard = path.join(root, "clients", "2", CLIENT_NAME);
    if (isHtml5Executable(standard)) return standard;
    try {
      const manifest = path.join(root, "installed.json");
      if (fs.statSync(manifest).size > 1024 * 1024) continue;
      const installed = JSON.parse(fs.readFileSync(manifest, "utf8"));
      const configured = installed?.["2"]?.path;
      if (typeof configured !== "string" || !path.isAbsolute(configured)) continue;
      const candidate = path.basename(configured).toLowerCase() === CLIENT_NAME.toLowerCase()
        ? configured : path.join(configured, CLIENT_NAME);
      if (isHtml5Executable(candidate)) return candidate;
    } catch {}
  }
  return "";
}

module.exports = { isHtml5Executable, locateHtml5Client };
