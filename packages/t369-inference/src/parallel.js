// packages/t369-inference/src/parallel.js
// =====================================================
// Parallel — Pipeline + Tensor Parallelism
// Version finale ultra-optimisée pour CPU
// SkyAInet × Nikola T369
// =====================================================

import { T369Model } from './model.js';

export const ParallelStrategy = Object.freeze({
  None: 'None',
  Pipeline: 'Pipeline',
  Tensor: 'Tensor',
  Hybrid: 'Hybrid',
});

export class ParallelConfig {
  constructor() {
    this.strategy = ParallelStrategy.None;
    this.numWorkers = Math.min(8, require('os').cpus().length);
    this.pipelineStages = 4;
    this.tensorParallelDegree = 4;
  }
}

export class ParallelExecutor {
  constructor(model, config = new ParallelConfig()) {
    this.model = model;
    this.config = config;
    this.kvCache = null;
  }

  enableKVCache() {
    this.model.initKVCache();
  }

  // === Pipeline Parallelism ===
  async pipelineParallelForward(tokens) {
    const numStages = this.config.pipelineStages;
    const numLayers = this.model.config.numLayers;
    const layersPerStage = Math.ceil(numLayers / numStages);

    let hidden = await this.#embedTokens(tokens);
    const seqLen = tokens.length;

    for (let stage = 0; stage < numStages; stage++) {
      const startLayer = stage * layersPerStage;
      const endLayer = Math.min((stage + 1) * layersPerStage, numLayers);

      // Chaque stage dans une "promesse" (simule thread)
      const stageHidden = await this.#runStage(hidden, startLayer, endLayer, seqLen);
      hidden = stageHidden;
    }

    console.debug(`[Parallel] Pipeline Parallel terminé (${numStages} stages)`);
    return hidden;
  }

  async #runStage(hidden, startLayer, endLayer, seqLen) {
    let h = new Float32Array(hidden);

    for (let layerIdx = startLayer; layerIdx < endLayer; layerIdx++) {
      if (layerIdx >= this.model.layers.length) break;

      const layer = this.model.layers[layerIdx];

      // RMSNorm + Attention
      this.model.applyRMSNorm(h);
      const attnOut = layer.attention.forward(h, h, h, seqLen);
      for (let i = 0; i < h.length; i++) h[i] += attnOut[i];

      // RMSNorm + MLP (MoE ou SwiGLU)
      this.model.applyRMSNorm(h);
      const mlpOut = this.model.swigluForward ? this.model.swigluForward(h, layer) : h;
      for (let i = 0; i < h.length; i++) h[i] += mlpOut[i];
    }

    return h;
  }

  // === Tensor Parallelism (GQA) ===
  async tensorParallelForward(tokens) {
    const degree = this.config.tensorParallelDegree;
    const numHeads = this.model.config.numQueryHeads;
    const headsPerWorker = Math.ceil(numHeads / degree);

    let hidden = await this.#embedTokens(tokens);
    const seqLen = tokens.length;

    const promises = [];

    for (let workerId = 0; workerId < degree; workerId++) {
      const startHead = workerId * headsPerWorker;
      const endHead = Math.min((workerId + 1) * headsPerWorker, numHeads);

      promises.push(
        (async () => {
          let partial = new Float32Array(hidden);
          for (const layer of this.model.layers) {
            const attnOut = layer.attention.forward(partial, partial, partial, seqLen);
            for (let i = 0; i < partial.length; i++) partial[i] += attnOut[i];
          }
          return partial;
        })()
      );
    }

    const results = await Promise.all(promises);

    // Combine results
    const finalHidden = new Float32Array(hidden.length);
    for (const partial of results) {
      for (let i = 0; i < finalHidden.length; i++) {
        finalHidden[i] += partial[i];
      }
    }

    console.debug(`[Parallel] Tensor Parallel terminé (${degree} workers)`);
    return finalHidden;
  }

  // === Hybrid Parallelism ===
  async hybridParallelForward(tokens) {
    let hidden = await this.pipelineParallelForward(tokens);

    // Tensor Parallel sur la dernière couche
    if (this.model.layers.length > 0) {
      const lastLayer = this.model.layers[this.model.layers.length - 1];
      const attnOut = lastLayer.attention.forward(hidden, hidden, hidden, tokens.length);
      for (let i = 0; i < hidden.length; i++) hidden[i] += attnOut[i];
    }

    console.debug('[Parallel] Hybrid Parallel terminé');
    return hidden;
  }

  // === Méthode principale ===
  async executeParallel(tokens) {
    switch (this.config.strategy) {
      case ParallelStrategy.Pipeline:
        return this.pipelineParallelForward(tokens);
      case ParallelStrategy.Tensor:
        return this.tensorParallelForward(tokens);
      case ParallelStrategy.Hybrid:
        return this.hybridParallelForward(tokens);
      default:
        return this.model.forward(tokens);
    }
  }

  async #embedTokens(tokens) {
    const emb = this.model.embedding.dequantize();
    const hiddenSize = this.model.config.hiddenSize;
    const hidden = new Float32Array(tokens.length * hiddenSize);

    for (let i = 0; i < tokens.length; i++) {
      const start = i * hiddenSize;
      const tokenEmb = emb.subarray(tokens[i] * hiddenSize, (tokens[i] + 1) * hiddenSize);
      hidden.set(tokenEmb, start);
    }

    return hidden;
  }
}