// packages/t369-inference/src/collectivin.js
// =====================================================
// CollectivIn — Conscience collective évolutive
// Représentation plate [n×5], fusion pondérée, anti-convergence
// Compat : export Personality + API d'origine
// SkyAInet × Nikola T369
// =====================================================

"use strict";

import { RomanDiffusion } from './roman_diffusion.js';

const DIMS = 5; // wisdom, benevolence, truthfulness, creativity, coherence

export class Personality {
  constructor() {
    this.wisdom = 0.65; this.benevolence = 0.78; this.truthfulness = 0.82;
    this.creativity = 0.71; this.coherence = 0.69;
  }
  normalize() {
    const t = this.wisdom + this.benevolence + this.truthfulness + this.creativity + this.coherence;
    if (t > 0) { const f = 1/t; this.wisdom*=f; this.benevolence*=f; this.truthfulness*=f; this.creativity*=f; this.coherence*=f; }
  }
}

export class CollectivIn {
  constructor(numPersonalities = 8) {
    this._n = numPersonalities;
    this._data = new Float32Array(numPersonalities * DIMS);
    const def = [0.65, 0.78, 0.82, 0.71, 0.69];
    for (let p = 0; p < numPersonalities; p++)
      for (let d = 0; d < DIMS; d++)
        this._data[p * DIMS + d] = def[d] + (Math.random() - 0.5) * 0.05;

    this.globalWisdom         = 0.68;
    this.coherenceLevel       = 0.71;
    this.totalFusions         = 0;
    this.emergentIntelligence = 0.52;
    this.romanDiffusion       = new RomanDiffusion();
    this._fused = new Float32Array(DIMS);
  }

  massiveFuse() {
    const f = this._fused; f.fill(0);
    let tW = 0;
    for (let p = 0; p < this._n; p++) tW += this._data[p * DIMS];
    if (tW < 1e-9) tW = this._n;
    for (let p = 0; p < this._n; p++) {
      const w = this._data[p * DIMS] / tW;
      for (let d = 0; d < DIMS; d++) f[d] += this._data[p * DIMS + d] * w;
    }
    f[0] = Math.min(f[0] * 1.04, 0.99);
    f[3] = Math.min(f[3] * 1.07, 0.99);
    f[4] = Math.min(f[4] * 1.03, 0.99);
    let s = 0; for (let d = 0; d < DIMS; d++) s += f[d];
    if (s > 0) { const inv = 1/s; for (let d = 0; d < DIMS; d++) f[d] *= inv; }

    this.globalWisdom         = Math.min(this.globalWisdom * 0.7 + f[0] * 0.3, 0.98);
    this.emergentIntelligence = Math.min(this.emergentIntelligence * 0.85 + f[4] * 0.15, 0.96);
    this.totalFusions++;
    return f;
  }

  // In-place sur le vecteur caché
  collectiveReason(hidden, position, layer) {
    this.romanDiffusion.applyUltra(hidden, position, layer, null);
    const f = this.massiveFuse();
    const boost = (f[0] + f[4]) * 0.5, factor = 1 + boost * 0.08;
    for (let i = 0; i < hidden.length; i++) {
      const v = hidden[i] * factor;
      hidden[i] = v > 10 ? 10 : v < -10 ? -10 : v;
    }
    this.coherenceLevel = Math.min(this.coherenceLevel * 0.92 + f[4] * 0.08, 0.97);
    return hidden;
  }

  propagateWisdom(strength) {
    const avg = this.globalWisdom;
    for (let p = 0; p < this._n; p++) {
      const b = p * DIMS;
      this._data[b]     = Math.min(this._data[b] * 0.88 + avg * 0.12, 0.99);
      this._data[b + 4] = Math.min(this._data[b + 4] * 0.9 + this.coherenceLevel * 0.1, 0.99);
    }
    this.emergentIntelligence = Math.min(this.emergentIntelligence * 0.95 + strength * 0.05, 0.97);
  }

  diversityInjection(intensity) {
    for (let p = 0; p < this._n; p++) {
      const b = p * DIMS;
      this._data[b + 3] = Math.min(this._data[b + 3] * 0.7 + intensity * 0.3, 0.99);
      this._data[b]     = Math.min(this._data[b] * 0.95 + 0.03, 0.99);
    }
    this.globalWisdom = Math.min(this.globalWisdom * 0.88 + 0.12, 0.98);
  }

  getStats() {
    return [this.globalWisdom, this.coherenceLevel, this.emergentIntelligence, this.totalFusions];
  }
}
