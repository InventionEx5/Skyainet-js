// packages/node/src/mixed_panel.js
//
// TRILOGUE À PANEL MIXTE — le trilogue (proposer → critic → synthesizer) où
// proposer et synthétiseur sont des CŒURS LOCAUX choisis par compétence-domaine,
// et le siège CRITIQUE est tenu par une IA EXTERNE (obligatoire).
//
// Pourquoi : un trilogue 100% local risque la CHAMBRE D'ÉCHO — les trois cœurs,
// nourris des mêmes leçons, peuvent « tomber d'accord sur une bêtise ». L'externe
// en critique est l'ANCRE DE RÉALISME : à chaque délibération une voix de frontière
// conteste la proposition locale, et la critique est injectée dans le prompt du
// synthétiseur (donc elle pèse vraiment sur la réponse finale). Coût maîtrisé :
// UN appel externe par tour (le siège critique), pas trois.
//
// Assignation dynamique : proposer = cœur le plus compétent du domaine (meilleur
// brouillon) ; synthétiseur = le généraliste (orchestration) sauf s'il est déjà
// proposer, auquel cas le 2ᵉ plus compétent ; critique = externe.

import { SpaceAI } from '#space_ai';
import { Critic } from '#critic';
import { makeMixedRoleGenerate, evaluateTrilogue } from '#space_teacher';
import { byteTokenizer } from '#peer_learning';

// Choisit le panel pour un domaine donné (par compétence).
export function assignPanel(society, domain) {
  const ranking    = society.whoKnows(domain);                       // [{id, competence}] décroissant
  const proposerId = ranking[0]?.id ?? society.ids()[0];
  const generalist = society.ids().find(id => society.brain(id).homeRole === 'synthesizer');
  const synthesizerId = (generalist && generalist !== proposerId)
    ? generalist
    : (ranking.find(r => r.id !== proposerId)?.id ?? proposerId);
  return {
    proposerId, synthesizerId, criticIsExternal: true,
    ranking: ranking.map(r => ({ id: r.id, competence: +r.competence.toFixed(3) })),
  };
}

export class MixedPanel {
  /**
   * @param {object}   o
   * @param {object}   o.society         — la Société (3 cœurs + compétence)
   * @param {object}   o.gateway         — gateway externe ({ complete(provider, messages, opts) })
   * @param {Function} [o.ingest]        — (lesson)=>void : dépôt tampon de rejeu
   * @param {Function} [o.embed]         — mesure l'apport du débat (déf: gateway.embed)
   * @param {object}   [o.tokenizer]
   * @param {string}   [o.criticProvider='anthropic'] — fournisseur du siège critique
   * @param {number}   [o.maxRounds=2]
   * @param {number}   [o.acceptScore=0.5] — score critique minimal pour ingérer
   */
  constructor({ society, gateway, ingest = null, embed = null, tokenizer = byteTokenizer,
                criticProvider = 'anthropic', maxRounds = 2, acceptScore = 0.5 } = {}) {
    if (!society) throw new Error('[MixedPanel] society requise');
    if (!gateway) throw new Error('[MixedPanel] gateway requis (critique externe obligatoire)');
    this.society = society; this.gateway = gateway; this.ingest = ingest;
    this.embed = embed ?? gateway.embed ?? null; this.tokenizer = tokenizer;
    this.criticProvider = criticProvider; this.maxRounds = maxRounds; this.acceptScore = acceptScore;
    this.critic = new Critic();
    this.stats = { taught: 0, ingested: 0, rejected: 0, rounds: 0, externalCritiques: 0 };
  }

  // Une délibération : assigne le panel → trilogue (proposer/synth locaux, critique
  //   externe) → critique heuristique → leçon → tampon.
  async teach(query, domain, { ingest } = {}) {
    const panel = assignPanel(this.society, domain);
    const generate = makeMixedRoleGenerate({
      society: this.society, proposerId: panel.proposerId, synthesizerId: panel.synthesizerId,
      gateway: this.gateway, criticProvider: this.criticProvider, tokenizer: this.tokenizer,
    });
    const space = new SpaceAI({ generate, maxRounds: this.maxRounds,
      names: { proposer: panel.proposerId, critic: `External:${this.criticProvider}`, synthesizer: panel.synthesizerId } });

    const tri = await space.trilogue(query);
    this.stats.externalCritiques += tri.rounds;            // un appel critique externe par tour
    const crit = this.critic.critique(query, tri.answer);
    this.stats.taught++; this.stats.rounds += tri.rounds;

    const { accept, lesson } = evaluateTrilogue(query, tri, crit,
      { embed: this.embed, acceptScore: this.acceptScore, source: 'mixed-panel' });
    if (lesson) lesson.domain = domain;                    // tag domaine → entraînement ciblé

    const sink = ingest ?? this.ingest;
    if (!accept) { this.stats.rejected++; return { ...tri, panel, critique: crit, lesson: null, ingested: false }; }
    sink?.(lesson); this.stats.ingested++;
    return { ...tri, panel, critique: crit, lesson, ingested: true };
  }

  // Curriculum : items = [{ query, domain }]
  async teachBatch(items, opts = {}) {
    const results = [];
    for (const it of items) results.push(await this.teach(it.query, it.domain, opts));
    return { taught: results.length, ingested: results.filter(r => r.ingested).length, results };
  }

  getStats() { return { ...this.stats }; }
}

export default MixedPanel;
