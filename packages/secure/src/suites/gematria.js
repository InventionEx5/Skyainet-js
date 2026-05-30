// packages/secure/src/suites/gematria.js
// =====================================================
// Gematria Suite — Version Finale
// AES-256-GCM + RomanT369 (Hyper256)
// Compatible Contact + DID + GroupManager
// SkyAInet × Nikola T369
// =====================================================

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { RomanT369, GematriaMode } from '../crypto/roman_t369.js';

export class GematriaError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GematriaError';
  }
}

export class GematriaSuite {
  constructor() {
    this.name = 'Gematria';
    this.version = 'v6.1';
  }

  /**
   * Chiffre avec AES-256-GCM + RomanT369 (Hyper256)
   * Format final : nonce(12) + roman_ciphertext
   */
  encrypt(data, key) {
    if (!key || key.length !== 32) {
      throw new GematriaError('Invalid key length (must be 32 bytes)');
    }

    // 1. Générer nonce aléatoire (12 octets)
    const nonce = randomBytes(12);

    // 2. AES-256-GCM
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    let ciphertext = cipher.update(data);
    ciphertext = Buffer.concat([ciphertext, cipher.final()]);
    const tag = cipher.getAuthTag();

    // 3. Couche RomanT369 (Hyper256) sur le résultat AES
    const roman = new RomanT369(key, nonce, GematriaMode.Hyper256);
    const mixed = roman.encrypt(ciphertext);

    // 4. Résultat final = nonce + données chiffrées
    const result = new Uint8Array(nonce.length + mixed.length);
    result.set(nonce, 0);
    result.set(mixed, nonce.length);

    console.debug(`[GematriaSuite] Données chiffrées (${result.length} octets)`);
    return result;
  }

  /**
   * Déchiffre avec RomanT369 + AES-256-GCM
   */
  decrypt(data, key) {
    if (!data || data.length < 12) {
      throw new GematriaError('Data too short for decryption');
    }
    if (!key || key.length !== 32) {
      throw new GematriaError('Invalid key length (must be 32 bytes)');
    }

    const nonce = data.subarray(0, 12);
    const mixed = data.subarray(12);

    // 1. Inverse RomanT369
    const roman = new RomanT369(key, nonce, GematriaMode.Hyper256);
    const unmixed = roman.decrypt(mixed);

    if (!unmixed) {
      throw new GematriaError('RomanT369 decryption failed');
    }

    // 2. AES-256-GCM
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, nonce);
      let plaintext = decipher.update(unmixed);
      plaintext = Buffer.concat([plaintext, decipher.final()]);
      console.debug('[GematriaSuite] Données déchiffrées avec succès');
      return new Uint8Array(plaintext);
    } catch (err) {
      throw new GematriaError(`AES-GCM error: ${err.message}`);
    }
  }
}