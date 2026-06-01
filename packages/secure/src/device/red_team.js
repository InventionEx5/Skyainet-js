// packages/secure/src/metrics/red_team.js
// =====================================================
// Red Team Classifier — Métriques de Discrétion Avancées
// SkyAInet × Nikola T369
// =====================================================

"use strict";

// ─────────────────────────────────────────────────────────────────
// COVERAGE METRICS
// ─────────────────────────────────────────────────────────────────

export class CoverageMetrics {
  constructor() {
    this.totalPackets = 0;
    this.coverPackets = 0;
    this.realPackets  = 0;
    this.klDivergence = 0;
    this.entropyReal  = 0;
    this.entropyCover = 0;
    this.burstRatio   = 0;
    this.contactId    = null;   // Uint8Array(32) | null
  }

  withContact(contactId) {
    this.contactId = contactId;
    return this;
  }

  update(isCover) {
    this.totalPackets++;
    if (isCover) this.coverPackets++;
    else         this.realPackets++;
  }

  /**
   * Calcule KL divergence + entropie de Shannon à partir des histogrammes.
   *
   * KL(P‖Q) = Σ p(x) · log(p(x)/q(x))
   *   P = distribution réelle, Q = distribution cover
   *
   * Un ε = 1e-10 est utilisé pour les bins absents de Q (évite log(0)).
   * L'entropie de Shannon H = -Σ p(x) · log(p(x)) mesure l'aléa apparent.
   *
   * @param {Map<number, number>} realHistogram  — byte → count
   * @param {Map<number, number>} coverHistogram — byte → count
   */
  calculateAdvancedMetrics(realHistogram, coverHistogram) {
    const totalReal  = [...realHistogram.values()].reduce((a, b) => a + b, 0);
    const totalCover = [...coverHistogram.values()].reduce((a, b) => a + b, 0);

    if (totalReal === 0 || totalCover === 0) {
      this.klDivergence = 0;
      this.entropyReal  = 0;
      this.entropyCover = 0;
      this.burstRatio   = 0;
      return;
    }

    let kl = 0;
    for (const [byte, countReal] of realHistogram) {
      const pReal  = countReal / totalReal;
      const cCover = coverHistogram.get(byte) ?? 0;
      const pCover = cCover > 0 ? cCover / totalCover : 1e-10;
      if (pReal > 0) kl += pReal * Math.log(pReal / pCover);
    }

    this.klDivergence = kl;
    this.entropyReal  = CoverageMetrics.#entropy(realHistogram,  totalReal);
    this.entropyCover = CoverageMetrics.#entropy(coverHistogram, totalCover);
    this.burstRatio   = this.realPackets > 0 ? this.coverPackets / this.realPackets : 0;
  }

  static #entropy(histogram, total) {
    if (total === 0) return 0;
    let h = 0;
    for (const count of histogram.values()) {
      if (count > 0) { const p = count / total; h -= p * Math.log(p); }
    }
    return h;
  }
}

// ─────────────────────────────────────────────────────────────────
// PROFILS DE DISCRÉTION
// ─────────────────────────────────────────────────────────────────

export const StealthProfile = Object.freeze({
  Low   : 'Low',     // performance maximale, discrétion minimale
  Medium: 'Medium',  // équilibre recommandé
  High  : 'High',    // discrétion maximale
});

// ─────────────────────────────────────────────────────────────────
// RED TEAM CLASSIFIER
// ─────────────────────────────────────────────────────────────────

export class RedTeamClassifier {
  /**
   * @param {number} klThreshold      — seuil KL divergence (défaut 0.08)
   * @param {number} entropyThreshold — seuil différence d'entropie (défaut 0.15)
   * @param {string} profile          — StealthProfile.*
   */
  constructor(klThreshold = 0.08, entropyThreshold = 0.15, profile = StealthProfile.Medium) {
    this.klThreshold      = klThreshold;
    this.entropyThreshold = entropyThreshold;
    this.stealthProfile   = profile;
  }

  /**
   * Évalue si le trafic est suffisamment discret selon le profil.
   *
   * Low    : KL < seuil seul
   * Medium : KL + entropie
   * High   : KL + entropie + burstRatio < 0.35
   */
  isStealthy(metrics) {
    const klOk      = metrics.klDivergence < this.klThreshold;
    const entropyOk = Math.abs(metrics.entropyReal - metrics.entropyCover) < this.entropyThreshold;

    switch (this.stealthProfile) {
      case StealthProfile.Low   : return klOk;
      case StealthProfile.High  : return klOk && entropyOk && metrics.burstRatio < 0.35;
      default                   : return klOk && entropyOk;   // Medium
    }
  }

  /**
   * Rapport détaillé avec recommandation.
   */
  generateReport(metrics) {
    const stealthy = this.isStealthy(metrics);
    return {
      isStealthy       : stealthy,
      klDivergence     : +metrics.klDivergence.toFixed(6),
      entropyReal      : +metrics.entropyReal.toFixed(4),
      entropyCover     : +metrics.entropyCover.toFixed(4),
      entropyDifference: +Math.abs(metrics.entropyReal - metrics.entropyCover).toFixed(4),
      burstRatio       : +metrics.burstRatio.toFixed(4),
      totalPackets     : metrics.totalPackets,
      coverRatio       : metrics.totalPackets > 0
        ? +(metrics.coverPackets / metrics.totalPackets).toFixed(4) : 0,
      profile          : this.stealthProfile,
      contactId        : metrics.contactId
        ? Array.from(metrics.contactId.subarray(0, 8)).map(b => b.toString(16).padStart(2,'0')).join('')
        : null,
      recommendation   : stealthy
        ? 'Trafic discret — profil actuel suffisant.'
        : 'Trafic détectable — augmenter la fréquence Flash Gematria ou élever le profil.',
    };
  }

  /**
   * Crée un histogramme de distribution des octets depuis un buffer.
   * Utile pour calculer les métriques sur un payload capturé.
   */
  static buildHistogram(data) {
    const hist = new Map();
    for (const byte of data) hist.set(byte, (hist.get(byte) ?? 0) + 1);
    return hist;
  }
}

// Instance par défaut
export const defaultRedTeamClassifier = new RedTeamClassifier(0.08, 0.15, StealthProfile.Medium);
