// packages/secure/src/crypto/aes_fips.js
// =====================================================
// AES-256-GCM (FIPS 140-3) — Version Production
// SkyAInet × Nikola T369 — Enterprise & Internal Use
// =====================================================

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { deriveAesKey } from './sha_fips.js';

export class AesError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AesError';
  }
}

export class Aes256GcmFips {
  #key; // Uint8Array[32]

  constructor(key) {
    if (key.length !== 32) {
      throw new AesError('Invalid key length');
    }
    this.#key = key instanceof Uint8Array ? key : new Uint8Array(key);
  }

  // === Chiffrement AEAD avec AAD ===
  encrypt(nonce, plaintext, aad = new Uint8Array(0)) {
    if (nonce.length !== 12) {
      throw new AesError('Invalid nonce length');
    }

    const nonceBuf = nonce instanceof Uint8Array ? nonce : new Uint8Array(nonce);
    const aadBuf   = aad instanceof Uint8Array ? aad : new Uint8Array(aad);
    const ptBuf    = plaintext instanceof Uint8Array ? plaintext : new Uint8Array(plaintext);

    const cipher = createCipheriv('aes-256-gcm', this.#key, nonceBuf, { authTagLength: 16 });
    if (aadBuf.length > 0) cipher.setAAD(aadBuf);

    const encrypted = cipher.update(ptBuf);
    cipher.final();

    const tag = cipher.getAuthTag();

    // Résultat = ciphertext + auth tag (16 octets) — standard AEAD
    const result = new Uint8Array(encrypted.length + 16);
    result.set(encrypted, 0);
    result.set(tag, encrypted.length);
    return result;
  }

  // === Déchiffrement AEAD avec AAD ===
  decrypt(nonce, ciphertext, aad = new Uint8Array(0)) {
    if (nonce.length !== 12) {
      throw new AesError('Invalid nonce length');
    }
    if (ciphertext.length < 16) {
      throw new AesError('Decryption failed');
    }

    const nonceBuf = nonce instanceof Uint8Array ? nonce : new Uint8Array(nonce);
    const aadBuf   = aad instanceof Uint8Array ? aad : new Uint8Array(aad);
    const ctBuf    = ciphertext instanceof Uint8Array ? ciphertext : new Uint8Array(ciphertext);

    const tag = ctBuf.subarray(ctBuf.length - 16);
    const encrypted = ctBuf.subarray(0, ctBuf.length - 16);

    const decipher = createDecipheriv('aes-256-gcm', this.#key, nonceBuf, { authTagLength: 16 });
    if (aadBuf.length > 0) decipher.setAAD(aadBuf);
    decipher.setAuthTag(tag);

    try {
      const decrypted = decipher.update(encrypted);
      decipher.final();
      return decrypted;
    } catch {
      throw new AesError('Decryption failed');
    }
  }

  // === Versions simplifiées (sans AAD) ===
  encryptSimple(nonce, plaintext) {
    return this.encrypt(nonce, plaintext, new Uint8Array(0));
  }

  decryptSimple(nonce, ciphertext) {
    return this.decrypt(nonce, ciphertext, new Uint8Array(0));
  }

  // === Dérivation de clé AES-256 (réutilise sha_fips) ===
  static deriveKey(rootKey, info) {
    return deriveAesKey(rootKey, info);
  }
}
