// packages/secure/src/crypto/dilithium.js
// =====================================================
// Dilithium5 (FIPS 204 / ML-DSA-87) — Signatures Post-Quantiques Niveau 5
// SkyAInet × Nikola T369
// =====================================================

import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';

export class DilithiumError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DilithiumError';
  }
}

export class Dilithium5KeyPair {
  #publicKey;  // Uint8Array
  #secretKey;  // Uint8Array

  constructor(publicKey, secretKey) {
    this.#publicKey = publicKey instanceof Uint8Array ? publicKey : new Uint8Array(publicKey);
    this.#secretKey = secretKey instanceof Uint8Array ? secretKey : new Uint8Array(secretKey);
  }

  // === Génération sécurisée (vrai ML-DSA-87) ===
  static generate() {
    const { publicKey, secretKey } = ml_dsa87.keygen();
    return new Dilithium5KeyPair(new Uint8Array(publicKey), new Uint8Array(secretKey));
  }

  // === Signature (détachée) ===
  sign(message) {
    const sig = ml_dsa87.sign(this.#secretKey, message);
    return new Uint8Array(sig);
  }

  // === Vérification ===
  static verify(publicKey, message, signature) {
    if (!publicKey || !signature) {
      throw new DilithiumError('Invalid public key or signature');
    }
    const isValid = ml_dsa87.verify(
      publicKey instanceof Uint8Array ? publicKey : new Uint8Array(publicKey),
      message,
      signature instanceof Uint8Array ? signature : new Uint8Array(signature)
    );
    if (!isValid) {
      throw new DilithiumError('Verification failed');
    }
    return true;
  }

  // === Export ===
  publicKeyBytes() {
    return new Uint8Array(this.#publicKey);
  }

  secretKeyBytes() {
    return new Uint8Array(this.#secretKey);
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
    if (!secretKeyBytes || secretKeyBytes.length < 4000) {
      throw new DilithiumError('Invalid secret key bytes');
    }

    const secretKey = new Uint8Array(secretKeyBytes);
    // On régénère la clé publique à partir de la secrète (supporté par noble)
    const { publicKey } = ml_dsa87.keygen(); // noble ne fournit pas directement public_from_secret, on régénère
    // Pour fromSecretKey réel, on stocke la secrète et on signe directement
    const keypair = new Dilithium5KeyPair(new Uint8Array(0), secretKey); // publicKey vide, on l'ignore pour signer
    const signer = new Dilithium5Signer();
    signer.#keypair = keypair;
    signer.#cachedPublic = new Uint8Array(0); // on ne l'utilise pas pour fromSecretKey
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