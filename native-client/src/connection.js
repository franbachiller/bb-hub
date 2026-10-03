// Conexion nativa al servidor de juego.
// Reemplaza la cadena Electron -> CDP -> iframe -> Worker por un WebSocket
// directo, eliminando el jitter de scheduling del navegador.
//
// Secuencia (identica al cliente oficial):
//   open          -> 233/40 con la clave publica ECDH (texto base64, sin cifrar)
//   recv 231      -> deriveBits + parche del logo -> sesion ChaCha20
//   crypto ready  -> 233/35 (ticket SSO) y 233/37 (idioma)
//
// Formato de wire:
//   saliente  cifrado : encrypt(ascii(base64(utf8(cp1252(bytes)))))  -> binario
//   saliente  claro   : base64(utf8(cp1252(bytes)))                  -> texto
//   entrante          : decrypt(base64decode(texto))                 -> bytes
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { MessageBuilder, MessageReader } from "./message.js";
import { CryptoSession, KeyExchange } from "./crypto.js";

const DEFAULT_HOST = "game.boombang.tv";
const DEFAULT_PORT = 2096;
const DEFAULT_PLATFORM = "pc";
const PING_INTERVAL_MS = 1000;
const PONG_ID = 163;
const CRYPTO_ID = 231;
const BAN_ID = 185;

export class GameConnection extends EventEmitter {
  constructor(options = {}) {
    super();
    this.host = options.host || DEFAULT_HOST;
    this.port = options.port || DEFAULT_PORT;
    this.platform = options.platform || DEFAULT_PLATFORM;
    this.ticket = options.ticket || "";
    this.lang = options.lang || "es";

    this.ws = null;
    this.crypto = null;
    this.keyExchange = null;
    this.ready = false;
    this.banned = false;

    this.pingTimer = null;
    this.pingSentAt = [];
    this.rttSamples = [];
    this.rttMs = 0;
  }

  connect() {
    const url = `wss://${this.host}:${this.port}/?p=${encodeURIComponent(this.platform)}`;
    this.keyExchange = new KeyExchange();
    this.ws = new WebSocket(url, this.ticket, {
      perMessageDeflate: false,
      handshakeTimeout: 15000
    });

    this.ws.on("open", () => {
      this.emit("open");
      this.#sendKeyExchange();
    });
    this.ws.on("message", (data, isBinary) => this.#onMessage(data, isBinary));
    this.ws.on("close", (code) => {
      this.#stopPinging();
      this.ready = false;
      this.emit("closed", code);
    });
    this.ws.on("error", (error) => this.emit("error", error));
    return this;
  }

  close() {
    this.#stopPinging();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* noop */
      }
    }
    this.ws = null;
    this.crypto = null;
    this.ready = false;
  }

  get connected() {
    return Boolean(this.ws && this.ws.readyState === WebSocket.OPEN);
  }

  /** Envia un MessageBuilder aplicando la cadena de codificacion del cliente. */
  send(message) {
    if (!this.connected) return false;
    const text = message instanceof MessageBuilder ? message.toString() : String(message);
    const base64 = Buffer.from(text, "utf8").toString("base64");
    if (!this.crypto) {
      this.ws.send(base64);
      return true;
    }
    this.ws.send(this.crypto.encrypt(Buffer.from(base64, "ascii")));
    return true;
  }

  /** Atajo: construye y envia en una sola llamada. */
  sendPacket(id, type = 0, subType = 0, params = []) {
    const message = new MessageBuilder(id, type, subType);
    for (const param of params) message.appendParameter(param);
    return this.send(message);
  }

  #sendKeyExchange() {
    const message = new MessageBuilder(233, 40);
    message.appendParameter(this.keyExchange.publicKeyBase64());
    this.send(message);
  }

  async #completeCrypto(reader) {
    const serverKey = reader.readString();
    const noCache = encodeURIComponent(reader.readString());
    try {
      const shared = this.keyExchange.deriveSharedSecret(serverKey);
      this.crypto = await CryptoSession.create(shared, noCache);
      this.ready = true;
      this.emit("crypto-ready");
      this.#login();
      this.#startPinging();
    } catch (error) {
      this.emit("error", new Error(`handshake fallido: ${error.message}`));
    }
  }

  #login() {
    const login = new MessageBuilder(233, 35);
    login.appendParameter(this.ticket);
    this.send(login);

    const language = new MessageBuilder(233, 37);
    language.appendParameter(this.lang || "es");
    this.send(language);
    this.emit("login-sent");
  }

  #startPinging() {
    this.#stopPinging();
    this.pingTimer = setInterval(() => this.#sendPing(), PING_INTERVAL_MS);
  }

  #stopPinging() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    this.pingSentAt = [];
    this.rttSamples = [];
  }

  #sendPing() {
    if (!this.connected) return;
    if (this.pingSentAt.length >= 8) this.pingSentAt.shift();
    this.pingSentAt.push(performance.now());
    this.send(new MessageBuilder(PONG_ID, 0));
  }

  #notePong(arrivedAt) {
    if (!this.pingSentAt.length) return;
    const sample = arrivedAt - this.pingSentAt.shift();
    if (sample < 0 || sample >= 30000) return;
    this.rttSamples.push(sample);
    if (this.rttSamples.length > 5) this.rttSamples.shift();
    const sorted = [...this.rttSamples].sort((a, b) => a - b);
    this.rttMs = Math.round(sorted[sorted.length >> 1]);
    this.emit("ping", this.rttMs);
  }

  #onMessage(data, isBinary) {
    const arrivedAt = performance.now();
    let raw;
    if (isBinary) {
      raw = Buffer.isBuffer(data) ? data : Buffer.from(data);
    } else {
      const text = data.toString();
      if (!text) return;
      raw = Buffer.from(text, "base64");
    }

    let bytes;
    if (this.crypto) {
      try {
        bytes = this.crypto.decrypt(raw);
      } catch (error) {
        this.emit("error", new Error(`decrypt fallido: ${error.message}`));
        return;
      }
    } else {
      bytes = raw;
    }

    if (bytes[1] === PONG_ID) {
      this.#notePong(arrivedAt);
      return;
    }

    let reader;
    try {
      reader = new MessageReader(bytes);
    } catch (error) {
      this.emit("error", new Error(`parse fallido: ${error.message}`));
      return;
    }
    reader.receivedAt = Date.now();
    reader.monoAt = arrivedAt;

    if (reader.id === BAN_ID) {
      this.banned = true;
      this.emit("banned", reader);
      return;
    }

    if (reader.id === CRYPTO_ID) {
      this.#completeCrypto(reader);
      return;
    }

    this.emit("packet", reader);
  }
}
