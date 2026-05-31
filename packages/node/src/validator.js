// packages/node/src/validator.js
// =====================================================
// ValidatorNode — Nœud de Validation Souverain
// Staking + Consensus Avancé + PoUW + Réputation Dynamique
// Intégré avec Rewards, Dream Cycle, ZipMemory & Governance
// =====================================================

import { ZipMemory } from '../../memory/src/zip_memory.js';

export class ValidatorNode {
  constructor(sovereignAlias, initialStake = 10000) {
    this.nodeId = `val-${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    this.sovereignAlias = sovereignAlias;
    this.capabilities = {
      computePower: 0.97,
      validationPower: 1.0,
      bandwidth: 0.92,
    };
    this.currentState = 'Active';

    // === Économie & Staking ===
    this.stakeAmount = initialStake;
    this.lockedUntil = null;
    this.reputation = 0.78;
    this.validatedContributions = 0;
    this.failedValidations = 0;
    this.lastValidation = Date.now();

    // === Performance & Historique ===
    this.totalValidationScore = 0.0;
    this.consecutiveSuccess = 0;
    this.slashCount = 0;

    // === ZipMemory Cache ===
    this.validationCache = new ZipMemory(`./data/validator/${sovereignAlias}_cache`);
  }

  // =====================================================
  // VALIDATION AVANCÉE
  // =====================================================
  async validateContribution(proof, rewards) {
    if (this.stakeAmount < 8000) {
      throw new Error('Stake insuffisant pour valider (minimum 8000 SKY)');
    }

    const baseScore = proof.score || 0.75;
    const reputationMultiplier = Math.max(0.4, Math.min(1.2, this.reputation));
    const finalScore = baseScore * reputationMultiplier;

    const isValid = finalScore >= 0.82 && this.reputation > 0.62;

    if (isValid) {
      this.validatedContributions++;
      this.consecutiveSuccess++;
      this.reputation = Math.min(0.995, this.reputation + 0.018 * (this.consecutiveSuccess / 10));
      this.totalValidationScore += finalScore;
      this.lastValidation = Date.now();

      // Récompense
      if (rewards && typeof rewards.addReward === 'function') {
        rewards.addReward('Validation', 8);
      }

      // Cache ZipMemory
      try {
        await this.validationCache.store(proof.proofId, proof.data);
      } catch (_) {}

      console.debug(`[Validator] Contribution validée avec score ${finalScore.toFixed(3)}`);
    } else {
      this.failedValidations++;
      this.consecutiveSuccess = 0;
      this.reputation = Math.max(0.25, this.reputation - 0.035);
      this.slash(0.08);
      console.warn(`[Validator] Contribution rejetée (score ${finalScore.toFixed(3)})`);
    }

    return isValid;
  }

  // =====================================================
  // CONSENSUS
  // =====================================================
  participateInConsensus(proposalWeight = 1.0) {
    const stakeFactor = Math.min(this.stakeAmount / 10000, 8.0);
    const repFactor = this.reputation;
    return Math.min(proposalWeight * stakeFactor * repFactor * 0.75, 120.0);
  }

  // =====================================================
  // SLASHING & ÉTAT
  // =====================================================
  slash(percentage) {
    const slashAmount = Math.min(this.stakeAmount * percentage, this.stakeAmount * 0.25);
    this.stakeAmount = Math.max(0, Math.floor(this.stakeAmount - slashAmount));
    this.reputation = Math.max(0.18, this.reputation - 0.12);
    this.slashCount++;

    if (this.slashCount >= 5) {
      this.currentState = 'Sleeping';
      console.warn('[Validator] Nœud mis en veille après multiples slashes');
    }
  }

  isEligibleForGovernance() {
    return this.stakeAmount >= 15000 && this.reputation >= 0.85 && this.consecutiveSuccess >= 12;
  }

  getNodeType() {
    return 'Validator';
  }

  // =====================================================
  // RAPPORT & MONITORING
  // =====================================================
  healthReport() {
    return `Validator ${this.sovereignAlias} | Stake: ${this.stakeAmount} SKY | Rep: ${this.reputation.toFixed(3)} | Validated: ${this.validatedContributions} | Failed: ${this.failedValidations} | Consecutive: ${this.consecutiveSuccess} | State: ${this.currentState}`;
  }
}

export default ValidatorNode;