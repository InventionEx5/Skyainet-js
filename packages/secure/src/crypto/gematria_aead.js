// packages/secure/src/crypto/gematria_aead.js
// =====================================================
// Gematria AEAD — Version Finale Production
// RomanT369 (Hyper256) + SHA-256 Auth Tag
// SkyAInet × Nikola T369
// Compatible avec deriveGematriaAeadKeys (sha_fips)
// =====================================================

import { createHash } from 'crypto';
import { RomanT369, GematriaMode } from './roman_t369.js';
import { deriveGematriaAeadKeys } from './sha_fips.js';

export class GematriaAeadError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GematriaAeadError';
  }
}

export class GematriaAead {
  #key;   // Uint8Array[32]
  #nonce; // Uint8Array[12]

  constructor(key, nonce) {
    this.#key   = key instanceof Uint8Array ? key : new Uint8Array(key);
    this.#nonce = nonce instanceof Uint8Array ? nonce : new Uint8Array(nonce);
  }

  // === Création depuis root_key (utilise la dérivation FIPS) ===
  static fromRootKey(rootKey) {
    const [key, nonce] = deriveGematriaAeadKeys(rootKey);
    return new GematriaAead(key, nonce);
  }

  // === Chiffrement AEAD : RomanT369 + Tag SHA-256 (16 octets) ===
  encrypt(plaintext) {
    const roman = new RomanT369(this.#key, this.#nonce, GematriaMode.Hyper256);
    const ciphertext = roman.encrypt(plaintext);

    // Tag d'authentification (16 premiers octets du SHA-256)
    const hasher = createHash('sha256');
    hasher.update(this.#key);
    hasher.update(this.#nonce);
    hasher.update(ciphertext);
    const tag = hasher.digest().subarray(0, 16);

    // Résultat = ciphertext + tag
    const result = new Uint8Array(ciphertext.length + 16);
    result.set(ciphertext, 0);
    result.set(tag, ciphertext.length);
    return result;
  }

  // === Déchiffrement + vérification du tag ===
  decrypt(data) {
    if (data.length < 16) {
      throw new GematriaAeadError('Invalid input length');
    }

    const ciphertext = data.subarray(0, data.length - 16);
    const tag        = data.subarray(data.length - 16);

    const roman = new RomanT369(this.#key, this.#nonce, GematriaMode.Hyper256);
    const plaintext = roman.decrypt(ciphertext);

    // Vérification du tag
    const hasher = createHash('sha256');
    hasher.update(this.#key);
    hasher.update(this.#nonce);
    hasher.update(ciphertext);
    const computedTag = hasher.digest().subarray(0, 16);

    // Comparaison constante (timing-safe)
    if (!this.#constantTimeEq(computedTag, tag)) {
      throw new GematriaAeadError('Decryption failed: invalid tag or corrupted data');
    }

    return plaintext;
  }

  // === Version avancée : retourne ciphertext + tag séparément ===
  encryptWithTag(plaintext) {
    const roman = new RomanT369(this.#key, this.#nonce, GematriaMode.Hyper256);
    const ciphertext = roman.encrypt(plaintext);

    const hasher = createHash('sha256');
    hasher.update(this.#key);
    hasher.update(this.#nonce);
    hasher.update(ciphertext);
    const tag = hasher.digest().subarray(0, 16);

    return [ciphertext, tag];
  }

  // === Comparaison constante (résistance aux attaques temporelles) ===
  #constantTimeEq(a, b) {
    if (a.length !== b.length) return false;
    let result = 0;
    for (let i = 0; i < a.length; i++) {
      result |= a[i] ^ b[i];
    }
    return result === 0;
  }
}