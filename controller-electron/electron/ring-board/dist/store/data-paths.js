import path from "node:path";
import { createRequire } from "node:module";
// Installed resources are read-only. Resolve once in the main process and
// pass this directory to each brain worker, which has no Electron app API.
export function boardDataDir(rootDir) {
    if (!process.versions.electron)
        return path.join(rootDir, "data");
    const { app } = createRequire(import.meta.url)("electron");
    return path.join(app.getPath("userData"), "ring-board");
}
