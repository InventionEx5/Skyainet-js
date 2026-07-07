// packages/core/src/economics.js
// =====================================================
// NodeEconomics — Abonnements + Rewards intégrés
// Port de economics.rs — SkyAInet × Nikola T369
// =====================================================

"use strict";

import { UserRewards, AccountType, RewardReason } from '#rewards';

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

  /**
   * Réclame les rewards en attente et les transfère dans le wallet SKY.
   *
   * Connexion wallet (optionnelle) :
   *   — Si `wallet` est fourni et implémente `creditLocal(amount)`,
   *     les SKY sont crédités immédiatement dans le wallet de l'utilisateur.
   *   — En production, remplacer creditLocal par un vrai transfer ERC-20
   *     via treasury.sendToUser(wallet.address, amount).
   *
   * @param {import('#wallet').SkyWallet|null} wallet
   * @returns {Promise<{ amount: number, walletBalance: number|null, payoutRecord: object }>}
   */
  async claimMonthlyRewards(wallet = null) {
    const amount = this.userRewards.claimMonthlyRewards();
    if (amount <= 0) return { amount: 0, walletBalance: wallet?.cachedBalance ?? null, payoutRecord: null };

    this.totalEarnedSky += amount;
    this.lastPayout      = Date.now();
    const payoutRecord   = { ts: this.lastPayout, amount };
    this.#payoutHistory.push(payoutRecord);
    if (this.#payoutHistory.length > 24) this.#payoutHistory.shift();

    // ── Connexion wallet ──────────────────────────────────────────
    let walletBalance = null;
    if (wallet && typeof wallet.creditLocal === 'function') {
      try {
        walletBalance = wallet.creditLocal(amount);
        console.info(`[Economics] Claim ${amount} SKY → wallet ${wallet.address ?? 'local'} | balance: ${walletBalance} SKY`);
      } catch (e) {
        console.warn(`[Economics] creditLocal échoué : ${e.message}`);
      }
    } else {
      console.info(`[Economics] Claim ${amount} SKY — pas de wallet connecté (local only)`);
    }

    return { amount, walletBalance, payoutRecord };
  }

  /**
   * Reçoit la part utilisateur d'une distribution treasury (55% users)
   * et la crédite dans le wallet.
   *
   * Appelée par TreasuryManager.distributeRewards() pour chaque nœud contributeur.
   *
   * @param {number} amount  — montant SKY à créditer
   * @param {import('#wallet').SkyWallet|null} wallet
   */
  async receiveDistribution(amount, wallet = null) {
    if (amount <= 0) return;
    this.userRewards.totalSkyEarned += amount;
    this.totalEarnedSky             += amount;

    if (wallet && typeof wallet.creditLocal === 'function') {
      try {
        wallet.creditLocal(amount);
        console.info(`[Economics] Distribution reçue : +${amount} SKY → wallet ${wallet.address ?? 'local'}`);
      } catch (e) {
        console.warn(`[Economics] receiveDistribution creditLocal échoué : ${e.message}`);
      }
    }
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

  // -- Handlers API (Economics: rewards/wallet/abonnements/profil) -- migres depuis skycloud.js
  //    Les methodes node.X() restent dans skycloud (orchestrent #userRewards/#userProfile/#nodeEcon/#skyWallet/#treasury/#subscriptions).
  apiHandlers(node) {
    return {
      claimRewards              : node.claimRewards.bind(node),
      claim_rewards             : node.claimRewards.bind(node),
      getRewardsStats           : node.getRewardsStats.bind(node),
      get_rewards_stats         : node.getRewardsStats.bind(node),
      creditWallet              : amount => node.creditWallet(amount),
      credit_wallet             : amount    => node.creditWallet(amount),
      withdraw_to_wallet        : (address, amount) => node.withdrawToWallet(address, amount),
      connect_wallet            : wallet    => node.connectWallet(wallet),
      connect_treasury          : treasury  => node.connectTreasury(treasury),
      send_sky                  : (to, amt, label, txHash) => {   // log seul — l'envoi réel est signé par MetaMask côté frontend (non-custodial)
        console.info(`[SkyCloud] tx sortante (signée MetaMask) → ${to} · ${amt} SKY · ${txHash ?? 'no-hash'}${label ? ' · ' + label : ''}`);
        return { logged: true, to, amount: amt, txHash: txHash ?? null };
      },
      get_tx_history            : limit     => node.skyWallet?.getTransactionHistory(limit),
      subscribeToPlan           : (context, planIndex) => node.subscribeToPlan(context, planIndex),
      subscribe_to_plan         : (context, planIndex) => node.subscribeToPlan(context, planIndex),
      cancelSubscription        : context              => node.cancelSubscription(context),
      cancel_subscription       : (context)           => node.cancelSubscription(context),
      getActiveSubscriptions    : ()                   => node.getActiveSubscriptions(),
      get_active_subscriptions  : ()                   => node.getActiveSubscriptions(),
      getSubscription           : context              => node.getSubscription(context),
      getSubscriptionPlans      : ()                   => node.getSubscriptionPlans(),
      get_subscription_plans    : ()                   => node.getSubscriptionPlans(),
      get_user_profile          : ()        => node.getUserProfile(),
      get_profile_nav_badge     : ()        => node.getProfileNavBadge(),
      update_reputation         : score     => node.updateReputation(score),
      set_account_type          : type      => node.setAccountType(type),
      set_verification_level    : level     => node.setVerificationLevel(level),
      link_wallet_to_profile    : address   => node.linkWalletToProfile(address),
    };
  }
}
