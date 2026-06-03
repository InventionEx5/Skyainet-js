// packages/governance/src/posi.js
// =====================================================
// PoSI — Proof of Sovereign Indexing
// Score de Souveraineté Décentralisée
// Port de posi.rs — SkyAInet × Nikola T369
// =====================================================

"use strict";

// ─────────────────────────────────────────────────────────────────
// ERREUR TYPÉE
// ─────────────────────────────────────────────────────────────────

export class PoSIError extends Error {
  constructor(message, code = 'POSI_ERROR') {
    super(message);
    this.name = 'PoSIError';
    this.code = code;
  }
  static invalidContribution() { return new PoSIError('Contributions must be > 0',          'INVALID_CONTRIBUTION'); }
  static invalidReputation()   { return new PoSIError('Reputation must be in [0, 1]',        'INVALID_REPUTATION'); }
  static invalidDreamScore()   { return new PoSIError('Dream score must be in [0, 1]',       'INVALID_DREAM_SCORE'); }
}

// ─────────────────────────────────────────────────────────────────
// POSI SCORE — résultat d'un calcul
// ─────────────────────────────────────────────────────────────────

export class PoSIScore {
  constructor({ total, contributionWeight, reputationWeight, dreamWeight }) {
    this.total              = total;
    this.contributionWeight = contributionWeight;
    this.reputationWeight   = reputationWeight;
    this.dreamWeight        = dreamWeight;
    this.lastUpdated        = Date.now();
  }

  toJSON() {
    return {
      total              : +this.total.toFixed(6),
      contributionWeight : +this.contributionWeight.toFixed(6),
      reputationWeight   : +this.reputationWeight.toFixed(6),
      dreamWeight        : +this.dreamWeight.toFixed(6),
      lastUpdated        : this.lastUpdated,
    };
  }
}

// ─────────────────────────────────────────────────────────────────
// POSI
//
// Calcule le score de souveraineté d'un nœud selon trois axes :
//
//   contributions  — activité réseau (messages, indexations, leçons)
//                    plafonnée à 2500 → poids max 0.42
//   reputation     — score de réputation [0, 1] → poids max 0.33
//   dreamScore     — qualité des cycles de rêve [0, 1] → poids max 0.25
//
//   total = min(contributions/2500 × 0.42 + reputation × 0.33 + dream × 0.25, 1.0)
//
// Un nœud est "souverain" si son score ≥ 0.78.
//
// Récompenses SKY automatiques selon le niveau de souveraineté :
//   > 0.88 → +45 SKY   > 0.80 → +28 SKY
//   > 0.75 → +15 SKY   sinon  →  +6 SKY
//
// Historique conservé pour audit et traçabilité (max 1000 entrées).
// ─────────────────────────────────────────────────────────────────

export class PoSI {
  #scoreHistory;  // number[] — historique des scores

  constructor() {
    this.sovereigntyScore    = 0.78;
    this.lastCalculation     = Date.now();
    this.totalCalculations   = 0;
    this.minScore            = 0.0;
    this.maxScore            = 1.0;
    this.#scoreHistory       = [];
  }

  // ─── Calcul complet ──────────────────────────────────────────

  /**
   * Calcule le score de souveraineté et distribue optionnellement des SKY.
   *
   * @param {number}      contributions — nombre total de contributions (entier ≥ 1)
   * @param {number}      reputation    — [0, 1]
   * @param {number}      dreamScore    — [0, 1]
   * @param {UserRewards} [rewards]     — instance UserRewards pour bonus SKY
   * @returns {PoSIScore}
   */
  calculateScore(contributions, reputation, dreamScore, rewards = null) {
    if (!contributions || contributions <= 0) throw PoSIError.invalidContribution();
    if (reputation < 0 || reputation > 1)    throw PoSIError.invalidReputation();
    if (dreamScore < 0 || dreamScore > 1)    throw PoSIError.invalidDreamScore();

    const contributionWeight = (Math.min(contributions, 2500) / 2500) * 0.42;
    const reputationWeight   = reputation  * 0.33;
    const dreamWeight        = dreamScore  * 0.25;

    const total = Math.max(this.minScore,
      Math.min(this.maxScore, contributionWeight + reputationWeight + dreamWeight)
    );

    const score = new PoSIScore({ total, contributionWeight, reputationWeight, dreamWeight });

    this.sovereigntyScore  = total;
    this.lastCalculation   = Date.now();
    this.totalCalculations++;

    // Historique plafonné à 1000 entrées
    this.#scoreHistory.push(total);
    if (this.#scoreHistory.length > 1000) this.#scoreHistory.shift();

    // Récompenses SKY
    if (rewards && typeof rewards.totalSkyEarned === 'number') {
      const bonus = total > 0.88 ? 45 : total > 0.80 ? 28 : total > 0.75 ? 15 : 6;
      rewards.totalSkyEarned += bonus;
    }

    console.debug(
      `[PoSI] Score: ${total.toFixed(4)} ` +
      `(contrib: ${contributionWeight.toFixed(3)}, rep: ${reputationWeight.toFixed(3)}, dream: ${dreamWeight.toFixed(3)})`
    );

    return score;
  }

  /**
   * Version simplifiée sans mutation d'état — pour estimation rapide.
   */
  calculateSimpleScore(contributions, reputation, dreamScore) {
    const c = (Math.min(Math.max(0, contributions), 2500) / 2500) * 0.42;
    const r = Math.max(0, Math.min(1, reputation))  * 0.33;
    const d = Math.max(0, Math.min(1, dreamScore))  * 0.25;
    return Math.min(1.0, c + r + d);
  }

  // ─── Métriques ───────────────────────────────────────────────

  isSovereign() { return this.sovereigntyScore >= 0.78; }

  /**
   * Multiplicateur de récompense selon le niveau de souveraineté.
   * Utilisé par PouW et le système de rewards.
   */
  getSovereigntyBonus() {
    if (this.sovereigntyScore > 0.88) return 1.65;
    if (this.sovereigntyScore > 0.80) return 1.35;
    if (this.sovereigntyScore > 0.75) return 1.15;
    return 1.0;
  }

  /** Score moyen sur les N derniers calculs. */
  averageScore(n = 10) {
    const slice = this.#scoreHistory.slice(-n);
    return slice.length > 0 ? slice.reduce((a, b) => a + b, 0) / slice.length : 0;
  }

  /** Tendance : positif si le score monte, négatif s'il descend. */
  scoreTrend(n = 10) {
    const slice = this.#scoreHistory.slice(-n);
    if (slice.length < 2) return 0;
    return slice[slice.length - 1] - slice[0];
  }

  getHistory(limit = 50) { return this.#scoreHistory.slice(-limit); }

  summary() {
    return `PoSI Score: ${this.sovereigntyScore.toFixed(4)} | Calculations: ${this.totalCalculations} | Sovereign: ${this.isSovereign()}`;
  }

  stats() {
    return {
      sovereigntyScore  : +this.sovereigntyScore.toFixed(6),
      totalCalculations : this.totalCalculations,
      isSovereign       : this.isSovereign(),
      sovereigntyBonus  : this.getSovereigntyBonus(),
      averageScore      : +this.averageScore().toFixed(6),
      scoreTrend        : +this.scoreTrend().toFixed(6),
      historySize       : this.#scoreHistory.length,
    };
  }
}
