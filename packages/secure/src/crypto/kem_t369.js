// packages/secure/src/crypto/kem_t369.js
// =====================================================
// KemT369 — Pure Post-Quantum KEM
// ML-KEM-768 + RomanT369 (Hyper256) + Secure Key Derivation
// SkyAInet × Nikola T369
// =====================================================

import { ml_kem768, ml_kem1024 } from '@noble/post-quantum/ml-kem.js';
import { RomanT369, GematriaMode } from './roman_t369.js';

export class KemError extends Error {
  constructor(message) {
    super(message);
    this.name = 'KemError';
  }
}

export class KemT369 {
  #is1024; // false = ML-KEM-768 (recommandé), true = ML-KEM-1024

  constructor(is1024 = false) {
    this.#is1024 = !!is1024;
  }

  // === Génération de paire de clés (vrai ML-KEM) ===
  generateKeypair() {
    const kem = this.#is1024 ? ml_kem1024 : ml_kem768;
    const { publicKey, secretKey } = kem.keygen();

    return [
      {
        ml_kem_public: new Uint8Array(publicKey),
        is_1024: this.#is1024
      },
      new Uint8Array(secretKey)
    ];
  }

  // === Encapsulation (côté émetteur) ===
  encapsulate(publicKey) {
    if (!publicKey || !publicKey.ml_kem_public) {
      throw new KemError('Invalid ML-KEM public key');
    }

    const kem = publicKey.is_1024 ? ml_kem1024 : ml_kem768;
    const { cipherText, sharedSecret } = kem.encapsulate(publicKey.ml_kem_public);

    const finalSecret = this.#deriveFinalKey(new Uint8Array(sharedSecret));

    return [
      { ml_kem_ciphertext: new Uint8Array(cipherText) },
      { secret: finalSecret }
    ];
  }

  // === Décapsulation (côté récepteur) ===
  decapsulate(secretKey, ciphertext) {
    if (!secretKey || secretKey.length < 2400) {
      throw new KemError('Invalid ML-KEM secret key');
    }
    if (!ciphertext || !ciphertext.ml_kem_ciphertext) {
      throw new KemError('Invalid ML-KEM ciphertext');
    }

    const kem = this.#is1024 ? ml_kem1024 : ml_kem768;
    const sharedSecret = kem.decapsulate(ciphertext.ml_kem_ciphertext, secretKey);

    const finalSecret = this.#deriveFinalKey(new Uint8Array(sharedSecret));
    return { secret: finalSecret };
  }

  // === Dérivation finale de clé (HKDF-like + RomanT369 Hyper256) ===
  #deriveFinalKey(mlShared) {
    if (mlShared.length !== 32) {
      throw new KemError('Key derivation failed');
    }

    const nonce = new Uint8Array(12);
    const roman = new RomanT369(mlShared, nonce, GematriaMode.Hyper256);

    // Passe finale RomanT369 pour diffusion maximale (ton invention)
    const finalKey = roman.encrypt(mlShared);
    return finalKey.slice(0, 32);
  }
}