// packages/secure/src/transport/trait.js
// =====================================================
// Universal Transport Trait — Gematria Flash Core
// SkyAInet × Nikola T369
// =====================================================

"use strict";

import { HybridMode } from '../crypto/hybrid.js';

// ─────────────────────────────────────────────────────────────────
// COUCHES ET SUITES CRYPTO
// ─────────────────────────────────────────────────────────────────

export const TransportLayer = Object.freeze({
  Core: 'Core',   // Cœur du réseau (libp2p, TCP)
  Edge: 'Edge',   // Extrémités (WebRTC, Mobile, Navigateur)
  Relay: 'Relay', // Relais intermédiaire
});

export const CryptoSuite = Object.freeze({
  Gematria95       : 'Gematria95',
  HybridFlash      : 'HybridFlash',
  PostQuantumHybrid: 'PostQuantumHybrid',
  FullGematria     : 'FullGematria',
});

// ─────────────────────────────────────────────────────────────────
// ERREUR TYPÉE
// ─────────────────────────────────────────────────────────────────

export class TransportError extends Error {
  constructor(message, code = 'TRANSPORT_ERROR') {
    super(message);
    this.name = 'TransportError';
    this.code = code;
  }
}

// ─────────────────────────────────────────────────────────────────
// MESSAGE DE TRANSPORT
// ─────────────────────────────────────────────────────────────────

export class TransportMessage {
  constructor(from, payload, topic = 'skyainet/messages/v1', mode = null) {
    this.id        = `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    this.from      = from;
    this.payload   = payload;   // Uint8Array chiffré
    this.topic     = topic;
    this.mode      = mode;      // HybridMode utilisé | null
    this.timestamp = Date.now();
  }
}

// ─────────────────────────────────────────────────────────────────
// TRANSPORT — INTERFACE DE BASE
//
// Toutes les implémentations concrètes étendent cette classe.
// Les méthodes non surchargées lancent une TransportError explicite
// plutôt que de retourner silencieusement undefined.
// ─────────────────────────────────────────────────────────────────

export class Transport {
  /**
   * Démarre le transport (bind port, handshakes initiaux, etc.).
   * @returns {Promise<void>}
   */
  async start() {
    throw new TransportError('start() non implémenté', 'NOT_IMPLEMENTED');
  }

  /**
   * Arrête proprement le transport.
   * @returns {Promise<void>}
   */
  async stop() {
    throw new TransportError('stop() non implémenté', 'NOT_IMPLEMENTED');
  }

  /**
   * Envoie des données chiffrées à une adresse.
   * @param {string}     addr  — "host:port" ou peerId
   * @param {Uint8Array} data  — payload clair (le transport chiffre)
   * @returns {Promise<void>}
   */
  async send(addr, data) {
    throw new TransportError('send() non implémenté', 'NOT_IMPLEMENTED');
  }

  /**
   * Reçoit le prochain message disponible.
   * @returns {Promise<TransportMessage>}
   */
  async recv() {
    throw new TransportError('recv() non implémenté', 'NOT_IMPLEMENTED');
  }

  /**
   * Retourne l'adresse locale d'écoute, ou null si non démarré.
   * @returns {string|null}
   */
  localAddr() { return null; }

  /**
   * Suite cryptographique utilisée par ce transport.
   * @returns {string} — CryptoSuite.*
   */
  cryptoMode() { return CryptoSuite.PostQuantumHybrid; }

  /**
   * Couche réseau de ce transport.
   * @returns {string} — TransportLayer.*
   */
  layer() { return TransportLayer.Core; }

  /**
   * Retourne true si le transport supporte le mode Flash Gematria.
   * Les sous-classes qui l'implémentent doivent surcharger cette méthode.
   */
  supportsFlashGematria() { return false; }

  // ─── Méthodes optionnelles (mode hybride) ───────────────────

  /**
   * Bascule le mode hybride du transport.
   * @param {string} mode — HybridMode.*
   */
  async setHybridMode(mode) {
    throw new TransportError('setHybridMode() non supporté par ce transport', 'UNSUPPORTED');
  }

  /**
   * Retourne le mode hybride courant, ou null si non applicable.
   * @returns {string|null}
   */
  currentHybridMode() { return null; }
}

// ─────────────────────────────────────────────────────────────────
// HYBRID TRANSPORT TRAIT
//
// Extension de Transport pour les implémentations qui supportent
// le mode hybride KEM + Gematria. Ajoute sendWithMode() et
// forceFlashGematria() comme points d'extension obligatoires.
// ─────────────────────────────────────────────────────────────────

export class HybridTransportTrait extends Transport {
  supportsFlashGematria() { return true; }

  /**
   * Envoi avec un mode hybride explicite.
   * @param {string}      addr
   * @param {Uint8Array}  data
   * @param {string}      mode    — HybridMode.*
   * @param {object|null} contact — Contact (pool.js) pour filtrage DID
   * @returns {Promise<void>}
   */
  async sendWithMode(addr, data, mode, contact = null) {
    throw new TransportError('sendWithMode() non implémenté', 'NOT_IMPLEMENTED');
  }

  /**
   * Force une transition Flash Gematria immédiate.
   * @returns {Promise<void>}
   */
  async forceFlashGematria() {
    return this.setHybridMode(HybridMode.FlashGematria);
  }

  cryptoMode()       { return CryptoSuite.HybridFlash; }
  currentHybridMode() { return HybridMode.KemT369Core; }
}
