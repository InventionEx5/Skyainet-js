// packages/t369-inference/src/moe.js
// =====================================================
// MoE — Roman Sparse Mixture of Experts
// Router softmax + SwiGLU + Top-K sans sort + load balancing
// Poids quantifiés 4-bit, buffers poolés
// SkyAInet × Nikola T369
// =====================================================

"use strict";

import { QuantizedTensor, bufferPool } from './quant.js';

export class MoEConfig {
  constructor() {
    this.numExperts       = 8;
    this.topK             = 2;
    this.hiddenSize       = 2048;
    this.intermediateSize = 8192;
    this.bits             = 4;
  }
}

export class ExpertFFN {
  constructor(hiddenSize, intermediateSize, bits = 4) {
    const initUp   = new Float32Array(hiddenSize * intermediateSize);
    const initGate = new Float32Array(hiddenSize * intermediateSize);
    const initDown = new Float32Array(intermediateSize * hiddenSize);
    for (let i = 0; i < initUp.length; i++)   initUp[i]   = Math.sin(i * 0.001)  * 0.02;
    for (let i = 0; i < initGate.length; i++) initGate[i] = Math.cos(i * 0.001)  * 0.02;
    for (let i = 0; i < initDown.length; i++) initDown[i] = Math.sin(i * 0.0013) * 0.02;

    this.up   = QuantizedTensor.fromF32(initUp, bits);
    this.gate = QuantizedTensor.fromF32(initGate, bits);
    this.down = QuantizedTensor.fromF32(initDown, bits);

    this.hiddenSize = hiddenSize;
    this.intermediateSize = intermediateSize;

    this._upBuf   = new Float32Array(hiddenSize * intermediateSize);
    this._gateBuf = new Float32Array(hiddenSize * intermediateSize);
    this._downBuf = new Float32Array(intermediateSize * hiddenSize);
    this._inter   = new Float32Array(intermediateSize);
  }

  // SwiGLU : down( silu(gate·x) * (up·x) )
  forward(hidden) {
    const H = this.hiddenSize, I = this.intermediateSize;
    this.up.dequantizeInto(this._upBuf);
    this.gate.dequantizeInto(this._gateBuf);
    this.down.dequantizeInto(this._downBuf);

    const inter = this._inter;
    for (let j = 0; j < I; j++) {
      let g = 0, u = 0;
      for (let i = 0; i < H; i++) {
        const h = hidden[i];
        g += h * this._gateBuf[i * I + j];
        u += h * this._upBuf[i * I + j];
      }
      inter[j] = (g / (1 + Math.exp(-g))) * u; // SiLU(gate)*up
    }

    const out = bufferPool.acquire(H);
    out.fill(0);
    for (let i = 0; i < H; i++) {
      let v = 0;
      for (let j = 0; j < I; j++) v += inter[j] * this._downBuf[j * H + i];
      out[i] = v;
    }
    return out;
  }
}

export class MoELayer {
  constructor(config = new MoEConfig()) {
    this.config = config;
    const { numExperts, hiddenSize, intermediateSize, bits } = config;

    this.router = new Float32Array(numExperts * hiddenSize);
    for (let e = 0; e < numExperts; e++)
      for (let d = 0; d < hiddenSize; d++)
        this.router[e * hiddenSize + d] = Math.sin(e * 0.017 + d * 0.013) * 0.1;

    this.experts = [];
    for (let i = 0; i < numExperts; i++)
      this.experts.push(new ExpertFFN(hiddenSize, intermediateSize, bits ?? 4));

    this._usage = new Uint32Array(numExperts);
    this._calls = 0;
  }

  forward(hidden) {
    const { numExperts, topK, hiddenSize } = this.config;

    // Router scores + softmax
    const scores = bufferPool.acquire(numExperts);
    for (let e = 0; e < numExperts; e++) {
      let s = 0;
      const base = e * hiddenSize;
      for (let d = 0; d < hiddenSize; d++) s += hidden[d] * this.router[base + d];
      scores[e] = s;
    }
    let mx = scores[0];
    for (let e = 1; e < numExperts; e++) if (scores[e] > mx) mx = scores[e];
    let sum = 0;
    for (let e = 0; e < numExperts; e++) { scores[e] = Math.exp(scores[e] - mx); sum += scores[e]; }
    for (let e = 0; e < numExperts; e++) scores[e] /= sum;

    // Top-K sans tri (numExperts petit). On part de bi=premier non-utilisé
    // pour garantir un indice valide même quand tous les scores sont égaux.
    const ids = new Int32Array(topK), wts = new Float32Array(topK);
    const used = new Uint8Array(numExperts);
    for (let k = 0; k < topK; k++) {
      let bi = -1, bv = -Infinity;
      for (let e = 0; e < numExperts; e++) {
        if (used[e]) continue;
        if (bi === -1 || scores[e] > bv) { bv = scores[e]; bi = e; }
      }
      if (bi === -1) break; // plus d'experts disponibles
      ids[k] = bi; wts[k] = bv; used[bi] = 1; this._usage[bi]++;
    }
    bufferPool.release(scores);

    let wSum = 0;
    for (let k = 0; k < topK; k++) wSum += wts[k];
    if (wSum < 1e-9) wSum = 1;

    const output = new Float32Array(hiddenSize);
    for (let k = 0; k < topK; k++) {
      const w = wts[k] / wSum;
      const eo = this.experts[ids[k]].forward(hidden);
      for (let i = 0; i < hiddenSize; i++) output[i] += eo[i] * w;
      bufferPool.release(eo);
    }
    this._calls++;
    return output;
  }

  loadBalance() {
    const total = this._calls * this.config.topK || 1;
    return Array.from(this._usage, u => u / total);
  }
}
