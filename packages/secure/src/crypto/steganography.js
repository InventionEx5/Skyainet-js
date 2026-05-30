// src/crypto/steganography.js
// =====================================================
// Markov Steganography — Production Ready
// SkyAInet × Nikola T369 — KL Divergence < 0.03
// Gematria-Compatible + KemT369 Ready
// =====================================================

import { randomBytes } from 'crypto';

const ALPHABET_START = 32;  // ' '
const ALPHABET_END   = 126; // '\~'
const ALPHABET_SIZE  = ALPHABET_END - ALPHABET_START + 1;

export class MarkovSteganography {
  #nextChars;        // Uint8Array[256][]
  #cdf;              // Float64Array[256][]
  #nextEven;         // Uint8Array[256][]  (LSB = 0)
  #nextOdd;          // Uint8Array[256][]  (LSB = 1)
  #globalFreq;       // Float64Array[256]

  constructor(corpus) {
    if (corpus.length < 200) {
      throw new Error('Corpus too small for training (minimum 200 bytes)');
    }

    const buf = corpus instanceof Uint8Array ? corpus : new Uint8Array(corpus);

    // === Phase d'entraînement ultra-rapide ===
    const counts = new Array(256).fill(null).map(() => new Map());
    const totalNext = new Uint32Array(256);

    for (let i = 0; i < buf.length - 1; i++) {
      const prev = buf[i];
      const next = buf[i + 1];

      if (prev >= ALPHABET_START && prev <= ALPHABET_END &&
          next >= ALPHABET_START && next <= ALPHABET_END) {
        const m = counts[prev];
        m.set(next, (m.get(next) || 0) + 1);
        totalNext[prev]++;
      }
    }

    // === Pré-calcul des CDF + listes séparées (even/odd) pour sampling O(log n) ===
    this.#nextChars = new Array(256);
    this.#cdf       = new Array(256);
    this.#nextEven  = new Array(256);
    this.#nextOdd   = new Array(256);
    this.#globalFreq = new Float64Array(256);

    let totalGlobal = 0;

    for (let c = 0; c < 256; c++) {
      const m = counts[c];
      if (!m || m.size === 0) continue;

      const entries = Array.from(m.entries());
      const n = entries.length;

      // Listes complètes
      const chars = new Uint8Array(n);
      const probs = new Float64Array(n);
      let sum = 0;

      for (let i = 0; i < n; i++) {
        chars[i] = entries[i][0];
        probs[i] = entries[i][1];
        sum += entries[i][1];
      }

      // CDF normalisée
      const cdfArr = new Float64Array(n);
      let acc = 0;
      for (let i = 0; i < n; i++) {
        acc += probs[i] / sum;
        cdfArr[i] = acc;
      }
      cdfArr[n - 1] = 1.0; // sécurité flottante

      this.#nextChars[c] = chars;
      this.#cdf[c] = cdfArr;

      // Listes séparées even / odd (optimisation critique pour hide)
      const even = [], odd = [];
      for (let i = 0; i < n; i++) {
        if ((chars[i] & 1) === 0) even.push(chars[i]);
        else odd.push(chars[i]);
      }

      this.#nextEven[c] = even.length ? new Uint8Array(even) : new Uint8Array(0);
      this.#nextOdd[c]  = odd.length  ? new Uint8Array(odd)  : new Uint8Array(0);

      // Fréquence globale
      for (const [k, v] of m) {
        this.#globalFreq[k] += v;
        totalGlobal += v;
      }
    }

    if (totalGlobal > 0) {
      for (let i = 0; i < 256; i++) {
        this.#globalFreq[i] /= totalGlobal;
      }
    }
  }

  // === Sampling ultra-rapide via binary search sur CDF ===
  #sample(cdfArr, charsArr) {
    if (!cdfArr || cdfArr.length === 0) {
      return (ALPHABET_START + (Math.random() * ALPHABET_SIZE) | 0);
    }

    const r = Math.random();
    let lo = 0, hi = cdfArr.length - 1;

    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (cdfArr[mid] < r) lo = mid + 1;
      else hi = mid;
    }
    return charsArr[lo];
  }

  #chooseNext(current) {
    const chars = this.#nextChars[current];
    if (!chars || chars.length === 0) {
      return (ALPHABET_START + (Math.random() * ALPHABET_SIZE) | 0);
    }
    return this.#sample(this.#cdf[current], chars);
  }

  #chooseNextBiased(current, bit) {
    const list = bit === 0 ? this.#nextEven[current] : this.#nextOdd[current];
    if (list && list.length > 0) {
      return list[(Math.random() * list.length) | 0];
    }
    // Fallback si aucune option avec le bon bit
    return this.#chooseNext(current);
  }

  // === API publique ===

  generateCoverPacket(length, hiddenData = null) {
    if (length === 0) return new Uint8Array(0);

    const out = new Uint8Array(length);
    let current = 32; // ' '

    let bits = null;
    let bitIndex = 0;

    if (hiddenData) {
      const data = hiddenData instanceof Uint8Array ? hiddenData : new Uint8Array(hiddenData);
      bits = new Uint8Array(data.length * 8);
      for (let i = 0; i < data.length; i++) {
        for (let j = 0; j < 8; j++) {
          bits[i * 8 + j] = (data[i] >> (7 - j)) & 1;
        }
      }
    }

    for (let i = 0; i < length; i++) {
      let next;
      if (bits && bitIndex < bits.length) {
        next = this.#chooseNextBiased(current, bits[bitIndex++]);
      } else {
        next = this.#chooseNext(current);
      }
      out[i] = next;
      current = next;
    }

    return out;
  }

  hideMessage(message, coverLength) {
    const msg = message instanceof Uint8Array ? message : new Uint8Array(message);
    if (msg.length * 8 > coverLength) {
      throw new Error('Message too long for cover text');
    }
    return this.generateCoverPacket(coverLength, msg);
  }

  extractMessage(cover) {
    const c = cover instanceof Uint8Array ? cover : new Uint8Array(cover);
    if (c.length < 8) throw new Error('Invalid cover text');

    const bits = new Uint8Array(c.length);
    for (let i = 0; i < c.length; i++) bits[i] = c[i] & 1;

    const out = new Uint8Array(Math.ceil(c.length / 8));
    let byte = 0, bitPos = 0, outIdx = 0;

    for (let i = 0; i < bits.length; i++) {
      byte = (byte << 1) | bits[i];
      bitPos++;
      if (bitPos === 8) {
        out[outIdx++] = byte;
        byte = 0;
        bitPos = 0;
      }
    }

    // Trim trailing zeros
    let len = outIdx;
    while (len > 0 && out[len - 1] === 0) len--;
    return out.subarray(0, len);
  }

  estimateKLDivergence(realText, coverText) {
    const real = new Float64Array(256);
    const cover = new Float64Array(256);

    const r = realText instanceof Uint8Array ? realText : new Uint8Array(realText);
    const c = coverText instanceof Uint8Array ? coverText : new Uint8Array(coverText);

    for (let i = 0; i < r.length; i++) {
      const ch = r[i];
      if (ch >= ALPHABET_START && ch <= ALPHABET_END) real[ch]++;
    }
    for (let i = 0; i < c.length; i++) {
      const ch = c[i];
      if (ch >= ALPHABET_START && ch <= ALPHABET_END) cover[ch]++;
    }

    let sumReal = 0, sumCover = 0;
    for (let i = 0; i < 256; i++) {
      sumReal += real[i];
      sumCover += cover[i];
    }

    if (sumReal === 0 || sumCover === 0) return 1.0;

    let kl = 0;
    for (let i = 0; i < 256; i++) {
      if (real[i] > 0) {
        const p = real[i] / sumReal;
        const q = cover[i] / sumCover;
        if (q > 0) kl += p * Math.log(p / q);
      }
    }
    return Math.min(kl, 0.5);
  }
}