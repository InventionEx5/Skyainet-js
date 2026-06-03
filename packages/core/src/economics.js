// packages/core/src/economics.js
// =====================================================
// NodeEconomics — Abonnements + Rewards intégrés
// Port de economics.rs — SkyAInet × Nikola T369
// =====================================================

"use strict";

import { UserRewards, AccountType, RewardReason } from './rewards.js';

// ─────────────────────────────────────────────────────────────────
// ENUMS — Plans et Tiers
// ─────────────────────────────────────────────────────────────────

export const NodeTier = Object.freeze({
  Mini       : 'Mini',
  Light      : 'Light',
  Full       : 'Full',
  DreamWeaver: 'DreamWeaver',
  Validator  : 'Validator',
});

export const GatewayPlan = Object.freeze({
  Basic    : 'Basic',
  Pro      : 'Pro',
  Sovereign: 'Sovereign',
});

export const ApiKeysPlan = Object.freeze({
  Free      : 'Free',
  Developer : 'Developer',
  Enterprise: 'Enterprise',
});

export const StoragePlan = Object.freeze({
  Basic    : 'Basic',
  Pro      : 'Pro',
  Enterprise: 'Enterprise',
});

// ─────────────────────────────────────────────────────────────────
// TARIFS MENSUELS (€) — port exact des impl dans economics.rs
// ─────────────────────────────────────────────────────────────────

const NODE_PRICES = Object.freeze({
  [NodeTier.Mini]       : 0,
  [NodeTier.Light]      : 6,
  [NodeTier.Full]       : 18,
  [NodeTier.DreamWeaver]: 32,
  [NodeTier.Validator]  : 55,
});

const GATEWAY_PRICES = Object.freeze({
  [GatewayPlan.Basic]    : 9,
  [GatewayPlan.Pro]      : 19,
  [GatewayPlan.Sovereign]: 39,
});

const APIKEYS_PRICES = Object.freeze({
  [ApiKeysPlan.Free]      : 0,
  [ApiKeysPlan.Developer] : 12,
  [ApiKeysPlan.Enterprise]: 49,
});

const STORAGE_PRICES = Object.freeze({
  [StoragePlan.Basic]     : 8,
  [StoragePlan.Pro]       : 25,
  [StoragePlan.Enterprise]: 79,
});

// ─────────────────────────────────────────────────────────────────
// SUBSCRIPTION — type discriminé
// ─────────────────────────────────────────────────────────────────

export class Subscription {
  /**
   * @param {'node'|'gateway'|'apikeys'|'storage'} kind
   * @param {string} plan — valeur de l'enum correspondant
   */
  constructor(kind, plan) {
    this.kind = kind;
    this.plan = plan;
  }

  monthlyPriceEur() {
    switch (this.kind) {
      case 'node'   : return NODE_PRICES[this.plan]    ?? 0;
      case 'gateway': return GATEWAY_PRICES[this.plan] ?? 0;
      case 'apikeys': return APIKEYS_PRICES[this.plan] ?? 0;
      case 'storage': return STORAGE_PRICES[this.plan] ?? 0;
      default       : return 0;
    }
  }

  equals(other) {
    return other instanceof Subscription &&
           this.kind === other.kind &&
           this.plan === other.plan;
  }

  toJSON() { return { kind: this.kind, plan: this.plan, priceEur: this.monthlyPriceEur() }; }

  // Factories
  static node(tier = NodeTier.Mini)            { return new Subscription('node',    tier); }
  static gateway(plan = GatewayPlan.Basic)     { return new Subscription('gateway', plan); }
  static apiKeys(plan = ApiKeysPlan.Free)      { return new Subscription('apikeys', plan); }
  static storage(plan = StoragePlan.Basic)     { return new Subscription('storage', plan); }
}

// ─────────────────────────────────────────────────────────────────
// NODE ECONOMICS
//
// Agrège :
//   — Abonnements actifs + coût mensuel total
//   — UserRewards (délégation complète)
//   — Revenus de location de nœud (rental)
//   — Historique des payouts
//
// Délègue recordLearnContribution / recordDreamCycle / etc.
// à UserRewards pour éviter la duplication.
// ─────────────────────────────────────────────────────────────────

export class NodeEconomics {
  #subscriptions;   // Subscription[]
  #payoutHistory;   // { ts, amount }[]

  constructor(accountType = AccountType.Free) {
    this.userRewards             = new UserRewards(accountType);
    this.#subscriptions          = [Subscription.node(NodeTier.Mini)];
    this.isRentedOut             = false;
    this.rentalPricePerHourSky   = 0;
    this.totalEarnedSky          = 0;
    this.lastPayout              = null;
    this.#payoutHistory          = [];
  }

  // ─── Abonnements ─────────────────────────────────────────────

  addSubscription(subscription) {
    if (!(subscription instanceof Subscription)) throw new TypeError('Expected Subscription');
    if (this.#subscriptions.some(s => s.equals(subscription))) return;
    this.#subscriptions.push(subscription);
    console.info(`[Economics] Abonnement ajouté : ${subscription.kind}/${subscription.plan}`);
  }

  removeSubscription(kind, plan) {
    this.#subscriptions = this.#subscriptions.filter(s => !(s.kind === kind && s.plan === plan));
  }

  getActiveSubscriptions()  { return [...this.#subscriptions]; }

  getTotalMonthlyCostEur() {
    return this.#subscriptions.reduce((s, sub) => s + sub.monthlyPriceEur(), 0);
  }

  // ─── Délégation Rewards ───────────────────────────────────────

  recordLearnContribution(quality)         { this.userRewards.recordLearnContribution(quality); }
  recordDreamCycle(quality)                { this.userRewards.recordDreamCycle(quality); }
  recordHighQualityInteraction(quality)    { this.userRewards.recordHighQualityInteraction(quality); }

  claimMonthlyRewards() {
    const amount = this.userRewards.claimMonthlyRewards();
    if (amount > 0) {
      this.totalEarnedSky += amount;
      this.lastPayout      = Date.now();
      this.#payoutHistory.push({ ts: Date.now(), amount });
      if (this.#payoutHistory.length > 24) this.#payoutHistory.shift(); // 24 mois max
    }
    return amount;
  }

  getSubscriptionBonus()   { return this.userRewards.getSubscriptionBonus(); }
  isEligibleForRewards()   { return this.userRewards.isEligibleForRewards(); }

  // ─── Location ────────────────────────────────────────────────

  setRentalPrice(skyPerHour) {
    this.rentalPricePerHourSky = Math.max(0, skyPerHour);
    this.isRentedOut           = skyPerHour > 0;
  }

  recordRentalIncome(hours) {
    const income         = hours * this.rentalPricePerHourSky;
    this.totalEarnedSky += income;
    this.userRewards.totalSkyEarned += income;
    return income;
  }

  // ─── Stats ────────────────────────────────────────────────────

  summary() {
    return `Economics | Subs: ${this.#subscriptions.length} | ` +
           `Monthly: ${this.getTotalMonthlyCostEur()}€ | ` +
           `Earned: ${this.totalEarnedSky} SKY | ` +
           `Pending: ${this.userRewards.pendingRewards} SKY | ` +
           `Quality: ${this.userRewards.conversationQualityScore.toFixed(2)}`;
  }

  stats() {
    return {
      subscriptions   : this.#subscriptions.map(s => s.toJSON()),
      monthlyCostEur  : this.getTotalMonthlyCostEur(),
      isRentedOut     : this.isRentedOut,
      rentalPrice     : this.rentalPricePerHourSky,
      totalEarnedSky  : this.totalEarnedSky,
      lastPayout      : this.lastPayout,
      payoutHistory   : this.#payoutHistory,
      rewards         : this.userRewards.stats(),
    };
  }
}