// Sesion criptografica del socket: ECDH P-256 + parche por esteganografia
// en el logo + ChaCha20-Poly1305, exactamente como el worker del cliente.
import crypto from "node:crypto";
import { decodePng } from "./png.js";

const LOGO_URL = "https://static.boombang.tv/html_static_prod/images/logo.png";

// Pixeles y offsets de clave tomados del worker (init-crypto).
const STEGO_PIXELS = [
  { x: 49, y: 39 },
  { x: 16, y: 52 },
  { x: 88, y: 33 },
  { x: 108, y: 52 }
];
const STEGO_OFFSETS = [5, 10, 18, 20];

const NONCE_LEN = 12;
const KEY_LEN = 32;
const TAG_LEN = 16;

/** Par de claves efimero ECDH P-256 (equivale a generateKey + exportKey raw). */
export class KeyExchange {
  constructor() {
    this.ecdh = crypto.createECDH("prime256v1");
    this.ecdh.generateKeys();
  }

  /** Clave publica en formato raw sin comprimir (65 bytes: 0x04||X||Y). */
  publicKeyRaw() {
    return this.ecdh.getPublicKey(null, "uncompressed");
  }

  publicKeyBase64() {
    return this.publicKeyRaw().toString("base64");
  }

  /** deriveBits({ECDH}, priv, 256) -> coordenada X de 32 bytes. */
  deriveSharedSecret(serverPublicKeyBase64) {
    const peer = Buffer.from(serverPublicKeyBase64, "base64");
    return this.ecdh.computeSecret(peer);
  }
}

/**
 * Descarga el logo y extrae el canal AZUL de los 4 pixeles del stego.
 * El servidor rota `nocache`, por eso hay que releerlo en cada handshake.
 */
export async function fetchStegoBytes(noCache) {
  const url = `${LOGO_URL}?nocache=${noCache}`;
  const response = await fetch(url, { headers: { accept: "image/png" } });
  if (!response.ok) throw new Error(`logo fetch failed: ${response.status}`);
  const png = decodePng(Buffer.from(await response.arrayBuffer()));
  return STEGO_PIXELS.map(({ x, y }) => {
    const index = (y * png.width + x) * 4;
    return png.data[index + 2]; // canal azul
  });
}

/**
 * Aplica el parche del logo al secreto compartido y devuelve la clave final.
 * El worker solo parchea si el secreto tiene mas de 20 bytes.
 */
export function patchKey(sharedSecret, stegoBytes) {
  const key = Buffer.from(sharedSecret);
  if (key.length > 20) {
    for (let i = 0; i < STEGO_OFFSETS.length; i++) {
      key[STEGO_OFFSETS[i]] = stegoBytes[i];
    }
  }
  const final = Buffer.alloc(KEY_LEN);
  key.subarray(0, KEY_LEN).copy(final);
  return final;
}

/** ChaCha20-Poly1305 con nonce aleatorio de 12 bytes por mensaje. */
export class CryptoSession {
  constructor(key) {
    if (key.length !== KEY_LEN) throw new Error(`clave invalida: ${key.length}`);
    this.key = key;
  }

  static async create(sharedSecret, noCache) {
    const stego = await fetchStegoBytes(noCache);
    return new CryptoSession(patchKey(sharedSecret, stego));
  }

  encrypt(plaintext) {
    const nonce = crypto.randomBytes(NONCE_LEN);
    const cipher = crypto.createCipheriv("chacha20-poly1305", this.key, nonce, {
      authTagLength: TAG_LEN
    });
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([nonce, body, cipher.getAuthTag()]);
  }

  decrypt(frame) {
    const buf = Buffer.isBuffer(frame) ? frame : Buffer.from(frame);
    const nonce = buf.subarray(0, NONCE_LEN);
    const payload = buf.subarray(NONCE_LEN);
    const body = payload.subarray(0, payload.length - TAG_LEN);
    const tag = payload.subarray(payload.length - TAG_LEN);
    const decipher = crypto.createDecipheriv("chacha20-poly1305", this.key, nonce, {
      authTagLength: TAG_LEN
    });
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  }
}
