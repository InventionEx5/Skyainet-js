// packages/t369-inference/src/kv_cache.js
// =====================================================
// KVCache — Flat TypedArray, O(1) append, sliding window — Fusion L1
// Allocation unique, prefill batch + PREFIX CACHE (réutilisation du KV d'un
// préfixe de prompt commun entre requêtes). SkyAInet × Nikola T369
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

  // ── Snapshot / restore pour PREFIX CACHE (Fusion L1) ──────────
  // Copie compacte du KV des `len` premières positions (toutes couches).
  snapshot(len = this.currentSeqLen) {
    const slot = this._slot, L = this.numLayers;
    len = Math.min(len, this.currentSeqLen, this.maxSeqLen);
    const K = new Float32Array(L * len * slot);
    const V = new Float32Array(L * len * slot);
    for (let l = 0; l < L; l++) {
      const src = l * this._layerSize;
      K.set(this._K.subarray(src, src + len * slot), l * len * slot);
      V.set(this._V.subarray(src, src + len * slot), l * len * slot);
    }
    return { len, slot, numLayers: L, K, V };
  }

  // Recharge un snapshot (positionne currentSeqLen sur sa longueur). O(copie).
  restoreSnapshot(snap) {
    if (!snap || snap.slot !== this._slot || snap.numLayers !== this.numLayers) return false;
    const { len, slot, K, V } = snap;
    if (len > this.maxSeqLen) return false;
    for (let l = 0; l < this.numLayers; l++) {
      const dst = l * this._layerSize;
      this._K.set(K.subarray(l * len * slot, (l + 1) * len * slot), dst);
      this._V.set(V.subarray(l * len * slot, (l + 1) * len * slot), dst);
    }
    this.currentSeqLen = len;
    return true;
  }
}

// ─────────────────────────────────────────────────────────────────
// PREFIX CACHE STORE (Fusion L1)
//
// Mémorise le KV de préfixes de prompts déjà calculés. À la requête suivante,
// le plus long préfixe commun est restauré → on ne recalcule que le suffixe.
// Gain majeur sur prompts système / few-shot répétés.
// ─────────────────────────────────────────────────────────────────

export class PrefixCacheStore {
  constructor(maxEntries = 16) {
    this.maxEntries = maxEntries;
    this._map = new Map();   // key -> { tokens, snapshot }
    this.hits = 0; this.misses = 0;
  }

  static hashTokens(tokens, len = tokens.length) {
    let h = 2166136261;
    for (let i = 0; i < len; i++) { h ^= tokens[i] | 0; h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(36) + ':' + len;
  }

  store(tokens, snapshot) {
    const key = PrefixCacheStore.hashTokens(tokens, snapshot.len);
    if (this._map.size >= this.maxEntries && !this._map.has(key)) {
      this._map.delete(this._map.keys().next().value); // FIFO
    }
    this._map.set(key, { tokens: Array.prototype.slice.call(tokens, 0, snapshot.len), snapshot });
    return this;
  }

  // Plus long préfixe stocké qui préfixe `tokens`. Renvoie {snapshot, prefixLen} ou null.
  match(tokens) {
    let best = null, bestLen = 0;
    for (const entry of this._map.values()) {
      const t = entry.tokens;
      if (t.length > tokens.length || t.length <= bestLen) continue;
      let ok = true;
      for (let i = 0; i < t.length; i++) { if (t[i] !== tokens[i]) { ok = false; break; } }
      if (ok) { best = entry.snapshot; bestLen = t.length; }
    }
    if (best) { this.hits++; return { snapshot: best, prefixLen: bestLen }; }
    this.misses++; return null;
  }

  clear() { this._map.clear(); return this; }
  stats() { return { entries: this._map.size, hits: this.hits, misses: this.misses }; }
}
