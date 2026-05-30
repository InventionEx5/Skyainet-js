// packages/t369-inference/src/tokenizer.js
// =====================================================
// BpeTokenizer — BPE haute performance
// Cache LRU, séparateur \x00 (pas de collision), decode </w> propre
// SkyAInet × Nikola T369
// =====================================================

"use strict";

class LruCache {
  constructor(max = 8192) { this._max = max; this._m = new Map(); }
  get(k) {
    if (!this._m.has(k)) return undefined;
    const v = this._m.get(k); this._m.delete(k); this._m.set(k, v); return v;
  }
  set(k, v) {
    if (this._m.has(k)) this._m.delete(k);
    else if (this._m.size >= this._max) this._m.delete(this._m.keys().next().value);
    this._m.set(k, v);
  }
}

// Pré-tokenisation unicode (lettres / chiffres / ponctuation)
const PRE_RE = /\p{L}+|\p{N}+|[^\s\p{L}\p{N}]+/gu;

export class BpeTokenizer {
  constructor() {
    this.vocab     = new Map();
    this.idToToken = [];
    this.merges    = new Map();   // "a\x00b" → rank
    this.bosToken  = 0;
    this.eosToken  = 1;
    this.padToken  = 2;
    this.unkToken  = 3;
    this._cache    = new LruCache(8192);
  }

  load(vocab, merges) {
    this.vocab.clear(); this.idToToken = []; this.merges.clear();
    this._cache = new LruCache(8192);
    for (const [token, id] of vocab) {
      this.vocab.set(token, id);
      if (this.idToToken.length <= id) this.idToToken.length = id + 1;
      this.idToToken[id] = token;
    }
    for (const [[a, b], rank] of merges) this.merges.set(`${a}\x00${b}`, rank);
    return this;
  }

  encode(text) {
    if (!text) return [];
    const cached = this._cache.get(text);
    if (cached) return cached.slice();

    const words  = text.match(PRE_RE) || [];
    const result = [];
    for (const w of words) {
      const ids = this._encodeWord(w);
      for (let i = 0; i < ids.length; i++) result.push(ids[i]);
    }
    this._cache.set(text, result);
    return result.slice();
  }

  _encodeWord(word) {
    let parts = [...word];
    if (parts.length === 0) return [];
    parts[parts.length - 1] += '</w>';

    // BPE : fusionne la paire de plus bas rang à chaque tour
    while (parts.length > 1) {
      let bestRank = Infinity, bestIdx = -1;
      for (let i = 0; i < parts.length - 1; i++) {
        const r = this.merges.get(`${parts[i]}\x00${parts[i+1]}`);
        if (r !== undefined && r < bestRank) { bestRank = r; bestIdx = i; }
      }
      if (bestIdx === -1) break;
      parts.splice(bestIdx, 2, parts[bestIdx] + parts[bestIdx + 1]);
    }
    return parts.map(p => this.vocab.get(p) ?? this.unkToken);
  }

  decode(tokens) {
    let out = '';
    for (const id of tokens) {
      const tok = this.idToToken[id];
      if (tok === undefined) { out += '<unk>'; continue; }
      out += tok.endsWith('</w>') ? tok.slice(0, -4) + ' ' : tok;
    }
    return out.trimEnd();
  }

  vocabSize() { return this.vocab.size; }
  addSpecialToken(token, id) {
    this.vocab.set(token, id);
    if (this.idToToken.length <= id) this.idToToken.length = id + 1;
    this.idToToken[id] = token;
  }
}
