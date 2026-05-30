// packages/t369-inference/src/roman_diffusion.js
// =====================================================
// RomanDiffusion — ULTRA
// S-Box romaine + 9 modes de diffusion + poids adaptatifs + latent
// Table sin/cos précalculée, in-place, clamp sans prototype pollution
// SkyAInet × Nikola T369
// =====================================================

"use strict";

const BASE_WEIGHTS = new Float32Array([1.0, 5.0, 10.0, 50.0, 100.0, 200.0, 250.0]);
const TWO_PI = Math.PI * 2;

// ── Tables trigonométriques précalculées (4096 entrées) ──
const TRIG_LEN = 4096, TRIG_MASK = TRIG_LEN - 1;
const SIN_TBL = new Float32Array(TRIG_LEN);
const COS_TBL = new Float32Array(TRIG_LEN);
for (let i = 0; i < TRIG_LEN; i++) {
  const a = (i / TRIG_LEN) * TWO_PI;
  SIN_TBL[i] = Math.sin(a);
  COS_TBL[i] = Math.cos(a);
}
function fastSin(x) { return SIN_TBL[(((x / TWO_PI) * TRIG_LEN) | 0) + TRIG_LEN * 64 & TRIG_MASK]; }
function fastCos(x) { return COS_TBL[(((x / TWO_PI) * TRIG_LEN) | 0) + TRIG_LEN * 64 & TRIG_MASK]; }
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

// Buffer partagé pour réinterprétation float<->uint (zéro allocation)
const _reinterpret = new ArrayBuffer(4);
const _rF32 = new Float32Array(_reinterpret);
const _rU32 = new Uint32Array(_reinterpret);

export class RomanDiffusion {
  constructor() {
    this.baseWeights     = BASE_WEIGHTS;
    this.phase           = 0.0;
    this.layerFactor     = 1.0;
    this.depthBoost      = 1.0;
    this.chaosIntensity  = 0.012;
    this.latentInfluence = 0.38;
    this._workBuf        = null;
  }

  // ── Diffusion ultra, in-place sur hidden ──────────
  applyUltra(hidden, position, layer, latentContext = null) {
    const len = hidden.length;
    if (!this._workBuf || this._workBuf.length !== len) this._workBuf = new Float32Array(len);
    const out = this._workBuf;

    this.phase      += 0.009;
    this.layerFactor = 1.0 + layer * 0.028;
    this.depthBoost  = layer >= 8 ? 1.018 : 1.0;

    const weights = this.baseWeights;
    const lf      = this.layerFactor;
    const db      = this.depthBoost;
    const latInf  = this.latentInfluence;
    const phase   = this.phase;
    const latLen  = latentContext ? latentContext.length : 0;

    for (let i = 0; i < len; i++) {
      const key      = i + position + layer;
      const romanIdx = key % 7;
      let weight     = weights[romanIdx] * lf;

      if (latLen) weight += latentContext[i % latLen] * latInf * 0.1;

      const sboxed = this._sbox(hidden[i], weight, key);

      let d;
      switch (key % 9) {
        case 0:  d = sboxed - weight * 0.011; break;
        case 1:  d = sboxed + weight * 0.011; break;
        case 2:  d = this._xor(sboxed, weight); break;
        case 3:  d = sboxed * (1.0 + weight * 0.0009); break;
        case 4:  d = this._rotate(sboxed, weight | 0); break;
        case 5:  d = this._hybrid(sboxed, weight, phase); break;
        case 6:  d = this._chaotic(sboxed, weight, i); break;
        case 7:  d = this._spiral(sboxed, weight, position); break;
        default: d = this._quantum(sboxed, weight, layer); break;
      }

      out[i] = clamp(d * db, -14.0, 14.0) * 0.97;
    }

    hidden.set(out);
    return hidden;
  }

  // ── S-Box romaine (table-driven) ──────────────────
  _sbox(value, weight, seed) {
    const x = value + weight * 0.0012;
    return x
      + fastSin(x * 4.1 + seed * 0.37) * 0.18
      + fastSin(x * 1.9) * 0.09
      + fastCos(x * 2.7) * 0.07;
  }

  _xor(value, weight) {
    _rF32[0] = value;
    const bits = _rU32[0];
    const w = (weight * 1371.0) | 0;
    const xored = (bits ^ w ^ ((bits >>> 7) | (bits << 25))) >>> 0;
    return xored * 9e-8 + value * 0.998;
  }

  _rotate(value, shift) {
    _rF32[0] = value;
    const bits = _rU32[0];
    const s = (shift + 11) % 29;
    const rot = ((bits << s) | (bits >>> (32 - s))) >>> 0;
    return rot * 8e-8 + value * 0.997;
  }

  _hybrid(value, weight, phase) {
    const pm = fastSin(phase * 1.3 + weight * 0.013) * 0.6 + 0.4;
    return value * (1.0 + weight * 0.0005 * pm) + weight * 0.0028 * pm + fastSin(value * 0.0003) * 0.4;
  }

  _chaotic(value, weight, seed) {
    const c = fastSin(seed * 0.41) * this.chaosIntensity + fastCos(seed * 0.19) * this.chaosIntensity * 0.7;
    return value + c - value * 0.0012;
  }

  _spiral(value, weight, position) {
    const sp = (fastSin(position * 0.27) * 0.5 + 0.5) * weight * 0.0006;
    return value * (1.0 + sp) + fastCos(value * 0.0008) * 0.3;
  }

  _quantum(value, weight, layer) {
    const q = fastSin(layer * 0.11) * 0.4 + 0.6;
    return value * q + weight * 0.0018 * (1.0 - q);
  }

  reset() {
    this.phase = 0.0;
    this.layerFactor = 1.0;
    this.depthBoost = 1.0;
  }
}
