// packages/t369-inference/src/roman_diffusion.js
// =====================================================
// RomanDiffusion — ULTRA-PUISSANTE
// S-Box Romaine + Diffusion Multi-Phase + Adaptive Weights + Latent Integration
// SkyAInet × Nikola T369
// =====================================================

export class RomanDiffusion {
  constructor() {
    this.baseWeights = new Float32Array([1.0, 5.0, 10.0, 50.0, 100.0, 200.0, 250.0]);
    this.phase = 0.0;
    this.layerFactor = 1.0;
    this.depthBoost = 1.0;
    this.chaosIntensity = 0.012;
    this.latentInfluence = 0.38;
  }

  applyUltra(hidden, position, layer, latentContext = null) {
    const len = hidden.length;
    const output = new Float32Array(len);

    this.phase += 0.009;
    this.layerFactor = 1.0 + (layer * 0.028);
    this.depthBoost = layer >= 8 ? 1.018 : 1.0;

    for (let i = 0; i < len; i++) {
      const romanIdx = (i + position + layer) % 7;
      let weight = this.baseWeights[romanIdx] * this.layerFactor;

      if (latentContext) {
        const latentVal = latentContext[i % latentContext.length];
        weight += latentVal * this.latentInfluence * 0.1;
      }

      const sboxed = this.#romanSboxUltra(hidden[i], weight, i + position + layer);

      let diffused;
      const mode = (i + position + layer) % 9;

      switch (mode) {
        case 0:  diffused = sboxed - weight * 0.011; break;
        case 1:  diffused = sboxed + weight * 0.011; break;
        case 2:  diffused = this.#romanXorUltra(sboxed, weight); break;
        case 3:  diffused = sboxed * (1.0 + weight * 0.0009); break;
        case 4:  diffused = this.#romanRotateUltra(sboxed, weight | 0); break;
        case 5:  diffused = this.#romanHybridUltra(sboxed, weight, this.phase); break;
        case 6:  diffused = this.#romanChaoticUltra(sboxed, weight, i); break;
        case 7:  diffused = this.#romanSpiral(sboxed, weight, position); break;
        default: diffused = this.#romanQuantum(sboxed, weight, layer); break;
      }

      output[i] = (diffused * this.depthBoost).clamp(-14.0, 14.0) * 0.97;
    }

    return output;
  }

  // === Méthodes privées (optimisées) ===

  #romanSboxUltra(value, weight, seed) {
    const x = value + (weight * 0.0012);
    const sin1 = Math.sin(x * 4.1 + seed * 0.37) * 0.18;
    const sin2 = Math.sin(x * 1.9) * 0.09;
    const cos1 = Math.cos(x * 2.7) * 0.07;
    return x + sin1 + sin2 + cos1;
  }

  #romanXorUltra(value, weight) {
    const bits = new Uint32Array(new Float32Array([value]).buffer)[0];
    const w = (weight * 1371.0) | 0;
    const xored = bits ^ w ^ (bits >>> 7 | bits << 25);
    return (xored * 9e-8) + value * 0.998;
  }

  #romanRotateUltra(value, shift) {
    const bits = new Uint32Array(new Float32Array([value]).buffer)[0];
    const rotated = (bits << ((shift + 11) % 29)) | (bits >>> (32 - ((shift + 11) % 29)));
    return (rotated * 8e-8) + value * 0.997;
  }

  #romanHybridUltra(value, weight, phase) {
    const phaseMod = (Math.sin(phase * 1.3 + weight * 0.013) * 0.6 + 0.4);
    return value * (1.0 + weight * 0.0005 * phaseMod)
         + (weight * 0.0028) * phaseMod
         + Math.sin(value * 0.0003) * 0.4;
  }

  #romanChaoticUltra(value, weight, seed) {
    const chaos = (Math.sin(seed * 0.41) * this.chaosIntensity)
                + (Math.cos(seed * 0.19) * this.chaosIntensity * 0.7);
    return value + chaos - (value * 0.0012);
  }

  #romanSpiral(value, weight, position) {
    const spiral = (Math.sin(position * 0.27) * 0.5 + 0.5) * weight * 0.0006;
    return value * (1.0 + spiral) + Math.cos(value * 0.0008) * 0.3;
  }

  #romanQuantum(value, weight, layer) {
    const q = (Math.sin(layer * 0.11) * 0.4 + 0.6);
    return value * q + (weight * 0.0018) * (1.0 - q);
  }

  reset() {
    this.phase = 0.0;
    this.layerFactor = 1.0;
    this.depthBoost = 1.0;
  }
}