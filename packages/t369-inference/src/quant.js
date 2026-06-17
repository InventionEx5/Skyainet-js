// packages/t369-inference/src/quant.js
// =====================================================
// Quant — Block-wise 4/8-bit Quantization (GGUF-style) — Fusion L1
// Blocs de 32, buffer pool, dequant in-place + dequant partiel,
// précision MIXTE par couche/rôle (per-layer quant). SkyAInet × Nikola T369
// =====================================================

"use strict";

const BLOCK_SIZE = 32;

// Pool de buffers Float32 réutilisables (zéro GC en boucle chaude)
class BufferPool {
  #pool = new Map();
  acquire(size) {
    const b = this.#pool.get(size);
    return (b && b.length) ? b.pop() : new Float32Array(size);
  }
  release(buf) {
    const s = buf.length;
    if (!this.#pool.has(s)) this.#pool.set(s, []);
    const b = this.#pool.get(s);
    if (b.length < 64) { buf.fill(0); b.push(buf); }
  }
  // Hygiène mémoire : libère le pool (utile entre deux longues sessions)
  clear() { this.#pool.clear(); }
  stats() {
    let buffers = 0, floats = 0;
    for (const [size, arr] of this.#pool) { buffers += arr.length; floats += size * arr.length; }
    return { sizes: this.#pool.size, buffers, approxBytes: floats * 4 };
  }
}
export const bufferPool = new BufferPool();

// ─────────────────────────────────────────────────────────────────
// Politique de précision MIXTE (Fusion L1)
// Couches sensibles (embedding/attention/router) en 8-bit ; FFN/experts en
// 4-bit. Réduit la perte de qualité là où elle compte, garde la compression.
// ─────────────────────────────────────────────────────────────────

export class QuantPolicy {
  constructor(map = null) {
    this.map = map || {
      embedding: 8, attention: 8, router: 8, norm: 8,
      ffn: 4, expert: 4, lora: 8, default: 4,
    };
  }
  bitsFor(role) { return this.map[role] ?? this.map.default ?? 4; }
  setBits(role, bits) { this.map[role] = bits; return this; }
  clone() { return new QuantPolicy({ ...this.map }); }
}
export const defaultQuantPolicy = new QuantPolicy();

export class QuantizedTensor {
  constructor(rows = 0, cols = 0, bits = 8) {
    const numel     = rows * cols;
    const numBlocks = Math.max(1, Math.ceil(numel / BLOCK_SIZE));
    const dataSize  = bits === 4 ? Math.ceil(numel / 2) : numel;
    this.data          = new Int8Array(dataSize);
    this.scales        = new Float32Array(numBlocks).fill(1.0);
    this.zeroPoints    = new Float32Array(numBlocks);
    this.bits          = bits;
    this.originalShape = [rows, cols];
    this._numel        = numel;
  }

  // Compat : ancien nom quantizeFromF32 conservé
  static quantizeFromF32(data, bits = 8) { return QuantizedTensor.fromF32(data, bits); }

  // Quantifie selon une politique de précision mixte (per-layer/role)
  static fromF32WithPolicy(data, role, policy = defaultQuantPolicy) {
    return QuantizedTensor.fromF32(data, policy.bitsFor(role));
  }

  static fromF32(data, bits = 8) {
    if (!data || data.length === 0) return new QuantizedTensor(0, 0, bits);
    const numel     = data.length;
    const numBlocks = Math.ceil(numel / BLOCK_SIZE);
    const qt        = new QuantizedTensor(numel, 1, bits);
    qt._numel       = numel;
    const range     = bits === 4 ? 15 : 127;

    for (let b = 0; b < numBlocks; b++) {
      const start = b * BLOCK_SIZE;
      const end   = Math.min(start + BLOCK_SIZE, numel);
      let mn = Infinity, mx = -Infinity;
      for (let i = start; i < end; i++) {
        const v = data[i];
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      const scale = mx !== mn ? (mx - mn) / (2 * range) : 1.0;
      const zp    = Math.round(-mn / scale);
      qt.scales[b] = scale; qt.zeroPoints[b] = zp;

      if (bits === 8) {
        for (let i = start; i < end; i++)
          qt.data[i] = Math.max(-range, Math.min(range, Math.round(data[i] / scale) + zp));
      } else {
        for (let i = start; i < end; i += 2) {
          const q1 = Math.max(0, Math.min(15, Math.round(data[i] / scale) + zp));
          const q2 = (i + 1 < end) ? Math.max(0, Math.min(15, Math.round(data[i+1] / scale) + zp)) : 0;
          qt.data[i >> 1] = (q1 & 0x0F) | ((q2 & 0x0F) << 4);
        }
      }
    }
    return qt;
  }

  dequantize() {
    const out = new Float32Array(this._numel);
    this.dequantizeInplace(out);
    return out;
  }

  // Compat : ancien nom dequantizeInplace
  dequantizeInplace(output) { return this.dequantizeInto(output); }

  dequantizeInto(output) {
    const numel     = Math.min(output.length, this._numel);
    const numBlocks = Math.ceil(numel / BLOCK_SIZE);
    if (this.bits === 8) {
      for (let b = 0; b < numBlocks; b++) {
        const sc = this.scales[b], zp = this.zeroPoints[b];
        const s = b * BLOCK_SIZE, e = Math.min(s + BLOCK_SIZE, numel);
        for (let i = s; i < e; i++) output[i] = (this.data[i] - zp) * sc;
      }
    } else {
      for (let b = 0; b < numBlocks; b++) {
        const sc = this.scales[b], zp = this.zeroPoints[b];
        const s = b * BLOCK_SIZE, e = Math.min(s + BLOCK_SIZE, numel);
        let o = s;
        for (let i = s >> 1; o < e; i++) {
          const p = this.data[i];
          output[o++] = ((p & 0x0F) - zp) * sc;
          if (o < e) output[o++] = (((p >> 4) & 0x0F) - zp) * sc;
        }
      }
    }
  }

  // Dequant PARTIEL (Fusion L1) : ne reconstruit que [start, start+count)
  // dans output[0..count). Évite de déquantifier toute la matrice quand seules
  // quelques colonnes sont nécessaires (gain en boucle chaude MoE/attention).
  dequantizeRangeInto(output, start, count) {
    const end = Math.min(start + count, this._numel);
    if (this.bits === 8) {
      for (let i = start; i < end; i++) {
        const b = (i / BLOCK_SIZE) | 0;
        output[i - start] = (this.data[i] - this.zeroPoints[b]) * this.scales[b];
      }
    } else {
      for (let i = start; i < end; i++) {
        const b   = (i / BLOCK_SIZE) | 0;
        const p   = this.data[i >> 1];
        const nib = (i & 1) ? ((p >> 4) & 0x0F) : (p & 0x0F);
        output[i - start] = (nib - this.zeroPoints[b]) * this.scales[b];
      }
    }
    return output;
  }

  get numel() { return this._numel; }
  // Télémétrie compression
  get bytes() { return this.data.byteLength + this.scales.byteLength + this.zeroPoints.byteLength; }
  get compressionRatio() { return (this._numel * 4) / Math.max(1, this.bytes); }
}
