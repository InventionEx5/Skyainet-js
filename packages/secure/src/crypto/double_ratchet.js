// packages/secure/src/crypto/double_ratchet.js
// =====================================================
// Double Ratchet — Version Finale Production
// Thevie × Nikola T369 — RomanT369 (Hyper256) + Post-Quantum Ready
// Compatible avec GematriaAead + KemT369
// =====================================================

import { generateKeyPairSync, diffieHellman, randomBytes, createHash } from 'crypto';
import { RomanT369, GematriaMode } from './roman_t369.js';
import { hkdfSha256 } from './sha_fips.js';

const MAX_SKIP = 1000;

export class DoubleRatchetError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DoubleRatchetError';
  }
}

export class DoubleRatchet {
  #rootKey;              // Uint8Array[32]
  #sendChainKey;         // Uint8Array[32]
  #recvChainKey;         // Uint8Array[32]
  #sendRatchetPrivate;   // KeyObject (x25519 natif)
  #sendRatchetPublic;    // Uint8Array (raw 32 bytes)
  #recvRatchetPublic;    // Uint8Array | null
  #sendMessageNumber;    // number
  #recvMessageNumber;    // number
  #skippedKeys;          // Map<string, Uint8Array[32]>

  constructor(rootKey, sendRatchetPrivate = null) {
    this.#rootKey = rootKey instanceof Uint8Array ? rootKey : new Uint8Array(rootKey);
    this.#sendChainKey = new Uint8Array(this.#rootKey);
    this.#recvChainKey = new Uint8Array(32);
    this.#sendMessageNumber = 0;
    this.#recvMessageNumber = 0;
    this.#skippedKeys = new Map();

    if (sendRatchetPrivate) {
      this.#sendRatchetPrivate = sendRatchetPrivate;
    } else {
      const { privateKey, publicKey } = generateKeyPairSync('x25519');
      this.#sendRatchetPrivate = privateKey;
      this.#sendRatchetPublic = new Uint8Array(publicKey.export({ format: 'der', type: 'spki' }).slice(-32));
    }

    this.#recvRatchetPublic = null;
  }

  // === Dérivation de clé de message (HKDF ultra-rapide via sha_fips) ===
  static #deriveMessageKey(chainKey) {
    const salt = new Uint8Array(0);
    const infoMsg = new TextEncoder().encode('T369-DR-MSG-KEY');
    const infoChain = new TextEncoder().encode('T369-DR-CHAIN');

    const messageKey = hkdfSha256(chainKey, salt, infoMsg, 32);
    const newChain = hkdfSha256(chainKey, salt, infoChain, 32);
    chainKey.set(newChain);
    return messageKey;
  }

  // === Nonce déterministe et unique ===
  #deriveNonce() {
    const hasher = createHash('sha256');
    hasher.update(new Uint8Array(new Uint32Array([this.#sendMessageNumber]).buffer));
    hasher.update(new Uint8Array(new Uint32Array([this.#recvMessageNumber]).buffer));
    hasher.update(this.#rootKey.subarray(0, 8));
    return new Uint8Array(hasher.digest().subarray(0, 12));
  }

  // === Chiffrement ===
  encrypt(plaintext) {
    const messageKey = DoubleRatchet.#deriveMessageKey(this.#sendChainKey);
    const nonce = this.#deriveNonce();

    const roman = new RomanT369(messageKey, nonce, GematriaMode.Hyper256);
    const ciphertext = roman.encrypt(plaintext);

    this.#sendMessageNumber++;
    return ciphertext;
  }

  // === Déchiffrement avec gestion des messages en retard ===
  decrypt(ciphertext) {
    const keyStr = `${this.#recvMessageNumber}:0`;
    if (this.#skippedKeys.has(keyStr)) {
      const key = this.#skippedKeys.get(keyStr);
      this.#skippedKeys.delete(keyStr);
      const roman = new RomanT369(key, this.#deriveNonce(), GematriaMode.Hyper256);
      const pt = roman.decrypt(ciphertext);
      if (!pt) throw new DoubleRatchetError('Decryption failed');
      return pt;
    }

    if (this.#recvChainKey.every(b => b === 0)) {
      throw new DoubleRatchetError('Decryption failed');
    }

    const messageKey = DoubleRatchet.#deriveMessageKey(this.#recvChainKey);
    const roman = new RomanT369(messageKey, this.#deriveNonce(), GematriaMode.Hyper256);
    const plaintext = roman.decrypt(ciphertext);

    if (!plaintext) throw new DoubleRatchetError('Decryption failed');

    this.#recvMessageNumber++;
    return plaintext;
  }

  // === Ratchet de racine (changement de direction) ===
  ratchet(theirRatchetPublic) {
    if (this.#recvRatchetPublic) {
      throw new DoubleRatchetError('Invalid ratchet key');
    }

    const theirPub = theirRatchetPublic instanceof Uint8Array 
      ? theirRatchetPublic 
      : new Uint8Array(theirRatchetPublic);

    // Diffie-Hellman X25519 natif (le plus rapide possible)
    const shared = diffieHellman({
      privateKey: this.#sendRatchetPrivate,
      publicKey: theirPub
    });

    const transcript = new Uint8Array(shared.length + this.#rootKey.length);
    transcript.set(shared, 0);
    transcript.set(this.#rootKey, shared.length);

    const salt = new TextEncoder().encode('T369-DR-ROOT');
    this.#rootKey = hkdfSha256(transcript, salt, new TextEncoder().encode('root'), 32);
    this.#sendChainKey = hkdfSha256(transcript, salt, new TextEncoder().encode('send-chain'), 32);
    this.#recvChainKey = hkdfSha256(transcript, salt, new TextEncoder().encode('recv-chain'), 32);

    this.#recvRatchetPublic = theirPub;

    // Nouveau ratchet éphémère
    const { privateKey, publicKey } = generateKeyPairSync('x25519');
    this.#sendRatchetPrivate = privateKey;
    this.#sendRatchetPublic = new Uint8Array(publicKey.export({ format: 'der', type: 'spki' }).slice(-32));

    this.#sendMessageNumber = 0;
    this.#recvMessageNumber = 0;
  }

  // === Saut de messages (pour les messages en retard) ===
  skipMessageKeys(until) {
    if (until - this.#recvMessageNumber > MAX_SKIP) {
      throw new DoubleRatchetError('Too many skipped messages');
    }

    while (this.#recvMessageNumber < until) {
      const key = DoubleRatchet.#deriveMessageKey(this.#recvChainKey);
      const keyStr = `${this.#recvMessageNumber}:0`;
      this.#skippedKeys.set(keyStr, key);
      this.#recvMessageNumber++;
    }
  }

  // === Accesseurs utiles ===
  getSendRatchetPublic() {
    return this.#sendRatchetPublic;
  }
}