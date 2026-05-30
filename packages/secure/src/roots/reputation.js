// packages/secure/src/roots/reputation.js
// =====================================================
// PeerReputation — Système de Réputation Avancé
// Compatible Contact + DID + RomanT369 + GroupManager
// DiamantRoots v2 — Évaluation Dynamique des Nœuds
// SkyAInet × Nikola T369
// =====================================================

import { Contact } from '../contacts/contact.js';
import { ContactManager } from '../contacts/manager.js';

export class ReputationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReputationError';
  }
}

export class PeerReputation {
  constructor() {
    this.score = 0.65;
    this.lastUpdated = Date.now();
    this.history = [];              // max 10 dernières mises à jour
    this.successfulInteractions = 0;
    this.failedInteractions = 0;
    this.contactId = null;          // [u8; 32] → string hex ou Uint8Array
  }

  withContact(contactId) {
    this.contactId = contactId;
    return this;
  }

  /**
   * Met à jour le score de réputation
   */
  update(delta) {
    const newScore = Math.max(0, Math.min(1, this.score + delta));

    if (Math.abs(newScore - this.score) < 0.001) {
      return;
    }

    this.history.push(this.score);
    if (this.history.length > 10) {
      this.history.shift();
    }

    this.score = newScore;
    this.lastUpdated = Date.now();

    console.debug(
      `[Reputation] Score mis à jour : ${(this.score - delta).toFixed(3)} → ${this.score.toFixed(3)} (delta: \( {delta >= 0 ? '+' : ''} \){delta.toFixed(3)})`
    );
  }

  /**
   * Enregistre une interaction réussie (bonus DID)
   */
  recordSuccess(impact = 0.05, contact = null) {
    this.successfulInteractions++;

    let finalImpact = Math.max(0.01, impact);

    if (contact && contact.hasDecentralizedIdentity && contact.verificationLevel >= 2) {
      finalImpact *= 1.15; // +15% bonus
    }

    this.update(finalImpact);
  }

  /**
   * Enregistre une interaction échouée
   */
  recordFailure(impact = 0.05) {
    this.failedInteractions++;
    this.update(-Math.max(0.01, Math.abs(impact)));
  }

  /**
   * Décroissance naturelle (anti-inactivité)
   */
  applyDecay(decayRate = 0.995) {
    if (this.score > 0.3) {
      this.score = Math.max(0, Math.min(1, this.score * decayRate));
    }
  }

  /**
   * Niveau de réputation
   */
  tier() {
    return ReputationTier.fromScore(this.score);
  }

  /**
   * Score pondéré (70% actuel + 30% historique)
   */
  weightedScore() {
    if (this.history.length === 0) return this.score;

    const avgHistory = this.history.reduce((a, b) => a + b, 0) / this.history.length;
    return (this.score * 0.7) + (avgHistory * 0.3);
  }

  /**
   * Vérifie si le nœud est considéré comme fiable
   */
  isTrusted(contactManager = null) {
    const baseTrust = this.score >= 0.75 && this.successfulInteractions > 5;

    if (contactManager && this.contactId) {
      const contact = contactManager.get(this.contactId);
      if (contact) {
        return baseTrust && contact.hasDecentralizedIdentity();
      }
    }

    return baseTrust;
  }
}

/**
 * Niveaux de réputation
 */
export const ReputationTier = {
  Newcomer: 'Newcomer',
  Reliable: 'Reliable',
  Trusted: 'Trusted',
  Elite: 'Elite',
  Legendary: 'Legendary',

  fromScore(score) {
    if (score >= 0.92) return this.Legendary;
    if (score >= 0.82) return this.Elite;
    if (score >= 0.70) return this.Trusted;
    if (score >= 0.55) return this.Reliable;
    return this.Newcomer;
  }
};