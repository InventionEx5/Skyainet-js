// packages/t369-inference/src/tokenizer.js
// =====================================================
// T369 BPE Tokenizer — Extremely Optimized
// High-performance Byte Pair Encoding for T369Inference
// SkyAInet × Nikola T369
// =====================================================

export class BpeTokenizer {
  constructor() {
    this.vocab = new Map();           // string → number
    this.idToToken = [];              // number → string
    this.merges = new Map();          // `\( {a}: \){b}` → rank
    this.bosToken = 0;
    this.eosToken = 1;
    this.padToken = 2;
    this.unkToken = 3;
    this.encodeCache = new Map();     // string → number[]
  }

  load(vocab, merges) {
    this.vocab.clear();
    this.idToToken = [];
    this.merges.clear();

    for (const [token, id] of vocab) {
      this.vocab.set(token, id);
      if (this.idToToken.length <= id) this.idToToken.length = id + 1;
      this.idToToken[id] = token;
    }

    for (const [[a, b], rank] of merges) {
      this.merges.set(`\( {a}: \){b}`, rank);
    }

    return this;
  }

  encode(text) {
    if (this.encodeCache.has(text)) {
      return this.encodeCache.get(text).slice();
    }

    let tokens = this.#preTokenize(text);
    const result = [];

    // BPE merge loop (optimisé)
    while (tokens.length > 1) {
      let bestRank = Infinity;
      let bestIdx = -1;

      for (let i = 0; i < tokens.length - 1; i++) {
        const key = `\( {tokens[i]}: \){tokens[i + 1]}`;
        const rank = this.merges.get(key);
        if (rank !== undefined && rank < bestRank) {
          bestRank = rank;
          bestIdx = i;
        }
      }

      if (bestIdx === -1) break;

      const newToken = this.#getMergedToken(tokens[bestIdx], tokens[bestIdx + 1]);
      tokens.splice(bestIdx, 2, newToken);
    }

    for (const token of tokens) {
      const id = this.vocab.get(token);
      result.push(id !== undefined ? id : this.unkToken);
    }

    if (this.encodeCache.size < 10000) {
      this.encodeCache.set(text, result.slice());
    }

    return result;
  }

  decode(tokens) {
    let result = '';
    for (const id of tokens) {
      const token = this.idToToken[id];
      result += token !== undefined ? token : '<unk>';
    }
    return result;
  }

  #preTokenize(text) {
    return text.split(/\s+/).flatMap(word => {
      if (!word) return [];
      const chars = [...word];
      if (chars.length > 0) chars[chars.length - 1] += '</w>';
      return chars;
    });
  }

  #getMergedToken(a, b) {
    const ta = this.idToToken[a] || '';
    const tb = this.idToToken[b] || '';
    return ta + tb;
  }

  vocabSize() {
    return this.vocab.size;
  }

  addSpecialToken(token, id) {
    this.vocab.set(token, id);
    if (this.idToToken.length <= id) this.idToToken.length = id + 1;
    this.idToToken[id] = token;
  }
}