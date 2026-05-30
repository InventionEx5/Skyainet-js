// packages/secure/src/crypto/gematria_aead.js
// =====================================================
// Gematria AEAD — RomanT369 (Hyper256) + Tag SHA-256
// SkyAInet × Nikola T369
// =====================================================

import { createHash, timingSafeEqual } from 'crypto';
import { RomanT369, GematriaMode } from './roman_t369.js';
import { deriveGematriaAeadKeys } from './sha_fips.js';

const toU8 = (x) => x instanceof Uint8Array ? x : new Uint8Array(x);

export class GematriaAeadError extends Error {
  constructor(message) { super(message); this.name = 'GematriaAeadError'; }
}

export class GematriaAead {
  #key; #nonce;
  constructor(key, nonce) { this.#key = toU8(key); this.#nonce = toU8(nonce); }

  static fromRootKey(rootKey) {
    const [key, nonce] = deriveGematriaAeadKeys(rootKey);
    return new GematriaAead(key, nonce);
  }

  // Tag = SHA-256(key || nonce || ciphertext)[:16] — lie le tag à la clé+nonce
  #computeTag(ciphertext) {
    const h = createHash('sha256');
    h.update(this.#key); h.update(this.#nonce); h.update(ciphertext);
    return new Uint8Array(h.digest().subarray(0, 16));
  }

  encrypt(plaintext) {
    const roman = new RomanT369(this.#key, this.#nonce, GematriaMode.Hyper256);
    const ct = roman.encrypt(toU8(plaintext));
    const tag = this.#computeTag(ct);
    const result = new Uint8Array(ct.length + 16);
    result.set(ct, 0); result.set(tag, ct.length);
    return result;
  }

  decrypt(data) {
    const d = toU8(data);
    if (d.length < 16) throw new GematriaAeadError('Invalid input length');
    const ct  = d.subarray(0, d.length - 16);
    const tag = d.subarray(d.length - 16);
    const computed = this.#computeTag(ct);
    // Vérif AVANT déchiffrement (fail-fast, timing-safe)
    if (!timingSafeEqual(computed, toU8(tag)))
      throw new GematriaAeadError('Decryption failed: invalid tag or corrupted data');
    const roman = new RomanT369(this.#key, this.#nonce, GematriaMode.Hyper256);
    return roman.decrypt(ct);
  }

  encryptWithTag(plaintext) {
    const roman = new RomanT369(this.#key, this.#nonce, GematriaMode.Hyper256);
    const ct = roman.encrypt(toU8(plaintext));
    return [ct, this.#computeTag(ct)];
  }
}
