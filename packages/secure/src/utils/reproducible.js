// packages/secure/src/utils/reproducible.js
// =====================================================
// Reproducible Utilities — RNG et Hash Déterministes
// SkyAInet × Nikola T369
// =====================================================

"use strict";

// ─────────────────────────────────────────────────────────────────
// SPLITM IX64 — PRNG déterministe
//
// Algorithme SplitMix64 (Sebastiano Vigna, 2015).
// Période 2^64, excellent équilibre entre vitesse et qualité
// statistique. Idéal pour la reproductibilité dans les tests
// et la génération de clés de test déterministes.
// ─────────────────────────────────────────────────────────────────

function createSplitMix64(seed) {
  // BigInt pour préserver la précision sur 64 bits
  let state = BigInt(seed) & 0xFFFFFFFFFFFFFFFFn;

  function next() {
    state = (state + 0x9E3779B97F4A7C15n) & 0xFFFFFFFFFFFFFFFFn;
    let z = state;
    z = ((z ^ (z >> 30n)) * 0xBF58476D1CE4E5B9n) & 0xFFFFFFFFFFFFFFFFn;
    z = ((z ^ (z >> 27n)) * 0x94D049BB133111EBn) & 0xFFFFFFFFFFFFFFFFn;
    z = z ^ (z >> 31n);
    return z;   // BigInt 64 bits
  }

  return {
    /** Retourne un entier u32 [0, 2^32) */
    nextU32() { return Number(next() & 0xFFFFFFFFn); },

    /** Retourne un flottant [0, 1) */
    nextFloat() { return this.nextU32() / 0x100000000; },

    /** Retourne un entier [min, max] inclus */
    nextRange(min, max) {
      return min + (this.nextU32() % (max - min + 1));
    },

    /** Génère `length` octets aléatoires déterministes */
    nextBytes(length) {
      const out = new Uint8Array(length);
      for (let i = 0; i < length; i += 4) {
        const u32 = this.nextU32();
        out[i]     =  u32        & 0xFF;
        if (i + 1 < length) out[i + 1] = (u32 >>  8) & 0xFF;
        if (i + 2 < length) out[i + 2] = (u32 >> 16) & 0xFF;
        if (i + 3 < length) out[i + 3] = (u32 >> 24) & 0xFF;
      }
      return out;
    },

    /** Mélange un tableau en place (Fisher-Yates déterministe) */
    shuffle(arr) {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = this.nextU32() % (i + 1);
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr;
    },

    /** Retourne l'état courant (pour sérialisation) */
    getState() { return state; },

    /** Restaure un état précédent */
    setState(s) { state = BigInt(s) & 0xFFFFFFFFFFFFFFFFn; },
  };
}

// ─────────────────────────────────────────────────────────────────
// API PUBLIQUE
// ─────────────────────────────────────────────────────────────────

/**
 * Crée un générateur pseudo-aléatoire déterministe (SplitMix64).
 * @param {number|bigint} seed
 */
export function createReproducibleRng(seed) {
  return createSplitMix64(seed);
}

/**
 * Hash déterministe FNV-1a 64 bits réduit à u32.
 * Rapide, sans collision connue sur les petites données.
 * Non cryptographique — usage : identifiants, tables de dispatch.
 *
 * @param {Uint8Array} data
 * @returns {number} u32
 */
export function deterministicHash(data) {
  let hash = 0xcbf29ce484222325n;   // FNV offset basis 64-bit
  const FNV_PRIME = 0x100000001b3n;
  const MASK64    = 0xFFFFFFFFFFFFFFFFn;

  for (let i = 0; i < data.length; i++) {
    hash = ((hash ^ BigInt(data[i])) * FNV_PRIME) & MASK64;
  }

  return Number(hash & 0xFFFFFFFFn);
}

/**
 * Hash FNV-1a sur une chaîne UTF-8 (commodité).
 * @param {string} str
 * @returns {number} u32
 */
export function deterministicHashStr(str) {
  return deterministicHash(new TextEncoder().encode(str));
}

/**
 * Génère `length` octets déterministes à partir d'une graine.
 * @param {number|bigint} seed
 * @param {number}        length
 * @returns {Uint8Array}
 */
export function generateDeterministicBytes(seed, length) {
  if (length < 0) throw new RangeError('length doit être ≥ 0');
  const rng   = createSplitMix64(seed);
  const bytes = rng.nextBytes(length);
  console.debug(`[Reproducible] ${length} octets générés — graine: ${seed}`);
  return bytes;
}

/**
 * Dérive une graine entière depuis des données arbitraires.
 * Utile pour enchaîner un hash déterministe avec un RNG.
 * @param {Uint8Array|string} data
 * @returns {number} graine u32
 */
export function seedFromData(data) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return deterministicHash(bytes);
}
