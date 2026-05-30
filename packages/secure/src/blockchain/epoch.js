// packages/secure/src/blockchain/epoch.js
// =====================================================
// Epoch Manager v6.0 — Gestion des Époques + Rekeying Sécurisé
// SkyAInet × Nikola T369 — Intégration Dilithium5 + Hybrid Crypto
// Version Ultra Améliorée (Production Ready)
// =====================================================

export class EpochError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EpochError';
  }
}

export const EpochStatus = Object.freeze({
  Active: 'Active',
  Rekeying: 'Rekeying',
  Finalizing: 'Finalizing',
});

export class EpochManager {
  constructor(durationSeconds = 3600, rekeyThreshold = 0.66) {
    this.currentEpoch = 0;
    this.epochDuration = durationSeconds;           // en secondes
    this.lastEpochStart = new Date();
    this.status = EpochStatus.Active;
    this.rekeyThreshold = rekeyThreshold;           // ex: 0.66 = 66%
    this.totalRekeyVotes = 0;
    this.minParticipants = 3;                       // Minimum 3 nœuds pour consensus
  }

  /**
   * Vérifie si on doit passer à l'epoch suivant
   */
  shouldAdvanceEpoch() {
    const now = new Date();
    const elapsed = Math.floor((now - this.lastEpochStart) / 1000);
    return elapsed >= this.epochDuration;
  }

  /**
   * Avance à l'epoch suivant (avec rekeying si nécessaire)
   */
  advanceEpoch() {
    if (this.status !== EpochStatus.Active) {
      throw new EpochError('Invalid epoch state');
    }

    this.currentEpoch += 1;
    this.lastEpochStart = new Date();
    this.status = EpochStatus.Rekeying;
    this.totalRekeyVotes = 0;

    console.info(`[EpochManager] Nouvel epoch: ${this.currentEpoch} → Status: Rekeying`);
  }

  /**
   * Enregistre un vote pour le rekeying (consensus-aware)
   */
  voteForRekey(nodeId, totalNodes) {
    if (totalNodes < this.minParticipants) {
      console.warn('[EpochManager] Pas assez de participants pour consensus');
      return false;
    }

    this.totalRekeyVotes += 1;

    const consensusRatio = this.totalRekeyVotes / totalNodes;

    if (consensusRatio >= this.rekeyThreshold) {
      this.status = EpochStatus.Finalizing;
      console.info(
        `[EpochManager] Consensus rekeying atteint (\( {this.totalRekeyVotes}/ \){totalNodes} → ${(consensusRatio * 100).toFixed(1)}%) → Finalizing epoch ${this.currentEpoch}`
      );
      return true;
    } else {
      console.debug(
        `[EpochManager] Vote rekeying: \( {this.totalRekeyVotes}/ \){totalNodes} (${(consensusRatio * 100).toFixed(1)}%)`
      );
      return false;
    }
  }

  /**
   * Finalise l'epoch et effectue le rekeying global (rotation réelle des clés)
   * @param {Array} identities - Tableau d'objets NodeIdentity avec méthode rotatePublicKey()
   */
  finalizeEpoch(identities) {
    if (this.status !== EpochStatus.Finalizing) {
      throw new EpochError('Invalid epoch state');
    }

    let successfulRotations = 0;

    for (const identity of identities) {
      try {
        if (typeof identity.rotatePublicKey === 'function') {
          identity.rotatePublicKey();
          successfulRotations++;
          console.debug(`[EpochManager] Clé rotée avec succès pour ${identity.nodeId || 'unknown'}`);
        } else {
          console.warn('[EpochManager] NodeIdentity sans méthode rotatePublicKey()');
        }
      } catch (e) {
        console.error(`[EpochManager] Échec rotation clé: ${e.message}`);
      }
    }

    if (successfulRotations === 0) {
      throw new EpochError('Key rotation failed: Aucune clé n\'a pu être rotée');
    }

    this.status = EpochStatus.Active;
    this.totalRekeyVotes = 0;

    console.info(
      `[EpochManager] Epoch \( {this.currentEpoch} finalisé → Rekeying terminé ( \){successfulRotations} nœuds sur ${identities.length})`
    );
  }

  /**
   * Retourne le temps restant avant le prochain epoch (en secondes)
   */
  timeUntilNextEpoch() {
    const now = new Date();
    const elapsed = Math.floor((now - this.lastEpochStart) / 1000);
    return Math.max(0, this.epochDuration - elapsed);
  }

  /**
   * Vérifie si on est en période de rekeying
   */
  isRekeyingPeriod() {
    return this.status === EpochStatus.Rekeying || this.status === EpochStatus.Finalizing;
  }
}

export default EpochManager;