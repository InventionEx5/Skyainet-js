// packages/t369-inference/src/transformer_block.js
// =====================================================
// TransformerBlock — Pre-Norm RMSNorm + GQA/MHLA + MoE + RomanDiffusion
// Forward in-place, RMSNorm avec weights, MoE sur dernier token
// SkyAInet × Nikola T369
// =====================================================

"use strict";

import { RomanAttention } from '#roman_attention';
import { MoELayer, MoERouter } from '#moe';
import { RomanDiffusion } from '#roman_diffusion';

export class TransformerBlock {
  constructor(hiddenSize, numQueryHeads, numKvHeads, headDim, moeConfig = null) {
    this.hiddenSize = hiddenSize;

    this.attention = new RomanAttention({
      numQueryHeads, numKvHeads, headDim,
      latentDim: 32, diffusionStrength: 0.38, maxSeqLen: 32768,
      ropeBase: 10000.0, ropeScaling: 1.0, useFlash: true, useMhla: true,
    });

    this.moeLayer = new MoELayer(moeConfig ?? {
      numExperts: 8, topK: 2, hiddenSize,
      intermediateSize: hiddenSize * 4, bits: 4,
    });
    // Memory Router L0 : routing orientable + hot-swap d'adapters sur ce bloc
    this.moeRouter = new MoERouter(this.moeLayer);

    this.romanDiffusion = new RomanDiffusion();
    this.norm1 = new Float32Array(hiddenSize).fill(1.0);
    this.norm2 = new Float32Array(hiddenSize).fill(1.0);
    this._normBuf = new Float32Array(hiddenSize);
  }

  _rmsNorm(x, weights, buf) {
    const len = x.length, eps = 1e-6;
    let ss = 0;
    for (let i = 0; i < len; i++) ss += x[i] * x[i];
    const inv = 1.0 / Math.sqrt(ss / len + eps);
    for (let i = 0; i < len; i++) buf[i] = x[i] * inv * weights[i];
    return buf;
  }

  // Forward in-place sur hidden [seqLen × hiddenSize]
  forward(hidden, seqLen, layerIdx, kvCache = null, opts = {}) {
    const H = this.hiddenSize;

    // 1. Pre-Norm (sur tout) + Attention + Residual
    // Norme une copie du tenseur complet pour l'attention
    const total = H * seqLen;
    const normedFull = new Float32Array(total);
    for (let t = 0; t < seqLen; t++) {
      const off = t * H;
      let ss = 0;
      for (let i = 0; i < H; i++) ss += hidden[off+i] * hidden[off+i];
      const inv = 1.0 / Math.sqrt(ss / H + 1e-6);
      for (let i = 0; i < H; i++) normedFull[off+i] = hidden[off+i] * inv * this.norm1[i];
    }
    const attn = this.attention.forward(normedFull, normedFull, normedFull, seqLen, kvCache, layerIdx);
    for (let i = 0; i < total; i++) hidden[i] += attn[i];

    // 2. Pre-Norm + MoE (dernier token) + Residual
    const lastOff   = (seqLen - 1) * H;
    const lastTok   = hidden.subarray(lastOff, lastOff + H);
    const normed2   = this._rmsNorm(lastTok, this.norm2, this._normBuf);
    const moeOut    = this.moeLayer.forward(normed2, { bias: opts.moeBias || null, trace: opts.trace });
    for (let i = 0; i < H; i++) hidden[lastOff + i] += moeOut[i];

    // 3. RomanDiffusion Ultra (in-place)
    this.romanDiffusion.applyUltra(hidden, seqLen, layerIdx, null);
  }

  // ─── Adapter routing du bloc (Fusion L0) ─────────────────────
  setExpertAdapter(idx, adapter)          { return this.moeLayer.setExpertAdapter(idx, adapter); }
  registerAdapter(name, adapter)          { this.moeRouter.register(name, adapter); return this; }
  attachAdapter(name, expertIdx)          { return this.moeRouter.attach(name, expertIdx); }
  routeFromContext(ctxVec, strength = 1)  { return this.moeRouter.biasFromContext(ctxVec, strength); }
  moeBalance()                            { return this.moeLayer.loadBalance(); }
}
