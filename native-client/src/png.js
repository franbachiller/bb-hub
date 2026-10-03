// Decodificador PNG minimo (solo lo necesario para el logo del handshake).
// Soporta 8 bits/canal, no entrelazado, color type 0/2/3/4/6.
import zlib from "node:zlib";

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Decodifica un PNG a RGBA de 8 bits.
 * @returns {{width:number, height:number, data:Uint8Array}} data en RGBA.
 */
export function decodePng(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  for (let i = 0; i < SIGNATURE.length; i++) {
    if (buf[i] !== SIGNATURE[i]) throw new Error("PNG invalido: firma incorrecta");
  }

  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette = null;
  let transparency = null;
  const idat = [];

  let offset = 8;
  while (offset + 8 <= buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.toString("latin1", offset + 4, offset + 8);
    const start = offset + 8;
    if (type === "IHDR") {
      width = buf.readUInt32BE(start);
      height = buf.readUInt32BE(start + 4);
      depth = buf[start + 8];
      colorType = buf[start + 9];
      interlace = buf[start + 12];
    } else if (type === "PLTE") {
      palette = buf.subarray(start, start + len);
    } else if (type === "tRNS") {
      transparency = buf.subarray(start, start + len);
    } else if (type === "IDAT") {
      idat.push(buf.subarray(start, start + len));
    } else if (type === "IEND") {
      break;
    }
    offset = start + len + 4;
  }

  if (depth !== 8) throw new Error(`PNG no soportado: bit depth ${depth}`);
  if (interlace !== 0) throw new Error("PNG no soportado: entrelazado Adam7");
  const channels = CHANNELS[colorType];
  if (!channels) throw new Error(`PNG no soportado: color type ${colorType}`);
  if (colorType === 3 && !palette) throw new Error("PNG paletizado sin PLTE");

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = channels; // depth 8 => 1 byte por canal
  const stride = width * bpp;
  const pixels = Buffer.alloc(height * stride);

  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const rowStart = y * stride;
    const prevStart = rowStart - stride;
    for (let x = 0; x < stride; x++) {
      const value = raw[pos++];
      const left = x >= bpp ? pixels[rowStart + x - bpp] : 0;
      const up = y > 0 ? pixels[prevStart + x] : 0;
      const upLeft = y > 0 && x >= bpp ? pixels[prevStart + x - bpp] : 0;
      let out;
      switch (filter) {
        case 0: out = value; break;
        case 1: out = value + left; break;
        case 2: out = value + up; break;
        case 3: out = value + ((left + up) >> 1); break;
        case 4: out = value + paeth(left, up, upLeft); break;
        default: throw new Error(`PNG filtro desconocido: ${filter}`);
      }
      pixels[rowStart + x] = out & 255;
    }
  }

  // Normalizar a RGBA
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0, n = width * height; i < n; i++) {
    const src = i * bpp;
    const dst = i * 4;
    if (colorType === 6) {
      rgba[dst] = pixels[src];
      rgba[dst + 1] = pixels[src + 1];
      rgba[dst + 2] = pixels[src + 2];
      rgba[dst + 3] = pixels[src + 3];
    } else if (colorType === 2) {
      rgba[dst] = pixels[src];
      rgba[dst + 1] = pixels[src + 1];
      rgba[dst + 2] = pixels[src + 2];
      rgba[dst + 3] = 255;
    } else if (colorType === 0) {
      rgba[dst] = rgba[dst + 1] = rgba[dst + 2] = pixels[src];
      rgba[dst + 3] = 255;
    } else if (colorType === 4) {
      rgba[dst] = rgba[dst + 1] = rgba[dst + 2] = pixels[src];
      rgba[dst + 3] = pixels[src + 1];
    } else if (colorType === 3) {
      const idx = pixels[src] * 3;
      rgba[dst] = palette[idx];
      rgba[dst + 1] = palette[idx + 1];
      rgba[dst + 2] = palette[idx + 2];
      rgba[dst + 3] = transparency && pixels[src] < transparency.length
        ? transparency[pixels[src]]
        : 255;
    }
  }

  return { width, height, data: rgba };
}
