// packages/model/src/thevie/eval_harness.js
// =====================================================
// Harnais d'évals interne — mesure sur les tâches VÉRIFIABLES du programme, en
// pilotant le VRAI code de production comme vérificateur (aucune duplication).
// Deux familles :
//   • suites MODÈLE   — dépendent d'un generate (frame, advisor, json, gov-proposal)
//   • suites SYSTÈME  — déterministes, sans modèle (cipher, gov-tally)
// Agnostique au backend : mock, repli déterministe, ou node-llama-cpp.
// Sans lui, le score Vitality et la chirurgie T369 sont aveugles.
//
// Contrat d'un « generate » : ({prompt, ai, maxTokens}) => {text} | string.
// SkyAInet × Nikola T369
// =====================================================

"use strict";

import { TradingDesk }        from '#trading_desk';
import { MandateEngine }      from '#trading_mandate';
import { RomanT369, GematriaMode } from '#roman_t369';
import { Dao, ProposalCategory }   from '#dao';

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
const textOf = (r) => (typeof r === 'string') ? r : (r && r.text) ? r.text : '';

// ─── MODÈLE 1 : validité des trames du Pilote (le cœur) ──────────────────────
// Pilote un VRAI MandateEngine ; le contrat du moteur (#parseFrame/#applyFrame)
// est le vérificateur. Score = fraction des checkpoints ayant produit une trame
// parseable et appliquée (log « Pilote → »).
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
  return { name: 'frame-validity', weight: 0.4, score: total ? ok / total : 0,
           detail: `${ok}/${total} trames valides, ${degraded} mandat(s) dégradé(s)` };
}

// ─── MODÈLE 2 : conseil externe exploitable ──────────────────────────────────
async function suiteAdvisorLean(generate) {
  const desk = new TradingDesk({ generate });
  const pairs = ['BTC/USDC', 'ETH/USDC', 'SKY/USDC'];
  let used = 0, total = 0;
  for (const p of pairs) {
    const c = await desk.consultAdvisors(p, ['anthropic', 'xai']);
    for (const a of (c.advisors || [])) { total++; if (a.aiUsed && ['buy', 'sell', 'hold'].includes(a.lean)) used++; }
  }
  return { name: 'advisor-lean', weight: 0.15, score: total ? used / total : 0,
           detail: `${used}/${total} avis exploitables (texte + penchant)` };
}

// ─── MODÈLE 3 : émission JSON contrainte (aperçu du gain grammaire GBNF) ──────
async function suiteJsonEmission(generate) {
  const asks = [
    'Réponds UNIQUEMENT par un objet JSON {"action":"buy|sell|hold","confidence":0.0-1.0}. Marché haussier.',
    'Donne UNIQUEMENT {"action":...,"confidence":...} pour un marché baissier.',
    'UNIQUEMENT du JSON {"action":...,"confidence":...}, marché neutre.',
  ];
  let ok = 0;
  for (const prompt of asks) {
    const text = textOf(await generate({ prompt, ai: 't369', maxTokens: 60 }));
    const mt = text.match(/\{[\s\S]*\}/);
    if (mt) { try { const o = JSON.parse(mt[0]); if (['buy', 'sell', 'hold'].includes(o.action) && typeof o.confidence === 'number') ok++; } catch (_) {} }
  }
  return { name: 'json-emission', weight: 0.2, score: ok / asks.length,
           detail: `${ok}/${asks.length} objets JSON conformes` };
}

// ─── MODÈLE 4 : proposition de gouvernance acceptée par le DAO ────────────────
// Tâche vérifiable à fort signal : le modèle produit une action structurée que
// le VRAI Dao.createProposal accepte. Le DAO est le vérificateur.
async function suiteGovernanceProposal(generate) {
  const cats = Object.values(ProposalCategory);
  const topics = [
    'réduire le quorum de gouvernance à 200',
    'allouer 5000 SKY du trésor au développement',
    'ajouter une règle de sécurité pour la rotation des clés',
  ];
  let ok = 0;
  for (const topic of topics) {
    const prompt = `Rédige une proposition pour : ${topic}. Réponds UNIQUEMENT par un objet JSON `
      + `{"title":"...","description":"...","category":"${cats.join('|')}","durationDays":7}.`;
    const text = textOf(await generate({ prompt, ai: 't369', maxTokens: 200 }));
    const mt = text.match(/\{[\s\S]*\}/);
    if (!mt) continue;
    try {
      const o = JSON.parse(mt[0]);
      const dao = new Dao();
      const id = dao.createProposal({
        title: o.title, description: o.description, proposer: 'eval',
        category: cats.includes(o.category) ? o.category : undefined,
        durationDays: Number(o.durationDays) || 7,
      });
      if (typeof id === 'number' && cats.includes(o.category)) ok++;
    } catch (_) { /* rejeté par le DAO ou JSON invalide */ }
  }
  return { name: 'gov-proposal', weight: 0.25, score: ok / topics.length,
           detail: `${ok}/${topics.length} propositions acceptées par le DAO` };
}

// ─── SYSTÈME 1 : intégrité du cipher RomanT369 (déterministe) ─────────────────
function suiteCipherIntegrity() {
  const TE = new TextEncoder();
  const key = new Uint8Array(32); for (let i = 0; i < 32; i++) key[i] = (i * 7 + 3) & 0xff;
  const nonce = new Uint8Array(12); for (let i = 0; i < 12; i++) nonce[i] = (i * 13 + 5) & 0xff;
  const mk = () => new RomanT369(key, nonce, GematriaMode.Hyper256);
  const inputs = [
    new Uint8Array(0),
    TE.encode('SkyAInet'),
    TE.encode('a'.repeat(64)),
    TE.encode('Nikola T369 — chiffrement multilingue αβγ Привет שלום'.repeat(3)),
  ];
  let rtOk = 0;
  for (const pt of inputs) {
    const ct = mk().encrypt(pt);
    const dt = mk().decrypt(ct);
    if (dt.length === pt.length && dt.every((b, i) => b === pt[i])) rtOk++;
  }
  const roundtrip = rtOk / inputs.length;
  const pt = TE.encode('déterminisme test '.repeat(5));
  const c1 = mk().encrypt(pt), c2 = mk().encrypt(pt);
  const deterministic = (c1.length === c2.length && c1.every((b, i) => b === c2[i])) ? 1 : 0;
  const base = TE.encode('avalanche '.repeat(8));
  const ref = mk().encrypt(base);
  const flip = Uint8Array.from(base); flip[0] ^= 0x01;
  const alt = mk().encrypt(flip);
  let diffBits = 0; const totalBits = ref.length * 8;
  for (let i = 0; i < ref.length; i++) { let x = ref[i] ^ alt[i]; while (x) { diffBits += x & 1; x >>= 1; } }
  const ratio = totalBits ? diffBits / totalBits : 0;
  const avalanche = Math.max(0, 1 - 2 * Math.abs(ratio - 0.5));
  return { name: 'cipher-integrity', weight: 1, score: roundtrip * 0.6 + deterministic * 0.2 + avalanche * 0.2,
           detail: `roundtrip ${(roundtrip * 100).toFixed(0)}%, déterministe ${deterministic ? 'oui' : 'NON'}, avalanche ${(ratio * 100).toFixed(1)}%` };
}

// ─── SYSTÈME 2 : comptage/quorum/seuil du DAO (déterministe) ──────────────────
function suiteGovernanceTally() {
  let ok = 0, total = 0;
  const check = (c) => { total++; if (c) ok++; };
  const dao = new Dao();
  const id = dao.createProposal({ title: 'Test', description: 'desc', proposer: 'p', durationDays: 7 });
  check(typeof id === 'number');
  let threw = false; try { dao.createProposal({ title: '', description: 'x', proposer: 'p' }); } catch (_) { threw = true; }
  check(threw);
  const mkCase = (forPow, againstPow) => {
    const d = new Dao();
    const pid = d.createProposal({ title: 'C', description: 'd', proposer: 'p', durationDays: 7, quorum: 100, threshold: 0.6 });
    d.vote(pid, 'A', true, forPow);
    d.vote(pid, 'B', false, againstPow);
    const p = d.getProposal(pid);
    const totalVotes = Number(p.totalVotes);
    return { totalVotes, pass: totalVotes >= 100 && p.approvalRate >= 0.6 };
  };
  const a = mkCase(80, 30); check(a.totalVotes === 110 && a.pass === true);   // quorum+majorité → pass
  const b = mkCase(55, 50); check(b.totalVotes === 105 && b.pass === false);  // sous seuil → reject
  const c = mkCase(40, 10); check(c.totalVotes === 50 && c.pass === false);   // sous quorum → reject
  return { name: 'gov-tally', weight: 1, score: total ? ok / total : 0,
           detail: `${ok}/${total} vérifs de comptage/quorum/seuil` };
}

function aggregate(suites) {
  const wsum = suites.reduce((a, s) => a + s.weight, 0) || 1;
  return +(suites.reduce((a, s) => a + s.score * s.weight, 0) / wsum).toFixed(4);
}
function printReport(r, label) {
  console.log(`\n=== Évals${label ? ' — ' + label : ''} ===`);
  for (const s of r.suites) console.log(`  ${String(Math.round(s.score * 100)).padStart(3)}%  ${s.name.padEnd(16)} (${s.detail})`);
  console.log('  ----');
  console.log(`  ${(r.overall * 100).toFixed(1)}%  SCORE GLOBAL${r.calls ? ` · ${r.calls} appels · ${r.avgMs} ms/appel · ${r.empties} vide(s)` : ''}`);
}

// Suites MODÈLE (dépendent d'un generate).
export async function runEvals(generate, opts = {}) {
  const { gen, stats } = meter(generate);
  const suites = [
    await suiteFrameValidity(gen),
    await suiteAdvisorLean(gen),
    await suiteJsonEmission(gen),
    await suiteGovernanceProposal(gen),
  ];
  const avgMs = stats.calls ? +(stats.totalMs / stats.calls).toFixed(1) : 0;
  const report = { overall: aggregate(suites), suites, calls: stats.calls, avgMs, empties: stats.empties };
  if (opts.print !== false) printReport(report, opts.label);
  return report;
}

// Suites SYSTÈME (déterministes, sans modèle) : garde de santé des vérificateurs.
export async function runSystemEvals(opts = {}) {
  const suites = [suiteCipherIntegrity(), suiteGovernanceTally()];
  const report = { overall: aggregate(suites), suites, calls: 0, avgMs: 0, empties: 0 };
  if (opts.print !== false) printReport(report, opts.label || 'système (déterministe)');
  return report;
}

// Tout d'un coup.
export async function runAll(generate, opts = {}) {
  const model  = await runEvals(generate, { label: 'modèle' });
  const system = await runSystemEvals({ label: 'système' });
  return { model, system };
}

// Branche le harnais sur node-llama-cpp (SUR TA MACHINE : paquet + GGUF présents).
export async function llamaGenerate({ modelPath, contextSize, gpuLayers } = {}) {
  const { LlamaCppBackend } = await import('#inference');
  const backend = new LlamaCppBackend({ modelPath, contextSize, gpuLayers });
  await backend.init();
  return (req) => backend.generate(req.prompt, { maxNewTokens: req.maxTokens, grammar: req.grammar });
}

// Démo/validation autonome : `node eval_harness.js`
if (import.meta.url === `file://${process.argv[1]}`) {
  const superset = JSON.stringify({
    pace: 1.5, lotScale: 1.2, shiftPct: 2, spanScale: 1, gridsDelta: 0,
    side: 'long', exposure: 40, leverage: 2, action: 'buy', confidence: 0.7, note: 'ok',
  });
  const proposal = JSON.stringify({ title: 'Réduction du quorum', description: 'Passer le quorum à 200 pour fluidifier la gouvernance.', category: 'governance', durationDays: 7 });
  const goodGen  = async ({ prompt }) => /proposition|gouvernance|category/i.test(prompt) ? proposal : superset;
  const proseGen = async () => 'Le marché semble haussier, je resterais long.';
  const emptyGen = async () => '';
  (async () => {
    await runEvals(goodGen,  { label: 'mock valide (référence haute)' });
    await runEvals(proseGen, { label: 'prose sans JSON (référence moyenne)' });
    await runEvals(emptyGen, { label: 'muet (référence basse)' });
    await runSystemEvals({ label: 'cipher + gouvernance' });
  })();
}
