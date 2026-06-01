// packages/secure/src/utils/markov.js
// =====================================================
// Markov Chain — Stéganographie Textuelle Intelligente
// SkyAInet × Nikola T369
// =====================================================

"use strict";

// ─────────────────────────────────────────────────────────────────
// ERREUR TYPÉE
// ─────────────────────────────────────────────────────────────────

export class MarkovError extends Error {
  constructor(message, code = 'MARKOV_ERROR') {
    super(message);
    this.name = 'MarkovError';
    this.code = code;
  }
}

// ─────────────────────────────────────────────────────────────────
// MARKOV CHAIN (ordre 1)
//
// Chaîne de Markov d'ordre 1 entraînée sur du texte naturel.
// La génération utilise une sélection pondérée par fréquence —
// les transitions fréquentes sont favorisées sans être exclusives,
// produisant un texte plus naturel que le sampling uniforme.
//
// Usage stéganographique : les messages cachés guident le choix
// du mot de départ pour encoder un bit dans chaque phrase générée.
// ─────────────────────────────────────────────────────────────────

export class MarkovChain {
  // Map<word, Map<nextWord, count>>
  #transitions;
  // Mots de départ pondérés (début de phrase après ponctuation)
  #starters;
  #totalTransitions;

  constructor() {
    this.#transitions      = new Map();
    this.#starters         = [];
    this.#totalTransitions = 0;
  }

  // ─── Entraînement ────────────────────────────────────────────

  /**
   * Entraîne la chaîne sur un texte brut.
   * Les mots en début de phrase (après '.', '!', '?') sont marqués
   * comme starters pour generateRandom().
   *
   * @param {string} text
   */
  train(text) {
    if (!text?.trim()) return;

    // Normalisation légère : collapse whitespace, garder la ponctuation
    const words = text.trim().split(/\s+/).filter(Boolean);
    if (words.length < 2) return;

    let newSentence = true;

    for (let i = 0; i < words.length - 1; i++) {
      const current = words[i];
      const next    = words[i + 1];

      if (newSentence) {
        this.#starters.push(current);
        newSentence = false;
      }

      // Détection fin de phrase
      if (/[.!?]$/.test(current)) newSentence = true;

      if (!this.#transitions.has(current)) {
        this.#transitions.set(current, new Map());
      }
      const nextMap = this.#transitions.get(current);
      nextMap.set(next, (nextMap.get(next) ?? 0) + 1);
      this.#totalTransitions++;
    }
  }

  /**
   * Entraîne à partir du champ `notes` d'un Contact (compatibilité).
   * @param {{ notes?: string }} contact
   */
  trainFromContact(contact) {
    if (contact?.notes) this.train(contact.notes);
  }

  /**
   * Entraîne sur plusieurs textes à la fois.
   * @param {string[]} corpus
   */
  trainBatch(corpus) {
    for (const text of corpus) this.train(text);
  }

  // ─── Génération ───────────────────────────────────────────────

  /**
   * Génère un texte à partir d'un mot de départ.
   *
   * Sélection pondérée par fréquence de transition :
   * si "the" → { "quick": 3, "slow": 1 }, "quick" est choisi 75 % du temps.
   *
   * @param {string} start   — mot de départ (doit être dans le corpus)
   * @param {number} length  — nombre max de mots générés après `start`
   * @returns {string}
   */
  generate(start, length = 20) {
    if (!this.isTrained()) {
      throw new MarkovError('Chaîne non entraînée — appelle train() d\'abord', 'NOT_TRAINED');
    }

    let   current = start;
    const result  = [current];

    for (let i = 0; i < length; i++) {
      const nextMap = this.#transitions.get(current);
      if (!nextMap || nextMap.size === 0) break;

      // Sélection pondérée
      let total = 0;
      for (const count of nextMap.values()) total += count;

      let r       = Math.floor(Math.random() * total);
      let chosen  = null;
      for (const [word, count] of nextMap) {
        r -= count;
        if (r < 0) { chosen = word; break; }
      }
      if (!chosen) break;

      result.push(chosen);
      current = chosen;
    }

    if (result.length < 2) {
      throw new MarkovError(
        `Mot de départ "${start}" introuvable dans la chaîne ou sans successeur`,
        'START_NOT_FOUND'
      );
    }

    return result.join(' ');
  }

  /**
   * Génère à partir d'un starter aléatoire (début de phrase du corpus).
   * @param {number} length
   * @returns {string}
   */
  generateRandom(length = 20) {
    if (!this.isTrained()) {
      throw new MarkovError('Chaîne non entraînée', 'NOT_TRAINED');
    }
    const starters = this.#starters.length > 0
      ? this.#starters
      : [...this.#transitions.keys()];
    const start = starters[Math.floor(Math.random() * starters.length)];
    return this.generate(start, length);
  }

  /**
   * Génère N variantes à partir de starters différents.
   * Utile pour la stéganographie : chaque variante encode un bit différent.
   *
   * @param {number} count  — nombre de variantes
   * @param {number} length — longueur de chaque variante
   * @returns {string[]}
   */
  generateVariants(count, length = 20) {
    const results = [];
    const pool    = this.#starters.length > 0
      ? [...this.#starters]
      : [...this.#transitions.keys()];

    // Shuffle pour diversifier les starters
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }

    for (let i = 0; i < count; i++) {
      const start = pool[i % pool.length];
      try {
        results.push(this.generate(start, length));
      } catch {
        // Starter sans successeur — on saute
      }
    }
    return results;
  }

  // ─── Métriques & état ─────────────────────────────────────────

  isTrained()          { return this.#transitions.size > 0; }
  get vocabularySize() { return this.#transitions.size; }
  get transitions()    { return this.#totalTransitions; }

  /**
   * Retourne les N mots les plus fréquents comme starters.
   */
  topStarters(n = 10) {
    const freq = new Map();
    for (const w of this.#starters) freq.set(w, (freq.get(w) ?? 0) + 1);
    return [...freq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([word, count]) => ({ word, count }));
  }

  stats() {
    return {
      vocabulary        : this.#transitions.size,
      totalTransitions  : this.#totalTransitions,
      starters          : this.#starters.length,
      uniqueStarters    : new Set(this.#starters).size,
    };
  }

  /** Réinitialise la chaîne */
  reset() {
    this.#transitions.clear();
    this.#starters.length  = 0;
    this.#totalTransitions = 0;
  }
}
