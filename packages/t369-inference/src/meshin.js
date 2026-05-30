// packages/t369-inference/src/meshin.js
// =====================================================
// MeshIn — Réseau neuronal évolutif (Hebbian + Neurogenesis + Pruning)
// TypedArrays plats, compat API Neuron/MeshIn d'origine
// SkyAInet × Nikola T369
// =====================================================

"use strict";

const MAX_NEURONS  = 1024;
const PRUNE_THRESH = 0.05;
const PRUNE_IDLE   = 60_000;

// Conservé pour compat (export attendu par index.js)
export class Neuron {
  constructor(id, initialWisdom = 0.5) {
    this.id = id; this.wisdom = initialWisdom;
    this.activation = 0.0; this.connections = []; this.lastUsed = 0;
  }
}

export class MeshIn {
  constructor(initialSize = 64) {
    this._wisdom     = new Float32Array(MAX_NEURONS);
    this._activation = new Float32Array(MAX_NEURONS);
    this._lastUsed   = new Float64Array(MAX_NEURONS);
    this._active     = new Uint8Array(MAX_NEURONS);
    this._count         = 0;
    this.totalSynapses  = 0;
    this.averageWisdom  = 0.5;
    this._learnCalls    = 0;
    for (let i = 0; i < initialSize; i++) this.addNeuron(0.5);
  }

  addNeuron(initialWisdom = 0.5) {
    if (this._count >= MAX_NEURONS) return -1;
    const id = this._count++;
    this._wisdom[id] = initialWisdom;
    this._activation[id] = 0.0;
    this._lastUsed[id] = Date.now();
    this._active[id] = 1;
    return id;
  }

  learn(neuronIds, strength) {
    const now = Date.now();
    const s = strength < 0 ? 0 : strength > 1 ? 1 : strength;
    for (const id of neuronIds) {
      if (id < 0 || id >= this._count || !this._active[id]) continue;
      this._wisdom[id]     = Math.min(this._wisdom[id] + s * 0.1, 0.99);
      this._activation[id] = Math.min(this._activation[id] + s, 1.0);
      this._lastUsed[id]   = now;
    }
    this._updateAvg();
    if (this.averageWisdom > 0.85 && this._count < MAX_NEURONS) {
      this.addNeuron(0.6); this.totalSynapses++;
    }
    if (++this._learnCalls % 256 === 0) this._prune();
  }

  wisdomVector(size) {
    const out = new Float32Array(size);
    let j = 0;
    for (let i = 0; i < this._count && j < size; i++) if (this._active[i]) out[j++] = this._wisdom[i];
    return out;
  }

  _updateAvg() {
    let sum = 0, n = 0;
    for (let i = 0; i < this._count; i++) if (this._active[i]) { sum += this._wisdom[i]; n++; }
    this.averageWisdom = n ? sum / n : 0.5;
  }

  _prune() {
    const now = Date.now();
    for (let i = 0; i < this._count; i++)
      if (this._active[i] && this._wisdom[i] < PRUNE_THRESH && now - this._lastUsed[i] > PRUNE_IDLE)
        this._active[i] = 0;
  }

  get neurons() { return { size: Array.from(this._active).filter(Boolean).length }; }

  getStats() {
    const active = Array.from(this._active).filter(Boolean).length;
    return [active, this.averageWisdom, this.totalSynapses];
  }
}
