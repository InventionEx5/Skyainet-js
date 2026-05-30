// packages/t369-inference/src/kv_cache.js
// =====================================================
// KVCache — Flat TypedArray, O(1) append, sliding window
// Allocation unique, prefill batch, compat API d'origine
// SkyAInet × Nikola T369
// =====================================================

"use strict";

export class KVCache {
  constructor(numLayers, numHeads, headDim, maxSeqLen) {
    this.numLayers     = numLayers;
    this.numHeads      = numHeads;
    this.headDim       = headDim;
    this.maxSeqLen     = maxSeqLen;
    this.currentSeqLen = 0;

    this._slot      = numHeads * headDim;
    this._layerSize = maxSeqLen * this._slot;
    this._K = new Float32Array(numLayers * this._layerSize);
    this._V = new Float32Array(numLayers * this._layerSize);
  }

  append(layer, key, value) {
    if (layer >= this.numLayers) return;

    if (this.currentSeqLen >= this.maxSeqLen) {
      // Sliding window : décale tout d'un slot
      const slot = this._slot;
      for (let l = 0; l < this.numLayers; l++) {
        const base = l * this._layerSize;
        this._K.copyWithin(base, base + slot, base + this.currentSeqLen * slot);
        this._V.copyWithin(base, base + slot, base + this.currentSeqLen * slot);
      }
      if (layer === this.numLayers - 1) this.currentSeqLen--;
    }

    const base = layer * this._layerSize + this.currentSeqLen * this._slot;
    const n    = Math.min(this._slot, key.length);
    for (let i = 0; i < n; i++) { this._K[base + i] = key[i]; this._V[base + i] = value[i]; }

    if (layer === this.numLayers - 1) this.currentSeqLen++;
  }

  // Renvoie des vues plates (zéro copie)
  getLayer(layer) {
    if (layer >= this.numLayers) return null;
    const base = layer * this._layerSize;
    const end  = this.currentSeqLen * this._slot;
    return [this._K.subarray(base, base + end), this._V.subarray(base, base + end)];
  }

  // Copie tout le prompt d'un coup
  prefill(layer, keys, values) {
    const base = layer * this._layerSize;
    const n    = Math.min(keys.length, this._layerSize);
    this._K.set(keys.subarray(0, n), base);
    this._V.set(values.subarray(0, n), base);
  }

  clear()   { this.currentSeqLen = 0; }
  len()     { return this.currentSeqLen; }
  isEmpty() { return this.currentSeqLen === 0; }

  resize(newMax) {
    if (newMax <= this.maxSeqLen) return;
    const slot   = this._slot;
    const newLS  = newMax * slot;
    const nK = new Float32Array(this.numLayers * newLS);
    const nV = new Float32Array(this.numLayers * newLS);
    for (let l = 0; l < this.numLayers; l++) {
      const src = l * this._layerSize, dst = l * newLS;
      nK.set(this._K.subarray(src, src + this._layerSize), dst);
      nV.set(this._V.subarray(src, src + this._layerSize), dst);
    }
    this._K = nK; this._V = nV; this._layerSize = newLS; this.maxSeqLen = newMax;
  }
}
