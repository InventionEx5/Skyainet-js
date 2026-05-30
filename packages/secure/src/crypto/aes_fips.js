// packages/secure/src/crypto/aes_fips.js
// =====================================================
// AES-256-GCM (FIPS 140-3) — Version Production
// SkyAInet × Nikola T369
// =====================================================

import { createCipheriv, createDecipheriv } from 'crypto';
import { deriveAesKey } from './sha_fips.js';

const toU8 = (x) => x instanceof Uint8Array ? x : new Uint8Array(x);

export class AesError extends Error {
  constructor(message) { super(message); this.name = 'AesError'; }
}

export class Aes256GcmFips {
  #key;
  constructor(key) {
    if (key.length !== 32) throw new AesError('Invalid key length');
    this.#key = toU8(key);
  }

  encrypt(nonce, plaintext, aad = new Uint8Array(0)) {
    if (nonce.length !== 12) throw new AesError('Invalid nonce length');
    const nonceBuf = toU8(nonce), aadBuf = toU8(aad), ptBuf = toU8(plaintext);
    const cipher = createCipheriv('aes-256-gcm', this.#key, nonceBuf, { authTagLength: 16 });
    if (aadBuf.length > 0) cipher.setAAD(aadBuf);
    // concat update + final (final peut produire des octets restants)
    const part1 = cipher.update(ptBuf);
    const part2 = cipher.final();
    const tag   = cipher.getAuthTag();
    const result = new Uint8Array(part1.length + part2.length + 16);
    result.set(part1, 0);
    result.set(part2, part1.length);
    result.set(tag, part1.length + part2.length);
    return result;
  }

  decrypt(nonce, ciphertext, aad = new Uint8Array(0)) {
    if (nonce.length !== 12) throw new AesError('Invalid nonce length');
    if (ciphertext.length < 16) throw new AesError('Decryption failed');
    const nonceBuf = toU8(nonce), aadBuf = toU8(aad), ctBuf = toU8(ciphertext);
    const tag = ctBuf.subarray(ctBuf.length - 16);
    const enc = ctBuf.subarray(0, ctBuf.length - 16);
    const decipher = createDecipheriv('aes-256-gcm', this.#key, nonceBuf, { authTagLength: 16 });
    if (aadBuf.length > 0) decipher.setAAD(aadBuf);
    decipher.setAuthTag(tag);
    try {
      const part1 = decipher.update(enc);
      const part2 = decipher.final();
      const result = new Uint8Array(part1.length + part2.length);
      result.set(part1, 0);
      result.set(part2, part1.length);
      return result;
    } catch {
      throw new AesError('Decryption failed');
    }
  }

  encryptSimple(nonce, plaintext)  { return this.encrypt(nonce, plaintext, new Uint8Array(0)); }
  decryptSimple(nonce, ciphertext) { return this.decrypt(nonce, ciphertext, new Uint8Array(0)); }

  static deriveKey(rootKey, info) { return deriveAesKey(rootKey, info); }
}
