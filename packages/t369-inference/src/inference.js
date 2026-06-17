// packages/t369-inference/src/inference.js
// =====================================================
// T369Inference — Orchestrateur
// tokenize → generate (standard/speculative/parallel) → decode
// Compat : API d'origine + métriques tokens/sec
// SkyAInet × Nikola T369
// =====================================================

"use strict";

import { T369Model, ModelConfig }                          from '#t369';
import { KVCache }                                         from '#kv_cache';
import { SpeculativeDecoder, SpeculativeConfig }            from '#speculative';
import { ParallelExecutor, ParallelConfig, ParallelStrategy } from '#parallel';
import { BpeTokenizer }                                    from '#tokenizer';
import { GpuKernels, CpuKernels }                          from '#gpu_kernels';

export const ParallelMode = Object.freeze({
  None: 'None', Pipeline: 'Pipeline', Tensor: 'Tensor', Speculative: 'Speculative',
});

export class T369Inference {
  constructor(config = new ModelConfig()) {
    this.model              = new T369Model(config);
    this.kvCache            = null;
    this.useKVCache         = true;
    this.speculativeDecoder = null;
    this.parallelExecutor   = null;
    this.parallelMode       = ParallelMode.None;
    this._tokens = 0; this._calls = 0; this._start = Date.now();
  }

  initKVCache() {
    this.model.initKVCache();
    this.kvCache = this.model.kvCache;
  }

  loadTokenizer(tokenizer) { this.model.setTokenizer(tokenizer); return this; }

  enableSpeculativeDecoding(config = new SpeculativeConfig()) {
    this.speculativeDecoder = new SpeculativeDecoder(this.model.config, config);
    this.parallelMode = ParallelMode.Speculative;
    return this;
  }

  enablePipelineParallel(stages = 4) {
    const c = new ParallelConfig();
    c.strategy = ParallelStrategy.Pipeline; c.pipelineStages = stages;
    this.parallelExecutor = new ParallelExecutor(this.model, c);
    this.parallelMode = ParallelMode.Pipeline;
    return this;
  }

  enableTensorParallel(degree = 4) {
    const c = new ParallelConfig();
    c.strategy = ParallelStrategy.Tensor; c.tensorParallelDegree = degree;
    this.parallelExecutor = new ParallelExecutor(this.model, c);
    this.parallelMode = ParallelMode.Tensor;
    return this;
  }

  setParallelMode(mode) { this.parallelMode = mode; return this; }

  async generate(prompt, maxNewTokens = 128) {
    const tok = this.model.tokenizer;
    if (!tok) throw new Error('[Inference] Tokenizer non chargé');
    this._calls++;

    const promptTokens = tok.encode(prompt);
    if (promptTokens.length === 0) throw new Error('[Inference] Prompt vide');

    let outTokens;
    switch (this.parallelMode) {
      case ParallelMode.Speculative: outTokens = await this._spec(promptTokens, maxNewTokens); break;
      case ParallelMode.Pipeline:
      case ParallelMode.Tensor:      outTokens = await this._parallel(promptTokens, maxNewTokens); break;
      default:                       outTokens = this._standard(promptTokens, maxNewTokens);
    }

    const gen = outTokens.slice(promptTokens.length);
    this._tokens += gen.length;
    return prompt + tok.decode(gen);
  }

  _standard(promptTokens, maxNewTokens) {
    if (this.useKVCache) this.initKVCache();
    const tokens = this.model.generate(promptTokens, maxNewTokens);
    if (this.model.inSelf.isEvolving && this._calls % 5 === 0) this.model.inSelf.evolveSelf();
    return tokens;
  }

  async _spec(promptTokens, maxNewTokens) {
    if (!this.speculativeDecoder) return this._standard(promptTokens, maxNewTokens);
    return this.speculativeDecoder.speculativeGenerate(promptTokens, maxNewTokens);
  }

  async _parallel(promptTokens, maxNewTokens) {
    if (!this.parallelExecutor) return this._standard(promptTokens, maxNewTokens);
    // Préchauffe via l'exécuteur puis génère
    await this.parallelExecutor.executeParallel(promptTokens);
    return this.model.generate(promptTokens, maxNewTokens);
  }

  setKVCacheEnabled(enabled) { this.useKVCache = enabled; if (!enabled) { this.model.kvCache = null; this.kvCache = null; } else this.initKVCache(); }
  clearKVCache() { this.model.clearKVCache(); }
  loadTokenizerInstance(t) { this.model.setTokenizer(t); }

  getUltraStats() {
    const m = this.model;
    const [cyc, wis] = m.inSelf.getStats();
    const [, conf] = m.inAware.getStats();
    return `InSelf: ${cyc} | Wisdom: ${wis.toFixed(3)} | Confidence: ${conf.toFixed(2)}`;
  }

  getStats() {
    const up = (Date.now() - this._start) / 1000;
    return {
      totalTokens: this._tokens, totalCalls: this._calls,
      tokensPerSec: up > 0 ? (this._tokens / up).toFixed(1) : '0',
      parallelMode: this.parallelMode,
      model: this.model.getStats(),
      speculative: this.speculativeDecoder?.getStats() ?? null,
    };
  }
}

// =====================================================
// Inference Core (Fusion L0/L1) — abstraction tri-backend
// Un seul contrat (generate/embed) ; moteur interchangeable :
//   LocalJS (ce runtime) · RemoteHTTP (SkyCloud embarque llama.cpp/vLLM,
//   endpoint LOCAL souverain) · WebGPU (kernels WGSL pilotés JS) · WASM.
// + cache de réponses + hook Memory Router (aiguillage d'adapters).
// =====================================================

export const BackendKind = Object.freeze({
  LocalJS: 'local-js', Native: 'native', WebGPU: 'webgpu', Wasm: 'wasm', Mesh: 'mesh',
});

export class InferenceBackend {
  constructor(name) { this.name = name; this.ready = false; }
  get capabilities() { return { streaming: false, adapters: false, gpu: false, sovereign: false }; }
  async init() { this.ready = true; return this; }
  async generate(prompt, opts = {}) { throw new Error('[Backend] generate non implémenté'); }
  async embed(text) { throw new Error('[Backend] embed non supporté'); }
  async dispose() {}
}

// Backend par défaut : ce runtime JS (souverain, sans binaire). Construction
// paresseuse : le modèle n'est bâti qu'à l'init (évite de charger la chaîne lourde).
export class LocalJSBackend extends InferenceBackend {
  constructor(config = null) { super(BackendKind.LocalJS); this._config = config; this.engine = null; }
  get capabilities() { return { streaming: false, adapters: true, gpu: false, sovereign: true }; }
  async init() {
    if (!this.engine) {
      this.engine = this._config ? new T369Inference(this._config) : new T369Inference();
      if (this.engine.initKVCache) this.engine.initKVCache();
    }
    this.ready = true; return this;
  }
  configure(fn) { if (this.engine && fn) fn(this.engine); return this; }
  get router() { return (this.engine && this.engine.model && this.engine.model.moeRouter) || null; }
  async generate(prompt, opts = {}) {
    if (!this.engine) await this.init();
    return this.engine.generate(prompt, opts.maxNewTokens ?? 128);
  }
}

// SkyCloud embarque le moteur natif (llama.cpp/vLLM/MLX) et expose sa PROPRE
// API HTTP en localhost -> souverain, pas une dépendance tierce.
export class RemoteHTTPBackend extends InferenceBackend {
  constructor(endpoint = 'http://127.0.0.1:8799') { super(BackendKind.Native); this.endpoint = endpoint; }
  get capabilities() { return { streaming: true, adapters: true, gpu: true, sovereign: true }; }
  async init() { this.ready = true; return this; }
  async generate(prompt, opts = {}) {
    const res = await fetch(this.endpoint + '/api/generate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, max_tokens: opts.maxNewTokens ?? 128, adapters: opts.adapters ?? [], stream: false }),
    });
    if (!res.ok) throw new Error('[RemoteHTTPBackend] HTTP ' + res.status);
    const j = await res.json();
    return j.text ?? j.content ?? '';
  }
  async embed(text) {
    const res = await fetch(this.endpoint + '/api/embed', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: text }),
    });
    if (!res.ok) throw new Error('[RemoteHTTPBackend] embed HTTP ' + res.status);
    const j = await res.json();
    return j.embedding ?? j.data ?? [];
  }
}

// Inférence pilotée 100% depuis JS via WebGPU (kernels WGSL) — sans binaire,
// tourne aussi dans le navigateur. Kernels portés en L1.
export class WebGPUBackend extends InferenceBackend {
  constructor() { super(BackendKind.WebGPU); this.kernels = null; }
  get capabilities() { return { streaming: true, adapters: true, gpu: true, sovereign: true, browser: true, kernels: ['matmul', 'dequant4'] }; }
  static available() { return GpuKernels.available(); }
  async init() {
    if (!WebGPUBackend.available()) throw new Error('[WebGPUBackend] WebGPU indisponible sur cet hôte');
    this.kernels = new GpuKernels();
    await this.kernels.init();   // acquiert le device + compile les shaders WGSL au runtime
    this.ready = true; return this;
  }
  // Primitive exposée au moteur (matmul GPU). Le graphe forward complet se
  // compose au-dessus de ces kernels (étape suivante).
  async matmul(A, B, M, K, N) { if (!this.ready) await this.init(); return this.kernels.matmul(A, B, M, K, N); }
  async generate() { throw new Error('[WebGPUBackend] graphe forward WGSL en composition — kernels matmul/dequant prêts'); }
  async dispose() { this.kernels?.dispose(); this.ready = false; }
}

// Fallback CPU portable, sans binaire : kernels AssemblyScript -> WASM SIMD (L1).
export class WasmBackend extends InferenceBackend {
  constructor() { super(BackendKind.Wasm); this.kernels = new CpuKernels(); }
  get capabilities() { return { streaming: false, adapters: true, gpu: false, sovereign: true, portable: true, kernels: ['matmul', 'dequant4', 'silu'] }; }
  async init() { await this.kernels.init(); this.ready = true; return this; }
  // En attendant l'AssemblyScript->WASM compilé, ces primitives tournent sur le
  // kernel CPU de référence (résultats identiques, plus lent).
  matmul(A, B, M, K, N) { return this.kernels.matmul(A, B, M, K, N); }
  async generate() { throw new Error('[WasmBackend] graphe forward en composition — kernels CPU de référence prêts (WASM à compiler)'); }
}

// Backend MESH (souverain) : inférence distribuée façon Petals via le
// MeshInferenceRouter (#sharded_inference). Le modèle est sharded sur les nœuds ;
// le forward traverse la chaîne de pairs. Routeur + executeShard injectés.
export class MeshBackend extends InferenceBackend {
  constructor(router, opts = {}) {
    super(BackendKind.Mesh);
    this.router       = router ?? null;            // MeshInferenceRouter
    this.executeShard = opts.executeShard ?? null; // async (nodeId, {start,end}, act) => act
    this.redundancy   = opts.redundancy ?? 1;
  }
  get capabilities() { return { streaming: false, adapters: true, gpu: false, sovereign: true, distributed: true }; }
  async init() {
    if (!this.router) throw new Error('[MeshBackend] router requis (MeshInferenceRouter)');
    this.ready = true; return this;
  }
  async generate(prompt, opts = {}) {
    if (!this.executeShard) throw new Error('[MeshBackend] executeShard requis pour le forward distribué');
    const res = await this.router.runDistributed(prompt, this.executeShard, {
      redundancy: opts.redundancy ?? this.redundancy,
    });
    return { text: res.output, hops: res.hops, route: res.route, backend: 'mesh' };
  }
}

export class InferenceCore {
  constructor(opts = {}) {
    this.backends = new Map();
    this.kind = opts.backend || BackendKind.LocalJS;
    this.cacheEnabled = opts.cache ?? true;
    this._cache = new Map();
    this._stats = { calls: 0, hits: 0, misses: 0 };
    this.register(BackendKind.LocalJS, new LocalJSBackend(opts.modelConfig || null));
    if (opts.endpoint)   this.register(BackendKind.Native, new RemoteHTTPBackend(opts.endpoint));
    if (opts.meshRouter) this.register(BackendKind.Mesh, new MeshBackend(opts.meshRouter, opts.mesh || {}));
  }
  register(kind, backend) { this.backends.set(kind, backend); return this; }
  get backend() { return this.backends.get(this.kind); }
  async use(kind) { this.kind = kind; const b = this.backends.get(kind); if (b && !b.ready) await b.init(); return this; }

  // Sélection auto selon les capacités disponibles : natif > webgpu > local-js > wasm
  async autoSelect() {
    const order = [BackendKind.Native, BackendKind.WebGPU, BackendKind.LocalJS, BackendKind.Wasm];
    for (const k of order) {
      const b = this.backends.get(k);
      if (b) { try { await b.init(); this.kind = k; return k; } catch (_) { /* indispo -> suivant */ } }
    }
    return this.kind;
  }

  _key(prompt, opts) {
    let h = 2166136261;
    const s = prompt + '|' + (opts.maxNewTokens ?? 128) + '|' + (opts.adapters ? opts.adapters.join(',') : '');
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(36);
  }

  // Memory Router : si le backend expose un MoERouter, on dérive un biais de
  // routing d'adapters depuis un vecteur de contexte (à passer en opts.bias).
  routeAdapters(contextVec) {
    const b = this.backend;
    if (b && b.router && contextVec) { try { return b.router.biasFromContext(contextVec); } catch (_) { return null; } }
    return null;
  }

  async generate(prompt, opts = {}) {
    this._stats.calls++;
    const b = this.backend;
    if (this.cacheEnabled) {
      const k = this._key(prompt, opts);
      if (this._cache.has(k)) { this._stats.hits++; return this._cache.get(k); }
      if (b && !b.ready) await b.init();
      const out = await b.generate(prompt, opts);
      this._cache.set(k, out); this._stats.misses++;
      return out;
    }
    if (b && !b.ready) await b.init();
    return b.generate(prompt, opts);
  }

  async embed(text) { const b = this.backend; if (b && !b.ready) await b.init(); return b.embed(text); }
  clearCache() { this._cache.clear(); }
  stats() { return { ...this._stats, backend: this.kind, cacheSize: this._cache.size, capabilities: this.backend?.capabilities }; }
}
