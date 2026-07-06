// packages/node/src/space_ai.js
// =====================================================
// Space AI — Trilogue multi-agents (Fusion L4)
//
// Trois rôles d'IA débattent pour produire une meilleure réponse qu'un
// agent seul (inference-time reasoning par débat) :
//   • Proposer    — propose une réponse initiale
//   • Critic      — repère failles, oublis, erreurs, angles manquants
//   • Synthesizer — fusionne proposition + critique en réponse finale
//
// Multi-tours : la synthèse d'un tour devient la proposition du suivant,
// jusqu'à convergence (stabilité) ou nombre de tours max.
//
// L'IA est injectée via une fonction generate(prompt, {role, temperature}).
// Indépendant du moteur — testable avec un générateur factice.
//
// SkyAInet × Thevie × Nikola T369
// =====================================================

"use strict";

const ROLES = Object.freeze({
  proposer    : { temperature: 0.8, system: 'Tu proposes une réponse claire, complète et utile.' },
  critic      : { temperature: 0.4, system: 'Tu critiques rigoureusement : failles, oublis, erreurs, angles manquants. Sois bref et précis.' },
  synthesizer : { temperature: 0.5, system: 'Tu fusionnes la proposition et la critique en une réponse finale améliorée.' },
});

const CONVERGENCE_SIM = 0.85;   // similarité au-delà de laquelle on considère convergé

// ─────────────────────────────────────────────────────────────────
// SPACE AI
// ─────────────────────────────────────────────────────────────────

export class SpaceAI {
  #generate;     // async (prompt, {role, temperature, ai, maxTokens}) => text | {text}
  #maxRounds;
  #minRounds;
  #names;
  #history;

  /**
   * @param {object}   opts
   * @param {Function} opts.generate — async (prompt, {role,...}) => text|{text}
   * @param {number}   [opts.maxRounds]
   * @param {{proposer?,critic?,synthesizer?}} [opts.names] — noms des 3 IA
   */
  constructor(opts = {}) {
    if (typeof opts.generate !== 'function') {
      throw new Error('[SpaceAI] opts.generate (async fn) requis');
    }
    this.#generate  = opts.generate;
    this.#maxRounds = Math.max(1, opts.maxRounds ?? 2);
    this.#minRounds = Math.max(1, opts.minRounds ?? 6);   // plancher : même un sujet simple reçoit ≥ minRounds rounds (jamais bâclé)
    this.#names = {
      proposer   : opts.names?.proposer    ?? 'Thevie',
      critic     : opts.names?.critic      ?? 'T369',
      synthesizer: opts.names?.synthesizer ?? 'LoraÉvo',
    };
    this.#history = [];
  }

  /**
   * Lance le trilogue sur une question.
   * @param {string} query
   * @param {{rounds?: number, context?: string}} [opts]
   * @returns {Promise<{ answer, rounds, transcript, converged }>}
   */
  async trilogue(query, opts = {}) {
    const minRounds = Math.max(1, opts.minRounds ?? this.#minRounds);
    const maxRounds = Math.max(minRounds, Math.min(opts.rounds ?? this.#maxRounds, 12));   // plafond 12
    const context   = opts.context ? `Contexte: ${opts.context}\n` : '';
    const transcript = [];

    let prevSynth = '';
    let answer    = '';
    let converged = false;
    let roundsRun = 0;

    // Structure B : chaque round = Proposeur + Critique + Synthétiseur (les 3 parlent).
    for (let round = 1; round <= maxRounds; round++) {
      const proposal = await this.#run('proposer', round === 1
        ? `${context}Question: ${query}\n\nPropose ta meilleure réponse, complète et rigoureuse.`
        : `${context}Question: ${query}\n\nMeilleure réponse actuelle:\n${prevSynth}\n\nRe-propose une version améliorée (angle neuf, plus complète). Un sujet simple reste important : ne bâcle pas.`);
      transcript.push({ role: 'proposer', ai: this.#names.proposer, round, text: proposal });

      const critique = await this.#run('critic',
        `${context}Question: ${query}\n\nRéponse proposée:\n${proposal}\n\nListe rigoureusement les faiblesses, oublis et angles manquants.`);
      transcript.push({ role: 'critic', ai: this.#names.critic, round, text: critique });

      const synthesis = await this.#run('synthesizer',
        `${context}Question: ${query}\n\nProposition:\n${proposal}\n\nCritique:\n${critique}\n\nProduis la réponse finale améliorée qui répond à la critique.`);
      transcript.push({ role: 'synthesizer', ai: this.#names.synthesizer, round, text: synthesis });

      answer = synthesis;
      roundsRun = round;

      // Convergence autorisée SEULEMENT après minRounds (le simple reçoit >= minRounds rounds solides).
      if (round >= minRounds && prevSynth && _similarity(prevSynth, synthesis) > CONVERGENCE_SIM) {
        converged = true; break;
      }
      prevSynth = synthesis;
    }

    const result = { answer, rounds: roundsRun, transcript, converged };
    this.#history.push({ query, answer, at: Date.now() });
    return result;
  }

  /**
   * Débat libre : N voix proposent en parallèle (températures variées) puis
   * synthèse de toutes les propositions (diversité, façon ensemble).
   * @returns {Promise<{ answer, proposals, voices }>}
   */
  async debate(query, { voices = 3, context = '' } = {}) {
    const ctx   = context ? `Contexte: ${context}\n` : '';
    const temps = [0.4, 0.7, 1.0];
    const proposals = [];
    for (let i = 0; i < Math.max(2, voices); i++) {
      proposals.push(await this.#run('proposer',
        `${ctx}Question: ${query}\n\nDonne ta perspective (angle ${i + 1}).`,
        temps[i % temps.length]));
    }
    const merged = await this.#run('synthesizer',
      `${ctx}Question: ${query}\n\nPerspectives:\n` +
      proposals.map((p, i) => `[${i + 1}] ${p}`).join('\n\n') +
      `\n\nSynthétise la meilleure réponse combinant ces perspectives.`);
    return { answer: merged, proposals, voices: proposals.length };
  }

  stats() {
    return { triloguesRun: this.#history.length, maxRounds: this.#maxRounds, names: { ...this.#names } };
  }

  // ─── Privé ────────────────────────────────────────────────────

  async #run(role, prompt, temperatureOverride = null) {
    const cfg        = ROLES[role];
    const fullPrompt = `${cfg.system}\n\n${prompt}`;
    try {
      const r = await this.#generate(fullPrompt, {
        role,
        ai         : this.#names[role],
        temperature: temperatureOverride ?? cfg.temperature,
        maxTokens  : 400,
      });
      return (r?.text ?? r ?? '').toString().trim() || '[réponse vide]';
    } catch (e) {
      return `[${role} indisponible: ${e.message}]`;
    }
  }
}

export default SpaceAI;

// ─────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────

function _similarity(a, b) {
  const sa = new Set(String(a).toLowerCase().match(/\b\w+\b/g) ?? []);
  const sb = new Set(String(b).toLowerCase().match(/\b\w+\b/g) ?? []);
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter++;
  const union = sa.size + sb.size - inter;
  return union > 0 ? inter / union : 0;
}
