// packages/secure/src/crypto/hybrid.js
// =====================================================
// Hybrid Transport — Stratégie Finale Production
// KemT369 (ML-KEM-768) + RomanT369 (Hyper256) + GematriaAead
// SkyAInet × Nikola T369
// =====================================================

import { KemT369 } from './kem_t369.js';
import { RomanT369, GematriaMode } from './roman_t369.js';
import { hkdfSha256 } from './sha_fips.js';

export class HybridError extends Error {
  constructor(message) {
    super(message);
    this.name = 'HybridError';
  }
}

export const HybridMode = Object.freeze({
  KemT369Core:   'KemT369Core',     // 80% du trafic — cœur post-quantique
  FlashGematria: 'FlashGematria',   // 20% — métadonnées légères
  FullGematria:  'FullGematria',    // extrémités (mobile, navigateur, WebRTC)
});

class GematriaAead {
  #roman;

  constructor(key, nonce) {
    this.#roman = new RomanT369(key, nonce, GematriaMode.Hyper256);
  }

  encrypt(plaintext) {
    return this.#roman.encrypt(plaintext);
  }

  decrypt(ciphertext) {
    return this.#roman.decrypt(ciphertext);
  }
}

export class HybridTransport {
  #kem;
  #currentMode;
  #cachedSecret; // Uint8Array[32] | null

  constructor(is1024 = false) {
    this.#kem = new KemT369(is1024);
    this.#currentMode = HybridMode.KemT369Core;
    this.#cachedSecret = null;
  }

  setMode(mode) {
    if (!Object.values(HybridMode).includes(mode)) {
      throw new HybridError('Invalid mode');
    }
    this.#currentMode = mode;
  }

  // === Chiffrement ===
  encrypt(publicKey, plaintext, mode = this.#currentMode) {
    const [kemCt, shared] = this.#kem.encapsulate(publicKey);
    const secret = shared.secret;

    const [key, nonce] = deriveKeys(secret);

    let ciphertext;
    if (mode === HybridMode.FlashGematria) {
      const aead = new GematriaAead(key, nonce);
      ciphertext = aead.encrypt(plaintext);
    } else {
      const roman = new RomanT369(key, nonce, GematriaMode.Hyper256);
      ciphertext = roman.encrypt(plaintext);
    }

    if (mode === HybridMode.FullGematria) {
      this.#cachedSecret = secret;
    }

    return [kemCt, ciphertext];
  }

  // === Déchiffrement ===
  decrypt(secretKey, kemCt, ciphertext, mode = this.#currentMode) {
    const shared = this.#kem.decapsulate(secretKey, kemCt);
    const secret = shared.secret;

    const [key, nonce] = deriveKeys(secret);

    let plaintext;
    if (mode === HybridMode.FlashGematria) {
      const aead = new GematriaAead(key, nonce);
      plaintext = aead.decrypt(ciphertext);
    } else {
      const roman = new RomanT369(key, nonce, GematriaMode.Hyper256);
      plaintext = roman.decrypt(ciphertext);
    }

    return plaintext;
  }

  encryptWithCurrentMode(publicKey, plaintext) {
    return this.encrypt(publicKey, plaintext, this.#currentMode);
  }
}

// === Dérivation de clés ultra-rapide (réutilise hkdf natif) ===
function deriveKeys(sharedSecret) {
  const salt = new TextEncoder().encode('SkyAInet-Hybrid');
  const key   = hkdfSha256(sharedSecret, salt, new TextEncoder().encode('gematria-key'),   32);
  const nonce = hkdfSha256(sharedSecret, salt, new TextEncoder().encode('gematria-nonce'), 12);
  return [key, nonce];
}