// Loads the real brain worker (dist/runtime/brain-worker.js) with a virtual clock:
// every request carries simNow, and this listener (registered first) sets Date.now
// before the worker's own listener evaluates it.
import { parentPort, workerData } from "node:worker_threads";
import { pathToFileURL } from "node:url";

let clock = workerData.start;
Date.now = () => clock;
parentPort.on("message", (m) => {
  if (m && typeof m.simNow === "number") clock = m.simNow;
});
await import(pathToFileURL(workerData.brainPath).href);
