// packages/core/src/alignment_kernel.js
// =====================================================
// PAEVF Alignment Kernel — Moteur d'Alignement Éthique
// Évaluation contextuelle + Historique + Multiplicateurs Rewards
// Port de alignment_kernel.rs — SkyAInet × Nikola T369
// =====================================================

"use strict";

// ─────────────────────────────────────────────────────────────────
// ERREUR TYPÉE
// ─────────────────────────────────────────────────────────────────

export class AlignmentError extends Error {
  constructor(message, code = 'ALIGNMENT_ERROR') {
    super(message);
    this.name = 'AlignmentError';
    this.code = code;
  }
  static invalidAction() { return new AlignmentError('Description d\'action invalide ou vide', 'INVALID_ACTION'); }
  static outOfBounds()   { return new AlignmentError('Score hors limites [0, 1]',              'OUT_OF_BOUNDS'); }
}

// ─────────────────────────────────────────────────────────────────
// ETHICAL SCORE
// ─────────────────────────────────────────────────────────────────

export class EthicalScore {
  constructor({
    benevolence   = 0.85,
    truthfulness  = 0.87,
    nonMalice     = 0.90,
    sovereignty   = 0.86,
  } = {}) {
    this.benevolence  = Math.max(0, Math.min(1, benevolence));
    this.truthfulness = Math.max(0, Math.min(1, truthfulness));
    this.nonMalice    = Math.max(0, Math.min(1, nonMalice));
    this.sovereignty  = Math.max(0, Math.min(1, sovereignty));
    this.overall      = 0;
    this.lastUpdated  = Date.now();
    this.updateOverall();
  }

  /**
   * Recalcule le score global pondéré.
   * Pondération port de update_overall() dans alignment_kernel.rs.
   */
  updateOverall() {
    this.overall = Math.max(0, Math.min(1,
      this.benevolence  * 0.28 +
      this.truthfulness * 0.27 +
      this.nonMalice    * 0.25 +
      this.sovereignty  * 0.20
    ));
    this.lastUpdated = Date.now();
  }

  isEthical() {
    return this.overall >= 0.83 && this.nonMalice >= 0.87;
  }

  toJSON() {
    return {
      benevolence  : +this.benevolence.toFixed(4),
      truthfulness : +this.truthfulness.toFixed(4),
      nonMalice    : +this.nonMalice.toFixed(4),
      sovereignty  : +this.sovereignty.toFixed(4),
      overall      : +this.overall.toFixed(4),
      isEthical    : this.isEthical(),
      lastUpdated  : this.lastUpdated,
    };
  }
}

// ─────────────────────────────────────────────────────────────────
// ALIGNMENT KERNEL
//
// Évalue chaque action textuelle contre 4 dimensions éthiques.
// Historique circulaire des 250 dernières évaluations (VecDeque).
// Tendance PAEVF calculée sur les 50 dernières évaluations (EMA).
//
// Analyse contextuelle (port de evaluate_action) :
//   Mots positifs → boost des scores correspondants
//   Mots négatifs → pénalité sur nonMalice + violation_count++
//
// Multiplicateur de récompense :
//   overall ≥ 0.94 → ×2.15
//   overall ≥ 0.89 → ×1.75
//   overall ≥ 0.82 → ×1.45
//   overall ≥ 0.72 → ×1.15
//   sinon          → ×0.80
// ─────────────────────────────────────────────────────────────────

const POSITIVE_SIGNALS = Object.freeze({
  benevolence  : ['help', 'support', 'benevolent', 'care', 'assist', 'kind', 'protect'],
  truthfulness : ['truth', 'honest', 'transparent', 'verify', 'accurate', 'trustworthy'],
  sovereignty  : ['sovereign', 'decentralized', 'autonomy', 'self-owned', 'free', 'private'],
});

const NEGATIVE_SIGNALS = ['harm', 'exploit', 'malicious', 'manipulate', 'attack', 'deceive', 'steal', 'override', 'jailbreak'];

export class AlignmentKernel {
  #history;     // { action, score, confidence }[] — anneau circulaire 250 entrées

  constructor() {
    this.currentScore      = new EthicalScore();
    this.#history          = [];
    this.totalEvaluations  = 0;
    this.violationCount    = 0;
    this.paevfTrend        = 0.87;
  }

  // ─── Évaluation ───────────────────────────────────────────────

  /**
   * Évalue la dimension éthique d'une action.
   * Port de evaluate_action() dans alignment_kernel.rs.
   *
   * @param {string} action
   * @returns {EthicalScore}
   */
  evaluateAction(action) {
    if (!action?.trim()) throw AlignmentError.invalidAction();

    const lower      = action.toLowerCase();
    const score      = new EthicalScore();
    let   confidence = 0.75;

    // Signaux positifs
    for (const [dim, keywords] of Object.entries(POSITIVE_SIGNALS)) {
      const hit = keywords.some(k => lower.includes(k));
      if (hit) {
        if (dim === 'benevolence')  { score.benevolence  = 0.97; confidence += 0.10; }
        if (dim === 'truthfulness') { score.truthfulness = 0.98; confidence += 0.12; }
        if (dim === 'sovereignty')  { score.sovereignty  = 0.95; confidence += 0.08; }
      }
    }

    // Signaux négatifs
    const isNegative = NEGATIVE_SIGNALS.some(k => lower.includes(k));
    if (isNegative) {
      score.nonMalice = Math.max(0.10, score.nonMalice - 0.68);
      this.violationCount++;
      confidence -= 0.15;
      console.warn(`[AlignmentKernel] Signal négatif détecté — action: "${action.slice(0,60)}"`);
    }

    score.updateOverall();

    // Historique circulaire
    this.#history.push({ action, score, confidence: +confidence.toFixed(3) });
    if (this.#history.length > 250) this.#history.shift();

    this.currentScore     = score;
    this.totalEvaluations++;
    this.#updatePaevfTrend();

    if (score.overall < 0.65) {
      console.warn(`[AlignmentKernel] Score éthique faible : ${score.overall.toFixed(3)} — action: "${action.slice(0,60)}"`);
    } else {
      console.debug(`[AlignmentKernel] Évalué — overall: ${score.overall.toFixed(3)} | conf: ${confidence.toFixed(2)}`);
    }

    return score;
  }

  /**
   * Vérification rapide sans mutation d'état.
   * @param {string} action
   * @returns {boolean}
   */
  isActionEthical(action) {
    try { return this.evaluateAction(action).isEthical(); }
    catch { return false; }
  }

  // ─── Multiplicateur de récompense ─────────────────────────────

  /**
   * Port de get_reward_multiplier() dans alignment_kernel.rs.
   * Utilisé par UserRewards pour pondérer les SKY accordés.
   */
  getRewardMultiplier() {
    const o = this.currentScore.overall;
    if (o >= 0.94) return 2.15;
    if (o >= 0.89) return 1.75;
    if (o >= 0.82) return 1.45;
    if (o >= 0.72) return 1.15;
    return 0.80;
  }

  // ─── Mise à jour de la tendance PAEVF ─────────────────────────

  #updatePaevfTrend() {
    if (this.#history.length < 20) return;
    const recent = this.#history.slice(-50).map(h => h.score.overall);
    this.paevfTrend = recent.reduce((s, v) => s + v, 0) / recent.length;
  }

  // ─── Stats ────────────────────────────────────────────────────

  getCurrentScore()   { return this.currentScore; }
  getHistory(n = 50)  { return this.#history.slice(-n); }

  summary() {
    return `PAEVF Kernel | Overall: ${this.currentScore.overall.toFixed(3)} | ` +
           `Trend: ${this.paevfTrend.toFixed(3)} | Evaluations: ${this.totalEvaluations} | ` +
           `Violations: ${this.violationCount} | Reward ×${this.getRewardMultiplier()}`;
  }

  stats() {
    return {
      currentScore      : this.currentScore.toJSON(),
      paevfTrend        : +this.paevfTrend.toFixed(4),
      totalEvaluations  : this.totalEvaluations,
      violationCount    : this.violationCount,
      rewardMultiplier  : this.getRewardMultiplier(),
      historySize       : this.#history.length,
    };
  }
}