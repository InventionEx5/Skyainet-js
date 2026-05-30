// packages/t369-inference/src/inself.js
// =====================================================
// InSelf — Auto-amélioration sur logits (vectoriel)
// Score entropie-inversée, early-exit adaptatif
// Compat : selfImprove(text) conservé + refineLogits(vecteur)
// SkyAInet × Nikola T369
// =====================================================

"use strict";

import { RomanDiffusion } from './roman_diffusion.js';

export class ImprovedResponse {
  constructor(payload, qualityScore, improvementDelta, iterations, wisdomGained) {
    this.payload          = payload;   // texte OU logits selon la méthode
    this.text             = typeof payload === 'string' ? payload : null;
    this.logits           = typeof payload === 'string' ? null : payload;
    this.qualityScore     = qualityScore;
    this.improvementDelta = improvementDelta;
    this.iterations       = iterations;
    this.wisdomGained     = wisdomGained;
  }
}

export class InSelf {
  constructor() {
    this.romanDiffusion        = new RomanDiffusion();
    this.selfImprovementCycles = 0;
    this.cumulativeWisdom      = 0.58;
    this.reflectionDepth       = 3;
    this.evolutionRate         = 0.034;
    this.lastImprovement       = 0.0;
    this.isEvolving            = true;
    this._qualityTarget        = 0.88;
    this._minDelta             = 0.006;
  }

  // ── Raffinage sur logits (chemin rapide, utilisé par model.js) ──
  refineLogits(logits, maxIterations = 3) {
    this.selfImprovementCycles++;
    const work = new Float32Array(logits);
    let bestQ  = this._scoreLogits(work);
    let total  = 0, iters = 0;

    for (let i = 0; i < maxIterations; i++) {
      iters++;
      if (bestQ >= this._qualityTarget) break;
      this.romanDiffusion.applyUltra(work, i, Math.min(this.reflectionDepth, 8), null);

      // Sharpening adaptatif
      const temp = Math.max(0.1, 0.85 - i * 0.05);
      let mx = work[0];
      for (let j = 1; j < work.length; j++) if (work[j] > mx) mx = work[j];
      for (let j = 0; j < work.length; j++) work[j] = (work[j] - mx) / temp;

      const newQ = this._scoreLogits(work);
      const delta = Math.max(0, newQ - bestQ);
      total += delta; bestQ = newQ;
      this.cumulativeWisdom = Math.min(this.cumulativeWisdom * 0.96 + newQ * 0.04, 0.99);
      if (delta < this._minDelta && i > 1) break;
    }
    this.lastImprovement = iters ? total / iters : 0;
    this.evolutionRate   = Math.min(this.evolutionRate * 0.97 + this.lastImprovement * 0.03, 0.12);
    return new ImprovedResponse(work, bestQ, total, iters, this.lastImprovement);
  }

  _scoreLogits(logits) {
    const len = logits.length;
    let mx = logits[0];
    for (let i = 1; i < len; i++) if (logits[i] > mx) mx = logits[i];
    let se = 0;
    for (let i = 0; i < len; i++) se += Math.exp(logits[i] - mx);
    let ent = 0;
    for (let i = 0; i < len; i++) { const p = Math.exp(logits[i] - mx) / se; if (p > 1e-10) ent -= p * Math.log(p); }
    return Math.max(0, Math.min(0.99, 1 - ent / Math.log(len)));
  }

  // ── Compat : amélioration textuelle (chemin lent, legacy) ──
  selfImprove(prompt, initialResponse, maxIterations = 6) {
    this.selfImprovementCycles++;
    let current = initialResponse, bestQ = 0, total = 0, iters = 0;
    for (let i = 0; i < maxIterations; i++) {
      iters = i + 1;
      const q = this._evalText(current, prompt);
      if (q > 0.94) break;
      const refl = this._reflect(current, q);
      const nq = this._evalText(refl, prompt);
      const delta = Math.max(0, nq - q);
      total += delta; current = refl;
      if (nq > bestQ) bestQ = nq;
      this.cumulativeWisdom = Math.min(this.cumulativeWisdom * 0.96 + nq * 0.04, 0.99);
      if (delta < 0.008 && i > 2) break;
    }
    this.lastImprovement = iters ? total / iters : 0;
    return new ImprovedResponse(current, bestQ, total, iters, this.lastImprovement);
  }

  _reflect(response, q) {
    let r = response;
    if (q < 0.75) r += ' [Réflexion: cohérence logique]';
    if (q < 0.85 && this.reflectionDepth >= 2) r += ' [Réflexion: nuance et contexte]';
    if (q > 0.80 && this.reflectionDepth >= 3) r += ' [Réflexion créative romaine]';
    return r;
  }

  _evalText(response, prompt) {
    let s = 0.5;
    if (response.length > 40 && response.length < 800) s += 0.15;
    const pw = prompt.split(/\s+/);
    const m = pw.filter(w => response.includes(w)).length;
    s += (m / Math.max(pw.length, 1)) * 0.25;
    if (response.includes('Réflexion')) s += 0.12;
    if (response.length < 25) s -= 0.2;
    return Math.max(0.1, Math.min(0.98, s));
  }

  evolveSelf() {
    if (!this.isEvolving) return;
    this.reflectionDepth  = Math.min(this.reflectionDepth + 1, 8);
    this.evolutionRate    = Math.min(this.evolutionRate * 1.03, 0.15);
    this.cumulativeWisdom = Math.min(this.cumulativeWisdom * 0.985 + 0.015, 0.99);
    this._qualityTarget   = Math.min(this._qualityTarget + 0.002, 0.96);
    this._minDelta        = Math.max(this._minDelta * 0.98, 0.001);
  }

  getStats() {
    return [this.selfImprovementCycles, this.cumulativeWisdom, this.evolutionRate, this.reflectionDepth];
  }

  reset() {
    this.romanDiffusion.reset();
    this.selfImprovementCycles = 0;
    this.cumulativeWisdom = 0.58;
    this.lastImprovement = 0.0;
    this._qualityTarget = 0.88;
    this._minDelta = 0.006;
  }
}
