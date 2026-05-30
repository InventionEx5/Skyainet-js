// packages/secure/src/crypto/kem_t369.js
// =====================================================
// KemT369 — Pure Post-Quantum KEM
// ML-KEM-768/1024 + RomanT369 (Hyper256) final derivation
// SkyAInet × Nikola T369
// =====================================================

import { ml_kem768, ml_kem1024 } from '@noble/post-quantum/ml-kem.js';
import { RomanT369, GematriaMode } from './roman_t369.js';

export class KemError extends Error {
  constructor(message) { super(message); this.name = 'KemError'; }
}

export class KemT369 {
  #is1024;
  constructor(is1024 = false) { this.#is1024 = !!is1024; }

  #kem() { return this.#is1024 ? ml_kem1024 : ml_kem768; }

  generateKeypair() {
    const { publicKey, secretKey } = this.#kem().keygen();
    return [
      { ml_kem_public: new Uint8Array(publicKey), is_1024: this.#is1024 },
      new Uint8Array(secretKey),
    ];
  }

  encapsulate(publicKey) {
    if (!publicKey || !publicKey.ml_kem_public) throw new KemError('Invalid ML-KEM public key');
    const kem = publicKey.is_1024 ? ml_kem1024 : ml_kem768;
    const { cipherText, sharedSecret } = kem.encapsulate(publicKey.ml_kem_public);
    return [
      { ml_kem_ciphertext: new Uint8Array(cipherText) },
      { secret: this.#deriveFinalKey(new Uint8Array(sharedSecret)) },
    ];
  }

  decapsulate(secretKey, ciphertext) {
    if (!secretKey || secretKey.length < 2400) throw new KemError('Invalid ML-KEM secret key');
    if (!ciphertext || !ciphertext.ml_kem_ciphertext) throw new KemError('Invalid ML-KEM ciphertext');
    const sharedSecret = this.#kem().decapsulate(ciphertext.ml_kem_ciphertext, secretKey);
    return { secret: this.#deriveFinalKey(new Uint8Array(sharedSecret)) };
  }

  // Dérivation finale : passe RomanT369 sur le secret partagé.
  // IMPORTANT : encrypt() est déterministe pour (key,nonce) fixes, donc les
  // deux parties obtiennent le même secret final. nonce = zéros (le secret ML
  // est déjà unique et secret ; RomanT369 sert de diffusion supplémentaire).
  #deriveFinalKey(mlShared) {
    if (mlShared.length !== 32) throw new KemError('Key derivation failed');
    const nonce = new Uint8Array(12);
    const roman = new RomanT369(mlShared, nonce, GematriaMode.Hyper256);
    return roman.encrypt(mlShared).slice(0, 32);
  }
}
