// packages/secure/src/blockchain/epoch.js
// =====================================================
// EpochManager — Gestion des Époques + Rekeying Distribué
// Consensus pondéré + rotation Dilithium5 via NodeIdentity
// SkyAInet × Nikola T369
// =====================================================

"use strict";

import { randomBytes } from 'crypto';

// ─────────────────────────────────────────────────────────────────
// ERREUR TYPÉE
// ─────────────────────────────────────────────────────────────────

export class EpochError extends Error {
  constructor(message, code = 'EPOCH_ERROR') {
    super(message);
    this.name = 'EpochError';
    this.code = code;
  }
}

// ─────────────────────────────────────────────────────────────────
// STATUTS
// ─────────────────────────────────────────────────────────────────

export const EpochStatus = Object.freeze({
  Active    : 'Active',
  Rekeying  : 'Rekeying',
  Finalizing: 'Finalizing',
});

// ─────────────────────────────────────────────────────────────────
// EPOCH MANAGER
//
// Cycle de vie d'une epoch :
//   Active → shouldAdvanceEpoch() → advanceEpoch() → Rekeying
//   Rekeying → voteForRekey() × N → Finalizing (si consensus ≥ seuil)
//   Finalizing → finalizeEpoch(identities) → Active
//
// Consensus :
//   votes / totalNodes ≥ rekeyThreshold ET totalNodes ≥ minParticipants
//
// Rekeying :
//   Pour chaque NodeIdentity fourni, génère une nouvelle attestation
//   Dilithium5 via generateAttestation() et met à jour la clé publique.
//   NodeIdentity n'expose pas rotatePublicKey() — on utilise
//   generateAttestation() qui signe un nouveau nonce avec la clé
//   secrète du signer, prouvant la possession sans changer le signer.
//
//   Pour une vraie rotation de clé, l'appelant doit recréer le
//   NodeIdentity avec un nouveau Dilithium5Signer et appeler
//   identity.upgrade() — documenté ci-dessous.
// ─────────────────────────────────────────────────────────────────

export class EpochManager {
  #votes;            // Map<nodeIdHex, boolean> — votes uniques par nœud
  #epochHistory;     // { epoch, startedAt, finalizedAt, rotations }[]
  #startedAt;        // timestamp ms de l'epoch courante

  /**
   * @param {number} durationSeconds  — durée de chaque epoch (défaut 3600 s)
   * @param {number} rekeyThreshold   — fraction de votes requise [0, 1] (défaut 0.66)
   * @param {number} minParticipants  — nœuds minimum pour consensus (défaut 3)
   */
  constructor(durationSeconds = 3_600, rekeyThreshold = 0.66, minParticipants = 3) {
    this.currentEpoch    = 0;
    this.epochDuration   = Math.max(1, durationSeconds);
    this.rekeyThreshold  = Math.max(0, Math.min(1, rekeyThreshold));
    this.minParticipants = Math.max(1, minParticipants);
    this.status          = EpochStatus.Active;

    this.#votes        = new Map();
    this.#epochHistory = [];
    this.#startedAt    = Date.now();
  }

  // ─── Progression de l'epoch ───────────────────────────────────

  shouldAdvanceEpoch() {
    return this.elapsedSeconds() >= this.epochDuration;
  }

  elapsedSeconds() {
    return Math.floor((Date.now() - this.#startedAt) / 1000);
  }

  timeUntilNextEpoch() {
    return Math.max(0, this.epochDuration - this.elapsedSeconds());
  }

  /**
   * Démarre l'epoch suivante et passe en état Rekeying.
   * Lève si la transition est invalide.
   */
  advanceEpoch() {
    if (this.status !== EpochStatus.Active) {
      throw new EpochError(`Transition invalide (état courant: ${this.status})`, 'E_STATE');
    }

    this.currentEpoch++;
    this.#startedAt = Date.now();
    this.status     = EpochStatus.Rekeying;
    this.#votes.clear();

    console.info(`[EpochManager] Epoch ${this.currentEpoch} — état: Rekeying`);
  }

  // ─── Consensus ────────────────────────────────────────────────

  /**
   * Enregistre le vote d'un nœud pour le rekeying.
   * Dédupliqué par nodeId — un nœud ne peut voter qu'une fois par epoch.
   *
   * @param {string|Uint8Array} nodeId
   * @param {number}            totalNodes — nombre total de nœuds actifs
   * @returns {boolean} true si le consensus est atteint
   */
  voteForRekey(nodeId, totalNodes) {
    if (this.status !== EpochStatus.Rekeying) {
      console.warn('[EpochManager] Vote ignoré — pas en période Rekeying');
      return false;
    }
    if (totalNodes < this.minParticipants) {
      console.warn(`[EpochManager] Participants insuffisants (${totalNodes} < ${this.minParticipants})`);
      return false;
    }

    const hex = _toHex(nodeId);
    this.#votes.set(hex, true);   // idempotent

    const ratio = this.#votes.size / totalNodes;
    const consensusReached = ratio >= this.rekeyThreshold;

    if (consensusReached) {
      this.status = EpochStatus.Finalizing;
      console.info(
        `[EpochManager] Consensus atteint : ${this.#votes.size}/${totalNodes}` +
        ` (${(ratio * 100).toFixed(1)}%) → Finalizing epoch ${this.currentEpoch}`
      );
    } else {
      console.debug(
        `[EpochManager] Vote : ${this.#votes.size}/${totalNodes} (${(ratio * 100).toFixed(1)}%)`
      );
    }

    return consensusReached;
  }

  // ─── Finalisation ─────────────────────────────────────────────

  /**
   * Finalise l'epoch en rafraîchissant les attestations Dilithium5
   * de chaque NodeIdentity.
   *
   * API réelle de NodeIdentity (node_types.js) :
   *   identity.generateAttestation() → Attestation signée avec le signer courant
   *
   * Pour une vraie rotation de clé (nouveau Dilithium5Signer), l'appelant
   * doit reconstruire les NodeIdentity avant d'appeler finalizeEpoch().
   *
   * @param {NodeIdentity[]} identities
   * @returns {{ epoch, rotations, failed }}
   */
  finalizeEpoch(identities) {
    if (this.status !== EpochStatus.Finalizing) {
      throw new EpochError(`Finalisation impossible (état: ${this.status})`, 'E_STATE');
    }
    if (!Array.isArray(identities) || identities.length === 0) {
      throw new EpochError('Au moins une identité requise pour finaliser', 'E_INPUT');
    }

    let rotations = 0;
    let failed    = 0;

    for (const identity of identities) {
      if (!identity) continue;
      try {
        // generateAttestation() : re-signe un nouveau nonce avec Dilithium5
        // → prouve la possession de la clé + fraîcheur de l'attestation
        if (typeof identity.generateAttestation === 'function') {
          identity.generateAttestation();
          rotations++;
          const id = identity.nodeIdHex?.()?.slice(0, 16) ?? 'unknown';
          console.debug(`[EpochManager] Attestation renouvelée : ${id}`);
        } else {
          console.warn('[EpochManager] Identité sans generateAttestation() — ignorée');
          failed++;
        }
      } catch (e) {
        console.error(`[EpochManager] Échec attestation : ${e.message}`);
        failed++;
      }
    }

    if (rotations === 0) {
      throw new EpochError('Aucune attestation n\'a pu être renouvelée', 'E_ROTATION');
    }

    // Archiver l'epoch
    this.#epochHistory.push({
      epoch      : this.currentEpoch,
      startedAt  : this.#startedAt,
      finalizedAt: Date.now(),
      rotations,
      failed,
    });

    this.status = EpochStatus.Active;
    this.#votes.clear();

    console.info(
      `[EpochManager] Epoch ${this.currentEpoch} finalisé — ` +
      `${rotations} attestations renouvelées, ${failed} échecs`
    );

    return { epoch: this.currentEpoch, rotations, failed };
  }

  // ─── Accesseurs ───────────────────────────────────────────────

  isRekeyingPeriod() {
    return this.status === EpochStatus.Rekeying || this.status === EpochStatus.Finalizing;
  }

  get voteCount() { return this.#votes.size; }

  getHistory(limit = 10) {
    return this.#epochHistory.slice(-limit);
  }

  stats() {
    return {
      currentEpoch   : this.currentEpoch,
      status         : this.status,
      elapsedSeconds : this.elapsedSeconds(),
      timeUntilNext  : this.timeUntilNextEpoch(),
      votes          : this.#votes.size,
      epochDuration  : this.epochDuration,
      rekeyThreshold : this.rekeyThreshold,
      minParticipants: this.minParticipants,
      totalEpochs    : this.#epochHistory.length,
    };
  }
}

export default EpochManager;

// ─────────────────────────────────────────────────────────────────
// HELPER INTERNE
// ─────────────────────────────────────────────────────────────────

function _toHex(nodeId) {
  if (typeof nodeId === 'string') return nodeId.toLowerCase();
  return Array.from(nodeId).map(b => b.toString(16).padStart(2, '0')).join('');
}
