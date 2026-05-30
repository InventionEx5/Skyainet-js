// packages/sentinel/src/anti_fork.js
// =====================================================
// AntiFork — Système Anti‑Fork & Auto‑Défense Avancé
// SkyAInet – Détection par hauteur, hash, réputation + Actions automatiques (Slash, Quarantine)
// Intégré avec Rewards, NodeIdentity et Reputation System
// =====================================================

import { UserRewards, RewardReason } from '../../core/src/rewards.js';
import { SkyAInetNode } from '../../node/src/node.js';
import { Dilithium5Signer } from '../../secure/src/crypto/dilithium.js';

// ----------------------------------------------------------------------
// Niveaux de gravité d’un fork
// ----------------------------------------------------------------------
export const ForkSeverity = Object.freeze({
  Warning:  'Warning',
  Minor:    'Minor',
  Major:    'Major',
  Critical: 'Critical',
});

// ----------------------------------------------------------------------
// Événement de fork détecté
// ----------------------------------------------------------------------
export class ForkEvent {
  /**
   * @param {Date} timestamp
   * @param {string} severity - clé de ForkSeverity
   * @param {string} description
   * @param {Array<string>} affectedNodes
   * @param {string} evidence
   */
  constructor(timestamp, severity, description, affectedNodes, evidence) {
    this.timestamp = timestamp;
    this.severity = severity;
    this.description = description;
    this.affectedNodes = affectedNodes;
    this.evidence = evidence;
  }

  toJSON() {
    return {
      timestamp: this.timestamp.toISOString(),
      severity: this.severity,
      description: this.description,
      affectedNodes: this.affectedNodes,
      evidence: this.evidence,
    };
  }

  static fromJSON(json) {
    return new ForkEvent(
      new Date(json.timestamp),
      json.severity,
      json.description,
      json.affectedNodes,
      json.evidence,
    );
  }
}

// ----------------------------------------------------------------------
// Système Anti‑Fork
// ----------------------------------------------------------------------
export class AntiFork {
  constructor() {
    this.forkThresholdHeight = 5;
    this.forkThresholdHash = 2; // nombre de mismatchs tolérés (non utilisé directement dans detect)
    this.events = []; // Array<ForkEvent>
    this.quarantinedNodes = new Map(); // Map<peerId, Date>
    this.signer = new Dilithium5Signer(); // signeur post‑quantique pour preuves futures
  }

  /**
   * Détection avancée de fork.
   * @param {number} localHeight
   * @param {string} localHash
   * @param {Array<{peerId: string, height: number, hash: string, reputation: number}>} peers
   * @param {SkyAInetNode} node – mutable, pour mise en quarantaine immédiate
   * @param {UserRewards} rewards – mutable, pour récompense de détection
   * @returns {Array<ForkEvent>}
   */
  detectFork(localHeight, localHash, peers, node, rewards) {
    const detected = [];

    for (const { peerId, height, hash, reputation } of peers) {
      // 1. Écart de hauteur suspect
      const heightDiff = height - localHeight;
      if (heightDiff > this.forkThresholdHeight) {
        const event = new ForkEvent(
          new Date(),
          ForkSeverity.Major,
          `Fork par hauteur détecté avec le pair ${peerId}`,
          [peerId],
          `Height diff: ${heightDiff}`,
        );
        detected.push(event);
        this.quarantineNode(peerId, node);
      }

      // 2. Mismatch de hash (si le pair est réputé)
      if (hash !== localHash && reputation > 0.6) {
        const event = new ForkEvent(
          new Date(),
          ForkSeverity.Critical,
          `Mismatch de hash avec le pair ${peerId}`,
          [peerId],
          `Local: ${localHash} | Peer: ${hash}`,
        );
        detected.push(event);
        this.quarantineNode(peerId, node);
      }
    }

    if (detected.length > 0) {
      this.events.push(...detected);
      console.warn(`[AntiFork] ${detected.length} fork(s) détecté(s)`);

      // Récompense de contribution à la sécurité
      rewards.addReward(RewardReason.SecurityContribution, 35);
    }

    return detected;
  }

  /**
   * Met un nœud en quarantaine et réduit sa réputation.
   * @param {string} peerId
   * @param {SkyAInetNode} node
   */
  quarantineNode(peerId, node) {
    this.quarantinedNodes.set(peerId, new Date());
    node.metadata.reputationScore = Math.max(0.1, node.metadata.reputationScore - 0.25);
    console.warn(`[AntiFork] Nœud ${peerId} mis en quarantaine`);
  }

  /**
   * Vérifie si un pair est en quarantaine.
   * @param {string} peerId
   * @returns {boolean}
   */
  isQuarantined(peerId) {
    return this.quarantinedNodes.has(peerId);
  }

  /**
   * Retourne la liste complète des événements.
   * @returns {Array<ForkEvent>}
   */
  getEvents() {
    return this.events;
  }

  /**
   * Résumé de l'état du système anti‑fork.
   * @returns {string}
   */
  summary() {
    return (
      `AntiFork | Events: ${this.events.length} | ` +
      `Quarantined: ${this.quarantinedNodes.size} | ` +
      `Threshold Height: ${this.forkThresholdHeight}`
    );
  }
}