const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const API_TOKENS = [
  "XMLSocket",
  "JSON.parse",
  "JSON.stringify",
  "ByteArray",
  "Timer",
  "setTimeout",
  "getTimer",
  "getPlotXY",
  "MouseEvent.MOUSE_DOWN",
  "MouseEvent.CLICK",
  "Event.ENTER_FRAME",
  "TimerEvent.TIMER",
  "DataEvent.DATA",
  "IOErrorEvent.IO_ERROR",
  "SecurityErrorEvent.SECURITY_ERROR",
  "Socket",
  "connect(",
  "send(",
  "writeByte",
  "writeInt",
  "readUnsignedByte",
  "readInt",
  "orientation",
  "stage.addEventListener"
];

const args = parseArgs(process.argv.slice(2));

if (!args.old || !args.new) {
  console.error("Usage: node tools/kernel_update_analyzer.js --old <oldExportDir> --new <newExportDir> [--out <reportDir>]");
  process.exit(2);
}

const oldRoot = resolveScriptRoot(args.old);
const newRoot = resolveScriptRoot(args.new);
const outRoot = path.resolve(args.out || "tmp/kernel_update_analysis");

fs.mkdirSync(outRoot, { recursive: true });

const oldFiles = loadAsFiles(oldRoot);
const newFiles = loadAsFiles(newRoot);
const oldByRel = new Map(oldFiles.map((file) => [file.rel, file]));
const newByRel = new Map(newFiles.map((file) => [file.rel, file]));

const oldFingerprints = oldFiles.map(fingerprintFile);
const newFingerprints = newFiles.map(fingerprintFile);

const oldByFullName = new Map(oldFingerprints.map((item) => [item.fullName, item]));
const newByFullName = new Map(newFingerprints.map((item) => [item.fullName, item]));

const candidates = [];
for (const oldItem of oldFingerprints) {
  const scored = [];
  for (const newItem of newFingerprints) {
    scored.push({
      old: oldItem.rel,
      oldFullName: oldItem.fullName,
      new: newItem.rel,
      newFullName: newItem.fullName,
      score: scorePair(oldItem, newItem),
      reasons: explainPair(oldItem, newItem)
    });
  }
  scored.sort((a, b) => b.score - a.score);
  candidates.push({
    old: oldItem.rel,
    oldFullName: oldItem.fullName,
    best: scored.slice(0, 8)
  });
}

const summary = {
  oldRoot,
  newRoot,
  oldCount: oldFiles.length,
  newCount: newFiles.length,
  sameRelativeCount: oldFiles.filter((file) => newByRel.has(file.rel)).length,
  sameFullNameCount: oldFingerprints.filter((item) => newByFullName.has(item.fullName)).length,
  generatedAt: new Date().toISOString()
};

const anchors = buildAnchors([...oldFingerprints, ...newFingerprints], oldRoot, newRoot);
const keyReport = buildKeyReport(oldFingerprints, newFingerprints);

writeJson(path.join(outRoot, "kernel_compare_report.json"), {
  summary,
  keyReport,
  candidates,
  anchors
});
writeCsv(path.join(outRoot, "mapping_candidates.csv"), candidates);
writeMarkdown(path.join(outRoot, "kernel_compare_report.md"), summary, keyReport, candidates, anchors);

console.log(`Old scripts: ${summary.oldCount}`);
console.log(`New scripts: ${summary.newCount}`);
console.log(`Same relative paths: ${summary.sameRelativeCount}`);
console.log(`Same full class names: ${summary.sameFullNameCount}`);
console.log(`Report: ${path.join(outRoot, "kernel_compare_report.md")}`);

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) {
      continue;
    }
    result[key.slice(2)] = argv[i + 1];
    i += 1;
  }
  return result;
}

function resolveScriptRoot(input) {
  const root = path.resolve(input);
  const nested = path.join(root, "scripts");
  if (fs.existsSync(nested) && fs.statSync(nested).isDirectory()) {
    return nested;
  }
  return root;
}

function loadAsFiles(root) {
  const files = [];
  walk(root, (file) => {
    if (file.toLowerCase().endsWith(".as")) {
      const raw = fs.readFileSync(file, "utf8");
      files.push({
        abs: file,
        rel: path.relative(root, file).replaceAll(path.sep, "/"),
        raw
      });
    }
  });
  files.sort((a, b) => a.rel.localeCompare(b.rel));
  return files;
}

function walk(dir, onFile) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const next = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(next, onFile);
    } else {
      onFile(next);
    }
  }
}

function fingerprintFile(file) {
  const raw = file.raw;
  const noComments = stripComments(raw);
  const pkg = matchOne(noComments, /\bpackage\s+([a-zA-Z0-9_.$]+)/);
  const className = matchOne(noComments, /\b(?:public|internal|final|\s)*\s*class\s+([a-zA-Z0-9_]+)/);
  const extendsName = matchOne(noComments, /\bclass\s+[a-zA-Z0-9_]+(?:\s+extends\s+([a-zA-Z0-9_.$]+))?/);
  const imports = unique(matches(noComments, /\bimport\s+([a-zA-Z0-9_.*$]+)\s*;/g).map(normalizePathName));
  const strings = unique(matches(noComments, /"((?:\\.|[^"\\])*)"/g).filter((item) => item.length > 0));
  const numbers = unique(matches(noComments, /(?<![a-zA-Z0-9_])-?\b\d{1,6}\b/g));
  const functions = matches(noComments, /\b(?:public|private|protected|internal)?\s*(?:static\s+)?function\s+([a-zA-Z0-9_]+)\s*\(([^)]*)\)/g, true).map((m) => ({
    name: m[1],
    params: m[2].trim() ? m[2].split(",").length : 0
  }));
  const apiTokens = API_TOKENS.filter((token) => noComments.includes(token));
  const eventTokens = unique(matches(noComments, /\b(?:MouseEvent|TimerEvent|KeyboardEvent|Event|DataEvent|IOErrorEvent|SecurityErrorEvent)\.[A-Z0-9_]+/g));
  const packetIds = unique(matches(noComments, /\b(?:new\s+[a-zA-Z0-9_.$]+\s*\(\s*|_pa14653\s*\(\s*|_ps6110\s*\(\s*)(\d{1,4})/g));
  const normalized = normalizeSource(noComments);

  return {
    rel: file.rel,
    abs: file.abs,
    package: pkg,
    className,
    fullName: pkg && className ? `${pkg}.${className}` : className || file.rel,
    normalizedFullName: normalizePathName(pkg && className ? `${pkg}.${className}` : className || file.rel),
    extendsName,
    normalizedExtends: normalizePathName(extendsName || ""),
    imports,
    strings,
    numbers,
    functions,
    apiTokens,
    eventTokens,
    packetIds,
    lineCount: noComments.split(/\r?\n/).length,
    charCount: noComments.length,
    normalizedHash: sha1(normalized),
    normalizedPrefixHash: sha1(normalized.slice(0, 12000))
  };
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function normalizeSource(source) {
  return source
    .replace(/"((?:\\.|[^"\\])*)"/g, '"STR"')
    .replace(/'((?:\\.|[^'\\])*)'/g, "'STR'")
    .replace(/\b_loc\d+_\b/g, "_LOC")
    .replace(/\b_[a-z]{1,3}\d+\b/g, "_OBF")
    .replace(/\b\d{1,6}\b/g, "NUM")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePathName(value) {
  return String(value || "")
    .replace(/\b_[a-z]{1,3}\d+\b/g, "_OBF")
    .replace(/\._[a-z]{1,3}\d+\b/g, "._OBF");
}

function matchOne(source, regex) {
  const found = source.match(regex);
  return found ? found[1] || "" : "";
}

function matches(source, regex, full = false) {
  const result = [];
  for (const match of source.matchAll(regex)) {
    result.push(full ? match : match[1] || match[0]);
  }
  return result;
}

function unique(values) {
  return [...new Set(values.map((value) => String(value)))].sort();
}

function sha1(value) {
  return crypto.createHash("sha1").update(value).digest("hex");
}

function scorePair(oldItem, newItem) {
  let score = 0;
  if (oldItem.rel === newItem.rel) score += 18;
  if (oldItem.normalizedFullName === newItem.normalizedFullName) score += 12;
  if (oldItem.normalizedExtends && oldItem.normalizedExtends === newItem.normalizedExtends) score += 8;
  if (oldItem.normalizedHash === newItem.normalizedHash) score += 80;
  if (oldItem.normalizedPrefixHash === newItem.normalizedPrefixHash) score += 20;
  score += jaccard(oldItem.imports, newItem.imports) * 20;
  score += jaccard(oldItem.strings, newItem.strings) * 35;
  score += jaccard(oldItem.apiTokens, newItem.apiTokens) * 22;
  score += jaccard(oldItem.eventTokens, newItem.eventTokens) * 12;
  score += jaccard(oldItem.numbers, newItem.numbers) * 12;
  score += jaccard(oldItem.packetIds, newItem.packetIds) * 8;
  score += countSimilarity(oldItem.functions.length, newItem.functions.length) * 8;
  score += countSimilarity(oldItem.lineCount, newItem.lineCount) * 10;
  return Math.round(score * 100) / 100;
}

function explainPair(oldItem, newItem) {
  const reasons = [];
  if (oldItem.rel === newItem.rel) reasons.push("same relative path");
  if (oldItem.normalizedHash === newItem.normalizedHash) reasons.push("same normalized body");
  const sharedStrings = intersection(oldItem.strings, newItem.strings);
  const sharedApi = intersection(oldItem.apiTokens, newItem.apiTokens);
  const sharedEvents = intersection(oldItem.eventTokens, newItem.eventTokens);
  if (sharedStrings.length) reasons.push(`strings:${sharedStrings.slice(0, 5).join("|")}`);
  if (sharedApi.length) reasons.push(`api:${sharedApi.join("|")}`);
  if (sharedEvents.length) reasons.push(`events:${sharedEvents.join("|")}`);
  return reasons.slice(0, 6);
}

function jaccard(a, b) {
  if (!a.length && !b.length) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  const shared = [...setA].filter((item) => setB.has(item)).length;
  const total = new Set([...a, ...b]).size;
  return total ? shared / total : 0;
}

function intersection(a, b) {
  const setB = new Set(b);
  return a.filter((item) => setB.has(item));
}

function countSimilarity(a, b) {
  if (a === 0 && b === 0) return 1;
  const max = Math.max(Math.abs(a), Math.abs(b), 1);
  return Math.max(0, 1 - Math.abs(a - b) / max);
}

function buildAnchors(items, oldRoot, newRoot) {
  const anchorSpecs = [
    ["controller-bridge", ["XMLSocket", "DataEvent.DATA", "127.0.0.1"]],
    ["socket-send", ["send(", "connect("]],
    ["mouse-down", ["MouseEvent.MOUSE_DOWN"]],
    ["plot-converter", ["getPlotXY"]],
    ["raw-position", ["_ep6362", "_gn15250"]],
    ["json", ["JSON.parse", "JSON.stringify"]],
    ["timer", ["TimerEvent.TIMER", "getTimer"]]
  ];
  return anchorSpecs.map(([name, tokens]) => {
    const hits = items
      .filter((item) => tokens.some((token) => fs.readFileSync(item.abs, "utf8").includes(token)))
      .map((item) => ({
        rel: item.rel,
        fullName: item.fullName,
        root: item.abs.startsWith(oldRoot) ? "old" : "new",
        tokens: tokens.filter((token) => fs.readFileSync(item.abs, "utf8").includes(token))
      }))
      .sort((a, b) => a.root.localeCompare(b.root) || a.rel.localeCompare(b.rel));
    return { name, tokens, hits };
  });
}

function buildKeyReport(oldItems, newItems) {
  const oldByRel = Object.fromEntries(oldItems.map((item) => [item.rel, item]));
  const keys = [
    "src/multiuser/_eo13669.as",
    "src/modules/interfaz/_xh13617.as",
    "src/person/_eb5699.as",
    "src/person/_tg3488.as",
    "src/config/_ub7011.as",
    "src/utils/_wm11621.as",
    "src/allData/scene/typeEscenarios/_ut3229.as"
  ];
  return keys
    .filter((rel) => oldByRel[rel])
    .map((rel) => {
      const oldItem = oldByRel[rel];
      const best = newItems
        .map((newItem) => ({
          rel: newItem.rel,
          fullName: newItem.fullName,
          score: scorePair(oldItem, newItem),
          reasons: explainPair(oldItem, newItem)
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 8);
      return { old: rel, oldFullName: oldItem.fullName, best };
    });
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function writeCsv(file, data) {
  const lines = ["old,oldFullName,rank,new,newFullName,score,reasons"];
  for (const row of data) {
    row.best.forEach((candidate, index) => {
      lines.push([
        row.old,
        row.oldFullName,
        index + 1,
        candidate.new,
        candidate.newFullName,
        candidate.score,
        candidate.reasons.join("; ")
      ].map(csvEscape).join(","));
    });
  }
  fs.writeFileSync(file, lines.join("\n"));
}

function csvEscape(value) {
  const text = String(value ?? "");
  return `"${text.replaceAll('"', '""')}"`;
}

function writeMarkdown(file, summary, keyReport, candidates, anchors) {
  const lines = [];
  lines.push("# Kernel Update Analysis");
  lines.push("");
  lines.push(`- Old scripts: ${summary.oldCount}`);
  lines.push(`- New scripts: ${summary.newCount}`);
  lines.push(`- Same relative paths: ${summary.sameRelativeCount}`);
  lines.push(`- Same full class names: ${summary.sameFullNameCount}`);
  lines.push("");
  lines.push("## Key Port Candidates");
  lines.push("");
  for (const item of keyReport) {
    lines.push(`### ${item.old}`);
    for (const candidate of item.best.slice(0, 5)) {
      lines.push(`- ${candidate.score.toFixed(2)} -> ${candidate.rel} (${candidate.reasons.join("; ") || "no strong reason"})`);
    }
    lines.push("");
  }
  lines.push("## Anchor Hits");
  lines.push("");
  for (const anchor of anchors) {
    lines.push(`### ${anchor.name}`);
    for (const hit of anchor.hits.slice(0, 40)) {
      lines.push(`- [${hit.root}] ${hit.rel} :: ${hit.tokens.join(", ")}`);
    }
    if (anchor.hits.length > 40) {
      lines.push(`- ... ${anchor.hits.length - 40} more`);
    }
    lines.push("");
  }
  lines.push("## Top Global Matches");
  lines.push("");
  for (const row of candidates.slice(0, 80)) {
    const best = row.best[0];
    if (!best || best.score < 35) continue;
    lines.push(`- ${best.score.toFixed(2)} ${row.old} -> ${best.new}`);
  }
  fs.writeFileSync(file, lines.join("\n"));
}
