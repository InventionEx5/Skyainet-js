// packages/model/src/thevie/complexity_classifier.js
// =====================================================
// ComplexityClassifier — classifieur APPRIS de la complexité d'une requête,
// pour l'escalade à l'inférence (chat Thevie & Friends).
//
// Deux axes indépendants, chacun un scoreur logistique sur un vecteur de features :
//   • gap    → besoin de CONNAISSANCE FRAÎCHE (récence / factuel) ⇒ tier 'hard' (surf)
//   • reason → besoin de DÉLIBÉRATION (raisonnement / conception / code) ⇒ tier 'medium' (triade)
// Sinon 'simple' (un seul cœur, réponse rapide).
//
// Apprentissage EN LIGNE, AUTO-SUPERVISÉ depuis le RÉSULTAT des décisions :
//   • une requête 'hard' dont le surf a ramené du contenu de qualité → la décision a payé
//     (renforce l'axe gap) ; un surf à vide → elle était mauvaise (corrige).
//   • une requête 'medium' dont les 3 avis DIVERGENT → la triade a apporté de la valeur
//     (renforce l'axe reason) ; des avis quasi identiques → elle était superflue (corrige).
// Aucun corpus, aucun clic utilisateur : ça apprend en tournant.
//
// Poids initiaux calés pour reproduire l'ancien heuristique ; ils dérivent ensuite.
"use strict";

// ── Marqueurs (étendus vs l'heuristique d'origine), regroupés par intention ──
const GAP_MARKERS = [
  /(derni[eè]r|latest|r[eé]cent|recent|actuel|current|aujourd|today|maintenant|\bnow\b)/,
  /\b(20[0-9]{2}|19[0-9]{2})\b/,
  /(prix|price|cours|stock|quote|taux|\brate\b|march[eé]|market cap|valuation)/,
  /(news|actualit|headline|breaking|annonc|\brelease\b|sortie de|version de)/,
  /(qui est|who is|who's|what is the current|c'est qui|dirigeant|\bceo\b|pr[eé]sident de)/,
  /(combien|how much|how many|quel est le nombre|nombre de)/,
  /(quand|when will|when does|when is|prochaine? (date|version|sortie))/,
  /(m[eé]t[eé]o|weather|score|r[eé]sultat du match|classement)/,
];
const REASON_MARKERS = [
  /(pourquoi|why\b)/,
  /(comment|how (do|does|to|can|should)|de quelle mani[eè]re)/,
  /(compar|versus|\bvs\b|diff[eé]renc|difference between|mieux que|better than)/,
  /(analys|[eé]valu|evaluate|assess|audit|critique|passe en revue|review)/,
  /(explique|explain|d[eé]montr|prove|justifi|raisonn|reason (about|through))/,
  /(con[çc]oi|design|architect|mod[eé]lis|structure|schéma|blueprint)/,
  /(strat[eé]g|approach|plan (de|pour|d')|feuille de route|roadmap|[eé]tapes pour)/,
  /(trade-?off|implic|pros and cons|avantages? et inconv|compromis|contrainte)/,
];
const CODE_MARKERS = [
  /```|~~~/,
  /\b(function|class|const|let|def|import|return|async|await|export|interface|struct|impl)\b/,
  /\.(js|jsx|ts|tsx|py|rs|go|java|cpp|cc|c|h|html|css|scss|sol|json|yaml|yml|sh|sql|rb|php)\b/,
  /(refactor|debug|optimi[sz]|corrige|fix (the|this|a|le|ce)|compile|exception|stack ?trace|traceback|\berror\b|erreur d|bug\b)/,
  /(implémente|implement|écris (une|le|la|un)|write (a|the|some)|génère (le|la|un|du)|generate (a|the|some)|crée (une|le|la|un))/,
];

function countGroups(text, groups) {
  let n = 0;
  for (const re of groups) if (re.test(text)) n++;
  return n;
}

export class ComplexityClassifier {
  #wGap; #wReason; #lr; #gapThresh; #reasonThresh;
  #stats = { seen: 0, updates: 0, byTier: { simple: 0, medium: 0, hard: 0 } };

  constructor(opts = {}) {
    this.#lr           = opts.lr ?? 0.08;
    this.#gapThresh    = opts.gapThreshold ?? 0.5;
    this.#reasonThresh = opts.reasonThreshold ?? 0.5;
    // features : [bias, wordsNorm, gapHits, reasonHits, codeHits, qMarks, hasNum, multipart]
    this.#wGap    = (opts.wGap    && opts.wGap.length    === 8) ? [...opts.wGap]    : [-1.4, 0.25, 2.3, 0.05, 0.15, 0.15, 0.9,  0.1];
    this.#wReason = (opts.wReason && opts.wReason.length === 8) ? [...opts.wReason] : [-1.3, 1.05, 0.05, 1.9,  1.0,  0.5,  0.0,  1.1];
  }

  #features(query) {
    const q = String(query || '').split(/\[web context\]|\[contexte/i)[0].toLowerCase().trim();
    if (!q) return [1, 0, 0, 0, 0, 0, 0, 0];
    const words   = q.split(/\s+/).filter(Boolean).length;
    const qMarks  = (q.match(/\?/g) || []).length;
    const hasNum  = /\d/.test(q) ? 1 : 0;
    const multipart = (qMarks > 1 || words > 60 || /\b(puis|ensuite|et aussi|then|also|and then)\b/.test(q)) ? 1 : 0;
    return [
      1,
      Math.min(2.5, words / 25),
      countGroups(q, GAP_MARKERS),
      countGroups(q, REASON_MARKERS),
      countGroups(q, CODE_MARKERS),
      Math.min(3, qMarks),
      hasNum,
      multipart,
    ];
  }

  #dot(w, f) { let s = 0; for (let i = 0; i < w.length; i++) s += w[i] * (f[i] ?? 0); return s; }
  #sig(x) { return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, x)))); }

  scores(query) {
    const f = this.#features(query);
    return { gap: this.#sig(this.#dot(this.#wGap, f)), reason: this.#sig(this.#dot(this.#wReason, f)), features: f };
  }

  /** → { tier: 'simple'|'medium'|'hard', gap, reason, features } */
  classify(query) {
    const { gap, reason, features } = this.scores(query);
    let tier = 'simple';
    if (gap >= this.#gapThresh) tier = 'hard';
    else if (reason >= this.#reasonThresh) tier = 'medium';
    this.#stats.seen++; this.#stats.byTier[tier]++;
    return { tier, gap, reason, features };
  }

  /**
   * Mise à jour logistique en ligne. `axis` ∈ {'gap','reason'} ; `reward` ∈ [-1,1]
   * (>0 : la décision a payé → renforce ; <0 : corrige). `features` = ceux renvoyés
   * par classify() pour CETTE requête.
   */
  learn({ features, axis, reward } = {}) {
    if (!Array.isArray(features) || (axis !== 'gap' && axis !== 'reason') || !reward) return false;
    const w = axis === 'gap' ? this.#wGap : this.#wReason;
    const pred   = this.#sig(this.#dot(w, features));
    const target = reward > 0 ? 1 : 0;
    const mag    = Math.min(1, Math.abs(reward));
    for (let i = 0; i < w.length; i++) {
      w[i] += this.#lr * mag * (target - pred) * (features[i] ?? 0);
      w[i] = Math.max(-8, Math.min(8, w[i]));   // clip anti-emballement
    }
    this.#stats.updates++;
    return true;
  }

  exportState() {
    return {
      wGap: [...this.#wGap], wReason: [...this.#wReason],
      lr: this.#lr, gapThreshold: this.#gapThresh, reasonThreshold: this.#reasonThresh,
      stats: { seen: this.#stats.seen, updates: this.#stats.updates, byTier: { ...this.#stats.byTier } },
    };
  }
  importState(s) {
    if (s && Array.isArray(s.wGap) && s.wGap.length === 8) this.#wGap = [...s.wGap];
    if (s && Array.isArray(s.wReason) && s.wReason.length === 8) this.#wReason = [...s.wReason];
    if (s && typeof s.gapThreshold === 'number') this.#gapThresh = s.gapThreshold;
    if (s && typeof s.reasonThreshold === 'number') this.#reasonThresh = s.reasonThreshold;
    return this.exportState();
  }
  stats() { return { ...this.#stats, byTier: { ...this.#stats.byTier }, wGap: [...this.#wGap], wReason: [...this.#wReason] }; }
}

/**
 * Divergence moyenne (distance de Jaccard par paires sur les ensembles de mots) entre
 * plusieurs textes. ~1 = très différents (délibération utile) ; ~0 = quasi identiques.
 */
export function textDivergence(texts) {
  const sets = (texts || []).map(t => new Set((String(t || '').toLowerCase().match(/\b[\p{L}\p{N}]+\b/gu)) || []));
  let sum = 0, n = 0;
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      const a = sets[i], b = sets[j];
      if (!a.size && !b.size) continue;
      let inter = 0; for (const w of a) if (b.has(w)) inter++;
      const uni = a.size + b.size - inter;
      sum += uni ? 1 - inter / uni : 0; n++;
    }
  }
  return n ? sum / n : 0;
}

// ── Démo/validation autonome : `node complexity_classifier.js` ──
if (import.meta.url === `file://${process.argv[1]}`) {
  const A = (c, l) => { console.log(c ? '✓' : '✗ ÉCHEC', l); if (!c) process.exitCode = 1; };
  const clf = new ComplexityClassifier();
  A(clf.classify('Bonjour, ça va ?').tier === 'simple', "simple : salutation");
  A(clf.classify('Quel est le prix actuel du Bitcoin ?').tier === 'hard', "hard : prix actuel (lacune)");
  A(clf.classify("Qui est le PDG de Boeing aujourd'hui ?").tier === 'hard', "hard : identité courante");
  A(clf.classify('Pourquoi le ciel est bleu et comment fonctionne la diffusion ?').tier === 'medium', "medium : pourquoi/comment");
  A(clf.classify('Refactor cette fonction async en TypeScript').tier === 'medium', "medium : tâche de code");
  A(clf.classify('Merci !').tier === 'simple', "simple : remerciement");

  // Apprentissage : un 'hard' à surf vide doit faire baisser le gapScore sur cette requête
  const q = 'Explique le prix actuel';
  const before = clf.scores(q).gap;
  for (let i = 0; i < 40; i++) { const f = clf.classify(q).features; clf.learn({ features: f, axis: 'gap', reward: -0.7 }); }
  const after = clf.scores(q).gap;
  A(after < before, `apprentissage : surf répétés à vide → gapScore baisse (${before.toFixed(2)} → ${after.toFixed(2)})`);

  A(textDivergence(['le chat dort', 'le chat dort']) === 0, "divergence : textes identiques → 0");
  A(textDivergence(['alpha beta gamma', 'delta epsilon zeta']) > 0.9, "divergence : textes disjoints → ~1");
  console.log('ComplexityClassifier — auto-test OK');
}
