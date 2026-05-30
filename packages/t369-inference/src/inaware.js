// packages/t369-inference/src/inaware.js
// =====================================================
// InAware — Uncertainty-Aware Inference
// Entropie + margin top1/top2 sur logits, refine si incertain
// Compat : generateWithAwareness conservé + analyze(logits)
// SkyAInet × Nikola T369
// =====================================================

"use strict";

import { RomanDiffusion } from './roman_diffusion.js';

export class AwareResponse {
  constructor(payload, confidence, uncertainty, entropy, extra) {
    this.payload     = payload;
    this.logits      = payload instanceof Float32Array ? payload : null;
    this.text        = typeof payload === 'string' ? payload : null;
    this.confidence  = confidence;
    this.uncertainty = uncertainty;
    this.entropy     = entropy;
    this.topToken    = typeof extra === 'number' ? extra : null;
    this.tokensUsed  = typeof extra === 'number' ? null : extra;
  }
}

export class InAware {
  constructor() {
    this.romanDiffusion        = new RomanDiffusion();
    this.totalGenerations      = 0;
    this.averageConfidence     = 0.72;
    this.selfReflectionEnabled = true;
    this._uncThresh            = 0.65;
  }

  // ── Chemin rapide : analyse de logits (utilisé par model.js) ──
  analyze(logits) {
    this.totalGenerations++;
    const { entropy, top, second } = this._stats(logits);
    const uncertainty = Math.min(entropy / Math.log(logits.length), 1.0);
    const margin = Math.max(0, logits[top] - logits[second]);
    const confidence = Math.max(0.05, Math.min(margin / 8.0, 1.0) * (1 - uncertainty * 0.6));

    let refined = logits;
    if (this.selfReflectionEnabled && uncertainty > this._uncThresh) {
      refined = new Float32Array(logits);
      this.romanDiffusion.applyUltra(refined, this.totalGenerations % 64, 0, null);
    }
    this.averageConfidence = Math.min(this.averageConfidence * 0.92 + confidence * 0.08, 0.98);
    return new AwareResponse(refined, confidence, uncertainty, entropy, top);
  }

  _stats(logits) {
    const len = logits.length;
    let mx = logits[0];
    for (let i = 1; i < len; i++) if (logits[i] > mx) mx = logits[i];
    let se = 0;
    for (let i = 0; i < len; i++) se += Math.exp(logits[i] - mx);
    let ent = 0, top = 0, tp = -Infinity, second = 1, sp = -Infinity;
    for (let i = 0; i < len; i++) {
      const p = Math.exp(logits[i] - mx) / se;
      if (p > 1e-10) ent -= p * Math.log(p);
      if (logits[i] > tp) { sp = tp; second = top; tp = logits[i]; top = i; }
      else if (logits[i] > sp) { sp = logits[i]; second = i; }
    }
    return { entropy: ent, top, second };
  }

  // ── Compat : génération textuelle consciente (legacy) ──
  generateWithAwareness(logits, prompt, maxTokens = 128) {
    const a = this.analyze(logits);
    let response = `Réponse consciente pour : ${prompt}`;
    if (this.selfReflectionEnabled && a.uncertainty > 0.75)
      response += `\n\n[Self-Reflection] Incertitude ${(a.uncertainty*100).toFixed(0)}%.`;
    return new AwareResponse(response, a.confidence, a.uncertainty, a.entropy, maxTokens);
  }

  getStats() { return [this.totalGenerations, this.averageConfidence]; }
  reset() { this.romanDiffusion.reset(); this.totalGenerations = 0; this.averageConfidence = 0.72; }
}
