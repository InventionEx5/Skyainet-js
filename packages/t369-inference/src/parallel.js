// packages/t369-inference/src/parallel.js
// =====================================================
// Parallel — Pipeline + Tensor + Hybrid
// Détection CPU sans 'os' (browser+Node), délègue aux TransformerBlocks
// SkyAInet × Nikola T369
// =====================================================

"use strict";

import { T369Model } from './t369.js';

export const ParallelStrategy = Object.freeze({
  None: 'None', Pipeline: 'Pipeline', Tensor: 'Tensor', Hybrid: 'Hybrid',
});

function detectCpus() {
  if (typeof navigator !== 'undefined' && navigator.hardwareConcurrency)
    return navigator.hardwareConcurrency;
  try { return globalThis.require?.('os')?.cpus?.().length ?? 4; } catch { return 4; }
}

export class ParallelConfig {
  constructor() {
    this.strategy             = ParallelStrategy.None;
    this.numWorkers           = Math.min(8, detectCpus());
    this.pipelineStages       = 4;
    this.tensorParallelDegree = 4;
  }
}

export class ParallelExecutor {
  constructor(model, config = new ParallelConfig()) {
    this.model = model; this.config = config;
  }

  enableKVCache() { this.model.initKVCache(); }

  async pipelineParallelForward(tokens) {
    const numLayers = this.model.config.numLayers;
    const stages = this.config.pipelineStages;
    const lps = Math.ceil(numLayers / stages);
    const hidden = this._embed(tokens);
    const seqLen = tokens.length;
    for (let s = 0; s < stages; s++) {
      const start = s * lps, end = Math.min((s+1)*lps, numLayers);
      for (let li = start; li < end && li < this.model.layers.length; li++)
        this.model.layers[li].forward(hidden, seqLen, li, this.model.kvCache);
    }
    return hidden;
  }

  async tensorParallelForward(tokens) {
    const degree = Math.min(this.config.tensorParallelDegree, this.model.config.numQueryHeads);
    const hidden = this._embed(tokens);
    const seqLen = tokens.length;
    const partials = [];
    for (let w = 0; w < degree; w++) {
      const p = new Float32Array(hidden);
      for (const layer of this.model.layers) {
        const attn = layer.attention.forward(p, p, p, seqLen);
        for (let i = 0; i < p.length; i++) p[i] += attn[i];
      }
      partials.push(p);
    }
    const out = new Float32Array(hidden.length);
    const inv = 1 / degree;
    for (const p of partials) for (let i = 0; i < out.length; i++) out[i] += p[i] * inv;
    return out;
  }

  async hybridParallelForward(tokens) {
    const hidden = await this.pipelineParallelForward(tokens);
    const last = this.model.layers[this.model.layers.length - 1];
    if (last) {
      const attn = last.attention.forward(hidden, hidden, hidden, tokens.length);
      for (let i = 0; i < hidden.length; i++) hidden[i] += attn[i];
    }
    return hidden;
  }

  async executeParallel(tokens) {
    switch (this.config.strategy) {
      case ParallelStrategy.Pipeline: return this.pipelineParallelForward(tokens);
      case ParallelStrategy.Tensor:   return this.tensorParallelForward(tokens);
      case ParallelStrategy.Hybrid:   return this.hybridParallelForward(tokens);
      default:                        return this.model.forward(tokens);
    }
  }

  _embed(tokens) {
    const H = this.model.config.hiddenSize;
    const emb = this.model.embedding.dequantize();
    const hidden = new Float32Array(tokens.length * H);
    for (let i = 0; i < tokens.length; i++) {
      const src = tokens[i] * H;
      hidden.set(emb.subarray(src, src + H), i * H);
    }
    return hidden;
  }
}
