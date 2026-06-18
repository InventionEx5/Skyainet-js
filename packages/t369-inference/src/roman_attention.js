// packages/t369-inference/src/roman_attention.js
// =====================================================
// RomanAttention — GQA + RoPE + MHLA + softmax-attention
// RoPE plat, KV-cache intégré, buffers poolés, scale 1/sqrt(d)
// SkyAInet × Nikola T369
// =====================================================

"use strict";

import { bufferPool } from '#quant';

export class RomanAttentionConfig {
  constructor() {
    this.numQueryHeads    = 16;
    this.numKvHeads       = 4;
    this.headDim          = 128;
    this.latentDim        = 32;
    this.diffusionStrength= 0.38;
    this.maxSeqLen        = 32768;
    this.ropeBase         = 10000.0;
    this.ropeScaling      = 1.0;
    this.useFlash         = true;
    this.useMhla          = true;
  }
}

export class RomanAttention {
  constructor(config = new RomanAttentionConfig()) {
    this.config = config;
    const { headDim, latentDim, maxSeqLen, ropeBase, ropeScaling } = config;

    // RoPE plat : [pos * headDim + d]
    this._cos = new Float32Array(maxSeqLen * headDim);
    this._sin = new Float32Array(maxSeqLen * headDim);
    const half = headDim >> 1;
    for (let pos = 0; pos < maxSeqLen; pos++) {
      const base = pos * headDim;
      for (let i = 0; i < half; i++) {
        const freq = pos / (Math.pow(ropeBase, (2 * i) / headDim) * ropeScaling);
        const c = Math.cos(freq), s = Math.sin(freq);
        this._cos[base + 2*i] = c; this._cos[base + 2*i+1] = c;
        this._sin[base + 2*i] = s; this._sin[base + 2*i+1] = s;
      }
    }

    // Projections latentes MHLA
    const lk = headDim * latentDim;
    this.latentKeyProj   = new Float32Array(lk);
    this.latentValueProj = new Float32Array(lk);
    for (let i = 0; i < lk; i++) {
      this.latentKeyProj[i]   = Math.sin(i * 0.013) * 0.1;
      this.latentValueProj[i] = Math.cos(i * 0.017) * 0.1;
    }

    this._scale = 1.0 / Math.sqrt(headDim);
  }

  forward(query, key, value, seqLen, kvCache = null, layerIdx = 0) {
    const { useMhla } = this.config;
    const Q = new Float32Array(query); this._rope(Q, seqLen);
    const K = new Float32Array(key);   this._rope(K, seqLen); this._diffuse(K);
    const V = new Float32Array(value);

    let Kf = K, Vf = V, kvLen = seqLen;
    if (kvCache) {
      kvCache.prefill(layerIdx, K, V);
      const got = kvCache.getLayer(layerIdx);
      if (got) { [Kf, Vf] = got; kvLen = kvCache.len() || seqLen; }
    }

    return useMhla
      ? this._mhla(Q, Kf, Vf, seqLen)
      : this._gqa(Q, Kf, Vf, seqLen, kvLen);
  }

  // ── GQA avec softmax (vraie attention pondérée) ───
  _gqa(Q, K, V, qLen, kvLen) {
    const { numQueryHeads: qH, numKvHeads: kvH, headDim } = this.config;
    const rep = qH / kvH;
    const out = new Float32Array(Q.length);
    const scores = bufferPool.acquire(kvLen);

    for (let qi = 0; qi < qLen; qi++) {
      for (let qh = 0; qh < qH; qh++) {
        const kvh   = (qh / rep) | 0;
        const qBase = (qi * qH + qh) * headDim;

        // Scores Q·K causal (ki <= qi)
        const limit = Math.min(kvLen, qi + 1);
        for (let ki = 0; ki < limit; ki++) {
          const kBase = (ki * kvH + kvh) * headDim;
          let dot = 0;
          for (let d = 0; d < headDim; d++) dot += Q[qBase + d] * K[kBase + d];
          scores[ki] = dot * this._scale;
        }
        // Softmax stable
        let mx = scores[0];
        for (let k = 1; k < limit; k++) if (scores[k] > mx) mx = scores[k];
        let sum = 0;
        for (let k = 0; k < limit; k++) { scores[k] = Math.exp(scores[k] - mx); sum += scores[k]; }
        const inv = 1 / sum;

        // Pondération de V
        for (let ki = 0; ki < limit; ki++) {
          const w = scores[ki] * inv;
          const vBase = (ki * kvH + kvh) * headDim;
          for (let d = 0; d < headDim; d++) out[qBase + d] += w * V[vBase + d];
        }
      }
    }
    bufferPool.release(scores);
    return out;
  }

  // ── MHLA : compression latente ────────────────────
  _mhla(Q, K, V, qLen) {
    const { numQueryHeads: qH, headDim, latentDim } = this.config;
    const out = new Float32Array(Q.length);
    const lk  = bufferPool.acquire(latentDim);
    const lv  = bufferPool.acquire(latentDim);

    for (let qi = 0; qi < qLen; qi++) {
      for (let qh = 0; qh < qH; qh++) {
        const qBase = (qi * qH + qh) * headDim;
        lk.fill(0); lv.fill(0);
        for (let d = 0; d < headDim; d++) {
          const kv = K[qBase + d], vv = V[qBase + d];
          const pb = d * latentDim;
          for (let l = 0; l < latentDim; l++) {
            lk[l] += kv * this.latentKeyProj[pb + l];
            lv[l] += vv * this.latentValueProj[pb + l];
          }
        }
        for (let l = 0; l < latentDim; l++) { lk[l] = this._act(lk[l]); lv[l] = this._act(lv[l]); }

        let score = 0;
        for (let l = 0; l < latentDim; l++) score += Q[qBase + (l % headDim)] * lk[l];
        score = this._act(score * this._scale);

        for (let d = 0; d < headDim; d++) {
          let contrib = 0;
          const pb = d * latentDim;
          for (let l = 0; l < latentDim; l++) contrib += lv[l] * this.latentValueProj[pb + l];
          out[qBase + d] += score * contrib;
        }
      }
    }
    bufferPool.release(lk); bufferPool.release(lv);
    return out;
  }

  _rope(t, seqLen) {
    const hd = this.config.headDim;
    for (let pos = 0; pos < seqLen; pos++) {
      const b = pos * hd;
      for (let i = 0; i < hd; i += 2) {
        const t0 = t[b+i], t1 = t[b+i+1];
        const c = this._cos[b+i], s = this._sin[b+i];
        t[b+i]   = t0 * c - t1 * s;
        t[b+i+1] = t0 * s + t1 * c;
      }
    }
  }

  _diffuse(key) {
    const str = this.config.diffusionStrength, inv = 1 - str;
    for (let i = 0; i < key.length; i++) key[i] = key[i] * inv + Math.sin(key[i] * 0.7) * str;
  }

  _act(x) {
    return Math.tanh(x) * 0.88 + Math.sin(x * 0.6) * this.config.diffusionStrength * 0.12;
  }

  // ═══════════════════════════════════════════════════════════════
  //  ATTENTION CAUSALE INCRÉMENTALE CORRECTE (cross-token, GQA, RoPE)
  //  x : [seqLen × H] normé, H = numQueryHeads·headDim.
  //  dec : KVCache (slot = numKvHeads·headDim) ; basePos : position absolue
  //  de x[0]. Écrit le K/V des positions [basePos, basePos+seqLen) puis chaque
  //  token interroge tout le préfixe causal [0, basePos+t]. Identique en
  //  recalcul complet (basePos=0) et en décodage pas-à-pas (basePos=pos).
  //
  //  Réduction GQA : faute de projection K/V apprise dans ce modèle, chaque
  //  tête KV agrège (moyenne) ses `rep = qH/kvH` têtes-requête → mapping
  //  déterministe et sans paramètre de qH·headDim vers kvH·headDim.
  // ═══════════════════════════════════════════════════════════════
  causalSelfAttention(x, seqLen, layerIdx, dec, basePos = 0) {
    const { numQueryHeads: qH, numKvHeads: kvH, headDim } = this.config;
    const rep     = qH / kvH;
    const H       = qH * headDim;
    const kvWidth = kvH * headDim;
    const scale   = this._scale;
    const out     = new Float32Array(seqLen * H);

    // 1) K/V réduits + RoPE, écrits au cache à leur position absolue
    const kvK = new Float32Array(kvWidth), kvV = new Float32Array(kvWidth);
    for (let t = 0; t < seqLen; t++) {
      const absPos = basePos + t, xoff = t * H;
      for (let kh = 0; kh < kvH; kh++) {
        for (let d = 0; d < headDim; d++) {
          let s = 0;
          for (let r = 0; r < rep; r++) s += x[xoff + (kh * rep + r) * headDim + d];
          const v = s / rep;
          kvK[kh * headDim + d] = v;
          kvV[kh * headDim + d] = v;
        }
      }
      this._ropeAt(kvK, absPos, kvH, headDim);   // RoPE sur K (pas sur V)
      dec.writeStep(layerIdx, absPos, kvK, kvV);
    }

    const total = basePos + seqLen;
    const got = dec.viewUpTo(layerIdx, total);
    const Kb = got[0], Vb = got[1];
    const q  = new Float32Array(headDim);
    const scores = new Float32Array(total);

    // 2) Chaque token-requête attend son préfixe causal
    for (let t = 0; t < seqLen; t++) {
      const absPos = basePos + t, xoff = t * H, limit = absPos + 1;
      for (let qh = 0; qh < qH; qh++) {
        const kh = (qh / rep) | 0, qbase = xoff + qh * headDim;
        for (let d = 0; d < headDim; d++) q[d] = x[qbase + d];
        this._ropeAt(q, absPos, 1, headDim);

        let mx = -Infinity;
        for (let ki = 0; ki < limit; ki++) {
          const kBase = ki * kvWidth + kh * headDim;
          let dot = 0;
          for (let d = 0; d < headDim; d++) dot += q[d] * Kb[kBase + d];
          dot *= scale; scores[ki] = dot; if (dot > mx) mx = dot;
        }
        let sum = 0;
        for (let ki = 0; ki < limit; ki++) { const e = Math.exp(scores[ki] - mx); scores[ki] = e; sum += e; }
        const inv = sum > 0 ? 1 / sum : 0;
        for (let ki = 0; ki < limit; ki++) {
          const w = scores[ki] * inv, vBase = ki * kvWidth + kh * headDim;
          for (let d = 0; d < headDim; d++) out[qbase + d] += w * Vb[vBase + d];
        }
      }
    }
    return out;
  }

  // RoPE appliqué à `nHeads` blocs headDim consécutifs, à la position absolue `pos`.
  _ropeAt(vec, pos, nHeads, headDim) {
    const cb = (pos % this.config.maxSeqLen) * headDim;
    for (let h = 0; h < nHeads; h++) {
      const hb = h * headDim;
      for (let i = 0; i < headDim; i += 2) {
        const c = this._cos[cb + i], s = this._sin[cb + i];
        const a = vec[hb + i], b = vec[hb + i + 1];
        vec[hb + i]     = a * c - b * s;
        vec[hb + i + 1] = a * s + b * c;
      }
    }
  }

  // ─── Réglages runtime — long-contexte / diffusion (Fusion L0) ──

  /** Étend le contexte en recalculant les tables RoPE (style YaRN). */
  setRopeScaling(scale) {
    this.config.ropeScaling = scale;
    const { headDim, maxSeqLen, ropeBase } = this.config;
    const half = headDim >> 1;
    for (let pos = 0; pos < maxSeqLen; pos++) {
      const base = pos * headDim;
      for (let i = 0; i < half; i++) {
        const freq = pos / (Math.pow(ropeBase, (2 * i) / headDim) * scale);
        const c = Math.cos(freq), s = Math.sin(freq);
        this._cos[base + 2*i] = c; this._cos[base + 2*i+1] = c;
        this._sin[base + 2*i] = s; this._sin[base + 2*i+1] = s;
      }
    }
    return this;
  }

  setDiffusionStrength(s) { this.config.diffusionStrength = Math.max(0, Math.min(1, s)); return this; }

  capabilities() {
    return {
      mhla: this.config.useMhla, flash: this.config.useFlash,
      headDim: this.config.headDim, maxSeqLen: this.config.maxSeqLen,
      ropeScaling: this.config.ropeScaling,
    };
  }
}
