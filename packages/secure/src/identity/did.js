// packages/secure/src/identity/did.js
// =====================================================
// DID (Decentralized Identifier) t369
// SkyAInet × Nikola T369 — DID Core + Dilithium + Contact Integration
// =====================================================

import { Dilithium5Signer } from '../crypto/dilithium.js';

export class DidError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DidError';
  }
}

export const ServiceType = Object.freeze({
  Messaging: 'Messaging',
  Storage: 'Storage',
  Compute: 'Compute',
  Discovery: 'Discovery',
  Custom: (name) => `Custom(${name})`,
});

export class ServiceEndpoint {
  constructor(id, type, serviceEndpoint, priority = 0) {
    this.id = id;
    this.type = type;
    this.serviceEndpoint = serviceEndpoint;
    this.priority = priority;
    this.createdAt = Math.floor(Date.now() / 1000);
  }
}

export class Did {
  constructor(publicKey) {
    if (!publicKey || publicKey.length !== 32) {
      throw new DidError('Invalid public key length');
    }

    const id = `did:t369:${this.#toHex(publicKey.slice(0, 16))}`;
    const now = Math.floor(Date.now() / 1000);

    this.id = id;
    this.publicKey = new Uint8Array(publicKey);
    this.authentication = ['Dilithium5VerificationKey2020'];
    this.service = [];
    this.createdAt = now;
    this.updatedAt = now;
    this.revoked = false;
    this.revocationReason = null;

    console.info(`[DID] Nouveau DID créé : ${id}`);
  }

  static fromDilithiumKey(dilithiumPublicKey) {
    return new Did(dilithiumPublicKey);
  }

  addService(id, serviceType, endpoint, priority = 0) {
    const service = new ServiceEndpoint(id, serviceType, endpoint, priority);
    this.service.push(service);
    this.updatedAt = Math.floor(Date.now() / 1000);

    console.debug(`[DID] Service ajouté à ${this.id}`);
  }

  removeService(serviceId) {
    const before = this.service.length;
    this.service = this.service.filter(s => s.id !== serviceId);

    if (this.service.length === before) {
      throw new DidError('Service endpoint not found');
    }

    this.updatedAt = Math.floor(Date.now() / 1000);
    console.debug(`[DID] Service ${serviceId} supprimé de ${this.id}`);
  }

  revoke(reason) {
    this.revoked = true;
    this.revocationReason = reason;
    this.updatedAt = Math.floor(Date.now() / 1000);

    console.warn(`[DID] DID révoqué : ${this.id} (raison: ${reason})`);
  }

  verifyWithDilithium(message, signature, dilithiumSigner) {
    if (this.revoked) {
      throw new DidError('DID is revoked');
    }

    try {
      const isValid = dilithiumSigner.verify(message, signature);
      if (isValid) {
        console.debug(`[DID] Signature Dilithium vérifiée pour ${this.id}`);
        return true;
      } else {
        throw new DidError('Dilithium verification failed');
      }
    } catch (e) {
      throw new DidError(`Dilithium error: ${e.message}`);
    }
  }

  toDidDocument() {
    return JSON.stringify(this, null, 2);
  }

  toShortString() {
    return this.id;
  }

  rotatePublicKey(newPublicKey) {
    if (!newPublicKey || newPublicKey.length !== 32) {
      throw new DidError('Invalid public key length');
    }

    this.publicKey = new Uint8Array(newPublicKey);
    this.updatedAt = Math.floor(Date.now() / 1000);
    this.id = `did:t369:${this.#toHex(newPublicKey.slice(0, 16))}`;

    console.info(`[DID] Rotation de clé effectuée pour ${this.id}`);
  }

  #toHex(bytes) {
    return Array.from(bytes)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }
}

// DID de test (ne jamais utiliser en production)
export const TEST_DID = new Did(new Uint8Array(32));
