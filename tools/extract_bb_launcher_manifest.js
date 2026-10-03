const fs = require("fs");
const path = require("path");

const appData = process.env.APPDATA || "";
const defaultCacheDir = path.join(appData, "BoomBang-Launcher", "Cache");
const defaultOutDir = path.join(process.cwd(), "official_client", "manifests");

function parseArgs(argv) {
  const args = {
    cacheDir: defaultCacheDir,
    outDir: defaultOutDir,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--cache-dir" && argv[i + 1]) {
      args.cacheDir = argv[i + 1];
      i += 1;
    } else if (arg === "--out-dir" && argv[i + 1]) {
      args.outDir = argv[i + 1];
      i += 1;
    }
  }

  return args;
}

function walk(dir, visitor) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, visitor);
    } else {
      visitor(fullPath);
    }
  }
}

function normalizeUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    parsed.hash = "";
    parsed.pathname = parsed.pathname.replace(/\/{2,}/g, "/");
    return parsed.toString();
  } catch {
    return null;
  }
}

function classifyUrl(url) {
  if (/Kernel\.swf/i.test(url)) {
    return "kernel";
  }
  if (/BBLoad\.swf/i.test(url)) {
    return "loader";
  }
  if (/\.swf(?:\?|$)/i.test(url)) {
    return "swf";
  }
  if (/\.xml(?:\?|$)/i.test(url)) {
    return "xml";
  }
  return "other";
}

function shouldKeep(url) {
  if (!/boombang\.tv/i.test(url)) {
    return false;
  }
  if (/\/Catalog\/StaticRoutes/i.test(url) || /crossdomain\.xml/i.test(url)) {
    return true;
  }
  if (!/21032026_prod/i.test(url)) {
    return false;
  }
  return /Kernel\.swf|BBLoad\.swf|dswmedia\/|\.swf(?:\?|$)|\.xml(?:\?|$)/i.test(url);
}

function main() {
  const { cacheDir, outDir } = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(cacheDir)) {
    console.error(`Cache dir not found: ${cacheDir}`);
    process.exit(1);
  }

  const urls = new Set();
  const urlRegex = /https?:\/\/[^\s\x00"'<>]+/g;

  walk(cacheDir, (filePath) => {
    try {
      const text = fs.readFileSync(filePath).toString("latin1");
      for (const match of text.matchAll(urlRegex)) {
        const normalized = normalizeUrl(match[0]);
        if (normalized && shouldKeep(normalized)) {
          urls.add(normalized);
        }
      }
    } catch {
      // Ignore unreadable cache shards.
    }
  });

  const sorted = [...urls].sort();
  const summary = {
    cacheDir,
    total: sorted.length,
    counts: {
      kernel: sorted.filter((item) => classifyUrl(item) === "kernel").length,
      loader: sorted.filter((item) => classifyUrl(item) === "loader").length,
      swf: sorted.filter((item) => classifyUrl(item) === "swf").length,
      xml: sorted.filter((item) => classifyUrl(item) === "xml").length,
      other: sorted.filter((item) => classifyUrl(item) === "other").length,
    },
    urls: sorted,
  };

  fs.mkdirSync(outDir, { recursive: true });

  const txtPath = path.join(outDir, "launcher-cache-assets.txt");
  const jsonPath = path.join(outDir, "launcher-cache-assets.json");

  fs.writeFileSync(txtPath, `${sorted.join("\n")}\n`, "utf8");
  fs.writeFileSync(jsonPath, JSON.stringify(summary, null, 2), "utf8");

  console.log(`Wrote ${sorted.length} asset URLs`);
  console.log(txtPath);
  console.log(jsonPath);
}

main();
