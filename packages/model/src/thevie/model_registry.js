// packages/model/src/thevie/model_registry.js
// =====================================================
// Model Registry — Gestion Centralisée des Modèles + Adapters (Fusion L0)
// Sélection dynamique selon tâche, coût, vitesse, qualité.
// Roster aligné : local = Thevie / LoraÉvo / open-weights ;
// cloud = Claude · Deepseek · Grok (gpt-4o + gemini + mistral retirés).
// + Catalogue du Dynamic Adapter Swarm (découverte d'adapters LoRA par tâche).
// SkyAInet × Nikola T369
// =====================================================

"use strict";

// ─────────────────────────────────────────────────────────────────
// MESURES RÉELLES (bancs kernel_bench.mjs / engine_bench.mjs, ce dépôt)
// Données HONNÊTES, mesurées sur CPU en JS pur, à PETITE échelle (modèle non
// entraîné). Elles ne représentent PAS une cible 3B/GPU et ne servent donc pas
// à fixer avgSpeed/avgQuality des entrées ci-dessous (qui restent des objectifs
// provisoires tant que de vrais poids entraînés n'existent pas). On les expose
// pour traçabilité et pour alimenter les métriques dynamiques à l'exécution.
// ─────────────────────────────────────────────────────────────────
export const MEASURED_REFERENCE = {
  measuredAt   : '2026-06 (CPU, Node, JS pur)',
  engine       : {
    backend          : 't369',
    path             : 'causal incrémental (cache KV)',
    decodeTokPerSec  : { 'H256_L6': 19, 'H512_L8': 3 },   // mesuré
    note             : 'moteur JS de référence, petite échelle — non extrapolable à 3B/GPU',
  },
  matmulKernel : {
    impl             : 'CpuKernels.matmulTiled (transpose + accum. registre)',
    speedupVsNaive   : 1.14,                               // ×, mesuré 256³–512³
    gflops           : 1.12,                               // GFLOP/s, mesuré
    relErrorVsF64    : 5.9e-8,                             // plus précis que l'oracle naïf
  },
};

// ─────────────────────────────────────────────────────────────────
// MODEL INFO
// ─────────────────────────────────────────────────────────────────

export class ModelInfo {
  constructor({
    name, backend, modelId,
    costPer1kTokens = 0,
    avgQuality      = 0.80,
    avgSpeed        = 50,
    specialties     = [],
    supportsLora    = false,
    isLocal         = false,
    contextWindow   = 8192,
  }) {
    this.name             = name;
    this.backend          = backend;
    this.modelId          = modelId;
    this.costPer1kTokens  = costPer1kTokens;
    this.avgQuality       = Math.max(0, Math.min(1, avgQuality));
    this.avgSpeed         = avgSpeed;     // tokens/s
    this.specialties      = specialties;
    this.supportsLora     = supportsLora;
    this.isLocal          = isLocal;
    this.contextWindow    = contextWindow;
    // Métriques dynamiques — mises à jour après chaque usage
    this._callCount       = 0;
    this._totalLatencyMs  = 0;
    this._errorCount      = 0;
  }

  /** Latence moyenne observée en ms */
  get avgLatencyMs() {
    return this._callCount > 0 ? this._totalLatencyMs / this._callCount : 0;
  }

  /** Taux d'erreur observé */
  get errorRate() {
    return this._callCount > 0 ? this._errorCount / this._callCount : 0;
  }

  /**
   * Enregistre un appel (pour métriques dynamiques).
   * @param {number} latencyMs
   * @param {boolean} success
   */
  recordCall(latencyMs, success = true) {
    this._callCount++;
    this._totalLatencyMs += latencyMs;
    if (!success) this._errorCount++;
    // Mise à jour EMA de la vitesse
    const estimatedTps = 1000 / Math.max(1, latencyMs) * 50;
    this.avgSpeed = this.avgSpeed * 0.9 + estimatedTps * 0.1;
  }
}

// ─────────────────────────────────────────────────────────────────
// ADAPTER INFO — métadonnées d'un adapter LoRA du swarm (Fusion L0)
//
// Le swarm = pool d'adapters hot-swappables (cf. moe.js / MoERouter).
// Le registre permet de DÉCOUVRIR le bon adapter pour une tâche puis de
// l'activer sur un expert via le Memory Router.
// ─────────────────────────────────────────────────────────────────

export class AdapterInfo {
  constructor({
    name,
    task           = 'general',
    rank           = 8,
    scale          = 1.0,
    baseModel      = 'thevie-8b',
    source         = 'lesson',        // 'lesson' | 'distilled' | 'manual' | 'dream'
    runner         = 'thevie',        // Runner propriétaire (thevie | loraevo | t369)
    supportsHotSwap = true,
    version        = 1,
    specialties    = [],
  }) {
    this.name            = name;
    this.task            = task;
    this.rank            = rank;
    this.scale           = scale;
    this.baseModel       = baseModel;
    this.source          = source;
    this.runner          = runner;
    this.supportsHotSwap = supportsHotSwap;
    this.version         = version;
    this.specialties     = specialties.length ? specialties : [task];
    this._uses           = 0;
  }
  recordUse() { this._uses++; }
  get uses()  { return this._uses; }
}

// ─────────────────────────────────────────────────────────────────
// MODEL REGISTRY
//
// Registre central des modèles IA + adapters disponibles.
// Sélection intelligente via score composite :
//   score = quality×0.55 + speed×0.35 + spécialité×0.18 + local×0.22 - coût×45
//
// Les métriques dynamiques (latence, taux d'erreur) ajustent le score
// après chaque appel — auto-apprentissage du registre.
// ─────────────────────────────────────────────────────────────────

export class ModelRegistry {
  #models;    // Map<name, ModelInfo>
  #adapters;  // Map<name, AdapterInfo>

  constructor() {
    this.#models   = new Map();
    this.#adapters = new Map();
    this.#registerDefaults();
    this.#registerDefaultAdapters();
    console.info(`[ModelRegistry] ${this.#models.size} modèles, ${this.#adapters.size} adapters chargés`);
  }

  // ─── Enregistrement ──────────────────────────────────────────

  register(info) {
    const model = info instanceof ModelInfo ? info : new ModelInfo(info);
    this.#models.set(model.name, model);
    console.info(`[ModelRegistry] Modèle enregistré → ${model.name} (${model.backend})`);
    return this;
  }

  unregister(name) {
    return this.#models.delete(name);
  }

  // ─── Sélection intelligente ───────────────────────────────────

  /**
   * Sélectionne le meilleur modèle pour une tâche donnée
   * (port de get_best_model).
   *
   * Score composite :
   *   quality × 0.55 + (speed/150) × 0.35
   *   + spécialité × 0.18
   *   + local × 0.22
   *   - errorRate × 0.30    (pénalité dynamique)
   *   - cost × 45.0         (pénalité coût cloud)
   *
   * @param {string}  taskType    — ex. "code", "ethics", "fast"
   * @param {boolean} preferLocal — favoriser les modèles locaux
   * @param {number}  maxBudget   — coût max / 1k tokens (0 = illimité)
   * @returns {ModelInfo|null}
   */
  getBestModel(taskType = 'general', preferLocal = true, maxBudget = Infinity) {
    let best      = null;
    let bestScore = -Infinity;

    for (const model of this.#models.values()) {
      // Filtre budgétaire (les modèles locaux ignorent le budget)
      if (!model.isLocal && model.costPer1kTokens > maxBudget) continue;

      let score = model.avgQuality * 0.55 + (model.avgSpeed / 150) * 0.35;

      // Bonus spécialité
      if (model.specialties.some(s => s.includes(taskType) || taskType.includes(s))) {
        score += 0.18;
      }

      // Bonus local
      if (preferLocal && model.isLocal) score += 0.22;

      // Pénalité taux d'erreur dynamique
      score -= model.errorRate * 0.30;

      // Pénalité coût cloud
      if (!model.isLocal) score -= model.costPer1kTokens * 45;

      if (score > bestScore) {
        bestScore = score;
        best      = model;
      }
    }

    if (best) {
      console.debug(`[ModelRegistry] "${taskType}" → ${best.name} (score: ${bestScore.toFixed(3)})`);
    }

    return best;
  }

  /**
   * Sélectionne le modèle LoRA-compatible le plus adapté.
   * @param {string} taskType
   * @returns {ModelInfo|null}
   */
  getBestLoraModel(taskType = 'general') {
    return this.getBestModel(taskType, true, 0) ?? null;
  }

  // ─── Métriques dynamiques ────────────────────────────────────

  /**
   * Enregistre un appel pour mettre à jour les métriques d'un modèle.
   * @param {string}  name
   * @param {number}  latencyMs
   * @param {boolean} success
   */
  recordCall(name, latencyMs, success = true) {
    this.#models.get(name)?.recordCall(latencyMs, success);
  }

  // ─── Adapter Swarm (Fusion L0) ───────────────────────────────

  registerAdapter(info) {
    const a = info instanceof AdapterInfo ? info : new AdapterInfo(info);
    this.#adapters.set(a.name, a);
    return this;
  }
  unregisterAdapter(name) { return this.#adapters.delete(name); }
  getAdapter(name)        { return this.#adapters.get(name) ?? null; }
  hasAdapter(name)        { return this.#adapters.has(name); }
  listAdapters()          { return [...this.#adapters.values()]; }
  listAdaptersFor(runner) { return [...this.#adapters.values()].filter(a => a.runner === runner); }
  get totalAdapters()     { return this.#adapters.size; }

  /**
   * Découvre le meilleur adapter pour une tâche (spécialité > tâche exacte >
   * léger biais d'usage). Sert au Memory Router pour l'activation à chaud.
   * @param {string} taskType
   * @returns {AdapterInfo|null}
   */
  getBestAdapter(taskType = 'general') {
    let best = null, bestScore = -Infinity;
    for (const a of this.#adapters.values()) {
      let s = 0;
      if (a.specialties.some(x => x.includes(taskType) || taskType.includes(x))) s += 1.0;
      if (a.task === taskType) s += 0.5;
      s += Math.min(a._uses, 50) * 0.001; // adapters éprouvés légèrement favorisés
      if (s > bestScore) { bestScore = s; best = a; }
    }
    return best;
  }

  // ─── Lecture ─────────────────────────────────────────────────

  getModel(name)       { return this.#models.get(name) ?? null; }
  hasModel(name)       { return this.#models.has(name); }
  listModels()         { return [...this.#models.values()]; }
  listLocalModels()    { return [...this.#models.values()].filter(m => m.isLocal); }
  listCloudModels()    { return [...this.#models.values()].filter(m => !m.isLocal); }
  get totalModels()    { return this.#models.size; }

  stats() {
    const models = this.listModels();
    return {
      total    : models.length,
      local    : models.filter(m => m.isLocal).length,
      cloud    : models.filter(m => !m.isLocal).length,
      loraReady: models.filter(m => m.supportsLora).length,
      adapters : this.#adapters.size,
      avgQuality: +(models.reduce((s, m) => s + m.avgQuality, 0) / models.length).toFixed(3),
    };
  }

  // ─── Defaults ─────────────────────────────────────────────────

  #registerDefaults() {
    // ─── Modèles locaux (priorité, souverains) ─────────────────
    // NB : avgQuality / avgSpeed ci-dessous sont des OBJECTIFS provisoires
    // (poids 3B entraînés pas encore disponibles), utilisés pour le scoring du
    // sélecteur. Mesures réelles du moteur actuel : voir MEASURED_REFERENCE.
    this.register({
      name: 'thevie-8b', backend: 't369', modelId: 'thevie/qwen3-8b-distilled',
      costPer1kTokens: 0, avgQuality: 0.87, avgSpeed: 135,
      specialties: ['general','fast','thevie','rag','orchestration'],
      supportsLora: true, isLocal: true, contextWindow: 32768,   // distillé depuis Qwen3-8B
    });
    this.register({
      name: 'loraevo', backend: 't369', modelId: 'thevie/lora-evo',
      costPer1kTokens: 0, avgQuality: 0.85, avgSpeed: 110,
      specialties: ['evolution','learning','lora','adaptation','code','contracts','thevie'],
      supportsLora: true, isLocal: true, contextWindow: 32768,   // adaptateur sur Qwen3-8B
    });
    this.register({
      name: 'qwen3-8b', backend: 'vllm', modelId: 'Qwen/Qwen3-8B',
      costPer1kTokens: 0, avgQuality: 0.84, avgSpeed: 48,
      specialties: ['base','code','reasoning','general'],
      supportsLora: true, isLocal: true, contextWindow: 32768,   // base résidente (Apache 2.0)
    });

    // ─── Modèles cloud (partenaires : Grok · Claude · DeepSeek) ──
    this.register({
      name: 'claude-sonnet-4-6', backend: 'anthropic', modelId: 'claude-sonnet-4-6',
      costPer1kTokens: 0.003, avgQuality: 0.96, avgSpeed: 68,
      specialties: ['ethics','reasoning','analysis','code'],
      supportsLora: false, isLocal: false, contextWindow: 200000,
    });
    this.register({
      name: 'deepseek-v4', backend: 'deepseek', modelId: 'deepseek-v4',
      costPer1kTokens: 0.0014, avgQuality: 0.91, avgSpeed: 115,
      specialties: ['code','math','fast','reasoning'],
      supportsLora: false, isLocal: false, contextWindow: 64000,
    });
    this.register({
      name: 'grok-4', backend: 'xai', modelId: 'grok-4',
      costPer1kTokens: 0.003, avgQuality: 0.95, avgSpeed: 88,
      specialties: ['reasoning','code','math','science','general'],
      supportsLora: false, isLocal: false, contextWindow: 131072,
    });
  }

  // Adapters représentatifs du swarm, rattachés aux Runners (Thevie/LoraÉvo/T369)
  #registerDefaultAdapters() {
    this.registerAdapter({
      name: 'thevie-rag', task: 'rag', runner: 'thevie', source: 'distilled',
      baseModel: 'thevie-8b', specialties: ['rag','synthesis','orchestration','general'],
    });
    this.registerAdapter({
      name: 'loraevo-code', task: 'code', runner: 'loraevo', source: 'lesson',
      baseModel: 'loraevo', rank: 16, specialties: ['code','contracts','web','governance'],
    });
    this.registerAdapter({
      name: 't369-security', task: 'security', runner: 't369', source: 'manual',
      baseModel: 'thevie-8b', specialties: ['security','verification','attestation'],
    });
    this.registerAdapter({
      name: 't369-dreamweaver', task: 'imagination', runner: 't369', source: 'dream',
      baseModel: 'thevie-8b', specialties: ['imagination','synthesis','creativity'],
    });
  }
}
