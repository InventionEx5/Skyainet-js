// packages/t369-inference/src/inference.js
// =====================================================
// T369Inference — Orchestrateur
// tokenize → generate (standard/speculative/parallel) → decode
// Compat : API d'origine + métriques tokens/sec
// SkyAInet × Nikola T369
// =====================================================

"use strict";

import { T369Model, ModelConfig }                          from './t369.js';
import { KVCache }                                         from './kv_cache.js';
import { SpeculativeDecoder, SpeculativeConfig }            from './speculative.js';
import { ParallelExecutor, ParallelConfig, ParallelStrategy } from './parallel.js';
import { BpeTokenizer }                                    from './tokenizer.js';

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
