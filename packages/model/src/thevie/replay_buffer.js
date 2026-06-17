// packages/model/src/thevie/memory/replay_buffer.js
// =====================================================
// Replay Buffer — Prioritized + Reflective + Anti-Oubli
// Port de replay_buffer.rs
// SkyAInet × Nikola T369
// =====================================================

"use strict";

// ─────────────────────────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────────────────────────

const DEFAULT_CAPACITY   = 2048;
const RECENT_MAX         = 64;
const QUERY_KEY_LEN      = 50;
const IMPORTANCE_FLOOR   = 0.15;
const WEIGHT_EXPONENT    = 0.60;    // IS-weight β (port de .powf(0.6))
const SIMILARITY_THRESH  = 0.35;   // seuil Jaccard pour reflect

// ─────────────────────────────────────────────────────────────────
// EXPERIENCE
// ─────────────────────────────────────────────────────────────────

export class Experience {
  constructor({ query, response, quality, timestamp = null, errorType = null, importance = null }) {
    this.query      = query;
    this.response   = response;
    this.quality    = Math.max(0, Math.min(1, quality));
    this.timestamp  = timestamp ?? Date.now();
    this.errorType  = errorType ?? null;
    // importance inversement proportionnelle à la qualité — les mauvaises expériences prioritaires
    this.importance = importance ?? Math.max(IMPORTANCE_FLOOR, 1.0 - this.quality);
  }
}

// ─────────────────────────────────────────────────────────────────
// REPLAY BUFFER
//
// Buffer circulaire avec :
//   push()               — ajout avec anti-répétition + priorité
//   prioritizedSample()  — échantillonnage proportionnel à l'importance
//   sample()             — échantillonnage uniforme
//   reflectOnPastErrors()— détection d'erreurs similaires (Jaccard)
//   prune()              — suppression des expériences < minQuality
//   stats()              — métriques complètes
// ─────────────────────────────────────────────────────────────────

export class ReplayBuffer {
  #buffer;          // Experience[] — anneau circulaire (head = 0)
  #head;            // indice de la prochaine écriture
  #size;            // nombre d'expériences réellement stockées
  #capacity;
  #totalSamples;
  #totalQualitySum;
  #recentQueries;   // string[] — clés des N dernières requêtes (anti-répétition)

  constructor(capacity = DEFAULT_CAPACITY) {
    this.#capacity       = Math.max(1, capacity);
    this.#buffer         = new Array(this.#capacity).fill(null);
    this.#head           = 0;
    this.#size           = 0;
    this.#totalSamples   = 0;
    this.#totalQualitySum= 0;
    this.#recentQueries  = [];
  }

  // ─── Ajout ───────────────────────────────────────────────────

  /**
   * Ajoute une expérience avec gestion de l'importance et anti-répétition.
   * Les requêtes récentes déjà vues ont leur importance réduite de moitié.
   *
   * @param {Experience|object} exp
   */
  push(exp) {
    const e = exp instanceof Experience ? exp : new Experience(exp);

    // Anti-répétition : réduire l'importance si requête récente
    const key = e.query.toLowerCase().slice(0, QUERY_KEY_LEN);
    if (this.#recentQueries.includes(key)) {
      e.importance *= 0.5;
    }

    // Anneau circulaire : écraser la plus ancienne entrée
    const old = this.#buffer[this.#head];
    if (old !== null) {
      this.#totalQualitySum -= old.quality;
      this.#size = Math.max(0, this.#size - 1);
    }

    this.#buffer[this.#head] = e;
    this.#head = (this.#head + 1) % this.#capacity;
    this.#size++;
    this.#totalSamples++;
    this.#totalQualitySum += e.quality;

    // Mise à jour anneau anti-répétition
    this.#recentQueries.push(key);
    if (this.#recentQueries.length > RECENT_MAX) this.#recentQueries.shift();
  }

  // ─── Échantillonnage prioritaire ─────────────────────────────

  /**
   * Échantillonnage proportionnel à l'importance (Prioritized Experience Replay).
   * Poids IS = (importance / totalImportance)^β pour corriger le biais.
   *
   * @param {number} batchSize
   * @returns {{ exp: Experience, weight: number }[]}
   */
  prioritizedSample(batchSize) {
    const all = this.#toArray();
    if (all.length === 0) return [];

    const totalImportance = all.reduce((s, e) => s + e.importance, 0);
    if (totalImportance < 0.01) {
      return this.sample(batchSize).map(exp => ({ exp, weight: 1 }));
    }

    const result = [];
    const n      = Math.min(batchSize, all.length);

    for (let i = 0; i < n; i++) {
      const target = Math.random() * totalImportance;
      let cumul    = 0;
      for (const exp of all) {
        cumul += exp.importance;
        if (cumul >= target) {
          const weight = Math.pow(exp.importance / totalImportance, WEIGHT_EXPONENT);
          result.push({ exp, weight });
          break;
        }
      }
    }

    return result;
  }

  /**
   * Échantillonnage uniforme classique.
   * @param {number} batchSize
   * @returns {Experience[]}
   */
  sample(batchSize) {
    const all = this.#toArray();
    if (all.length === 0) return [];
    const result = [];
    const n      = Math.min(batchSize, all.length);
    for (let i = 0; i < n; i++) {
      result.push(all[Math.floor(Math.random() * all.length)]);
    }
    return result;
  }

  /**
   * Récupère les N expériences les plus récentes de haute qualité.
   * @param {number} k
   * @param {number} minQuality
   */
  getBestRecent(k = 8, minQuality = 0.7) {
    return this.#toArray()
      .filter(e => e.quality >= minQuality)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, k);
  }

  // ─── Réflexion sur les erreurs passées ───────────────────────

  /**
   * Détecte les expériences passées de faible qualité similaires à la requête courante.
   * Similarité mesurée par Jaccard sur les mots (port de reflect_on_past_errors).
   *
   * @param {string} currentQuery
   * @param {number} [maxResults]
   * @returns {string[]} — messages de mise en garde
   */
  reflectOnPastErrors(currentQuery, maxResults = 5) {
    const qLower = currentQuery.toLowerCase();
    const results = [];

    const recent = [...this.#toArray()].reverse().slice(0, 15);
    for (const exp of recent) {
      if (exp.quality < 0.6) {
        const sim = _jaccard(qLower, exp.query.toLowerCase());
        if (sim > SIMILARITY_THRESH) {
          results.push(
            `⚠️ Erreur similaire : "${exp.query.slice(0, 55)}" (qualité: ${exp.quality.toFixed(2)}, sim: ${sim.toFixed(2)})`
          );
          if (results.length >= maxResults) break;
        }
      }
    }

    return results.length > 0 ? results : ['Aucune erreur similaire détectée.'];
  }

  // ─── Maintenance ─────────────────────────────────────────────

  /**
   * Supprime les expériences sous un seuil de qualité minimum.
   * @param {number} minQuality
   * @returns {number} nombre d'expériences supprimées
   */
  prune(minQuality = 0.3) {
    const before = this.#size;
    const kept   = this.#toArray().filter(e => e.quality >= minQuality);

    // Reset et réinsertion
    this.#buffer = new Array(this.#capacity).fill(null);
    this.#head   = 0;
    this.#size   = 0;
    this.#totalQualitySum = 0;

    for (const e of kept) {
      this.#buffer[this.#head] = e;
      this.#head = (this.#head + 1) % this.#capacity;
      this.#size++;
      this.#totalQualitySum += e.quality;
    }

    return before - this.#size;
  }

  // ─── Stats & Accesseurs ──────────────────────────────────────

  stats() {
    const avgQuality = this.#size > 0 ? this.#totalQualitySum / this.#size : 0;
    const all        = this.#toArray();
    const errRate    = this.#size > 0
      ? all.filter(e => e.quality < 0.6).length / this.#size : 0;

    return {
      size         : this.#size,
      capacity     : this.#capacity,
      totalSamples : this.#totalSamples,
      avgQuality   : +avgQuality.toFixed(4),
      errorRate    : +errRate.toFixed(4),
      recentQueries: this.#recentQueries.length,
    };
  }

  get size()         { return this.#size; }
  get totalSamples() { return this.#totalSamples; }
  get isEmpty()      { return this.#size === 0; }

  // ─── Bridge replay → entraînement (Fusion L2) ────────────────

  /**
   * Met à jour la priorité (importance) d'une expérience après apprentissage
   * (mise à jour de priorité façon TD-error de PER).
   */
  updatePriority(exp, importance) {
    if (exp) exp.importance = Math.max(IMPORTANCE_FLOOR, importance);
    return this;
  }

  /**
   * Extrait un lot d'expériences en leçons textuelles pour le Test-Time Training
   * du LoRA. Par défaut priorise les expériences importantes (= erreurs) →
   * apprentissage ciblé sur les points faibles.
   * @param {number} k
   * @param {{prioritized?: boolean}} [opts]
   * @returns {string[]}
   */
  toLessons(k = 16, { prioritized = true } = {}) {
    const batch = prioritized
      ? this.prioritizedSample(k).map(x => x.exp)
      : this.sample(k);
    return batch
      .filter(e => e && e.query && e.response)
      .map(e => `Q: ${e.query}\nR: ${e.response}`);
  }

  // ─── Privé ───────────────────────────────────────────────────

  /** Retourne un tableau de toutes les expériences non-null. */
  #toArray() {
    return this.#buffer.filter(e => e !== null);
  }
}

// ─────────────────────────────────────────────────────────────────
// HELPER — similarité Jaccard sur les mots
// ─────────────────────────────────────────────────────────────────

function _jaccard(a, b) {
  const sa = new Set(a.split(/\s+/).filter(Boolean));
  const sb = new Set(b.split(/\s+/).filter(Boolean));
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter++;
  const union = sa.size + sb.size - inter;
  return union > 0 ? inter / union : 0;
}
