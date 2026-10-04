"use strict";

const net = require("node:net");

const RECONNECT_MS = 1500;

// TCP client of the Hub :9999 bridge, same null-terminated JSON protocol as the
// Flash XMLSocket. Runs inside the Hub process (it used to be a separate Node
// launched by ABRIR_HUB_Y_CONTROLLER.cmd), so the core needs no changes.
class HubBridge {
  constructor({ port, onMessage, onStatus, log } = {}) {
    this.port = port;
    this.onMessage = typeof onMessage === "function" ? onMessage : () => {};
    this.onStatus = typeof onStatus === "function" ? onStatus : () => {};
    this.log = typeof log === "function" ? log : () => {};
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.connected = false;
    this.closed = false;
    this.reconnectTimer = null;
    this.pending = [];
  }

  start() {
    this.closed = false;
    this.connect();
  }

  stop() {
    this.closed = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.socket) {
      try {
        this.socket.removeAllListeners();
        this.socket.destroy();
      } catch {}
    }
    this.socket = null;
    this.connected = false;
    this.pending = [];
  }

  send(obj) {
    if (!obj || typeof obj !== "object") return false;
    const payload = `${JSON.stringify(obj)}\0`;
    if (!this.connected || !this.socket) {
      if (this.pending.length < 200) this.pending.push(payload);
      return false;
    }
    try {
      this.socket.write(payload, "utf8");
      return true;
    } catch (error) {
      this.log(`puente: error al escribir: ${error.message}`);
      return false;
    }
  }

  connect() {
    if (this.closed || this.socket) return;
    const socket = net.connect({ host: "127.0.0.1", port: this.port });
    this.socket = socket;
    socket.setNoDelay(true);

    socket.on("connect", () => {
      this.connected = true;
      this.buffer = Buffer.alloc(0);
      this.onStatus({ connected: true });
      while (this.pending.length) {
        try { socket.write(this.pending.shift(), "utf8"); } catch {}
      }
    });

    socket.on("data", (chunk) => this.onData(chunk));

    socket.on("close", () => {
      this.connected = false;
      this.socket = null;
      this.buffer = Buffer.alloc(0);
      this.onStatus({ connected: false });
      if (!this.closed && !this.reconnectTimer) {
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          this.connect();
        }, RECONNECT_MS);
      }
    });

    socket.on("error", (error) => {
      if (this.lastError !== error.code) this.log(`puente: no se pudo conectar al puerto ${this.port}: ${error.code || error.message}`);
      this.lastError = error.code;
      try { socket.destroy(); } catch {}
    });
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let idx = this.buffer.indexOf(0);
    while (idx >= 0) {
      const raw = this.buffer.subarray(0, idx).toString("utf8").trim();
      this.buffer = this.buffer.subarray(idx + 1);
      idx = this.buffer.indexOf(0);
      if (!raw || raw.startsWith("<")) continue;
      try {
        this.onMessage(JSON.parse(raw));
      } catch {
        this.log(`puente: JSON inválido: ${raw.slice(0, 80)}`);
      }
    }
  }
}

module.exports = { HubBridge };
