// packages/secure/src/crypto/sha_fips.js
// =====================================================
// SHA-256 + HKDF-SHA256 (FIPS 140-3)
// SkyAInet × Nikola T369
// =====================================================

import { createHash, createHmac, hkdfSync, timingSafeEqual } from 'crypto';

const TE = new TextEncoder();
const toU8 = (x) => x instanceof Uint8Array ? x : new Uint8Array(x);

export class Sha256Hasher {
  #hasher;
  constructor() { this.#hasher = createHash('sha256'); }
  update(data) { this.#hasher.update(Buffer.from(toU8(data))); return this; }
  finalize() { return new Uint8Array(this.#hasher.digest()); }
  static hash(data) { return new Uint8Array(createHash('sha256').update(Buffer.from(toU8(data))).digest()); }
}

export function hkdfSha256(ikm, salt = null, info = new Uint8Array(0), okmLength = 32) {
  if (okmLength > 255 * 32) throw new Error('Invalid output length (max 8160 bytes)');
  if (okmLength <= 0)       throw new Error('Invalid output length (must be > 0)');
  const saltBuf = salt ? toU8(salt) : new Uint8Array(0);
  return new Uint8Array(hkdfSync('sha256', toU8(ikm), saltBuf, toU8(info), okmLength));
}

export function hkdfSha256Unchecked(ikm, salt = null, info = new Uint8Array(0), okmLength = 32) {
  const saltBuf = salt ? toU8(salt) : new Uint8Array(0);
  return new Uint8Array(hkdfSync('sha256', toU8(ikm), saltBuf, toU8(info), okmLength));
}

export function deriveGematriaAeadKeys(rootKey) {
  const root = toU8(rootKey);
  const key   = hkdfSha256Unchecked(root, TE.encode('T369-GEMATRIA'), TE.encode('GEMATRIA-KEY'),   32);
  const nonce = hkdfSha256Unchecked(root, TE.encode('T369-GEMATRIA'), TE.encode('GEMATRIA-NONCE'), 12);
  return [key, nonce];
}

export function deriveAesKey(rootKey, context) {
  const root = toU8(rootKey);
  const ctx  = context instanceof Uint8Array ? context : TE.encode(context);
  return hkdfSha256Unchecked(root, TE.encode('T369-AES'), ctx, 32);
}

export function constantTimeEq(a, b) {
  const aBuf = toU8(a), bBuf = toU8(b);
  if (aBuf.length !== bBuf.length) return false;   // évite throw de timingSafeEqual
  return timingSafeEqual(aBuf, bBuf);
}

export function hmacSha256(key, data) {
  return new Uint8Array(createHmac('sha256', toU8(key)).update(toU8(data)).digest());
}
