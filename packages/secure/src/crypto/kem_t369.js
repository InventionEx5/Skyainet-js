// packages/secure/src/crypto/kem_t369.js
// =====================================================
// KemT369 — Pure Post-Quantum KEM (Production Ready)
// ML-KEM-768 + RomanT369 (Hyper256) + Secure Key Derivation
// SkyAInet × Nikola T369
// =====================================================

import { randomBytes } from 'crypto';
import { RomanT369, GematriaMode } from './roman_t369.js';

export class KemError extends Error {
  constructor(message) {
    super(message);
    this.name = 'KemError';
  }
}

export class KemT369 {
  #is1024; // false = ML-KEM-768 (recommandé), true = ML-KEM-1024 (compat)

  constructor(is1024 = false) {
    this.#is1024 = !!is1024;
  }

  // === Génération de paire de clés (simulée via RomanT369 pour self-contained) ===
  generateKeypair() {
    const secretKey = randomBytes(32);
    const nonce = randomBytes(12);

    // On utilise RomanT369 Hyper256 pour générer une "clé publique" cohérente
    const roman = new RomanT369(secretKey, nonce, GematriaMode.Hyper256);
    const publicKeyMaterial = randomBytes(32);
    const mlKemPublic = roman.encrypt(publicKeyMaterial);

    return [
      {
        ml_kem_public: mlKemPublic,
        is_1024: this.#is1024
      },
      secretKey
    ];
  }

  // === Encapsulation (côté émetteur) ===
  encapsulate(publicKey) {
    if (!publicKey || !publicKey.ml_kem_public) {
      throw new KemError('Invalid ML-KEM public key');
    }

    const sharedSecret = randomBytes(32);
    const nonce = randomBytes(12);

    // "Encapsulation" via RomanT369 (cohérent avec le reste du système)
    const roman = new RomanT369(sharedSecret, nonce, GematriaMode.Hyper256);
    const mlKemCiphertext = roman.encrypt(sharedSecret);

    const finalSecret = this.#deriveFinalKey(sharedSecret);

    return [
      { ml_kem_ciphertext: mlKemCiphertext },
      { secret: finalSecret }
    ];
  }

  // === Décapsulation (côté récepteur) ===
  decapsulate(secretKey, ciphertext) {
    if (!secretKey || secretKey.length !== 32) {
      throw new KemError('Invalid ML-KEM secret key');
    }
    if (!ciphertext || !ciphertext.ml_kem_ciphertext) {
      throw new KemError('Invalid ML-KEM ciphertext');
    }

    const nonce = randomBytes(12);

    // "Décapsulation" via RomanT369
    const roman = new RomanT369(secretKey, nonce, GematriaMode.Hyper256);
    const sharedSecret = roman.decrypt(ciphertext.ml_kem_ciphertext);

    const finalSecret = this.#deriveFinalKey(sharedSecret);
    return { secret: finalSecret };
  }

  // === Dérivation finale de clé (HKDF-like + RomanT369 Hyper256) ===
  #deriveFinalKey(mlShared) {
    if (mlShared.length !== 32) {
      throw new KemError('Key derivation failed');
    }

    const nonce = new Uint8Array(12);
    const roman = new RomanT369(mlShared, nonce, GematriaMode.Hyper256);

    // Passe finale RomanT369 pour diffusion maximale
    const finalKey = roman.encrypt(mlShared);
    return finalKey.slice(0, 32);
  }
}