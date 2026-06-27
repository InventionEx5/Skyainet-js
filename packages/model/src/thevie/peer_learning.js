// packages/model/src/thevie/peer_learning.js
//
// APPRENTISSAGE ENTRE PAIRS RÉEL — un cœur pair GÉNÈRE vraiment une réponse
// (inférence) qui devient une vraie LEÇON ; l'apprenant s'ENTRAÎNE dessus via le
// t369_trainer (poids complets). La diffusion de l'étape 1 (compétences
// contrôlées) devient ici concrète : génération réelle → leçon → entraînement.
//
// Détail important : la génération décode via le chemin PROPRE `logitsFull` (le
// même que le t369_trainer optimise), et NON via `model.generate()` natif qui
// passe par la surcouche cognitive stochastique — sinon génération et
// entraînement seraient incohérents.

import { bindFromModel, commitToModel, trainStep } from '#t369_trainer';
import { disagreement as semanticScore } from '#semantic_disagreement';

// Tokenizer OCTET par défaut (vocab 256, aucun entraînement requis).
// En production : brancher le BpeTokenizer du projet (et accorder vocabSize).
export const byteTokenizer = {
  vocabSize: 256,
  encode: (s) => Array.from(new TextEncoder().encode(s ?? '')),
  decode: (ids) => new TextDecoder().decode(Uint8Array.from((ids ?? []).filter(i => i >= 0 && i < 256))),
};

function argmax(arr) { let mi = 0, mv = arr[0]; for (let i = 1; i < arr.length; i++) if (arr[i] > mv) { mv = arr[i]; mi = i; } return mi; }

// generateFn d'un Brain : décodage greedy DÉTERMINISTE via logitsFull (chemin
// entraîné). Renvoie uniquement le texte généré (hors prompt).
export function makeCoreGenerate(model, tokenizer = byteTokenizer, { maxNewTokens = 32, maxPrompt = 96, eos = 1 } = {}) {
  return async (prompt) => {
    const ids = tokenizer.encode(prompt).slice(0, maxPrompt);
    const gen = [];
    for (let i = 0; i < maxNewTokens; i++) {
      const logits = model.logitsFull(ids.concat(gen));      // forward propre, logits du dernier token
      const nt = argmax(logits);
      if (nt === eos) break;
      gen.push(nt);
    }
    return tokenizer.decode(gen);
  };
}

// Tokenise une leçon (query→response→EOS) en (tokens, targets) décalés.
// L'EOS appris fait que la génération s'arrête au bon endroit.
function lessonTokens(tokenizer, query, response, maxLen, eos = 1) {
  const seq = [...tokenizer.encode(query), ...tokenizer.encode(response), eos].slice(0, maxLen + 1);
  return { tokens: seq.slice(0, -1), targets: seq.slice(1) };
}

// Entraîne le cœur d'un Brain sur des leçons via le t369_trainer (poids complets).
export function trainBrainOnLessons(brain, lessons, { tokenizer = byteTokenizer, epochs = 4, lr = 0.05, maxLen = 64 } = {}) {
  const { W, cfg, rope, transform } = bindFromModel(brain.model);
  let first = null, last = null, steps = 0;
  for (let e = 0; e < epochs; e++) {
    for (const L of lessons) {
      if (!L?.query || !L?.response) continue;
      const { tokens, targets } = lessonTokens(tokenizer, L.query, L.response, maxLen);
      if (tokens.length < 2) continue;
      const loss = trainStep(W, tokens, targets, cfg, rope, lr, transform);
      if (first === null) first = loss; last = loss; steps++;
    }
  }
  if (steps > 0) commitToModel(brain.model, W);
  return { trained: steps > 0, steps, lossStart: first, lossEnd: last };
}

// Entropie croisée d'un cœur sur une leçon (lr=0 → mesure sans mise à jour).
export function lessonCE(brain, lesson, { tokenizer = byteTokenizer, maxLen = 64 } = {}) {
  const { W, cfg, rope, transform } = bindFromModel(brain.model);
  const { tokens, targets } = lessonTokens(tokenizer, lesson.query, lesson.response, maxLen);
  if (tokens.length < 2) return null;
  return trainStep(W, tokens, targets, cfg, rope, 0, transform);
}

// ACTE DE DIFFUSION : un PAIR enseigne à un apprenant via VRAIE génération.
// Le pair génère la réponse → leçon → tampon de l'apprenant ; on mesure l'écart
// (apprenant vs pair) pour la compétence. Aucun appel externe.
export async function diffuseFromPeer(society, { learnerId, query, domain, tokenizer = byteTokenizer, embed = null, buffer = null }) {
  const sel = society.selectTeacher(learnerId, domain);
  if (sel.teacher !== 'peer') return { taught: false, teacher: sel.teacher, reason: sel.reason };
  const teacher = society.brain(sel.brainId), learner = society.brain(learnerId);
  const answer = await teacher.generate(query, { tokenizer });   // le pair génère VRAIMENT
  const own = await learner.generate(query, { tokenizer });       // réponse actuelle de l'apprenant
  const gap = embed ? semanticScore([own, answer], { embed }) : 0.5;
  society.recordCompetence(learnerId, domain, gap, { fromPeer: true, costUSD: 0 });
  const lesson = { query, response: answer, quality: 0.8, importance: +Math.max(0.05, gap).toFixed(4), source: 'peer', teacher: sel.brainId };
  buffer?.push?.(lesson);
  return { taught: true, teacher: sel.brainId, answer, gap, lesson };
}
