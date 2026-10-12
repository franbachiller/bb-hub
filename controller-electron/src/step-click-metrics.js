const finite = value => value != null && String(value).trim() !== "" && Number.isFinite(Number(value)) ? Number(value) : null;
const patterns = ["SINGLE", "TRIPLE", "CUSTOM"];

export function stepClickDraft(config) {
  const legacy = config && ["startMs", "endMs", "intervalMs", "clicks"].some(key => config[key] != null);
  return { enabled: false, source: "PAIR", startMs: 350, endMs: 400, intervalMs: 10, momentMs: 375,
    ...config, pattern: patterns.includes(config?.pattern) ? config.pattern : legacy ? "CUSTOM" : "SINGLE" };
}

export function validStepClickDraft(config) {
  if (!patterns.includes(config?.pattern)) return false;
  const integer = (value, low, high) => finite(value) != null && Number.isInteger(Number(value)) && Number(value) >= low && Number(value) <= high;
  if (config.pattern !== "CUSTOM") return integer(config.momentMs, 0, 4999);
  return integer(config.startMs, 0, 4999) && integer(config.endMs, 1, 5000) && Number(config.endMs) > Number(config.startMs) &&
    integer(config.intervalMs, 1, 5000) && Math.ceil((Number(config.endMs) - Number(config.startMs)) / Number(config.intervalMs)) <= 256;
}

export function stepClickPhases(config, durationMs = 5000) {
  if (!validStepClickDraft(config) || finite(durationMs) == null || Number(durationMs) <= 0) return [];
  const limit = Math.min(5000, Number(durationMs));
  if (config.pattern !== "CUSTOM") {
    const moment = Number(config.momentMs);
    return (config.pattern === "TRIPLE" ? [moment - 20, moment, moment + 20] : [moment]).filter(ms => ms >= 0 && ms < limit);
  }
  const start = Number(config.startMs), end = Math.min(Number(config.endMs), limit), interval = Number(config.intervalMs);
  return Array.from({ length: Math.max(0, Math.ceil((end - start) / interval)) }, (_, index) => start + index * interval);
}

export function selectStepCrossing(status) {
  if (!status || !Number.isInteger(status.targetId) || status.targetId < 0) return null;
  return [status.lastEncounter, status.lastCrossing, status.crossing].find(c => c && c.targetId === status.targetId &&
    c.complete === true && c.samples >= 2 && finite(c.durationMs) > 0 && stepCrossingPhase(c) != null &&
    c.contactWindows?.some(window => finite(window?.fromMs) != null && finite(window?.toMs) != null && Number(window.toMs) >= Number(window.fromMs)) &&
    (!status.source || !c.source || status.source === c.source)) || null;
}

export function stepCrossingPhase(crossing) {
  return finite(crossing?.closestContactMs) ?? finite(crossing?.closestMs);
}
