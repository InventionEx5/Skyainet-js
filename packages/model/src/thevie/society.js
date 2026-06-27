// packages/model/src/thevie/society.js
//
// LA SOCIÉTÉ — trois cerveaux locaux ÉGAUX (Thevie, T369, LoraÉvo), même
// architecture (T369Model, configs différentes), donc la MÊME machinerie
// d'apprentissage les entraîne tous : la passe arrière est pilotée par
// model.config (un seul t369_trainer, trois instances). « Les trois apprennent
// de la même façon » devient littéralement vrai au niveau du code.
//
// Chaque cœur est ANCRÉ sur une spécialité pour ne PAS converger vers le même
// cerveau :
//   • Thevie  = généraliste   (largeur : couvre tout le terrain)   → +orchestration
//   • T369    = raisonnement  (profondeur : plus de couches)
//   • LoraÉvo = adaptation    (base légère + LoRA/mémoire par-dessus)
//
// La Société suit QUI SAIT QUOI (compétence par domaine) et expose le MARCHÉ DE
// PROFESSEURS unifié : un apprenant incertain consulte le plus compétent du
// domaine — un PAIR (gratuit, déjà appris) si l'un maîtrise vraiment, sinon
// l'IA EXTERNE (frontière). Ré-ancrage périodique sur l'externe pour éviter la
// dérive collective (trois locaux qui « se mettent d'accord sur une bêtise »).

import { T369Model, ModelConfig } from '#t369';
import { WeaningController } from '#weaning';

// Profils de spécialité — trois petits cœurs (~⅓ chacun), à régler en prod.
// hiddenSize = numQueryHeads × headDim ; numKvHeads = numQueryHeads / 2 (GQA).
export function defaultSocietyConfigs({ vocabSize = 4096, maxSeqLen = 512, headDim = 16 } = {}) {
  const mk = (hidden, layers, experts, inter) => {
    const c = new ModelConfig();
    c.vocabSize = vocabSize; c.maxSeqLen = maxSeqLen; c.headDim = headDim;
    c.numQueryHeads = Math.round(hidden / headDim);
    c.numKvHeads = Math.max(1, Math.round(c.numQueryHeads / 2));
    c.hiddenSize = hidden; c.numLayers = layers; c.numExperts = experts;
    c.topK = 2; c.intermediateSize = inter;
    return c;
  };
  return {
    thevie : { kind: 'generalist', homeRole: 'synthesizer', config: mk(96, 3, 8, 192) },  // largeur
    t369   : { kind: 'reasoning',  homeRole: 'proposer',    config: mk(96, 5, 4, 288) },  // profondeur
    loraevo: { kind: 'adaptation', homeRole: 'critic',      config: mk(64, 2, 4, 128) },  // léger + LoRA
  };
}

export class Brain {
  constructor({ id, kind, homeRole, model, generateFn = null }) {
    this.id = id; this.kind = kind; this.homeRole = homeRole;
    this.model = model;            // T369Model — vrai cœur entraînable par le trainer partagé
    this.generateFn = generateFn;  // (prompt,opts)=>text : branché sur l'inférence réelle (étape suivante)
  }
  async generate(prompt, opts = {}) {
    if (!this.generateFn) throw new Error(`[Brain ${this.id}] inférence non branchée`);
    return this.generateFn(prompt, opts);
  }
}

export class Society {
  /**
   * @param {Brain[]} brains
   * @param {object}  [o]
   * @param {object}  [o.weaningCfg]        — config WeaningController par cerveau
   * @param {number}  [o.peerThreshold=0.6] — compétence pair minimale pour enseigner
   * @param {number}  [o.peerMargin=0.05]   — un pair doit dépasser l'apprenant d'au moins ça
   */
  constructor(brains = [], { weaningCfg = {}, peerThreshold = 0.6, peerMargin = 0.05 } = {}) {
    this.brains = new Map();
    this.competence = new Map();        // brainId -> WeaningController (compétence par domaine)
    for (const b of brains) { this.brains.set(b.id, b); this.competence.set(b.id, new WeaningController(weaningCfg)); }
    this.peerThreshold = peerThreshold;
    this.peerMargin = peerMargin;
    this.ledger = { peerConsults: 0, externalConsults: 0, externalCostUSD: 0 };
  }

  ids() { return [...this.brains.keys()]; }
  brain(id) { return this.brains.get(id); }
  competenceOf(id, domain) { return this.competence.get(id)?.domainStats(domain).competence ?? 0; }

  // Le pair le plus compétent dans un domaine, hors `exclude`.
  bestPeer(domain, { exclude = null } = {}) {
    let best = null, bestC = -1;
    for (const id of this.brains.keys()) {
      if (id === exclude) continue;
      const c = this.competenceOf(id, domain);
      if (c > bestC) { bestC = c; best = id; }
    }
    return { id: best, competence: +Math.max(0, bestC).toFixed(4) };
  }

  // MARCHÉ DE PROFESSEURS : choisir le professeur d'un apprenant incertain.
  //   • forceAnchor → externe imposé (ré-ancrage anti-dérive)
  //   • un pair nettement plus compétent (≥ seuil ET > apprenant + marge) → PAIR (gratuit)
  //   • sinon → EXTERNE (frontière : ce qu'aucun pair ne sait encore)
  selectTeacher(learnerId, domain, { forceAnchor = false } = {}) {
    if (forceAnchor) return { teacher: 'external', reason: 'anchor' };
    const self = this.competenceOf(learnerId, domain);
    const peer = this.bestPeer(domain, { exclude: learnerId });
    if (peer.id && peer.competence >= this.peerThreshold && peer.competence > self + this.peerMargin)
      return { teacher: 'peer', brainId: peer.id, competence: peer.competence, reason: 'peer-competent' };
    return { teacher: 'external', reason: 'frontier' };
  }

  // Enregistre la compétence mesurée d'un apprenant après une leçon.
  recordCompetence(learnerId, domain, studentGap, { fromPeer = false, costUSD = 0 } = {}) {
    this.competence.get(learnerId)?.record(domain, studentGap, costUSD);
    if (fromPeer) this.ledger.peerConsults++;
    else { this.ledger.externalConsults++; this.ledger.externalCostUSD += costUSD; }
  }

  whoKnows(domain) {
    return this.ids().map(id => ({ id, competence: this.competenceOf(id, domain) })).sort((a, b) => b.competence - a.competence);
  }

  stats() {
    const competence = {};
    for (const id of this.ids()) competence[id] = { kind: this.brain(id).kind, domains: this.competence.get(id).globalStats().domains };
    return {
      brains: this.ids(), peerThreshold: this.peerThreshold,
      ledger: { ...this.ledger, externalCostUSD: +this.ledger.externalCostUSD.toFixed(6) },
      competence,
    };
  }
}

// Construit les trois cerveaux à partir des profils par défaut (cœurs initialisés).
export function buildSociety(opts = {}) {
  const cfgs = defaultSocietyConfigs(opts);
  const brains = Object.entries(cfgs).map(([id, spec], i) => {
    const model = new T369Model(spec.config);
    if (typeof model.initEmbeddings === 'function') model.initEmbeddings(1000 + i * 7);  // init distincte par cœur
    return new Brain({ id, kind: spec.kind, homeRole: spec.homeRole, model });
  });
  return { society: new Society(brains, opts), brains, configs: cfgs };
}

export default Society;
