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

    // Chemin d'attention par défaut : CAUSAL cross-token + cache KV incrémental
    // (correct, déterministe, O(n)). Mettre à false pour l'ancien chemin _mhla.
    this.useCausalAttention = true;
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
    if (this.loraHead) {
      // Défaut causal : décodage incrémental (cache KV, O(n)), prouvé identique
      // au recalcul plein. Sinon, ancien chemin déterministe plein.
      return this.useCausalAttention
        ? this.generateIncremental(promptTokens, maxNewTokens)
        : this.generateLearned(promptTokens, maxNewTokens);
    }

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
    // Projections d'attention Q/K/V/O : seed distinct par couche (brise la
    // symétrie inter-couches), déterministe à partir du seed du modèle.
    for (let li = 0; li < this.layers.length; li++)
      this.layers[li].attention.initProjections((seed + 1 + li * 1013) >>> 0);
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
    // Défaut : chemin causal cross-token (mêmes représentations que le décodage
    // incrémental → tête entraînée et inférence cohérentes).
    if (this.useCausalAttention) return this.encodeCausalFull(tokens).slice();
    const { hiddenSize: H, vocabSize: V } = this.config;
    const seqLen = tokens.length;
    let emb;
    if (this._embF32 && this._embF32.length === V * H) emb = this._embF32;
    else { if (this._embBuf.length !== V * H) this._embBuf = new Float32Array(V * H); this.embedding.dequantizeInto(this._embBuf); emb = this._embBuf; }
    const hidden = new Float32Array(seqLen * H);
    for (let i = 0; i < seqLen; i++) hidden.set(emb.subarray(tokens[i] * H, tokens[i] * H + H), i * H);

    // Passe d'encodage en une fois (cache null = attention pleine-séquence,
    // pas de décodage incrémental). On GÈLE la phase de diffusion de chaque
    // couche (roman_diffusion.js : this.phase += 0.009 à chaque appel, utilisée
    // par le mode _hybrid) afin que l'encodage soit une fonction PURE des tokens
    // -> inférence DÉTERMINISTE (sinon la tête LoRA voit un caché qui dérive).
    const savedPhase = this.layers.map(l => l.romanDiffusion ? l.romanDiffusion.phase : null);
    for (let li = 0; li < this.layers.length; li++) this.layers[li].forward(hidden, seqLen, li, null);
    for (let li = 0; li < this.layers.length; li++) if (savedPhase[li] !== null) this.layers[li].romanDiffusion.phase = savedPhase[li];

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

  // ════════════════════════════════════════════════════════════════
  //  DÉCODAGE INCRÉMENTAL CORRECT — vraie attention causale + cache KV
  //  Le modèle est désormais CAUSAL (diffusion causale, MoE par token,
  //  attention causale cross-token) → la représentation d'un token ne change
  //  plus quand on en ajoute après. On peut donc préremplir le KV du prompt
  //  UNE fois, puis n'encoder qu'UN token par pas (O(n) au lieu de O(n²)),
  //  avec un résultat IDENTIQUE au recalcul pleine-séquence.
  // ════════════════════════════════════════════════════════════════

  _rms(vec, weights, out) {
    const H = vec.length; let ss = 0;
    for (let i = 0; i < H; i++) ss += vec[i] * vec[i];
    const inv = 1 / Math.sqrt(ss / H + 1e-6);
    for (let i = 0; i < H; i++) out[i] = vec[i] * inv * weights[i];
    return out;
  }

  // Une couche, version causale : pre-norm + attention causale (cache) + résidu,
  // puis MoE PAR TOKEN (tous les tokens, pas seulement le dernier) + résidu,
  // puis diffusion causale. `dec` = KVCache (slot numKvHeads·headDim).
  _layerForwardCausal(L, hidden, seqLen, layerIdx, dec, basePos) {
    const H = this.config.hiddenSize, total = H * seqLen;

    const normedFull = new Float32Array(total);
    const tmp = new Float32Array(H);
    for (let t = 0; t < seqLen; t++) {
      this._rms(hidden.subarray(t * H, t * H + H), L.norm1, tmp);
      normedFull.set(tmp, t * H);
    }

    const attn = L.attention.causalSelfAttention(normedFull, seqLen, layerIdx, dec, basePos);
    for (let i = 0; i < total; i++) hidden[i] += attn[i];

    const n2 = new Float32Array(H);
    for (let t = 0; t < seqLen; t++) {
      const off = t * H;
      this._rms(hidden.subarray(off, off + H), L.norm2, n2);
      const moeOut = L.moeLayer.forward(n2, {});
      for (let i = 0; i < H; i++) hidden[off + i] += moeOut[i];
    }

    L.romanDiffusion.applyUltra(hidden, seqLen, layerIdx, basePos, H);
  }

  // Encode `tokens` (placés à partir de basePos) à travers toutes les couches
  // via le chemin causal + cache. Renvoie le caché [seqLen×H] (normé final).
  _encodeCausal(tokens, dec, basePos) {
    const { hiddenSize: H, vocabSize: V } = this.config;
    const seqLen = tokens.length;
    let emb;
    if (this._embF32 && this._embF32.length === V * H) emb = this._embF32;
    else { if (this._embBuf.length !== V * H) this._embBuf = new Float32Array(V * H); this.embedding.dequantizeInto(this._embBuf); emb = this._embBuf; }
    const hidden = new Float32Array(seqLen * H);
    for (let i = 0; i < seqLen; i++) hidden.set(emb.subarray(tokens[i] * H, tokens[i] * H + H), i * H);

    for (let li = 0; li < this.layers.length; li++)
      this._layerForwardCausal(this.layers[li], hidden, seqLen, li, dec, basePos);

    const tmp = new Float32Array(H);
    for (let t = 0; t < seqLen; t++) { this._rms(hidden.subarray(t * H, t * H + H), this.finalNorm, tmp); hidden.set(tmp, t * H); }
    return hidden;
  }

  // Logits depuis un caché de dernier token : LM head (gelé) + delta LoRA.
  _logitsAt(hVec) {
    const { hiddenSize: H, vocabSize: V } = this.config;
    if (this._lmBuf.length !== H * V) this._lmBuf = new Float32Array(H * V);
    this.lmHead.dequantizeInto(this._lmBuf);
    const logits = new Float32Array(V);
    for (let i = 0; i < H; i++) { const hi = hVec[i]; if (hi === 0) continue; const row = i * V; for (let j = 0; j < V; j++) logits[j] += hi * this._lmBuf[row + j]; }
    if (this.loraHead) { const dlt = this.loraHead.forward(hVec); for (let j = 0; j < V; j++) logits[j] += dlt[j]; }
    return logits;
  }

  // Recalcul pleine-séquence (cache neuf) — RÉFÉRENCE pour valider l'incrémental.
  encodeCausalFull(tokens) {
    const { numLayers, numKvHeads, headDim, maxSeqLen } = this.config;
    const dec = new KVCache(numLayers, numKvHeads, headDim, maxSeqLen);
    const hidden = this._encodeCausal(tokens, dec, 0);
    const H = this.config.hiddenSize;
    return hidden.subarray((tokens.length - 1) * H, tokens.length * H);
  }
  logitsFull(tokens) { return this._logitsAt(this.encodeCausalFull(tokens)); }

  // Génération incrémentale : préremplit le prompt puis encode 1 token/pas.
  // opts.collect = true -> renvoie aussi les logits par pas (pour validation).
  generateIncremental(promptTokens, maxNewTokens, opts = {}) {
    const { numLayers, numKvHeads, headDim, maxSeqLen, hiddenSize: H } = this.config;
    const dec = new KVCache(numLayers, numKvHeads, headDim, maxSeqLen);
    const tokens = [...promptTokens];
    const steps = [];

    // Préremplissage du prompt (positions 0..P-1) en une passe
    let hidden = this._encodeCausal(tokens, dec, 0);
    let logits = this._logitsAt(hidden.subarray((tokens.length - 1) * H, tokens.length * H));
    if (opts.collect) steps.push(logits.slice());
    tokens.push(this._argmax(logits));

    // Décodage : un seul token par pas, à sa position absolue
    for (let s = 1; s < maxNewTokens; s++) {
      const basePos = tokens.length - 1;
      const h1 = this._encodeCausal([tokens[basePos]], dec, basePos);
      logits = this._logitsAt(h1.subarray(0, H));
      if (opts.collect) steps.push(logits.slice());
      tokens.push(this._argmax(logits));
    }
    return opts.collect ? { tokens, steps } : tokens;
  }

  // ── Persistance binaire réelle (v2) ──
  // 'T369' | u32 version | u32 V | u32 H | u32 numLayers | i32 seed |
  //   u32 loraLen | [lora] | f32arr finalNorm |
  //   QT embedding | QT lmHead |
  //   par couche : f32arr norm1 | f32arr norm2 | u32 numExperts |
  //                {QT up,gate,down}×experts | f32arr routerRow ×experts
  // (f32arr = u32 longueur + floats ; QT = u32 longueur + QuantizedTensor.serialize)
  async saveWeights(path) {
    const fs = await import('node:fs');
    const { vocabSize: V, hiddenSize: H, numLayers } = this.config;

    const chunks = [];
    const u32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); chunks.push(b); };
    const i32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, n | 0, true); chunks.push(b); };
    const raw = (u8) => chunks.push(u8);
    const f32arr = (arr) => { const b = new Uint8Array(4 + arr.length * 4); const d = new DataView(b.buffer); d.setUint32(0, arr.length, true); for (let i = 0; i < arr.length; i++) d.setFloat32(4 + i * 4, arr[i], true); chunks.push(b); };
    const qt = (t) => { const s = t.serialize(); u32(s.byteLength); raw(s); };

    raw(new Uint8Array([0x54, 0x33, 0x36, 0x39]));   // 'T369'
    u32(3); u32(V); u32(H); u32(numLayers); i32(this._seed);

    const loraBytes = this.loraHead ? this.loraHead.serialize() : new Uint8Array(0);
    u32(loraBytes.byteLength); raw(loraBytes);
    f32arr(this.finalNorm);

    qt(this.embedding);
    qt(this.lmHead);
    for (let li = 0; li < numLayers; li++) {
      const L = this.layers[li];
      f32arr(L.norm1); f32arr(L.norm2);
      const A = L.attention;                                    // projections Q/K/V/O (v3)
      f32arr(A.wQ); f32arr(A.wK); f32arr(A.wV); f32arr(A.wO);
      const ex = L.moeLayer.experts;
      u32(ex.length);
      for (let e = 0; e < ex.length; e++) { qt(ex[e].up); qt(ex[e].gate); qt(ex[e].down); }
      for (let e = 0; e < ex.length; e++) f32arr(L.moeLayer.routerRows[e]);
    }

    let total = 0; for (const c of chunks) total += c.byteLength;
    const out = new Uint8Array(total); let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.byteLength; }
    fs.writeFileSync(path, Buffer.from(out.buffer, out.byteOffset, out.byteLength));
    return total;
  }

  async loadWeights(path) {
    const fs = await import('node:fs');
    const rawBuf = fs.readFileSync(path);
    const buf = rawBuf.buffer.slice(rawBuf.byteOffset, rawBuf.byteOffset + rawBuf.byteLength);
    const dv = new DataView(buf), u8 = new Uint8Array(buf);
    if (!(u8[0] === 0x54 && u8[1] === 0x33 && u8[2] === 0x36 && u8[3] === 0x39))
      throw new Error('[T369Model] format de poids invalide (magic)');
    let o = 4;
    const rdU32 = () => { const v = dv.getUint32(o, true); o += 4; return v; };
    const rdI32 = () => { const v = dv.getInt32(o, true); o += 4; return v; };
    const rdF32 = (n) => { const a = new Float32Array(n); for (let i = 0; i < n; i++) { a[i] = dv.getFloat32(o, true); o += 4; } return a; };
    const rdF32len = () => rdF32(rdU32());
    const rdQT = () => { const len = rdU32(); const t = QuantizedTensor.deserialize(new Uint8Array(buf, o, len)); o += len; return t; };

    const version = rdU32();
    const V = rdU32(), H = rdU32(), numLayers = rdU32();
    const seed = rdI32();

    if (version === 1) {
      // Ancien format : finalNorm (brut, sans préfixe) puis lora.
      const loraLen = rdU32();
      this.finalNorm = rdF32(H);
      if (loraLen > 0) this.loraHead = LoraAdapter.deserialize(new Uint8Array(buf, o, loraLen));
      this.initEmbeddings(seed);
      console.info(`[T369Model] Poids chargés : V=${V} H=${H} L=${numLayers} seed=${seed} lora=${loraLen}o (v1)`);
      return this;
    }

    // v2 : lora + finalNorm + poids de base complets
    const loraLen = rdU32();
    if (loraLen > 0) { this.loraHead = LoraAdapter.deserialize(new Uint8Array(buf, o, loraLen)); o += loraLen; }
    this.finalNorm = rdF32len();
    this.initEmbeddings(seed);                 // restaure l'override _embF32 seedé

    this.embedding = rdQT();
    this.lmHead = rdQT();
    for (let li = 0; li < numLayers; li++) {
      const L = this.layers[li];
      L.norm1.set(rdF32len()); L.norm2.set(rdF32len());
      if (version >= 3) {                                       // projections Q/K/V/O
        const A = L.attention;
        A.wQ.set(rdF32len()); A.wK.set(rdF32len()); A.wV.set(rdF32len()); A.wO.set(rdF32len());
      }
      const ne = rdU32();
      for (let e = 0; e < ne; e++) { L.moeLayer.experts[e].up = rdQT(); L.moeLayer.experts[e].gate = rdQT(); L.moeLayer.experts[e].down = rdQT(); }
      for (let e = 0; e < ne; e++) L.moeLayer.routerRows[e].set(rdF32len());
    }
    console.info(`[T369Model] Poids chargés : V=${V} H=${H} L=${numLayers} seed=${seed} lora=${loraLen}o, base quantifiée complète (v${version})`);
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