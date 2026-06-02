// packages/model/src/thevie/synapse.js
// =====================================================
// Synapse — Connexion Neurone à Neurone
// Port de synapse.rs — Hebbian, Anti-Hebbian, Décroissance, Sérialisation
// SkyAInet × Nikola T369
// =====================================================

"use strict";

// ─────────────────────────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────────────────────────

const STRENGTH_MIN   = 0.08;
const STRENGTH_MAX   = 1.00;
const STRENGTH_INIT  = 0.50;
const DECAY_RATE_DEF = 0.008;

// ─────────────────────────────────────────────────────────────────
// SYNAPSE
//
// Connexion dirigée entre deux neurones.
// Propriétés :
//   - strength    : poids de la connexion [STRENGTH_MIN, 1.0]
//   - usageCount  : nombre total d'activations
//   - lastUsed    : timestamp ms de la dernière activation
//   - decayRate   : vitesse de dégradation naturelle par tick
//   - createdAt   : timestamp ms de création
//
// Loi de Hebb : "neurons that fire together, wire together"
// Anti-Hebb : affaiblissement si corrélation négative
// ─────────────────────────────────────────────────────────────────

export class Synapse {
  /**
   * @param {number} from         — NeuronId source
   * @param {number} to           — NeuronId cible
   * @param {number} [strength]   — force initiale [STRENGTH_MIN, 1.0]
   * @param {number} [decayRate]  — taux de décroissance par tick
   */
  constructor(from, to, strength = STRENGTH_INIT, decayRate = DECAY_RATE_DEF) {
    const now         = _now();
    this.from         = from;
    this.to           = to;
    this.strength     = _clamp(strength);
    this.usageCount   = 0;
    this.lastUsed     = now;
    this.decayRate    = Math.max(0, Math.min(0.1, decayRate));
    this.createdAt    = now;
  }

  // ─── Renforcement Hebbian ─────────────────────────────────────

  /**
   * Renforce la connexion après co-activation (port de strengthen).
   * @param {number} amount — [0, 1]
   */
  strengthen(amount = 0.12) {
    this.strength   = _clamp(this.strength + amount);
    this.usageCount++;
    this.lastUsed   = _now();
    return this;
  }

  /**
   * Affaiblit la connexion (Anti-Hebbian / erreur de prédiction).
   * @param {number} amount — [0, 1]
   */
  weaken(amount = 0.18) {
    this.strength   = _clamp(this.strength - amount);
    this.lastUsed   = _now();
    return this;
  }

  // ─── Décroissance ─────────────────────────────────────────────

  /**
   * Dégradation naturelle (port de decay).
   * Appelée périodiquement pour simuler l'oubli biologique.
   */
  decay() {
    this.strength = _clamp(this.strength - this.decayRate);
    return this;
  }

  /**
   * Décroissance proportionnelle à l'âge d'inactivité.
   * @param {number} maxDecay — plafond de décroissance par appel
   */
  timeBasedDecay(maxDecay = 0.28) {
    const ageH    = (_now() - this.lastUsed) / 3_600_000;
    if (ageH > 8) {
      const decay = Math.min(ageH / 60, maxDecay);
      this.strength = _clamp(this.strength - decay);
    }
    return this;
  }

  // ─── Métriques ───────────────────────────────────────────────

  /** true si la synapse est suffisamment forte pour transmettre un signal. */
  isActive() {
    return this.strength > 0.12 && this.usageCount > 0;
  }

  /** Âge de la synapse en secondes (port de age_seconds). */
  ageSeconds() {
    return Math.floor((_now() - this.createdAt) / 1000);
  }

  /** Efficacité = strength × log1p(usageCount) — neurones fréquents sont favorisés. */
  get efficiency() {
    return this.strength * Math.log1p(this.usageCount);
  }

  // ─── Sérialisation ───────────────────────────────────────────

  toJSON() {
    return {
      from      : this.from,
      to        : this.to,
      strength  : +this.strength.toFixed(4),
      usageCount: this.usageCount,
      lastUsed  : this.lastUsed,
      decayRate : this.decayRate,
      createdAt : this.createdAt,
    };
  }

  static fromJSON(obj) {
    const s = new Synapse(obj.from, obj.to, obj.strength, obj.decayRate);
    s.usageCount = obj.usageCount ?? 0;
    s.lastUsed   = obj.lastUsed   ?? _now();
    s.createdAt  = obj.createdAt  ?? _now();
    return s;
  }
}

// ─────────────────────────────────────────────────────────────────
// HELPERS INTERNES
// ─────────────────────────────────────────────────────────────────

function _clamp(v) {
  return v < STRENGTH_MIN ? STRENGTH_MIN : v > STRENGTH_MAX ? STRENGTH_MAX : v;
}

function _now() { return Date.now(); }
