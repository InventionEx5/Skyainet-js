// packages/secure/src/crypto/constant_time.js
// =====================================================
// Constant-Time Primitives — Production Ready
// SkyAInet × Nikola T369 — Timing Attack Resistant
// =====================================================

import { randomBytes, timingSafeEqual } from 'crypto';

const toU8 = (x) => x instanceof Uint8Array ? x : new Uint8Array(x);

// Échantillonnage uniforme mod n via rejection sampling non biaisé.
// Boucle jusqu'à obtenir une valeur dans la zone non biaisée (pas de fallback
// déterministe qui réintroduirait un biais statistique exploitable).
export function sampleUniformMod(modulus) {
  if (modulus < 2 || modulus > 95) throw new Error('Modulus must be between 2 and 95');
  const bound = 256 - (256 % modulus);
  // Tire par lots pour limiter les appels à randomBytes
  while (true) {
    const batch = randomBytes(16);
    for (let i = 0; i < 16; i++) if (batch[i] < bound) return batch[i] % modulus;
  }
}

export function addMod(a, b, modulus) { return ((a + b) % modulus) & 0xff; }
export function subMod(a, b, modulus) { return ((a - b + modulus) % modulus) & 0xff; }

// Sélection sans branche : choice falsy → a, choice truthy → b
export function select(a, b, choice) {
  const mask = (-((choice ? 1 : 0))) & 0xff; // 0x00 ou 0xff
  return ((a & (~mask & 0xff)) | (b & mask)) & 0xff;
}

export function constantTimeEq(a, b) {
  const bufA = toU8(a), bufB = toU8(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// Alias historique
export const constantTimeEqFixed = constantTimeEq;
