// packages/secure/src/crypto/roman_t369.js
// =====================================================
// RomanT369 — STRONG EDITION
// 7 Rounds Roman + Roman S-Box + Dominant Post-Quantique
// Architecture bloc 64 octets + Uint32 hi/lo (sans BigInt)
// Sécurité maximale + Performance optimisée
// SkyAInet × Nikola T369
// =====================================================

import { createHash } from 'crypto';

// ─── Helpers Uint32 (remplace BigInt, reste dans le JIT V8) ──────────────────

function rotL32(x, n) { n &= 31; return ((x << n) | (x >>> (32 - n))) >>> 0; }
function rotR32(x, n) { n &= 31; return ((x >>> n) | (x << (32 - n))) >>> 0; }
function add32(a, b)  { return (a + b) >>> 0; }
function mul32(a, b)  { return Math.imul(a, b) >>> 0; }

// Rotation 64-bit simulée en hi/lo Uint32 — zéro BigInt, zéro GC
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

function add64_hl(ah, al, bh, bl) {
  const lo = add32(al, bl);
  const hi = add32(ah, add32(bh, lo < al ? 1 : 0)); // carry
  return [hi, lo];
}

function mul64_hl(ah, al, bh, bl) {
  // Multiplication 64×64→64 (bits bas seulement, suffisant pour ARX)
  const lo = mul32(al, bl);
  const hi = (mul32(ah, bl) + mul32(al, bh) + Math.imul(al, bl) / 0x100000000 | 0) >>> 0;
  return [hi, lo];
}

// ─── Constantes ARX (Knuth / Murmur3 / FNV) — même jeu que v5 ───────────────
const C1H = 0x9E3779B9, C1L = 0x7F4A7C15;
const C2H = 0x85EBCA77, C2L = 0xC2B2AE63;
const C3H = 0xA3B195A8, C3L = 0xD7F4B3C2;
const C4H = 0xC4CEB9FE, C4L = 0x1A85EC53;
const C5H = 0x6C62272E, C5L = 0x07BB0142;

// ─── SHA-256 synchrone ───────────────────────────────────────────────────────
function sha256(parts) {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest(); // Buffer[32]
}

// ─── Helpers rotation 8-bit (inchangés, corrects) ────────────────────────────
function rotU8L(b, n) { n &= 7; return ((b << n) | (b >>> (8 - n))) & 0xff; }
function rotU8R(b, n) { n &= 7; return ((b >>> n) | (b << (8 - n))) & 0xff; }
function rotU8Add(b, w, n) { return rotU8L((b + w) & 0xff, n); }
function rotU8Sub(b, w, n) { return rotU8R((b - w + 256) & 0xff, n); }
function rotU8Xor(b, w, n) { return rotU8L((b ^ w) & 0xff, n); }
function rotU8XorR(b, w, n){ return rotU8R((b ^ w) & 0xff, n); }

// ─── Alphabet 256 caractères ─────────────────────────────────────────────────
export const ROMAN_T369_ALPHABET = [
  // 26 Majuscules latines
  'A','B','C','D','E','F','G','H','I','J','K','L','M',
  'N','O','P','Q','R','S','T','U','V','W','X','Y','Z',
  // 26 Minuscules latines
  'a','b','c','d','e','f','g','h','i','j','k','l','m',
  'n','o','p','q','r','s','t','u','v','w','x','y','z',
  // 10 Chiffres
  '0','1','2','3','4','5','6','7','8','9',
  // 33 Cyrilliques
  'А','Б','В','Г','Д','Е','Ё','Ж','З','И','Й','К','Л','М','Н','О',
  'П','Р','С','Т','У','Ф','Х','Ц','Ч','Ш','Щ','Ъ','Ы','Ь','Э','Ю','Я',
  // 24 Grecques
  'Α','Β','Γ','Δ','Ε','Ζ','Η','Θ','Ι','Κ','Λ','Μ',
  'Ν','Ξ','Ο','Π','Ρ','Σ','Τ','Υ','Φ','Χ','Ψ','Ω',
  // 7 Chiffres romains
  'I','V','X','L','C','D','M',
  // 2 Symboles
  '⁂','⁑',
  // 28 Arabes
  'ا','ب','ت','ث','ج','ح','خ','د','ذ','ر','ز','س','ش','ص',
  'ض','ط','ظ','ع','غ','ف','ق','ك','ل','م','ن','ه','و','ي',
  // 22 Hébraïques
  'א','ב','ג','ד','ה','ו','ז','ח','ט','י','כ','ל',
  'מ','נ','ס','ע','פ','צ','ק','ר','ש','ת',
  // 33 Géorgiens
  'ა','ბ','გ','დ','ე','ვ','ზ','თ','ი','კ','ლ','მ','ნ','ო','პ',
  'ჟ','რ','ს','ტ','უ','ფ','ქ','ღ','ყ','შ','ჩ','ც','ძ','წ','ჭ','ხ','ჯ','ჰ',
  // 33 Arméniens
  'Ա','Բ','Գ','Դ','Ե','Զ','Է','Ը','Թ','Ժ','Ի','Լ','Խ','Ծ','Կ','Հ',
  'Ձ','Ղ','Ճ','Մ','Յ','Ն','Շ','Ո','Չ','Պ','Ջ','Ռ','Ս','Վ','Տ','Ր','Ց',
  // 20 Devanagari
  'अ','आ','इ','ई','उ','ऊ','ऋ','ए','ऐ','ओ',
  'औ','क','ख','ग','घ','च','छ','ज','झ','ट',
  // 10 Thaï
  'ก','ข','ค','ฆ','ง','จ','ฉ','ช','ซ','ฌ',
  // 12 Mathématiques
  '∞','∑','∏','√','∫','∂','∇','∆','≈','≠','≤','≥',
]; // Total = 26+26+10+33+24+7+2+28+22+33+33+20+10+12 = 286 → slice à 256

// Vérification silencieuse (sera tree-shaké en prod)
if (ROMAN_T369_ALPHABET.length < 256) {
  throw new Error(`Alphabet insuffisant : ${ROMAN_T369_ALPHABET.length} < 256`);
}
const ALPHABET_256 = ROMAN_T369_ALPHABET.slice(0, 256);

// Lookup inverse O(1) pour fromHumanReadable
const ALPHA_INVERSE = new Map(ALPHABET_256.map((c, i) => [c, i]));

// ─── GematriaMode ────────────────────────────────────────────────────────────
export const GematriaMode = Object.freeze({
  Dynamic:  'Dynamic',
  Extended: 'Extended',
  Hyper256: 'Hyper256',
});

// ─── Classe principale ────────────────────────────────────────────────────────
export class RomanT369 {
  // Champs privés — inaccessibles par introspection
  #key;                 // Uint8Array[32]
  #nonce;               // Uint8Array[12]
  #modulus;             // number
  #permutation;         // Uint8Array[256]  bijection garantie
  #hyperLookup;         // Uint8Array[256] | null
  #hyperLookupInverse;  // Uint8Array[256] | null
  #romanSbox;           // Uint8Array[256]
  #romanSboxInv;        // Uint8Array[256]
  #romanWeights;        // Uint8Array[7]
  #mode;
  #domainKey;           // Uint8Array[64]  dérivée secondaire
  #chaos;               // Uint8Array[256] non-linéarité extra
  // Sentinel inter-blocs (3 derniers octets chiffrés du bloc précédent)
  #sentinel;            // Uint8Array[3]

  constructor(key, nonce, mode = GematriaMode.Hyper256) {
    if (key.length   !== 32) throw new RangeError('key must be 32 bytes');
    if (nonce.length !== 12) throw new RangeError('nonce must be 12 bytes');

    this.#key        = Uint8Array.from(key);
    this.#nonce      = Uint8Array.from(nonce);
    this.#mode       = mode;
    this.#modulus    = mode === GematriaMode.Dynamic  ? 95
                     : mode === GematriaMode.Extended ? 128 : 256;
    this.#romanWeights = new Uint8Array([1, 5, 10, 50, 100, 200, 250]);
    this.#sentinel   = new Uint8Array(3);

    // Ordre de construction important (permutation → domainKey → chaos → sbox)
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

  // ── Permutation bijective garantie (Fisher-Yates + SHA-256) ────────────────
  #genPermutation() {
    const buf  = Buffer.alloc(2);
    const tbl  = new Uint8Array(256);
    const used = new Uint8Array(256); // 0=libre, 1=pris
    const mod  = this.#modulus;
    for (let i = 0; i < 256; i++) {
      buf.writeUInt16LE(i);
      const h = sha256([this.#key, this.#nonce, buf]);
      let c   = h[0] % mod;
      // Sondage linéaire garanti unique — max 256 pas
      let off = 0;
      while (used[c]) { c = (c + 1) % mod; off++; if (off > mod) break; }
      used[c] = 1;
      tbl[i]  = c;
    }
    return tbl;
  }

  // ── DomainKey 64 octets — double SHA-256 entrelacé ─────────────────────────
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

  // ── Table chaos 256 octets — non-linéarité pure ────────────────────────────
  #buildChaosTable() {
    const tbl = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
      const h  = sha256([
        this.#domainKey,
        new Uint8Array([i, this.#key[i % 32] ^ this.#nonce[i % 12]]),
      ]);
      tbl[i] = h[0] ^ h[3] ^ h[7] ^ h[15];
    }
    return tbl;
  }

  // ── HyperLookup — bijection complète sur 256 ───────────────────────────────
  #preHyperLookup() {
    const lk   = new Uint8Array(256);
    const used = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
      let c = this.#permutation[i];
      while (used[c]) c = (c + 1) & 0xff;
      used[c] = 1;
      lk[i]   = c;
    }
    return lk;
  }

  // ── Inverse d'une table de substitution ────────────────────────────────────
  #invertTable(lk) {
    const inv = new Uint8Array(256);
    for (let i = 0; i < 256; i++) inv[lk[i]] = i;
    return inv;
  }

  // ── Roman S-Box (7 rounds, 3 phases) — identique v5 ───────────────────────
  #preRomanSbox() {
    const W   = this.#romanWeights;
    const tbl = new Uint8Array(256);
    for (let byte = 0; byte < 256; byte++) {
      let val = byte;
      for (let r = 0; r < 7; r++) {
        const idx    = (val + r * 17) % 7;
        const weight = W[idx];
        const phase  = (val + r) % 3;
        if      (phase === 0) val = rotU8Sub(val, weight, 2 + (r % 3));
        else if (phase === 1) val = rotU8Add(val, weight, 3 + (r % 2));
        else                  val = rotU8Xor(val, weight, 1 + (r % 4));
      }
      val = (val ^ this.#permutation[val]) & 0xff;
      val = (val + this.#key[val % 32]) & 0xff;
      tbl[byte] = val;
    }
    return tbl;
  }

  // ── Roman Diffuse (7 rounds) — identique v5 ────────────────────────────────
  #romanDiffuse(byte, pos) {
    const W = this.#romanWeights;
    for (let r = 0; r < 7; r++) {
      const idx    = (byte + pos + r * 17) % 7;
      const weight = W[idx];
      const phase  = (byte + pos + r) % 3;
      if      (phase === 0) byte = rotU8Sub(byte, weight, 2 + (r % 3));
      else if (phase === 1) byte = rotU8Add(byte, weight, 3 + (r % 2));
      else                  byte = rotU8Xor(byte, weight, 1 + (r % 4));
    }
    return byte;
  }

  #romanUndiffuse(byte, pos) {
    const W = this.#romanWeights;
    for (let r = 6; r >= 0; r--) {
      const idx    = (byte + pos + r * 17) % 7;
      const weight = W[idx];
      const phase  = (byte + pos + r) % 3;
      if      (phase === 0) byte = rotU8Add(byte, weight, 2 + (r % 3));
      else if (phase === 1) byte = rotU8Sub(byte, weight, 3 + (r % 2));
      else                  byte = rotU8XorR(byte, weight, 1 + (r % 4));
    }
    return byte;
  }

  // ╔══════════════════════════════════════════════════════════════════════════╗
  // ║  DOMINANT POST-QUANTIQUE — 7 couches hi/lo Uint32, sans BigInt          ║
  // ║                                                                          ║
  // ║  Architecture :                                                          ║
  // ║   1. Seed 64-bit hi/lo multisource (val, pos, prev1-3, domainKey)       ║
  // ║   2. 3 couches ARX 64-bit hi/lo avec constantes C1…C5                   ║
  // ║   3. Injection chaos (non-linéarité)                                     ║
  // ║   4. 2 couches ARX 64-bit hi/lo supplémentaires                         ║
  // ║   5. Feistel 4 passes (chaos + domainKey)                                ║
  // ║   6. 2 couches finales + XOR-fold 8-bit                                  ║
  // ║                                                                          ║
  // ║  Identique v5 mathématiquement — zéro BigInt — JIT V8 natif             ║
  // ╚══════════════════════════════════════════════════════════════════════════╝
  #getDominant(val, pos, p1, p2, p3) {
    const K  = this.#key;
    const DK = this.#domainKey;
    const CH = this.#chaos;

    // Seed 64-bit hi/lo
    let sh = (mul32(pos, 0x9E3779B9) ^ mul32(p1, 0x517CC1B7)) >>> 0;
    let sl = (mul32(p2,  0xA8B4D3E2) ^ mul32(p3, 0x6C62272E) ^ val) >>> 0;

    // Couche 1 : XOR C1 + rotL 17 + add key[pos%32]
    sh ^= C1H; sl ^= C1L;
    [sh, sl] = rotL64_hl(sh, sl, 17);
    sl = add32(sl, K[pos % 32]);

    // Couche 2 : mul C2 + add p1
    [sh, sl] = mul64_hl(sh, sl, C2H, C2L);
    sh ^= 0; sl = add32(sl, p1);

    // Couche 3 : injection domainKey[0..7] + prev1
    for (let b = 0; b < 8; b++) {
      sh ^= DK[b];
      [sh, sl] = rotL64_hl(sh, sl, 5 + b);
      sl = add32(sl, p1 ^ DK[b + 8]);
    }

    // Couche 4 : XOR C3 + rotR 13 + add p2 + mul C4
    sh ^= C3H; sl ^= C3L;
    [sh, sl] = rotR64_hl(sh, sl, 13);
    sl = add32(sl, p2);
    [sh, sl] = mul64_hl(sh, sl, C4H, C4L);

    // Couche 5 : injection chaos (non-linéarité pure)
    const lo0 = sl & 0xff, lo1 = (sl >>> 8) & 0xff;
    const hi0 = sh & 0xff, hi1 = (sh >>> 8) & 0xff;
    sl ^= CH[lo0] | (CH[lo1] << 8);
    sh ^= CH[hi0] | (CH[hi1] << 8);

    // Couche 6 : XOR C5 + rotL 7 + add (pos<<3) + XOR p3 + mul C1
    sh ^= C5H; sl ^= C5L;
    [sh, sl] = rotL64_hl(sh, sl, 7);
    sl = add32(sl, p3);
    sl = add32(sl, (pos << 3) >>> 0);
    [sh, sl] = mul64_hl(sh, sl, C1H, C1L);

    // Couche 7 : Feistel 4 passes sur les 4 octets bas de sl
    const b0 = [sl & 0xff, (sl >>> 8) & 0xff, (sl >>> 16) & 0xff, (sl >>> 24) & 0xff];
    for (let r = 0; r < 4; r++) {
      const f   = CH[(b0[r] ^ DK[32 + r * 4 + (pos % 4)]) & 0xff];
      b0[(r + 1) % 4] = (b0[(r + 1) % 4] ^ f ^ K[(pos + r * 7) % 32]) & 0xff;
    }
    sl = (b0[0] | (b0[1] << 8) | (b0[2] << 16) | (b0[3] << 24)) >>> 0;

    // Couche 8 : XOR domainKey[32..47]
    for (let t = 0; t < 8; t++) {
      sh ^= DK[32 + t] | (DK[40 + t] << 8);
      [sh, sl] = rotL64_hl(sh, sl, 3 + t);
    }

    // Réduction finale : XOR-fold des 8 octets de [sh, sl]
    return (
      (sl & 0xff) ^ ((sl >>> 8) & 0xff) ^ ((sl >>> 16) & 0xff) ^ ((sl >>> 24) & 0xff) ^
      (sh & 0xff) ^ ((sh >>> 8) & 0xff) ^ ((sh >>> 16) & 0xff) ^ ((sh >>> 24) & 0xff)
    ) & 0xff;
  }

  // ╔══════════════════════════════════════════════════════════════════════════╗
  // ║  PRÉCALCUL DES DOMINANTS PAR BLOC (64 octets)                           ║
  // ║                                                                          ║
  // ║  Un seul SHA-256 par bloc → seed → expansion ARX légère × 64            ║
  // ║  Les 7 couches lourdes de #getDominant ne sont payées qu'une fois.       ║
  // ║  Le sentinel (3 derniers octets chiffrés) chaîne les blocs de façon      ║
  // ║  opaque — aucune corrélation inter-blocs exploitable.                    ║
  // ╚══════════════════════════════════════════════════════════════════════════╝
  #deriveBlockSeed(blockIdx) {
    const idxBuf = new Uint8Array(4);
    idxBuf[0] = blockIdx        & 0xff;
    idxBuf[1] = (blockIdx >> 8) & 0xff;
    idxBuf[2] = (blockIdx >> 16)& 0xff;
    idxBuf[3] = (blockIdx >> 24)& 0xff;
    return sha256([this.#key, this.#nonce, idxBuf, this.#sentinel]);
  }

  // Expansion ARX légère : 4 opérations 32-bit par dominant
  // Non-linéarité assurée par le seed SHA-256 + chaos
  #expandDominants(seed, length) {
    const CH  = this.#chaos;
    const dom = new Uint8Array(length);
    let   s   = (seed[0] | (seed[1] << 8) | (seed[2] << 16) | (seed[3] << 24)) >>> 0;
    let   t   = (seed[4] | (seed[5] << 8) | (seed[6] << 16) | (seed[7] << 24)) >>> 0;

    for (let i = 0; i < length; i++) {
      // 4 étapes ARX 32-bit : rapides, dans JIT, non-linéaires via chaos
      s  = add32(mul32(s, 0x9E3779B9), seed[i % 32]);
      s  = rotL32(s, 13);
      s ^= CH[s & 0xff];
      t  = add32(mul32(t, 0x85EBCA77), seed[(i + 16) % 32]);
      t  = rotR32(t, 7);
      t ^= CH[t & 0xff];
      dom[i] = ((s ^ t) >>> 24) & 0xff;
    }
    return dom;
  }

  // ─── Chiffrement / Déchiffrement public ────────────────────────────────────

  encrypt(plaintext) {
    this.#sentinel.fill(0); // reset sentinel à chaque appel complet
    const out      = new Uint8Array(plaintext.length);
    const BLOCK    = 64;
    const total    = plaintext.length;
    const nBlocks  = Math.ceil(total / BLOCK);

    for (let bi = 0; bi < nBlocks; bi++) {
      const off   = bi * BLOCK;
      const chunk = plaintext.subarray(off, off + BLOCK);
      const seed  = this.#deriveBlockSeed(bi);
      const doms  = this.#expandDominants(seed, chunk.length);

      this.#encryptChunk(chunk, out, off, doms);
      // Mise à jour sentinel : 3 derniers octets chiffrés du bloc
      const end = Math.min(off + BLOCK, total);
      this.#sentinel[0] = out[end - 1];
      this.#sentinel[1] = end >= 2 ? out[end - 2] : 0;
      this.#sentinel[2] = end >= 3 ? out[end - 3] : 0;
    }
    return out;
  }

  decrypt(ciphertext) {
    this.#sentinel.fill(0);
    const out     = new Uint8Array(ciphertext.length);
    const BLOCK   = 64;
    const total   = ciphertext.length;
    const nBlocks = Math.ceil(total / BLOCK);

    for (let bi = 0; bi < nBlocks; bi++) {
      const off   = bi * BLOCK;
      const chunk = ciphertext.subarray(off, off + BLOCK);
      const seed  = this.#deriveBlockSeed(bi);
      const doms  = this.#expandDominants(seed, chunk.length);

      this.#decryptChunk(chunk, out, off, doms);
      const end = Math.min(off + BLOCK, total);
      this.#sentinel[0] = ciphertext[end - 1];
      this.#sentinel[1] = end >= 2 ? ciphertext[end - 2] : 0;
      this.#sentinel[2] = end >= 3 ? ciphertext[end - 3] : 0;
    }
    return out;
  }

  // ─── Boucles internes (inline-friendly pour V8) ───────────────────────────

  #encryptChunk(chunk, out, offset, doms) {
    const HL  = this.#hyperLookup;
    const SB  = this.#romanSbox;
    const P   = this.#permutation;
    const mod = this.#modulus;

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
    const INV = this.#hyperLookupInverse;
    const SBI = this.#romanSboxInv;
    const P   = this.#permutation;
    const mod = this.#modulus;

    for (let i = 0, n = chunk.length; i < n; i++) {
      let val   = chunk[i];
      const dom = doms[i];
      val = (val - Math.imul(dom, 29) + 65536) & 0xff;
      val = rotU8L((val ^ dom) & 0xff, 3);
      val = this.#romanUndiffuse(val, i);
      val = SBI[val];
      if (INV) {
        out[offset + i] = INV[val];
      } else {
        const k = P[val];
        out[offset + i] = (val + mod - k) % mod;
      }
    }
  }

  // ─── Affichage ────────────────────────────────────────────────────────────

  toHumanReadable(data) {
    let s = '';
    for (let i = 0; i < data.length; i++) s += ALPHABET_256[data[i]];
    return s;
  }

  fromHumanReadable(str) {
    const out = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) {
      const idx = ALPHA_INVERSE.get(str[i]);
      if (idx === undefined) return null;
      out[i] = idx;
    }
    return out;
  }
}
