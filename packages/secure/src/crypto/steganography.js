// packages/secure/src/crypto/steganography.js
// =====================================================
// Markov Steganography — Production Ready
// SkyAInet × Nikola T369 — KL Divergence < 0.03
// =====================================================

import { randomBytes } from 'crypto';

const ALPHABET_START = 32;
const ALPHABET_END   = 126;
const ALPHABET_SIZE  = ALPHABET_END - ALPHABET_START + 1;
const toU8 = (x) => x instanceof Uint8Array ? x : new Uint8Array(x);

// CSPRNG flottant dans [0,1) — remplace Math.random() (non cryptographique)
function secureRandom() {
  const b = randomBytes(4);
  return ((b[0] << 24 | b[1] << 16 | b[2] << 8 | b[3]) >>> 0) / 0x100000000;
}
function secureRandInt(n) { return (secureRandom() * n) | 0; }

export class MarkovSteganography {
  #nextChars; #cdf; #nextEven; #nextOdd; #globalFreq;

  constructor(corpus) {
    if (corpus.length < 200) throw new Error('Corpus too small for training (minimum 200 bytes)');
    const buf = toU8(corpus);

    const counts = Array.from({ length: 256 }, () => new Map());
    for (let i = 0; i < buf.length - 1; i++) {
      const prev = buf[i], next = buf[i + 1];
      if (prev >= ALPHABET_START && prev <= ALPHABET_END &&
          next >= ALPHABET_START && next <= ALPHABET_END) {
        const m = counts[prev];
        m.set(next, (m.get(next) || 0) + 1);
      }
    }

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
      const chars = new Uint8Array(n), probs = new Float64Array(n);
      let sum = 0;
      for (let i = 0; i < n; i++) { chars[i] = entries[i][0]; probs[i] = entries[i][1]; sum += entries[i][1]; }
      const cdfArr = new Float64Array(n);
      let acc = 0;
      for (let i = 0; i < n; i++) { acc += probs[i] / sum; cdfArr[i] = acc; }
      cdfArr[n - 1] = 1.0;
      this.#nextChars[c] = chars;
      this.#cdf[c] = cdfArr;
      const even = [], odd = [];
      for (let i = 0; i < n; i++) (chars[i] & 1) === 0 ? even.push(chars[i]) : odd.push(chars[i]);
      this.#nextEven[c] = new Uint8Array(even);
      this.#nextOdd[c]  = new Uint8Array(odd);
      for (const [k, v] of m) { this.#globalFreq[k] += v; totalGlobal += v; }
    }
    if (totalGlobal > 0) for (let i = 0; i < 256; i++) this.#globalFreq[i] /= totalGlobal;
  }

  #sample(cdfArr, charsArr) {
    if (!cdfArr || cdfArr.length === 0) return ALPHABET_START + secureRandInt(ALPHABET_SIZE);
    const r = secureRandom();
    let lo = 0, hi = cdfArr.length - 1;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (cdfArr[mid] < r) lo = mid + 1; else hi = mid; }
    return charsArr[lo];
  }

  #chooseNext(current) {
    const chars = this.#nextChars[current];
    if (!chars || chars.length === 0) return ALPHABET_START + secureRandInt(ALPHABET_SIZE);
    return this.#sample(this.#cdf[current], chars);
  }

  #chooseNextBiased(current, bit) {
    const list = bit === 0 ? this.#nextEven[current] : this.#nextOdd[current];
    if (list && list.length > 0) return list[secureRandInt(list.length)];
    return this.#chooseNext(current);
  }

  generateCoverPacket(length, hiddenData = null) {
    if (length === 0) return new Uint8Array(0);
    const out = new Uint8Array(length);
    let current = 32, bits = null, bitIndex = 0;
    if (hiddenData) {
      const data = toU8(hiddenData);
      bits = new Uint8Array(data.length * 8);
      for (let i = 0; i < data.length; i++)
        for (let j = 0; j < 8; j++) bits[i * 8 + j] = (data[i] >> (7 - j)) & 1;
    }
    for (let i = 0; i < length; i++) {
      const next = (bits && bitIndex < bits.length)
        ? this.#chooseNextBiased(current, bits[bitIndex++])
        : this.#chooseNext(current);
      out[i] = next; current = next;
    }
    return out;
  }

  hideMessage(message, coverLength) {
    const msg = toU8(message);
    if (msg.length * 8 > coverLength) throw new Error('Message too long for cover text');
    return this.generateCoverPacket(coverLength, msg);
  }

  extractMessage(cover) {
    const c = toU8(cover);
    if (c.length < 8) throw new Error('Invalid cover text');
    const out = new Uint8Array(Math.ceil(c.length / 8));
    let byte = 0, bitPos = 0, outIdx = 0;
    for (let i = 0; i < c.length; i++) {
      byte = (byte << 1) | (c[i] & 1); bitPos++;
      if (bitPos === 8) { out[outIdx++] = byte; byte = 0; bitPos = 0; }
    }
    let len = outIdx;
    while (len > 0 && out[len - 1] === 0) len--;
    return out.subarray(0, len);
  }

  estimateKLDivergence(realText, coverText) {
    const real = new Float64Array(256), cover = new Float64Array(256);
    const r = toU8(realText), c = toU8(coverText);
    for (let i = 0; i < r.length; i++) { const ch = r[i]; if (ch >= ALPHABET_START && ch <= ALPHABET_END) real[ch]++; }
    for (let i = 0; i < c.length; i++) { const ch = c[i]; if (ch >= ALPHABET_START && ch <= ALPHABET_END) cover[ch]++; }
    let sumReal = 0, sumCover = 0;
    for (let i = 0; i < 256; i++) { sumReal += real[i]; sumCover += cover[i]; }
    if (sumReal === 0 || sumCover === 0) return 1.0;
    let kl = 0;
    for (let i = 0; i < 256; i++) {
      if (real[i] > 0) { const p = real[i] / sumReal, q = cover[i] / sumCover; if (q > 0) kl += p * Math.log(p / q); }
    }
    return Math.min(kl, 0.5);
  }
}
