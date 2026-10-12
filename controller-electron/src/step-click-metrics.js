const finite = value => value != null && Number.isFinite(Number(value)) ? Number(value) : null;

export function hasStepContact(crossing) {
  return Boolean(crossing && crossing.samples >= 2 && finite(crossing.durationMs) > 0 &&
    (finite(crossing.closestContactMs) != null || finite(crossing.closestMs) != null) &&
    crossing.contactWindows?.some(w => finite(w?.fromMs) != null && finite(w?.toMs) != null && finite(w.toMs) >= finite(w.fromMs)));
}

export function selectStepCrossing(status) {
  if (!status || !Number.isInteger(status.targetId) || status.targetId < 0) return null;
  const matches = crossing => crossing && crossing.targetId === status.targetId;
  if (matches(status.crossing) && status.crossing.active && hasStepContact(status.crossing)) return status.crossing;
  if (matches(status.lastEncounter) && hasStepContact(status.lastEncounter)) return status.lastEncounter;
  return [status.lastCrossing, status.crossing].find(c => matches(c) && c.samples >= 2 && finite(c.closestMs) != null) || null;
}

export function recommendStepWindow(crossing, config, latencyMs) {
  if (!hasStepContact(crossing)) return { ready: false, reason: "Esperando un cruce con contacto del fichado." };
  const latency = finite(latencyMs);
  if (latency == null || latency < 0) return { ready: false, reason: "Esperando una medición de la conexión." };
  const contactMs = finite(crossing.closestContactMs) ?? finite(crossing.closestMs);
  const centerMs = Math.round(contactMs - latency);
  if (centerMs < 0) return { ready: false, centerMs, reason: "Este cruce exige enviar antes de recibir el paso; esta referencia no alcanza." };
  const duration = Math.floor(Number(crossing.durationMs));
  if (duration < 1 || centerMs >= duration) return { ready: false, centerMs, reason: "La estimación queda fuera de este paso." };
  const span = Number(config?.endMs) - Number(config?.startMs);
  const width = Math.min(duration, Number.isFinite(span) && span >= 1 ? Math.round(span) : 50);
  const startMs = Math.max(0, Math.min(duration - width, Math.round(centerMs - width / 2)));
  return { ready: true, centerMs, contactMs, latencyMs: latency, startMs, endMs: startMs + width };
}
