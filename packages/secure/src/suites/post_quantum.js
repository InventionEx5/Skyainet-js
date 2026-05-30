// packages/secure/src/suites/post_quantum.js
// =====================================================
// Post-Quantum Suite — ML-KEM-768/1024 + RomanT369 (Hyper256)
// Compatible Contact + DID + GroupManager
// SkyAInet × Nikola T369
// =====================================================

import { KemT369 } from '../crypto/kem_t369.js';
import { RomanT369, GematriaMode } from '../crypto/roman_t369.js';

export class PostQuantumError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PostQuantumError';
  }
}

export class PostQuantumSuite {
  constructor(is1024 = false) {
    this.name = 'PostQuantum';
    this.version = 'v6.1';
    this.kem = new KemT369(is1024);
  }

  /**
   * Génère une paire de clés post-quantique
   */
  generateKeypair() {
    return this.kem.generateKeypair();
  }

  /**
   * Chiffrement hybride post-quantique (KEM + RomanT369 Hyper256)
   */
  encrypt(publicKey, plaintext, contact = null) {
    if (!publicKey || !publicKey.ml_kem_public) {
      throw new PostQuantumError('Invalid public key');
    }

    const [kemCt, shared] = this.kem.encapsulate(publicKey);
    const nonce = new Uint8Array(12);

    const roman = new RomanT369(shared.secret, nonce, GematriaMode.Hyper256);
    const ciphertext = roman.encrypt(plaintext);

    console.debug(
      `[PostQuantumSuite] Message chiffré (KEM + RomanT369) — Contact: ${contact ? contact.name : 'unknown'}`
    );

    return [kemCt, ciphertext];
  }

  /**
   * Déchiffrement hybride post-quantique
   */
  decrypt(secretKey, kemCt, ciphertext) {
    if (!secretKey || secretKey.length !== 32) {
      throw new PostQuantumError('Invalid secret key');
    }

    const shared = this.kem.decapsulate(secretKey, kemCt);
    const nonce = new Uint8Array(12);

    const roman = new RomanT369(shared.secret, nonce, GematriaMode.Hyper256);
    const plaintext = roman.decrypt(ciphertext);

    if (!plaintext) {
      throw new PostQuantumError('RomanT369 decryption failed');
    }

    console.debug('[PostQuantumSuite] Message déchiffré avec succès');
    return plaintext;
  }

  is1024() {
    return this.kem.is1024 || false;
  }
}