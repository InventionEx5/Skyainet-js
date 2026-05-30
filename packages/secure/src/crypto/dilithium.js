// packages/secure/src/crypto/dilithium.js
// =====================================================
// Dilithium5 (FIPS 204 / ML-DSA-87) — Signatures PQ Niveau 5
// SkyAInet × Nikola T369
// =====================================================

import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';

const toU8 = (x) => x instanceof Uint8Array ? x : new Uint8Array(x);

export class DilithiumError extends Error {
  constructor(message) { super(message); this.name = 'DilithiumError'; }
}

export class Dilithium5KeyPair {
  #publicKey; #secretKey;
  constructor(publicKey, secretKey) {
    this.#publicKey = toU8(publicKey);
    this.#secretKey = toU8(secretKey);
  }

  static generate() {
    const { publicKey, secretKey } = ml_dsa87.keygen();
    return new Dilithium5KeyPair(new Uint8Array(publicKey), new Uint8Array(secretKey));
  }

  // Reconstruit une paire à partir d'une graine 32 octets (déterministe).
  // C'est la bonne façon de restaurer une clé : ml_dsa87.keygen(seed) régénère
  // exactement la même paire publique+privée, contrairement à l'ancienne
  // fromSecretKey qui générait une paire aléatoire sans rapport.
  static fromSeed(seed) {
    const s = toU8(seed);
    if (s.length !== 32) throw new DilithiumError('Seed must be 32 bytes');
    const { publicKey, secretKey } = ml_dsa87.keygen(s);
    return new Dilithium5KeyPair(new Uint8Array(publicKey), new Uint8Array(secretKey));
  }

  sign(message) { return new Uint8Array(ml_dsa87.sign(this.#secretKey, toU8(message))); }

  static verify(publicKey, message, signature) {
    if (!publicKey || !signature) throw new DilithiumError('Invalid public key or signature');
    const ok = ml_dsa87.verify(toU8(publicKey), toU8(message), toU8(signature));
    if (!ok) throw new DilithiumError('Verification failed');
    return true;
  }

  publicKeyBytes() { return new Uint8Array(this.#publicKey); }
  secretKeyBytes() { return new Uint8Array(this.#secretKey); }
}

export class Dilithium5Signer {
  #keypair; #cachedPublic;
  constructor(keypair = null) {
    this.#keypair      = keypair ?? Dilithium5KeyPair.generate();
    this.#cachedPublic = this.#keypair.publicKeyBytes();
  }

  // Restauration correcte via graine déterministe
  static fromSeed(seed) {
    return new Dilithium5Signer(Dilithium5KeyPair.fromSeed(seed));
  }

  sign(message) { return this.#keypair.sign(message); }
  verify(message, signature) { return Dilithium5KeyPair.verify(this.#cachedPublic, message, signature); }
  publicKeyBytes() { return new Uint8Array(this.#cachedPublic); }
  secretKeyBytes() { return this.#keypair.secretKeyBytes(); }
}
