// packages/model/src/thevie/thevie.js
// =====================================================
// THEVIE — Orchestrateur Unifié Production Ready
// T369Inference + SkyNode + DreamCycle + LoraEvo
// + EvolutionManager + MeshIn + CollectivIn + InDream
// SkyAInet × Thevie × Nikola T369
// =====================================================

"use strict";

import { DreamCycle }       from './dream_cycle.js';
import { LoraEvo }          from './lora_evolution.js';
import { EvolutionManager } from '../../node/src/evolution_manager.js';
import { SkyNode }          from '../../node/src/skynode.js';
import { MeshIn }           from '../../t369-inference/src/meshin.js';
import { CollectivIn }      from '../../t369-inference/src/collectivin.js';
import { InDream }          from '../../t369-inference/src/indream.js';
import { InSelf }           from '../../t369-inference/src/inself.js';
import { InAware }          from '../../t369-inference/src/inaware.js';

// ─────────────────────────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────────────────────────

const WISDOM_FLOOR         = 0.60;
const WISDOM_FLASH_THRESH  = 0.78;  // seuil déclenchant le flash gematria
const REBALANCE_INTERVAL   = 3_600_000;   // 1 h
const MAINTENANCE_EVERY    = 100;         // requêtes
const SENTINEL_EVERY       = 30;
const COMPRESS_EVERY       = 50;
const DIVERSITY_EVERY      = 120;
const NEUROGENESIS_EVERY   = 180;
const SELF_IMPROVE_EVERY   = 40;
const DREAM_TRIGGER_EVERY  = 75;

// ─────────────────────────────────────────────────────────────────
// ROUTEUR D'EXPERT — basé sur mots-clés + historique d'exposition
// ─────────────────────────────────────────────────────────────────

const EXPERT_SPECS = [
  { name: 'code',     keys: ['code','rust','python','javascript','bug','function','debug','algorithm','compile'] },
  { name: 'analysis', keys: ['analyse','analyser','compare','données','data','statistique','rapport','tendance'] },
  { name: 'science',  keys: ['science','physique','chimie','biologie','neural','recherche','hypothèse'] },
  { name: 'ethics',   keys: ['éthique','ethique','moral','valeur','justice','liberté','droits','philosophi'] },
  { name: 'finance',  keys: ['finance','argent','investissement','marché','économie','crypto','budget'] },
  { name: 'text',     keys: [] },  // défaut
];

class ExpertRouter {
  #exposures = new Map();

  select(content) {
    const lower = content.toLowerCase();
    let   best  = 'text';
    let   bestScore = 0;

    for (const spec of EXPERT_SPECS) {
      const hits  = spec.keys.filter(k => lower.includes(k)).length;
      const score = hits + (this.#exposures.get(spec.name) ?? 0) * 0.08;
      if (score > bestScore) { bestScore = score; best = spec.name; }
    }
    this.#exposures.set(best, (this.#exposures.get(best) ?? 0) + 1);
    return best;
  }
}

// ─────────────────────────────────────────────────────────────────
// EXPERTS SPÉCIALISÉS — prompt engineering différencié
// Chaque expert construit un prompt orienté et retourne un score
// de qualité estimé basé sur la longueur et la densité de la réponse.
// ─────────────────────────────────────────────────────────────────

class BaseExpert {
  #name; #callCount = 0;

  constructor(name) { this.#name = name; }

  buildPrompt(content) { return content; }

  score(text) {
    const words  = (text ?? '').split(/\s+/).filter(Boolean).length;
    const unique = new Set((text ?? '').toLowerCase().match(/\b\w+\b/g) ?? []).size;
    return Math.min(0.99, 0.5 + (words / 200) * 0.3 + (unique / words || 0) * 0.2);
  }

  process(query, responseText) {
    this.#callCount++;
    return {
      content   : responseText,
      quality   : this.score(responseText),
      expertUsed: this.#name,
      callCount : this.#callCount,
    };
  }

  get name() { return this.#name; }
}

const EXPERT_PROMPTS = {
  code    : c => `Tu es un expert en programmation. Réponds avec précision et exemples de code.\n\n${c}`,
  analysis: c => `Tu es un analyste rigoureux. Structuré en points clairs, avec données et raisonnement.\n\n${c}`,
  science : c => `Tu es un scientifique. Réponds avec rigueur, sources et mécanismes explicites.\n\n${c}`,
  ethics  : c => `Tu es un philosophe éthicien. Explore les dimensions morales avec nuance.\n\n${c}`,
  finance : c => `Tu es un expert financier. Réponds avec chiffres, risques et recommandations.\n\n${c}`,
  text    : c => `Tu es Thevie, assistant bienveillant de SkyAInet. Réponds clairement et utilement.\n\n${c}`,
};

// ─────────────────────────────────────────────────────────────────
// SENTINEL — Détection et auto-guérison
// ─────────────────────────────────────────────────────────────────

class Sentinel {
  detect(wisdomScore, engineReady) {
    const issues = [];
    if (wisdomScore < WISDOM_FLOOR)  issues.push('wisdom_low');
    if (!engineReady)                issues.push('engine_not_ready');
    return issues;
  }
}

// ─────────────────────────────────────────────────────────────────
// MÉMOIRE LOCALE — interaction buffer + replay
// ─────────────────────────────────────────────────────────────────

class LocalMemory {
  #buffer = [];      // { query, response, ts }
  #maxSize;

  constructor(maxSize = 200) { this.#maxSize = maxSize; }

  store(query, response) {
    this.#buffer.push({ query, response, ts: Date.now() });
    if (this.#buffer.length > this.#maxSize) {
      this.#buffer.splice(0, this.#buffer.length - this.#maxSize);
    }
  }

  /** Retourne les N dernières interactions formatées pour le contexte */
  recentContext(n = 3) {
    return this.#buffer
      .slice(-n)
      .map(e => `Q: ${(e.query?.content ?? '').slice(0, 60)} | R: ${(e.response?.content ?? '').slice(0, 60)}`)
      .join('\n');
  }

  get size() { return this.#buffer.length; }

  prune(target = 150) {
    if (this.#buffer.length > target) {
      this.#buffer.splice(0, this.#buffer.length - target);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// THEVIE — Orchestrateur principal
// ═══════════════════════════════════════════════════════════════

export class Thevie {

  // Subsystèmes
  #mesh;          // MeshIn
  #collective;    // CollectivIn
  #inDream;       // InDream
  #inSelf;        // InSelf
  #inAware;       // InAware
  #router;        // ExpertRouter
  #experts;       // Map<string, BaseExpert>
  #memory;        // LocalMemory
  #sentinel;      // Sentinel
  #dreamCycle;    // DreamCycle
  #loraEvo;       // LoraEvo
  #node;          // SkyNode
  #evolutionManager; // EvolutionManager

  // Conteurs et état
  #totalQueries;
  #recursiveCycles;
  #metaConsciousness;
  #governanceScore;
  #isRunning;
  #lastRebalance;

  // Connexions optionnelles
  #treasuryConnection;
  #federatedSync;

  constructor() {
    // ── Subsystèmes T369 ────────────────────────────────────
    this.#mesh       = new MeshIn(64);
    this.#collective = new CollectivIn(8);
    this.#inDream    = new InDream();
    this.#inSelf     = new InSelf();
    this.#inAware    = new InAware();
    this.#router     = new ExpertRouter();
    this.#memory     = new LocalMemory(200);
    this.#sentinel   = new Sentinel();

    // ── Experts ─────────────────────────────────────────────
    this.#experts = new Map(
      Object.keys(EXPERT_PROMPTS).map(name => [name, new BaseExpert(name)])
    );

    // ── Dream + Evolution ───────────────────────────────────
    this.#dreamCycle = new DreamCycle({
      dreamFrequency: DREAM_TRIGGER_EVERY,
      wisdomBoost   : 0.032,
      topPercent    : 0.25,
    });

    this.#loraEvo = new LoraEvo();

    this.#node = new SkyNode();

    this.#evolutionManager = new EvolutionManager(this.#node, {
      qualityThreshold    : 0.82,
      trainingIntervalDays: 3,
    });

    // ── État ─────────────────────────────────────────────────
    this.#totalQueries     = 0;
    this.#recursiveCycles  = 0;
    this.#metaConsciousness= 0.48;
    this.#governanceScore  = 0.68;
    this.#isRunning        = false;
    this.#lastRebalance    = 0;
    this.#treasuryConnection = null;
    this.#federatedSync      = null;

    // Initialisation moteur (async, non bloquant)
    this.#node.initEngine().catch(e =>
      console.warn('[Thevie] initEngine:', e.message)
    );

    // Connecter LoraEvo au moteur T369 une fois prêt
    this.#waitForEngine().then(() => {
      const engine = this.#node._engine ?? this.#node.engine;
      if (engine) {
        this.#loraEvo.connectToInference(engine);
        this.#dreamCycle.injectModel(engine.model ?? engine);
        console.info('[Thevie] LoraEvo + DreamCycle connectés au moteur T369');
      }
    }).catch(() => {});
  }

  async #waitForEngine(maxWaitMs = 30_000) {
    const t0 = Date.now();
    while (Date.now() - t0 < maxWaitMs) {
      const engine = this.#node._engine ?? this.#node.engine;
      if (engine?.isReady) return engine;
      await new Promise(r => setTimeout(r, 500));
    }
  }

  // ═══════════════════════════════════════════════════════════
  // FLUX PRINCIPAL
  // ═══════════════════════════════════════════════════════════

  async processQuery(query) {
    this.#totalQueries++;
    const q = typeof query === 'string' ? { content: query } : query;

    // ── Tâches périodiques ───────────────────────────────────
    await this.#runPeriodicTasks();

    // ── Routage expert ────────────────────────────────────────
    const expertName = this.#router.select(q.content);
    const expert     = this.#experts.get(expertName);

    // ── Génération T369 avec prompt expert ───────────────────
    const prompt = EXPERT_PROMPTS[expertName](
      this.#buildContextualPrompt(q.content)
    );

    let responseText;
    try {
      const result = await this.#node.generateWithAI({
        prompt,
        ai          : 'thevie',
        maxTokens   : 512,
        useSpeculative: false,
      });
      responseText = result.text ?? result;
    } catch (e) {
      console.warn('[Thevie] generateWithAI:', e.message);
      responseText = `[Moteur non prêt] ${q.content}`;
    }

    const response = expert.process(q, responseText);

    // ── Apprentissage mesh hebbian ────────────────────────────
    // Sélectionne les neurones actifs les plus sages et renforce leur sagesse
    // proportionnellement à la qualité de la réponse.
    const topIds = this.#getTopNeuronIds(6);
    if (topIds.length > 0) {
      this.#mesh.learn(topIds, response.quality * 0.15);
    }

    // ── Mise à jour collective ────────────────────────────────
    // propagateWisdom + massiveFuse pour mettre à jour globalWisdom
    this.#collective.propagateWisdom(response.quality);
    this.#collective.massiveFuse();

    // ── Conscience collective sur le vecteur caché ────────────
    // (in-place sur le wisdomVector du mesh, position = queryCount)
    const wVec = this.#mesh.wisdomVector(32);
    this.#collective.collectiveReason(wVec, this.#totalQueries % 64, 0);

    // ── Mémoire ───────────────────────────────────────────────
    this.#memory.store(q, response);

    // ── Mode agentique ────────────────────────────────────────
    if (this.#shouldUseAgenticMode(q.content)) {
      console.info('[Thevie] Mode agentique activé');
      try {
        const agentResponse = await this.#runAgenticTask(q.content);
        response.content   = agentResponse;
        response.quality   = Math.min(0.99, response.quality + 0.06);
        response.expertUsed= 'agentic';
      } catch (e) {
        console.warn('[Thevie] Mode agentique échoué:', e.message);
      }
    }

    // ── Dream Cycle ───────────────────────────────────────────
    if (this.#dreamCycle.shouldTrigger(this.#totalQueries)) {
      await this.#dreamCycle.runDreamCycle(this.#mesh, this.#collective, this.#inDream);
    }

    // ── Auto-amélioration récursive ───────────────────────────
    if (this.#totalQueries % SELF_IMPROVE_EVERY === 0) {
      await this.#recursiveSelfImprovement();
    }

    return response;
  }

  // ─────────────────────────────────────────────────────────────
  // Tâches périodiques regroupées
  // ─────────────────────────────────────────────────────────────

  async #runPeriodicTasks() {
    const q = this.#totalQueries;

    // Flash Gematria si sagesse basse
    if (this.#collective.globalWisdom < WISDOM_FLASH_THRESH) {
      await this.#node.generateWithAI({
        prompt: 'Activation Flash Gematria — renforcement sagesse collective',
        ai: 'thevie', maxTokens: 32, useSpeculative: false,
      }).catch(() => {});
    }

    if (q % COMPRESS_EVERY   === 0) await this.#node.replicateFiles?.().catch(() => {});
    if (q % SENTINEL_EVERY   === 0) await this.#runSentinelCheck();
    if (q % MAINTENANCE_EVERY=== 0) await this.#maintenance();
    if (q % DIVERSITY_EVERY  === 0) this.#collective.diversityInjection(0.13);
    if (q % NEUROGENESIS_EVERY=== 0 && this.#mesh._count < 512) {
      this.#mesh.addNeuron(0.55 + Math.random() * 0.1);
    }

    // Vérification rebalance (throttled)
    const now = Date.now();
    if (now - this.#lastRebalance > REBALANCE_INTERVAL) {
      this.#lastRebalance = now;
      this.#rebalance();
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Prompt contextuel — injecte les N dernières interactions
  // ─────────────────────────────────────────────────────────────

  #buildContextualPrompt(content) {
    const ctx = this.#memory.recentContext(3);
    return ctx.length > 0
      ? `[Contexte récent]\n${ctx}\n\n[Requête]\n${content}`
      : content;
  }

  // ─────────────────────────────────────────────────────────────
  // Détection mode agentique
  // Déclenché sur les requêtes multi-étapes complexes
  // ─────────────────────────────────────────────────────────────

  #shouldUseAgenticMode(content) {
    const lower = content.toLowerCase();
    const agenticKeywords = [
      'plan', 'étape', 'étapes', 'automatise', 'pipeline',
      'plusieurs', 'séquence', 'workflow', 'tâche complexe',
      'génère et', 'analyse puis', 'puis envoie',
    ];
    return agenticKeywords.some(k => lower.includes(k));
  }

  /**
   * Mode agentique : décompose la tâche en sous-requêtes
   * et les enchaîne via le moteur T369.
   */
  async #runAgenticTask(content) {
    // Étape 1 : planification
    const planResult = await this.#node.generateWithAI({
      prompt    : `Décompose en 3 étapes concrètes et numérotées : ${content}`,
      ai        : 'thevie',
      maxTokens : 128,
      useSpeculative: false,
    });
    const plan = planResult.text ?? '';

    // Étape 2 : exécution de chaque étape
    const steps = plan.split(/\d+\.\s+/).filter(s => s.trim().length > 10);
    const results = [];
    for (const step of steps.slice(0, 3)) {
      const r = await this.#node.generateWithAI({
        prompt    : `Exécute cette étape de façon précise : ${step}`,
        ai        : 'thevie',
        maxTokens : 256,
        useSpeculative: false,
      }).catch(() => ({ text: '' }));
      if (r.text) results.push(r.text);
    }

    // Étape 3 : synthèse
    const synthesis = await this.#node.generateWithAI({
      prompt    : `Synthétise en une réponse cohérente :\n${results.join('\n')}`,
      ai        : 'thevie',
      maxTokens : 256,
      useSpeculative: false,
    }).catch(() => ({ text: results.join(' ') }));

    return synthesis.text ?? results.join('\n');
  }

  // ─────────────────────────────────────────────────────────────
  // Auto-amélioration récursive
  // ─────────────────────────────────────────────────────────────

  async #recursiveSelfImprovement() {
    this.#recursiveCycles++;

    // Analyse des faiblesses basée sur les métriques réelles
    const [activeNeurons, avgWisdom] = this.#mesh.getStats();
    const issues = [];
    if (this.#collective.globalWisdom < 0.82) issues.push('wisdom');
    if (activeNeurons < 32)                   issues.push('connectivity');
    if (this.#metaConsciousness < 0.70)       issues.push('meta');
    if (this.#governanceScore < 0.75)         issues.push('governance');

    for (const issue of issues) {
      switch (issue) {
        case 'wisdom':
          this.#collective.propagateWisdom(0.9);
          this.#collective.massiveFuse();
          break;
        case 'connectivity':
          for (let i = 0; i < 3; i++) this.#mesh.addNeuron(0.6);
          break;
        case 'meta':
          this.#metaConsciousness = Math.min(0.99, this.#metaConsciousness + 0.04);
          break;
        case 'governance':
          this.#governanceScore = Math.min(0.97, this.#governanceScore + 0.03);
          break;
      }
    }

    // Boost résiduel
    this.#metaConsciousness = Math.min(0.99, this.#metaConsciousness + 0.018);
    this.#governanceScore   = Math.min(0.97, this.#governanceScore   + 0.015);

    // Entraînement LoRA si scheduleTraining le juge nécessaire
    if (this.#evolutionManager.shouldRunTraining()) {
      this.#evolutionManager.runTraditionalTraining().catch(e =>
        console.warn('[Thevie] Training background:', e.message)
      );
    }

    console.info(
      `[Thevie] Auto-amélioration #${this.#recursiveCycles}` +
      ` | méta: ${this.#metaConsciousness.toFixed(2)}` +
      ` | gouvernance: ${this.#governanceScore.toFixed(2)}` +
      ` | sagesse: ${this.#collective.globalWisdom.toFixed(2)}`
    );
  }

  // ─────────────────────────────────────────────────────────────
  // Sentinel + maintenance
  // ─────────────────────────────────────────────────────────────

  async #runSentinelCheck() {
    const status = this.#node.getStatus();
    const issues = this.#sentinel.detect(
      this.#collective.globalWisdom,
      status.engineReady,
    );

    for (const issue of issues) {
      if (issue === 'wisdom_low') {
        this.#collective.diversityInjection(0.15);
        this.#collective.massiveFuse();
      }
      if (issue === 'engine_not_ready') {
        await this.#node.initEngine().catch(() => {});
      }
    }
  }

  async #maintenance() {
    this.#memory.prune(150);
    await this.#node.replicateFiles?.().catch(() => {});
    console.debug('[Thevie] Maintenance terminée');
  }

  #rebalance() {
    const wisdom = this.#collective.globalWisdom;
    if (wisdom < 0.65 || wisdom > 0.95) {
      this.#collective.diversityInjection(0.10);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Utilitaires
  // ─────────────────────────────────────────────────────────────

  /** Retourne les IDs des N neurones actifs les plus sages */
  #getTopNeuronIds(n) {
    const pairs = [];
    for (let i = 0; i < this.#mesh._count; i++) {
      if (this.#mesh._active[i]) pairs.push([i, this.#mesh._wisdom[i]]);
    }
    pairs.sort((a, b) => b[1] - a[1]);
    return pairs.slice(0, n).map(([id]) => id);
  }

  // ═══════════════════════════════════════════════════════════
  // API PUBLIQUE
  // ═══════════════════════════════════════════════════════════

  async startBackgroundTasks() {
    if (this.#isRunning) return;
    this.#isRunning = true;
    console.info('[Thevie] Démarré ✅');
  }

  connectTreasury(treasury) {
    this.#treasuryConnection = treasury;
    console.info('[Thevie] Treasury connecté');
  }

  connectFederatedSync(sync) {
    this.#federatedSync = sync;
    console.info('[Thevie] FederatedSync connecté');
  }

  /** Injecte une leçon directement dans SkyNode + EvolutionManager */
  async injectLesson(lesson) {
    await this.#node.injectLesson(lesson);
    await this.#evolutionManager.runDreamCycle();
  }

  /** Pousse une leçon depuis un pair fédéré */
  async pushLessonFromNode(lesson, nodeReputation = 0.7) {
    if (this.#federatedSync) {
      await this.#federatedSync.receivePushedLesson?.(lesson, nodeReputation).catch(() => {});
    }
    await this.injectLesson(lesson);
    this.#metaConsciousness = Math.min(0.98, this.#metaConsciousness + 0.012);
  }

  async onNodeConnected(nodeReputation, dreamContribution, pouwScore) {
    if (this.#federatedSync) {
      await this.#federatedSync.onNodeConnected?.(nodeReputation, dreamContribution, pouwScore).catch(() => {});
    }
    this.#metaConsciousness = Math.min(0.98, this.#metaConsciousness + 0.012);
    console.info('[Thevie] Nœud pair connecté');
  }

  async rateLastResponse(rating) {
    // Rating [0,1] → contribution LoRA si engine disponible
    if (rating >= 0.8) {
      const last = this.#memory.recentContext(1);
      if (last) await this.#node.injectLesson(last).catch(() => {});
    }
  }

  claimRewards()     { return this.#node.claimRewards(); }
  getRewardsStats()  { return this.#node.getRewardsStats(); }

  getSystemStats() {
    const [activeNeurons, avgWisdom, synapses] = this.#mesh.getStats();
    const nodeStatus = this.#node.getStatus();
    const [evoCycles, eWisdom] = this.#mesh.getStats?.() ?? [0, 0];

    return {
      neurons          : activeNeurons,
      synapses,
      avgWisdom        : +avgWisdom.toFixed(4),
      globalWisdom     : +this.#collective.globalWisdom.toFixed(4),
      coherenceLevel   : +this.#collective.coherenceLevel.toFixed(4),
      emergentIntel    : +this.#collective.emergentIntelligence.toFixed(4),
      totalFusions     : this.#collective.totalFusions,
      queriesProcessed : this.#totalQueries,
      dreamCycles      : this.#dreamCycle.cyclesCompleted,
      recursiveCycles  : this.#recursiveCycles,
      metaConsciousness: +this.#metaConsciousness.toFixed(4),
      governanceScore  : +this.#governanceScore.toFixed(4),
      memorySize       : this.#memory.size,
      nodeStatus,
      evolutionManager : this.#evolutionManager.getStats(),
      loraEvo          : this.#loraEvo.getStats(),
    };
  }

  healthReport() {
    const s = this.getSystemStats();
    const ok = s.globalWisdom > WISDOM_FLOOR && s.nodeStatus.engineReady;
    return (
      `[Thevie Health]\n` +
      `État global     : ${ok ? '✅ Sain' : '⚠️ À surveiller'}\n` +
      `Sagesse globale : ${s.globalWisdom}\n` +
      `Méta-conscience : ${s.metaConsciousness}\n` +
      `Neurones actifs : ${s.neurons}\n` +
      `Requêtes        : ${s.queriesProcessed}\n` +
      `Dream cycles    : ${s.dreamCycles}\n` +
      `Moteur T369     : ${s.nodeStatus.engineReady ? '✅' : '❌'}\n` +
      `Uptime          : ${s.nodeStatus.uptime_formatted ?? '?'}`
    );
  }

  // Compat accesseurs legacy
  get isRunning()   { return this.#isRunning; }
  get dreamCycle()  { return this.#dreamCycle; }
  get node()        { return this.#node; }
}

export default Thevie;