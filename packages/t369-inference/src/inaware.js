// packages/t369-inference/src/inaware.js
// =====================================================
// InAware — ULTRA-PUISSANT
// Uncertainty-Aware Inference + Confidence Scoring + Roman Self-Reflection
// SkyAInet × Nikola T369
// =====================================================

import { RomanDiffusion } from './roman_diffusion.js';

export class AwareResponse {
  constructor(text, confidence, uncertainty, entropy, tokensUsed) {
    this.text = text;
    this.confidence = confidence;
    this.uncertainty = uncertainty;
    this.entropy = entropy;
    this.tokensUsed = tokensUsed;
  }
}

export class InAware {
  constructor() {
    this.romanDiffusion = new RomanDiffusion();
    this.totalGenerations = 0;
    this.averageConfidence = 0.72;
    this.selfReflectionEnabled = true;
  }

  generateWithAwareness(logits, prompt, maxTokens = 128) {
    this.totalGenerations++;

    const entropy = this.#calculateEntropy(logits);
    const uncertainty = Math.min(entropy / 10.0, 1.0);

    const confidence = this.#calculateConfidence(logits, uncertainty);

    let response = this.#romanAwareGeneration(prompt, maxTokens, uncertainty);

    if (this.selfReflectionEnabled && uncertainty > 0.65) {
      response = this.#selfReflect(response, uncertainty);
    }

    this.averageConfidence = Math.min(this.averageConfidence * 0.92 + confidence * 0.08, 0.98);

    console.debug(
      `[InAware] Génération #${this.totalGenerations} | Confiance: ${confidence.toFixed(2)} | Incertitude: ${uncertainty.toFixed(2)}`
    );

    return new AwareResponse(response, confidence, uncertainty, entropy, maxTokens);
  }

  #calculateEntropy(logits) {
    let maxLogit = -Infinity;
    for (let i = 0; i < logits.length; i++) {
      if (logits[i] > maxLogit) maxLogit = logits[i];
    }

    let expSum = 0;
    for (let i = 0; i < logits.length; i++) {
      expSum += Math.exp(logits[i] - maxLogit);
    }

    let entropy = 0;
    for (let i = 0; i < logits.length; i++) {
      const p = Math.exp(logits[i] - maxLogit) / expSum;
      entropy -= p * Math.log(Math.max(p, 1e-10));
    }
    return entropy;
  }

  #calculateConfidence(logits, uncertainty) {
    let maxLogit = -Infinity;
    let secondMax = -Infinity;

    for (let i = 0; i < logits.length; i++) {
      if (logits[i] > maxLogit) {
        secondMax = maxLogit;
        maxLogit = logits[i];
      } else if (logits[i] > secondMax) {
        secondMax = logits[i];
      }
    }

    const margin = Math.max(0, maxLogit - secondMax);
    const baseConf = Math.min(margin / 8.0, 1.0);

    return Math.max(0.1, baseConf * (1.0 - uncertainty * 0.6));
  }

  #romanAwareGeneration(prompt, maxTokens, uncertainty) {
    let response = `Réponse consciente pour : ${prompt}`;

    if (uncertainty > 0.5) {
      const hidden = new Float32Array(128).fill(0.5);
      const diffused = this.romanDiffusion.applyUltra(hidden, 0, 0);

      if (diffused.some(x => x > 0.8)) {
        response += " [Perspective créative explorée]";
      }
    }

    return response;
  }

  #selfReflect(response, uncertainty) {
    if (uncertainty > 0.75) {
      return `${response}\n\n[Self-Reflection] Cette réponse contient une incertitude de ${(uncertainty * 100).toFixed(0)}%. Je recommande de vérifier les faits ou d’explorer d’autres perspectives.`;
    } else if (uncertainty > 0.55) {
      return `${response}\n\n[Self-Reflection] Je suis modérément confiant dans cette réponse.`;
    }
    return response;
  }

  getStats() {
    return [this.totalGenerations, this.averageConfidence];
  }

  reset() {
    this.romanDiffusion.reset();
    this.totalGenerations = 0;
    this.averageConfidence = 0.72;
  }
}