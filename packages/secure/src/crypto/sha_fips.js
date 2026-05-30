// packages/secure/src/crypto/sha_fips.js
// =====================================================
// SHA-256 + HKDF-SHA256 (FIPS 140-3)
// SkyAInet × Nikola T369
// GematriaAead (post-quantique ready)
// =====================================================

import { createHash, createHmac, hkdfSync, timingSafeEqual } from 'crypto';

// ─── Classe SHA-256 Hasher (wrapper léger) ──────────────────────────────────
export class Sha256Hasher {
  #hasher;

  constructor() {
    this.#hasher = createHash('sha256');
  }

  update(data) {
    this.#hasher.update(data);
    return this; // fluent
  }

  finalize() {
    return new Uint8Array(this.#hasher.digest());
  }

  // Version one-shot ultra-rapide
  static hash(data) {
    return new Uint8Array(createHash('sha256').update(data).digest());
  }
}

// ─── HKDF-SHA256 (natif + ultra-rapide) ─────────────────────────────────────
export function hkdfSha256(ikm, salt = null, info = new Uint8Array(0), okmLength = 32) {
  if (okmLength > 255 * 32) {
    throw new Error('Invalid output length (max 8160 bytes)');
  }

  const saltBuf = salt ? (salt instanceof Uint8Array ? salt : new Uint8Array(salt)) : new Uint8Array(0);
  const ikmBuf  = ikm  instanceof Uint8Array ? ikm  : new Uint8Array(ikm);
  const infoBuf = info instanceof Uint8Array ? info : new Uint8Array(info);

  const okm = hkdfSync('sha256', ikmBuf, saltBuf, infoBuf, okmLength);
  return new Uint8Array(okm);
}

// Version interne sans vérification (pour perf maximale)
export function hkdfSha256Unchecked(ikm, salt = null, info = new Uint8Array(0), okmLength = 32) {
  const saltBuf = salt ? (salt instanceof Uint8Array ? salt : new Uint8Array(salt)) : new Uint8Array(0);
  const ikmBuf  = ikm  instanceof Uint8Array ? ikm  : new Uint8Array(ikm);
  const infoBuf = info instanceof Uint8Array ? info : new Uint8Array(info);

  return new Uint8Array(hkdfSync('sha256', ikmBuf, saltBuf, infoBuf, okmLength));
}

// ─── Dérivations spécifiques GematriaAead ───────────────────────────────────
export function deriveGematriaAeadKeys(rootKey) {
  const root = rootKey instanceof Uint8Array ? rootKey : new Uint8Array(rootKey);

  const key   = hkdfSha256Unchecked(root, new TextEncoder().encode('T369-GEMATRIA'), new TextEncoder().encode('GEMATRIA-KEY'),   32);
  const nonce = hkdfSha256Unchecked(root, new TextEncoder().encode('T369-GEMATRIA'), new TextEncoder().encode('GEMATRIA-NONCE'), 12);

  return [key, nonce];
}

export function deriveAesKey(rootKey, context) {
  const root = rootKey instanceof Uint8Array ? rootKey : new Uint8Array(rootKey);
  const ctx  = context instanceof Uint8Array ? context : new TextEncoder().encode(context);

  return hkdfSha256Unchecked(root, new TextEncoder().encode('T369-AES'), ctx, 32);
}

// ─── Comparaison constante (résistance timing attacks) ──────────────────────
export function constantTimeEq(a, b) {
  const aBuf = a instanceof Uint8Array ? a : new Uint8Array(a);
  const bBuf = b instanceof Uint8Array ? b : new Uint8Array(b);
  return timingSafeEqual(aBuf, bBuf);
}

// ─── HMAC-SHA256 ────────────────────────────────────────────────────────────
export function hmacSha256(key, data) {
  const keyBuf = key instanceof Uint8Array ? key : new Uint8Array(key);
  const dataBuf = data instanceof Uint8Array ? data : new Uint8Array(data);

  return new Uint8Array(createHmac('sha256', keyBuf).update(dataBuf).digest());
}