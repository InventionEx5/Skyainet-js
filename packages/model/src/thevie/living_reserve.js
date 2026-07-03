// packages/model/src/thevie/living_reserve.js
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

// ─── Pipeline T369 — boucle de feedback de bout en bout ──────────────────────
// Le « chirurgien/régulateur » T369 en action. Chaîne : évaluer (harnais) →
// enregistrer le score → décider la promotion (gâchée par le score). Testable en
// mock : `generate` représente l'inférence du module candidat (base + adaptateur).
export async function t369FeedbackCycle(reserve, id, generate, opts = {}) {
  const { runEvals } = await import('#eval_harness');
  const report = await runEvals(generate, { print: opts.print ?? false });   // 1) mesurer
  reserve.recordEval(id, report);                                            // 2) enregistrer (score + santé)
  const decision = reserve.promote(id, { margin: opts.margin ?? 2 });        // 3) décider
  return { id, overall: report.overall, score: reserve.get(id).score, promoted: decision.promoted, decision };
}

// ─── Data Factory — robinet du daemon de trading vers un JSONL d'entraînement ──
// Capte les échantillons cockpit→trame→résultat émis par MandateEngine ('sample'),
// ne garde que le SIGNAL VÉRIFIÉ (récompense réelle : gain > 0 par défaut), et les
// met au format `messages` attendu par train_adapter.py. Brancher via .tap(engine),
// lire via .jsonl, écrire via .flushToFile().
export class DataFactory {
  #buffer = []; #seen = 0; #kept = 0; #verify;
  constructor({ verify } = {}) {
    this.#verify = typeof verify === 'function' ? verify : (s) => (s.gain ?? 0) > 0;
  }
  tap(engine) { engine.on('sample', (s) => this.ingest(s)); return this; }
  ingest(sample) {
    this.#seen++;
    if (!sample || !sample.prompt || !sample.frame) return false;
    if (!this.#verify(sample)) return false;                                 // filtre : récompense vérifiée
    this.#buffer.push(JSON.stringify({
      messages: [
        { role: 'user',      content: sample.prompt },
        { role: 'assistant', content: JSON.stringify(sample.frame) },
      ],
    }));
    this.#kept++; return true;
  }
  get jsonl() { return this.#buffer.join('\n'); }
  stats() { return { seen: this.#seen, kept: this.#kept, buffered: this.#buffer.length }; }
  clear() { const n = this.#buffer.length; this.#buffer = []; return n; }
  async flushToFile(path) {
    const { writeFile } = await import('fs/promises');
    const body = this.#buffer.length ? this.#buffer.join('\n') + '\n' : '';
    await writeFile(path, body, 'utf8');
    const n = this.#buffer.length; this.#buffer = []; return { path, written: n };
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

// Démo (b) pipeline T369 de bout en bout + (c) Data Factory : `node living_reserve.js`
if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    const A = (c, l) => { console.log((c ? '✓' : '✗ ÉCHEC'), l); if (!c) process.exit(1); };
    const superset = JSON.stringify({ pace:1.5, lotScale:1.2, shiftPct:2, spanScale:1, gridsDelta:0, side:'long', exposure:40, leverage:2, action:'buy', confidence:0.7, note:'ok' });
    const proposal = JSON.stringify({ title:'Réduire le quorum', description:'Passer le quorum à 200.', category:'governance', durationDays:7 });
    const goodGen = async ({ prompt }) => /proposition|gouvernance|category/i.test(prompt) ? proposal : superset;
    const weakGen = async () => 'le marché me semble haussier';

    // ── (b) Pipeline T369 : runEvals → recordEval → promote ──
    const R2 = new LivingReserve();
    R2.register({ id: 'cand_good', domain: 'ai', owner: 'thevie',  sizeBytes: 40e6 });
    R2.register({ id: 'cand_weak', domain: 'ai', owner: 'loraevo', sizeBytes: 40e6 });
    const cg = await t369FeedbackCycle(R2, 'cand_good', goodGen);
    A(cg.promoted === true, 'pipeline T369 : bon module évalué → enregistré → PROMU');
    const cw = await t369FeedbackCycle(R2, 'cand_weak', weakGen);
    A(cw.promoted === false, 'pipeline T369 : module faible → score bas → promotion refusée');
    A(R2.active('ai').id === 'cand_good', 'pipeline T369 : le meilleur module reste actif (boucle bouclée)');
    console.log(`   (bon: score ${cg.score.toFixed(1)} · faible: score ${cw.score.toFixed(1)})`);

    // ── (c) Data Factory : robinet du daemon → JSONL vérifié ──
    const { TradingDesk }   = await import('#trading_desk');
    const { MandateEngine } = await import('#trading_mandate');
    const OBJ = { horizonTicks:1000, takeProfitPct:100000, maxLossPct:99, maxDrawdownPct:99 };
    const desk = new TradingDesk();
    const eng  = new MandateEngine({ desk, generate: async () => superset });
    const factory = new DataFactory().tap(eng);
    desk.setMarkPrice('ETH/USDC', 3200);
    const mdt = eng.createMandate({ capital:1000, pairs:['ETH/USDC'], strategy:'dca', strategyParams:{everyTicks:2}, perTradePct:10, pilotEveryTicks:2, objectives:OBJ });
    for (const px of [3200,3300,3400,3500,3600,3700]) { desk.setMarkPrice('ETH/USDC', px); await eng.runTick(mdt.id); }
    const st = factory.stats();
    A(st.seen > 0, 'data factory : échantillons captés du daemon (cockpit→trame→résultat)');
    A(st.kept > 0, 'data factory : signal vérifié (gain>0) retenu, reste filtré');
    const first = JSON.parse(factory.jsonl.split('\n')[0]);
    A(first.messages && first.messages[0].role === 'user' && first.messages[1].role === 'assistant', 'data factory : format JSONL {messages:[user,assistant]}');
    A(first.messages[0].content.includes('PILOTE'), 'data factory : le prompt cockpit est présent (entraînable)');
    console.log(`   (data factory: ${st.seen} captés, ${st.kept} retenus → ${factory.jsonl.split('\n').length} lignes JSONL)`);
    console.log('✓ Pipeline T369 + Data Factory — toutes les vérifs passent');
  })();
}
