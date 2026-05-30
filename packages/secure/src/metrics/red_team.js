// packages/secure/src/metrics/red_team.js
// =====================================================
// Red Team Classifier — Métriques de Discrétion Avancées
// Compatible Contact + GroupManager + DID
// SkyAInet × Nikola T369
// =====================================================

export class CoverageMetrics {
  constructor() {
    this.totalPackets = 0;
    this.coverPackets = 0;
    this.realPackets = 0;
    this.klDivergence = 0.0;
    this.entropyReal = 0.0;
    this.entropyCover = 0.0;
    this.burstRatio = 0.0;
    this.contactId = null; // Uint8Array(32) | null
  }

  withContact(contactId) {
    this.contactId = contactId;
    return this;
  }

  update(isCover) {
    this.totalPackets++;
    if (isCover) {
      this.coverPackets++;
    } else {
      this.realPackets++;
    }
  }

  /**
   * Calcule la KL Divergence + Entropie (version statistique réelle)
   */
  calculateAdvancedMetrics(realHistogram, coverHistogram) {
    const totalReal = Array.from(realHistogram.values()).reduce((a, b) => a + b, 0);
    const totalCover = Array.from(coverHistogram.values()).reduce((a, b) => a + b, 0);

    if (totalReal === 0 || totalCover === 0) {
      this.klDivergence = 0.0;
      return;
    }

    let kl = 0.0;

    for (const [byte, countReal] of realHistogram) {
      const pReal = countReal / totalReal;
      const countCover = coverHistogram.get(byte) || 0;
      const pCover = countCover > 0 ? countCover / totalCover : 1e-10;

      if (pReal > 0) {
        kl += pReal * Math.log(pReal / pCover);
      }
    }

    this.klDivergence = kl;
    this.entropyReal = CoverageMetrics.#calculateEntropy(realHistogram, totalReal);
    this.entropyCover = CoverageMetrics.#calculateEntropy(coverHistogram, totalCover);

    this.burstRatio = this.realPackets > 0
      ? this.coverPackets / this.realPackets
      : 0.0;
  }

  static #calculateEntropy(histogram, total) {
    if (total === 0) return 0.0;

    let entropy = 0.0;
    for (const count of histogram.values()) {
      if (count > 0) {
        const p = count / total;
        entropy -= p * Math.log(p);
      }
    }
    return entropy;
  }
}

export const StealthProfile = Object.freeze({
  Low: 'Low',       // Maximum performance
  Medium: 'Medium', // Équilibre recommandé
  High: 'High',     // Maximum discrétion
});

export class RedTeamClassifier {
  constructor(klThreshold = 0.08, entropyThreshold = 0.15, profile = StealthProfile.Medium) {
    this.klThreshold = klThreshold;
    this.entropyThreshold = entropyThreshold;
    this.stealthProfile = profile;
  }

  /**
   * Évalue si le trafic est suffisamment discret
   */
  isStealthy(metrics) {
    const klOk = metrics.klDivergence < this.klThreshold;
    const entropyOk = Math.abs(metrics.entropyReal - metrics.entropyCover) < this.entropyThreshold;

    switch (this.stealthProfile) {
      case StealthProfile.Low:
        return klOk;
      case StealthProfile.Medium:
        return klOk && entropyOk;
      case StealthProfile.High:
        return klOk && entropyOk && metrics.burstRatio < 0.35;
      default:
        return klOk;
    }
  }

  /**
   * Génère un rapport détaillé
   */
  generateReport(metrics) {
    const isStealthy = this.isStealthy(metrics);

    return {
      isStealthy,
      klDivergence: metrics.klDivergence,
      entropyDifference: Math.abs(metrics.entropyReal - metrics.entropyCover),
      burstRatio: metrics.burstRatio,
      contactId: metrics.contactId,
      recommendation: isStealthy
        ? "Trafic discret. Profil actuel suffisant."
        : "Trafic détectable. Augmenter la fréquence des Flash Gematria ou ajuster le profil.",
    };
  }
}

// Instance par défaut (recommandée)
export const defaultRedTeamClassifier = new RedTeamClassifier(0.08, 0.15, StealthProfile.Medium);