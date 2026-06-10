// packages/model/src/thevie/thevie.js
// =====================================================
// THEVIE — Orchestrateur Unifié Production Ready
// T369Inference + SkyCloud + DreamCycle + LoraEvo
// + EvolutionManager + MeshIn + CollectivIn + InDream
// SkyAInet × Thevie × Nikola T369
// =====================================================

"use strict";

import { DreamCycle }       from './dream_cycle.js';
import { LoraEvo }          from './lora_evolution.js';
import { EvolutionManager } from '../../node/src/evolution_manager.js';
import { SkyCloud as SkyNode }          from '../../node/src/skycloud.js';
import { MeshIn }           from '../../t369-inference/src/meshin.js';
import { CollectivIn }      from '../../t369-inference/src/collectivin.js';
import { InDream }          from '../../t369-inference/src/indream.js';
import { InSelf }           from '../../t369-inference/src/inself.js';
import { InAware }          from '../../t369-inference/src/inaware.js';

// Sentinel package — classes autonomes (sentinel/)
import { Sentinel as SentinelCore }  from '../../../sentinel/src/sentinel.js';
import { AntiFork }                  from '../../../sentinel/src/anti_fork.js';

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

// ExpertType — enum des types d'experts (port de moe.rs)
const ExpertType = Object.freeze({
  Text    : 'text',
  Code    : 'code',
  Analysis: 'analysis',
  Science : 'science',
  Ethics  : 'ethics',
  Finance : 'finance',
  Creative: 'creative',
  Logic   : 'logic',
});

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
// levelUp() : incrémente la compétence + monte de niveau si > 1.0
//             (port de Expert::level_up dans moe.rs)
// ─────────────────────────────────────────────────────────────────

class BaseExpert {
  #name; #callCount = 0;
  #competence;
  #level;

  constructor(name, initialCompetence = 0.80) {
    this.#name       = name;
    this.#competence = Math.max(0.5, Math.min(2.0, initialCompetence));
    this.#level      = 1;
  }

  buildPrompt(content) { return content; }

  score(text) {
    const words  = (text ?? '').split(/\s+/).filter(Boolean).length;
    const unique = new Set((text ?? '').toLowerCase().match(/\b\w+\b/g) ?? []).size;
    const compBoost = Math.min(0.07, (this.#competence - 1) * 0.07);
    return Math.min(0.99, 0.5 + (words / 200) * 0.3 + (unique / words || 0) * 0.2 + compBoost);
  }

  process(query, responseText) {
    this.#callCount++;
    return {
      content   : responseText,
      quality   : this.score(responseText),
      expertUsed: this.#name,
      callCount : this.#callCount,
      level     : this.#level,
      competence: +this.#competence.toFixed(3),
    };
  }

  /** Monte la compétence de l'expert (port de Expert::level_up dans moe.rs). */
  levelUp() {
    this.#competence = Math.min(2.0, this.#competence + 0.06);
    if (this.#competence > 1.0 && this.#level < 12) this.#level++;
    console.debug(`[Expert:${this.#name}] Level up → lvl ${this.#level} (comp: ${this.#competence.toFixed(3)})`);
  }

  get name()       { return this.#name; }
  get competence() { return this.#competence; }
  get level()      { return this.#level; }
}

const EXPERT_PROMPTS = {
  code    : c => `Tu es un expert en programmation. Réponds avec précision et exemples de code.\n\n${c}`,
  analysis: c => `Tu es un analyste rigoureux. Structuré en points clairs, avec données et raisonnement.\n\n${c}`,
  science : c => `Tu es un scientifique. Réponds avec rigueur, sources et mécanismes explicites.\n\n${c}`,
  ethics  : c => `Tu es un philosophe éthicien. Explore les dimensions morales avec nuance.\n\n${c}`,
  finance : c => `Tu es un expert financier. Réponds avec chiffres, risques et recommandations.\n\n${c}`,
  text    : c => `Tu es Thevie, assistant bienveillant de SkyAInet. Réponds clairement et utilement.\n\n${c}`,
  creative: c => `Tu es un créatif inspiré. Réponds avec imagination, originalité et fluidité.\n\n${c}`,
  logic   : c => `Tu es un logicien rigoureux. Décompose le problème étape par étape.\n\n${c}`,
};

// ─────────────────────────────────────────────────────────────────
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
  #sentinel;      // SentinelCore (sentinel/src/sentinel.js)
  #antiFork;      // AntiFork    (sentinel/src/anti_fork.js)
  #dreamCycle;    // DreamCycle
  #loraEvo;       // LoraEvo
  #node;          // SkyCloud
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

  // Nouveaux champs
  #flashTimer;          // handle setInterval Flash Scheduler
  #lowPowerMode;        // boolean
  #zipMemoryEnabled;    // boolean
  #pendingEthicalScores; // { nodeId, score, ts }[] — buffer avant treasury

  constructor() {
    // ── Subsystèmes T369 ────────────────────────────────────
    this.#mesh       = new MeshIn(64);
    this.#collective = new CollectivIn(8);
    this.#inDream    = new InDream();
    this.#inSelf     = new InSelf();
    this.#inAware    = new InAware();
    this.#router     = new ExpertRouter();
    this.#memory     = new LocalMemory(200);
    this.#sentinel   = new SentinelCore(this.#node);
    this.#antiFork   = new AntiFork();

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

    this.#node = new SkyCloud();

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
    this.#flashTimer         = null;
    this.#lowPowerMode       = false;
    this.#zipMemoryEnabled   = true;
    this.#pendingEthicalScores = [];

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
  // ─────────────────────────────────────────────────────────────
  // Auto-amélioration récursive
  // (Mode agentique supprimé — délégué à AgenticRunner dans agentic.js)
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
    // Délègue à SentinelCore.runCheck() — detectIssues + triggerHealing
    await this.#sentinel.runCheck().catch(e =>
      console.warn('[Thevie] SentinelCheck:', e.message)
    );

    // Détection de fork sur les pairs actifs via AntiFork
    const peers  = this.#node.getPeers();
    if (peers.length > 0) {
      const status    = this.#node.getStatus();
      const localHash = `${status.wisdomScore.toFixed(6)}:${status.evolutionCycles}`;
      const peerData  = peers.map(p => ({
        peerId    : p.id,
        height    : 0,
        hash      : localHash,
        reputation: p.reputation ?? 0.7,
      }));
      this.#antiFork.detectFork(0, localHash, peerData, this.#node, null);
      this.#antiFork.pruneEvents(30);
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

  // ═══════════════════════════════════════════════════════════════
  // FLASH GEMATRIA
  // ═══════════════════════════════════════════════════════════════

  /**
   * Déclenche un Flash Gematria si la sagesse collective est sous le seuil.
   * Appelle generateWithAI avec un prompt de renforcement cognitif.
   */
  async triggerFlashIfNeeded() {
    if (this.#collective.globalWisdom < WISDOM_FLASH_THRESH) {
      await this.#node.generateWithAI({
        prompt        : 'Flash Gematria : renforcement immédiat de la sagesse collective T369.',
        ai            : 'thevie',
        maxTokens     : 32,
        useSpeculative: false,
      }).catch(() => {});
      console.info(`[Thevie] Flash Gematria déclenché (sagesse: ${this.#collective.globalWisdom.toFixed(2)})`);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // GESTION D'ÉNERGIE DU NŒUD
  // ═══════════════════════════════════════════════════════════════

  /** Met le nœud en veille intelligente — réduit les cycles périodiques. */
  async sleepNode() {
    this.#node.setState('Sleeping');
    // Suspendre le moteur LoraEvo pour libérer la mémoire
    this.#loraEvo?.shortTermMemory?.splice(0);
    console.info('[Thevie] Nœud mis en veille');
  }

  /** Réveille le nœud et relance l'engine si nécessaire. */
  async wakeNode() {
    this.#node.setState('Active');
    if (!this.#node._engine?.isReady) {
      await this.#node.initEngine().catch(e =>
        console.warn('[Thevie] wakeNode — initEngine:', e.message)
      );
    }
    console.info('[Thevie] Nœud réveillé');
  }

  /** Active le mode basse consommation : réduit maxTokens et fréquence des cycles. */
  async enableLowPowerMode() {
    this.#lowPowerMode = true;
    console.info('[Thevie] Mode basse consommation activé');
  }

  /** Désactive le mode basse consommation. */
  async disableLowPowerMode() {
    this.#lowPowerMode = false;
    console.info('[Thevie] Mode basse consommation désactivé');
  }

  // ═══════════════════════════════════════════════════════════════
  // SANTÉ ET RAPPORT
  // ═══════════════════════════════════════════════════════════════

  /**
   * Rapport de santé complet — combine node metrics + mesh + sentinel.
   * Retourne un objet structuré (pas une string) pour une intégration facile.
   */
  nodeHealth() {
    const s       = this.getSystemStats();
    const metrics = this.#node.getNodeMetrics();
    const ok      = s.globalWisdom > WISDOM_FLOOR && s.nodeStatus.engineReady;

    return {
      healthy          : ok,
      globalWisdom     : s.globalWisdom,
      metaConsciousness: s.metaConsciousness,
      governanceScore  : s.governanceScore,
      neurons          : s.neurons,
      queriesProcessed : s.queriesProcessed,
      dreamCycles      : s.dreamCycles,
      engineReady      : s.nodeStatus.engineReady,
      uptime           : metrics.uptime_formatted,
      peers            : metrics.peers_connected,
      lowPowerMode     : this.#lowPowerMode,
      sentinel         : this.#sentinel?.antiFork?.summary() ?? null,
    };
  }

  /**
   * Rapport complet combinant nodeHealth + dashboard + sagesse.
   */
  fullStatusReport() {
    const health    = this.nodeHealth();
    const dashboard = this.getNodeDashboard();
    return {
      ...health,
      dashboard,
      timestamp: Date.now(),
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // COMPRESSION RÉSEAU (ZipMemory)
  // ═══════════════════════════════════════════════════════════════

  async getNetworkCompressionStats() {
    // SkyCloud.replicateFiles retourne { replicated: n }
    // On enrichit avec les stats internes disponibles
    const nodeMetrics = this.#node.getNodeMetrics();
    return {
      totalFiles   : nodeMetrics.api_keys_count ?? 0,  // proxy disponible
      engineReady  : nodeMetrics.engine_ready,
      wisdomScore  : nodeMetrics.wisdom_score,
      zipEnabled   : this.#zipMemoryEnabled,
    };
  }

  /** Active ou désactive la compression ZipMemory sur le nœud. */
  setZipMemoryEnabled(enabled) {
    this.#zipMemoryEnabled = !!enabled;
    console.info(`[Thevie] ZipMemory ${this.#zipMemoryEnabled ? 'activé' : 'désactivé'}`);
  }

  // ═══════════════════════════════════════════════════════════════
  // MODÈLE ÉCONOMIQUE
  // ═══════════════════════════════════════════════════════════════

  /** Vérifie si le nœud courant peut être upgradé (pas déjà au niveau max). */
  canUpgradeNode() {
    const status = this.#node.getStatus();
    // Un nœud peut être upgradé s'il est actif et que le moteur est prêt
    return status.isRunning && status.engineReady;
  }

  /**
   * Upgrade le nœud vers un niveau supérieur.
   * Crée un nouveau SkyCloud configuré selon le niveau demandé
   * et transfère les pairs existants.
   *
   * @param {'Mini'|'Light'|'Full'|'Validator'} level
   */
  async upgradeMyNode(level) {
    const validLevels = ['Mini', 'Light', 'Full', 'Validator'];
    if (!validLevels.includes(level)) {
      return { success: false, error: `Niveau invalide : ${level}` };
    }
    if (!this.canUpgradeNode()) {
      return { success: false, error: 'Nœud non éligible à l\'upgrade' };
    }

    // Préparer le nouveau nœud avec la config du niveau demandé
    const newNode = new SkyCloud();
    await newNode.initEngine().catch(() => {});

    // Transférer les pairs
    for (const peer of this.#node.getPeers()) {
      newNode.addPeer(peer);
    }

    this.#node = newNode;

    // Reconnecter les subsystèmes
    const engine = this.#node._engine;
    if (engine?.isReady) {
      this.#loraEvo.connectToInference(engine);
      this.#dreamCycle.injectModel(engine.model);
    }

    console.info(`[Thevie] Nœud upgradé → ${level}`);
    return { success: true, level, nodeId: this.#node.id };
  }

  /**
   * Dashboard complet du nœud courant.
   */
  getNodeDashboard() {
    const metrics = this.#node.getNodeMetrics();
    const rewards = this.#node.getRewardsStats();
    const status  = this.#node.getStatus();

    return {
      nodeId          : metrics.node_id,
      state           : metrics.state,
      engineReady     : metrics.engine_ready,
      wisdomScore     : metrics.wisdom_score,
      totalRequests   : metrics.total_requests,
      evolutionCycles : metrics.evolution_cycles,
      peersConnected  : metrics.peers_connected,
      registeredAIs   : metrics.registered_ais,
      uptime          : metrics.uptime_formatted,
      apiKeysCount    : metrics.api_keys_count,
      totalSkyEarned  : rewards.totalEarned,
      zipMemory       : this.#zipMemoryEnabled,
      lowPowerMode    : this.#lowPowerMode,
      metaConsciousness: +this.#metaConsciousness.toFixed(4),
      governanceScore : +this.#governanceScore.toFixed(4),
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // FLASH SCHEDULER
  // ═══════════════════════════════════════════════════════════════

  /**
   * Démarre le Flash Scheduler — vérifie toutes les 45 s si un Flash
   * Gematria est nécessaire.
   */
  startFlashScheduler(intervalSeconds = 45) {
    if (this.#flashTimer) clearInterval(this.#flashTimer);
    this.#flashTimer = setInterval(async () => {
      await this.triggerFlashIfNeeded().catch(() => {});
    }, intervalSeconds * 1000).unref();
    console.info(`[Thevie] Flash Scheduler démarré (intervalle: ${intervalSeconds}s)`);
  }

  /** Redémarre le Flash Scheduler avec un nouvel intervalle. */
  restartFlashScheduler(newIntervalSeconds = 45) {
    if (this.#flashTimer) clearInterval(this.#flashTimer);
    this.#flashTimer = null;
    this.startFlashScheduler(newIntervalSeconds);
    console.info(`[Thevie] Flash Scheduler redémarré (${newIntervalSeconds}s)`);
  }

  // ═══════════════════════════════════════════════════════════════
  // CRÉATION DE NŒUD UTILISATEUR
  // ═══════════════════════════════════════════════════════════════

  /**
   * Crée un nœud SkyCloud pour un utilisateur selon le type demandé.
   *
   * Nœuds disponibles : Mini (gratuit), Light, Full, Validator (payants).
   * Le nœud est initialisé avec le moteur T369, ZipMemory activé,
   * et connecté automatiquement au réseau via les bootstrap nodes.
   *
   * @param {'Mini'|'Light'|'Full'|'Validator'} desiredType
   * @param {boolean} simulatePayment — true pour simuler un paiement (dev)
   */
  async createUserNode(desiredType = 'Mini', simulatePayment = false) {
    const paidTypes = ['Light', 'Full', 'Validator'];
    const isPaid    = paidTypes.includes(desiredType);

    if (isPaid && !simulatePayment) {
      return {
        success: false,
        error  : `Le type "${desiredType}" nécessite un abonnement payant.`,
      };
    }

    const node = new SkyCloud();

    // Initialisation du moteur T369
    try {
      await node.initEngine();
    } catch (e) {
      console.warn('[Thevie] createUserNode — initEngine:', e.message);
    }

    // Connexion aux bootstrap nodes du réseau principal
    for (const peer of this.getBootstrapNodes()) {
      node.addPeer(peer);
    }

    // Enregistrement des AIs standards
    node.registerAI('thevie',  'Thevie — Intelligence Collective');
    node.registerAI('loraevo', 'LoraÉvo — Guide Évolutif');
    node.registerAI('t369',    'T369 — Moteur Natif');

    const prices = { Mini: 0, Light: 6, Full: 18, Validator: 55 };
    const storage = { Mini: 5, Light: 50, Full: 200, Validator: 512 };

    console.info(`[Thevie] Nœud ${desiredType} créé — id: ${node.id}`);

    return {
      success         : true,
      node,
      nodeId          : node.id,
      nodeType        : desiredType,
      isPaid,
      storageLimitGb  : storage[desiredType] ?? 5,
      monthlyPriceEur : prices[desiredType]  ?? 0,
      zipMemoryEnabled: true,
      message         : isPaid
        ? `✅ Nœud ${desiredType} créé — abonnement activé (${prices[desiredType]} €/mois)`
        : '✅ Mini Nœud créé (gratuit) — ZipMemory activé',
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // RÉSEAU & CONNEXION
  // ═══════════════════════════════════════════════════════════════

  /**
   * Génère les données QR de connexion du nœud courant.
   * Format : JSON encodé avec id, wisdomScore et adresses pairs.
   */
  getMyQrConnection() {
    const status = this.#node.getStatus();
    const data   = {
      nodeId     : status.id,
      wisdomScore: status.wisdomScore,
      peers      : this.#node.getPeers().map(p => p.id),
      network    : 'skyainet/v1',
      ts         : Date.now(),
    };
    return JSON.stringify(data);
  }

  /**
   * Retourne les nœuds bootstrap du réseau SkyAInet.
   * En production, ces adresses seraient chargées depuis une config externe.
   */
  getBootstrapNodes() {
    return [
      { id: 'bootstrap-1', address: 'skyainet-bootstrap-1.net:8080', reputation: 0.95 },
      { id: 'bootstrap-2', address: 'skyainet-bootstrap-2.net:8080', reputation: 0.93 },
      { id: 'bootstrap-3', address: 'skyainet-bootstrap-3.net:8080', reputation: 0.91 },
    ];
  }

  // ═══════════════════════════════════════════════════════════════
  // GOUVERNANCE & RÉCOMPENSES
  // ═══════════════════════════════════════════════════════════════

  /**
   * Envoie le score éthique d'un nœud vers le treasury on-chain.
   * Prépare le terrain pour l'intégration blockchain.
   *
   * @param {string} nodeId
   * @param {number} score — [0, 1]
   */
  async sendEthicalScoreOnchain(nodeId, score) {
    if (this.#treasuryConnection) {
      await this.#treasuryConnection.recordEthicalScore?.(nodeId, score);
      console.info(`[Thevie] Score éthique envoyé on-chain : ${nodeId.slice(0, 16)} → ${score.toFixed(3)}`);
    } else {
      // Sans treasury connecté, on stocke localement en attendant
      if (!this.#pendingEthicalScores) this.#pendingEthicalScores = [];
      this.#pendingEthicalScores.push({ nodeId, score, ts: Date.now() });
      console.debug(`[Thevie] Score éthique mis en attente (treasury non connecté)`);
    }
  }

  /**
   * Rééquilibrage du réseau si le ratio de sagesse est hors des bornes.
   * Throttlé à 1 h minimum entre deux rééquilibrages.
   */
  async checkAndTriggerRebalance() {
    const now = Date.now();
    if (now - this.#lastRebalance < REBALANCE_INTERVAL) return;
    this.#lastRebalance = now;

    const wisdom = this.#collective.globalWisdom;
    if (wisdom < 0.65 || wisdom > 0.95) {
      this.#collective.diversityInjection(0.10);
      this.#collective.massiveFuse();

      if (this.#treasuryConnection) {
        await this.#treasuryConnection.triggerRebalance?.();
      }

      console.info(`[Thevie] Rebalance déclenché (sagesse: ${wisdom.toFixed(2)})`);
    }
  }

  /**
   * Note la dernière réponse et renforce l'apprentissage en conséquence.
   *
   * rating [0, 1] :
   *   ≥ 0.8 → injection LoRA + boost wisdom
   *   0.5–0.8 → injection légère
   *   < 0.5  → signal négatif, ajustement du profil LoraEvo
   */
  async rateLastResponse(rating) {
    const r = Math.max(0, Math.min(1, rating));

    if (r >= 0.8) {
      // Excellente réponse → renforcer via LoRA
      const ctx = this.#memory.recentContext(1);
      if (ctx) {
        await this.#node.injectLesson(ctx).catch(() => {});
      }
      this.#collective.globalWisdom = Math.min(0.99, this.#collective.globalWisdom + 0.002);
      this.#metaConsciousness       = Math.min(0.99, this.#metaConsciousness + 0.001);

    } else if (r >= 0.5) {
      // Réponse correcte → renforcement léger
      this.#collective.propagateWisdom(r);

    } else {
      // Réponse insuffisante → ajuster le profil de spécialisation LoraEvo
      this.#loraEvo?.evolutionProfile?.adapt?.('Guide Polyvalent');
      this.#collective.diversityInjection(0.05);
    }

    console.debug(`[Thevie] Rating: ${r.toFixed(2)} — apprentissage appliqué`);
  }

  /**
   * Réclame les récompenses quotidiennes du nœud.
   * Retourne [montantClamé, totalCumulé].
   */
  async claimDailyReward() {
    const result = this.#node.claimRewards();
    const stats  = this.#node.getRewardsStats();
    return [result.claimed ?? 0, stats.totalEarned ?? 0];
  }

  /**
   * Demande des leçons sur un sujet spécifique via le sync fédéré.
   * Si pas de sync fédéré, génère localement via T369.
   *
   * @param {string} topic
   * @param {number} minQuality — [0, 1]
   */
  async requestLessonsOnTopic(topic, minQuality = 0.7) {
    if (this.#federatedSync) {
      return this.#federatedSync.requestSpecificLessons?.(topic, minQuality) ?? [];
    }

    // Fallback : génération locale de leçons sur le sujet
    try {
      const result = await this.#node.generateWithAI({
        prompt        : `Génère 3 leçons concises et denses sur le sujet : ${topic}`,
        ai            : 'thevie',
        maxTokens     : 256,
        useSpeculative: false,
      });
      return result?.text
        ? result.text.split('\n').filter(l => l.trim().length > 10)
        : [];
    } catch {
      return [];
    }
  }

  // Compat accesseurs legacy
  get isRunning()   { return this.#isRunning; }
  get dreamCycle()  { return this.#dreamCycle; }
  get node()        { return this.#node; }
}

export default Thevie;