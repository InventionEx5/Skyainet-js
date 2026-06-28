// packages/model/src/thevie/society_orchestrator.js
//
// ORCHESTRATEUR DE LA SOCIÉTÉ — le point d'intégration unique qui relie tout.
// (Rôle que Thevie/SkyCloud tiennent dans le vrai monorepo ; assemblé ici en
// autonome, à brancher dans SkyCloud — qui importe dilithium.)
//
// Chaîne complète câblée :
//   chat → admission (PII + qualité + boost-correction) → TAMPON DE REJEU PRIORISÉ
//        → consolidation (re-consultation + répétition espacée) → 3 cœurs + LoRA
//
// Fonctions :
//   • ask(query)        — route vers le cœur le plus compétent du domaine.
//   • teach(query)      — trilogue à panel mixte (critique externe) → leçon → double signal.
//   • ingestChat(...)   — une conversation utilisateur↔IA devient une leçon (filtrée) en buffer.
//   • consolidate(...)  — rejoue les leçons prioritaires : le cœur les RÉ-ÉTUDIE (maîtrise),
//                         la priorité décroît une fois maîtrisée (répétition espacée), et la
//                         leçon est REDISTRIBUÉE aux cœurs faibles du domaine.
//   • background(flux)  — échange de fond (diffusion entre pairs).
//
// DOUBLE SIGNAL : une leçon entraîne le cœur en POIDS PLEINS et son ADAPTATEUR LoRA.

import { MixedPanel } from '#mixed_panel';
import { InternalShadow } from '#internal_shadow';
import { ReplayBuffer, Experience } from '#replay_buffer';
import { DEFAULT_REDACTOR } from '#pii_redaction';
import { trainBrainOnLessons, trainLoraOnLesson, lessonCE, byteTokenizer } from '#peer_learning';

const IMPORTANCE_FLOOR   = 0.05;
const MASTERY_CE         = 0.35;   // CE sous laquelle une leçon est « maîtrisée » (compétence ~0.70)
const CHAT_MIN_QUALITY   = 0.30;   // score minimal pour qu'un échange devienne leçon
const CORRECTION_BOOST   = 1.5;    // une correction de l'utilisateur est de grande valeur → re-consultée +
const TRUST_THRESHOLD    = 0.70;   // au-dessus (et hors correction) : réponse IA fiable → entraînement direct ;
                                   // en dessous (ou correction) : leçon à VÉRIFIER (ancrage externe avant entraînement)

// Score qualité heuristique d'un échange chat (léger ; le vrai monorepo en a un plus riche).
function _scoreChat(prompt, response) {
  const p = (prompt ?? '').trim();
  if (p.length < 3) return 0;
  let s = Math.min(1, p.length / 60);
  if (response && response.trim().length > 0) s = Math.min(1, s + 0.15);
  if (/^(salut|coucou|merci|ok|ça va|bonjour|hello|hi|yo)\b/i.test(p)) s *= 0.4;   // bavardage trivial
  return +s.toFixed(3);
}

// Détecte une correction implicite de l'utilisateur (signal d'apprentissage fort).
function _looksLikeCorrection(prompt) {
  return /\b(non|faux|incorrect|en fait|plutôt|tu te trompes|c'est pas|erreur|pas exact|détrompe)\b/i.test(prompt ?? '');
}

export class SocietyOrchestrator {
  /**
   * @param {object}   o
   * @param {object}   o.society         — la Société (3 cœurs + compétence)
   * @param {object}   o.gateway         — gateway externe ({ complete(provider, messages, opts) })
   * @param {Function} [o.classifier]    — (query)=>domainId
   * @param {Function} [o.embed]
   * @param {object}   [o.tokenizer]
   * @param {ReplayBuffer} [o.buffer]    — tampon de rejeu priorisé (créé si absent)
   * @param {number}   [o.bufferCapacity=512]
   * @param {string}   [o.criticProvider='anthropic']
   * @param {object}   [o.fullWeightOpts]
   * @param {number}   [o.loraEpochs=40]
   */
  constructor({ society, gateway, classifier = null, embed = null, tokenizer = byteTokenizer,
                buffer = null, bufferCapacity = 512, criticProvider = 'anthropic',
                fullWeightOpts = { epochs: 120, lr: 0.1 }, loraEpochs = 40,
                anchorEvery = 15, trainEvery = 2, maxRounds = 2, acceptScore = 0.5 } = {}) {
    if (!society) throw new Error('[SocietyOrchestrator] society requise');
    if (!gateway) throw new Error('[SocietyOrchestrator] gateway requis');
    this.society = society; this.gateway = gateway; this.classifier = classifier;
    this.embed = embed ?? gateway.embed ?? null; this.tokenizer = tokenizer;
    this.buffer = buffer ?? new ReplayBuffer(bufferCapacity);   // ← tampon de rejeu priorisé
    this.fullWeightOpts = fullWeightOpts; this.loraEpochs = loraEpochs;

    const externalTeach = async (query) => {
      const r = await gateway.complete(criticProvider, [{ role: 'user', content: query }], {});
      return (r?.text ?? '').toString();
    };
    this.panel = new MixedPanel({ society, gateway, embed: this.embed, tokenizer, criticProvider,
      maxRounds, acceptScore, ingest: (lesson) => this.learn(lesson) });
    this.shadow = new InternalShadow({ society, externalTeach, classifier, embed: this.embed, tokenizer,
      anchorEvery, trainEvery, trainOpts: fullWeightOpts });
    this.stats = { asked: 0, taught: 0, learned: 0, chatIngested: 0, chatRejected: 0, chatToVerify: 0,
                   piiRedacted: 0, anchored: 0, consolidations: 0, diffusionCycles: 0 };
  }

  _domain(query, domain) { return domain ?? (this.classifier ? this.classifier(query) : 'general'); }

  _toExperience(lesson) {
    const exp = new Experience({ query: lesson.query, response: lesson.response,
      quality: lesson.quality ?? 0.8, importance: lesson.importance ?? null });
    exp.domain      = lesson.domain ?? 'general';
    exp.source      = lesson.source ?? 'lesson';
    exp.verified    = lesson.verified ?? true;        // leçons internes (teach/learn/peer) = déjà vérifiées
    exp.needsAnchor = lesson.needsAnchor ?? false;
    exp.correction  = lesson.correction ?? false;
    exp.anchorContext = lesson.anchorContext ?? null; // litige d'une correction → contexte pour le critique externe
    return exp;
  }

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
    return this.panel.teach(query, this._domain(query, domain));
  }

  // DOUBLE SIGNAL (sans dépôt buffer) : poids pleins + adaptateur LoRA + compétence.
  _dualTrain(lesson, { targetId } = {}) {
    const id    = targetId ?? lesson.targetCore ?? this.society.whoKnows(lesson.domain ?? 'general')[0].id;
    const brain = this.society.brain(id);
    const ceBefore = lessonCE(brain, lesson, { tokenizer: this.tokenizer });
    trainBrainOnLessons(brain, [lesson], { tokenizer: this.tokenizer, ...this.fullWeightOpts });          // POIDS PLEINS
    const ceAfter  = lessonCE(brain, lesson, { tokenizer: this.tokenizer });
    const loraLoss = trainLoraOnLesson(brain.model, lesson, { tokenizer: this.tokenizer, epochs: this.loraEpochs }); // LoRA
    if (ceAfter != null && lesson.domain) this.society.competence.get(id).record(lesson.domain, 1 - Math.exp(-ceAfter));
    return {
      targetId: id,
      fullWeight: { ceBefore: ceBefore != null ? +ceBefore.toFixed(3) : null, ceAfter: ceAfter != null ? +ceAfter.toFixed(3) : null },
      lora: { finalLoss: loraLoss != null ? +loraLoss.toFixed(3) : null },
    };
  }

  // Enseignement direct d'une leçon : dépôt buffer + double signal.
  learn(lesson, opts = {}) {
    this.buffer.push(this._toExperience(lesson));
    this.stats.learned++;
    return this._dualTrain(lesson, opts);
  }

  // 3. ADMISSION CHAT : une conversation utilisateur↔IA → leçon filtrée → tampon de rejeu.
  //    Intake léger non bloquant. La cible est la réponse de l'IA → on CLASSE la confiance :
  //    réponse de haute qualité et non-corrective ⇒ VÉRIFIÉE (entraînement direct, gratuit) ;
  //    sinon (correction, ou qualité moyenne) ⇒ À VÉRIFIER — la consolidation la ré-ancrera
  //    via la critique externe avant tout entraînement (jamais d'auto-renforcement non vérifié).
  ingestChat(userPrompt, aiResponse, { ai = null, domain = 'general', isCorrection = null, quality = null, previousTurn = null } = {}) {
    const redP = DEFAULT_REDACTOR.redact(userPrompt ?? '');
    const redA = DEFAULT_REDACTOR.redact(aiResponse ?? '');
    const cleanPrompt = redP.text, cleanResponse = redA.text;
    if (!cleanPrompt.trim()) { this.stats.chatRejected++; return { accepted: false, reason: 'vide' }; }

    const score = quality ?? _scoreChat(cleanPrompt, cleanResponse);
    if (score < CHAT_MIN_QUALITY) { this.stats.chatRejected++; return { accepted: false, reason: `qualité ${score.toFixed(2)}` }; }

    const correction = isCorrection ?? _looksLikeCorrection(cleanPrompt);
    const importance  = Math.min(1, (1 - score * 0.5) * (correction ? CORRECTION_BOOST : 1));   // dur/correction → re-consulté +

    // RAFFINEMENT CORRECTION : si l'utilisateur corrige ET qu'on a le tour précédent,
    // la VRAIE leçon est (question d'origine → réponse corrigée). On reconstruit la
    // requête sur la question d'origine et on garde le LITIGE en contexte d'ancrage,
    // pour que le critique externe re-dérive la bonne réponse en connaissance de cause.
    let query = cleanPrompt, response = cleanResponse, anchorContext = null;
    if (correction && previousTurn?.query) {
      query = DEFAULT_REDACTOR.redact(previousTurn.query).text;
      const origAnswer = DEFAULT_REDACTOR.redact(previousTurn.response ?? '').text;
      response = cleanPrompt;   // placeholder (la correction) — sera remplacé par l'ancrage externe
      anchorContext = `Question: ${query}\nRéponse initiale (contestée par l'utilisateur): ${origAnswer}\n` +
                      `Correction de l'utilisateur: ${cleanPrompt}\nDonne la réponse correcte et vérifiée.`;
    }

    const trusted = !correction && response.trim().length > 0 && score >= TRUST_THRESHOLD;   // réponse IA fiable ?
    const lesson = { query, response, quality: score, importance, domain, source: 'chat',
                     correction, verified: trusted, needsAnchor: !trusted, anchorContext };

    this.buffer.push(this._toExperience(lesson));
    this.stats.chatIngested++;
    if (!trusted) this.stats.chatToVerify++;
    if (redP.count + redA.count > 0) this.stats.piiRedacted++;
    return { accepted: true, lesson, redactedPII: redP.count + redA.count };
  }

  // 4. CONSOLIDATION : rejeu priorisé du tampon (re-consultation pour la maîtrise).
  //    Le cœur ré-étudie les leçons importantes/dures ; la priorité décroît une fois
  //    maîtrisée (répétition espacée → anti-sur-apprentissage) ; et chaque leçon est
  //    REDISTRIBUÉE aux cœurs faibles du domaine (les 3 cerveaux apprennent).
  //    GARDE-FOU : une leçon « à vérifier » (sortie IA non fiable) est d'abord RÉ-ANCRÉE
  //    via le panel mixte (critique externe) ; sans ancrage possible, elle n'entraîne RIEN.
  async consolidate({ batchSize = 8, redistribute = true, peerOpts = null } = {}) {
    if (this.buffer.size === 0) return { consolidated: 0, mastered: 0, redistributed: 0, anchored: 0, skippedUnverified: 0, bufferSize: 0 };
    const entries = this.buffer.prioritizedSample(batchSize);
    const pOpts = peerOpts ?? { epochs: Math.max(40, Math.round((this.fullWeightOpts.epochs ?? 120) * 0.6)), lr: this.fullWeightOpts.lr ?? 0.1 };
    let mastered = 0, redistributed = 0, anchored = 0, skipped = 0;

    for (const { exp } of entries) {
      const domain = exp.domain ?? 'general';

      // VÉRIFICATION : jamais d'entraînement sur une sortie IA non vérifiée sans ancrage externe.
      if (exp.needsAnchor && !exp.verified) {
        const res = await this.panel.teach(exp.query, domain, { ingest: () => {}, context: exp.anchorContext ?? '' });   // critique EXTERNE (avec litige si correction)
        if (res?.lesson?.response) {
          exp.response = res.lesson.response;            // la réponse ancrée remplace la sortie IA brute
          exp.verified = true; exp.needsAnchor = false; anchored++;
        } else {
          skipped++; continue;                           // pas d'ancrage → on n'entraîne PAS sur du non vérifié
        }
      }

      const lesson = { query: exp.query, response: exp.response, domain };

      // RE-CONSULTATION : le cœur propriétaire ré-étudie la leçon (poids pleins + LoRA).
      const r  = this._dualTrain(lesson);
      const ce = r.fullWeight.ceAfter ?? 1;
      // Répétition espacée : maîtrisé → priorité basse ; encore dur → priorité haute.
      this.buffer.updatePriority(exp, Math.max(IMPORTANCE_FLOOR, 1 - Math.exp(-ce)));
      if (ce < MASTERY_CE) mastered++;

      // REDISTRIBUTION : les autres cœurs faibles du domaine apprennent la même leçon.
      if (redistribute) {
        for (const id of this.society.ids()) {
          if (id === r.targetId) continue;
          if (this.society.competenceOf(id, domain) >= this.society.peerThreshold) continue;   // déjà compétent
          trainBrainOnLessons(this.society.brain(id), [lesson], { tokenizer: this.tokenizer, ...pOpts });
          const pce = lessonCE(this.society.brain(id), lesson, { tokenizer: this.tokenizer });
          if (pce != null) this.society.competence.get(id).record(domain, 1 - Math.exp(-pce));
          redistributed++;
        }
      }
    }
    this.stats.consolidations++; this.stats.anchored += anchored;
    return { consolidated: entries.length, mastered, redistributed, anchored, skippedUnverified: skipped, bufferSize: this.buffer.size };
  }

  // 5. ÉCHANGE DE FOND : diffusion entre pairs (boucle shadow interne).
  async background(stream) {
    const out = await this.shadow.run(stream);
    this.stats.diffusionCycles += out.length;
    return out;
  }

  getStats() { return { ...this.stats, bufferSize: this.buffer.size, shadow: this.shadow.stats().ledger, panel: this.panel.getStats() }; }
}

export default SocietyOrchestrator;
