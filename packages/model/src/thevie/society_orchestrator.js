// packages/model/src/thevie/society_orchestrator.js
//
// ORCHESTRATEUR DE LA SOCIÉTÉ — le dernier étage qui relie tout. C'est le rôle de
// chef d'orchestre que Thevie/SkyCloud tiennent dans le vrai monorepo (ils
// importent dilithium, donc on assemble ici une version autonome équivalente, à
// brancher ensuite dans SkyCloud).
//
// Trois fonctions :
//   • ask(query)       — route la requête vers le cœur le plus compétent du domaine.
//   • teach(query)     — lance un trilogue à PANEL MIXTE (critique externe obligatoire)
//                        → leçon de haute qualité → DOUBLE entraînement.
//   • background(flux)  — fait tourner l'échange de fond (diffusion entre pairs).
//
// DOUBLE SIGNAL D'ENTRAÎNEMENT : une même leçon entraîne le cœur en POIDS PLEINS
// (trainBrainOnLessons → t369_trainer) ET son ADAPTATEUR LoRA (trainLoraOnLesson →
// poids vivants). Un seul signal d'enseignement nourrit les deux voies : la base
// (lente, permanente) et l'adaptateur (rapide, pluggable).

import { MixedPanel } from '#mixed_panel';
import { InternalShadow } from '#internal_shadow';
import { trainBrainOnLessons, trainLoraOnLesson, lessonCE, byteTokenizer } from '#peer_learning';

export class SocietyOrchestrator {
  /**
   * @param {object}   o
   * @param {object}   o.society         — la Société (3 cœurs + compétence)
   * @param {object}   o.gateway         — gateway externe ({ complete(provider, messages, opts) })
   * @param {Function} [o.classifier]    — (query)=>domainId
   * @param {Function} [o.embed]
   * @param {object}   [o.tokenizer]
   * @param {Array}    [o.buffer]        — tampon de rejeu partagé (leçons)
   * @param {string}   [o.criticProvider='anthropic']
   * @param {object}   [o.fullWeightOpts] — options d'entraînement poids pleins
   * @param {number}   [o.loraEpochs=40]  — époques d'entraînement de l'adaptateur LoRA
   */
  constructor({ society, gateway, classifier = null, embed = null, tokenizer = byteTokenizer,
                buffer = null, criticProvider = 'anthropic',
                fullWeightOpts = { epochs: 120, lr: 0.1 }, loraEpochs = 40,
                anchorEvery = 15, trainEvery = 2, maxRounds = 2, acceptScore = 0.5 } = {}) {
    if (!society) throw new Error('[SocietyOrchestrator] society requise');
    if (!gateway) throw new Error('[SocietyOrchestrator] gateway requis');
    this.society = society; this.gateway = gateway; this.classifier = classifier;
    this.embed = embed ?? gateway.embed ?? null; this.tokenizer = tokenizer;
    this.buffer = buffer ?? [];
    this.fullWeightOpts = fullWeightOpts; this.loraEpochs = loraEpochs;

    const externalTeach = async (query) => {
      const r = await gateway.complete(criticProvider, [{ role: 'user', content: query }], {});
      return (r?.text ?? '').toString();
    };
    // Le panel mixte ingère ses leçons directement dans le double entraînement.
    this.panel = new MixedPanel({ society, gateway, embed: this.embed, tokenizer, criticProvider,
      maxRounds, acceptScore, ingest: (lesson) => this.learn(lesson) });
    this.shadow = new InternalShadow({ society, externalTeach, classifier, embed: this.embed, tokenizer,
      anchorEvery, trainEvery, trainOpts: fullWeightOpts });
    this.stats = { asked: 0, taught: 0, learned: 0, diffusionCycles: 0 };
  }

  _domain(query, domain) { return domain ?? (this.classifier ? this.classifier(query) : 'general'); }

  // 1. ROUTAGE : la requête va au cœur le plus compétent du domaine.
  async ask(query, domain = null) {
    this.stats.asked++;
    const d = this._domain(query, domain);
    const best = this.society.whoKnows(d)[0];
    const answer = await this.society.brain(best.id).generate(query, { tokenizer: this.tokenizer });
    return { answer, core: best.id, domain: d, competence: +best.competence.toFixed(3) };
  }

  // 2. ENSEIGNEMENT : trilogue à panel mixte → leçon → double entraînement (via ingest→learn).
  async teach(query, domain = null) {
    this.stats.taught++;
    const d = this._domain(query, domain);
    return this.panel.teach(query, d);
  }

  // DOUBLE SIGNAL : une leçon entraîne le cœur en POIDS PLEINS et son ADAPTATEUR LoRA.
  learn(lesson, { targetId } = {}) {
    const id    = targetId ?? lesson.targetCore ?? this.society.whoKnows(lesson.domain ?? 'general')[0].id;
    const brain = this.society.brain(id);
    this.buffer.push(lesson);
    const ceBefore = lessonCE(brain, lesson, { tokenizer: this.tokenizer });
    trainBrainOnLessons(brain, [lesson], { tokenizer: this.tokenizer, ...this.fullWeightOpts });   // voie POIDS PLEINS
    const ceAfter  = lessonCE(brain, lesson, { tokenizer: this.tokenizer });
    const loraLoss = trainLoraOnLesson(brain.model, lesson, { tokenizer: this.tokenizer, epochs: this.loraEpochs });  // voie LoRA
    // La compétence (poids pleins) monte → le routage ask() reflète l'apprentissage.
    if (ceAfter != null && lesson.domain) this.society.competence.get(id).record(lesson.domain, 1 - Math.exp(-ceAfter));
    this.stats.learned++;
    return {
      targetId: id,
      fullWeight: { ceBefore: ceBefore != null ? +ceBefore.toFixed(3) : null, ceAfter: ceAfter != null ? +ceAfter.toFixed(3) : null },
      lora: { finalLoss: loraLoss != null ? +loraLoss.toFixed(3) : null },
    };
  }

  // 3. ÉCHANGE DE FOND : diffusion entre pairs (boucle shadow interne).
  async background(stream) {
    const out = await this.shadow.run(stream);
    this.stats.diffusionCycles += out.length;
    return out;
  }

  getStats() { return { ...this.stats, shadow: this.shadow.stats().ledger, panel: this.panel.getStats() }; }
}

export default SocietyOrchestrator;
