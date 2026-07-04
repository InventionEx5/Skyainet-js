// infra/vitality/phase0_bringup.js
// =====================================================
// Bring-up Phase 0 — monte les TROIS cerveaux (thevie / loraevo / t369), chacun
// son GGUF, sort les premiers scores réels + une concertation de contrôle.
// Chaîne : (SLERP mergekit) → convert_hf_to_gguf → llama-quantize → charge ×3 →
// runEvals par cerveau → triad_concert. À lancer sur le PC 32 Go (node-llama-cpp
// + GGUF présents). Le mode --dry-run valide TOUTE l'orchestration avec des
// cerveaux mock, sans aucun modèle (testable dès maintenant).
//
// Usage :
//   node infra/vitality/phase0_bringup.js --dry-run   # valide la chaîne, sans modèle
//   node infra/vitality/phase0_bringup.js --build      # construit les 3 GGUF (mergekit→convert→quantize)
//   node infra/vitality/phase0_bringup.js              # charge les GGUF + évalue + concerte
//   node infra/vitality/phase0_bringup.js --build --eval  # tout d'affilée
// SkyAInet × Nikola T369
// =====================================================

"use strict";

import { spawnSync } from 'child_process';
import { existsSync } from 'fs';

// ── Config des trois cerveaux (à ajuster à ton arborescence) ──
const BRAINS = [
  { name: 'thevie',  domain: 'généraliste',  gguf: './models/thevie-Q4_K_M.gguf',  merge: './infra/vitality/merge_thevie.yaml'  },
  { name: 'loraevo', domain: 'code',         gguf: './models/loraevo-Q4_K_M.gguf', merge: './infra/vitality/merge_loraevo.yaml' },
  { name: 't369',    domain: 'raisonnement', gguf: './models/t369-Q4_K_M.gguf',    merge: './infra/vitality/merge_t369.yaml'    },
];
const TOOLS = {
  mergekit:  process.env.MERGEKIT      || 'mergekit-yaml',
  convert:   process.env.LLAMA_CONVERT || 'python3 llama.cpp/convert_hf_to_gguf.py',
  quantize:  process.env.LLAMA_QUANTIZE|| './llama.cpp/llama-quantize',
  quantType: process.env.QUANT         || 'Q4_K_M',
};

function sh(line, label) {
  console.log(`  $ ${line}`);
  const r = spawnSync(line, { stdio: 'inherit', shell: true });
  if (r.status !== 0) throw new Error(`[bringup] échec: ${label}`);
}

// ── (1) Construire un GGUF : merge → convert (f16) → quantize ──
function buildBrain(b) {
  console.log(`\n[build] ${b.name} (${b.domain})`);
  const merged = `./models/_merged_${b.name}`;
  const f16    = `./models/${b.name}-f16.gguf`;
  sh(`${TOOLS.mergekit} ${b.merge} ${merged} --allow-crimes --out-shard-size 1B`, `mergekit ${b.name}`);
  sh(`${TOOLS.convert} ${merged} --outfile ${f16}`,                                `convert ${b.name}`);
  sh(`${TOOLS.quantize} ${f16} ${b.gguf} ${TOOLS.quantType}`,                       `quantize ${b.name}`);
  console.log(`  → ${b.gguf}`);
}

// ── (2) Charger un cerveau (réel node-llama-cpp, ou mock en dry-run) ──
async function loadBrain(b, { dryRun }) {
  if (dryRun) {
    // Cerveau mock : émet des trames/propositions valides → valide l'orchestration.
    const superset = JSON.stringify({ pace: 1.5, lotScale: 1.2, shiftPct: 2, spanScale: 1, gridsDelta: 0, side: 'long', exposure: 40, leverage: 2, action: 'buy', confidence: 0.7, note: 'ok' });
    const proposal = JSON.stringify({ title: 'T', description: 'd', category: 'governance', durationDays: 7 });
    return async ({ prompt }) => ({ text: /proposition|gouvernance|category/i.test(prompt) ? proposal : superset });
  }
  if (!existsSync(b.gguf)) throw new Error(`[bringup] GGUF manquant : ${b.gguf} (lance --build d'abord)`);
  const { LlamaCppBackend } = await import('#inference');
  const backend = new LlamaCppBackend({ modelPath: b.gguf });
  await backend.init();
  return (req) => backend.generate(req.prompt, { maxNewTokens: req.maxTokens, grammar: req.grammar });
}

// Extraction d'un penchant directionnel depuis un texte libre (pour la concertation).
const leanOf = (t) => { const m = /\b(buy|sell|hold|long|short)\b/i.exec(t || ''); if (!m) return null; const w = m[1].toLowerCase(); return w === 'long' ? 'buy' : w === 'short' ? 'sell' : w; };

// ── (3) Orchestration ──
async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const doBuild = args.includes('--build');

  if (doBuild) {
    for (const b of BRAINS) buildBrain(b);
    if (!args.includes('--eval')) { console.log('\n[build] terminé. Relance sans --build pour évaluer.'); return; }
  }

  const { runEvals }     = await import('#eval_harness');
  const { triadConcert } = await import('#living_reserve');

  console.log(`\n=== Bring-up Phase 0 — trois cerveaux ${dryRun ? '(DRY-RUN mock)' : ''} ===`);
  const generates = {};
  const board = [];
  for (const b of BRAINS) {
    const gen = await loadBrain(b, { dryRun });
    generates[b.name] = gen;
    const report = await runEvals(gen, { print: false });
    board.push({ name: b.name, domain: b.domain, score: +(report.overall * 100).toFixed(1) });
    console.log(`  ${b.name.padEnd(8)} (${b.domain.padEnd(13)}) → score ${(report.overall * 100).toFixed(1).padStart(5)}%`);
  }

  // Concertation de contrôle : les trois cerveaux délibèrent, T369 agrège.
  const con = await triadConcert({
    prompt: 'BTC/USDC maintenant : buy, sell ou hold ? Réponds en un mot.',
    generate: ({ prompt, ai }) => generates[ai]({ prompt, ai }),
    members: BRAINS.map(b => b.name),
    extract: leanOf,
  });
  console.log(`\n  concertation → ${con.decision.label || '(pas de consensus)'} ${con.decision.tiebreak ? '(T369 tranche)' : `par ${con.decision.votes}/3${con.decision.unanimous ? ' unanime' : ''}`}`);
  console.log('=== Bring-up terminé ===');
  return { board, concert: con.decision };
}

main().catch(e => { console.error(e.message); process.exit(1); });
