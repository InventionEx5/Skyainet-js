// packages/t369-inference/src/t369.js
// =====================================================
// T369Model — Embedding quantifié + TransformerBlocks + LM Head
// Buffers pré-alloués, GEMV sparse-skip, modules cognitifs intégrés
// SkyAInet × Nikola T369
// =====================================================

"use strict";

import { QuantizedTensor }  from './quant.js';
import { TransformerBlock } from './transformer_block.js';
import { KVCache }          from './kv_cache.js';
import { RomanDiffusion }   from './roman_diffusion.js';
import { CollectivIn }      from './collectivin.js';
import { InSelf }           from './inself.js';
import { InAware }          from './inaware.js';
import { InDream }          from './indream.js';
import { MeshIn }           from './meshin.js';

export class ModelConfig {
  constructor() {
    this.vocabSize        = 32000;
    this.hiddenSize       = 2048;
    this.numLayers        = 24;
    this.numQueryHeads    = 16;
    this.numKvHeads       = 4;
    this.headDim          = 128;
    this.maxSeqLen        = 32768;
    this.ropeScaling      = 1.0;
    this.bits             = 4;
    this.useMoe           = true;
    this.numExperts       = 8;
    this.topK             = 2;
    this.intermediateSize = 8192;
  }
}

// Réexport compat
export { TransformerBlock };

export class T369Model {
  constructor(config = new ModelConfig()) {
    this.config = config;
    const { vocabSize, hiddenSize, numLayers, numQueryHeads, numKvHeads, headDim, bits } = config;

    this.embedding = new QuantizedTensor(vocabSize, hiddenSize, bits);

    const moeConfig = {
      numExperts: config.numExperts, topK: config.topK, hiddenSize,
      intermediateSize: config.intermediateSize ?? hiddenSize * 4, bits,
    };
    this.layers = [];
    for (let i = 0; i < numLayers; i++)
      this.layers.push(new TransformerBlock(hiddenSize, numQueryHeads, numKvHeads, headDim, moeConfig));

    this.finalNorm = new Float32Array(hiddenSize).fill(1.0);
    this.lmHead    = new QuantizedTensor(hiddenSize, vocabSize, bits);
    this.kvCache   = null;
    this.tokenizer = null;

    this.romanDiffusion = new RomanDiffusion();
    this.collectivIn    = new CollectivIn();
    this.inSelf         = new InSelf();
    this.inAware        = new InAware();
    this.inDream        = new InDream();
    this.meshIn         = new MeshIn();

    this._logitBuf = new Float32Array(vocabSize);
    this._embBuf   = new Float32Array(vocabSize * hiddenSize);
    this._lmBuf    = new Float32Array(hiddenSize * vocabSize);
  }

  initKVCache() {
    if (!this.kvCache) {
      const { numLayers, numKvHeads, headDim, maxSeqLen } = this.config;
      this.kvCache = new KVCache(numLayers, numKvHeads, headDim, maxSeqLen);
    }
  }
  clearKVCache() { this.kvCache?.clear(); }

  applyRMSNorm(x, weights = null) {
    const len = x.length, eps = 1e-6;
    let ss = 0;
    for (let i = 0; i < len; i++) ss += x[i] * x[i];
    const inv = 1.0 / Math.sqrt(ss / len + eps);
    if (weights) for (let i = 0; i < len; i++) x[i] = x[i] * inv * weights[i];
    else for (let i = 0; i < len; i++) x[i] *= inv;
  }

  forward(tokens) {
    const { hiddenSize: H, vocabSize: V, numLayers } = this.config;
    const seqLen = tokens.length;
    if (seqLen === 0) throw new Error('[T369Model] Séquence vide');

    // 1. Embedding (dequant in-place)
    if (this._embBuf.length !== V * H) this._embBuf = new Float32Array(V * H);
    this.embedding.dequantizeInto(this._embBuf);
    const hidden = new Float32Array(seqLen * H);
    for (let i = 0; i < seqLen; i++) {
      const src = tokens[i] * H;
      hidden.set(this._embBuf.subarray(src, src + H), i * H);
    }

    // 2. Layers + CollectivIn périodique
    for (let li = 0; li < this.layers.length; li++) {
      this.layers[li].forward(hidden, seqLen, li, this.kvCache);
      if (li % 3 === 0) this.collectivIn.collectiveReason(hidden, seqLen, li);
    }

    // 3. Norme finale + InDream
    this.applyRMSNorm(hidden, this.finalNorm);
    this.inDream.dreamForward(hidden, seqLen, numLayers);

    // 4. LM Head (GEMV sur dernier token, skip des zéros)
    if (this._lmBuf.length !== H * V) this._lmBuf = new Float32Array(H * V);
    this.lmHead.dequantizeInto(this._lmBuf);
    const logits = this._logitBuf; logits.fill(0);
    const lastOff = (seqLen - 1) * H;
    for (let i = 0; i < H; i++) {
      const hi = hidden[lastOff + i];
      if (hi === 0) continue;
      const row = i * V;
      for (let j = 0; j < V; j++) logits[j] += hi * this._lmBuf[row + j];
    }

    // 5. InSelf raffine, InAware analyse
    const refined = this.inSelf.refineLogits(logits, 3);
    const aware   = this.inAware.analyze(refined.logits);

    // 6. MeshIn Hebbian léger
    this.meshIn.learn([tokens[seqLen - 1] % 64], 0.04);

    return aware.logits;
  }

  generate(promptTokens, maxNewTokens) {
    this.initKVCache();
    const tokens = [...promptTokens];
    for (let i = 0; i < maxNewTokens; i++) {
      const logits = this.forward(tokens);
      const nt = this._argmax(logits);
      tokens.push(nt);
      if (nt === 1) break;
    }
    if (this.inSelf.isEvolving) this.inSelf.evolveSelf();
    return tokens;
  }

  _argmax(arr) {
    let mi = 0, mv = arr[0];
    for (let i = 1; i < arr.length; i++) if (arr[i] > mv) { mv = arr[i]; mi = i; }
    return mi;
  }

  setTokenizer(t) { this.tokenizer = t; }
  async loadWeights(path) { console.info(`[T369Model] Chargement poids : ${path}`); }

  getStats() {
    return {
      layers: this.layers.length,
      kvCacheLen: this.kvCache?.len() ?? 0,
      inSelf: this.inSelf.getStats(),
      inAware: this.inAware.getStats(),
      meshIn: this.meshIn.getStats(),
      collectivIn: this.collectivIn.getStats(),
    };
  }
}
