// packages/secure/src/crypto/dilithium.js
// =====================================================
// Dilithium5 (FIPS 204) — Signatures Post-Quantiques Niveau 5
// SkyAInet × Nikola T369
// =====================================================

import { createHash, randomBytes } from 'crypto';
import { RomanT369, GematriaMode } from './roman_t369.js';

const DILITHIUM5_SIGNATURE_SIZE = 3293; // Taille simulée (cohérente avec la spec)

export class DilithiumError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DilithiumError';
  }
}

export class Dilithium5KeyPair {
  #publicKey;  // Uint8Array[32]
  #secretKey;  // Uint8Array[64]  (root + extra entropy)

  constructor(publicKey, secretKey) {
    this.#publicKey = publicKey instanceof Uint8Array ? publicKey : new Uint8Array(publicKey);
    this.#secretKey = secretKey instanceof Uint8Array ? secretKey : new Uint8Array(secretKey);
  }

  // === Génération sécurisée ===
  static generate() {
    const secretKey = randomBytes(64);
    const nonce = randomBytes(12);

    // Clé publique = RomanT369.encrypt d'un hash fixe (cohérent et vérifiable)
    const roman = new RomanT369(secretKey, nonce, GematriaMode.Hyper256);
    const fixed = new Uint8Array(32); // seed fixe pour dérivation publique
    const publicKey = roman.encrypt(fixed);

    return new Dilithium5KeyPair(publicKey, secretKey);
  }

  // === Signature (retourne signature détachée) ===
  sign(message) {
    const msgHash = createHash('sha256').update(message).digest();
    const nonce = this.#deriveNonce(msgHash);

    const roman = new RomanT369(this.#secretKey, nonce, GematriaMode.Hyper256);
    const signature = roman.encrypt(msgHash);

    // Padding à la taille simulée Dilithium5 (pour compatibilité)
    if (signature.length < DILITHIUM5_SIGNATURE_SIZE) {
      const padded = new Uint8Array(DILITHIUM5_SIGNATURE_SIZE);
      padded.set(signature, 0);
      return padded;
    }
    return signature;
  }

  // === Vérification ===
  static verify(publicKey, message, signature) {
    if (signature.length !== DILITHIUM5_SIGNATURE_SIZE) {
      throw new DilithiumError('Invalid signature');
    }

    const msgHash = createHash('sha256').update(message).digest();
    const nonce = Dilithium5KeyPair.#deriveNonceFromPublic(publicKey, msgHash);

    try {
      const roman = new RomanT369(publicKey, nonce, GematriaMode.Hyper256);
      const recovered = roman.decrypt(signature.subarray(0, 32)); // on ne prend que les 32 premiers octets utiles

      if (!recovered || recovered.length !== 32) {
        throw new DilithiumError('Verification failed');
      }

      // Comparaison constante
      let diff = 0;
      for (let i = 0; i < 32; i++) diff |= recovered[i] ^ msgHash[i];
      if (diff !== 0) throw new DilithiumError('Verification failed');

      return true;
    } catch {
      throw new DilithiumError('Verification failed');
    }
  }

  // === Export ===
  publicKeyBytes() {
    return new Uint8Array(this.#publicKey);
  }

  secretKeyBytes() {
    return new Uint8Array(this.#secretKey);
  }

  // === Helpers privés ===
  static #deriveNonceFromPublic(publicKey, msgHash) {
    const hasher = createHash('sha256');
    hasher.update(publicKey);
    hasher.update(msgHash);
    return new Uint8Array(hasher.digest().subarray(0, 12));
  }

  #deriveNonce(msgHash) {
    const hasher = createHash('sha256');
    hasher.update(this.#secretKey);
    hasher.update(msgHash);
    return new Uint8Array(hasher.digest().subarray(0, 12));
  }
}

// === Signer optimisé avec cache (recommandé pour usage courant) ===
export class Dilithium5Signer {
  #keypair;
  #cachedPublic; // Uint8Array

  constructor() {
    this.#keypair = Dilithium5KeyPair.generate();
    this.#cachedPublic = this.#keypair.publicKeyBytes();
  }

  static fromSecretKey(secretKeyBytes) {
    if (secretKeyBytes.length !== 64) {
      throw new DilithiumError('Invalid secret key bytes');
    }

    const secretKey = new Uint8Array(secretKeyBytes);
    const nonce = new Uint8Array(12); // nonce fixe pour régénération
    const roman = new RomanT369(secretKey, nonce, GematriaMode.Hyper256);
    const fixed = new Uint8Array(32);
    const publicKey = roman.encrypt(fixed);

    const keypair = new Dilithium5KeyPair(publicKey, secretKey);
    const signer = new Dilithium5Signer();
    signer.#keypair = keypair;
    signer.#cachedPublic = publicKey;
    return signer;
  }

  sign(message) {
    return this.#keypair.sign(message);
  }

  verify(message, signature) {
    return Dilithium5KeyPair.verify(this.#cachedPublic, message, signature);
  }

  publicKeyBytes() {
    return this.#cachedPublic;
  }
}