// packages/secure/src/transport/trait.js
// =====================================================
// Universal Transport Trait — Gematria Flash Core
// Compatible Contact + DID + RomanT369 + GroupManager
// SkyAInet × Nikola T369
// =====================================================

import { HybridMode } from '../crypto/hybrid.js';
import { Contact } from '../contacts/contact.js';

export const TransportLayer = Object.freeze({
  Core: 'Core',   // Cœur du réseau (libp2p)
  Edge: 'Edge',   // Extrémités (WebRTC, Mobile, Navigateur)
});

export const CryptoSuite = Object.freeze({
  BinaryXChaCha20Poly1305: 'BinaryXChaCha20Poly1305',
  Gematria95: 'Gematria95',
  HybridFlash: 'HybridFlash',
  PostQuantumHybrid: 'PostQuantumHybrid',
});

export class TransportError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TransportError';
  }
}

/**
 * Interface de base pour tous les transports
 * (à implémenter par les classes concrètes)
 */
export class Transport {
  /**
   * Envoi de données (utilise le mode courant)
   * @param {string} addr - Adresse (host:port)
   * @param {Uint8Array} data
   * @returns {Promise<void>}
   */
  async send(addr, data) {
    throw new TransportError('Not implemented');
  }

  /**
   * Réception de données
   * @returns {Promise<[string, Uint8Array]>} [addr, data]
   */
  async recv() {
    throw new TransportError('Not implemented');
  }

  async start() {
    throw new TransportError('Not implemented');
  }

  async stop() {
    throw new TransportError('Not implemented');
  }

  localAddr() {
    return null;
  }

  cryptoMode() {
    return CryptoSuite.PostQuantumHybrid;
  }

  layer() {
    return TransportLayer.Core;
  }

  // === Méthodes optionnelles (Hybrid) ===

  async setHybridMode(mode) {
    throw new TransportError('InvalidModeForLayer');
  }

  supportsFlashGematria() {
    return false;
  }

  currentHybridMode() {
    return null;
  }
}

/**
 * Extension pour les transports qui supportent le mode hybride
 */
export class HybridTransport extends Transport {
  /**
   * Envoi avec un mode hybride spécifique
   * @param {string} addr
   * @param {Uint8Array} data
   * @param {string} mode - HybridMode
   * @param {Contact|null} contact
   */
  async sendWithMode(addr, data, mode, contact = null) {
    throw new TransportError('Not implemented');
  }

  async forceFlashGematria() {
    throw new TransportError('Not implemented');
  }
}