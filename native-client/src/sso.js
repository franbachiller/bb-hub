// Autenticacion contra el backend del launcher oficial.
// Mismo flujo que harness/get_sso_ticket.js: login -> token -> ticket cliente 2.

const BACKEND = "https://backend-launcher.boombang.tv";
const CLIENT_ID = 2;

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("retry-after"));
      const hint = Number.isFinite(retryAfter) && retryAfter > 0
        ? `Espera ${retryAfter}s antes de reintentar.`
        : "Espera unos minutos antes de reintentar.";
      throw new Error(`Demasiados intentos de login (HTTP 429). ${hint}`);
    }
    throw new Error(data?.message || `HTTP ${response.status}`);
  }
  return data;
}

/**
 * Obtiene un ticket SSO.
 * Si la cuenta pide 2FA devuelve { status: "2fa_required", pendingToken }.
 */
export async function getSsoTicket({ username, password, pendingToken, code } = {}) {
  let token = null;

  if (pendingToken && code) {
    const result = await requestJson(`${BACKEND}/auth/2fa`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pendingToken, code })
    });
    if (result.status !== "ok" || !result.token) throw new Error("Codigo 2FA invalido");
    token = result.token;
  } else {
    if (!username || !password) throw new Error("Faltan usuario o contrasena");
    const result = await requestJson(`${BACKEND}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password })
    });
    if (result.status === "2fa_required" && result.pendingToken) {
      return { status: "2fa_required", pendingToken: result.pendingToken };
    }
    if (result.status !== "ok" || !result.token) throw new Error("Credenciales invalidas");
    token = result.token;
  }

  const ticket = await requestJson(`${BACKEND}/clients/${CLIENT_ID}/ticket`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` }
  });
  if (!ticket.ticket) throw new Error("El servidor no devolvio ticket");
  return { status: "ok", ticket: ticket.ticket };
}
