// packages/core/src/rewards.js
// =====================================================
// UserRewards — Système de Récompenses Anti-Farming
// Limites journalières + Qualité minimale + Claim mensuel
// Port de rewards.rs — SkyAInet × Nikola T369
// =====================================================

"use strict";

// ─────────────────────────────────────────────────────────────────
// ENUMS
// ─────────────────────────────────────────────────────────────────

export const AccountType = Object.freeze({
  Free     : 'Free',
  Pro      : 'Pro',
  NodeOwner: 'NodeOwner',
});

export const RewardReason = Object.freeze({
  LearnContribution      : 'LearnContribution',
  DreamCycleParticipation: 'DreamCycleParticipation',
  HighQualityInteraction : 'HighQualityInteraction',
  SubscriptionBonus      : 'SubscriptionBonus',
  // Alias rétrocompatibilité (rewards.js original)
  Message: 'HighQualityInteraction',
  Learn  : 'LearnContribution',
  Dream  : 'DreamCycleParticipation',
});

// ─────────────────────────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────────────────────────

const QUALITY_MIN       = 0.70;   // seuil minimum pour gagner des SKY
const QUALITY_RESET_HOUR= 0;      // heure de reset des messages journaliers (UTC minuit)

const BASE_REWARDS = Object.freeze({
  [RewardReason.LearnContribution]      : 12,
  [RewardReason.DreamCycleParticipation]: 22,
  [RewardReason.HighQualityInteraction] : 8,
  [RewardReason.SubscriptionBonus]      : 50,
});

const DAILY_LIMITS = Object.freeze({
  [AccountType.Free]     : 80,
  [AccountType.Pro]      : 200,
  [AccountType.NodeOwner]: 450,
});

const SUBSCRIPTION_BONUS = Object.freeze({
  [AccountType.Free]     : 0,
  [AccountType.Pro]      : 35,
  [AccountType.NodeOwner]: 75,
});

// ─────────────────────────────────────────────────────────────────
// USER REWARDS
//
// Port complet de rewards.rs avec :
//   — Anti-farming : limites journalières par AccountType
//   — Seuil qualité : 0.70 minimum
//   — EMA sur conversationQualityScore (α=0.16 learn, α=0.18 interaction)
//   — Claim mensuel — transfert pending → totalSkyEarned
//   — totalSkyEarned exposé directement pour rétrocompatibilité
//     (tous les fichiers font `rewards.totalSkyEarned += N`)
// ─────────────────────────────────────────────────────────────────

export class UserRewards {
  #dailyReset;      // timestamp du dernier reset journalier

  constructor(accountType = AccountType.Free) {
    this.accountType                 = accountType;

    // Compteurs (port de rewards.rs)
    this.dailyMessages               = 0;
    this.totalLearnContributions     = 0;
    this.totalDreamCycles            = 0;
    this.highQualityInteractions     = 0;

    // Scores
    this.conversationQualityScore    = 0.65;
    this.thevieEvolutionContribution = 0.25;

    // SKY — totalSkyEarned exposé publiquement pour rétrocompatibilité
    this.totalSkyEarned              = 0;
    this.pendingRewards              = 0;
    this.lastRewardDate              = null;

    this.#dailyReset = Date.now();
  }

  // ─── Anti-farming ─────────────────────────────────────────────

  getMaxDailyMessages() {
    return DAILY_LIMITS[this.accountType] ?? 80;
  }

  #canEarnToday() {
    this.#checkDailyReset();
    return this.dailyMessages < this.getMaxDailyMessages();
  }

  /** Reset automatique à minuit UTC. */
  #checkDailyReset() {
    const now       = new Date();
    const resetDate = new Date(this.#dailyReset);
    if (now.getUTCDate() !== resetDate.getUTCDate() ||
        now.getUTCMonth() !== resetDate.getUTCMonth()) {
      this.dailyMessages = 0;
      this.#dailyReset   = Date.now();
    }
  }

  // ─── Enregistrement ───────────────────────────────────────────

  /**
   * Enregistre une contribution d'apprentissage.
   * Port de record_learn_contribution().
   * @param {number} quality — [0, 1]
   */
  recordLearnContribution(quality = 0.85) {
    if (!this.#canEarnToday() || quality < QUALITY_MIN) return;
    this.dailyMessages++;
    this.totalLearnContributions++;
    this.conversationQualityScore = Math.max(0.1, Math.min(1.0,
      this.conversationQualityScore * 0.84 + quality * 0.16
    ));
    this.lastRewardDate = Date.now();
    this.#addPendingReward(RewardReason.LearnContribution, quality);
  }

  /**
   * Enregistre une participation au Dream Cycle.
   * Port de record_dream_cycle().
   */
  recordDreamCycle(quality = 0.85) {
    if (!this.#canEarnToday() || quality < QUALITY_MIN) return;
    this.dailyMessages++;
    this.totalDreamCycles++;
    this.thevieEvolutionContribution = Math.min(1.0,
      this.thevieEvolutionContribution + quality * 0.11
    );
    this.lastRewardDate = Date.now();
    this.#addPendingReward(RewardReason.DreamCycleParticipation, quality);
  }

  /**
   * Enregistre une interaction de haute qualité.
   * Port de record_high_quality_interaction().
   * Alias rétrocompatible : recordMessage()
   */
  recordHighQualityInteraction(quality = 0.85) {
    if (!this.#canEarnToday() || quality < QUALITY_MIN) return;
    this.dailyMessages++;
    this.highQualityInteractions++;
    this.conversationQualityScore = Math.max(0.1, Math.min(1.0,
      this.conversationQualityScore * 0.82 + quality * 0.18
    ));
    this.lastRewardDate = Date.now();
    this.#addPendingReward(RewardReason.HighQualityInteraction, quality);
  }

  /** Alias rétrocompatible pour les fichiers qui appellent recordMessage(). */
  recordMessage(quality = 0.80) {
    this.recordHighQualityInteraction(quality);
    // Fallback direct pour les callers qui ne passent pas de quality
    if (quality < QUALITY_MIN) this.totalSkyEarned += 0.1;
  }

  /** Alias rétrocompatible pour updateQualityScore(). */
  updateQualityScore(_idx, quality) {
    this.conversationQualityScore = Math.max(0.1, Math.min(1.0, quality));
    this.totalSkyEarned += quality * 0.5;
  }

  // ─── Rewards internes ────────────────────────────────────────

  #addPendingReward(reason, quality) {
    const base   = BASE_REWARDS[reason] ?? 8;
    const amount = Math.floor(base * quality);
    this.pendingRewards += amount;
  }

  // ─── Claim mensuel ────────────────────────────────────────────

  /**
   * Transfère les pending rewards vers totalSkyEarned.
   * Port de claim_monthly_rewards().
   * @returns {number} montant réclamé
   */
  claimMonthlyRewards() {
    if (this.pendingRewards === 0) return 0;
    const amount        = this.pendingRewards;
    this.totalSkyEarned += amount;
    this.pendingRewards  = 0;
    this.lastRewardDate  = Date.now();
    console.info(`[Rewards] Claim mensuel : ${amount} SKY`);
    return amount;
  }

  /** Alias rétrocompatible (rewards.js original). */
  claim() {
    const claimed = this.claimMonthlyRewards();
    return { claimed };
  }

  // ─── Bonus & Éligibilité ─────────────────────────────────────

  getSubscriptionBonus() {
    return SUBSCRIPTION_BONUS[this.accountType] ?? 0;
  }

  isEligibleForRewards() {
    return this.conversationQualityScore >= 0.65 &&
           this.totalLearnContributions  >= 1;
  }

  // ─── Stats ────────────────────────────────────────────────────

  summary() {
    return `Rewards | Type: ${this.accountType} | Pending: ${this.pendingRewards} SKY | ` +
           `Earned: ${this.totalSkyEarned} SKY | Quality: ${this.conversationQualityScore.toFixed(2)} | ` +
           `Learn: ${this.totalLearnContributions} | Dream: ${this.totalDreamCycles}`;
  }

  stats() {
    return {
      accountType                : this.accountType,
      dailyMessages              : this.dailyMessages,
      maxDailyMessages           : this.getMaxDailyMessages(),
      totalLearnContributions    : this.totalLearnContributions,
      totalDreamCycles           : this.totalDreamCycles,
      highQualityInteractions    : this.highQualityInteractions,
      conversationQualityScore   : +this.conversationQualityScore.toFixed(4),
      thevieEvolutionContribution: +this.thevieEvolutionContribution.toFixed(4),
      totalSkyEarned             : this.totalSkyEarned,
      pendingRewards             : this.pendingRewards,
      subscriptionBonus          : this.getSubscriptionBonus(),
      isEligible                 : this.isEligibleForRewards(),
      lastRewardDate             : this.lastRewardDate,
    };
  }
}