// packages/t369-inference/src/speculative.js
// =====================================================
// SpeculativeDecoder — Draft + Verify + Roman Acceptance
// Acceptation par rapport de vraisemblance lissé tanh
// SkyAInet × Nikola T369
// =====================================================

"use strict";

import { T369Model } from './model.js';

export class SpeculativeConfig {
  constructor() {
    this.draftModelSize       = 1024;
    this.maxSpeculativeTokens = 6;
    this.acceptanceThreshold  = 0.72;
    this.draftLayerRatio      = 0.5;
  }
}

export class SpeculativeDecoder {
  constructor(mainConfig, specConfig = new SpeculativeConfig()) {
    this.config = specConfig;

    this.mainModel = new T369Model(mainConfig);

    const draftConfig = Object.assign({}, mainConfig, {
      hiddenSize: specConfig.draftModelSize,
      numLayers : Math.max(2, Math.floor(mainConfig.numLayers * specConfig.draftLayerRatio)),
    });
    this.draftModel = new T369Model(draftConfig);

    this.mainModel.initKVCache();
    this.draftModel.initKVCache();

    this._proposed = 0;
    this._accepted = 0;
  }

  async speculativeGenerate(promptTokens, maxNewTokens) {
    const tokens = [...promptTokens];
    let generated = 0;

    while (generated < maxNewTokens) {
      const draft = await this._propose(tokens);
      if (draft.length === 0) break;
      const accepted = await this._verify(tokens, draft);

      for (const tok of accepted) {
        tokens.push(tok); generated++;
        if (tok === 1 || generated >= maxNewTokens) break;
      }
      this._proposed += draft.length;
      this._accepted += accepted.length;
      if (generated >= maxNewTokens) break;
    }
    return tokens;
  }

  async _propose(current) {
    const γ = this.config.maxSpeculativeTokens;
    const draft = [], tmp = [...current];
    for (let i = 0; i < γ; i++) {
      const logits = this.draftModel.forward(tmp);
      const nt = this._argmax(logits);
      draft.push(nt); tmp.push(nt);
      if (nt === 1) break;
    }
    return draft;
  }

  async _verify(current, draftTokens) {
    const τ = this.config.acceptanceThreshold;
    const accepted = [], tmp = [...current];
    for (const dt of draftTokens) {
      const logits = this.mainModel.forward(tmp);
      const best = this._argmax(logits);
      const score = this._accept(logits, dt, best);
      if (score >= τ) { accepted.push(dt); tmp.push(dt); }
      else { accepted.push(best); break; }
    }
    return accepted;
  }

  _accept(logits, draftTok, best) {
    const m = Math.max(logits[best], logits[draftTok]);
    const pD = Math.exp(logits[draftTok] - m);
    const pB = Math.exp(logits[best] - m);
    const ratio = pD / (pB + 1e-9);
    return (Math.tanh(ratio * 2) + 1) / 2;
  }

  _argmax(a) {
    let mi = 0, mv = a[0];
    for (let i = 1; i < a.length; i++) if (a[i] > mv) { mv = a[i]; mi = i; }
    return mi;
  }

  setKVCacheEnabled(enabled) {
    if (enabled) { this.mainModel.initKVCache(); this.draftModel.initKVCache(); }
    else { this.mainModel.kvCache = null; this.draftModel.kvCache = null; }
  }

  acceptanceRate() { return this._proposed ? this._accepted / this._proposed : 0; }
  getStats() { return { proposed: this._proposed, accepted: this._accepted, rate: this.acceptanceRate() }; }
}
