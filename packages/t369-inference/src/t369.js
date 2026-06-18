// packages/t369-inference/src/t369.js
// =====================================================
// T369Model — Embedding quantifié + TransformerBlocks + LM Head
// Buffers pré-alloués, GEMV sparse-skip, modules cognitifs intégrés
// SkyAInet × Nikola T369
// =====================================================

"use strict";

import { QuantizedTensor }  from '#quant';
import { TransformerBlock } from '#transformer_block';
import { KVCache }          from '#kv_cache';
import { RomanDiffusion }   from '#roman_diffusion';
import { CollectivIn }      from '#collectivin';
import { InSelf }           from '#inself';
import { InAware }          from '#inaware';
import { InDream }          from '#indream';
import { MeshIn }           from '#meshin';
import { LoraAdapter }      from '#lora_trainer';

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

    // ── Poids vivants : embeddings F32 réels (seedés) + tête LoRA entraînable ──
    this._embF32  = null;   // override embedding Float32 déterministe (via seed)
    this._seed    = 0;
    this.loraHead = null;   // adaptateur LoRA entraîné, injecté dans les logits
  }

  initKVCache() {
    if (!this.kvCache) {
      // L'attention met en cache la largeur complète (numQueryHeads·headDim = H),
      // pas numKvHeads -> le slot du cache doit suivre, sinon getLayer() est mal dimensionné.
      const { numLayers, numQueryHeads, headDim, maxSeqLen } = this.config;
      this.kvCache = new KVCache(numLayers, numQueryHeads, headDim, maxSeqLen);
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

    // 1. Embedding (override F32 seedé si présent, sinon dequant du tenseur quantifié)
    let emb;
    if (this._embF32 && this._embF32.length === V * H) {
      emb = this._embF32;
    } else {
      if (this._embBuf.length !== V * H) this._embBuf = new Float32Array(V * H);
      this.embedding.dequantizeInto(this._embBuf);
      emb = this._embBuf;
    }
    const hidden = new Float32Array(seqLen * H);
    for (let i = 0; i < seqLen; i++) {
      const src = tokens[i] * H;
      hidden.set(emb.subarray(src, src + H), i * H);
    }

    // 2. Layers + CollectivIn périodique
    for (let li = 0; li < this.layers.length; li++) {
      this.layers[li].forward(hidden, seqLen, li, this.kvCache);
      if (li % 3 === 0) this.collectivIn.collectiveReason(hidden, seqLen, li);
    }

    // 3. Norme finale (RMSNorm PAR TOKEN — corrige un NaN sur seqLen>1) + InDream
    const lastOff = (seqLen - 1) * H;
    for (let t = 0; t < seqLen; t++) {
      const off = t * H;
      let ss = 0;
      for (let i = 0; i < H; i++) ss += hidden[off + i] * hidden[off + i];
      const inv = 1.0 / Math.sqrt(ss / H + 1e-6);
      for (let i = 0; i < H; i++) hidden[off + i] = hidden[off + i] * inv * this.finalNorm[i];
    }
    this.inDream.dreamForward(hidden, seqLen, numLayers);

    // 4. LM Head (GEMV sur dernier token, skip des zéros)
    if (this._lmBuf.length !== H * V) this._lmBuf = new Float32Array(H * V);
    this.lmHead.dequantizeInto(this._lmBuf);
    const logits = this._logitBuf; logits.fill(0);
    for (let i = 0; i < H; i++) {
      const hi = hidden[lastOff + i];
      if (hi === 0) continue;
      const row = i * V;
      for (let j = 0; j < V; j++) logits[j] += hi * this._lmBuf[row + j];
    }

    // 4b. Injection de la tête LoRA entraînée (poids vivants) sur le dernier caché
    if (this.loraHead) {
      const hl = hidden.subarray(lastOff, lastOff + H);
      const delta = this.loraHead.forward(hl);
      for (let j = 0; j < V; j++) logits[j] += delta[j];
    }

    // 5. InSelf raffine, InAware analyse
    const refined = this.inSelf.refineLogits(logits, 3);
    const aware   = this.inAware.analyze(refined.logits);

    // 6. MeshIn Hebbian léger
    this.meshIn.learn([tokens[seqLen - 1] % 64], 0.04);

    return aware.logits;
  }

  generate(promptTokens, maxNewTokens) {
    // Tête LoRA entraînée présente -> inférence DÉTERMINISTE via encodeur + tête
    // (chemin sur lequel la tête a appris). La surcouche cognitive est volontairement
    // stochastique (état évolutif) -> inadaptée à une tête déterministe : on la
    // contourne pour l'inférence apprise, on la garde pour la génération exploratoire.
    if (this.loraHead) return this.generateLearned(promptTokens, maxNewTokens);

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

  // ════════════════════════════════════════════════════════════════
  //  POIDS VIVANTS — embeddings seedés, tête LoRA, train, génération
  // ════════════════════════════════════════════════════════════════

  // RNG déterministe (mulberry32) — base reproductible depuis une graine.
  static _mulberry32(s) {
    return function () {
      s |= 0; s = s + 0x6D2B79F5 | 0;
      let t = Math.imul(s ^ s >>> 15, 1 | s);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  // Initialise une table d'embedding F32 réelle et déterministe (σ = 1/√H).
  initEmbeddings(seed = 1337) {
    const { vocabSize: V, hiddenSize: H } = this.config;
    const rnd = T369Model._mulberry32(seed);
    const sigma = 1 / Math.sqrt(H);
    const e = new Float32Array(V * H);
    for (let i = 0; i < e.length; i++) e[i] = (rnd() * 2 - 1) * sigma;
    this._embF32 = e; this._seed = seed;
    return this;
  }

  // Attache une tête LoRA entraînable (Adam) au-dessus de la base gelée.
  attachHead(opts = {}) {
    const { hiddenSize: H, vocabSize: V } = this.config;
    this.loraHead = new LoraAdapter(H, V, {
      rank: opts.rank ?? 16, lr: opts.lr ?? 1e-2,
      alpha: opts.alpha ?? 16, weightDecay: opts.weightDecay ?? 1e-6,
    });
    return this.loraHead;
  }

  // Chemin transformeur PROPRE : embedding → blocs (résiduels) → RMSNorm final
  // par token. Retourne le caché du dernier token (déterministe, sans surcouche
  // cognitive) — c'est le vecteur sur lequel la tête LoRA s'entraîne et infère.
  _encodeHidden(tokens) {
    const { hiddenSize: H, vocabSize: V } = this.config;
    const seqLen = tokens.length;
    let emb;
    if (this._embF32 && this._embF32.length === V * H) emb = this._embF32;
    else { if (this._embBuf.length !== V * H) this._embBuf = new Float32Array(V * H); this.embedding.dequantizeInto(this._embBuf); emb = this._embBuf; }
    const hidden = new Float32Array(seqLen * H);
    for (let i = 0; i < seqLen; i++) hidden.set(emb.subarray(tokens[i] * H, tokens[i] * H + H), i * H);

    // Passe d'encodage en une fois : pas de cache incrémental (le KV-cache
    // renvoie des buffers non initialisés -> NaN ; cf. bug diagnostiqué).
    for (let li = 0; li < this.layers.length; li++) this.layers[li].forward(hidden, seqLen, li, null);

    const lastOff = (seqLen - 1) * H;
    const hl = hidden.slice(lastOff, lastOff + H);
    let ss = 0; for (let i = 0; i < H; i++) ss += hl[i] * hl[i];
    const inv = 1 / Math.sqrt(ss / H + 1e-6);
    for (let i = 0; i < H; i++) hl[i] = hl[i] * inv * this.finalNorm[i];
    return hl;
  }

  // Logits "tête" = LM head gelé (ici nul, poids non chargés) + delta LoRA.
  headLogits(tokens) {
    const { vocabSize: V } = this.config;
    const hl = this._encodeHidden(tokens);
    const logits = new Float32Array(V);
    if (this.loraHead) { const d = this.loraHead.forward(hl); for (let j = 0; j < V; j++) logits[j] += d[j]; }
    return { logits, hLast: hl };
  }

  // Un pas d'entraînement de la tête sur (prompt → token cible). Renvoie la loss.
  trainHead(tokens, target) {
    if (!this.loraHead) this.attachHead();
    const { vocabSize: V } = this.config;
    const hl = this._encodeHidden(tokens);
    const base = new Float32Array(V);            // base gelée nulle
    return this.loraHead.trainStep(hl, base, target);
  }

  // Génération via le chemin propre + tête entraînée (produit les tokens APPRIS).
  generateLearned(promptTokens, maxNewTokens) {
    const tokens = [...promptTokens];
    for (let i = 0; i < maxNewTokens; i++) tokens.push(this._argmax(this.headLogits(tokens).logits));
    return tokens;
  }

  // ── Persistance binaire réelle ──
  // Format : 'T369' | u32 version | u32 V | u32 H | u32 numLayers | i32 seed |
  //          u32 loraLen | finalNorm(H×f32) | loraAdapter.serialize()
  async saveWeights(path) {
    const fs = await import('node:fs');
    const { vocabSize: V, hiddenSize: H, numLayers } = this.config;
    const loraBytes = this.loraHead ? this.loraHead.serialize() : new Uint8Array(0);
    const normBytes = new Uint8Array(this.finalNorm.buffer.slice(0));
    const headerLen = 4 + 4 * 6;
    const total = headerLen + normBytes.byteLength + loraBytes.byteLength;
    const buf = new ArrayBuffer(total);
    const dv = new DataView(buf), u8 = new Uint8Array(buf);
    u8[0] = 0x54; u8[1] = 0x33; u8[2] = 0x36; u8[3] = 0x39;   // 'T369'
    let o = 4;
    dv.setUint32(o, 1, true); o += 4;
    dv.setUint32(o, V, true); o += 4;
    dv.setUint32(o, H, true); o += 4;
    dv.setUint32(o, numLayers, true); o += 4;
    dv.setInt32(o, this._seed, true); o += 4;
    dv.setUint32(o, loraBytes.byteLength, true); o += 4;
    u8.set(normBytes, o); o += normBytes.byteLength;
    u8.set(loraBytes, o);
    fs.writeFileSync(path, Buffer.from(buf));
    return total;
  }

  async loadWeights(path) {
    const fs = await import('node:fs');
    const raw = fs.readFileSync(path);
    const buf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
    const dv = new DataView(buf), u8 = new Uint8Array(buf);
    if (!(u8[0] === 0x54 && u8[1] === 0x33 && u8[2] === 0x36 && u8[3] === 0x39))
      throw new Error('[T369Model] format de poids invalide (magic)');
    let o = 4;
    const version = dv.getUint32(o, true); o += 4;
    const V = dv.getUint32(o, true); o += 4;
    const H = dv.getUint32(o, true); o += 4;
    const numLayers = dv.getUint32(o, true); o += 4;
    const seed = dv.getInt32(o, true); o += 4;
    const loraLen = dv.getUint32(o, true); o += 4;
    this.finalNorm = new Float32Array(buf.slice(o, o + H * 4)); o += H * 4;
    this.initEmbeddings(seed);
    if (loraLen > 0) { this.loraHead = LoraAdapter.deserialize(new Uint8Array(buf, o, loraLen)); }
    console.info(`[T369Model] Poids chargés : V=${V} H=${H} L=${numLayers} seed=${seed} lora=${loraLen}o (v${version})`);
    return this;
  }

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
