"use strict";

const SEPARATOR = String.fromCharCode(179, 178);

function decodePayload(opcode, payloadData) {
  if (Number(opcode) === 2) return Buffer.from(String(payloadData || ""), "base64");
  return Buffer.from(String(payloadData || ""), "latin1");
}

function parseBoomBangPacket(bytes) {
  if (!bytes || bytes.length < 2 || bytes[0] !== 177) return null;
  const raw = bytes.toString("latin1");
  const fields = raw.length > 4
    ? raw.slice(4).split(SEPARATOR).filter((field) => field !== "")
    : [];
  return {
    id: bytes[1],
    type: bytes.length > 3
      ? bytes[3] === 178 ? 0 : bytes[3]
      : null,
    rawType: bytes.length > 3 ? bytes[3] : null,
    fields
  };
}

function frameRecord(direction, event, source = "page") {
  const response = event.response || {};
  const bytes = decodePayload(response.opcode, response.payloadData);
  return {
    kind: `wire.websocket.${direction}`,
    t: Number.isFinite(Number(event.timestamp))
      ? Number(event.timestamp) * 1000
      : null,
    data: {
      source,
      requestId: event.requestId || null,
      opcode: Number(response.opcode),
      masked: response.mask === true,
      byteLength: bytes.length,
      packet: parseBoomBangPacket(bytes)
    }
  };
}

function handshakeRecord(event, source = "page") {
  const headers = { ...(event.request?.headers || {}) };
  for (const name of Object.keys(headers)) {
    const lower = name.toLowerCase();
    if (lower === "sec-websocket-protocol") headers[name] = "[REDACTED]";
    if (lower === "cookie") {
      headers[name] = String(headers[name])
        .split(";")
        .map((cookie) => `${cookie.split("=", 1)[0].trim()}=[REDACTED]`)
        .join("; ");
    }
  }
  return {
    kind: "wire.websocket.handshake",
    data: {
      source,
      requestId: event.requestId || null,
      headers
    }
  };
}

async function installCdpWireTap(page, appendRecord) {
  const session = await page.context().newCDPSession(page);
  const childSources = new Map();
  let nextMessageId = 1;

  const recordFrame = (direction, event, source) => {
    appendRecord(frameRecord(direction, event, source));
  };

  session.on("Network.webSocketCreated", (event) => {
    appendRecord({
      kind: "wire.websocket.created",
      t: Number.isFinite(Number(event.timestamp))
        ? Number(event.timestamp) * 1000
        : null,
      data: {
        source: "page",
        requestId: event.requestId,
        url: event.url
      }
    });
  });
  session.on("Network.webSocketWillSendHandshakeRequest", (event) => {
    appendRecord(handshakeRecord(event, "page"));
  });
  session.on("Network.webSocketFrameSent", (event) => {
    recordFrame("sent", event, "page");
  });
  session.on("Network.webSocketFrameReceived", (event) => {
    recordFrame("received", event, "page");
  });
  session.on("Network.webSocketClosed", (event) => {
    appendRecord({
      kind: "wire.websocket.closed",
      t: Number.isFinite(Number(event.timestamp))
        ? Number(event.timestamp) * 1000
        : null,
      data: { source: "page", requestId: event.requestId }
    });
  });

  session.on("Target.attachedToTarget", async (event) => {
    const source = `${event.targetInfo?.type || "child"}:${event.targetInfo?.targetId || "unknown"}`;
    childSources.set(event.sessionId, source);
    try {
      await session.send("Target.sendMessageToTarget", {
        sessionId: event.sessionId,
        message: JSON.stringify({
          id: nextMessageId++,
          method: "Network.enable",
          params: {}
        })
      });
      appendRecord({
        kind: "wire.target.attached",
        data: {
          source,
          url: event.targetInfo?.url || null
        }
      });
    } catch (error) {
      appendRecord({
        kind: "wire.target.error",
        data: { source, message: error.message }
      });
    }
  });
  session.on("Target.receivedMessageFromTarget", (event) => {
    let message = null;
    try {
      message = JSON.parse(event.message);
    } catch {
      return;
    }
    const source = childSources.get(event.sessionId) || "child";
    if (message.method === "Network.webSocketFrameSent") {
      recordFrame("sent", message.params || {}, source);
    } else if (message.method === "Network.webSocketFrameReceived") {
      recordFrame("received", message.params || {}, source);
    } else if (message.method === "Network.webSocketCreated") {
      appendRecord({
        kind: "wire.websocket.created",
        t: Number.isFinite(Number(message.params?.timestamp))
          ? Number(message.params.timestamp) * 1000
          : null,
        data: {
          source,
          requestId: message.params?.requestId || null,
          url: message.params?.url || null
        }
      });
    } else if (message.method === "Network.webSocketWillSendHandshakeRequest") {
      appendRecord(handshakeRecord(message.params || {}, source));
    }
  });

  await session.send("Network.enable");
  await session.send("Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: false
  });

  return {
    session,
    mode: "cdp-passive",
    pageNetwork: true,
    childAutoAttach: true
  };
}

module.exports = {
  decodePayload,
  frameRecord,
  installCdpWireTap,
  parseBoomBangPacket
};
