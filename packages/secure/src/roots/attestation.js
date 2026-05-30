// packages/secure/src/roots/attestation.js
// =====================================================
// Node Attestation — Dilithium5 + Timestamp + DID
// Compatible Contact + DID + RomanT369 + GroupManager
// DiamantRoots v2 — Preuve d’Identité Post-Quantique
// SkyAInet × Nikola T369
// =====================================================

import { Dilithium5Signer } from '../crypto/dilithium.js';
import { Contact } from '../contacts/contact.js';
import { ContactManager } from '../contacts/manager.js';

export class AttestationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AttestationError';
  }
}

export class NodeAttestation {
  constructor(nodeId, publicKey, signature, timestamp, epoch, did = null) {
    this.nodeId = nodeId;           // Uint8Array(32)
    this.publicKey = publicKey;     // Uint8Array
    this.signature = signature;     // Uint8Array
    this.timestamp = timestamp;     // seconds
    this.epoch = epoch;
    this.did = did;                 // string | null
  }

  /**
   * Vérifie l’attestation avec Dilithium5 + DID (si présent)
   */
  verify(signer, contactManager = null) {
    const now = Math.floor(Date.now() / 1000);

    // Vérification expiration (24h)
    if (now - this.timestamp > 86400) {
      throw new AttestationError('Attestation expired');
    }

    // Vérification Dilithium5
    try {
      signer.verify(this.publicKey, this.signature);
    } catch (e) {
      console.warn(`[Attestation] Échec de vérification pour le nœud ${this.#shortId()}`);
      throw new AttestationError(`Dilithium verification failed: ${e.message}`);
    }

    // Vérification DID si ContactManager fourni
    if (contactManager && this.did) {
      const contact = contactManager.get(this.nodeId);
      if (contact) {
        if (!contact.hasDecentralizedIdentity() || contact.verificationLevel < 2) {
          throw new AttestationError('Contact not verified (DID required)');
        }
      }
    }

    console.debug(`[Attestation] Nœud ${this.#shortId()} attesté avec succès`);
    return true;
  }

  /**
   * Crée une nouvelle attestation (côté nœud)
   */
  static create(nodeId, publicKey, signature, epoch, contact = null) {
    const timestamp = Math.floor(Date.now() / 1000);
    const did = contact ? contact.getDidString?.() || null : null;

    return new NodeAttestation(nodeId, publicKey, signature, timestamp, epoch, did);
  }

  #shortId() {
    if (!this.nodeId) return 'unknown';
    return Array.from(this.nodeId.slice(0, 8))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }
}