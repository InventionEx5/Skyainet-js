// packages/t369-inference/src/kv_cache.js
// =====================================================
// KVCache — High-Performance Key-Value Cache
// Ultra-optimized for autoregressive generation
// SkyAInet × Nikola T369
// =====================================================

export class KVCache {
  constructor(numLayers, numHeads, headDim, maxSeqLen) {
    this.numLayers = numLayers;
    this.numHeads = numHeads;
    this.headDim = headDim;
    this.maxSeqLen = maxSeqLen;
    this.currentSeqLen = 0;

    const headSize = numHeads * headDim;

    this.keys = new Array(numLayers);
    this.values = new Array(numLayers);

    for (let layer = 0; layer < numLayers; layer++) {
      this.keys[layer] = new Array(maxSeqLen);
      this.values[layer] = new Array(maxSeqLen);

      for (let pos = 0; pos < maxSeqLen; pos++) {
        this.keys[layer][pos] = new Float32Array(headSize);
        this.values[layer][pos] = new Float32Array(headSize);
      }
    }
  }

  // Append new key and value for current position
  append(layer, key, value) {
    if (layer >= this.numLayers || this.currentSeqLen >= this.maxSeqLen) {
      return;
    }

    const pos = this.currentSeqLen;
    const headSize = this.numHeads * this.headDim;

    const k = this.keys[layer][pos];
    const v = this.values[layer][pos];

    const kLen = Math.min(headSize, key.length);
    for (let i = 0; i < kLen; i++) k[i] = key[i];

    const vLen = Math.min(headSize, value.length);
    for (let i = 0; i < vLen; i++) v[i] = value[i];

    if (layer === this.numLayers - 1) {
      this.currentSeqLen++;
    }
  }

  // Get keys and values up to current position for a layer
  getLayer(layer) {
    if (layer >= this.numLayers) return null;

    const end = this.currentSeqLen;
    return [
      this.keys[layer].slice(0, end),
      this.values[layer].slice(0, end)
    ];
  }

  // Reset cache (for new generation)
  clear() {
    this.currentSeqLen = 0;
  }

  // Resize cache if needed (for longer context)
  resize(newMaxSeqLen) {
    if (newMaxSeqLen <= this.maxSeqLen) return;

    const headSize = this.numHeads * this.headDim;

    for (let layer = 0; layer < this.numLayers; layer++) {
      for (let pos = this.maxSeqLen; pos < newMaxSeqLen; pos++) {
        this.keys[layer][pos] = new Float32Array(headSize);
        this.values[layer][pos] = new Float32Array(headSize);
      }
    }

    this.maxSeqLen = newMaxSeqLen;
  }

  len() {
    return this.currentSeqLen;
  }

  isEmpty() {
    return this.currentSeqLen === 0;
  }
}