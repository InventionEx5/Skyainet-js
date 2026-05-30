// packages/t369-inference/src/indream.js
// =====================================================
// InDream — Roman Dream Attention + Dream Cycle
// Diffusion ultra + renforcement créatif in-place
// SkyAInet × Nikola T369
// =====================================================

"use strict";

import { RomanDiffusion } from './roman_diffusion.js';

export class InDream {
  constructor() {
    this.diffusion       = new RomanDiffusion();
    this.dreamCycles     = 0;
    this.creativityBoost = 0.42;
  }

  // Applique la diffusion romaine (in-place)
  dreamForward(hidden, position, layer, latentContext = null) {
    return this.diffusion.applyUltra(hidden, position, layer, latentContext);
  }

  // Dream cycle créatif (in-place, zéro allocation)
  runDreamCycle(input) {
    this.dreamCycles++;
    const cb = this.creativityBoost, inv = 1 - cb;
    for (let i = 0; i < input.length; i++) {
      let v = Math.sin(input[i] * 1.12) * cb + input[i] * inv;
      v *= 1.03;
      input[i] = v > 8 ? 8 : v < -8 ? -8 : v;
    }
    return input;
  }

  reset() { this.diffusion.reset(); this.dreamCycles = 0; }
}
