// packages/node/src/validator.js
// =====================================================
// ValidatorNode — Nœud de Validation Souverain
// SkyAInet – Staking + Consensus Avancé + PoUW + Réputation Dynamique
// Intégré avec Rewards, Dream Cycle, ZipMemory & Governance
// =====================================================

import { NodeCapabilities, NodeState, SubscriptionLevel, NodeType } from '../../core/src/node_types.js';
import { ContributionProof } from './pouw.js';
import { UserRewards, RewardReason } from '../../core/src/rewards.js';
import { ZipMemory } from '../../memory/src/zip_memory.js';

export class ValidatorNode {
  /**
   * @param {string} sovereignAlias
   * @param {number} initialStake - en SKY
   */
  constructor(sovereignAlias, initialStake) {
    // Génération d'un UUID simple (crypto.randomUUID si disponible)
    const uuid = globalThis.crypto?.randomUUID
      ? crypto.randomUUID()
      : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
          const r = (Math.random() * 16) | 0;
          return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
        });

    this.nodeId = `val-${uuid}`;
    this.sovereignAlias = sovereignAlias;
    this.capabilities = new NodeCapabilities(SubscriptionLevel.Validator);
    this.capabilities.computePower = 0.97;
    this.capabilities.validationPower = 1.0;
    this.capabilities.bandwidth = 0.92;

    this.currentState = NodeState.Active;
    this.stakeAmount = initialStake;
    this.lockedUntil = null; // Date | null
    this.reputation = 0.78;    // 0.0 → 1.0
    this.validatedContributions = 0;
    this.failedValidations = 0;
    this.lastValidation = Date.now(); // timestamp en ms
    this.totalValidationScore = 0.0;
    this.consecutiveSuccess = 0;
    this.slashCount = 0;

    // Cache ZipMemory
    this.validationCache = new ZipMemory(`./data/validator/${sovereignAlias}_cache`);
  }

  /**
   * Validation avancée avec scoring intelligent + ZipMemory
   * @param {ContributionProof} proof
   * @param {UserRewards} rewards
   * @returns {Promise<boolean>}
   */
  async validateContribution(proof, rewards) {
    if (this.stakeAmount < 8000) {
      throw new Error('Stake insuffisant pour valider (minimum 8000 SKY)');
    }

    const baseScore = proof.score;
    const reputationMultiplier = Math.min(1.2, Math.max(0.4, this.reputation));
    const finalScore = baseScore * reputationMultiplier;

    const isValid = finalScore >= 0.82 && this.reputation > 0.62;

    if (isValid) {
      this.validatedContributions += 1;
      this.consecutiveSuccess += 1;
      const boost = 0.018 * (this.consecutiveSuccess / 10);
      this.reputation = Math.min(0.995, this.reputation + boost);
      this.totalValidationScore += finalScore;
      this.lastValidation = Date.now();

      // Récompense légère
      rewards.addReward(RewardReason.Validation, 8);

      // Stockage dans le cache ZipMemory
      if (this.validationCache) {
        await this.validationCache.saveCompressed(proof.proofId, proof.data);
      }

      console.debug(`[Validator] Contribution validée avec score ${finalScore.toFixed(3)}`);
    } else {
      this.failedValidations += 1;
      this.consecutiveSuccess = 0;
      this.reputation = Math.max(0.25, this.reputation - 0.035);
      this.slash(0.08);
      console.warn(`[Validator] Contribution rejetée (score ${finalScore.toFixed(3)})`);
    }

    return isValid;
  }

  /**
   * Participation au consensus avec poids dynamique
   * @param {number} proposalWeight
   * @returns {number}
   */
  participateInConsensus(proposalWeight) {
    const stakeFactor = Math.min(8.0, this.stakeAmount / 10000.0);
    const repFactor = this.reputation;
    return Math.min(120.0, proposalWeight * stakeFactor * repFactor * 0.75);
  }

  /**
   * Slashing intelligent avec impact sur la gouvernance
   * @param {number} percentage - entre 0 et 1
   */
  slash(percentage) {
    const maxSlash = this.stakeAmount * 0.25;
    const slashAmount = Math.min(maxSlash, this.stakeAmount * percentage);
    this.stakeAmount -= slashAmount;
    if (this.stakeAmount < 0) this.stakeAmount = 0;
    this.reputation = Math.max(0.18, this.reputation - 0.12);
    this.slashCount += 1;

    if (this.slashCount >= 5) {
      this.currentState = NodeState.Sleeping;
      console.warn('[Validator] Nœud mis en veille après multiples slashes');
    }
  }

  /**
   * Vérifie l'éligibilité pour la gouvernance
   * @returns {boolean}
   */
  isEligibleForGovernance() {
    return (
      this.stakeAmount >= 15000 &&
      this.reputation >= 0.85 &&
      this.consecutiveSuccess >= 12
    );
  }

  /**
   * Retourne le type de nœud
   * @returns {string} NodeType.Validator
   */
  getNodeType() {
    return NodeType.Validator;
  }

  /**
   * Rapport complet pour monitoring
   * @returns {string}
   */
  healthReport() {
    return (
      `Validator ${this.sovereignAlias} | ` +
      `Stake: ${this.stakeAmount} SKY | ` +
      `Rep: ${this.reputation.toFixed(3)} | ` +
      `Validated: ${this.validatedContributions} | ` +
      `Failed: ${this.failedValidations} | ` +
      `Consecutive: ${this.consecutiveSuccess} | ` +
      `State: ${this.currentState}`
    );
  }
}