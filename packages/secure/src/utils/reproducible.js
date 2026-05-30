// packages/secure/src/utils/reproducible.js
// =====================================================
// Reproducible Utilities — RNG et Hash Déterministes
// Compatible avec Contact, DID, Groupes et Tests
// SkyAInet × Nikola T369
// =====================================================

/**
 * SplitMix64 — Générateur pseudo-aléatoire déterministe très rapide
 * (excellent pour la reproductibilité)
 */
function createSplitMix64(seed) {
  let state = BigInt(seed) | 0n;

  return {
    next() {
      state = (state + 0x9E3779B97F4A7C15n) & 0xFFFFFFFFFFFFFFFFn;
      let z = state;
      z = (z ^ (z >> 30n)) * 0xBF58476D1CE4E5B9n & 0xFFFFFFFFFFFFFFFFn;
      z = (z ^ (z >> 27n)) * 0x94D049BB133111EBn & 0xFFFFFFFFFFFFFFFFn;
      z = z ^ (z >> 31n);
      return Number(z & 0xFFFFFFFFn); // retourne un u32
    },
    nextBytes(length) {
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i++) {
        bytes[i] = this.next() & 0xFF;
      }
      return bytes;
    }
  };
}

/**
 * Crée un générateur de nombres aléatoires reproductible à partir d’une graine
 */
export function createReproducibleRng(seed) {
  return createSplitMix64(seed);
}

/**
 * Calcule un hash déterministe (u64) à partir de données
 */
export function deterministicHash(data) {
  let hash = 0xcbf29ce484222325n; // FNV-1a 64-bit offset basis

  for (let i = 0; i < data.length; i++) {
    hash ^= BigInt(data[i]);
    hash = (hash * 0x100000001b3n) & 0xFFFFFFFFFFFFFFFFn;
  }

  return Number(hash & 0xFFFFFFFFn); // retourne u32 pour simplicité
}

/**
 * Génère un tableau d’octets déterministe à partir d’une graine
 */
export function generateDeterministicBytes(seed, length) {
  const rng = createSplitMix64(seed);
  const bytes = rng.nextBytes(length);

  console.debug(`[Reproducible] ${length} octets générés avec la graine ${seed}`);
  return bytes;
}