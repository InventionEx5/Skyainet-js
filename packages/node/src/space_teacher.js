// packages/node/src/space_teacher.js
//
// SPACE TEACHER — relie AI Space (trilogue + critique) à la boucle d'enseignement.
//
// Le trilogue (proposer → critic → synthesizer) produit une réponse de meilleure
// qualité qu'un agent seul ; le Critic la valide (garde-fou qualité) ; la réponse
// retenue devient une LEÇON déposée dans le tampon de rejeu — le MÊME tampon que
// la distillation consomme pour entraîner les vrais poids du T369. Le trilogue
// devient ainsi une source de leçons à côté du shadow léger.
//
// Pont rôle→fournisseur : chaque rôle est joué par une IA externe via le gateway
// REST (proposer=Grok, critic=Claude, synthesizer=DeepSeek par défaut) — les
// trois IA externes débattent réellement.

import { SpaceAI } from '#space_ai';
import { Critic } from '#critic';
import { assertTeachable } from '#external_providers';
import { disagreement as semanticScore } from '#semantic_disagreement';

// Construit generate(prompt, {role, temperature, maxTokens}) qui route chaque
// RÔLE vers un fournisseur via gateway.complete (appel REST réel, PII + cache +
// coûts inclus puisque ça passe par le gateway).
export function makeRoleGenerate(gateway, { roleProviders = { proposer: 'deepseek', critic: 'deepseek', synthesizer: 'deepseek' } } = {}) {
  for (const p of Object.values(roleProviders)) assertTeachable(p);   // PARE-FEU : rôles enseignants = enseignables (DeepSeek/local), pas Claude/Grok
  return async (prompt, { role = 'proposer', temperature, maxTokens } = {}) => {
    const provider = roleProviders[role] ?? roleProviders.proposer ?? 'xai';
    const r = await gateway.complete(provider, [{ role: 'user', content: prompt }], { temperature, maxTokens });
    return (r?.text ?? '').toString();
  };
}

// Construit generate(prompt, {role}) à PANEL MIXTE : les rôles proposer et
// synthesizer sont joués par des CŒURS LOCAUX (gratuit), le rôle critic par une
// IA EXTERNE via le gateway (l'ancre anti-chambre-d'écho, obligatoire). Les
// identités locales (proposerId/synthesizerId) sont choisies par assignPanel().
export function makeMixedRoleGenerate({ society, proposerId, synthesizerId, gateway,
                                        criticProvider = 'deepseek', tokenizer = null } = {}) {
  if (!society) throw new Error('[makeMixedRoleGenerate] society requise');
  if (!gateway) throw new Error('[makeMixedRoleGenerate] gateway requis (critique externe)');
  return async (prompt, { role = 'proposer', temperature, maxTokens } = {}) => {
    if (role === 'critic') {                                   // ancre externe obligatoire (ENSEIGNABLE)
      assertTeachable(criticProvider);                         // PARE-FEU : critique enseignant = DeepSeek/local, pas Claude/Grok
      const r = await gateway.complete(criticProvider, [{ role: 'user', content: prompt }], { temperature, maxTokens });
      return (r?.text ?? '').toString();
    }
    const id = role === 'synthesizer' ? synthesizerId : proposerId;   // cœurs locaux
    return (await society.brain(id).generate(prompt, { tokenizer })).toString();
  };
}

// Évalue un trilogue et fabrique la leçon (partagé par SpaceTeacher et MixedPanel).
// quality = fiabilité de la cible (depuis le score critique) ; importance = apport
// du débat (écart proposition→synthèse). Renvoie {accept, lesson, improvement}.
export function evaluateTrilogue(query, tri, crit, { embed = null, acceptScore = 0.5, source = 'trilogue' } = {}) {
  const proposal0   = tri.transcript.find(t => t.role === 'proposer')?.text ?? '';
  const improvement = embed ? semanticScore([proposal0, tri.answer], { embed }) : 0.5;
  const accept      = crit.score >= acceptScore && !tri.answer.startsWith('[');
  const lesson = accept ? {
    query, response: tri.answer,
    quality   : +Math.min(1, 0.6 + 0.4 * crit.score).toFixed(4),
    importance: +Math.max(0.05, improvement).toFixed(4),
    source, converged: tri.converged, rounds: tri.rounds, criticScore: crit.score, ts: Date.now(),
  } : null;
  return { accept, lesson, improvement };
}

export class SpaceTeacher {
  /**
   * @param {object}   o
   * @param {object}   o.gateway          — ExternalGateway (appels REST)
   * @param {Function} [o.ingest]         — (lesson)=>void : dépôt dans le tampon de rejeu
   * @param {Function} [o.embed]          — mesure l'apport du débat (déf: gateway.embed)
   * @param {object}   [o.roleProviders]  — { proposer, critic, synthesizer } → fournisseurs
   * @param {number}   [o.maxRounds=2]
   * @param {object}   [o.names]          — noms affichés des 3 IA
   * @param {number}   [o.acceptScore=0.5] — score critique minimal pour ingérer une leçon
   */
  constructor({ gateway, ingest = null, embed = null, roleProviders, maxRounds = 2, names, acceptScore = 0.5 } = {}) {
    if (!gateway) throw new Error('[SpaceTeacher] gateway requis');
    this.gateway = gateway;
    this.ingest = ingest;
    this.embed = embed ?? gateway.embed ?? null;
    this.acceptScore = acceptScore;
    this.space = new SpaceAI({ generate: makeRoleGenerate(gateway, { roleProviders }), maxRounds, names });
    this.critic = new Critic();
    this.stats = { taught: 0, ingested: 0, rejected: 0, rounds: 0 };
  }

  // Un acte d'enseignement : débat → critique → leçon → tampon.
  async teach(query, { context = '', reference = null, rounds } = {}) {
    const tri = await this.space.trilogue(query, { context, rounds });   // {answer, transcript, converged, rounds}
    const crit = this.critic.critique(query, tri.answer, { reference });
    this.stats.taught++; this.stats.rounds += tri.rounds;

    const { accept, lesson } = evaluateTrilogue(query, tri, crit, { embed: this.embed, acceptScore: this.acceptScore });
    if (!accept) { this.stats.rejected++; return { ...tri, critique: crit, lesson: null, ingested: false }; }
    this.ingest?.(lesson); this.stats.ingested++;
    return { ...tri, critique: crit, lesson, ingested: true };
  }

  // Session d'enseignement sur un lot de questions (curriculum).
  async teachBatch(queries, opts = {}) {
    const results = [];
    for (const q of queries) results.push(await this.teach(q, opts));
    return { taught: results.length, ingested: results.filter(r => r.ingested).length, results };
  }

  getStats() { return { ...this.stats, space: this.space.stats() }; }
}

export default SpaceTeacher;
