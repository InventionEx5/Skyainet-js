// packages/model/src/thevie/internal_shadow.js
//
// SHADOW INTERNE — la boucle d'arrière-plan qui fait apprendre les trois cœurs
// entre eux, automatiquement. Pour chaque requête : marché de professeurs
// (pair gratuit si un cœur maîtrise, sinon externe pour la frontière), gouverné
// par le SEVRAGE (un cœur déjà compétent dans le domaine est sauté).
//
// Deux principes économiques :
//   • UN SEUL cœur paie la frontière par cycle ; une fois entraîné et compétent,
//     les autres apprennent de LUI (gratuit) aux cycles suivants → la frontière
//     est payée une fois puis diffusée.
//   • La compétence est mesurée APRÈS entraînement (capacité réelle, via CE),
//     pas au moment de la consultation — sinon un cœur n'aurait jamais l'air
//     compétent (sa réponse pré-entraînement est mauvaise).
//
// Ré-ancrage : périodiquement le meilleur cœur d'un domaine est re-validé contre
// l'externe, pour détecter une dérive collective (les trois « d'accord sur une
// bêtise ») et la corriger.

import { trainBrainOnLessons, lessonCE, byteTokenizer } from '#peer_learning';

export class InternalShadow {
  /**
   * @param {object}   o
   * @param {object}   o.society         — la Société (3 cœurs + compétence)
   * @param {Function} o.externalTeach   — async (query, domain)=>answerText : l'IA externe (frontière/ancre)
   * @param {Function} [o.classifier]    — (query)=>domainId ; sinon domaine passé explicitement
   * @param {Function} [o.embed]
   * @param {object}   [o.tokenizer]
   * @param {number}   [o.anchorEvery=15] — cycles entre deux ré-ancrages par domaine
   * @param {number}   [o.trainEvery=2]   — leçons accumulées avant d'entraîner un cœur
   * @param {object}   [o.trainOpts]      — options d'entraînement
   */
  constructor({ society, externalTeach, classifier = null, embed = null, tokenizer = byteTokenizer,
                anchorEvery = 15, trainEvery = 2, externalCostUSD = 0.0004,
                trainOpts = { epochs: 100, lr: 0.1 }, train = trainBrainOnLessons, assess = null } = {}) {
    if (!society) throw new Error('[InternalShadow] society requise');
    if (typeof externalTeach !== 'function') throw new Error('[InternalShadow] externalTeach requis');
    this.society = society; this.externalTeach = externalTeach; this.classifier = classifier;
    this.embed = embed; this.tokenizer = tokenizer;
    this.anchorEvery = anchorEvery; this.trainEvery = trainEvery; this.externalCostUSD = externalCostUSD;
    this.trainOpts = trainOpts; this.train = train;
    // Compétence POST-entraînement (studentGap, 0 = maîtrisé). Défaut : via CE.
    this.assess = assess ?? ((brain, lesson) => {
      const ce = lessonCE(brain, lesson, { tokenizer: this.tokenizer });
      return ce == null ? 1 : 1 - Math.exp(-ce);
    });
    this.buffers = new Map(); this.domainCycle = new Map();
    this.ledger = { cycles: 0, peerDiffusions: 0, externalAcquisitions: 0, anchors: 0, trainings: 0, externalCostUSD: 0 };
  }

  _buf(id) { if (!this.buffers.has(id)) this.buffers.set(id, []); return this.buffers.get(id); }
  _threshold() { return this.society.peerThreshold; }

  // Un cycle d'arrière-plan pour une requête.
  async cycle(query, domainArg = null) {
    this.ledger.cycles++;
    const domain = domainArg ?? (this.classifier ? this.classifier(query) : 'general');
    const dc = (this.domainCycle.get(domain) ?? 0) + 1; this.domainCycle.set(domain, dc);
    const best = this.society.whoKnows(domain)[0];
    const events = [];

    // (A) Ré-ancrage : le meilleur cœur re-valide le domaine contre l'externe.
    if (best && best.competence >= this._threshold() && dc % this.anchorEvery === 0) {
      const ans = await this.externalTeach(query, domain);
      this._buf(best.id).push({ query, response: ans, domain, source: 'anchor' });
      this.ledger.anchors++; this.ledger.externalCostUSD += this.externalCostUSD;
      events.push({ type: 'anchor', core: best.id });
    }

    // (B) Pour chaque cœur faible : pair (gratuit) ou externe (frontière, UN seul/cycle).
    let externalThisCycle = false;
    for (const id of this.society.ids()) {
      if (this.society.competenceOf(id, domain) >= this._threshold()) continue;          // sevré → on saute
      const sel = this.society.selectTeacher(id, domain);
      if (sel.teacher === 'peer') {
        const answer = await this.society.brain(sel.brainId).generate(query, { tokenizer: this.tokenizer });  // le pair GÉNÈRE
        this._buf(id).push({ query, response: answer, domain, source: 'peer' });
        this.ledger.peerDiffusions++;
        events.push({ type: 'peer', learner: id, teacher: sel.brainId });
      } else {
        if (externalThisCycle) continue;                                                  // déjà un achat frontière ce cycle → attendre
        externalThisCycle = true;
        const answer = await this.externalTeach(query, domain);                           // frontière (payée une fois)
        this._buf(id).push({ query, response: answer, domain, source: 'external' });
        this.ledger.externalAcquisitions++; this.ledger.externalCostUSD += this.externalCostUSD;
        events.push({ type: 'external', learner: id });
      }
    }

    // (C) Cadence d'entraînement + compétence POST-entraînement (capacité réelle via CE).
    for (const id of this.society.ids()) {
      const buf = this._buf(id);
      if (buf.length < this.trainEvery) continue;
      this.train(this.society.brain(id), buf, { tokenizer: this.tokenizer, ...this.trainOpts });
      this.ledger.trainings++;
      for (const L of buf) {
        const gap = this.assess(this.society.brain(id), L);                                   // capacité réelle post-entraînement
        this.society.competence.get(id).record(L.domain ?? domain, gap);
      }
      events.push({ type: 'train', core: id, lessons: buf.length });
      buf.length = 0;
    }

    return { domain, best, events };
  }

  async run(stream) { const out = []; for (const it of stream) out.push(await this.cycle(it.query, it.domain)); return out; }

  stats() { return { ledger: { ...this.ledger, externalCostUSD: +this.ledger.externalCostUSD.toFixed(6) }, society: this.society.stats() }; }
}

export default InternalShadow;
