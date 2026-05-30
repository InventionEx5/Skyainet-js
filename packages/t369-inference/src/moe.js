// packages/t369-inference/src/moe.js
// =====================================================
// Mixture of Experts (MoE) — Roman Sparse MoE
// 8 Experts + Top-2 Routing + Roman Router
// SkyAInet × Nikola T369
// =====================================================

export class MoEConfig {
  constructor() {
    this.numExperts = 8;
    this.topK = 2;
    this.hiddenSize = 2048;
    this.intermediateSize = 8192;
  }
}

export class ExpertFFN {
  constructor(hiddenSize, intermediateSize) {
    this.up   = new Float32Array(hiddenSize * intermediateSize);
    this.gate = new Float32Array(hiddenSize * intermediateSize);
    this.down = new Float32Array(intermediateSize * hiddenSize);
  }
}

export class MoELayer {
  constructor(config = new MoEConfig()) {
    this.config = config;
    const { numExperts, hiddenSize, intermediateSize } = config;

    // Router : numExperts × hiddenSize
    this.router = new Float32Array(numExperts * hiddenSize);
    for (let e = 0; e < numExperts; e++) {
      for (let d = 0; d < hiddenSize; d++) {
        this.router[e * hiddenSize + d] = Math.sin(e * 0.017 + d * 0.013) * 0.1;
      }
    }

    // 8 experts
    this.experts = [];
    for (let i = 0; i < numExperts; i++) {
      this.experts.push(new ExpertFFN(hiddenSize, intermediateSize));
    }
  }

  forward(hidden) {
    const { numExperts, topK, hiddenSize, intermediateSize } = this.config;
    const len = hidden.length;

    // 1. Router scores
    const scores = new Float32Array(numExperts);
    for (let e = 0; e < numExperts; e++) {
      let sum = 0;
      for (let d = 0; d < hiddenSize; d++) {
        sum += hidden[d] * this.router[e * hiddenSize + d];
      }
      scores[e] = Math.tanh(sum);
    }

    // 2. Top-K selection
    const expertScores = Array.from(scores, (s, i) => ({ id: i, score: s }));
    expertScores.sort((a, b) => b.score - a.score);
    const selected = expertScores.slice(0, topK);

    const weightSum = selected.reduce((sum, e) => sum + e.score, 0) || 1;

    // 3. Execute selected experts
    const output = new Float32Array(hiddenSize);

    for (const { id: expertId, score: weight } of selected) {
      const expert = this.experts[expertId];
      const expertOut = new Float32Array(hiddenSize);

      for (let i = 0; i < hiddenSize; i++) {
        let gateVal = 0;
        let upVal = 0;

        for (let j = 0; j < intermediateSize; j++) {
          const idx = i * intermediateSize + j;
          gateVal += hidden[i] * expert.gate[idx];
          upVal   += hidden[i] * expert.up[idx];
        }

        const activated = gateVal * (upVal / (1 + Math.exp(-upVal)));
        for (let j = 0; j < intermediateSize; j++) {
          expertOut[i] += activated * expert.down[i * intermediateSize + j];
        }
      }

      // Weighted sum
      const w = weight / weightSum;
      for (let i = 0; i < hiddenSize; i++) {
        output[i] += expertOut[i] * w;
      }
    }

    return output;
  }
}