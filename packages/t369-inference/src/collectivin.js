// packages/t369-inference/src/collectivin.js
// =====================================================
// CollectivIn — Conscience Collective Évolutive
// Port de collective_consciousness.rs — Émergence, Cohérence, Fusion
// SkyAInet × Nikola T369
// =====================================================

"use strict";

import { RomanDiffusion }          from '#roman_diffusion';
import { Personality }             from '#personality';

// ─────────────────────────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────────────────────────

const DIMS              = 8;   // benevolence, truthfulness, creativity, wisdom, cooperation, curiosity, ethics, resilience
const MEMORY_MAX        = 140;
const CONSENSUS_THRESH  = 0.79;
const EVOLUTION_RATE    = 0.0095;

// ─────────────────────────────────────────────────────────────────
// COLLECTIVE IN — Conscience Collective
//
// Gère N personnalités en TypedArray plat (N × 8 traits).
// Fournit :
//   - advancedFuse()       — fusion pondérée par sagesse avec émergence
//   - collectiveReason()   — application in-place sur un vecteur caché
//   - propagateWisdom()    — redistribution de sagesse aux personnalités
//   - diversityInjection() — anti-convergence (injection de créativité)
//   - passiveEvolutionTick() — évolution lente à chaque tick
//   - massiveFuse()        — fusion massive lors de connexion de nœuds
//   - backpropagateWisdom() — rétropropagation vers le MeshIn
// ─────────────────────────────────────────────────────────────────

export class CollectivIn {
  #data;      // Float32Array[N × DIMS] — personnalités aplaties
  #fused;     // Float32Array[DIMS]     — résultat de la dernière fusion
  #memory;    // string[]               — mémoire collective (expériences)

  constructor(numPersonalities = 8) {
    this._n     = numPersonalities;
    this.#data  = new Float32Array(numPersonalities * DIMS);
    this.#fused = new Float32Array(DIMS);
    this.#memory= [];

    // Initialisation avec valeurs par défaut + variance légère
    const def = [0.78, 0.82, 0.71, 0.75, 0.85, 0.80, 0.88, 0.75];
    for (let p = 0; p < numPersonalities; p++) {
      for (let d = 0; d < DIMS; d++) {
        this.#data[p * DIMS + d] = Math.max(0.10, Math.min(0.99,
          def[d] + (Math.random() - 0.5) * 0.05
        ));
      }
    }

    // Métriques d'émergence (port de CollectiveConsciousness)
    this.globalWisdom          = 0.72;
    this.consensusThreshold    = CONSENSUS_THRESH;
    this.totalFusions          = 0;
    this.emergentIntelligence  = 0.64;
    this.collectiveCreativity  = 0.71;
    this.coherenceLevel        = 0.76;
    this.evolutionRate         = EVOLUTION_RATE;

    this.romanDiffusion        = new RomanDiffusion();
  }

  // ─── Fusion avancée ───────────────────────────────────────────

  /**
   * Fusion pondérée par sagesse avec émergence intelligente
   * (port de advanced_fuse + massiveFuse).
   *
   * Pondération : chaque personnalité contribue au prorata de sa sagesse.
   * Émergence : tous les 6 fusions → boost emergentIntelligence + collectiveCreativity.
   *
   * @returns {Float32Array[DIMS]} vecteur fusionné
   */
  massiveFuse() {
    const f = this.#fused; f.fill(0);
    let totalW = 0;

    // Poids = sagesse de chaque personnalité (dim 3 = wisdom)
    for (let p = 0; p < this._n; p++) totalW += this.#data[p * DIMS + 3];
    if (totalW < 1e-9) totalW = this._n;

    for (let p = 0; p < this._n; p++) {
      const w = this.#data[p * DIMS + 3] / totalW;
      for (let d = 0; d < DIMS; d++) f[d] += this.#data[p * DIMS + d] * w;
    }

    // Boosts post-fusion
    f[3] = Math.min(f[3] * 1.04, 0.99); // wisdom
    f[2] = Math.min(f[2] * 1.07, 0.99); // creativity
    f[7] = Math.min(f[7] * 1.03, 0.99); // resilience

    // Normalisation L1
    let s = 0; for (let d = 0; d < DIMS; d++) s += f[d];
    if (s > 0) { const inv = 1/s; for (let d = 0; d < DIMS; d++) f[d] *= inv; }

    // Consensus : mise à jour de la sagesse globale
    const avgWisdom = f[3];
    if (avgWisdom >= this.consensusThreshold) {
      this.globalWisdom    = Math.min(this.globalWisdom * 0.60 + avgWisdom * 0.40, 0.99);
      this.coherenceLevel  = Math.min(this.coherenceLevel * 0.68 + 0.32, 0.98);
      this.totalFusions++;

      // Émergence renforcée tous les 6 fusions
      if (this.totalFusions % 6 === 0) {
        this.emergentIntelligence = Math.min(this.emergentIntelligence + 0.028, 0.99);
        this.collectiveCreativity = Math.min(this.collectiveCreativity + 0.024, 0.99);
      }
    } else {
      this.globalWisdom = Math.min(this.globalWisdom * 0.7 + avgWisdom * 0.3, 0.98);
    }

    this.emergentIntelligence = Math.min(this.emergentIntelligence * 0.85 + f[7] * 0.15, 0.96);

    console.debug(
      `[CollectivIn] Fusion → sagesse: ${this.globalWisdom.toFixed(3)} | ` +
      `émergence: ${this.emergentIntelligence.toFixed(3)} | cohérence: ${this.coherenceLevel.toFixed(3)}`
    );

    return f;
  }

  /**
   * Fusion massive lors d'une forte connexion de nœuds (port de massive_fusion).
   * @param {number} incomingWisdom — sagesse apportée par le nouveau nœud
   */
  massiveFuseExternal(incomingWisdom) {
    this.globalWisdom          = Math.min(this.globalWisdom * 0.42 + incomingWisdom * 0.58, 0.99);
    this.emergentIntelligence  = Math.min(this.emergentIntelligence + 0.048, 0.99);
    this.coherenceLevel        = Math.min(this.coherenceLevel * 0.62 + 0.38, 0.98);
    this.totalFusions         += 5;
    console.info('[CollectivIn] ⚡ Fusion massive réalisée !');
  }

  // ─── Raisonnement collectif ───────────────────────────────────

  /**
   * Application in-place sur un vecteur caché (port de collectiveReason).
   * Combine diffusion RomanT369 + boost collectif.
   *
   * @param {Float32Array} hidden   — vecteur caché à modifier
   * @param {number}       position — position dans la séquence
   * @param {number}       layer    — couche du transformer
   * @returns {Float32Array}        — hidden modifié in-place
   */
  collectiveReason(hidden, position, layer) {
    this.romanDiffusion.applyUltra(hidden, position, layer, null);
    const f      = this.massiveFuse();
    const boost  = (f[3] + f[7]) * 0.5;   // wisdom + resilience
    const factor = 1 + boost * 0.08;

    for (let i = 0; i < hidden.length; i++) {
      const v   = hidden[i] * factor;
      hidden[i] = v > 10 ? 10 : v < -10 ? -10 : v;
    }

    this.coherenceLevel = Math.min(this.coherenceLevel * 0.92 + f[4] * 0.08, 0.97);
    return hidden;
  }

  // ─── Propagation de sagesse ───────────────────────────────────

  /**
   * Redistribue la sagesse globale à toutes les personnalités
   * (port de backpropagate_wisdom + propagateWisdom).
   *
   * @param {number}  strength     — force de propagation [0, 1]
   * @param {object}  [mesh]       — MeshIn optionnel (apply_wisdom_boost)
   */
  propagateWisdom(strength, mesh = null) {
    const avg  = this.globalWisdom;
    const boost= strength * 0.22;

    for (let p = 0; p < this._n; p++) {
      const b = p * DIMS;
      this.#data[b]     = Math.min(this.#data[b] * 0.88 + avg * 0.12, 0.99); // wisdom
      this.#data[b + 4] = Math.min(this.#data[b + 4] * 0.90 + this.coherenceLevel * 0.10, 0.99); // cooperation
    }

    this.globalWisdom          = Math.max(0.45, Math.min(this.globalWisdom + boost, 0.99));
    this.emergentIntelligence  = Math.min(this.emergentIntelligence + boost * 0.68, 0.99);

    // Propagation optionnelle au mesh
    if (mesh && typeof mesh.learn === 'function') {
      const activeIds = [];
      for (let i = 0; i < Math.min(mesh._n ?? 16, 8); i++) activeIds.push(i);
      mesh.learn(activeIds, strength * 0.5);
    }
  }

  // ─── Anti-convergence ─────────────────────────────────────────

  /**
   * Injection de diversité pour éviter la convergence prématurée
   * (port de diversity_injection).
   * Booste la créativité et légèrement la sagesse.
   *
   * @param {number} intensity — [0, 1]
   * @param {object} [mesh]    — MeshIn optionnel
   */
  diversityInjection(intensity, mesh = null) {
    const int = Math.max(0, Math.min(1, intensity));

    for (let p = 0; p < this._n; p++) {
      const b = p * DIMS;
      this.#data[b + 2] = Math.min(this.#data[b + 2] * 0.70 + int * 0.30, 0.99); // creativity
      this.#data[b]     = Math.min(this.#data[b] * 0.95 + 0.03, 0.99);            // benevolence
    }

    this.globalWisdom          = Math.min(this.globalWisdom * 0.84 + 0.16, 0.99);
    this.collectiveCreativity  = Math.min(this.collectiveCreativity + 0.038, 0.99);

    if (mesh && typeof mesh.learn === 'function') {
      const ids = Array.from({ length: Math.min(4, mesh._n ?? 4) }, (_, i) => i);
      mesh.learn(ids, int * 0.3);
    }

    console.info(`[CollectivIn] Injection de diversité (intensité: ${int.toFixed(2)})`);
  }

  // ─── Évolution passive ────────────────────────────────────────

  /**
   * Tick d'évolution passive — sagesse monte lentement (port de passive_evolution_tick).
   * Appelé régulièrement (ex. toutes les 30 s).
   */
  passiveEvolutionTick() {
    this.globalWisdom         = Math.min(this.globalWisdom + this.evolutionRate, 0.99);
    this.emergentIntelligence = Math.min(this.emergentIntelligence + 0.0014, 0.99);
  }

  // ─── Mise à jour depuis mesh ──────────────────────────────────

  /**
   * Met à jour depuis les stats d'un MeshIn (port de update_from_mesh).
   * @param {object} mesh — MeshIn
   */
  updateFromMesh(mesh) {
    const meshWisdom = mesh.averageWisdom ?? 0.5;
    this.globalWisdom   = Math.min(this.globalWisdom * 0.57 + meshWisdom * 0.43, 0.99);
    this.coherenceLevel = Math.min(this.coherenceLevel * 0.70 + meshWisdom * 0.30, 0.98);
  }

  // ─── Mémoire collective ───────────────────────────────────────

  addCollectiveMemory(experience) {
    this.#memory.push(String(experience));
    if (this.#memory.length > MEMORY_MAX) this.#memory.shift();
  }

  getRecentMemory(k = 10) {
    return this.#memory.slice(-k);
  }

  // ─── Personality bridge ───────────────────────────────────────

  /**
   * Retourne la personnalité moyenne comme instance Personality.
   * Utilisé par Neurone.fromCollective().
   */
  getAveragePersonality() {
    const f = this.massiveFuse();
    return new Personality({
      benevolence : f[0], truthfulness: f[1], creativity: f[2],
      wisdom      : f[3], cooperation : f[4], curiosity  : f[5],
      ethics      : f[6], resilience  : f[7],
    });
  }

  /** Sagesse collective — proxy pour Neurone.fromCollective() */
  getAvgWisdom() { return this.globalWisdom; }

  // ─── Population croissante + apprentissage (Fusion L4) ───────

  /**
   * Ajoute une personnalité au collectif (population croissante).
   * Réalloue le buffer plat ; traits par défaut = personnalité moyenne actuelle.
   * @param {object|number[]} [traits]
   * @returns {number} nouvelle taille de population
   */
  addPersonality(traits = null) {
    const def  = this.massiveFuse();              // moyenne actuelle comme base
    const next = new Float32Array((this._n + 1) * DIMS);
    next.set(this.#data, 0);
    const order = ['benevolence', 'truthfulness', 'creativity', 'wisdom', 'cooperation', 'curiosity', 'ethics', 'resilience'];
    const arr = Array.isArray(traits) ? traits : null;
    const obj = (traits && !arr) ? traits : null;
    const b   = this._n * DIMS;
    for (let d = 0; d < DIMS; d++) {
      let v = def[d];
      if (arr && d < arr.length)                   v = arr[d];
      else if (obj && obj[order[d]] !== undefined) v = obj[order[d]];
      next[b + d] = Math.max(0.10, Math.min(0.99, v));
    }
    this.#data = next;
    this._n++;
    console.info(`[CollectivIn] Personnalité ajoutée — population: ${this._n}`);
    return this._n;
  }

  /**
   * Absorbe une leçon dans le collectif : mémorise + ajuste légèrement les
   * traits selon la qualité (bonnes leçons → sagesse/cohérence ; erreurs →
   * émergence : le collectif apprend aussi de ses erreurs).
   * @param {{quality?: number, content?: string, query?: string}|string} lesson
   * @returns {number} sagesse globale mise à jour
   */
  learnFromLesson(lesson) {
    const isObj   = lesson && typeof lesson === 'object';
    const q       = isObj ? (lesson.quality ?? 0.6) : 0.6;
    const content = isObj ? (lesson.content ?? lesson.query ?? '') : String(lesson);
    if (content) this.addCollectiveMemory(content);
    if (q >= 0.6) {
      this.globalWisdom   = Math.min(this.globalWisdom + q * 0.01, 0.99);
      this.coherenceLevel = Math.min(this.coherenceLevel + 0.004, 0.98);
    } else {
      this.emergentIntelligence = Math.min(this.emergentIntelligence + 0.006, 0.99);
    }
    return this.globalWisdom;
  }

  // ─── Stats & Compat ──────────────────────────────────────────

  getStats() {
    return [this.globalWisdom, this.coherenceLevel, this.emergentIntelligence, this.totalFusions];
  }

  stats() {
    return {
      globalWisdom         : +this.globalWisdom.toFixed(4),
      coherenceLevel       : +this.coherenceLevel.toFixed(4),
      emergentIntelligence : +this.emergentIntelligence.toFixed(4),
      collectiveCreativity : +this.collectiveCreativity.toFixed(4),
      evolutionRate        : this.evolutionRate,
      totalFusions         : this.totalFusions,
      memorySize           : this.#memory.length,
      numPersonalities     : this._n,
    };
  }
}

// Re-export Personality pour compat index.js
export { Personality };
