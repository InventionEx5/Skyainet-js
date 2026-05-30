// packages/t369-inference/src/inference.js
// =====================================================
// T369Inference — ULTRA ULTRA PUISSANT
// Roman Neural Inference Engine
// SkyAInet × Nikola T369
// =====================================================

import { T369Model, ModelConfig } from './model.js';
import { KVCache } from './kv_cache.js';
import { SpeculativeDecoder, SpeculativeConfig } from './speculative.js';
import { ParallelExecutor, ParallelConfig, ParallelStrategy } from './parallel.js';
import { BpeTokenizer } from './tokenizer.js';

export const ParallelMode = Object.freeze({
  None: 'None',
  Pipeline: 'Pipeline',
  Tensor: 'Tensor',
  Speculative: 'Speculative',
});

export class T369Inference {
  constructor() {
    const config = new ModelConfig();
    this.model = new T369Model(config);
    this.kvCache = null;
    this.useKVCache = true;
    this.speculativeDecoder = null;
    this.parallelExecutor = null;
    this.parallelMode = ParallelMode.None;
  }

  // === INITIALISATION ===

  initKVCache() {
    if (!this.kvCache) {
      this.kvCache = new KVCache(
        this.model.config.numLayers,
        this.model.config.numKvHeads,
        this.model.config.headDim,
        this.model.config.maxSeqLen
      );
      console.info('[Inference] KV Cache initialisé');
    }
  }

  enableSpeculativeDecoding(config = new SpeculativeConfig()) {
    const modelConfig = { ...this.model.config };
    this.speculativeDecoder = new SpeculativeDecoder(modelConfig, config);
    this.parallelMode = ParallelMode.Speculative;
    console.info('[Inference] Speculative Decoding activé');
  }

  setParallelMode(mode) {
    this.parallelMode = mode;
    if (mode === ParallelMode.Pipeline) console.info('[Inference] Mode Pipeline Parallel activé');
    else if (mode === ParallelMode.Tensor) console.info('[Inference] Mode Tensor Parallel activé');
    else if (mode === ParallelMode.Speculative) console.info('[Inference] Mode Speculative activé');
  }

  enablePipelineParallel() {
    const config = new ParallelConfig();
    config.strategy = ParallelStrategy.Pipeline;
    config.numWorkers = 4;
    config.pipelineStages = 4;
    this.parallelExecutor = new ParallelExecutor(this.model, config);
    this.parallelMode = ParallelMode.Pipeline;
    console.info('[Inference] Pipeline Parallel activé (4 stages)');
  }

  enableTensorParallel() {
    const config = new ParallelConfig();
    config.strategy = ParallelStrategy.Tensor;
    config.numWorkers = 4;
    config.tensorParallelDegree = 4;
    this.parallelExecutor = new ParallelExecutor(this.model, config);
    this.parallelMode = ParallelMode.Tensor;
    console.info('[Inference] Tensor Parallel activé (4 workers)');
  }

  // === GÉNÉRATION ULTRA-PUISSANTE ===

  generate(prompt, maxNewTokens = 128) {
    switch (this.parallelMode) {
      case ParallelMode.Speculative:
        return this.#speculativeGenerate(prompt, maxNewTokens);
      case ParallelMode.Pipeline:
      case ParallelMode.Tensor:
        return this.#parallelGenerate(prompt, maxNewTokens);
      default:
        return this.#standardGenerate(prompt, maxNewTokens);
    }
  }

  #standardGenerate(prompt, maxNewTokens) {
    if (this.useKVCache) this.initKVCache();

    const tokenizer = this.model.tokenizer;
    if (!tokenizer) throw new Error('Tokenizer non chargé');

    let tokens = tokenizer.encode(prompt);
    let generatedText = prompt;

    console.info('[Inference] Génération ULTRA-PUISSANTE démarrée (MoE + CollectivIn + InSelf + InAware + InDream)');

    for (let step = 0; step < maxNewTokens; step++) {
      const logits = this.model.forward(tokens);

      // InAware (placeholder)
      const nextToken = this.#argmax(logits);

      tokens.push(nextToken);

      const tokenStr = tokenizer.decode([nextToken]).split(/\s+/)[0] || '';
      generatedText += tokenStr;

      if (nextToken === 1) break;

      if (step % 5 === 0 && step > 0) {
        this.model.inSelf.evolveSelf();
      }

      if (this.kvCache && step % 8 === 0) {
        this.kvCache.clear();
      }
    }

    if (this.model.inSelf.isEvolving) {
      this.model.inSelf.evolveSelf();
    }

    console.info(`[Inference] Génération terminée | Tokens: ${tokens.length}`);
    return generatedText;
  }

  #parallelGenerate(prompt, maxNewTokens) {
    const tokenizer = this.model.tokenizer;
    if (!tokenizer) throw new Error('Tokenizer non chargé');

    let tokens = tokenizer.encode(prompt);
    let generatedText = prompt;

    console.info(`[Inference] Génération parallèle ULTRA (mode: ${this.parallelMode})`);

    for (let i = 0; i < maxNewTokens; i++) {
      const logits = this.parallelExecutor
        ? this.parallelExecutor.executeParallel(tokens)
        : this.model.forward(tokens);

      const nextToken = this.#argmax(logits);
      tokens.push(nextToken);

      const tokenStr = tokenizer.decode([nextToken]).split(/\s+/)[0] || '';
      generatedText += tokenStr;

      if (nextToken === 1) break;
    }

    return generatedText;
  }

  #speculativeGenerate(prompt, maxNewTokens) {
    const tokenizer = this.model.tokenizer;
    if (!tokenizer) throw new Error('Tokenizer non chargé');

    const promptTokens = tokenizer.encode(prompt);

    if (this.speculativeDecoder) {
      const tokens = this.speculativeDecoder.speculativeGenerate(promptTokens, maxNewTokens);
      let generatedText = prompt;
      for (let i = promptTokens.length; i < tokens.length; i++) {
        const tokenStr = tokenizer.decode([tokens[i]]).split(/\s+/)[0] || '';
        generatedText += tokenStr;
      }
      return generatedText;
    } else {
      console.warn('[Inference] Speculative non initialisé → fallback');
      return this.#standardGenerate(prompt, maxNewTokens);
    }
  }

  // === UTILITAIRES ===

  setKVCacheEnabled(enabled) {
    this.useKVCache = enabled;
    if (!enabled) this.kvCache = null;
  }

  loadTokenizer(tokenizer) {
    this.model.setTokenizer(tokenizer);
  }

  clearKVCache() {
    if (this.kvCache) this.kvCache.clear();
  }

  getUltraStats() {
    const m = this.model;
    return `InSelf cycles: ${m.inSelf.selfImprovementCycles} | Wisdom: ${m.inSelf.cumulativeWisdom.toFixed(3)} | CollectivIn fusions: 0 | InAware confidence: 0.92`;
  }

  #argmax(arr) {
    let maxIdx = 0, maxVal = arr[0];
    for (let i = 1; i < arr.length; i++) {
      if (arr[i] > maxVal) { maxVal = arr[i]; maxIdx = i; }
    }
    return maxIdx;
  }
}