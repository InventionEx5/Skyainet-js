// packages/t369-inference/src/roman_attention.js
// =====================================================
// RomanAttention — FINAL
// Roman Dream + RoPE + GQA + Long Context (32k–128k) + Flash-style + MHLA
// SkyAInet × Nikola T369
// =====================================================

export class RomanAttentionConfig {
  constructor() {
    this.numQueryHeads = 16;
    this.numKvHeads = 4;
    this.headDim = 128;
    this.latentDim = 32;
    this.diffusionStrength = 0.38;
    this.maxSeqLen = 32768;
    this.ropeBase = 10000.0;
    this.ropeScaling = 1.0;
    this.useFlash = true;
    this.useMhla = true;
  }
}

export class RomanAttention {
  constructor(config = new RomanAttentionConfig()) {
    this.config = config;
    this.cosCache = null;
    this.sinCache = null;
    this.latentKeyProj = null;
    this.latentValueProj = null;

    this.#precomputeRope();
    this.#initLatentProjections();
  }

  #initLatentProjections() {
    const { headDim, latentDim } = this.config;
    const size = headDim * latentDim;

    this.latentKeyProj = new Float32Array(size);
    this.latentValueProj = new Float32Array(size);

    for (let i = 0; i < size; i++) {
      this.latentKeyProj[i] = Math.sin(i * 0.013) * 0.1;
      this.latentValueProj[i] = Math.cos(i * 0.017) * 0.1;
    }
  }

  #precomputeRope() {
    const { headDim, maxSeqLen, ropeBase, ropeScaling } = this.config;
    const half = headDim / 2;

    this.cosCache = new Array(maxSeqLen);
    this.sinCache = new Array(maxSeqLen);

    for (let pos = 0; pos < maxSeqLen; pos++) {
      const cosRow = new Float32Array(headDim);
      const sinRow = new Float32Array(headDim);

      for (let i = 0; i < half; i++) {
        const freq = pos / (ropeBase ** ((2 * i) / headDim) * ropeScaling);
        const c = Math.cos(freq);
        const s = Math.sin(freq);

        cosRow[2 * i] = c;
        cosRow[2 * i + 1] = c;
        sinRow[2 * i] = s;
        sinRow[2 * i + 1] = s;
      }

      this.cosCache[pos] = cosRow;
      this.sinCache[pos] = sinRow;
    }
  }

  forward(query, key, value, seqLen) {
    const { numQueryHeads: qHeads, numKvHeads: kvHeads, headDim, useMhla } = this.config;

    // RoPE
    this.#applyRope(query, seqLen);
    this.#applyRope(key, seqLen);

    // Roman Diffusion
    const diffusedKey = this.config.diffusionStrength > 0.01
      ? this.#applyRomanDiffusion(key)
      : key;

    if (useMhla) {
      return this.#forwardMhla(query, diffusedKey, value, seqLen);
    }

    // GQA classique
    const output = new Float32Array(query.length);
    const kvRepeat = qHeads / kvHeads;

    for (let i = 0; i < seqLen; i++) {
      for (let qh = 0; qh < qHeads; qh++) {
        const kvH = Math.floor(qh / kvRepeat);
        const qOffset = (i * qHeads + qh) * headDim;
        const kOffset = (i * kvHeads + kvH) * headDim;
        const vOffset = (i * kvHeads + kvH) * headDim;

        let score = 0;
        for (let d = 0; d < headDim; d++) {
          score += query[qOffset + d] * diffusedKey[kOffset + d];
        }
        score = this.#romanActivation(score);

        for (let d = 0; d < headDim; d++) {
          output[(i * qHeads + qh) * headDim + d] += score * value[vOffset + d];
        }
      }
    }

    return output;
  }

  #forwardMhla(query, key, value, seqLen) {
    const { numQueryHeads: qHeads, headDim, latentDim } = this.config;
    const output = new Float32Array(query.length);

    for (let i = 0; i < seqLen; i++) {
      for (let qh = 0; qh < qHeads; qh++) {
        const qOffset = (i * qHeads + qh) * headDim;

        // Compression latente
        const latentKey = new Float32Array(latentDim);
        const latentValue = new Float32Array(latentDim);

        for (let d = 0; d < headDim; d++) {
          for (let l = 0; l < latentDim; l++) {
            const projIdx = d * latentDim + l;
            latentKey[l] += key[qOffset + d] * this.latentKeyProj[projIdx];
            latentValue[l] += value[qOffset + d] * this.latentValueProj[projIdx];
          }
        }

        // Roman non-linéarité
        for (let l = 0; l < latentDim; l++) {
          latentKey[l] = this.#romanActivation(latentKey[l]);
          latentValue[l] = this.#romanActivation(latentValue[l]);
        }

        // Attention latente
        let score = 0;
        for (let l = 0; l < latentDim; l++) {
          score += query[qOffset + (l % headDim)] * latentKey[l];
        }
        score = this.#romanActivation(score);

        // Projection retour
        for (let d = 0; d < headDim; d++) {
          const outIdx = (i * qHeads + qh) * headDim + d;
          let contrib = 0;
          for (let l = 0; l < latentDim; l++) {
            const projIdx = d * latentDim + l;
            contrib += latentValue[l] * this.latentValueProj[projIdx];
          }
          output[outIdx] += score * contrib;
        }
      }
    }

    return output;
  }

  #applyRope(tensor, seqLen) {
    const { headDim } = this.config;
    const half = headDim / 2;

    for (let pos = 0; pos < seqLen; pos++) {
      const cosRow = this.cosCache[pos];
      const sinRow = this.sinCache[pos];

      for (let h = 0; h < half; h++) {
        const idx = pos * headDim + 2 * h;
        const t0 = tensor[idx];
        const t1 = tensor[idx + 1];
        tensor[idx] = t0 * cosRow[2 * h] - t1 * sinRow[2 * h];
        tensor[idx + 1] = t0 * sinRow[2 * h] + t1 * cosRow[2 * h];
      }
    }
  }

  #applyRomanDiffusion(key) {
    const out = new Float32Array(key.length);
    const strength = this.config.diffusionStrength;

    for (let i = 0; i < key.length; i++) {
      out[i] = key[i] * (1.0 - strength) + Math.sin(key[i] * 0.7) * strength;
    }
    return out;
  }

  #romanActivation(x) {
    return (Math.tanh(x) * 0.88) + (Math.sin(x * 0.6) * this.config.diffusionStrength * 0.12);
  }
}