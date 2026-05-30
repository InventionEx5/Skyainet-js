// packages/t369-inference/src/speculative.js
// =====================================================
// Speculative Decoding — Roman Speculative Inference
// Draft Model + Roman Dream Verification + KV Cache
// SkyAInet × Nikola T369
// =====================================================

import { T369Model } from './model.js';
import { KVCache } from './kv_cache.js';

export class SpeculativeConfig {
  constructor() {
    this.draftModelSize = 1024;
    this.maxSpeculativeTokens = 6;
    this.acceptanceThreshold = 0.72;
  }
}

export class SpeculativeDecoder {
  constructor(mainConfig, speculativeConfig = new SpeculativeConfig()) {
    const draftConfig = { ...mainConfig };
    draftConfig.hiddenSize = speculativeConfig.draftModelSize;
    draftConfig.numLayers = Math.floor(mainConfig.numLayers / 2);

    this.mainModel = new T369Model(mainConfig);
    this.draftModel = new T369Model(draftConfig);
    this.config = speculativeConfig;
    this.kvCache = null;
  }

  async speculativeGenerate(promptTokens, maxNewTokens) {
    this.mainModel.initKVCache();
    this.draftModel.initKVCache();

    const tokens = [...promptTokens];
    let generated = 0;

    console.info(`[Speculative] Démarrage | Max tokens: ${maxNewTokens}`);

    while (generated < maxNewTokens) {
      const draftTokens = await this.#draftProposeTokens(tokens);
      if (draftTokens.length === 0) break;

      const accepted = await this.#verifyTokens(tokens, draftTokens);

      for (const token of accepted) {
        tokens.push(token);
        generated++;

        if (token === 1 || generated >= maxNewTokens) break;
      }

      if (accepted.length < draftTokens.length) {
        console.debug('[Speculative] Rejet → régénération');
      }
    }

    console.info(`[Speculative] Terminé | Tokens générés: ${generated}`);
    return tokens;
  }

  async #draftProposeTokens(currentTokens) {
    const draftTokens = [];
    let tempTokens = [...currentTokens];

    for (let i = 0; i < this.config.maxSpeculativeTokens; i++) {
      const logits = await this.draftModel.forward(tempTokens);
      const nextToken = this.#argmax(logits);

      draftTokens.push(nextToken);
      tempTokens.push(nextToken);

      if (nextToken === 1) break;
    }

    console.debug(`[Speculative] Draft a proposé ${draftTokens.length} tokens`);
    return draftTokens;
  }

  async #verifyTokens(currentTokens, draftTokens) {
    const accepted = [];
    let tempTokens = [...currentTokens];

    for (const draftToken of draftTokens) {
      const logits = await this.mainModel.forward(tempTokens);
      const mainToken = this.#argmax(logits);

      const score = this.#romanAcceptanceScore(logits[mainToken], draftToken);

      if (score >= this.config.acceptanceThreshold) {
        accepted.push(draftToken);
        tempTokens.push(draftToken);
      } else {
        accepted.push(mainToken);
        tempTokens.push(mainToken);
        break;
      }
    }

    console.debug(`[Speculative] ${accepted.length} / ${draftTokens.length} tokens acceptés`);
    return accepted;
  }

  #argmax(logits) {
    let maxIdx = 0;
    let maxVal = logits[0];
    for (let i = 1; i < logits.length; i++) {
      if (logits[i] > maxVal) {
        maxVal = logits[i];
        maxIdx = i;
      }
    }
    return maxIdx;
  }

  #romanAcceptanceScore(mainLogit, draftToken) {
    return (Math.tanh(mainLogit) + 1.0) / 2.0;
  }

  setKVCacheEnabled(enabled) {
    if (enabled) {
      this.mainModel.initKVCache();
      this.draftModel.initKVCache();
    } else {
      this.mainModel.kvCache = null;
      this.draftModel.kvCache = null;
    }
  }
}