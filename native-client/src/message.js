// Protocolo de mensajes BoomBang.
// Replica exacta de las clases r0 (builder) y Gg (reader) del bundle HTML5.
//
// Framing:
//   [177, id]  (+[179, type])  (+[179, subType])  [179, 178]
//   ...param bytes... [179, 178]   por cada parametro
//   [176]                          terminador (finish)
//
// El cuerpo se interpreta como windows-1252. El separador de campos es
// la secuencia de bytes [179, 178] ("\u00b3\u00b2").

const SEP_A = 179; // 0xB3
const SEP_B = 178; // 0xB2
const END = 176; // 0xB0
const HEAD = 177; // 0xB1

const decoder = new TextDecoder("windows-1252");
const SEPARATOR = decoder.decode(new Uint8Array([SEP_A, SEP_B]));
const TERMINATOR = String.fromCharCode(SEP_B);

/** Decodifica bytes crudos a string windows-1252 (igual que el cliente). */
export function decodeBody(bytes) {
  return decoder.decode(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
}

export class MessageBuilder {
  constructor(id, type = 0, subType = 0) {
    this.id = id;
    this.type = type;
    this.subType = subType;
    this.finished = false;
    this.body = [HEAD, id & 255];
    if (type > 0) {
      this.body.push(SEP_A, type & 255);
      if (subType > 0) this.body.push(SEP_A, subType & 255);
    }
    this.body.push(SEP_A, SEP_B);
  }

  get length() {
    return this.body.length;
  }

  appendByte(value) {
    this.body.push(value & 255);
    return this;
  }

  appendBytes(values) {
    for (const v of values) this.body.push(v & 255);
    return this;
  }

  appendSeparator(partial = false) {
    this.body.push(SEP_A);
    if (!partial) this.body.push(SEP_B);
    return this;
  }

  /**
   * Agrega un parametro. Reproduce appendParameter del cliente: los strings
   * se serializan con charCodeAt (un byte por code unit), no en UTF-8.
   */
  appendParameter(value, partial = false) {
    if (typeof value === "boolean") {
      this.body.push(value ? 0x31 : 0x30);
    } else if (typeof value === "number") {
      for (const ch of String(value)) this.body.push(ch.charCodeAt(0) & 255);
    } else if (typeof value === "string") {
      for (const ch of value) this.body.push(ch.charCodeAt(0) & 255);
    } else {
      this.body.push(SEP_A, SEP_B);
      return this;
    }
    this.body.push(SEP_A);
    if (!partial) this.body.push(SEP_B);
    return this;
  }

  finish() {
    if (!this.finished) {
      this.body.push(END);
      this.finished = true;
    }
    return this;
  }

  toByteArray() {
    this.finish();
    return new Uint8Array(this.body);
  }

  toString() {
    return decodeBody(this.toByteArray());
  }
}

export class MessageReader {
  constructor(bytes) {
    const body = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    this.body = body;
    this.id = body[1];
    this.type = body[3] !== SEP_B ? body[3] : 0;
    this.subType =
      body.length > 5 && this.type !== 0 && body[5] !== SEP_B ? body[5] : 0;
    this.params = decodeBody(body).split(SEPARATOR);
    this.pointer = 1;
    this.receivedAt = 0;
  }

  get length() {
    return this.body.length;
  }

  /** Cantidad de parametros reales (excluye cabecera y terminador). */
  get parameters() {
    return this.params.length - 2;
  }

  resetPointer() {
    this.pointer = 1;
    return this;
  }

  readString() {
    const raw = this.params[this.pointer++];
    if (raw === undefined) return "";
    const cut = raw.indexOf(TERMINATOR);
    return cut === -1 ? raw : raw.slice(0, cut);
  }

  readInt() {
    return parseInt(this.params[this.pointer++], 10) || 0;
  }

  readBool() {
    return this.params[this.pointer++] === "1";
  }

  readObject() {
    return this.params[this.pointer++];
  }

  /** Lista de parametros ya recortados, util para logging/telemetria. */
  fields() {
    return this.params.slice(1, -1).map((raw) => {
      const cut = raw.indexOf(TERMINATOR);
      return cut === -1 ? raw : raw.slice(0, cut);
    });
  }

  key() {
    return `${this.id}:${this.type}:${this.subType}`;
  }

  toString() {
    return decodeBody(this.body);
  }
}
