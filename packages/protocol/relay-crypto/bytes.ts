/** Byte helpers shared inside `relay-crypto/`. Not part of the public surface. */

/** Every failure this module raises: bad keys, auth failure, misuse, limits. */
export class RelayCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelayCryptoError";
  }
}

const encoder = new TextEncoder();
// `ignoreBOM: false` is the default; it is spelled out because the Workers
// type definitions (the relay bundles this file) mark it required.
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

export function fromUtf8(bytes: Uint8Array): string {
  try {
    return decoder.decode(bytes);
  } catch {
    throw new RelayCryptoError("invalid UTF-8");
  }
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const p of parts) length += p.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

const B64URL =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const B64URL_INDEX: Record<string, number> = {};
for (let i = 0; i < B64URL.length; i++) B64URL_INDEX[B64URL[i]] = i;

/** Unpadded base64url (RFC 4648 §5). */
export function base64urlEncode(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out +=
      B64URL[(n >> 18) & 63] +
      B64URL[(n >> 12) & 63] +
      B64URL[(n >> 6) & 63] +
      B64URL[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out += B64URL[(n >> 18) & 63] + B64URL[(n >> 12) & 63];
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out +=
      B64URL[(n >> 18) & 63] + B64URL[(n >> 12) & 63] + B64URL[(n >> 6) & 63];
  }
  return out;
}

/**
 * Strict unpadded base64url decode: rejects padding, characters outside the
 * alphabet, impossible lengths and non-zero trailing bits, so every byte
 * string has exactly one accepted encoding.
 */
export function base64urlDecode(text: string): Uint8Array {
  if (text.length % 4 === 1)
    throw new RelayCryptoError("invalid base64url length");
  const values = new Array<number>(text.length);
  for (let i = 0; i < text.length; i++) {
    const v = B64URL_INDEX[text[i]];
    if (v === undefined)
      throw new RelayCryptoError("invalid base64url character");
    values[i] = v;
  }
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let o = 0;
  let i = 0;
  for (; i + 3 < values.length; i += 4) {
    const n =
      (values[i] << 18) |
      (values[i + 1] << 12) |
      (values[i + 2] << 6) |
      values[i + 3];
    out[o++] = (n >> 16) & 0xff;
    out[o++] = (n >> 8) & 0xff;
    out[o++] = n & 0xff;
  }
  const rest = values.length - i;
  if (rest === 2) {
    if (values[i + 1] & 0x0f)
      throw new RelayCryptoError("non-canonical base64url");
    out[o] = (values[i] << 2) | (values[i + 1] >> 4);
  } else if (rest === 3) {
    if (values[i + 2] & 0x03)
      throw new RelayCryptoError("non-canonical base64url");
    const n = (values[i] << 18) | (values[i + 1] << 12) | (values[i + 2] << 6);
    out[o] = (n >> 16) & 0xff;
    out[o + 1] = (n >> 8) & 0xff;
  }
  return out;
}
