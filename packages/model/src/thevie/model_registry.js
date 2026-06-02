// packages/model/src/thevie/model_registry.js
// =====================================================
// Model Registry — Gestion Centralisée des Modèles IA
// Sélection dynamique selon tâche, coût, vitesse, qualité
// Port de model_registry.rs
// SkyAInet × Nikola T369
// =====================================================

"use strict";

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
// MODEL REGISTRY
//
// Registre central des modèles IA disponibles.
// Sélection intelligente via score composite :
//   score = quality×0.55 + speed×0.35 + spécialité×0.18 + local×0.22 - coût×45
//
// Les métriques dynamiques (latence, taux d'erreur) ajustent le score
// après chaque appel — auto-apprentissage du registre.
// ─────────────────────────────────────────────────────────────────

export class ModelRegistry {
  #models;    // Map<name, ModelInfo>

  constructor() {
    this.#models = new Map();
    this.#registerDefaults();
    console.info(`[ModelRegistry] ${this.#models.size} modèles chargés`);
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
      avgQuality: +(models.reduce((s, m) => s + m.avgQuality, 0) / models.length).toFixed(3),
    };
  }

  // ─── Defaults ─────────────────────────────────────────────────

  #registerDefaults() {
    // ─── Modèles locaux (priorité) ─────────────────────────────
    this.register({
      name: 'thevie-distilled-3b', backend: 't369', modelId: 'thevie/distilled-3b',
      costPer1kTokens: 0, avgQuality: 0.87, avgSpeed: 135,
      specialties: ['general','fast','thevie'],
      supportsLora: true, isLocal: true, contextWindow: 8192,
    });
    this.register({
      name: 'loraevo', backend: 't369', modelId: 'thevie/lora-evo',
      costPer1kTokens: 0, avgQuality: 0.85, avgSpeed: 110,
      specialties: ['evolution','learning','lora','adaptation','thevie'],
      supportsLora: true, isLocal: true, contextWindow: 8192,
    });
    this.register({
      name: 'llama-3.1-8b', backend: 'vllm', modelId: 'meta-llama/Meta-Llama-3.1-8B-Instruct',
      costPer1kTokens: 0, avgQuality: 0.84, avgSpeed: 48,
      specialties: ['code','reasoning','general'],
      supportsLora: true, isLocal: true, contextWindow: 32768,
    });
    this.register({
      name: 'mistral-7b', backend: 'vllm', modelId: 'mistralai/Mistral-7B-Instruct-v0.3',
      costPer1kTokens: 0, avgQuality: 0.82, avgSpeed: 62,
      specialties: ['general','fast','multilingual'],
      supportsLora: true, isLocal: true, contextWindow: 32768,
    });

    // ─── Modèles cloud ─────────────────────────────────────────
    this.register({
      name: 'gpt-4o', backend: 'openai', modelId: 'gpt-4o',
      costPer1kTokens: 0.005, avgQuality: 0.94, avgSpeed: 92,
      specialties: ['code','creativity','multimodal'],
      supportsLora: false, isLocal: false, contextWindow: 128000,
    });
    this.register({
      name: 'claude-sonnet-4-6', backend: 'anthropic', modelId: 'claude-sonnet-4-6',
      costPer1kTokens: 0.003, avgQuality: 0.96, avgSpeed: 68,
      specialties: ['ethics','reasoning','analysis','code'],
      supportsLora: false, isLocal: false, contextWindow: 200000,
    });
    this.register({
      name: 'deepseek-r1', backend: 'deepseek', modelId: 'deepseek-r1',
      costPer1kTokens: 0.0014, avgQuality: 0.89, avgSpeed: 110,
      specialties: ['code','math','fast'],
      supportsLora: false, isLocal: false, contextWindow: 64000,
    });
    this.register({
      name: 'gemini-2-flash', backend: 'google', modelId: 'gemini-2.0-flash',
      costPer1kTokens: 0.0010, avgQuality: 0.88, avgSpeed: 120,
      specialties: ['fast','multimodal','general'],
      supportsLora: false, isLocal: false, contextWindow: 1000000,
    });
    this.register({
      name: 'grok-3', backend: 'xai', modelId: 'grok-3',
      costPer1kTokens: 0.003, avgQuality: 0.93, avgSpeed: 85,
      specialties: ['reasoning','code','math','science','general'],
      supportsLora: false, isLocal: false, contextWindow: 131072,
    });
    this.register({
      name: 'grok-3-mini', backend: 'xai', modelId: 'grok-3-mini',
      costPer1kTokens: 0.0006, avgQuality: 0.87, avgSpeed: 150,
      specialties: ['fast','reasoning','math','code'],
      supportsLora: false, isLocal: false, contextWindow: 131072,
    });
  }
}
