// packages/model/src/thevie/personality.js
// =====================================================
// Personality — Système de Personnalité Évolutive à 8 Traits
// Port de personality.rs — Mutation, Crossover, Influence, Sérialisation
// SkyAInet × Nikola T369
// =====================================================

"use strict";

// ─────────────────────────────────────────────────────────────────
// PROFILS DE PERSONNALITÉ PRÉDÉFINIS
// Utilisés pour la création de neurones spécialisés
// ─────────────────────────────────────────────────────────────────

export const PersonalityProfile = Object.freeze({
  // Profils originaux
  Sage       : { benevolence:0.82, truthfulness:0.95, creativity:0.68, wisdom:0.95, cooperation:0.88, curiosity:0.78, ethics:0.92, resilience:0.75 },
  Architect  : { benevolence:0.72, truthfulness:0.88, creativity:0.95, wisdom:0.82, cooperation:0.78, curiosity:0.92, ethics:0.85, resilience:0.88 },
  Guardian   : { benevolence:0.95, truthfulness:0.85, creativity:0.62, wisdom:0.78, cooperation:0.92, curiosity:0.65, ethics:0.98, resilience:0.95 },
  Explorer   : { benevolence:0.78, truthfulness:0.82, creativity:0.88, wisdom:0.72, cooperation:0.75, curiosity:0.98, ethics:0.82, resilience:0.72 },
  Diplomat   : { benevolence:0.92, truthfulness:0.88, creativity:0.75, wisdom:0.85, cooperation:0.98, curiosity:0.75, ethics:0.90, resilience:0.80 },
  // Profils étendus (idées supplémentaires)
  Oracle     : { benevolence:0.80, truthfulness:0.98, creativity:0.78, wisdom:0.98, cooperation:0.72, curiosity:0.88, ethics:0.95, resilience:0.70 },
  Innovator  : { benevolence:0.75, truthfulness:0.80, creativity:0.98, wisdom:0.75, cooperation:0.82, curiosity:0.95, ethics:0.80, resilience:0.85 },
  Sentinel   : { benevolence:0.85, truthfulness:0.92, creativity:0.65, wisdom:0.88, cooperation:0.90, curiosity:0.70, ethics:0.98, resilience:0.98 },
  Weaver     : { benevolence:0.88, truthfulness:0.85, creativity:0.92, wisdom:0.88, cooperation:0.95, curiosity:0.85, ethics:0.88, resilience:0.82 },
  Alchemist  : { benevolence:0.80, truthfulness:0.85, creativity:0.95, wisdom:0.90, cooperation:0.80, curiosity:0.92, ethics:0.85, resilience:0.78 },
  Default    : { benevolence:0.78, truthfulness:0.82, creativity:0.71, wisdom:0.75, cooperation:0.85, curiosity:0.80, ethics:0.88, resilience:0.75 },
});

// Noms des 8 traits pour itération
const TRAITS = ['benevolence','truthfulness','creativity','wisdom','cooperation','curiosity','ethics','resilience'];

// ─────────────────────────────────────────────────────────────────
// PERSONALITY
// ─────────────────────────────────────────────────────────────────

export class Personality {
  /**
   * @param {object|string} [init] — objet de traits ou clé de PersonalityProfile
   */
  constructor(init = 'Default') {
    const src = typeof init === 'string'
      ? (PersonalityProfile[init] ?? PersonalityProfile.Default)
      : init;

    this.benevolence  = _c(src.benevolence  ?? 0.78);
    this.truthfulness = _c(src.truthfulness ?? 0.82);
    this.creativity   = _c(src.creativity   ?? 0.71);
    this.wisdom       = _c(src.wisdom       ?? 0.75);
    this.cooperation  = _c(src.cooperation  ?? 0.85);
    this.curiosity    = _c(src.curiosity    ?? 0.80);
    this.ethics       = _c(src.ethics       ?? 0.88);
    this.resilience   = _c(src.resilience   ?? 0.75);
  }

  // ─── Compatibilité collectivin.js (5 traits) ────────────────
  get coherence() { return this.cooperation; }   // alias compat

  // ─── Mutation ────────────────────────────────────────────────

  /**
   * Mutation contrôlée à la naissance — diversité génétique (port de mutate_at_birth).
   * @param {number} strength — [0.01, 0.15]
   */
  mutateAtBirth(strength = 0.035) {
    const d = Math.max(0.01, Math.min(0.15, strength));
    for (const t of TRAITS) {
      this[t] = _c(this[t] + (Math.random() * 2 - 1) * d);
    }
    return this;
  }

  /**
   * Clone avec mutation — ne modifie pas l'original.
   */
  cloneWithMutation(strength = 0.055) {
    return new Personality(this).mutateAtBirth(strength);
  }

  // ─── Influence collective ─────────────────────────────────────

  /**
   * Applique l'influence d'une autre personnalité (port de apply_influence).
   * @param {Personality} other
   * @param {number}      strength — [0.05, 0.45]
   */
  applyInfluence(other, strength = 0.15) {
    const s = Math.max(0.05, Math.min(0.45, strength));
    for (const t of TRAITS) {
      this[t] = _c(this[t] * (1 - s) + other[t] * s);
    }
    return this;
  }

  // ─── Crossover ───────────────────────────────────────────────

  /**
   * Crossover entre deux personnalités — crée un enfant (port de crossover).
   * @param {Personality} p1
   * @param {Personality} p2
   * @returns {Personality}
   */
  static crossover(p1, p2) {
    const child = {};
    for (const t of TRAITS) {
      const w = Math.random();
      child[t] = p1[t] * w + p2[t] * (1 - w);
    }
    return new Personality(child);
  }

  // ─── Évolution ───────────────────────────────────────────────

  /**
   * Évolution multi-dimensionnelle après une interaction (port de EvolutionEngine.evolve_personality).
   * @param {number} quality        — [0, 1]
   * @param {number} dynamicRate    — taux d'évolution (ex. 0.042 × quality)
   * @param {number} mutationRate   — probabilité de mutation créative
   */
  evolve(quality, dynamicRate = 0.025, mutationRate = 0.012) {
    const rate = dynamicRate * Math.max(0.5, Math.min(1.4, quality));
    this.wisdom       = _c(this.wisdom       + rate * 0.65);
    this.truthfulness = _c(this.truthfulness + rate * 0.45);
    this.cooperation  = _c(this.cooperation  + rate * 0.38);
    this.curiosity    = _c(this.curiosity    + rate * 0.32);
    this.creativity   = _c(this.creativity   + rate * 0.28);
    this.ethics       = _c(this.ethics       + rate * 0.22);
    this.resilience   = _c(this.resilience   + rate * 0.18);

    // Mutation créative stochastique
    if (Math.random() < mutationRate) {
      this.creativity = _c(this.creativity + 0.04);
    }

    // Équilibre : trop de sagesse freine légèrement la créativité
    if (this.wisdom > 0.90) {
      this.creativity = _c(this.creativity - 0.006);
    }

    return this;
  }

  // ─── Métriques ───────────────────────────────────────────────

  /**
   * Similarité cosinus entre deux personnalités (port de cosine_similarity).
   */
  cosineSimilarity(other) {
    const a = this.toVector();
    const b = other.toVector();
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < 8; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
    const denom = Math.sqrt(na) * Math.sqrt(nb);
    return denom > 0 ? dot / denom : 0;
  }

  /** Moyenne des 8 traits — indicateur de stabilité globale. */
  getAverage() {
    return TRAITS.reduce((s, t) => s + this[t], 0) / 8;
  }

  /** Trait dominant (port de get_dominant_trait). */
  getDominantTrait() {
    let best = TRAITS[0], val = this[best];
    for (const t of TRAITS) { if (this[t] > val) { best = t; val = this[t]; } }
    return { trait: best, value: val };
  }

  /**
   * Vérifie si la personnalité est équilibrée (port de is_balanced).
   * @param {number} threshold — écart max toléré par rapport à la moyenne
   */
  isBalanced(threshold = 0.25) {
    const avg = this.getAverage();
    return TRAITS.every(t => Math.abs(this[t] - avg) <= threshold);
  }

  /** Retourne les 8 traits sous forme de Float32Array. */
  toVector() {
    return new Float32Array(TRAITS.map(t => this[t]));
  }

  /** Retourne une copie plain object des traits (sérialisable). */
  toJSON() {
    return Object.fromEntries(TRAITS.map(t => [t, +this[t].toFixed(4)]));
  }

  toString() {
    const { trait, value } = this.getDominantTrait();
    return `Personality [${TRAITS.map(t => `${t[0].toUpperCase()}:${this[t].toFixed(2)}`).join(' | ')}] | Avg:${this.getAverage().toFixed(2)} | Dom:${trait}`;
  }
}

// ─────────────────────────────────────────────────────────────────
// HELPER INTERNE
// ─────────────────────────────────────────────────────────────────

/** Clamp dans [0.10, 0.99] — same as Rust impl */
function _c(v) { return v < 0.10 ? 0.10 : v > 0.99 ? 0.99 : v; }
