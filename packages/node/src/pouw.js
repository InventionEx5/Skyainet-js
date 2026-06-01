// packages/node/src/pouw.js
// PoUWEngine — Proof of Useful Work
// Gematria Flash + ZipMemory + Thevie Orchestration + Rewards Dynamiques
// SkyAInet × Nikola T369

"use strict";

import { randomUUID }   from 'crypto';
import { ZipMemory }    from '../../memory/src/zip_memory.js';
import { UserRewards }  from '../../core/src/rewards.js';

// ─────────────────────────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────────────────────────

const STATS_CACHE_TTL_MS = 180_000;   // 3 min
const MAX_THEVIE_BOOST   = 2.5;
const MAX_LOYALTY_BONUS  = 0.65;      // +65 % max après 420 jours
const LOYALTY_DAYS       = 420;
const PRUNE_DEFAULT_DAYS = 90;
const BASE_REWARD_UNIT   = 12;        // SKY de base par unité de score

// ─────────────────────────────────────────────────────────────────
// CONTRIBUTION PROOF
// ─────────────────────────────────────────────────────────────────

export class ContributionProof {
  constructor(nodeId, contributionType, score, metadata = null, thevieBoost = 0, compressedSize = 0) {
    this.nodeId           = nodeId;
    this.contributionType = contributionType;
    this.score            = Math.max(0, Math.min(1, score));
    this.timestamp        = Date.now();
    this.proofHash        = `pouw:${randomUUID()}`;
    this.epoch            = 0;
    this.metadata         = metadata;
    this.thevieBoost      = Math.max(0, Math.min(MAX_THEVIE_BOOST, thevieBoost));
    this.compressedSize   = compressedSize;
  }

  /** Score effectif incluant le boost Thevie */
  get effectiveScore() { return this.score * (1 + this.thevieBoost); }

  toJSON() { return { ...this }; }

  static fromJSON(obj) {
    const p = new ContributionProof(
      obj.nodeId, obj.contributionType, obj.score ?? 0,
      obj.metadata ?? null, obj.thevieBoost ?? 0, obj.compressedSize ?? 0
    );
    p.timestamp   = obj.timestamp  ?? Date.now();
    p.proofHash   = obj.proofHash  ?? `pouw:${randomUUID()}`;
    p.epoch       = obj.epoch      ?? 0;
    return p;
  }
}

// ─────────────────────────────────────────────────────────────────
// DREAM SCORING
//
// DreamScoring n'existe pas dans le projet — implémenté ici.
// Suit les scores des cycles de rêve par nœud pour calculer
// une contribution pondérée dans le PoUW.
// ─────────────────────────────────────────────────────────────────

export class DreamScoring {
  #scores = [];     // { nodeId, score, ts }[]
  #total  = 0;

  recordDream(score, nodeId = 'local') {
    const s = Math.max(0, Math.min(1, score));
    this.#scores.push({ nodeId, score: s, ts: Date.now() });
    this.#total += s;
    // Plafonner le buffer à 1024 entrées
    if (this.#scores.length > 1024) {
      this.#total -= this.#scores.shift().score;
    }
  }

  getTotalScore() { return this.#total; }

  getAverageScore() {
    return this.#scores.length > 0 ? this.#total / this.#scores.length : 0;
  }

  getScoreForNode(nodeId) {
    return this.#scores
      .filter(s => s.nodeId === nodeId)
      .reduce((sum, s) => sum + s.score, 0);
  }

  prune(maxAgeDays = PRUNE_DEFAULT_DAYS) {
    const cutoff = Date.now() - maxAgeDays * 86_400_000;
    this.#scores  = this.#scores.filter(s => s.ts > cutoff);
    this.#total   = this.#scores.reduce((sum, s) => sum + s.score, 0);
  }

  toJSON() {
    return { total: this.#total, count: this.#scores.length, avg: this.getAverageScore() };
  }
}

// ─────────────────────────────────────────────────────────────────
// POUW STATS
// ─────────────────────────────────────────────────────────────────

export class PoUWStats {
  constructor() {
    this.totalContributions      = 0;
    this.totalRewardsDistributed = 0;
    this.averageScore            = 0;
    this.topContributors         = [];   // [[nodeId, score]]
    this.currentEpoch            = 0;
    this.activeNodes             = 0;
  }
}

// ─────────────────────────────────────────────────────────────────
// POUW ENGINE
// ─────────────────────────────────────────────────────────────────

export class PoUWEngine {
  #contributions;    // Map<nodeId, ContributionProof[]>
  #totalRewardsPool;
  #currentEpoch;
  #epochRewards;     // Map<epoch, amount>
  #thevieBoosts;     // Map<nodeId, boost>
  #statsCache;
  #lastStatsUpdate;
  #proofStorage;     // ZipMemory — persistance des preuves
  #dreamScoring;     // DreamScoring

  constructor() {
    this.#contributions  = new Map();
    this.#totalRewardsPool = 0;
    this.#currentEpoch   = 0;
    this.#epochRewards   = new Map();
    this.#thevieBoosts   = new Map();
    this.#statsCache     = null;
    this.#lastStatsUpdate= 0;
    this.#proofStorage   = new ZipMemory('./data/pouw_proofs');
    this.#dreamScoring   = new DreamScoring();
  }

  // ─── Enregistrement de contribution ──────────────────────────

  /**
   * Enregistre une contribution PoUW, la persiste dans ZipMemory,
   * et crédite les récompenses si un UserRewards est fourni.
   *
   * La compression des données brutes est simulée par un calcul de
   * taille via TextEncoder (ZipMemory ne compresse pas réellement —
   * la vraie compression sera assurée par un future ZipMemory v2).
   *
   * @param {string}      nodeId
   * @param {string}      contributionType  — 'inference' | 'storage' | 'dream' | 'validation' | …
   * @param {number}      score             — [0, 1]
   * @param {object|null} metadata
   * @param {Uint8Array|string|null} rawData — données brutes à persister
   * @param {UserRewards|null} rewards
   * @returns {Promise<ContributionProof>}
   */
  async recordContribution(nodeId, contributionType, score, metadata = null, rawData = null, rewards = null) {
    const clampedScore = Math.max(0, Math.min(1, score));
    const thevieBoost  = this.#thevieBoosts.get(nodeId) ?? 0;

    // Taille sérialisée (proxy de compressedSize tant que ZipMemory ne compresse pas)
    let compressedSize = 0;
    if (rawData != null) {
      compressedSize = rawData instanceof Uint8Array
        ? rawData.length
        : new TextEncoder().encode(JSON.stringify(rawData)).length;
    }

    const proof       = new ContributionProof(nodeId, contributionType, clampedScore, metadata, thevieBoost, compressedSize);
    proof.epoch       = this.#currentEpoch;

    // Persistance ZipMemory (store uniquement — pas de compress disponible)
    await this.#proofStorage.store(proof.proofHash, new TextEncoder().encode(JSON.stringify(proof.toJSON())));

    // Stockage en mémoire
    if (!this.#contributions.has(nodeId)) this.#contributions.set(nodeId, []);
    this.#contributions.get(nodeId).push(proof);

    // Invalider le cache de stats
    this.#statsCache = null;

    // Récompense — UserRewards.addReward n'existe pas : on incrémente totalSkyEarned directement
    if (rewards instanceof UserRewards) {
      const baseReward = Math.floor(clampedScore * BASE_REWARD_UNIT * (1 + thevieBoost));
      rewards.totalSkyEarned += baseReward;
    }

    console.debug(
      `[PoUW] ${nodeId.slice(0, 8)} | ${contributionType} | ` +
      `score: ${clampedScore.toFixed(3)} | boost: ${thevieBoost.toFixed(2)}x | ` +
      `reward: ${Math.floor(clampedScore * BASE_REWARD_UNIT * (1 + thevieBoost))} SKY`
    );

    return proof;
  }

  // ─── Dream Scoring ────────────────────────────────────────────

  /**
   * Enregistre un cycle de rêve et l'intègre dans le PoUW.
   * Crée automatiquement une ContributionProof de type 'dream'.
   */
  async recordDream(nodeId, dreamScore, rewards = null) {
    this.#dreamScoring.recordDream(dreamScore, nodeId);
    return this.recordContribution(nodeId, 'dream', dreamScore, null, null, rewards);
  }

  getTotalScore() {
    let total = 0;
    for (const list of this.#contributions.values()) {
      for (const p of list) total += p.effectiveScore;
    }
    return total;
  }

  getDreamScore() { return this.#dreamScoring.getTotalScore(); }

  // ─── Thevie Boost ─────────────────────────────────────────────

  applyThevieBoost(nodeId, boost) {
    const clamped = Math.max(0, Math.min(MAX_THEVIE_BOOST, boost));
    this.#thevieBoosts.set(nodeId, clamped);
    this.#statsCache = null;
    console.info(`[PoUW] Thevie Boost → ${nodeId.slice(0, 8)} : +${clamped.toFixed(2)}x`);
  }

  removeThevieBoost(nodeId) {
    this.#thevieBoosts.delete(nodeId);
    this.#statsCache = null;
  }

  // ─── Récompenses ──────────────────────────────────────────────

  /**
   * Calcule la récompense d'un nœud en proportion de sa contribution
   * relative dans le pool global, avec bonus de fidélité.
   *
   * Formule : reward = (nodeScore / globalScore) × pool × loyaltyBonus
   */
  calculateNodeReward(nodeId) {
    const contribs = this.#contributions.get(nodeId) ?? [];
    if (contribs.length === 0) return 0;

    const nodeScore = contribs.reduce((s, p) => s + p.effectiveScore, 0);
    const globalScore = this.#globalEffectiveScore();
    if (globalScore < 1e-6) return 0;

    const base    = (nodeScore / globalScore) * this.#totalRewardsPool;
    const loyalty = this.#loyaltyBonus(nodeId);
    return Math.floor(base * loyalty);
  }

  addToRewardsPool(amount) {
    if (amount <= 0) return;
    this.#totalRewardsPool += amount;
    const current = this.#epochRewards.get(this.#currentEpoch) ?? 0;
    this.#epochRewards.set(this.#currentEpoch, current + amount);
  }

  // ─── Gestion des epochs ───────────────────────────────────────

  onNewEpoch(epoch) {
    this.#currentEpoch = Math.max(0, epoch);
    this.#statsCache   = null;
    console.info(`[PoUW] Nouvel epoch : ${this.#currentEpoch}`);
  }

  get currentEpoch() { return this.#currentEpoch; }

  // ─── Statistiques ─────────────────────────────────────────────

  getGlobalStats() {
    const now = Date.now();
    if (this.#statsCache && now - this.#lastStatsUpdate < STATS_CACHE_TTL_MS) {
      return this.#statsCache;
    }

    let totalContribs = 0;
    let totalScore    = 0;

    for (const list of this.#contributions.values()) {
      totalContribs += list.length;
      for (const p of list) totalScore += p.effectiveScore;
    }

    const avgScore = totalContribs > 0 ? totalScore / totalContribs : 0;

    const top = [...this.#contributions.entries()]
      .map(([id, list]) => [id, list.reduce((s, p) => s + p.effectiveScore, 0)])
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);

    const stats                      = new PoUWStats();
    stats.totalContributions         = totalContribs;
    stats.totalRewardsDistributed    = this.#totalRewardsPool;
    stats.averageScore               = +avgScore.toFixed(4);
    stats.topContributors            = top;
    stats.currentEpoch               = this.#currentEpoch;
    stats.activeNodes                = this.#contributions.size;
    stats.dreamScoring               = this.#dreamScoring.toJSON();
    stats.thevieBoosts               = Object.fromEntries(this.#thevieBoosts);
    stats.epochRewards               = Object.fromEntries(this.#epochRewards);

    this.#statsCache     = stats;
    this.#lastStatsUpdate= now;
    return stats;
  }

  getNodeStats(nodeId) {
    const contribs = this.#contributions.get(nodeId) ?? [];
    if (contribs.length === 0) return null;

    const effectiveScore = contribs.reduce((s, p) => s + p.effectiveScore, 0);
    const types          = {};
    for (const p of contribs) types[p.contributionType] = (types[p.contributionType] ?? 0) + 1;

    return {
      nodeId,
      contributions   : contribs.length,
      effectiveScore  : +effectiveScore.toFixed(4),
      thevieBoost     : this.#thevieBoosts.get(nodeId) ?? 0,
      loyaltyBonus    : +this.#loyaltyBonus(nodeId).toFixed(4),
      estimatedReward : this.calculateNodeReward(nodeId),
      typeBreakdown   : types,
      latestEpoch     : contribs.at(-1)?.epoch ?? 0,
    };
  }

  // ─── Maintenance ─────────────────────────────────────────────

  pruneOldContributions(maxAgeDays = PRUNE_DEFAULT_DAYS) {
    const cutoff = Date.now() - maxAgeDays * 86_400_000;
    let pruned   = 0;

    for (const [nodeId, list] of this.#contributions) {
      const filtered = list.filter(p => p.timestamp > cutoff);
      pruned += list.length - filtered.length;
      if (filtered.length === 0) this.#contributions.delete(nodeId);
      else                        this.#contributions.set(nodeId, filtered);
    }

    this.#dreamScoring.prune(maxAgeDays);
    this.#statsCache = null;
    console.debug(`[PoUW] ${pruned} contributions purgées (> ${maxAgeDays} jours)`);
    return pruned;
  }

  // ─── Privés ───────────────────────────────────────────────────

  #globalEffectiveScore() {
    let total = 0;
    for (const list of this.#contributions.values()) {
      for (const p of list) total += p.effectiveScore;
    }
    return total;
  }

  /**
   * Bonus de fidélité : +1 % par 6,5 jours de contribution,
   * plafonné à +65 % après 420 jours.
   */
  #loyaltyBonus(nodeId) {
    const list = this.#contributions.get(nodeId);
    if (!list || list.length < 8) return 1.0;
    const oldest  = Math.min(...list.map(p => p.timestamp));
    const ageDays = (Date.now() - oldest) / 86_400_000;
    return 1 + Math.min(ageDays / LOYALTY_DAYS, MAX_LOYALTY_BONUS);
  }
}
