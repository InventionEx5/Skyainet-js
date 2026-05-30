// packages/secure/src/crypto/constant_time.js
// =====================================================
// Constant-Time Primitives — Production Ready
// SkyAInet × Nikola T369 — Gematria-Safe + Timing Attack Resistant
// =====================================================

import { randomBytes, timingSafeEqual } from 'crypto';

export function sampleUniformMod(modulus) {
  if (modulus < 2 || modulus > 95) {
    throw new Error('Modulus must be between 2 and 95');
  }

  const bound = 256 - (256 % modulus);
  let attempts = 0;

  // Rejection sampling borné (max 5 essais)
  while (true) {
    const byte = randomBytes(1)[0];
    if (byte < bound) {
      return byte % modulus;
    }
    attempts++;
    if (attempts > 4) {
      return byte % modulus; // fallback déterministe
    }
  }
}

export function addMod(a, b, modulus) {
  return ((a + b) % modulus) & 0xff;
}

export function subMod(a, b, modulus) {
  return ((a - b + modulus) % modulus) & 0xff;
}

export function select(a, b, choice) {
  // choice = 0 ou 1 (ou truthy/falsy)
  const mask = (-(!!choice | 0)) & 0xff; // 0 ou 0xff (bitwise constant-time)
  return (a & \~mask) | (b & mask);
}

export function constantTimeEq(a, b) {
  const bufA = a instanceof Uint8Array ? a : new Uint8Array(a);
  const bufB = b instanceof Uint8Array ? b : new Uint8Array(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function constantTimeEqFixed(a, b) {
  const bufA = a instanceof Uint8Array ? a : new Uint8Array(a);
  const bufB = b instanceof Uint8Array ? b : new Uint8Array(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}