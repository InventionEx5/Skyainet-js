// packages/model/src/thevie/weaning.js
//
// SEVRAGE PROGRESSIF — réduit la consultation des maîtres externes à mesure que
// la compétence LOCALE par domaine augmente, pour que le coût décroisse.
//
// Piloté par la COMPÉTENCE MESURÉE, pas par un calendrier : à chaque consultation
// on observe l'écart local↔maîtres (studentGap). compétence = moyenne mobile de
// (1 − studentGap). Quand un domaine est maîtrisé, on consulte de moins en moins ;
// un PLANCHER d'exploration subsiste pour détecter les dérives (le monde change,
// le modèle régresse) et rouvrir la consultation si la compétence rechute.
//
// Trois régimes par domaine :
//   • amorçage (peu d'observations)   → on s'appuie sur l'incertitude locale
//   • sevrage (compétence établie)    → p(consulter) = max(plancher, 1 − compétence)
//   • sécurité (incertitude extrême)  → on consulte toujours (local totalement perdu)

export class WeaningController {
  /**
   * @param {object} [o]
   * @param {number} [o.alpha=0.3]            — lissage de la moyenne mobile de compétence
   * @param {number} [o.warmupSamples=3]      — observations avant de passer en régime sevrage
   * @param {number} [o.exploreFloor=0.05]    — taux de consultation minimal (détection de dérive)
   * @param {number} [o.uncThreshold=0.25]    — incertitude qui déclenche la consultation à l'amorçage
   * @param {number} [o.hardUncThreshold=0.8] — incertitude extrême → consultation forcée (sécurité)
   */
  constructor({ alpha = 0.3, warmupSamples = 3, exploreFloor = 0.05, uncThreshold = 0.25, hardUncThreshold = 0.8 } = {}) {
    this.alpha = alpha; this.warmupSamples = warmupSamples; this.exploreFloor = exploreFloor;
    this.uncThreshold = uncThreshold; this.hardUncThreshold = hardUncThreshold;
    this.domains = new Map();
    this.totalSeen = 0; this.totalConsult = 0; this.totalCostUSD = 0;
  }

  _get(d) {
    let s = this.domains.get(d);
    if (!s) { s = { competence: 0, samples: 0, consultations: 0, seen: 0, costUSD: 0, lastGap: null }; this.domains.set(d, s); }
    return s;
  }

  // Politique de sevrage : probabilité de consulter pour ce domaine.
  consultProbability(domain, uncertainty = 0) {
    const s = this._get(domain);
    if (uncertainty >= this.hardUncThreshold) return 1;                                   // sécurité
    if (s.samples < this.warmupSamples) return uncertainty >= this.uncThreshold ? 1 : this.exploreFloor;  // amorçage
    return Math.max(this.exploreFloor, 1 - s.competence);                                 // sevrage
  }

  // Décision (échantillonnée). rng injectable pour des tests déterministes.
  decideConsult(domain, uncertainty = 0, rng = Math.random) {
    const p = this.consultProbability(domain, uncertainty);
    const consult = rng() < p;
    const s = this._get(domain); s.seen++; this.totalSeen++;
    if (consult) { s.consultations++; this.totalConsult++; }
    return { consult, p };
  }

  // Met à jour la compétence après une consultation (signal = écart local↔maîtres).
  record(domain, studentGap, costUSD = 0) {
    const s = this._get(domain);
    const obs = 1 - Math.max(0, Math.min(1, studentGap));            // compétence observée ∈ [0,1]
    s.competence = s.samples === 0 ? obs : (1 - this.alpha) * s.competence + this.alpha * obs;
    s.samples++; s.costUSD += costUSD; this.totalCostUSD += costUSD; s.lastGap = studentGap;
    return s.competence;
  }

  domainStats(domain) { const s = this._get(domain); return { ...s, consultRate: s.seen ? s.consultations / s.seen : 0 }; }

  globalStats() {
    const ds = {};
    for (const [k, s] of this.domains) ds[k] = { competence: +s.competence.toFixed(3), samples: s.samples, consultRate: s.seen ? +(s.consultations / s.seen).toFixed(3) : 0, costUSD: +s.costUSD.toFixed(6) };
    return { totalSeen: this.totalSeen, totalConsult: this.totalConsult, overallRate: this.totalSeen ? +(this.totalConsult / this.totalSeen).toFixed(3) : 0, totalCostUSD: +this.totalCostUSD.toFixed(6), domains: ds };
  }
}
