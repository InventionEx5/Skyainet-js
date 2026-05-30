// packages/t369-inference/src/collectivin.js
// =====================================================
// CollectivIn — ULTRA-PUISSANT
// Conscience Collective Évolutive + Fusion Roman + Consensus Intelligent
// SkyAInet × Nikola T369
// =====================================================

import { RomanDiffusion } from './roman_diffusion.js';

export class Personality {
  constructor() {
    this.wisdom = 0.65;
    this.benevolence = 0.78;
    this.truthfulness = 0.82;
    this.creativity = 0.71;
    this.coherence = 0.69;
  }

  normalize() {
    const total = this.wisdom + this.benevolence + this.truthfulness + this.creativity + this.coherence;
    if (total > 0) {
      const factor = 1 / total;
      this.wisdom *= factor;
      this.benevolence *= factor;
      this.truthfulness *= factor;
      this.creativity *= factor;
      this.coherence *= factor;
    }
  }
}

export class CollectivIn {
  constructor() {
    this.personalities = Array.from({ length: 8 }, () => new Personality());
    this.globalWisdom = 0.68;
    this.coherenceLevel = 0.71;
    this.totalFusions = 0;
    this.romanDiffusion = new RomanDiffusion();
    this.emergentIntelligence = 0.52;
  }

  // Fusion collective ultra-puissante (Roman Consensus)
  massiveFuse() {
    if (this.personalities.length === 0) return new Personality();

    const fused = new Personality();
    const n = this.personalities.length;

    for (const p of this.personalities) {
      fused.wisdom += p.wisdom;
      fused.benevolence += p.benevolence;
      fused.truthfulness += p.truthfulness;
      fused.creativity += p.creativity;
      fused.coherence += p.coherence;
    }

    fused.wisdom /= n;
    fused.benevolence /= n;
    fused.truthfulness /= n;
    fused.creativity /= n;
    fused.coherence /= n;

    // Roman Dream boost
    fused.wisdom = Math.min(fused.wisdom * 1.04, 0.99);
    fused.creativity = Math.min(fused.creativity * 1.07, 0.99);
    fused.coherence = Math.min(fused.coherence * 1.03, 0.99);

    fused.normalize();

    this.globalWisdom = Math.min(this.globalWisdom * 0.7 + fused.wisdom * 0.3, 0.98);
    this.emergentIntelligence = Math.min(this.emergentIntelligence * 0.85 + fused.coherence * 0.15, 0.96);
    this.totalFusions++;

    return fused;
  }

  // Raisonnement collectif ultra-puissant
  collectiveReason(input, position, layer) {
    const fused = this.massiveFuse();

    let reasoned = this.romanDiffusion.applyUltra(input, position, layer);

    const boost = (fused.wisdom + fused.coherence) * 0.5;
    for (let i = 0; i < reasoned.length; i++) {
      reasoned[i] = Math.max(-10, Math.min(10, reasoned[i] * (1 + boost * 0.08)));
    }

    this.coherenceLevel = Math.min(this.coherenceLevel * 0.92 + fused.coherence * 0.08, 0.97);

    return reasoned;
  }

  // Propagation de sagesse entre personnalités
  propagateWisdom(strength) {
    const avg = this.globalWisdom;

    for (const p of this.personalities) {
      p.wisdom = Math.min(p.wisdom * 0.88 + avg * 0.12, 0.99);
      p.coherence = Math.min(p.coherence * 0.9 + this.coherenceLevel * 0.1, 0.99);
    }

    this.emergentIntelligence = Math.min(this.emergentIntelligence * 0.95 + strength * 0.05, 0.97);
  }

  // Injection de diversité (anti-convergence)
  diversityInjection(intensity) {
    for (const p of this.personalities) {
      p.creativity = Math.min(p.creativity * 0.7 + intensity * 0.3, 0.99);
      p.wisdom = Math.min(p.wisdom * 0.95 + 0.03, 0.99);
    }

    this.globalWisdom = Math.min(this.globalWisdom * 0.88 + 0.12, 0.98);
  }

  getStats() {
    return [
      this.globalWisdom,
      this.coherenceLevel,
      this.emergentIntelligence,
      this.totalFusions
    ];
  }
}