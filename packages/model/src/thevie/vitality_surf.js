// packages/model/src/thevie/vitality_surf.js
// =====================================================
// Vitality Surf — recherche web SUPERVISÉE, BUDGÉTÉE, pilotée par les LACUNES.
// Thevie/LoraÉvo proposent des intentions d'exploration issues des clusters
// d'échec MESURÉS (harnais d'évals) + des lacunes de couverture de la Réserve ;
// T369 valide et attribue un BUDGET (il limite, ne censure quasi jamais) ; un
// fetcher COMPLIANT récupère ; filtrage temps réel (sécurité / qualité /
// redondance) ; distillation par la triade → JSONL VÉRIFIÉ pour la Data Factory.
//
// PRINCIPE : Vitality Surf produit des DONNÉES, pas des paramètres. Transformer
// le JSONL en Modules Vivants (adaptateurs) reste l'étape d'entraînement GPU
// (Phase 1) — même chaîne que la Data Factory et train_adapter.py.
//
// CONFORMITÉ (non négociable) : le fetcher DOIT respecter robots.txt, limiter le
// débit, et s'identifier honnêtement (UA). PAS de stealth / spoofing de
// fingerprint / contournement d'anti-bot — voir la note dans le fetcher.
// SkyAInet × Nikola T369
// =====================================================

"use strict";

export const SurfRisk = Object.freeze({ Low: 'low', Medium: 'medium', High: 'high', Blocked: 'blocked' });

// ─── (1) Curiosité DIRIGÉE PAR LES LACUNES MESURÉES ──────────────────────────
// Transforme les suites d'évals sous seuil + les domaines sans module actif en
// intentions d'exploration, triées par importance. Pas de "au hasard" : data-driven.
export function deriveIntents({ evalReport = null, reserve = null, domains = ['dca', 'grid', 'ai', 'gov', 'cipher'], extra = [], max = 8 } = {}) {
  const intents = [];
  if (evalReport && Array.isArray(evalReport.suites)) {
    for (const s of evalReport.suites) {
      if (s.score < 0.7) intents.push({ topic: `combler la faiblesse: ${s.name}`, source: 'eval-gap', weight: 1 - s.score });
    }
  }
  if (reserve && typeof reserve.list === 'function') {
    const active = new Set(reserve.list({ state: 'active' }).map(m => m.domain));
    for (const dom of domains) if (!active.has(dom)) intents.push({ topic: `couverture manquante: ${dom}`, source: 'reserve-gap', weight: 0.5 });
  }
  for (const e of extra) intents.push({ topic: String(e), source: 'proposed', weight: 0.4 });
  return intents.sort((a, b) => b.weight - a.weight).slice(0, max);
}

// ─── (2) Superviseur T369 : valide + attribue un BUDGET (limite, refuse rarement) ─
export class SurfSupervisor {
  constructor({ classify = null, budgets = {} } = {}) {
    this.classify = classify || (() => SurfRisk.Low);   // hook classifieur de risque (sécurité)
    this.budgets  = { maxPages: 12, maxDepth: 2, maxMs: 60000, ...budgets };
  }
  authorize(intent) {
    const risk = this.classify(intent);
    if (risk === SurfRisk.Blocked) return { ok: false, risk, reason: 'catégorie interdite (sécurité)' };
    const scale = risk === SurfRisk.High ? 0.3 : risk === SurfRisk.Medium ? 0.6 : 1;   // on LIMITE selon le risque
    return {
      ok: true, risk,
      budget: {
        maxPages: Math.max(1, Math.round(this.budgets.maxPages * scale)),
        maxDepth: risk === SurfRisk.High ? 1 : this.budgets.maxDepth,
        maxMs   : Math.round(this.budgets.maxMs * scale),
      },
    };
  }
}

// ─── (3+4) Session d'exploration COMPLIANT + filtrage temps réel ─────────────
// Le fetcher est INJECTÉ. Contrat obligatoire : async (url) => { url, text, links[],
// allowed } où `allowed` reflète robots.txt, avec limitation de débit et UA
// honnête EN AMONT. PAS de stealth. Filtres : sécurité, qualité (pertinence),
// redondance (dédup par empreinte).
export class SurfSession {
  #seen = new Set();
  constructor({ fetcher, safety = null, quality = null } = {}) {
    if (typeof fetcher !== 'function') throw new Error('[Surf] fetcher requis (COMPLIANT : robots.txt + rate limit + UA honnête, sans stealth)');
    this.fetcher = fetcher;
    this.safety  = safety  || (async () => true);                                  // rejette NSFW / malware / désinfo
    this.quality = quality || ((page) => !!page.text && page.text.length > 200);   // pertinence minimale
  }
  async explore(intent, budget) {
    const t0 = Date.now();
    const kept = [];
    const queue = intent.seedUrl ? [{ url: intent.seedUrl, depth: 0 }] : [];
    let pages = 0, skippedRobots = 0, deduped = 0;
    while (queue.length && pages < budget.maxPages && (Date.now() - t0) < budget.maxMs) {
      const { url, depth } = queue.shift();
      let page;
      try { page = await this.fetcher(url); } catch (_) { continue; }
      pages++;
      if (!page || page.allowed === false) { skippedRobots++; continue; }           // robots.txt → on saute
      const h = hashText(page.text || '');
      if (this.#seen.has(h)) { deduped++; continue; }                               // redondance
      this.#seen.add(h);
      if (!(await this.safety(page))) continue;                                     // sécurité
      if (!this.quality(page, intent)) continue;                                    // qualité
      kept.push({ url: page.url || url, text: page.text });
      if (depth < budget.maxDepth) for (const l of (page.links || []).slice(0, 5)) queue.push({ url: l, depth: depth + 1 });
    }
    return { intent: intent.topic, pagesFetched: pages, kept, skippedRobots, deduped, ms: Date.now() - t0 };
  }
}

// Enveloppe un fetcher pour GARANTIR un débit minimal entre requêtes (politesse).
// À composer avec un fetcher qui, lui, respecte robots.txt et envoie un UA honnête.
export function rateLimited(fetcher, minDelayMs = 1500) {
  let last = 0;
  return async (url) => {
    const wait = Math.max(0, minDelayMs - (Date.now() - last));
    if (wait) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
    return fetcher(url);
  };
}

// ─── (5) Distillation par la triade → JSONL VÉRIFIÉ (score de vitalité) ──────
// Thevie synthétise, LoraÉvo extrait l'actionnable, T369 score. Seul le signal à
// haute vitalité est conservé. ANTI-EFFONDREMENT : privilégier des connaissances
// VÉRIFIABLES ; le score triade est un filtre doux, pas une garantie.
export async function surfDistill({ pages, triad = {}, verify = null, minVitality = 0.6 }) {
  const dataset = [];
  for (const page of pages) {
    const synthesis  = triad.synthesize ? await triad.synthesize(page) : page.text;
    const actionable = triad.extract    ? await triad.extract(page)    : synthesis;
    const vitality   = triad.score      ? await triad.score({ page, synthesis, actionable }) : 1;
    const sample = { source: page.url, synthesis, actionable, vitality };
    if (vitality >= minVitality && (!verify || verify(sample))) {
      dataset.push({ messages: [{ role: 'user', content: `Connaissance issue de: ${page.url}` }, { role: 'assistant', content: actionable }] });
    }
  }
  return { kept: dataset.length, jsonl: dataset.map((d) => JSON.stringify(d)).join('\n') };
}

// ─── Orchestration complète (une passe) : lacune → budget → surf → distill ───
export async function runSurf({ intent, supervisor, session, triad, verify, minVitality }) {
  const auth = supervisor.authorize(intent);
  if (!auth.ok) return { ok: false, reason: auth.reason, risk: auth.risk };
  const crawl = await session.explore(intent, auth.budget);
  const distilled = await surfDistill({ pages: crawl.kept, triad, verify, minVitality });
  return { ok: true, risk: auth.risk, budget: auth.budget, crawl, distilled };
}

function hashText(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }

// Démo/validation autonome : `node vitality_surf.js`  (mocks — aucun réseau, aucun stealth)
if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    const A = (c, l) => { console.log((c ? '✓' : '✗ ÉCHEC'), l); if (!c) process.exit(1); };

    // (1) Curiosité dirigée par les lacunes mesurées
    const evalReport = { suites: [{ name: 'gov-proposal', score: 0.3 }, { name: 'frame-validity', score: 0.9 }, { name: 'json-emission', score: 0.5 }] };
    const reserve = { list: ({ state }) => state === 'active' ? [{ domain: 'dca' }, { domain: 'ai' }] : [] };
    const intents = deriveIntents({ evalReport, reserve });
    A(intents[0].source === 'eval-gap' && intents[0].topic.includes('gov-proposal'), 'curiosité : plus grosse faiblesse mesurée (gov-proposal 0.3) en tête');
    A(intents.some(i => i.source === 'reserve-gap' && i.topic.includes('grid')), 'curiosité : domaine sans module actif (grid) → couverture manquante');

    // (2) Superviseur T369 : budget selon le risque, refuse le bloqué
    const sup = new SurfSupervisor({ classify: (i) => i.topic.includes('gov') ? SurfRisk.Medium : SurfRisk.Low });
    const a1 = sup.authorize({ topic: 'gouvernance on-chain' });
    A(a1.ok && a1.budget.maxPages === 7, 'superviseur : risque moyen → budget limité (12→7 pages), pas refusé');
    const supBlock = new SurfSupervisor({ classify: () => SurfRisk.Blocked });
    A(supBlock.authorize({ topic: 'x' }).ok === false, 'superviseur : catégorie interdite → refus (sécurité)');

    // (3+4) Exploration compliant + filtres (fetcher MOCK : pas de réseau, pas de stealth)
    const corpus = {
      'seed':  { url: 'seed',  text: 'A'.repeat(500) + ' gouvernance décentralisée', links: ['p2', 'p3', 'blocked'], allowed: true },
      'p2':    { url: 'p2',    text: 'B'.repeat(500) + ' vote quadratique', links: [], allowed: true },
      'p3':    { url: 'p3',    text: 'A'.repeat(500) + ' gouvernance décentralisée', links: [], allowed: true },   // doublon de seed
      'blocked': { url: 'blocked', text: 'C'.repeat(500), links: [], allowed: false },                           // robots.txt interdit
    };
    let calls = 0;
    const mockFetcher = async (url) => { calls++; return corpus[url] || null; };
    const session = new SurfSession({ fetcher: rateLimited(mockFetcher, 0) });
    const crawl = await session.explore({ topic: 'gouvernance', seedUrl: 'seed' }, a1.budget);
    A(crawl.kept.length === 2 && crawl.deduped === 1 && crawl.skippedRobots === 1, 'exploration : 2 pages gardées, 1 doublon dédupliqué, 1 bloquée par robots.txt');

    // (5) Distillation triade → JSONL vérifié
    const triad = {
      synthesize: async (p) => 'synthèse: ' + p.text.slice(0, 12),
      extract:    async (p) => 'actionnable: ' + p.url,
      score:      async ({ page }) => page.url === 'p2' ? 0.9 : 0.4,   // seul p2 passe le seuil de vitalité
    };
    const distilled = await surfDistill({ pages: crawl.kept, triad, minVitality: 0.6 });
    A(distilled.kept === 1 && distilled.jsonl.includes('actionnable: p2'), 'distillation : seul le signal à haute vitalité conservé → 1 ligne JSONL');
    const parsed = JSON.parse(distilled.jsonl.split('\n')[0]);
    A(parsed.messages[0].role === 'user' && parsed.messages[1].role === 'assistant', 'distillation : format JSONL {messages:[user,assistant]} (Data Factory / train_adapter.py)');

    // Orchestration complète (une passe)
    const full = await runSurf({ intent: { topic: 'gouvernance', seedUrl: 'seed' }, supervisor: sup, session: new SurfSession({ fetcher: mockFetcher }), triad, minVitality: 0.6 });
    A(full.ok && full.distilled.kept >= 1, 'orchestration : lacune → budget → surf → distill (une passe complète)');
    console.log(`   (surf: budget ${a1.budget.maxPages}p, ${crawl.kept.length} gardées, ${distilled.kept} distillées → JSONL)`);
    console.log('✓ Vitality Surf — recherche supervisée/budgétée/compliant, toutes les vérifs passent');
  })();
}
