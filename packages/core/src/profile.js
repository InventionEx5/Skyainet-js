// packages/core/src/profile.js
// =====================================================
// UserProfile — Agrégateur du profil utilisateur
//
// Agrège en un seul objet :
//   • AccountType (Free / Pro / NodeOwner)
//   • Score de réputation + ReputationTier
//   • PoSI Score (contributions × reputation × dream)
//   • ThevieEvolutionContribution
//   • Limites journalières + usage
//   • Quality score
//   • Niveau de vérification
//   • Abonnements actifs
//
// Source de vérité unique pour skyainet.html popup Profil
// et toutes les pages qui affichent des données utilisateur.
//
// SkyAInet × Nikola T369
// =====================================================

"use strict";

import { AccountType, RewardReason }   from './rewards.js';
import { NodeEconomics }               from './economics.js';
import { PoSI }                        from './posi.js';
import { reputationTierFromScore,
         ReputationTier }              from '../node/src/node_types.js';

// ─────────────────────────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────────────────────────

/** Niveaux de vérification du compte utilisateur. */
export const VerificationLevel = Object.freeze({
  None      : 'None',       // compte créé, aucune vérification
  Email     : 'Email',      // adresse email confirmée
  Wallet    : 'Wallet',     // wallet blockchain confirmé (signature)
  Node      : 'Node',       // nœud actif détecté on-chain
  Validator : 'Validator',  // validateur avec stake suffisant
});

/** Bornes pour la progression de réputation. */
const REP_THRESHOLDS = Object.freeze({
  [ReputationTier.Newcomer] : { min: 0,    max: 0.50, label: 'Newcomer',  color: '#94a3b8' },
  [ReputationTier.Reliable] : { min: 0.50, max: 0.70, label: 'Reliable',  color: '#4ade80' },
  [ReputationTier.Trusted]  : { min: 0.70, max: 0.85, label: 'Trusted',   color: '#6ee7b7' },
  [ReputationTier.Sovereign]: { min: 0.85, max: 0.95, label: 'Sovereign', color: '#22d3ee' },
  [ReputationTier.Legend]   : { min: 0.95, max: 1.00, label: 'Legend',    color: '#c084fc' },
});

// ─────────────────────────────────────────────────────────────────
// USER PROFILE
// ─────────────────────────────────────────────────────────────────

export class UserProfile {
  #nodeEcon;         // NodeEconomics — source rewards + abonnements
  #posi;             // PoSI — calcul du score souverain
  #reputation;       // number [0, 1]
  #verificationLevel;// VerificationLevel
  #walletAddress;    // string | null — adresse blockchain
  #stakeAmount;      // number — SKY stakés (pour Validator)
  #createdAt;        // timestamp

  /**
   * @param {object} opts
   * @param {NodeEconomics}       opts.nodeEcon
   * @param {number}              [opts.reputation=0.5]
   * @param {string}              [opts.verificationLevel]
   * @param {string|null}         [opts.walletAddress]
   * @param {number}              [opts.stakeAmount=0]
   */
  constructor(opts = {}) {
    this.#nodeEcon          = opts.nodeEcon ?? new NodeEconomics(AccountType.Free);
    this.#posi              = new PoSI();
    this.#reputation        = Math.max(0, Math.min(1, opts.reputation ?? 0.5));
    this.#verificationLevel = opts.verificationLevel ?? VerificationLevel.None;
    this.#walletAddress     = opts.walletAddress     ?? null;
    this.#stakeAmount       = Math.max(0, opts.stakeAmount ?? 0);
    this.#createdAt         = opts.createdAt ?? Date.now();
  }

  // ─── Mise à jour ──────────────────────────────────────────────

  /**
   * Met à jour le score de réputation.
   * @param {number} score — [0, 1]
   */
  updateReputation(score) {
    this.#reputation = Math.max(0, Math.min(1, score));
  }

  /**
   * Met à jour le niveau de vérification.
   * @param {VerificationLevel} level
   */
  setVerificationLevel(level) {
    if (!Object.values(VerificationLevel).includes(level)) {
      throw new TypeError(`VerificationLevel invalide : ${level}`);
    }
    this.#verificationLevel = level;

    // Vérification wallet → AccountType minimum Pro
    if (level === VerificationLevel.Wallet || level === VerificationLevel.Node) {
      if (this.#nodeEcon.userRewards.accountType === AccountType.Free) {
        console.info('[UserProfile] Vérification Wallet → upgrade automatique vers Pro suggéré');
      }
    }
  }

  /**
   * Connecte l'adresse wallet et monte le niveau de vérification.
   * @param {string} address
   */
  connectWallet(address) {
    this.#walletAddress = address;
    if (this.#verificationLevel === VerificationLevel.None ||
        this.#verificationLevel === VerificationLevel.Email) {
      this.#verificationLevel = VerificationLevel.Wallet;
    }
  }

  /**
   * Met à jour le type de compte.
   * @param {AccountType} type
   */
  setAccountType(type) {
    if (!Object.values(AccountType).includes(type)) {
      throw new TypeError(`AccountType invalide : ${type}`);
    }
    this.#nodeEcon.userRewards.accountType = type;
    console.info(`[UserProfile] AccountType → ${type}`);
  }

  // ─── Calculs ──────────────────────────────────────────────────

  /**
   * Calcule le PoSI Score à partir des données courantes.
   * Formule : contributions×0.42 + reputation×0.33 + dream×0.25
   * @returns {import('./posi.js').PoSIScore}
   */
  computePoSI() {
    const contributions = this.#nodeEcon.userRewards.totalLearnContributions;
    const dreamScore    = Math.min(
      this.#nodeEcon.userRewards.totalDreamCycles / 100,
      1.0
    );
    try {
      return this.#posi.calculateScore(
        Math.max(1, contributions),
        this.#reputation,
        dreamScore,
        this.#nodeEcon.userRewards
      );
    } catch {
      // Fallback si contributions = 0
      return this.#posi.calculateSimpleScore(1, this.#reputation, dreamScore);
    }
  }

  /** Retourne le ReputationTier courant. */
  get reputationTier() {
    return reputationTierFromScore(this.#reputation);
  }

  /** Retourne les métadonnées du tier (label, color, min, max). */
  get reputationTierMeta() {
    return REP_THRESHOLDS[this.reputationTier] ?? REP_THRESHOLDS[ReputationTier.Newcomer];
  }

  /**
   * Progression dans le tier courant [0, 1].
   * 0 = début du tier, 1 = seuil du tier suivant.
   */
  get reputationProgress() {
    const meta = this.reputationTierMeta;
    const range = meta.max - meta.min;
    if (range <= 0) return 1;
    return Math.max(0, Math.min(1, (this.#reputation - meta.min) / range));
  }

  // ─── Getters de commodité ────────────────────────────────────

  get accountType()              { return this.#nodeEcon.userRewards.accountType; }
  get reputation()               { return this.#reputation; }
  get verificationLevel()        { return this.#verificationLevel; }
  get walletAddress()            { return this.#walletAddress; }
  get stakeAmount()              { return this.#stakeAmount; }
  get dailyMessages()            { return this.#nodeEcon.userRewards.dailyMessages; }
  get maxDailyMessages()         { return this.#nodeEcon.userRewards.getMaxDailyMessages(); }
  get qualityScore()             { return this.#nodeEcon.userRewards.conversationQualityScore; }
  get thevieEvolutionContribution() { return this.#nodeEcon.userRewards.thevieEvolutionContribution; }
  get pendingRewards()           { return this.#nodeEcon.userRewards.pendingRewards; }
  get totalSkyEarned()           { return this.#nodeEcon.userRewards.totalSkyEarned; }
  get subscriptionBonus()        { return this.#nodeEcon.getSubscriptionBonus(); }
  get isEligibleForRewards()     { return this.#nodeEcon.isEligibleForRewards(); }
  get learnContributions()       { return this.#nodeEcon.userRewards.totalLearnContributions; }
  get dreamCycles()              { return this.#nodeEcon.userRewards.totalDreamCycles; }
  get qualityInteractions()      { return this.#nodeEcon.userRewards.highQualityInteractions; }
  get payoutHistory()            { return this.#nodeEcon.stats().payoutHistory; }
  get activeSubscriptions()      { return this.#nodeEcon.getActiveSubscriptions(); }
  get nodeEcon()                 { return this.#nodeEcon; }

  // ─── Sérialisation ────────────────────────────────────────────

  /**
   * Résumé complet pour la popup Profil de skyainet.html.
   * Appelé à chaque ouverture de la popup.
   */
  getSummary() {
    const posiScore = this.computePoSI();
    const tier      = this.reputationTierMeta;

    return {
      // Identité
      accountType        : this.accountType,
      walletAddress      : this.#walletAddress,
      verificationLevel  : this.#verificationLevel,
      createdAt          : this.#createdAt,

      // Réputation
      reputation         : +this.#reputation.toFixed(4),
      reputationTier     : this.reputationTier,
      reputationLabel    : tier.label,
      reputationColor    : tier.color,
      reputationProgress : +this.reputationProgress.toFixed(4),

      // PoSI
      posiScore          : +posiScore.total.toFixed(4),
      posiContribution   : +posiScore.contributionWeight.toFixed(4),
      posiReputation     : +posiScore.reputationWeight.toFixed(4),
      posiDream          : +posiScore.dreamWeight.toFixed(4),

      // Activité
      dailyMessages      : this.dailyMessages,
      maxDailyMessages   : this.maxDailyMessages,
      dailyUsagePct      : +(this.dailyMessages / this.maxDailyMessages).toFixed(4),
      qualityScore       : +this.qualityScore.toFixed(4),
      thevieEvolution    : +this.thevieEvolutionContribution.toFixed(4),
      learnContributions : this.learnContributions,
      dreamCycles        : this.dreamCycles,
      qualityInteractions: this.qualityInteractions,

      // Économie
      pendingRewards     : this.pendingRewards,
      totalSkyEarned     : this.totalSkyEarned,
      subscriptionBonus  : this.subscriptionBonus,
      isEligible         : this.isEligibleForRewards,
      stakeAmount        : this.#stakeAmount,

      // Abonnements
      activeSubscriptions: this.activeSubscriptions.length,
    };
  }

  /**
   * Données minimales pour la nav (badge réputation + solde pending).
   */
  getNavBadge() {
    return {
      reputationTier   : this.reputationTier,
      reputationColor  : this.reputationTierMeta.color,
      pendingRewards   : this.pendingRewards,
      accountType      : this.accountType,
      verificationLevel: this.#verificationLevel,
    };
  }

  stats() {
    return {
      ...this.getSummary(),
      payoutHistory   : this.payoutHistory,
      posiHistory     : this.#posi.getHistory(12),
      posiStats       : this.#posi.stats(),
    };
  }
}

export default UserProfile;
