// packages/secure/src/crypto/hybrid.js
// =====================================================
// Hybrid Transport — KemT369 + RomanT369 + GematriaAead
// SkyAInet × Nikola T369
// =====================================================

import { KemT369 } from './kem_t369.js';
import { RomanT369, GematriaMode } from './roman_t369.js';
import { GematriaAead } from './gematria_aead.js';
import { hkdfSha256 } from './sha_fips.js';

const TE = new TextEncoder();

export class HybridError extends Error {
  constructor(message) { super(message); this.name = 'HybridError'; }
}

export const HybridMode = Object.freeze({
  KemT369Core:   'KemT369Core',
  FlashGematria: 'FlashGematria',
  FullGematria:  'FullGematria',
});

// Dérivation de clés depuis le secret partagé
function deriveKeys(sharedSecret) {
  const salt  = TE.encode('SkyAInet-Hybrid');
  const key   = hkdfSha256(sharedSecret, salt, TE.encode('gematria-key'),   32);
  const nonce = hkdfSha256(sharedSecret, salt, TE.encode('gematria-nonce'), 12);
  return [key, nonce];
}

export class HybridTransport {
  #kem; #currentMode; #cachedSecret;
  constructor(is1024 = false) {
    this.#kem = new KemT369(is1024);
    this.#currentMode = HybridMode.KemT369Core;
    this.#cachedSecret = null;
  }

  setMode(mode) {
    if (!Object.values(HybridMode).includes(mode)) throw new HybridError('Invalid mode');
    this.#currentMode = mode;
  }

  generateKeypair() { return this.#kem.generateKeypair(); }

  encrypt(publicKey, plaintext, mode = this.#currentMode) {
    const [kemCt, shared] = this.#kem.encapsulate(publicKey);
    const [key, nonce] = deriveKeys(shared.secret);
    const pt = plaintext instanceof Uint8Array ? plaintext : new Uint8Array(plaintext);
    let ciphertext;
    if (mode === HybridMode.FlashGematria) {
      ciphertext = new GematriaAead(key, nonce).encrypt(pt);
    } else {
      ciphertext = new RomanT369(key, nonce, GematriaMode.Hyper256).encrypt(pt);
    }
    if (mode === HybridMode.FullGematria) this.#cachedSecret = shared.secret;
    return [kemCt, ciphertext];
  }

  decrypt(secretKey, kemCt, ciphertext, mode = this.#currentMode) {
    const shared = this.#kem.decapsulate(secretKey, kemCt);
    const [key, nonce] = deriveKeys(shared.secret);
    if (mode === HybridMode.FlashGematria) {
      return new GematriaAead(key, nonce).decrypt(ciphertext);
    }
    return new RomanT369(key, nonce, GematriaMode.Hyper256).decrypt(ciphertext);
  }

  // deriveKeys exposé pour skynode (qui appelle this.#hybrid.deriveKeys())
  deriveKeys() {
    if (!this.#cachedSecret) {
      // Pas de secret négocié : génère une paire éphémère et encapsule pour soi
      const [pub, sec] = this.#kem.generateKeypair();
      const [kemCt, shared] = this.#kem.encapsulate(pub);
      this.#cachedSecret = shared.secret;
    }
    return deriveKeys(this.#cachedSecret);
  }

  encryptWithCurrentMode(publicKey, plaintext) {
    return this.encrypt(publicKey, plaintext, this.#currentMode);
  }
}
