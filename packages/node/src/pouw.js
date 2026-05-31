// packages/node/src/pouw.js
// PoUWEngine — Proof of Useful Work Avancé
// Gematria Flash + ZipMemory + Thevie Orchestration + Rewards Dynamiques
// Intégré avec PeerReputation pour pondération intelligente des contributions

import { DreamScoring } from './dream_scoring.js';
import { ZipMemory } from '../../memory/src/zip_memory.js';
import { UserRewards, RewardReason } from '../../core/src/rewards.js';
import { PeerReputation } from '../../secure/src/roots/reputation.js';
import { randomUUID } from 'crypto';

export class ContributionProof {
  constructor(nodeId, contributionType, score, metadata = null, thevieBoost = 0, compressedSize = 0) {
    this.nodeId = nodeId;
    this.contributionType = contributionType;
    this.score = Math.max(0, Math.min(1, score));
    this.timestamp = Date.now();
    this.proofHash = `pouw:${randomUUID()}`;
    this.epoch = 0;
    this.metadata = metadata;
    this.thevieBoost = thevieBoost;
    this.compressedSize = compressedSize;
  }

  toJSON() {
    return { ...this };
  }
}

export class PoUWStats {
  constructor() {
    this.totalContributions = 0;
    this.totalRewardsDistributed = 0;
    this.averageScore = 0;
    this.topContributors = [];
    this.currentEpoch = 0;
    this.activeNodes = 0;
  }
}

export class PoUWEngine {
  #contributions = new Map();
  #totalRewardsPool = 0;
  #currentEpoch = 0;
  #epochRewards = new Map();
  #thevieBoosts = new Map();
  #peerReputations = new Map(); // nodeId → PeerReputation
  #statsCache = null;
  #lastStatsUpdate = 0;
  #proofStorage;

  constructor() {
    this.#proofStorage = new ZipMemory('./data/pouw_proofs');
  }

  // =====================================================
  // ENREGISTREMENT DE CONTRIBUTION (avec pondération réputation)
  // =====================================================
  async recordContribution(nodeId, contributionType, score, metadata = null, rawData = null, rewards = null) {
    const clampedScore = Math.max(0, Math.min(1, score));
    const thevieBoost = this.#thevieBoosts.get(nodeId) ?? 0;

    // === NOUVELLE LOGIQUE : Pondération par réputation ===
    let rep = this.#peerReputations.get(nodeId);
    if (!rep) {
      rep = new PeerReputation();
      this.#peerReputations.set(nodeId, rep);
    }

    // Boost léger pour contribution utile
    rep.recordSuccess(0.035);

    // Multiplicateur de réputation (0.85 → 1.25)
    const reputationMultiplier = 0.85 + (rep.score * 0.4);

    let compressedSize = 0;
    if (rawData && this.#proofStorage?.compress) {
      try {
        const compressed = await this.#proofStorage.compress(rawData);
        compressedSize = compressed.length;
      } catch {
        compressedSize = rawData.length;
      }
    }

    const proof = new ContributionProof(
      nodeId,
      contributionType,
      clampedScore,
      metadata,
      thevieBoost,
      compressedSize
    );
    proof.epoch = this.#currentEpoch;

    if (!this.#contributions.has(nodeId)) {
      this.#contributions.set(nodeId, []);
    }
    this.#contributions.get(nodeId).push(proof);

    this.#statsCache = null;

    // Récompense avec pondération réputation
    if (rewards instanceof UserRewards) {
      const baseReward = Math.floor(clampedScore * 12 * reputationMultiplier);
      rewards.addReward(RewardReason.PoUWContribution, baseReward);
    }

    console.debug(
      `PoUW | Node: ${nodeId.slice(0, 8)} | Type: ${contributionType} | Score: ${clampedScore.toFixed(3)} | Rep: ${rep.score.toFixed(2)} | Boost: ${thevieBoost.toFixed(2)}x`
    );

    return proof;
  }

  // =====================================================
  // THEVIE BOOST
  // =====================================================
  applyThevieBoost(nodeId, boost) {
    const clamped = Math.max(0, Math.min(2.5, boost));
    this.#thevieBoosts.set(nodeId, clamped);
    console.info(`Thevie Boost → \( {nodeId.slice(0, 8)} : + \){clamped.toFixed(2)}x`);
  }

  // =====================================================
  // CALCUL DE RÉCOMPENSE (avec pondération réputation)
  // =====================================================
  calculateNodeReward(nodeId) {
    const contribs = this.#contributions.get(nodeId) ?? [];
    if (contribs.length === 0) return 0;

    const nodeScore = contribs.reduce((sum, p) => sum + p.score * (1 + p.thevieBoost), 0);

    let globalScore = 0;
    for (const list of this.#contributions.values()) {
      for (const p of list) {
        globalScore += p.score * (1 + p.thevieBoost);
      }
    }

    if (globalScore < 0.0001) return 0;

    const base = (nodeScore / globalScore) * this.#totalRewardsPool;
    const loyalty = this.#calculateLoyaltyBonus(nodeId);

    // === NOUVELLE LOGIQUE : Pondération finale par réputation ===
    const rep = this.#peerReputations.get(nodeId);
    const reputationBonus = rep ? (0.9 + rep.score * 0.3) : 1.0;

    return Math.floor(base * loyalty * reputationBonus);
  }

  #calculateLoyaltyBonus(nodeId) {
    const contribs = this.#contributions.get(nodeId);
    if (!contribs || contribs.length < 8) return 1.0;

    const oldest = Math.min(...contribs.map(c => c.timestamp));
    const ageDays = (Date.now() - oldest) / (1000 * 60 * 60 * 24);
    return 1 + Math.min(ageDays / 420, 0.65);
  }

  addToRewardsPool(amount) {
    this.#totalRewardsPool += amount;
    this.#epochRewards.set(this.#currentEpoch, amount);
  }

  onNewEpoch(epoch) {
    this.#currentEpoch = epoch;
    this.#statsCache = null;
    console.info(`New PoUW Epoch: ${epoch}`);
  }

  getTotalScore() {
    let total = 0;
    for (const list of this.#contributions.values()) {
      for (const p of list) {
        total += p.score * (1 + p.thevieBoost);
      }
    }
    return total;
  }

  getGlobalStats() {
    const now = Date.now();
    if (this.#statsCache && (now - this.#lastStatsUpdate) < 180000) {
      return this.#statsCache;
    }

    let totalContribs = 0;
    let totalScore = 0;

    for (const list of this.#contributions.values()) {
      totalContribs += list.length;
      for (const p of list) {
        totalScore += p.score * (1 + p.thevieBoost);
      }
    }

    const avgScore = totalContribs > 0 ? totalScore / totalContribs : 0;

    const top = Array.from(this.#contributions.entries())
      .map(([id, list]) => {
        const score = list.reduce((s, p) => s + p.score * (1 + p.thevieBoost), 0);
        return [id, score];
      })
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);

    const stats = new PoUWStats();
    stats.totalContributions = totalContribs;
    stats.totalRewardsDistributed = this.#totalRewardsPool;
    stats.averageScore = avgScore;
    stats.topContributors = top;
    stats.currentEpoch = this.#currentEpoch;
    stats.activeNodes = this.#contributions.size;

    this.#statsCache = stats;
    this.#lastStatsUpdate = now;

    return stats;
  }

  pruneOldContributions(maxAgeDays = 90) {
    const cutoff = Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000);

    for (const [nodeId, list] of this.#contributions) {
      const filtered = list.filter(p => p.timestamp > cutoff);
      if (filtered.length === 0) {
        this.#contributions.delete(nodeId);
      } else {
        this.#contributions.set(nodeId, filtered);
      }
    }

    this.#statsCache = null;
    console.debug(`PoUW pruned contributions older than ${maxAgeDays} days`);
  }
}