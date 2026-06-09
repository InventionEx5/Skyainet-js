// packages/node/src/validator.js
// =====================================================
// ValidatorNode — Nœud de Validation Souverain
// Staking + Consensus + PoUW + Slashing + Gouvernance
// SkyAInet × Nikola T369
// =====================================================

"use strict";

import { randomUUID }          from 'crypto';
import { ZipMemory }           from '../../memory/src/zip_memory.js';
import { UserRewards }         from '../../core/src/rewards.js';
import { ContributionProof }   from './pouw.js';
import { NodeState, reputationTierFromScore } from '../../node/src/node_types.js';

// ─────────────────────────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────────────────────────

const MIN_STAKE_VALIDATE    = 8_000;    // SKY requis pour valider
const MIN_STAKE_GOVERNANCE  = 15_000;   // SKY requis pour voter
const MIN_REP_VALIDATE      = 0.62;
const MIN_REP_GOVERNANCE    = 0.85;
const MIN_CONSEC_GOVERNANCE = 12;       // succès consécutifs requis
const MAX_SLASH_EVENTS      = 5;        // avant mise en veille automatique
const MAX_SLASH_PER_EVENT   = 0.25;     // plafond à 25 % du stake
const REP_FLOOR             = 0.18;
const REP_CAP               = 0.995;
const VALIDATION_THRESHOLD  = 0.82;     // score effectif minimum
const REWARD_PER_VALIDATION = 8;        // SKY par validation réussie
const CONSENSUS_STAKE_MAX   = 8.0;      // plafond du facteur stake
const CONSENSUS_VOTE_MAX    = 120.0;    // poids de vote maximum

// ─────────────────────────────────────────────────────────────────
// VALIDATOR NODE
// ─────────────────────────────────────────────────────────────────

export class ValidatorNode {
  #validationCache;   // ZipMemory — persistance légère des preuves validées
  #history;           // { proofHash, score, valid, ts }[] — anneau de 512

  constructor(sovereignAlias, initialStake = 10_000) {
    if (!sovereignAlias?.trim()) throw new Error('sovereignAlias requis');

    this.nodeId         = `val-${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    this.sovereignAlias = sovereignAlias.trim();
    this.currentState   = NodeState.Active;

    // Capacités
    this.capabilities = {
      computePower   : 0.97,
      validationPower: 1.00,
      bandwidth      : 0.92,
    };

    // Économie & staking
    this.stakeAmount = Math.max(0, initialStake);
    this.lockedUntil = null;   // timestamp de déverrouillage (null = libre)

    // Réputation & performance
    this.reputation             = 0.78;
    this.validatedContributions = 0;
    this.failedValidations      = 0;
    this.totalValidationScore   = 0;
    this.consecutiveSuccess     = 0;
    this.slashCount             = 0;
    this.lastValidation         = Date.now();
    this.createdAt              = Date.now();

    // Persistance
    this.#validationCache = new ZipMemory(`./data/validator/${this.sovereignAlias}_cache`);
    this.#history         = [];
  }

  // ─── Validation ───────────────────────────────────────────────

  /**
   * Valide une ContributionProof PoUW.
   *
   * Calcul du score effectif :
   *   finalScore = proof.effectiveScore × reputationMultiplier
   *   reputationMultiplier ∈ [0.4, 1.2]
   *
   * Validation si finalScore ≥ VALIDATION_THRESHOLD ET réputation > MIN_REP_VALIDATE.
   *
   * En cas de succès :
   *   - Réputation monte progressivement (bonus de streak)
   *   - Récompense ajoutée à UserRewards.totalSkyEarned
   *   - Preuve persistée dans ZipMemory
   *
   * En cas d'échec :
   *   - Réputation descend
   *   - Streak réinitialisé
   *   - Slashing automatique (8 %)
   *
   * @param {ContributionProof} proof
   * @param {UserRewards|null}  rewards
   * @returns {Promise<boolean>}
   */
  async validateContribution(proof, rewards = null) {
    if (!(proof instanceof ContributionProof)) {
      throw new Error('proof doit être une instance de ContributionProof');
    }
    if (this.stakeAmount < MIN_STAKE_VALIDATE) {
      throw new Error(`Stake insuffisant (${this.stakeAmount} < ${MIN_STAKE_VALIDATE} SKY)`);
    }
    if (this.currentState !== NodeState.Active) {
      throw new Error(`Nœud non actif (état: ${this.currentState})`);
    }

    const repMult    = Math.max(0.40, Math.min(1.20, this.reputation));
    const finalScore = proof.effectiveScore * repMult;
    const isValid    = finalScore >= VALIDATION_THRESHOLD && this.reputation > MIN_REP_VALIDATE;

    this.#record(proof.proofHash, finalScore, isValid);

    if (isValid) {
      this.validatedContributions++;
      this.consecutiveSuccess++;
      this.totalValidationScore += finalScore;
      this.lastValidation = Date.now();

      // Montée de réputation avec bonus de streak (plafonné)
      const streakBonus = Math.min(this.consecutiveSuccess / 10, 0.5);
      this.reputation   = Math.min(REP_CAP, this.reputation + 0.018 * (1 + streakBonus));

      // Récompense — totalSkyEarned est la bonne propriété de UserRewards
      if (rewards instanceof UserRewards) {
        rewards.totalSkyEarned += REWARD_PER_VALIDATION;
      }

      // Persistance de la preuve (clé = proofHash, valeur = JSON sérialisé)
      await this.#validationCache.store(
        proof.proofHash,
        new TextEncoder().encode(JSON.stringify({ ...proof.toJSON(), validatedAt: Date.now() }))
      );

      console.debug(`[Validator] ✅ ${proof.proofHash.slice(0, 20)} — score: ${finalScore.toFixed(3)}`);

    } else {
      this.failedValidations++;
      this.consecutiveSuccess = 0;
      this.reputation         = Math.max(REP_FLOOR + 0.07, this.reputation - 0.035);
      this.#applySlash(0.08);

      console.warn(`[Validator] ❌ ${proof.proofHash.slice(0, 20)} — score: ${finalScore.toFixed(3)}`);
    }

    return isValid;
  }

  // ─── Consensus ────────────────────────────────────────────────

  /**
   * Calcule le poids de vote de ce validateur dans un consensus.
   *
   * Formule : weight = min(proposal × stakeFactor × reputation × 0.75, MAX)
   *   stakeFactor = min(stake / 10000, 8.0)
   *
   * Un validateur avec un stake élevé et une bonne réputation pèse plus,
   * mais le poids est plafonné pour éviter la centralisation.
   *
   * @param {number} proposalWeight — poids de base de la proposition
   * @returns {number} poids de vote [0, 120]
   */
  participateInConsensus(proposalWeight = 1.0) {
    if (this.currentState !== NodeState.Active) return 0;
    const stakeFactor = Math.min(this.stakeAmount / 10_000, CONSENSUS_STAKE_MAX);
    return +Math.min(proposalWeight * stakeFactor * this.reputation * 0.75, CONSENSUS_VOTE_MAX).toFixed(4);
  }

  // ─── Staking ──────────────────────────────────────────────────

  addStake(amount) {
    if (amount <= 0) throw new Error('Montant invalide');
    this.stakeAmount += amount;
    console.info(`[Validator] Stake ajouté : +${amount} SKY → total: ${this.stakeAmount}`);
  }

  /**
   * Retire du stake avec vérification du verrouillage.
   * Le retrait est refusé si le stake passe sous MIN_STAKE_VALIDATE
   * (le validateur deviendrait inéligible).
   */
  withdrawStake(amount) {
    if (amount <= 0) throw new Error('Montant invalide');
    if (this.lockedUntil && Date.now() < this.lockedUntil) {
      throw new Error(`Stake verrouillé jusqu'à ${new Date(this.lockedUntil).toISOString()}`);
    }
    const remaining = this.stakeAmount - amount;
    if (remaining < 0) throw new Error('Solde insuffisant');
    if (remaining > 0 && remaining < MIN_STAKE_VALIDATE) {
      throw new Error(`Retrait rendrait le stake insuffisant pour valider (min ${MIN_STAKE_VALIDATE} SKY)`);
    }
    this.stakeAmount = remaining;
    if (remaining === 0) this.currentState = NodeState.Idle;
    return remaining;
  }

  lockStake(durationMs) {
    this.lockedUntil = Date.now() + durationMs;
  }

  // ─── Slashing ─────────────────────────────────────────────────

  /**
   * Inflige un slashing au validateur.
   * Le montant est plafonné à MAX_SLASH_PER_EVENT du stake pour éviter
   * une destruction instantanée sur un seul événement.
   * Après MAX_SLASH_EVENTS slashings, le nœud est mis en veille.
   */
  slash(percentage) {
    this.#applySlash(percentage);
  }

  #applySlash(percentage) {
    const pct         = Math.max(0, Math.min(MAX_SLASH_PER_EVENT, percentage));
    const slashAmount = Math.floor(this.stakeAmount * pct);
    this.stakeAmount  = Math.max(0, this.stakeAmount - slashAmount);
    this.reputation   = Math.max(REP_FLOOR, this.reputation - 0.12);
    this.slashCount++;

    console.warn(
      `[Validator] Slash #${this.slashCount} — -${slashAmount} SKY (-${(pct*100).toFixed(0)}%) | ` +
      `stake restant: ${this.stakeAmount}`
    );

    if (this.slashCount >= MAX_SLASH_EVENTS) {
      this.currentState = NodeState.Sleeping;
      console.warn('[Validator] Nœud mis en veille — seuil de slashings atteint');
    }
  }

  // ─── Gouvernance ──────────────────────────────────────────────

  isEligibleForGovernance() {
    return (
      this.stakeAmount        >= MIN_STAKE_GOVERNANCE &&
      this.reputation         >= MIN_REP_GOVERNANCE   &&
      this.consecutiveSuccess >= MIN_CONSEC_GOVERNANCE &&
      this.currentState       === NodeState.Active
    );
  }

  /**
   * Poids de vote en gouvernance — basé sur le stake et la réputation,
   * indépendant du poids de consensus (contextes différents).
   */
  governanceVotingPower() {
    if (!this.isEligibleForGovernance()) return 0;
    return +Math.min((this.stakeAmount / 10_000) * this.reputation, 10.0).toFixed(4);
  }

  // ─── Récupération d'une preuve archivée ──────────────────────

  async retrieveProof(proofHash) {
    const raw = await this.#validationCache.retrieve(proofHash);
    if (!raw) return null;
    try { return JSON.parse(new TextDecoder().decode(raw)); }
    catch { return null; }
  }

  // ─── Métriques & santé ───────────────────────────────────────

  get averageValidationScore() {
    const total = this.validatedContributions + this.failedValidations;
    return total > 0 ? +(this.totalValidationScore / total).toFixed(4) : 0;
  }

  get successRate() {
    const total = this.validatedContributions + this.failedValidations;
    return total > 0 ? +(this.validatedContributions / total).toFixed(4) : 1;
  }

  getNodeType() { return 'Validator'; }

  healthReport() {
    return {
      nodeId              : this.nodeId,
      sovereignAlias      : this.sovereignAlias,
      state               : this.currentState,
      stakeAmount         : this.stakeAmount,
      lockedUntil         : this.lockedUntil,
      reputation          : +this.reputation.toFixed(4),
      reputationTier      : reputationTierFromScore(this.reputation),
      validated           : this.validatedContributions,
      failed              : this.failedValidations,
      successRate         : this.successRate,
      avgScore            : this.averageValidationScore,
      consecutiveSuccess  : this.consecutiveSuccess,
      slashCount          : this.slashCount,
      consensusWeight     : this.participateInConsensus(),
      governanceEligible  : this.isEligibleForGovernance(),
      governancePower     : this.governanceVotingPower(),
      lastValidation      : this.lastValidation,
    };
  }

  // ─── Privés ───────────────────────────────────────────────────

  /** Enregistre une validation dans l'anneau d'historique (512 entrées max) */
  #record(proofHash, score, valid) {
    this.#history.push({ proofHash, score: +score.toFixed(4), valid, ts: Date.now() });
    if (this.#history.length > 512) this.#history.shift();
  }
}

export default ValidatorNode;
