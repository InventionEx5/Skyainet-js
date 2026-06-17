// packages/model/src/thevie/critic.js
// =====================================================
// Critic — Auto-critique & génération de signal d'entraînement (Fusion L4)
//
// Évalue les réponses du système (qualité, pertinence, défauts), produit une
// critique structurée, et transforme les réponses faibles en leçons
// correctives. C'est le générateur de signal du volant d'évolution :
// le système apprend de ses propres erreurs détectées.
//
// Deux modes :
//   • Heuristique (toujours dispo, zéro dépendance) — pertinence, densité,
//     répétition, marqueurs d'erreur.
//   • LLM (optionnel) — critique générée par une IA injectée (generateFn),
//     pour une évaluation sémantique fine.
//
// SkyAInet × Thevie × Nikola T369
// =====================================================

"use strict";

// Seuils
const LESSON_THRESHOLD = 0.55;   // sous ce score → leçon corrective
const SHORT_RESPONSE   = 12;     // mots — en dessous = potentiellement trop court
const ERROR_MARKERS = [
  '[moteur non prêt]', 'error', 'erreur', 'undefined', 'null',
  "i don't know", 'je ne sais pas', 'i cannot', 'as an ai',
];

// ─────────────────────────────────────────────────────────────────
// CRITIQUE — résultat structuré
// ─────────────────────────────────────────────────────────────────

export class Critique {
  constructor({ score, relevance, density, issues = [], suggestion = '', isLesson = false }) {
    this.score      = score;
    this.relevance  = relevance;
    this.density    = density;
    this.issues     = issues;
    this.suggestion = suggestion;
    this.isLesson   = isLesson;
  }
}

// ─────────────────────────────────────────────────────────────────
// CRITIC
// ─────────────────────────────────────────────────────────────────

export class Critic {
  #generateFn;     // optionnel : async (prompt, opts) => text | {text}
  #threshold;
  #history;        // critiques récentes (ring 128)
  #count;

  constructor(opts = {}) {
    this.#generateFn = typeof opts.generate === 'function' ? opts.generate : null;
    this.#threshold  = opts.lessonThreshold ?? LESSON_THRESHOLD;
    this.#history    = [];
    this.#count      = 0;
  }

  // ─── Critique heuristique (synchrone, zéro dépendance) ───────

  /**
   * Évalue une paire (question, réponse) et renvoie une critique structurée.
   * @param {string} query
   * @param {string} response
   * @param {{reference?: string}} [opts] — réponse de référence facultative
   * @returns {Critique}
   */
  critique(query, response, { reference = null } = {}) {
    const q = String(query ?? '');
    const r = String(response ?? '');
    const issues = [];

    // 1. Pertinence — recouvrement lexical query ↔ response
    const relevance = _jaccard(_tokens(q), _tokens(r));
    if (relevance < 0.05 && q.length > 0) issues.push('hors-sujet');

    // 2. Densité — diversité lexicale (anti-répétition)
    const words  = r.split(/\s+/).filter(Boolean);
    const unique = new Set(r.toLowerCase().match(/\b\w+\b/g) ?? []).size;
    const density = words.length > 0 ? unique / words.length : 0;
    if (density < 0.4 && words.length > 8) issues.push('répétitif');

    // 3. Longueur
    if (words.length < SHORT_RESPONSE) issues.push('trop court');

    // 4. Marqueurs d'erreur / refus
    const lower = r.toLowerCase();
    if (ERROR_MARKERS.some(m => lower.includes(m))) issues.push("marqueur d'erreur/refus");
    if (!r.trim()) issues.push('réponse vide');

    // 5. Référence (si fournie) — recouvrement avec la réponse attendue
    let refMatch = null;
    if (reference) {
      refMatch = _jaccard(_tokens(r), _tokens(String(reference)));
      if (refMatch < 0.2) issues.push("s'écarte de la référence");
    }

    // Score composite [0,1]
    let score =
      0.35 * _clamp(relevance * 2.2) +     // pertinence (amplifiée)
      0.25 * _clamp(density) +
      0.20 * _clamp(words.length / 80) +
      0.20 * (refMatch !== null ? _clamp(refMatch * 1.5) : 0.6);
    score = _clamp(score - issues.length * 0.06);   // pénalité par défaut détecté

    const crit = new Critique({
      score     : +score.toFixed(3),
      relevance : +relevance.toFixed(3),
      density   : +density.toFixed(3),
      issues,
      suggestion: this.#buildSuggestion(issues),
      isLesson  : score < this.#threshold,
    });
    this.#record(crit);
    return crit;
  }

  // ─── Critique sémantique via IA (optionnel, async) ───────────

  /**
   * Enrichit la critique heuristique d'une évaluation par une IA injectée.
   * @returns {Promise<Critique & {aiCritique?: string, aiScore?: number}>}
   */
  async critiqueWithAI(query, response, { ai = 'thevie' } = {}) {
    const base = this.critique(query, response);
    if (!this.#generateFn) return base;

    const prompt =
      `Évalue cette réponse de façon critique et concise.\n` +
      `Question: ${String(query).slice(0, 300)}\n` +
      `Réponse: ${String(response).slice(0, 500)}\n` +
      `Donne : (1) une note /10, (2) les faiblesses, (3) une version améliorée en une phrase.`;
    try {
      const r    = await this.#generateFn(prompt, { ai, temperature: 0.3, maxTokens: 200 });
      const text = (r?.text ?? r ?? '').toString();
      base.aiCritique = text.trim();
      const m = text.match(/(\d+(?:\.\d+)?)\s*\/\s*10/);
      if (m) base.aiScore = Math.max(0, Math.min(1, parseFloat(m[1]) / 10));
    } catch {
      base.aiCritique = null;
    }
    return base;
  }

  // ─── Réponse faible → leçon corrective (signal du volant) ────

  /**
   * Transforme une réponse critiquée en leçon d'entraînement corrective.
   * Avec référence → enseigne la bonne réponse ; sinon → marque à retravailler.
   * @returns {string|null} leçon prête pour l'entraînement, ou null si réponse OK
   */
  toLesson(query, response, { reference = null, force = false } = {}) {
    const crit = this.critique(query, response, { reference });
    if (!crit.isLesson && !force) return null;
    if (reference) return `Q: ${query}\nR: ${reference}`;   // enseigne la bonne réponse
    const fixes = crit.issues.length ? ` (à corriger: ${crit.issues.join(', ')})` : '';
    return `Q: ${query}\nR: [réponse à améliorer${fixes}] ${String(response).slice(0, 200)}`;
  }

  /** Critique un lot de paires → critiques + leçons correctives + résumé. */
  batchCritique(pairs, { reference = false } = {}) {
    const critiques = [];
    const lessons   = [];
    for (const p of pairs) {
      const ref = reference ? (p.reference ?? null) : null;
      const c   = this.critique(p.query, p.response, { reference: ref });
      critiques.push(c);
      if (c.isLesson) {
        const l = this.toLesson(p.query, p.response, { reference: ref });
        if (l) lessons.push(l);
      }
    }
    const avg = critiques.length ? critiques.reduce((s, c) => s + c.score, 0) / critiques.length : 0;
    return {
      critiques, lessons,
      avgScore : +avg.toFixed(3),
      weakCount: lessons.length,
      total    : critiques.length,
    };
  }

  stats() {
    const n   = this.#history.length;
    const avg = n ? this.#history.reduce((s, c) => s + c.score, 0) / n : 0;
    return {
      totalCritiques: this.#count,
      windowAvgScore: +avg.toFixed(3),
      hasAI         : !!this.#generateFn,
      threshold     : this.#threshold,
    };
  }

  // ─── Privé ────────────────────────────────────────────────────

  #buildSuggestion(issues) {
    if (issues.length === 0) return 'Réponse satisfaisante.';
    const map = {
      'hors-sujet'               : 'recentrer sur la question',
      'répétitif'                : 'varier le vocabulaire',
      'trop court'               : 'développer davantage',
      "marqueur d'erreur/refus"  : 'fournir une vraie réponse',
      'réponse vide'             : 'générer une réponse',
      "s'écarte de la référence" : 'se rapprocher de la réponse attendue',
    };
    return issues.map(i => map[i] ?? i).join(' ; ');
  }

  #record(crit) {
    this.#count++;
    this.#history.push(crit);
    if (this.#history.length > 128) this.#history.shift();
  }
}

export default Critic;

// ─────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────

function _tokens(text) {
  return new Set(String(text).toLowerCase().match(/\b\w+\b/g) ?? []);
}

function _jaccard(a, b) {
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  const union = a.size + b.size - inter;
  return union > 0 ? inter / union : 0;
}

function _clamp(x) { return Math.max(0, Math.min(1, x)); }
