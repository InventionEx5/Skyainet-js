// packages/model/src/thevie/domain_classifier.js
//
// CLASSIFIEUR DE DOMAINE PAR EMBEDDING — assigne chaque requête à un domaine,
// pour que le sevrage progressif suive la compétence par DOMAINE RÉEL (et pas
// une compétence globale).
//
// Clustering EN LIGNE (leader / DP-means) : les domaines émergent du flux de
// requêtes. Pour chaque requête : on cherche le centroïde le plus proche (cosinus) ;
// si assez proche → on l'y rattache et on met à jour le centroïde (moyenne
// courante, donc stable) ; sinon → on crée un nouveau domaine. Amorçage optionnel
// par domaines connus (centroïdes étiquetés) pour des identifiants lisibles.
//
// L'embedder est INJECTÉ (le même que le cache sémantique). La qualité des
// domaines dépend entièrement de lui : avec un bon embedder de phrases, les
// requêtes sémantiquement proches se regroupent. Le mécanisme, lui, est exact.

function normCopy(v) {
  let n = 0; for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1; const o = new Float64Array(v.length);
  for (let i = 0; i < v.length; i++) o[i] = v[i] / n; return o;
}
function renorm(v) { let n = 0; for (let i = 0; i < v.length; i++) n += v[i] * v[i]; n = Math.sqrt(n) || 1; for (let i = 0; i < v.length; i++) v[i] /= n; }
function cos(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }   // a,b normalisés

export class EmbeddingDomainClassifier {
  /**
   * @param {object}   [o]
   * @param {Function} [o.embed]            — (text)=>vector ; permet classify(text)
   * @param {number}   [o.spawnThreshold=0.72] — cosinus mini pour rattacher (sinon nouveau domaine)
   * @param {number}   [o.maxDomains=64]    — plafond ; au-delà, on rattache au plus proche
   * @param {number}   [o.updateRate=null]  — null = moyenne courante (stable) ; sinon EMA ∈ (0,1)
   * @param {object}   [o.seeds]            — { label: vecteur } : domaines connus pré-amorcés
   */
  constructor({ embed = null, spawnThreshold = 0.72, maxDomains = 64, updateRate = null, seeds = null } = {}) {
    this.embed = embed;
    this.spawnThreshold = spawnThreshold;
    this.maxDomains = maxDomains;
    this.updateRate = updateRate;
    this.domains = [];      // [{ id, centroid:Float64Array(unité), count }]
    this._seq = 0;
    if (seeds) for (const [label, vec] of Object.entries(seeds)) this._add(label, vec);
  }

  _add(id, vec) { this.domains.push({ id, centroid: normCopy(vec), count: 1 }); return id; }

  _update(d, q) {
    if (this.updateRate != null) {
      const a = this.updateRate;
      for (let i = 0; i < d.centroid.length; i++) d.centroid[i] = (1 - a) * d.centroid[i] + a * q[i];
    } else {                                   // moyenne courante pondérée par le compte → converge
      const n = d.count, k = 1 / (n + 1);
      for (let i = 0; i < d.centroid.length; i++) d.centroid[i] = d.centroid[i] * (n * k) + q[i] * k;
    }
    renorm(d.centroid); d.count++;
  }

  _vec(input) { return (typeof input === 'string') ? this.embed(input) : input; }

  // Plus proche domaine SANS mise à jour (lecture seule, pour inspection).
  nearest(input) {
    const q = normCopy(this._vec(input)); let best = -Infinity, bi = -1;
    for (let i = 0; i < this.domains.length; i++) { const s = cos(q, this.domains[i].centroid); if (s > best) { best = s; bi = i; } }
    return bi < 0 ? { id: null, similarity: 0 } : { id: this.domains[bi].id, similarity: +best.toFixed(4) };
  }

  // Classe (et met à jour le centroïde / crée un domaine). Renvoie l'id de domaine.
  classify(input) {
    const q = normCopy(this._vec(input));
    let best = -Infinity, bi = -1;
    for (let i = 0; i < this.domains.length; i++) { const s = cos(q, this.domains[i].centroid); if (s > best) { best = s; bi = i; } }
    if (bi >= 0 && best >= this.spawnThreshold) { this._update(this.domains[bi], q); return this.domains[bi].id; }
    if (this.domains.length < this.maxDomains) return this._add(`domain_${this._seq++}`, q);
    if (bi >= 0) { this._update(this.domains[bi], q); return this.domains[bi].id; }   // plafond → plus proche
    return this._add(`domain_${this._seq++}`, q);
  }

  // Adaptateur pour ShadowRouter / WeaningController : (text)=>domainId.
  domainFn() { return (text) => this.classify(text); }

  stats() { return { count: this.domains.length, domains: this.domains.map(d => ({ id: d.id, count: d.count })) }; }
}
