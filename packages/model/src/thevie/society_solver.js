// packages/model/src/thevie/society_solver.js
// =====================================================
// Society Solver — « problème → trilogue → COMPTE RENDU ».
// Un registre de problèmes (sociétal / culturel / environnemental / travail /
// médical / scientifique…), une sélection par priorité, et un solveur qui lance
// le trilogue (SpaceAI : proposer → critic → synthesizer) pour PRODUIRE UNE
// SOLUTION livrée en compte rendu à des HUMAINS.
//
// CÔTÉ RAPPORT, PAS ENTRAÎNEMENT : la sortie va au compte rendu, jamais au
// tampon de rejeu / à la distillation. C'est pourquoi les rôles du trilogue
// PEUVENT être joués par Claude/Grok ici (collaboration à l'inférence pour un
// livrable humain = autorisée ; le pare-feu ne protège que l'ENTRAÎNEMENT).
// Ce module ne touche AUCUN chemin d'entraînement — par conception.
// SkyAInet × Nikola T369
// =====================================================

"use strict";

export const ProblemCategory = Object.freeze({
  Societal: 'societal', Cultural: 'cultural', Environmental: 'environmental',
  Work: 'work', Medical: 'medical', Scientific: 'scientific', Other: 'other',
});

// ─── Registre + SÉLECTION des problèmes ──────────────────────────────────────
// Qui/comment : les problèmes sont SOUMIS (utilisateurs / opérateur / dérivés de
// lacunes) ; la sélection prend l'ouvert de plus forte priorité (weight).
export class ProblemRegistry {
  #problems = new Map(); #seq = 0;
  submit({ title, description = '', domain = 'general', category = 'other', weight = 1, source = 'submitted' } = {}) {
    if (!title) throw new Error('[Problem] title requis');
    const id = `pb_${++this.#seq}_${Date.now().toString(36)}`;
    const p = { id, title, description, domain, category, weight, source, status: 'open', report: null, ts: Date.now() };
    this.#problems.set(id, p);
    return { ...p };
  }
  next() {
    const open = [...this.#problems.values()].filter(p => p.status === 'open').sort((a, b) => b.weight - a.weight);
    return open[0] ? { ...open[0] } : null;
  }
  markSolving(id) { const p = this.#problems.get(id); if (p) p.status = 'solving'; return p ? { ...p } : null; }
  resolve(id, report) { const p = this.#problems.get(id); if (p) { p.status = 'solved'; p.report = report; } return p ? { ...p } : null; }
  get(id) { const p = this.#problems.get(id); return p ? { ...p } : null; }
  list(filter = {}) {
    let a = [...this.#problems.values()];
    if (filter.status) a = a.filter(p => p.status === filter.status);
    if (filter.category) a = a.filter(p => p.category === filter.category);
    return a.map(p => ({ ...p })).sort((x, y) => y.weight - x.weight);
  }
  stats() { const a = [...this.#problems.values()]; const by = (s) => a.filter(p => p.status === s).length; return { total: a.length, open: by('open'), solving: by('solving'), solved: by('solved') }; }
}

// ─── Solveur : trilogue → compte rendu structuré ─────────────────────────────
export class SocietySolver {
  #minSolutionLen;
  constructor({ minSolutionLen = 40 } = {}) { this.#minSolutionLen = minSolutionLen; }
  // `generate` : async (prompt, {role, temperature, ai, maxTokens}) => text|{text}.
  // Les rôles peuvent router vers des cœurs LOCAUX et/ou Claude/Grok (RAPPORT).
  async solve(problem, { generate, rounds = 2, names } = {}) {
    if (typeof generate !== 'function') throw new Error('[Solver] generate requis (rôles → IA : cœurs locaux et/ou Claude/Grok pour le rapport)');
    const { SpaceAI } = await import('#space_ai');
    const space = new SpaceAI({ generate, names, maxRounds: rounds });
    const tri = await space.trilogue(problem.description || problem.title, {
      context: `Domaine: ${problem.domain} (${problem.category}). Problème à résoudre: ${problem.title}`,
    });
    const solution = String(tri.answer || '').trim();
    const accepted = solution.length >= this.#minSolutionLen;   // garde-fou minimal : solution non-triviale
    return {
      problemId: problem.id, title: problem.title, domain: problem.domain, category: problem.category,
      solution, accepted, converged: tri.converged, rounds: tri.rounds,
      participants: [...new Set(tri.transcript.map(t => t.ai))],
      deliberation: tri.transcript.map(t => ({ role: t.role, ai: t.ai, round: t.round ?? 0, text: t.text })),
      ts: Date.now(),
    };
  }
}

// ─── Agenda AUTOMATIQUE : résout les prochains problèmes → comptes rendus ─────
export async function runAgenda(registry, solver, { generate, max = 3, rounds = 2 } = {}) {
  const reports = [];
  for (let i = 0; i < max; i++) {
    const problem = registry.next();
    if (!problem) break;
    registry.markSolving(problem.id);
    const report = await solver.solve(problem, { generate, rounds });
    registry.resolve(problem.id, report);
    reports.push(report);
  }
  return reports;
}

// Démo/validation autonome : `node society_solver.js`  (générateur de rôles MOCK)
if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    const A = (c, l) => { console.log((c ? '✓' : '✗ ÉCHEC'), l); if (!c) process.exit(1); };

    // Registre + sélection par priorité
    const reg = new ProblemRegistry();
    reg.submit({ title: 'Réduire la fracture numérique en zone rurale', domain: 'société', category: 'societal', weight: 0.9 });
    reg.submit({ title: 'Optimiser le tri des déchets urbains', domain: 'environnement', category: 'environmental', weight: 0.5 });
    A(reg.next().title.includes('fracture numérique'), 'sélection : problème de plus forte priorité en tête');
    A(reg.stats().open === 2, 'registre : 2 problèmes ouverts');

    // Générateur de rôles MOCK (proposer/critic/synthesizer) — cœurs locaux simulés
    const generate = async (prompt, { role } = {}) => {
      if (role === 'proposer')   return 'Proposition : déployer des hubs numériques communautaires avec accès et formation.';
      if (role === 'critic')     return 'Faiblesse : ne traite ni le financement pérenne ni la maintenance sur la durée.';
      return 'Solution finale : hubs communautaires cofinancés public-privé, avec formation certifiante, budget de maintenance sur 3 ans et indicateurs de suivi trimestriels.';
    };
    const solver = new SocietySolver();

    // Résolution d'un problème → compte rendu
    const report = await solver.solve(reg.next(), { generate, names: { proposer: 'Thevie', critic: 'T369', synthesizer: 'LoraÉvo' } });
    A(report.solution.length > 40 && report.accepted === true, 'trilogue : aboutit à une SOLUTION non-triviale (acceptée)');
    A(report.participants.includes('Thevie') && report.participants.includes('T369') && report.participants.includes('LoraÉvo'), 'compte rendu : les 3 IA ont délibéré');
    A(report.deliberation.some(d => d.role === 'critic'), 'compte rendu : la critique figure dans la délibération');

    // Agenda automatique : résout les problèmes ouverts
    const reg2 = new ProblemRegistry();
    reg2.submit({ title: 'Améliorer le dépistage précoce du diabète', domain: 'médical', category: 'medical', weight: 0.8 });
    reg2.submit({ title: 'Réduire le gaspillage alimentaire en cantine', domain: 'travail', category: 'work', weight: 0.6 });
    const reports = await runAgenda(reg2, solver, { generate, max: 5 });
    A(reports.length === 2 && reports.every(r => r.accepted), 'agenda auto : 2 problèmes résolus → 2 comptes rendus');
    A(reg2.stats().solved === 2 && reg2.stats().open === 0, 'agenda auto : registre à jour (2 résolus, 0 ouvert)');
    console.log(`   (rapport: "${report.title.slice(0, 28)}" → solution ${report.solution.length} car., ${report.participants.length} IA)`);
    console.log('✓ Society Solver — problème → trilogue → compte rendu (côté rapport, hors entraînement), vérifs OK');
  })();
}
