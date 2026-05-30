// packages/t369-inference/src/indream.js
// =====================================================
// InDream — Roman Dream Attention + Dream Cycle
// Version Ultra-Puissante (utilise RomanDiffusion Ultra)
// SkyAInet × Nikola T369
// =====================================================

import { RomanDiffusion } from './roman_diffusion.js';

export class InDream {
  constructor() {
    this.diffusion = new RomanDiffusion();
    this.dreamCycles = 0;
    this.creativityBoost = 0.42;
  }

  // Applique la diffusion romaine ultra-puissante
  dreamForward(hidden, position, layer, latentContext = null) {
    return this.diffusion.applyUltra(hidden, position, layer, latentContext);
  }

  // Lance un vrai Dream Cycle (réflexion créative)
  runDreamCycle(input) {
    this.dreamCycles++;

    const dreamed = new Float32Array(input.length);

    for (let i = 0; i < input.length; i++) {
      dreamed[i] = Math.sin(input[i] * 1.12) * this.creativityBoost
                 + input[i] * (1.0 - this.creativityBoost);
    }

    // Renforcement créatif
    for (let i = 0; i < dreamed.length; i++) {
      dreamed[i] = Math.max(-8.0, Math.min(8.0, dreamed[i] * 1.03));
    }

    console.info(`[InDream] Dream Cycle #${this.dreamCycles} terminé`);
    return dreamed;
  }

  reset() {
    this.diffusion.reset();
    this.dreamCycles = 0;
  }
}