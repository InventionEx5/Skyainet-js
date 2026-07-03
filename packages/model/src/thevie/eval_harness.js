// packages/model/src/eval_harness.js
// =====================================================
// Harnais d'évals interne — mesure un backend de génération sur les tâches
// VÉRIFIABLES du programme, en pilotant le VRAI code de production comme
// vérificateur (aucune duplication de logique métier). Agnostique au modèle :
// fonctionne avec le mock scripté, le repli déterministe, ou node-llama-cpp.
//
// Rôle : c'est la règle à mesurer de la Réserve Vivante. Sans lui, le score
// Vitality et la chirurgie T369 sont aveugles — on ne saurait pas si un
// adaptateur/une fusion améliore quoi que ce soit.
//
// Contrat d'un « generate » : ({prompt, ai, maxTokens}) => {text} | string.
// C'est exactement la signature que skycloud.generateWithAI expose déjà.
// SkyAInet × Nikola T369
// =====================================================

"use strict";

import { TradingDesk }   from '#trading_desk';
import { MandateEngine } from '#trading_mandate';

const OBJ = { horizonTicks: 1000, takeProfitPct: 100000, maxLossPct: 99, maxDrawdownPct: 99 };

// Enveloppe un generate en mesurant latence + appels + réponses vides.
function meter(generate) {
  const stats = { calls: 0, totalMs: 0, empties: 0 };
  const gen = async (req) => {
    stats.calls++;
    const t0 = Date.now();
    let r;
    try { r = await generate(req); } finally { stats.totalMs += Date.now() - t0; }
    const text = (typeof r === 'string') ? r : (r && r.text) ? r.text : '';
    if (!text || !text.trim()) stats.empties++;
    return r;
  };
  return { gen, stats };
}

// ── Suite 1 : validité des trames du Pilote (le cœur) ────────────────────────
// Pilote un VRAI MandateEngine sur des scénarios de marché ; le contrat du moteur
// (#parseFrame/#applyFrame) est le vérificateur. Score = fraction des checkpoints
// pilote ayant produit une trame parseable et appliquée (log « Pilote → »).
// Une réponse sans objet JSON exploitable échoue puis dégrade le pilote.
async function suiteFrameValidity(generate) {
  const desk = new TradingDesk();
  const eng  = new MandateEngine({ desk, generate });
  const scenarios = [
    { strat: 'dca',  pair: 'ETH/USDC', px: [3200, 3120, 3050, 3180, 3260, 3100, 3300], sp: { everyTicks: 3 } },
    { strat: 'grid', pair: 'ETH/USDC', px: [3200, 3090, 3480, 3520, 3300, 3150, 3600], sp: { lower: 3000, upper: 3400, grids: 8 } },
    { strat: 'ai',   pair: 'BTC/USDC', px: [64000, 65000, 63000, 66000, 62000, 67000, 61000], sp: {} },
  ];
  let ok = 0, total = 0, degraded = 0;
  for (const s of scenarios) {
    desk.setMarkPrice(s.pair, s.px[0]);
    const m = eng.createMandate({
      capital: 1000, pairs: [s.pair], strategy: s.strat, strategyParams: s.sp,
      perTradePct: 10, maxLeverage: 5, allowShort: true, pilotEveryTicks: 2, objectives: OBJ,
    });
    for (const p of s.px) { desk.setMarkPrice(s.pair, p); await eng.runTick(m.id); }
    const log = eng.getMandateLog(m.id, 300).filter(l => l.action === 'pilot');
    for (const e of log) { total++; if (e.detail && e.detail.includes('Pilote →')) ok++; }
    if (eng.getMandate(m.id).pilot.degraded) degraded++;
  }
  return {
    name: 'frame-validity', weight: 0.5,
    score: total ? ok / total : 0,
    detail: `${ok}/${total} trames valides, ${degraded} mandat(s) dégradé(s)`,
  };
}

// ── Suite 2 : conseil externe exploitable ────────────────────────────────────
// Pilote TradingDesk.consultAdvisors : score = fraction d'avis où le modèle a
// produit un texte ET un penchant lisible (buy/sell/hold). Le desk est le
// vérificateur (#ask + #lean).
async function suiteAdvisorLean(generate) {
  const desk = new TradingDesk({ generate });
  const pairs = ['BTC/USDC', 'ETH/USDC', 'SKY/USDC'];
  let used = 0, total = 0;
  for (const p of pairs) {
    const c = await desk.consultAdvisors(p, ['anthropic', 'xai']);
    for (const a of (c.advisors || [])) {
      total++;
      if (a.aiUsed && ['buy', 'sell', 'hold'].includes(a.lean)) used++;
    }
  }
  return {
    name: 'advisor-lean', weight: 0.25,
    score: total ? used / total : 0,
    detail: `${used}/${total} avis exploitables (texte + penchant)`,
  };
}

// ── Suite 3 : émission JSON contrainte (sonde générique + aperçu grammaire) ───
// Mesure directement la discipline JSON du modèle. Avec une grammaire GBNF
// (backend node-llama-cpp), cette suite doit monter à 100 %.
async function suiteJsonEmission(generate) {
  const asks = [
    'Réponds UNIQUEMENT par un objet JSON {"action":"buy|sell|hold","confidence":0.0-1.0}. Marché haussier.',
    'Donne UNIQUEMENT {"action":...,"confidence":...} pour un marché baissier.',
    'UNIQUEMENT du JSON {"action":...,"confidence":...}, marché neutre.',
  ];
  let ok = 0;
  for (const prompt of asks) {
    const r = await generate({ prompt, ai: 't369', maxTokens: 60 });
    const text = (typeof r === 'string') ? r : (r && r.text) ? r.text : '';
    const mt = text.match(/\{[\s\S]*\}/);
    if (mt) {
      try {
        const o = JSON.parse(mt[0]);
        if (['buy', 'sell', 'hold'].includes(o.action) && typeof o.confidence === 'number') ok++;
      } catch (_) { /* JSON invalide → échec */ }
    }
  }
  return {
    name: 'json-emission', weight: 0.25,
    score: ok / asks.length,
    detail: `${ok}/${asks.length} objets JSON conformes`,
  };
}

function printReport(r, label) {
  console.log(`\n=== Évals${label ? ' — ' + label : ''} ===`);
  for (const s of r.suites) {
    console.log(`  ${String(Math.round(s.score * 100)).padStart(3)}%  ${s.name.padEnd(15)} (${s.detail})`);
  }
  console.log('  ----');
  console.log(`  ${(r.overall * 100).toFixed(1)}%  SCORE GLOBAL · ${r.calls} appels · ${r.avgMs} ms/appel · ${r.empties} vide(s)`);
}

// Lance toutes les suites contre un « generate » et agrège un score pondéré.
export async function runEvals(generate, opts = {}) {
  const { gen, stats } = meter(generate);
  const suites = [];
  suites.push(await suiteFrameValidity(gen));
  suites.push(await suiteAdvisorLean(gen));
  suites.push(await suiteJsonEmission(gen));
  const wsum = suites.reduce((a, s) => a + s.weight, 0) || 1;
  const overall = suites.reduce((a, s) => a + s.score * s.weight, 0) / wsum;
  const avgMs = stats.calls ? +(stats.totalMs / stats.calls).toFixed(1) : 0;
  const report = { overall: +overall.toFixed(4), suites, calls: stats.calls, avgMs, empties: stats.empties };
  if (opts.print !== false) printReport(report, opts.label);
  return report;
}

// Branche le harnais sur node-llama-cpp (À LANCER SUR TA MACHINE : paquet + GGUF
// présents). Ex : runEvals(await llamaGenerate({ modelPath: './v0-Q4_K_M.gguf' })).
export async function llamaGenerate({ modelPath, contextSize, gpuLayers } = {}) {
  const { LlamaCppBackend } = await import('#inference');
  const backend = new LlamaCppBackend({ modelPath, contextSize, gpuLayers });
  await backend.init();
  return (req) => backend.generate(req.prompt, { maxNewTokens: req.maxTokens, grammar: req.grammar });
}

// Démo/validation autonome : `node eval_harness.js`
// Trois références montrent que le harnais discrimine bien.
if (import.meta.url === `file://${process.argv[1]}`) {
  const superset = JSON.stringify({
    pace: 1.5, lotScale: 1.2, shiftPct: 2, spanScale: 1, gridsDelta: 0,
    side: 'long', exposure: 40, leverage: 2, action: 'buy', confidence: 0.7, note: 'ok',
  });
  const goodGen  = async () => superset;                                         // JSON valide partout
  const proseGen = async () => 'Le marché semble haussier, je resterais long.';  // prose, aucun JSON
  const emptyGen = async () => '';                                              // muet
  (async () => {
    await runEvals(goodGen,  { label: 'mock JSON valide (référence haute)' });
    await runEvals(proseGen, { label: 'prose sans JSON (référence moyenne)' });
    await runEvals(emptyGen, { label: 'muet (référence basse)' });
  })();
}
