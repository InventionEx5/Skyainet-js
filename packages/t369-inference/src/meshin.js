// packages/t369-inference/src/meshin.js
// =====================================================
// MeshIn — Evolving Neural Mesh
// Réseau neuronal dynamique auto-évolutif (Hebbian + Neurogenesis)
// SkyAInet × Nikola T369
// =====================================================

export class Neuron {
  constructor(id, initialWisdom = 0.5) {
    this.id = id;
    this.wisdom = initialWisdom;
    this.activation = 0.0;
    this.connections = [];
    this.lastUsed = 0;
  }
}

export class MeshIn {
  constructor() {
    this.neurons = new Map(); // id → Neuron
    this.nextId = 1;
    this.totalSynapses = 0;
    this.averageWisdom = 0.5;

    // Création des 64 neurones de base
    for (let i = 0; i < 64; i++) {
      this.addNeuron(0.5);
    }
  }

  addNeuron(initialWisdom = 0.5) {
    const id = this.nextId++;
    const neuron = new Neuron(id, initialWisdom);
    this.neurons.set(id, neuron);
    return id;
  }

  // Hebbian learning + Neurogenesis
  learn(neuronIds, strength) {
    for (const id of neuronIds) {
      const neuron = this.neurons.get(id);
      if (neuron) {
        neuron.wisdom = Math.min(neuron.wisdom + strength * 0.1, 0.99);
        neuron.activation = Math.min(neuron.activation + strength, 1.0);
        neuron.lastUsed = Date.now();
      }
    }

    // Neurogenesis : création de nouveaux neurones si sagesse élevée
    if (this.averageWisdom > 0.85 && this.neurons.size < 512) {
      this.addNeuron(0.6);
      this.totalSynapses++;
    }

    this.#updateAverageWisdom();
  }

  #updateAverageWisdom() {
    if (this.neurons.size === 0) return;
    let sum = 0;
    for (const neuron of this.neurons.values()) {
      sum += neuron.wisdom;
    }
    this.averageWisdom = sum / this.neurons.size;
  }

  getStats() {
    return [this.neurons.size, this.averageWisdom, this.totalSynapses];
  }
}