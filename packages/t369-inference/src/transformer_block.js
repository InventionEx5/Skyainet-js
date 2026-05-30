// packages/t369-inference/src/transformer_block.js
// =====================================================
// TransformerBlock
// RMSNorm + Roman Dream Attention (GQA + MHLA) + MoE + RomanDiffusion Ultra
// SkyAInet × Nikola T369
// =====================================================

import { RomanAttention } from './roman_attention.js';
import { MoELayer } from './moe.js';
import { RomanDiffusion } from './roman_diffusion.js';

export class TransformerBlock {
  constructor(hiddenSize, numQueryHeads, numKvHeads, headDim) {
    this.hiddenSize = hiddenSize;

    this.attention = new RomanAttention({
      numQueryHeads,
      numKvHeads,
      headDim,
      latentDim: 32,
      diffusionStrength: 0.38,
      maxSeqLen: 32768,
      ropeBase: 10000.0,
      ropeScaling: 1.0,
      useFlash: true,
      useMhla: true,
    });

    this.moeLayer = new MoELayer({
      numExperts: 8,
      topK: 2,
      hiddenSize,
      intermediateSize: hiddenSize * 4,
    });

    this.romanDiffusion = new RomanDiffusion();

    // RMSNorm weights (initialized to 1.0)
    this.norm1 = new Float32Array(hiddenSize).fill(1.0);
    this.norm2 = new Float32Array(hiddenSize).fill(1.0);
  }

  // === RMSNorm ultra-rapide (une seule passe) ===
  #rmsNorm(x) {
    const eps = 1e-6;
    const len = x.length;
    let sumSq = 0;

    for (let i = 0; i < len; i++) {
      sumSq += x[i] * x[i];
    }

    const rms = Math.sqrt(sumSq / len + eps);
    const invRms = 1.0 / rms;

    const out = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      out[i] = x[i] * invRms;
    }
    return out;
  }

  // === Forward pass ultra-puissant ===
  forward(hidden, seqLen, layerIdx) {
    const hiddenSize = this.hiddenSize;

    // === 1. Pre-Norm + Roman Dream Attention (GQA + MHLA + RoPE) ===
    let normed = this.#rmsNorm(hidden);
    const attnOut = this.attention.forward(normed, normed, normed, seqLen);

    // Residual connection (in-place pour perf)
    for (let i = 0; i < hidden.length; i++) {
      hidden[i] += attnOut[i];
    }

    // === 2. Pre-Norm + MoE (remplace SwiGLU) ===
    normed = this.#rmsNorm(hidden);
    const mlpOut = this.moeLayer.forward(normed);

    for (let i = 0; i < hidden.length; i++) {
      hidden[i] += mlpOut[i];
    }

    // === 3. RomanDiffusion Ultra (post-processing) ===
    const diffused = this.romanDiffusion.applyUltra(hidden, seqLen, layerIdx, null);

    // Copie finale (peut être optimisée avec subarray si besoin)
    for (let i = 0; i < hidden.length; i++) {
      hidden[i] = diffused[i];
    }

    if (process.env.NODE_ENV !== 'production') {
      console.debug(`[TransformerBlock] Layer ${layerIdx} processed (MoE + RomanDiffusion Ultra)`);
    }
  }
}