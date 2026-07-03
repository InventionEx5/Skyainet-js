// packages/model/src/living_reserve.js
// =====================================================
// Réserve Vivante — registre des Modules Vivants (adaptateurs LoRA/GGUF).
// Un Module Vivant = un adaptateur adressé par contenu + un manifeste
// {domaine, propriétaire, base, lignée, état, santé, évals, score Vitality}.
// La Réserve orchestre le CYCLE DE VIE (candidat → actif → repli → retiré →
// réabsorbé), le SCORING Vitality (dérivé des rapports d'évals du harnais), le
// PRÊT temporaire entre les 3 IA (retour automatique), et la détection de
// dégradation. Pur logiciel : les tenseurs vivent en GGUF, ici on gère les
// décisions. Se connecte à : eval_harness (scores), EvolutionManager (produit
// les adaptateurs), DistillationManager (données), Sentinel (healing), secure/
// (signatures de prêt).
// SkyAInet × Nikola T369
// =====================================================

"use strict";

export class ReserveError extends Error {
  constructor(message, code = 'E_RESERVE') { super(message); this.name = 'ReserveError'; this.code = code; }
}

export const ModuleState = Object.freeze({
  Candidate: 'candidate', Active: 'active', Shadow: 'shadow', Retired: 'retired', Reabsorbed: 'reabsorbed',
});

const DAY = 86400000;
const HALF_LIFE_DAYS = 14;   // fraîcheur : un score d'éval perd la moitié de sa confiance en 14 jours

export class LivingReserve {
  #modules = new Map();      // id → manifeste

  // ─── Enregistrement ────────────────────────────────────────────────────────
  register({ id, domain = 'general', owner = 't369', base = 'Qwen3-8B', sizeBytes = 0, lineage = [] }) {
    if (!id) throw new ReserveError('id (empreinte de contenu) requis', 'E_ID');
    if (this.#modules.has(id)) return this.#view(this.#modules.get(id));
    const m = {
      id, domain, owner, base, sizeBytes,
      lineage: Array.isArray(lineage) ? lineage.slice() : [],
      state: ModuleState.Candidate, health: 0.5, score: 0,
      evals: [], createdAt: Date.now(), lastUsedAt: null, uses: 0,
      loan: null, counterfactual: null,
    };
    this.#modules.set(id, m);
    return this.#view(m);
  }

  #get(id) { const m = this.#modules.get(id); if (!m) throw new ReserveError(`Module inconnu : ${id}`, 'E_NOTFOUND'); return m; }
  #logLineage(m, op) { m.lineage.push(op); if (m.lineage.length > 100) m.lineage.splice(0, m.lineage.length - 100); }

  // ─── Scoring Vitality ──────────────────────────────────────────────────────
  // score = dernière éval × fraîcheur × (1 + usage) + contrefactuel − coût.
  // Le contrefactuel (utilité par ablation) est branché plus tard (matériel requis).
  #vitalityScore(m, now) {
    const last = m.evals.length ? m.evals[m.evals.length - 1] : null;
    const baseVal   = last ? last.overall : 0;                          // 0..1
    const ageDays   = last ? (now - last.at) / DAY : 999;
    const freshness = Math.pow(0.5, ageDays / HALF_LIFE_DAYS);          // 1 récent → 0 ancien
    const usage     = Math.min(0.15, Math.log10(1 + m.uses) * 0.05);
    const cost      = Math.min(0.2, ((m.sizeBytes || 0) / 1e6) / 500);  // 500 Mo → −0.2
    const cf        = m.counterfactual ?? 0;
    const raw = baseVal * freshness * (1 + usage) + cf - cost;
    return Math.max(0, Math.min(100, raw * 100));
  }
  #healthOf(m) {
    if (!m.evals.length) return 0.5;
    const last = m.evals[m.evals.length - 1].overall;
    const prev = m.evals.length > 1 ? m.evals[m.evals.length - 2].overall : last;
    const regression = Math.max(0, prev - last);                       // chute d'éval = risque
    return Math.max(0, Math.min(1, last - regression * 0.5));
  }
  #refresh(m) { m.health = this.#healthOf(m); m.score = this.#vitalityScore(m, Date.now()); }

  /** Enregistre un rapport du harnais (eval_harness.runEvals/runAll) et recalcule. */
  recordEval(id, report) {
    const m = this.#get(id);
    m.evals.push({ overall: Number(report.overall) || 0, suites: (report.suites || []).map(s => ({ name: s.name, score: s.score })), at: Date.now() });
    if (m.evals.length > 20) m.evals.splice(0, m.evals.length - 20);
    this.#refresh(m);
    return this.#view(m);
  }
  /** Utilité contrefactuelle par ablation (−0.x..+0.x), branchée quand le matériel suit. */
  setCounterfactual(id, delta) { const m = this.#get(id); m.counterfactual = Number(delta) || 0; this.#refresh(m); return this.#view(m); }
  /** Comptabilise une utilisation réelle (nourrit le score). */
  use(id) { const m = this.#get(id); m.uses++; m.lastUsedAt = Date.now(); this.#refresh(m); return this.#view(m); }

  // ─── Cycle de vie (T369 : promotion GÂCHÉE par le score) ───────────────────
  active(domain) { return [...this.#modules.values()].find(m => m.domain === domain && m.state === ModuleState.Active) || null; }

  /** Promeut un module en actif SI il bat l'actif du domaine d'au moins `margin` points. */
  promote(id, { margin = 2 } = {}) {
    const m = this.#get(id);
    const incumbent = this.active(m.domain);
    if (incumbent && incumbent.id !== m.id && m.score < incumbent.score + margin) {
      return { promoted: false, reason: `score ${m.score.toFixed(1)} < actif ${incumbent.score.toFixed(1)} + ${margin}`, active: incumbent.id };
    }
    let demoted = null;
    if (incumbent && incumbent.id !== m.id) { incumbent.state = ModuleState.Shadow; demoted = incumbent.id; }  // gardé en repli
    m.state = ModuleState.Active;
    this.#logLineage(m, { op: 'promote', at: Date.now() });
    return { promoted: true, active: m.id, demoted };
  }
  /** Restaure le meilleur repli en actif (récupération de régression). */
  rollback(domain) {
    const cur = this.active(domain);
    const shadow = [...this.#modules.values()].filter(m => m.domain === domain && m.state === ModuleState.Shadow).sort((a, b) => b.score - a.score)[0];
    if (!shadow) return { ok: false, reason: 'aucun module en repli' };
    if (cur) cur.state = ModuleState.Retired;
    shadow.state = ModuleState.Active;
    this.#logLineage(shadow, { op: 'rollback', at: Date.now() });
    return { ok: true, active: shadow.id, retired: cur ? cur.id : null };
  }
  retire(id, reason = 'retiré') { const m = this.#get(id); m.state = ModuleState.Retired; m.retireReason = reason; return this.#view(m); }

  /** Réabsorption : l'adaptateur prouvé est fusionné dans la base (recette
   *  mergekit DARE-TIES). On le sort du pool actif et on trace la lignée. */
  reabsorb(id) {
    const m = this.#get(id);
    m.state = ModuleState.Reabsorbed;
    this.#logLineage(m, { op: 'reabsorb', into: m.base, at: Date.now() });
    return this.#view(m);
  }

  // ─── Protocole d'échange (prêt temporaire) ─────────────────────────────────
  /** Prête un module à une autre IA (retour auto après `ticks`). La signature du
   *  grant est déférée à secure/ (clés device existantes) : interface prête. */
  requestLoan(id, borrower, { ticks = 20 } = {}) {
    const m = this.#get(id);
    if (m.loan) return { ok: false, reason: `déjà prêté à ${m.loan.borrower}` };
    if (m.owner === borrower) return { ok: false, reason: 'déjà propriétaire' };
    m.loan = { borrower, since: Date.now(), ticks, elapsed: 0 };
    return { ok: true, grant: { id, owner: m.owner, borrower, ticks, sig: null } };
  }
  returnLoan(id) { const m = this.#get(id); const was = !!m.loan; m.loan = null; return { ok: was }; }
  /** Fait avancer les prêts d'un tick ; retourne automatiquement ceux échus. */
  tickLoans() {
    const returned = [];
    for (const m of this.#modules.values()) {
      if (m.loan && (++m.loan.elapsed >= m.loan.ticks)) { returned.push({ id: m.id, borrower: m.loan.borrower }); m.loan = null; }
    }
    return returned;
  }

  // ─── Auto-Healing (connecté à Sentinel) ────────────────────────────────────
  /** Liste les modules dégradés (score/santé sous seuil) à ré-évaluer ou quarantiner. */
  detectDegraded({ minScore = 30, minHealth = 0.5 } = {}) {
    const live = [ModuleState.Active, ModuleState.Shadow, ModuleState.Candidate];
    return [...this.#modules.values()]
      .filter(m => live.includes(m.state) && (m.score < minScore || m.health < minHealth))
      .map(m => ({ id: m.id, domain: m.domain, score: +m.score.toFixed(1), health: +m.health.toFixed(2) }));
  }
  quarantine(id, reason = 'dégradé') { return this.retire(id, 'quarantaine: ' + reason); }

  // ─── Lectures ──────────────────────────────────────────────────────────────
  #view(m) {
    return {
      id: m.id, domain: m.domain, owner: m.owner, base: m.base, sizeBytes: m.sizeBytes,
      state: m.state, health: +m.health.toFixed(3), score: +m.score.toFixed(2),
      uses: m.uses, lastUsedAt: m.lastUsedAt, createdAt: m.createdAt,
      lineage: m.lineage.slice(-10), evals: m.evals.slice(-3),
      loan: m.loan ? { ...m.loan } : null, counterfactual: m.counterfactual,
      retireReason: m.retireReason,
    };
  }
  get(id) { const m = this.#modules.get(id); return m ? this.#view(m) : null; }
  list(filter = {}) {
    let a = [...this.#modules.values()];
    if (filter.domain) a = a.filter(m => m.domain === filter.domain);
    if (filter.state)  a = a.filter(m => m.state === filter.state);
    return a.map(m => this.#view(m)).sort((x, y) => y.score - x.score);
  }
  stats() {
    const a = [...this.#modules.values()];
    const by = (k) => a.filter(m => m.state === k).length;
    return {
      total: a.length, active: by(ModuleState.Active), shadow: by(ModuleState.Shadow),
      candidate: by(ModuleState.Candidate), retired: by(ModuleState.Retired),
      reabsorbed: by(ModuleState.Reabsorbed), loaned: a.filter(m => m.loan).length,
    };
  }
}

export default LivingReserve;

// Démo/validation autonome : `node living_reserve.js`
if (import.meta.url === `file://${process.argv[1]}`) {
  const A = (c, l) => { console.log((c ? '✓' : '✗ ÉCHEC'), l); if (!c) process.exit(1); };
  const R = new LivingReserve();
  const ev = (overall) => ({ overall, suites: [{ name: 'frame-validity', score: overall }] });

  R.register({ id: 'ad_ai_1', domain: 'ai', owner: 'thevie', sizeBytes: 40e6 });
  R.register({ id: 'ad_ai_2', domain: 'ai', owner: 'loraevo', sizeBytes: 40e6 });
  R.register({ id: 'ad_ai_3', domain: 'ai', owner: 't369', sizeBytes: 40e6 });
  R.recordEval('ad_ai_1', ev(0.60));
  R.recordEval('ad_ai_2', ev(0.85));
  R.recordEval('ad_ai_3', ev(0.40));
  A(R.get('ad_ai_2').score > R.get('ad_ai_1').score, 'scoring : meilleure éval → meilleur score Vitality');

  A(R.promote('ad_ai_1').promoted === true, 'promotion : 1er module → actif (pas de titulaire)');
  const p2 = R.promote('ad_ai_2');
  A(p2.promoted === true && p2.demoted === 'ad_ai_1', 'promotion gâchée : ad_ai_2 bat l\'actif → titulaire en repli');
  A(R.active('ai').id === 'ad_ai_2', 'actif du domaine = ad_ai_2');
  A(R.promote('ad_ai_3').promoted === false, 'promotion REFUSÉE : score trop bas vs actif');

  const loan = R.requestLoan('ad_ai_2', 'thevie', { ticks: 2 });
  A(loan.ok === true && loan.grant.borrower === 'thevie', 'prêt : grant émis à thevie');
  A(!R.requestLoan('ad_ai_2', 'loraevo').ok, 'prêt : refus tant que déjà prêté');
  R.tickLoans();
  const ret = R.tickLoans();
  A(ret.length === 1 && ret[0].id === 'ad_ai_2', 'prêt : retour AUTOMATIQUE après échéance');

  const deg = R.detectDegraded();
  A(deg.some(d => d.id === 'ad_ai_3'), 'auto-healing : ad_ai_3 détecté comme dégradé');
  R.quarantine('ad_ai_3');
  A(R.get('ad_ai_3').state === 'retired', 'auto-healing : quarantaine → retiré');

  const rb = R.rollback('ai');
  A(rb.ok === true && rb.active === 'ad_ai_1' && rb.retired === 'ad_ai_2', 'rollback : repli ad_ai_1 réactivé, ad_ai_2 retiré');

  R.reabsorb('ad_ai_1');
  A(R.get('ad_ai_1').state === 'reabsorbed', 'réabsorption : ad_ai_1 fusionné dans la base');
  A(R.get('ad_ai_1').lineage.some(l => l.op === 'reabsorb'), 'réabsorption : lignée tracée');

  console.log('\nstats finales :', JSON.stringify(R.stats()));
  console.log('✓ Réserve Vivante — toutes les vérifs passent');
}
