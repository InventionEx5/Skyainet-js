// packages/t369-inference/src/moe.js
// =====================================================
// MoE — Roman Sparse Mixture of Experts (Fusion L0)
// Base clairsemée + Dynamic Adapter Swarm (LoRA hot-swap) +
// routing orientable par contexte (Memory Router) + load balancing.
// Chemin actif petit (top-K), pool d'experts/adapters extensible à chaud.
// Poids quantifiés 4-bit, buffers poolés. SkyAInet × Nikola T369
// =====================================================

"use strict";

import { QuantizedTensor, bufferPool } from '#quant';

export class MoEConfig {
  constructor() {
    this.numExperts       = 8;
    this.topK             = 2;
    this.hiddenSize       = 2048;
    this.intermediateSize = 8192;
    this.bits             = 4;
    this.capacityFactor   = 1.25;   // marge de capacité par expert
    this.auxLossCoef      = 0.01;   // coefficient de la perte de load-balancing
  }
}

// ── LoRA adapter : résidu bas-rang appliqué en sortie d'expert ──
//    out += scale * B @ (A @ hidden)   avec A:[r×H], B:[H×r]
export class LoraAdapter {
  constructor(hiddenSize, rank = 8, scale = 1.0, name = 'adapter') {
    this.H = hiddenSize; this.r = rank; this.scale = scale; this.name = name;
    this.A = new Float32Array(rank * hiddenSize);
    this.B = new Float32Array(hiddenSize * rank);
    this._tmp = new Float32Array(rank);
    this.version = 0;
  }
  static fromWeights(H, r, A, B, scale = 1.0, name = 'adapter') {
    const a = new LoraAdapter(H, r, scale, name);
    a.A.set(A); a.B.set(B); return a;
  }
  // Initialisation type LoRA : A petit aléatoire, B à zéro (delta nul au départ)
  initLora(std = 0.02) {
    for (let i = 0; i < this.A.length; i++) this.A[i] = (Math.sin(i * 0.0007) ) * std;
    this.B.fill(0);
    return this;
  }
  applyInto(hidden, out) {
    const H = this.H, r = this.r, s = this.scale, tmp = this._tmp;
    for (let k = 0; k < r; k++) {
      let acc = 0; const base = k * H;
      for (let i = 0; i < H; i++) acc += this.A[base + i] * hidden[i];
      tmp[k] = acc;
    }
    for (let i = 0; i < H; i++) {
      let acc = 0; const base = i * r;
      for (let k = 0; k < r; k++) acc += this.B[base + k] * tmp[k];
      out[i] += s * acc;
    }
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
    this.adapter = null;            // LoRA hot-swappable
    this.name = 'expert';

    this._upBuf   = new Float32Array(hiddenSize * intermediateSize);
    this._gateBuf = new Float32Array(hiddenSize * intermediateSize);
    this._downBuf = new Float32Array(intermediateSize * hiddenSize);
    this._inter   = new Float32Array(intermediateSize);
  }

  setAdapter(adapter) { this.adapter = adapter; return this; }
  clearAdapter()      { this.adapter = null;   return this; }

  // SwiGLU : down( silu(gate·x) * (up·x) )  (+ adapter LoRA si présent)
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
    if (this.adapter) this.adapter.applyInto(hidden, out);
    return out;
  }
}

export class MoELayer {
  constructor(config = new MoEConfig()) {
    this.config = config;
    const { numExperts, hiddenSize, intermediateSize, bits } = config;
    this.hiddenSize = hiddenSize;

    // Routeur extensible : une ligne Float32Array(H) par expert
    this.routerRows = [];
    this.experts = [];
    for (let e = 0; e < numExperts; e++) {
      const row = new Float32Array(hiddenSize);
      for (let d = 0; d < hiddenSize; d++) row[d] = Math.sin(e * 0.017 + d * 0.013) * 0.1;
      this.routerRows.push(row);
      this.experts.push(new ExpertFFN(hiddenSize, intermediateSize, bits ?? 4));
    }

    this._usage  = [];                 // routages cumulés par expert
    this._sumPrb = [];                 // somme des probas routeur par expert
    for (let e = 0; e < numExperts; e++) { this._usage.push(0); this._sumPrb.push(0); }
    this._calls = 0;
  }

  get numExperts() { return this.experts.length; }

  // opts.bias : Float32Array(numExperts) ajouté aux scores avant softmax (routing orientable)
  forward(hidden, opts = {}) {
    const N = this.experts.length, H = this.hiddenSize;
    const topK = Math.min(this.config.topK, N);
    const bias = opts.bias || null;

    // Scores routeur + softmax (biais contextuel optionnel)
    const scores = bufferPool.acquire(N);
    for (let e = 0; e < N; e++) {
      let s = 0; const row = this.routerRows[e];
      for (let d = 0; d < H; d++) s += hidden[d] * row[d];
      if (bias) s += bias[e];
      scores[e] = s;
    }
    let mx = scores[0];
    for (let e = 1; e < N; e++) if (scores[e] > mx) mx = scores[e];
    let sum = 0;
    for (let e = 0; e < N; e++) { scores[e] = Math.exp(scores[e] - mx); sum += scores[e]; }
    if (sum < 1e-9) sum = 1;
    for (let e = 0; e < N; e++) { scores[e] /= sum; this._sumPrb[e] += scores[e]; }

    // Top-K sans tri
    const ids = new Int32Array(topK), wts = new Float32Array(topK);
    const used = new Uint8Array(N);
    for (let k = 0; k < topK; k++) {
      let bi = -1, bv = -Infinity;
      for (let e = 0; e < N; e++) {
        if (used[e]) continue;
        if (bi === -1 || scores[e] > bv) { bv = scores[e]; bi = e; }
      }
      if (bi === -1) break;
      ids[k] = bi; wts[k] = bv; used[bi] = 1; this._usage[bi]++;
    }
    bufferPool.release(scores);

    let wSum = 0;
    for (let k = 0; k < topK; k++) wSum += wts[k];
    if (wSum < 1e-9) wSum = 1;

    const output = new Float32Array(H);
    const routed = [];
    for (let k = 0; k < topK; k++) {
      const w = wts[k] / wSum;
      const eo = this.experts[ids[k]].forward(hidden);
      for (let i = 0; i < H; i++) output[i] += eo[i] * w;
      bufferPool.release(eo);
      routed.push({ expert: ids[k], weight: w });
    }
    this._calls++;
    if (opts.trace) output._route = routed; // télémétrie de routage (optionnelle)
    return output;
  }

  // ── Gestion dynamique du pool (adapter swarm / hot-swap) ──
  addExpert(expert, routerRow = null) {
    const H = this.hiddenSize;
    const row = routerRow ? Float32Array.from(routerRow) : new Float32Array(H);
    if (!routerRow) for (let d = 0; d < H; d++) row[d] = (Math.sin(this.experts.length * 0.017 + d * 0.013)) * 0.1;
    this.experts.push(expert);
    this.routerRows.push(row);
    this._usage.push(0); this._sumPrb.push(0);
    return this.experts.length - 1;
  }
  removeExpert(idx) {
    if (idx < 0 || idx >= this.experts.length) return false;
    this.experts.splice(idx, 1);
    this.routerRows.splice(idx, 1);
    this._usage.splice(idx, 1);
    this._sumPrb.splice(idx, 1);
    return true;
  }
  swapExpert(idx, expert) {
    if (idx < 0 || idx >= this.experts.length) return false;
    this.experts[idx] = expert; return true;
  }
  setExpertAdapter(idx, adapter) {
    if (idx < 0 || idx >= this.experts.length) return false;
    this.experts[idx].setAdapter(adapter); return true;
  }
  clearExpertAdapter(idx) {
    if (idx < 0 || idx >= this.experts.length) return false;
    this.experts[idx].clearAdapter(); return true;
  }

  loadBalance() {
    const total = this._calls * this.config.topK || 1;
    return this._usage.map(u => u / total);
  }

  // Perte de load-balancing (Switch Transformer) : N * Σ f_i · P_i
  auxLoss() {
    const N = this.experts.length, calls = this._calls || 1;
    const tot = calls * this.config.topK || 1;
    let s = 0;
    for (let e = 0; e < N; e++) {
      const f = this._usage[e] / tot;       // fraction routée
      const p = this._sumPrb[e] / calls;    // proba moyenne
      s += f * p;
    }
    return this.config.auxLossCoef * N * s;
  }

  resetStats() {
    for (let e = 0; e < this.experts.length; e++) { this._usage[e] = 0; this._sumPrb[e] = 0; }
    this._calls = 0;
  }
}

// ── Memory Router : registre d'adapters + activation par contexte ──
//    Le cœur du "Dynamic Adapter Swarm" piloté par l'orchestrateur (Thevie).
export class MoERouter {
  constructor(layer) {
    this.layer = layer;
    this.registry = new Map();   // name -> LoraAdapter
    this.active = new Map();     // expertIdx -> adapter name
  }
  register(name, adapter) { this.registry.set(name, adapter); return this; }
  unregister(name) { this.registry.delete(name); return this; }
  list() { return Array.from(this.registry.keys()); }

  // Charge un adapter nommé sur un expert (hot-swap, sans redémarrage)
  attach(name, expertIdx) {
    const a = this.registry.get(name);
    if (!a) return false;
    if (!this.layer.setExpertAdapter(expertIdx, a)) return false;
    this.active.set(expertIdx, name);
    return true;
  }
  detach(expertIdx) {
    this.layer.clearExpertAdapter(expertIdx);
    this.active.delete(expertIdx);
    return true;
  }

  // Biais de routage dérivé d'un vecteur de contexte (oriente l'activation
  // des experts selon la tâche/le Runner) -> renvoyé à MoELayer.forward(h,{bias}).
  biasFromContext(ctxVec, strength = 1.0) {
    const N = this.layer.experts.length, H = this.layer.hiddenSize;
    const bias = new Float32Array(N);
    for (let e = 0; e < N; e++) {
      let s = 0; const row = this.layer.routerRows[e];
      const L = Math.min(H, ctxVec.length);
      for (let d = 0; d < L; d++) s += ctxVec[d] * row[d];
      bias[e] = s * strength;
    }
    return bias;
  }

  snapshot() {
    return { experts: this.layer.experts.length, registered: this.list(),
             active: Array.from(this.active.entries()), balance: this.layer.loadBalance() };
  }
}
