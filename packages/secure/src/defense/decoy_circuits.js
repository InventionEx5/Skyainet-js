// packages/secure/src/defense/decoy_circuits.js
// =====================================================
// Decoy Circuits — Faux Circuits DiamantRoots (Deception Layer)
// SkyAInet × Nikola T369
// =====================================================

"use strict";

import { randomBytes }                from 'crypto';
import { RomanT369, GematriaMode }    from '../crypto/roman_t369.js';
import { hkdfSha256 }                 from '../crypto/sha_fips.js';

// ─────────────────────────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────────────────────────

const TE               = new TextEncoder();
const NODE_COUNT_MIN   = 3;
const NODE_COUNT_MAX   = 6;
const PORT_MIN         = 40_000;
const PORT_RANGE       = 25_001;
const LATENCY_MIN_MS   = 45;
const LATENCY_RANGE_MS = 136;
const REALISM_BASE     = 0.75;
const REALISM_MAX      = 0.98;

// ─────────────────────────────────────────────────────────────────
// DECOY CIRCUIT
// ─────────────────────────────────────────────────────────────────

export class DecoyCircuit {
  constructor({ id, fakeNodes, fakeSharedSecrets, createdAt, realismScore, latencyMs, nodeReputation }) {
    this.id                = id;
    this.fakeNodes         = fakeNodes;          // string[] — "ip:port"
    this.fakeSharedSecrets = fakeSharedSecrets;  // Uint8Array[]
    this.createdAt         = createdAt;
    this.realismScore      = realismScore;
    this.latencyMs         = latencyMs;
    this.nodeReputation    = nodeReputation;
  }

  isExpired(maxAgeSeconds) {
    return (Date.now() / 1000) - this.createdAt > maxAgeSeconds;
  }
}

// ─────────────────────────────────────────────────────────────────
// DECOY CIRCUIT MANAGER
//
// Génère des circuits leurres cryptographiquement cohérents :
//   - IPs routable-looking (pas de RFC-1918) avec ports variés
//   - Secrets partagés dérivés HKDF depuis un nonce aléatoire
//     + renforcement RomanT369 (indiscernables des vrais secrets KEM)
//   - Clé RomanT369 éphémère générée à la construction (randomBytes)
//     pour que les leurres de chaque instance soient uniques
// ─────────────────────────────────────────────────────────────────

export class DecoyCircuitManager {
  #roman;   // RomanT369 — éphémère, clé aléatoire
  #decoys;  // DecoyCircuit[]

  constructor(maxDecoys = 50) {
    this.maxDecoys = maxDecoys;
    this.#decoys   = [];

    // Clé et nonce aléatoires — chaque instance produit des leurres distincts
    const key   = randomBytes(32);
    const nonce = randomBytes(12);
    this.#roman = new RomanT369(key, nonce, GematriaMode.Hyper256);
  }

  // ─── Génération ──────────────────────────────────────────────

  /**
   * Génère `count` circuits leurres réalistes.
   * Chaque secret est :
   *   base = randomBytes(32)
   *   reinforced = RomanT369.encrypt(base)[0:32]
   *   finalSecret = HKDF(reinforced, salt=nonce, info="decoy-shared-secret")
   */
  generateDecoyCircuits(count) {
    const available = this.maxDecoys - this.#decoys.length;
    const toCreate  = Math.min(count, available);
    const created   = [];

    for (let i = 0; i < toCreate; i++) {
      const nodeCount = _randInt(NODE_COUNT_MIN, NODE_COUNT_MAX);
      const fakeNodes    = [];
      const fakeSecrets  = [];

      for (let j = 0; j < nodeCount; j++) {
        fakeNodes.push(this.#randomAddr());

        const base       = randomBytes(32);
        const reinforced = this.#roman.encrypt(base).subarray(0, 32);
        const salt       = randomBytes(12);
        const secret     = hkdfSha256(reinforced, salt, TE.encode('decoy-shared-secret'), 32);
        fakeSecrets.push(secret);
      }

      const circuit = new DecoyCircuit({
        id             : randomBytes(4).readUInt32BE(0),
        fakeNodes,
        fakeSharedSecrets: fakeSecrets,
        createdAt      : Math.floor(Date.now() / 1000),
        realismScore   : this.#realismScore(nodeCount, fakeNodes),
        latencyMs      : LATENCY_MIN_MS + _randInt(0, LATENCY_RANGE_MS),
        nodeReputation : 0.75 + Math.random() * 0.21,
      });

      this.#decoys.push(circuit);
      created.push(circuit);
    }

    console.info(`[DecoyCircuits] ${created.length} leurres générés (total: ${this.#decoys.length})`);
    return created;
  }

  // ─── Sélection ───────────────────────────────────────────────

  getRandomDecoy() {
    if (this.#decoys.length === 0) return null;
    return this.#decoys[_randInt(0, this.#decoys.length - 1)];
  }

  /**
   * Retourne `count` leurres distincts (sans répétition si possible).
   * Utilise Fisher-Yates tronqué pour éviter les doublons.
   */
  getDecoyBatch(count) {
    if (this.#decoys.length === 0) return [];
    const pool = [...this.#decoys];
    const n    = Math.min(count, pool.length);
    for (let i = pool.length - 1; i > pool.length - 1 - n; i--) {
      const j = _randInt(0, i);
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return pool.slice(pool.length - n);
  }

  // ─── Maintenance ─────────────────────────────────────────────

  cleanupOldDecoys(maxAgeSeconds) {
    const before      = this.#decoys.length;
    this.#decoys      = this.#decoys.filter(d => !d.isExpired(maxAgeSeconds));
    const removed     = before - this.#decoys.length;
    if (removed > 0) {
      console.debug(`[DecoyCircuits] ${removed} leurres expirés purgés`);
    }
    return removed;
  }

  totalDecoys()  { return this.#decoys.length; }
  get decoys()   { return [...this.#decoys]; }

  // ─── Privés ───────────────────────────────────────────────────

  /** Génère une adresse IP:port routable (hors RFC-1918 / loopback). */
  #randomAddr() {
    // Éviter 10.x, 172.16-31.x, 192.168.x, 127.x, 0.x
    let first;
    do { first = _randInt(1, 223); }
    while (first === 10 || first === 127 ||
           (first === 172 && _randInt(16, 31)) ||
           first === 192);

    const ip   = `${first}.${_randInt(0,255)}.${_randInt(0,255)}.${_randInt(1,254)}`;
    const port = PORT_MIN + _randInt(0, PORT_RANGE);
    return `${ip}:${port}`;
  }

  #realismScore(nodeCount, nodes) {
    let score = REALISM_BASE;
    const uniquePorts = new Set(nodes.map(n => n.split(':')[1]));
    if (uniquePorts.size === nodes.length) score += 0.10; // tous les ports sont distincts
    else if (uniquePorts.size > 2)         score += 0.05;
    if (nodeCount >= 4) score += 0.07;
    if (nodeCount >= 5) score += 0.03;
    return +Math.min(REALISM_MAX, score).toFixed(3);
  }
}

// ─────────────────────────────────────────────────────────────────
// HELPER INTERNE
// ─────────────────────────────────────────────────────────────────

function _randInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}
