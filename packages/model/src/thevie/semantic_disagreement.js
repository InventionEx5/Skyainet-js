// packages/model/src/thevie/semantic_disagreement.js
//
// DÉSACCORD SÉMANTIQUE entre réponses — remplace le Jaccard lexical.
//
// Le Jaccard compte les mots communs : deux réponses de MÊME SENS mais formulées
// autrement passent pour « divergentes » (faux), ce qui corrompt le studentGap
// (mesure de compétence) et le consensus des maîtres. Ici on compare le SENS :
// embedding de chaque réponse (le même embedder que le cache/classifieur) →
// similarité cosinus → désaccord = 1 − cosinus moyen par paire.
//
// ┌─ FRONTIÈRE HONNÊTE ───────────────────────────────────────────────────────┐
// │ Le cosinus d'embeddings mesure la PROXIMITÉ TOPIQUE/SÉMANTIQUE, pas         │
// │ l'entailment ni la CONTRADICTION. « X est vrai » et « X est faux » ont un   │
// │ cosinus élevé (même sujet) → vus comme « d'accord ». Détecter la            │
// │ contradiction relève du NLI (modèle dédié). Cette métrique est un progrès   │
// │ STRICT sur le lexical pour la robustesse aux paraphrases, sans prétendre    │
// │ juger la vérité. La qualité dépend de l'embedder (cf. classifieur).         │
// └────────────────────────────────────────────────────────────────────────────┘

export function tokenize(t) { return new Set((t ?? '').toLowerCase().match(/\w+/g) ?? []); }

// Désaccord LEXICAL (Jaccard) — repli quand aucun embedder n'est disponible.
export function lexicalDisagreement(texts) {
  const sets = (texts ?? []).map(tokenize);
  if (sets.length < 2) return 0;
  let sum = 0, pairs = 0;
  for (let i = 0; i < sets.length; i++) for (let j = i + 1; j < sets.length; j++) {
    let inter = 0; for (const w of sets[i]) if (sets[j].has(w)) inter++;
    const uni = sets[i].size + sets[j].size - inter;
    sum += uni > 0 ? inter / uni : 1; pairs++;
  }
  return pairs ? +(1 - sum / pairs).toFixed(4) : 0;
}

function normCopy(v) { let n = 0; for (let i = 0; i < v.length; i++) n += v[i] * v[i]; n = Math.sqrt(n) || 1; const o = new Float64Array(v.length); for (let i = 0; i < v.length; i++) o[i] = v[i] / n; return o; }
function cos(a, b) { let s = 0; const m = Math.min(a.length, b.length); for (let i = 0; i < m; i++) s += a[i] * b[i]; return s; }

// Désaccord SÉMANTIQUE : 1 − cosinus moyen des embeddings.
// `floor` (optionnel) recalibre l'échelle : cosinus = floor → désaccord 1,
// cosinus = 1 → désaccord 0. Régler `floor` au cosinus « non relié » de
// l'embedder étale la dynamique (les embeddings de phrases se concentrent dans
// un cône, donc le cosinus brut « non relié » est souvent ~0.2–0.4, pas 0).
export function embeddingDisagreement(texts, embed, { floor = 0 } = {}) {
  if (!texts || texts.length < 2 || typeof embed !== 'function') return 0;
  const vecs = texts.map(t => normCopy(embed(t ?? '')));
  let sum = 0, pairs = 0;
  for (let i = 0; i < vecs.length; i++) for (let j = i + 1; j < vecs.length; j++) { sum += cos(vecs[i], vecs[j]); pairs++; }
  let meanSim = pairs ? sum / pairs : 1;
  if (floor > 0 && floor < 1) meanSim = (meanSim - floor) / (1 - floor);   // recalibrage optionnel
  return +Math.max(0, Math.min(1, 1 - meanSim)).toFixed(4);
}

// Sélection automatique : sémantique si un embedder est fourni, sinon lexical.
export function disagreement(texts, { embed = null, floor = 0 } = {}) {
  return embed ? embeddingDisagreement(texts, embed, { floor }) : lexicalDisagreement(texts);
}
