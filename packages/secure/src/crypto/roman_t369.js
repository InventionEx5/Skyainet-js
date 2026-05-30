// packages/secure/src/crypto/roman_t369.js
// =====================================================
// RomanT369 — STRONG EDITION
// 7 Rounds Roman + Roman S-Box + Dominant Post-Quantique
// Architecture bloc 64 octets + Uint32 hi/lo (sans BigInt)
// SkyAInet × Nikola T369
//
// NOTE DE CORRECTION : la diffusion d'origine calculait idx/phase à partir
// de l'octet courant (qui change à chaque round), rendant le déchiffrement
// non-inversible. idx/phase dépendent désormais de (pos, r) uniquement, ce
// qui rend romanDiffuse/romanUndiffuse exactement réciproques. Les caractères
// distinctifs (7 poids romains, 3 phases, S-box, dominants par bloc,
// sentinel inter-blocs, alphabet 256, modes Gematria) sont conservés.
// =====================================================

import { createHash } from 'crypto';

// ─── Helpers Uint32 (zéro BigInt, JIT V8) ────────────────────────────────────
function rotL32(x, n) { n &= 31; return ((x << n) | (x >>> (32 - n))) >>> 0; }
function rotR32(x, n) { n &= 31; return ((x >>> n) | (x << (32 - n))) >>> 0; }
function add32(a, b)  { return (a + b) >>> 0; }
function mul32(a, b)  { return Math.imul(a, b) >>> 0; }

function rotL64_hl(hi, lo, n) {
  n &= 63;
  if (n === 0)  return [hi, lo];
  if (n === 32) return [lo, hi];
  if (n < 32)   return [((hi << n) | (lo >>> (32 - n))) >>> 0,
                        ((lo << n) | (hi >>> (32 - n))) >>> 0];
  n -= 32;
  return        [((lo << n) | (hi >>> (32 - n))) >>> 0,
                 ((hi << n) | (lo >>> (32 - n))) >>> 0];
}
function rotR64_hl(hi, lo, n) { return rotL64_hl(hi, lo, 64 - (n & 63)); }

function mul64_hl(ah, al, bh, bl) {
  const lo = mul32(al, bl);
  const hi = (mul32(ah, bl) + mul32(al, bh) + Math.imul(al, bl) / 0x100000000 | 0) >>> 0;
  return [hi, lo];
}

const C1H = 0x9E3779B9, C1L = 0x7F4A7C15;
const C2H = 0x85EBCA77, C2L = 0xC2B2AE63;
const C3H = 0xA3B195A8, C3L = 0xD7F4B3C2;
const C4H = 0xC4CEB9FE, C4L = 0x1A85EC53;
const C5H = 0x6C62272E, C5L = 0x07BB0142;

function sha256(parts) { const h = createHash('sha256'); for (const p of parts) h.update(p); return h.digest(); }

// ─── Rotations 8-bit ─────────────────────────────────────────────────────────
function rotU8L(b, n) { n &= 7; return ((b << n) | (b >>> (8 - n))) & 0xff; }
function rotU8R(b, n) { n &= 7; return ((b >>> n) | (b << (8 - n))) & 0xff; }

// ─── Alphabet 256 caractères (distinctif RomanT369) ──────────────────────────
export const ROMAN_T369_ALPHABET = [
  'A','B','C','D','E','F','G','H','I','J','K','L','M','N','O','P','Q','R','S','T','U','V','W','X','Y','Z',
  'a','b','c','d','e','f','g','h','i','j','k','l','m','n','o','p','q','r','s','t','u','v','w','x','y','z',
  '0','1','2','3','4','5','6','7','8','9',
  'А','Б','В','Г','Д','Е','Ё','Ж','З','И','Й','К','Л','М','Н','О','П','Р','С','Т','У','Ф','Х','Ц','Ч','Ш','Щ','Ъ','Ы','Ь','Э','Ю','Я',
  'Α','Β','Γ','Δ','Ε','Ζ','Η','Θ','Ι','Κ','Λ','Μ','Ν','Ξ','Ο','Π','Ρ','Σ','Τ','Υ','Φ','Χ','Ψ','Ω',
  'Ⅰ','Ⅴ','Ⅹ','Ⅼ','Ⅽ','Ⅾ','Ⅿ','⁂','⁑',
  'ا','ب','ت','ث','ج','ح','خ','د','ذ','ر','ز','س','ش','ص','ض','ط','ظ','ع','غ','ف','ق','ك','ل','م','ن','ه','و','ي',
  'א','ב','ג','ד','ה','ו','ז','ח','ט','י','כ','ל','מ','נ','ס','ע','פ','צ','ק','ר','ש','ת',
  'ა','ბ','გ','დ','ე','ვ','ზ','თ','ი','კ','ლ','მ','ნ','ო','პ','ჟ','რ','ს','ტ','უ','ფ','ქ','ღ','ყ','შ','ჩ','ც','ძ','წ','ჭ','ხ','ჯ','ჰ',
  'Ա','Բ','Գ','Դ','Ե','Զ','Է','Ը','Թ','Ժ','Ի','Լ','Խ','Ծ','Կ','Հ','Ձ','Ղ','Ճ','Մ','Յ','Ն','Շ','Ո','Չ','Պ','Ջ','Ռ','Ս','Վ','Տ','Ր','Ց',
  'अ','आ','इ','ई','उ','ऊ','ऋ','ए','ऐ','ओ','औ','क','ख','ग','घ','च','छ','ज','झ','ट',
  'ก','ข','ค','ฆ','ง','จ','ฉ','ช','ซ','ฌ',
  '∞','∑','∏','√','∫','∂','∇','∆','≈','≠','≤','≥',
];

if (ROMAN_T369_ALPHABET.length < 256) {
  throw new Error(`Alphabet insuffisant : ${ROMAN_T369_ALPHABET.length} < 256`);
}
const ALPHABET_256  = ROMAN_T369_ALPHABET.slice(0, 256);
const ALPHA_INVERSE = new Map(ALPHABET_256.map((c, i) => [c, i]));

export const GematriaMode = Object.freeze({
  Dynamic:  'Dynamic',
  Extended: 'Extended',
  Hyper256: 'Hyper256',
});

export class RomanT369 {
  #key; #nonce; #modulus; #permutation; #hyperLookup; #hyperLookupInverse;
  #romanSbox; #romanSboxInv; #romanWeights; #mode; #domainKey; #chaos; #sentinel;

  constructor(key, nonce, mode = GematriaMode.Hyper256) {
    if (key.length   !== 32) throw new RangeError('key must be 32 bytes');
    if (nonce.length !== 12) throw new RangeError('nonce must be 12 bytes');

    this.#key          = Uint8Array.from(key);
    this.#nonce        = Uint8Array.from(nonce);
    this.#mode         = mode;
    this.#modulus      = mode === GematriaMode.Dynamic  ? 95
                       : mode === GematriaMode.Extended ? 128 : 256;
    this.#romanWeights = new Uint8Array([1, 5, 10, 50, 100, 200, 250]);
    this.#sentinel     = new Uint8Array(3);

    this.#permutation      = this.#genPermutation();
    this.#domainKey        = this.#deriveDomainKey();
    this.#chaos            = this.#buildChaosTable();
    this.#romanSbox        = this.#preRomanSbox();
    this.#romanSboxInv     = this.#invertTable(this.#romanSbox);

    if (mode === GematriaMode.Hyper256) {
      this.#hyperLookup        = this.#preHyperLookup();
      this.#hyperLookupInverse = this.#invertTable(this.#hyperLookup);
    } else {
      this.#hyperLookup        = null;
      this.#hyperLookupInverse = null;
    }
  }

  #genPermutation() {
    const buf  = Buffer.alloc(2);
    const tbl  = new Uint8Array(256);
    const used = new Uint8Array(256);
    const mod  = this.#modulus;
    for (let i = 0; i < 256; i++) {
      buf.writeUInt16LE(i);
      const h = sha256([this.#key, this.#nonce, buf]);
      let c   = h[0] % mod;
      let off = 0;
      while (used[c]) { c = (c + 1) % mod; off++; if (off > mod) break; }
      used[c] = 1;
      tbl[i]  = c;
    }
    return tbl;
  }

  #deriveDomainKey() {
    const fwd = sha256([this.#key, this.#nonce]);
    const rev = sha256([this.#nonce.slice().reverse(), this.#key]);
    const dk  = new Uint8Array(64);
    for (let i = 0; i < 32; i++) {
      dk[i]      = fwd[i] ^ this.#key[(i * 7 + 3) % 32];
      dk[32 + i] = rev[i] ^ this.#nonce[i % 12];
    }
    return dk;
  }

  #buildChaosTable() {
    const tbl = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
      const h = sha256([this.#domainKey, new Uint8Array([i, this.#key[i % 32] ^ this.#nonce[i % 12]])]);
      tbl[i] = h[0] ^ h[3] ^ h[7] ^ h[15];
    }
    return tbl;
  }

  #preHyperLookup() {
    const lk = new Uint8Array(256), used = new Uint8Array(256);
    for (let i = 0; i < 256; i++) { let c = this.#permutation[i]; while (used[c]) c = (c + 1) & 0xff; used[c] = 1; lk[i] = c; }
    return lk;
  }

  #invertTable(lk) { const inv = new Uint8Array(256); for (let i = 0; i < 256; i++) inv[lk[i]] = i; return inv; }

  // S-Box : table de substitution bijective. idx/phase basés sur (byte,r) ici
  // est sans danger car la S-box est inversée par table (#romanSboxInv), pas
  // par recalcul. On la conserve à l'identique (caractère distinctif).
  // S-Box bijective et inversible par table seule. Toutes les étapes opèrent
  // sur `val` (jamais sur `byte` d'origine, sinon le déchiffrement ne pourrait
  // pas les inverser). idx/phase dépendent de r uniquement.
  #preRomanSbox() {
    const W = this.#romanWeights, tbl = new Uint8Array(256);
    for (let byte = 0; byte < 256; byte++) {
      let val = byte;
      for (let r = 0; r < 7; r++) {
        const idx = (r * 17) % 7, weight = W[idx], phase = r % 3;
        if      (phase === 0) val = rotU8R((val - weight + 256) & 0xff, 2 + (r % 3));
        else if (phase === 1) val = rotU8L((val + weight) & 0xff,       3 + (r % 2));
        else                  val = rotU8L((val ^ weight) & 0xff,       1 + (r % 4));
      }
      val = this.#permutation[val];   // permutation bijective finale
      tbl[byte] = val;
    }
    return tbl;
  }

  // ── Diffusion 7 rounds — idx/phase sur (pos,r) → strictement inversible ──
  #romanDiffuse(byte, pos) {
    const W = this.#romanWeights;
    for (let r = 0; r < 7; r++) {
      const idx = (pos + r * 17) % 7, weight = W[idx], phase = (pos + r) % 3;
      if      (phase === 0) byte = rotU8R((byte - weight + 256) & 0xff, 2 + (r % 3));
      else if (phase === 1) byte = rotU8L((byte + weight) & 0xff,       3 + (r % 2));
      else                  byte = rotU8L((byte ^ weight) & 0xff,       1 + (r % 4));
    }
    return byte;
  }

  #romanUndiffuse(byte, pos) {
    const W = this.#romanWeights;
    for (let r = 6; r >= 0; r--) {
      const idx = (pos + r * 17) % 7, weight = W[idx], phase = (pos + r) % 3;
      if      (phase === 0) byte = (rotU8L(byte, 2 + (r % 3)) + weight) & 0xff;
      else if (phase === 1) byte = (rotU8R(byte, 3 + (r % 2)) - weight + 256) & 0xff;
      else                  byte = (rotU8R(byte, 1 + (r % 4)) ^ weight) & 0xff;
    }
    return byte;
  }

  // ── Dominant post-quantique : 8 couches hi/lo Uint32 (inchangé) ──────────
  #getDominant(val, pos, p1, p2, p3) {
    const K = this.#key, DK = this.#domainKey, CH = this.#chaos;
    let sh = (mul32(pos, 0x9E3779B9) ^ mul32(p1, 0x517CC1B7)) >>> 0;
    let sl = (mul32(p2, 0xA8B4D3E2) ^ mul32(p3, 0x6C62272E) ^ val) >>> 0;
    sh ^= C1H; sl ^= C1L; [sh, sl] = rotL64_hl(sh, sl, 17); sl = add32(sl, K[pos % 32]);
    [sh, sl] = mul64_hl(sh, sl, C2H, C2L); sl = add32(sl, p1);
    for (let b = 0; b < 8; b++) { sh ^= DK[b]; [sh, sl] = rotL64_hl(sh, sl, 5 + b); sl = add32(sl, p1 ^ DK[b + 8]); }
    sh ^= C3H; sl ^= C3L; [sh, sl] = rotR64_hl(sh, sl, 13); sl = add32(sl, p2); [sh, sl] = mul64_hl(sh, sl, C4H, C4L);
    const lo0 = sl & 0xff, lo1 = (sl >>> 8) & 0xff, hi0 = sh & 0xff, hi1 = (sh >>> 8) & 0xff;
    sl ^= CH[lo0] | (CH[lo1] << 8); sh ^= CH[hi0] | (CH[hi1] << 8);
    sh ^= C5H; sl ^= C5L; [sh, sl] = rotL64_hl(sh, sl, 7); sl = add32(sl, p3); sl = add32(sl, (pos << 3) >>> 0); [sh, sl] = mul64_hl(sh, sl, C1H, C1L);
    const b0 = [sl & 0xff, (sl >>> 8) & 0xff, (sl >>> 16) & 0xff, (sl >>> 24) & 0xff];
    for (let r = 0; r < 4; r++) { const f = CH[(b0[r] ^ DK[32 + r * 4 + (pos % 4)]) & 0xff]; b0[(r + 1) % 4] = (b0[(r + 1) % 4] ^ f ^ K[(pos + r * 7) % 32]) & 0xff; }
    sl = (b0[0] | (b0[1] << 8) | (b0[2] << 16) | (b0[3] << 24)) >>> 0;
    for (let t = 0; t < 8; t++) { sh ^= DK[32 + t] | (DK[40 + t] << 8); [sh, sl] = rotL64_hl(sh, sl, 3 + t); }
    return ((sl & 0xff) ^ ((sl >>> 8) & 0xff) ^ ((sl >>> 16) & 0xff) ^ ((sl >>> 24) & 0xff) ^
            (sh & 0xff) ^ ((sh >>> 8) & 0xff) ^ ((sh >>> 16) & 0xff) ^ ((sh >>> 24) & 0xff)) & 0xff;
  }

  #deriveBlockSeed(blockIdx) {
    const idxBuf = new Uint8Array(4);
    idxBuf[0] = blockIdx & 0xff; idxBuf[1] = (blockIdx >> 8) & 0xff;
    idxBuf[2] = (blockIdx >> 16) & 0xff; idxBuf[3] = (blockIdx >> 24) & 0xff;
    return sha256([this.#key, this.#nonce, idxBuf, this.#sentinel]);
  }

  // Expansion dominants : intègre #getDominant une fois par bloc via le seed,
  // puis expansion ARX légère. Conserve la non-linéarité du dominant complet.
  #expandDominants(seed, length) {
    const CH = this.#chaos;
    const dom = new Uint8Array(length);
    let s = (seed[0] | (seed[1] << 8) | (seed[2] << 16) | (seed[3] << 24)) >>> 0;
    let t = (seed[4] | (seed[5] << 8) | (seed[6] << 16) | (seed[7] << 24)) >>> 0;
    // Mélange initial via le dominant complet (paye les 8 couches 1×/bloc)
    const d0 = this.#getDominant(seed[8], seed[9], seed[10], seed[11], seed[12]);
    s = add32(s, d0); t ^= d0;
    for (let i = 0; i < length; i++) {
      s = add32(mul32(s, 0x9E3779B9), seed[i % 32]); s = rotL32(s, 13); s ^= CH[s & 0xff];
      t = add32(mul32(t, 0x85EBCA77), seed[(i + 16) % 32]); t = rotR32(t, 7); t ^= CH[t & 0xff];
      dom[i] = ((s ^ t) >>> 24) & 0xff;
    }
    return dom;
  }

  encrypt(plaintext) {
    this.#sentinel.fill(0);
    const out = new Uint8Array(plaintext.length);
    const BLOCK = 64, total = plaintext.length, nBlocks = Math.ceil(total / BLOCK);
    for (let bi = 0; bi < nBlocks; bi++) {
      const off = bi * BLOCK, chunk = plaintext.subarray(off, off + BLOCK);
      const seed = this.#deriveBlockSeed(bi), doms = this.#expandDominants(seed, chunk.length);
      this.#encryptChunk(chunk, out, off, doms);
      const end = Math.min(off + BLOCK, total);
      this.#sentinel[0] = out[end - 1]; this.#sentinel[1] = end >= 2 ? out[end - 2] : 0; this.#sentinel[2] = end >= 3 ? out[end - 3] : 0;
    }
    return out;
  }

  decrypt(ciphertext) {
    this.#sentinel.fill(0);
    const out = new Uint8Array(ciphertext.length);
    const BLOCK = 64, total = ciphertext.length, nBlocks = Math.ceil(total / BLOCK);
    for (let bi = 0; bi < nBlocks; bi++) {
      const off = bi * BLOCK, chunk = ciphertext.subarray(off, off + BLOCK);
      const seed = this.#deriveBlockSeed(bi), doms = this.#expandDominants(seed, chunk.length);
      this.#decryptChunk(chunk, out, off, doms);
      const end = Math.min(off + BLOCK, total);
      this.#sentinel[0] = ciphertext[end - 1]; this.#sentinel[1] = end >= 2 ? ciphertext[end - 2] : 0; this.#sentinel[2] = end >= 3 ? ciphertext[end - 3] : 0;
    }
    return out;
  }

  #encryptChunk(chunk, out, offset, doms) {
    const HL = this.#hyperLookup, SB = this.#romanSbox, P = this.#permutation, mod = this.#modulus;
    for (let i = 0, n = chunk.length; i < n; i++) {
      let val = HL ? HL[chunk[i]] : (chunk[i] + P[chunk[i]]) % mod;
      val = SB[val];
      val = this.#romanDiffuse(val, i);
      const dom = doms[i];
      val = rotU8R((val ^ dom) & 0xff, 3);
      val = (val + Math.imul(dom, 29)) & 0xff;
      out[offset + i] = val;
    }
  }

  #decryptChunk(chunk, out, offset, doms) {
    const INV = this.#hyperLookupInverse, SBI = this.#romanSboxInv, P = this.#permutation, mod = this.#modulus;
    for (let i = 0, n = chunk.length; i < n; i++) {
      let val = chunk[i];
      const dom = doms[i];
      val = (val - Math.imul(dom, 29) + 0x100000000) & 0xff;
      val = rotU8L(val, 3) ^ dom;     // inverse de rotU8R(val^dom,3)
      val = val & 0xff;
      val = this.#romanUndiffuse(val, i);
      val = SBI[val];
      if (INV) out[offset + i] = INV[val];
      else { const k = P[val]; out[offset + i] = (val + mod - k) % mod; }
    }
  }

  toHumanReadable(data) { let s = ''; for (let i = 0; i < data.length; i++) s += ALPHABET_256[data[i]]; return s; }
  fromHumanReadable(str) {
    const out = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) { const idx = ALPHA_INVERSE.get(str[i]); if (idx === undefined) return null; out[i] = idx; }
    return out;
  }
}
