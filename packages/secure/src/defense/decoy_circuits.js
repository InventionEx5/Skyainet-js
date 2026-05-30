// packages/secure/src/defense/decoy_circuits.js
// =====================================================
// Decoy Circuits — Faux Circuits DiamantRoots (Deception Layer)
// SkyAInet × Nikola T369
// =====================================================

import { RomanT369, GematriaMode } from '../crypto/roman_t369.js';
import { hkdfSha256 } from '../crypto/sha_fips.js';

export class DecoyCircuit {
  constructor(id, fakeNodes, fakeSharedSecrets, createdAt, realismScore, latencyMs, nodeReputation) {
    this.id = id;
    this.fakeNodes = fakeNodes;               // string[] (ex: "10.42.17.89:41234")
    this.fakeSharedSecrets = fakeSharedSecrets; // Uint8Array[]
    this.createdAt = createdAt;
    this.realismScore = realismScore;
    this.latencyMs = latencyMs;
    this.nodeReputation = nodeReputation;
  }
}

export class DecoyCircuitManager {
  constructor(maxDecoys = 50) {
    this.decoys = [];
    this.maxDecoys = maxDecoys;
    this.roman = new RomanT369(new Uint8Array(32).fill(0x42), new Uint8Array(12), GematriaMode.Hyper256);
  }

  /**
   * Génère des circuits leurres réalistes et crédibles
   */
  generateDecoyCircuits(count) {
    const newDecoys = [];

    for (let i = 0; i < Math.min(count, this.maxDecoys - this.decoys.length); i++) {
      const nodeCount = Math.floor(Math.random() * 4) + 3; // 3 à 6 nœuds
      const fakeNodes = [];
      const fakeSecrets = [];

      for (let j = 0; j < nodeCount; j++) {
        const ip = `\( {Math.floor(Math.random() * 191) + 10}. \){Math.floor(Math.random() * 256)}.\( {Math.floor(Math.random() * 256)}. \){Math.floor(Math.random() * 256)}`;
        const port = Math.floor(Math.random() * 25001) + 40000;
        fakeNodes.push(`\( {ip}: \){port}`);

        const base = new Uint8Array(32);
        crypto.getRandomValues(base);
        const encrypted = this.roman.encrypt(base);
        const finalSecret = hkdfSha256(encrypted, new TextEncoder().encode('DECOY'), new TextEncoder().encode('shared-secret'), 32);
        fakeSecrets.push(finalSecret);
      }

      const realism = this.#calculateRealismScore(nodeCount, fakeNodes);

      const circuit = new DecoyCircuit(
        Math.floor(Math.random() * 0xFFFFFFFF),
        fakeNodes,
        fakeSecrets,
        Math.floor(Date.now() / 1000),
        realism,
        Math.floor(Math.random() * 136) + 45,
        Math.random() * 0.21 + 0.75
      );

      this.decoys.push(circuit);
      newDecoys.push(circuit);
    }

    console.info(`[DecoyCircuitManager] ${newDecoys.length} circuits leurres générés (total: ${this.decoys.length})`);
    return newDecoys;
  }

  #calculateRealismScore(nodeCount, nodes) {
    let score = 0.75;

    const uniquePorts = new Set(nodes.map(n => n.split(':')[1]));
    if (uniquePorts.size > 2) score += 0.08;

    if (nodeCount >= 4) score += 0.07;

    return Math.min(0.98, score);
  }

  /**
   * Retourne un circuit leurre aléatoire
   */
  getRandomDecoy() {
    if (this.decoys.length === 0) return null;
    const idx = Math.floor(Math.random() * this.decoys.length);
    return this.decoys[idx];
  }

  /**
   * Retourne plusieurs leurres pour injection
   */
  getDecoyBatch(count) {
    const result = [];
    for (let i = 0; i < Math.min(count, this.decoys.length); i++) {
      const idx = Math.floor(Math.random() * this.decoys.length);
      result.push(this.decoys[idx]);
    }
    return result;
  }

  /**
   * Nettoie les leurres trop anciens
   */
  cleanupOldDecoys(maxAgeSeconds) {
    const now = Math.floor(Date.now() / 1000);
    const before = this.decoys.length;
    this.decoys = this.decoys.filter(d => now - d.createdAt < maxAgeSeconds);

    if (before !== this.decoys.length) {
      console.debug(`[DecoyCircuitManager] ${before - this.decoys.length} leurres expirés nettoyés`);
    }
  }

  totalDecoys() {
    return this.decoys.length;
  }
}