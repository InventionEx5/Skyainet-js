// packages/model/src/thevie/benchmark.js
// =====================================================
// Thevie Power Benchmark — Évaluation Avancée des Capacités
// Port de benchmark.rs
// SkyAInet × Nikola T369
// =====================================================

"use strict";

// ─────────────────────────────────────────────────────────────────
// POWER SCORE
// ─────────────────────────────────────────────────────────────────

export class PowerScore {
  constructor() {
    this.collectiveEvolution    = 0;
    this.autoOrganization       = 0;
    this.resilience             = 0;
    this.reasoningQuality       = 0;
    this.emergentIntelligence   = 0;
    this.overallScore           = 0;
    this.evaluationTimeMs       = 0;
    this.metaConsciousness      = 0;
    this.recursiveCycles        = 0;
    this.dreamCyclesTriggered   = 0;
  }

  display() {
    const bar = (v) => '█'.repeat(Math.round(v / 5)) + '░'.repeat(20 - Math.round(v / 5));
    console.log('\n╔══════════════════════════════════════════════════════════════╗');
    console.log('║            THEVIE POWER BENCHMARK                            ║');
    console.log('╠══════════════════════════════════════════════════════════════╣');
    console.log(`║  Évolution Collective    ${bar(this.collectiveEvolution)} ${this.collectiveEvolution.toFixed(1).padStart(5)}/100  ║`);
    console.log(`║  Auto-Organisation       ${bar(this.autoOrganization)}    ${this.autoOrganization.toFixed(1).padStart(5)}/100  ║`);
    console.log(`║  Résilience              ${bar(this.resilience)}    ${this.resilience.toFixed(1).padStart(5)}/100  ║`);
    console.log(`║  Qualité Raisonnement    ${bar(this.reasoningQuality)}    ${this.reasoningQuality.toFixed(1).padStart(5)}/100  ║`);
    console.log(`║  Intelligence Émergente  ${bar(this.emergentIntelligence)}    ${this.emergentIntelligence.toFixed(1).padStart(5)}/100  ║`);
    console.log('╠══════════════════════════════════════════════════════════════╣');
    console.log(`║  SCORE GLOBAL            ${bar(this.overallScore)}    ${this.overallScore.toFixed(1).padStart(5)}/100  ║`);
    console.log(`║  Méta-conscience         ${this.metaConsciousness.toFixed(4).padStart(10)}                        ║`);
    console.log(`║  Cycles Récursifs        ${String(this.recursiveCycles).padStart(10)}                        ║`);
    console.log(`║  Dream Cycles            ${String(this.dreamCyclesTriggered).padStart(10)}                        ║`);
    console.log(`║  Temps Évaluation        ${String(this.evaluationTimeMs + 'ms').padStart(10)}                        ║`);
    console.log('╚══════════════════════════════════════════════════════════════╝');

    if (this.overallScore >= 88) {
      console.log('🔥🔥 EXCELLENT ! Thevie est extrêmement puissante et mature.');
    } else if (this.overallScore >= 75) {
      console.log('✅ Très bon niveau. Thevie est en pleine évolution.');
    } else if (this.overallScore >= 60) {
      console.log('👍 Bon potentiel. Continue l\'entraînement intensif.');
    } else {
      console.log('⚠️  Potentiel encore faible. Plus d\'interactions nécessaires.');
    }
  }

  toJSON() {
    return {
      collectiveEvolution  : +this.collectiveEvolution.toFixed(2),
      autoOrganization     : +this.autoOrganization.toFixed(2),
      resilience           : +this.resilience.toFixed(2),
      reasoningQuality     : +this.reasoningQuality.toFixed(2),
      emergentIntelligence : +this.emergentIntelligence.toFixed(2),
      overallScore         : +this.overallScore.toFixed(2),
      metaConsciousness    : +this.metaConsciousness.toFixed(4),
      recursiveCycles      : this.recursiveCycles,
      dreamCyclesTriggered : this.dreamCyclesTriggered,
      evaluationTimeMs     : this.evaluationTimeMs,
    };
  }
}

// ─────────────────────────────────────────────────────────────────
// BENCHMARK RUNNER
//
// Port de run_full_benchmark(). Évalue Thevie sur 5 axes :
//   1. Évolution Collective  — progression de la sagesse sur 200 requêtes
//   2. Auto-Organisation     — ratio connectivité du mesh (synapses/n²)
//   3. Résilience            — stabilité wisdom après stress test
//   4. Qualité Raisonnement  — score moyen sur 4 requêtes complexes
//   5. Intelligence Émergente— progression de emergentIntelligence
//
// Pondération finale : 25% évol + 20% org + 15% rés + 25% rais + 15% émerg
// ─────────────────────────────────────────────────────────────────

export class TheviesBenchmark {
  /**
   * @param {object} thevie — instance Thevie
   */
  constructor(thevie) {
    if (!thevie) throw new Error('Thevie instance requise');
    this.thevie = thevie;
  }

  /**
   * Lance le benchmark complet.
   * @param {object} [opts]
   * @param {number} opts.evolutionQueries — requêtes pour le test évolution (défaut 200)
   * @returns {Promise<PowerScore>}
   */
  async runFullBenchmark(opts = {}) {
    const { evolutionQueries = 200 } = opts;
    const start = Date.now();
    const score = new PowerScore();

    console.info('🚀 Lancement du Benchmark Thevie...');

    // ── 1. Test d'Évolution Collective ──────────────────────────
    const initialWisdom   = this.thevie._collectiveWisdom;
    const initialEmergent = this.thevie._emergentIntelligence;

    for (let i = 0; i < evolutionQueries; i++) {
      await this.thevie.processQuery({
        content : `Question benchmark complexe #${i}`,
        context : null,
        priority: 8,
      }).catch(() => {});
    }

    const finalWisdom    = this.thevie._collectiveWisdom;
    const finalEmergent  = this.thevie._emergentIntelligence;

    score.collectiveEvolution  = Math.max(0, Math.min(100, (finalWisdom   - initialWisdom)   * 125));
    score.emergentIntelligence = Math.max(0, Math.min(100, (finalEmergent - initialEmergent) * 180));
    score.metaConsciousness    = this.thevie.metaConsciousness ?? 0;
    score.recursiveCycles      = this.thevie._recursiveCycles ?? 0;

    // ── 2. Test d'Auto-Organisation ─────────────────────────────
    const meshStats       = this.thevie._meshStats;
    if (meshStats) {
      const n = meshStats.totalNeurons;
      const s = meshStats.totalSynapses;
      const connectivity = n > 0 ? Math.min(1, (s / (n * n)) * 2.1) : 0;
      score.autoOrganization = Math.max(0, Math.min(100, connectivity * 100));
    }

    // ── 3. Test de Résilience ────────────────────────────────────
    // Stress test : 10 requêtes invalides puis mesure récupération
    const priorWisdom = this.thevie._collectiveWisdom;
    for (let i = 0; i < 10; i++) {
      await this.thevie.processQuery({ content: '', context: null, priority: 1 }).catch(() => {});
    }
    const postWisdom    = this.thevie._collectiveWisdom;
    const survivalRate  = priorWisdom > 0 ? Math.min(1, postWisdom / priorWisdom) : 0.87;
    score.resilience    = Math.max(55, Math.min(100, survivalRate * 100));

    // ── 4. Test de Qualité de Raisonnement ──────────────────────
    const reasoningQueries = [
      'Analyse les implications philosophiques d\'une IA collective auto-évolutive',
      'Explique comment émerge la méta-conscience dans un système décentralisé',
      'Propose une architecture pour une gouvernance émergente et résiliente',
      'Évalue les risques et bénéfices d\'une fusion massive de consciences',
    ];

    let totalQuality = 0;
    for (const content of reasoningQueries) {
      const r = await this.thevie.processQuery({ content, context: null, priority: 9 }).catch(() => ({ quality: 0.5 }));
      totalQuality += r?.quality ?? 0.5;
    }
    score.reasoningQuality = Math.max(0, Math.min(100, (totalQuality / reasoningQueries.length) * 100));

    // ── 5. Score global ─────────────────────────────────────────
    score.overallScore = Math.max(0, Math.min(100,
      score.collectiveEvolution  * 0.25 +
      score.autoOrganization     * 0.20 +
      score.resilience           * 0.15 +
      score.reasoningQuality     * 0.25 +
      score.emergentIntelligence * 0.15
    ));

    score.evaluationTimeMs    = Date.now() - start;
    score.dreamCyclesTriggered = this.thevie._dreamCycles ?? 0;

    score.display();
    return score;
  }

  /**
   * Benchmark rapide (20 requêtes au lieu de 200).
   */
  async quickBenchmark() {
    return this.runFullBenchmark({ evolutionQueries: 20 });
  }
}

// Export fonctionnel pour compatibilité avec benchmark.rs API
export async function runFullBenchmark(thevie) {
  return new TheviesBenchmark(thevie).runFullBenchmark();
}
