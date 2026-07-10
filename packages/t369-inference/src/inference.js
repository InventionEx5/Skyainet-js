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
  LocalJS: 'local-js', Native: 'native', LlamaCpp: 'llama-cpp', Ollama: 'ollama',
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

// ─────────────────────────────────────────────────────────────────────────────
// OllamaBackend — inférence via un serveur Ollama local (http://127.0.0.1:11434).
//
// Parle l'API NATIVE d'Ollama (/api/generate, /api/embed, /api/tags), pas un
// format maison. Un backend = un modèle (ex. « qwen3:8b »). Pour trois cerveaux
// distincts, on enregistre trois OllamaBackend (thevie / loraevo / t369), chacun
// pointant sur son propre modèle Ollama.
//
// Durci : health-check au démarrage, erreurs EXPLICITES (serveur injoignable →
// « ollama serve » ; modèle absent → « ollama pull <modèle> »), timeout borné,
// streaming NDJSON avec callback onToken.
// ─────────────────────────────────────────────────────────────────────────────
export class OllamaBackend extends InferenceBackend {
  constructor({ url = 'http://127.0.0.1:11434', model = 'qwen3:8b', timeoutMs = 120000 } = {}) {
    super(BackendKind.Ollama);
    this.url       = String(url).replace(/\/+$/, '');   // sans slash final
    this.model     = model;
    this.timeoutMs = timeoutMs;
  }

  get capabilities() {
    return { streaming: true, adapters: false, gpu: true, sovereign: true, grammar: false, kind: 'ollama', model: this.model };
  }

  // ── Health-check : serveur joignable + modèle réellement présent ───────────
  async init() {
    let tags;
    try {
      const res = await this.#call('/api/tags', { method: 'GET' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      tags = await res.json();
    } catch (e) {
      throw new Error(`[Ollama] serveur injoignable sur ${this.url} — lance « ollama serve » (détail : ${this.#reason(e)})`);
    }
    const names = (tags?.models ?? []).map(m => m.name || m.model).filter(Boolean);
    // Ollama sous-entend le tag « :latest » — on compare avec ET sans le tag.
    const base = this.model.split(':')[0];
    const present = names.some(n => n === this.model || n.split(':')[0] === base);
    if (!present) {
      throw new Error(`[Ollama] modèle « ${this.model} » absent — lance « ollama pull ${this.model} » (installés : ${names.join(', ') || 'aucun'})`);
    }
    this.ready = true;
    return this;
  }

  // ── Génération (streaming si opts.onToken, sinon réponse unique) ────────────
  async generate(prompt, opts = {}) {
    const stream = typeof opts.onToken === 'function';
    const body = {
      model  : this.model,
      prompt : String(prompt),
      stream,
      options: {
        temperature: opts.temperature ?? 0.8,
        top_p      : opts.topP ?? 0.92,
        ...(opts.topK != null ? { top_k: opts.topK } : {}),
        num_predict: opts.maxNewTokens ?? opts.maxTokens ?? 256,
      },
    };
    let res;
    try {
      res = await this.#call('/api/generate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
    } catch (e) {
      throw new Error(`[Ollama] génération impossible sur ${this.url} — serveur arrêté ? (${this.#reason(e)})`);
    }
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`[Ollama] HTTP ${res.status} : ${txt.slice(0, 200) || 'erreur serveur'}`);
    }

    if (!stream) {
      const j = await res.json();
      return { text: j.response ?? '', tokensGenerated: j.eval_count ?? null };
    }

    // Streaming NDJSON : une ligne JSON par token { response, done }
    let text = '', tokens = 0, buf = '';
    const dec = new TextDecoder();
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let obj; try { obj = JSON.parse(line); } catch { continue; }
        if (obj.response) { text += obj.response; tokens++; try { opts.onToken(obj.response); } catch (_) { /* best-effort */ } }
        if (obj.done) return { text, tokensGenerated: obj.eval_count ?? tokens };
      }
    }
    return { text, tokensGenerated: tokens };
  }

  // ── Embeddings (/api/embed nouveau, /api/embeddings ancien en repli) ───────
  async embed(text) {
    let res;
    try {
      res = await this.#call('/api/embed', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, input: String(text) }),
      });
    } catch (e) {
      throw new Error(`[Ollama] embeddings impossibles sur ${this.url} (${this.#reason(e)})`);
    }
    if (!res.ok) throw new Error(`[Ollama] embed HTTP ${res.status}`);
    const j = await res.json();
    return j.embeddings?.[0] ?? j.embedding ?? [];
  }

  async dispose() { this.ready = false; }

  // ── Interne : fetch avec timeout borné (AbortController) ────────────────────
  async #call(path, init) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try { return await fetch(this.url + path, { ...init, signal: ac.signal }); }
    finally { clearTimeout(timer); }
  }
  #reason(e) {
    const code = e?.cause?.code || e?.code || '';
    if (code === 'ECONNREFUSED') return 'connexion refusée (serveur non démarré)';
    if (e?.name === 'AbortError') return `timeout après ${this.timeoutMs} ms`;
    return e?.message || String(e);
  }
}

// Backend node-llama-cpp (souverain, EN-PROCESSUS) : charge un GGUF directement
// dans le processus Node — pas de serveur natif séparé. Donne le contrôle DIRECT
// des grammaires GBNF depuis JS (sortie structurée GARANTIE : trames du Pilote,
// éditions de code, configs du cipher…). Import PARESSEUX : node-llama-cpp n'est
// chargé qu'à l'init, donc l'absence du paquet ne casse PAS le démarrage.
// Alternative sans nouveau code : llama-server derrière RemoteHTTPBackend (GPU,
// streaming, isolation) — voir ce backend plus haut.
export class LlamaCppBackend extends InferenceBackend {
  constructor(opts = {}) {
    super(BackendKind.LlamaCpp);
    this.modelPath   = opts.modelPath || null;   // chemin d'un .gguf (base ou fusion mergekit)
    this.contextSize = opts.contextSize ?? 4096;
    this.gpuLayers   = opts.gpuLayers;            // undefined = auto ; 0 = CPU pur
    this._llama = null; this._model = null; this._grammars = new Map();
  }
  get capabilities() { return { streaming: true, adapters: true, gpu: true, sovereign: true, grammar: true, kind: 'llama-cpp' }; }
  async init() {
    if (this._model) { this.ready = true; return this; }
    if (!this.modelPath) throw new Error('[LlamaCppBackend] modelPath (.gguf) requis');
    const { getLlama } = await import('node-llama-cpp');   // paresseux : pas d'effet au chargement du module
    this._llama = await getLlama();
    this._model = await this._llama.loadModel({
      modelPath: this.modelPath,
      ...(this.gpuLayers !== undefined ? { gpuLayers: this.gpuLayers } : {}),
    });
    this.ready = true; return this;
  }
  // Compile (et met en cache) une grammaire GBNF — rend une sortie non conforme
  // structurellement impossible.
  async _grammarFor(gbnf) {
    if (!gbnf) return undefined;
    if (this._grammars.has(gbnf)) return this._grammars.get(gbnf);
    const g = await this._llama.createGrammar({ grammar: gbnf });
    this._grammars.set(gbnf, g);
    return g;
  }
  // opts : { maxNewTokens|maxTokens, temperature, topP, topK, grammar (chaîne GBNF) }
  async generate(prompt, opts = {}) {
    if (!this._model) await this.init();
    const { LlamaCompletion } = await import('node-llama-cpp');
    const grammar = await this._grammarFor(opts.grammar);
    const context = await this._model.createContext({ contextSize: this.contextSize });
    try {
      const completion = new LlamaCompletion({ contextSequence: context.getSequence() });
      const text = await completion.generateCompletion(prompt, {
        maxTokens  : opts.maxNewTokens ?? opts.maxTokens ?? 256,
        temperature: opts.temperature ?? 0.7,
        topP       : opts.topP,
        topK       : opts.topK,
        grammar,
      });
      return { text, tokensGenerated: null, source: 'llama-cpp', backend: 'llama-cpp' };
    } finally {
      await context.dispose();   // chaque appel indépendant : pas de fuite d'état KV
    }
  }
  async dispose() { await this._model?.dispose?.(); this._model = null; this.ready = false; }
}