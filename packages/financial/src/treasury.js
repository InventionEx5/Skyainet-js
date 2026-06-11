// packages/financial/src/treasury.js
// =====================================================
// TreasuryManager — Gestion du Trésor + Distribution Globale
// 15% Burn | 55% Users | 25% DAO | 5% Dev Team
// viem — SkyAInet × Nikola T369
// =====================================================

"use strict";

import {
  createPublicClient, createWalletClient,
  http, webSocket,
  parseAbi,
  getContract,
  hexToBigInt, toHex, padHex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

// ─────────────────────────────────────────────────────────────────
// ABI TreasuryVault
// ─────────────────────────────────────────────────────────────────

const TREASURY_ABI = parseAbi([
  'function getBalance() view returns (uint256)',
  'function triggerRebalance()',
  'function logSecureTransfer(bytes32 gematriaSessionId, uint256 amount)',
  'function recordEthicalScore(bytes32 nodeId, uint256 score)',
  'event RevenueDistributed(uint256 burned, uint256 rewarded, uint256 daoReserve, uint256 devTeam, uint256 timestamp)',
  'event TokensBurned(uint256 amount, uint256 timestamp)',
  'event RewardsDistributed(uint256 amount, uint256 timestamp)',
  'event DaoShareSent(uint256 amount, uint256 timestamp)',
]);

// ─────────────────────────────────────────────────────────────────
// CONSTANTES DE DISTRIBUTION
// ─────────────────────────────────────────────────────────────────

const BURN_RATE  = 15n;   // 15%
const USERS_RATE = 55n;   // 55%
const DAO_RATE   = 25n;   // 25%
// Dev = 5% — reste exact

// ─────────────────────────────────────────────────────────────────
// ERREUR TYPÉE
// ─────────────────────────────────────────────────────────────────

export class TreasuryError extends Error {
  constructor(message, code = 'TREASURY_ERROR') {
    super(message);
    this.name = 'TreasuryError';
    this.code = code;
  }
  static providerError(msg) { return new TreasuryError(`Provider error: ${msg}`,       'PROVIDER_ERROR'); }
  static contractError(msg) { return new TreasuryError(`Contract call failed: ${msg}`, 'CONTRACT_ERROR'); }
}

// ─────────────────────────────────────────────────────────────────
// TREASURY MANAGER
// ─────────────────────────────────────────────────────────────────

export class TreasuryManager {
  #publicClient;     // viem PublicClient  — lecture
  #walletClient;     // viem WalletClient  — écriture
  #contract;         // viem Contract instance
  #contractAddress;
  #chainId;

  #totalBurned;
  #totalRewarded;
  #totalDaoReserve;
  #totalDevTeam;
  #lastRebalance;
  #rebalanceCount;
  #ethicalScores;
  #distributionHistory;
  #unwatch;          // fonction pour arrêter l'écoute des events

  /**
   * @param {object} opts
   * @param {string}  opts.rpcUrl          — URL RPC (http/https/wss)
   * @param {string}  opts.contractAddress — adresse TreasuryVault
   * @param {number}  [opts.chainId]
   * @param {string}  [opts.privateKey]    — clé privée `0x…` pour tx mutantes
   */
  constructor(opts = {}) {
    this.#contractAddress    = opts.contractAddress ?? null;
    this.#chainId            = opts.chainId         ?? 1;
    this.#publicClient       = null;
    this.#walletClient       = null;
    this.#contract           = null;
    this.#unwatch            = null;

    this.#totalBurned        = 0n;
    this.#totalRewarded      = 0n;
    this.#totalDaoReserve    = 0n;
    this.#totalDevTeam       = 0n;
    this.#lastRebalance      = null;
    this.#rebalanceCount     = 0;
    this.#ethicalScores      = new Map();
    this.#distributionHistory= [];

    if (opts.rpcUrl) this.#init(opts.rpcUrl, opts.privateKey);
  }

  // ─── Initialisation ───────────────────────────────────────────

  #init(rpcUrl, privateKey = null) {
    try {
      const chain     = { id: this.#chainId, name: 'skyainet', nativeCurrency: { name: 'SKY', symbol: 'SKY', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } };
      const transport = rpcUrl.startsWith('ws') ? webSocket(rpcUrl) : http(rpcUrl);

      this.#publicClient = createPublicClient({ chain, transport });

      if (privateKey && this.#contractAddress) {
        const account     = privateKeyToAccount(privateKey);
        this.#walletClient = createWalletClient({ account, chain, transport });
      }

      if (this.#contractAddress) {
        this.#contract = getContract({
          address: this.#contractAddress,
          abi    : TREASURY_ABI,
          client : { public: this.#publicClient, wallet: this.#walletClient },
        });
        this.#watchEvents();
      }

      console.info(`[Treasury] Initialisé | contract: ${this.#contractAddress}`);
    } catch (e) {
      console.warn(`[Treasury] Provider non disponible (${e.message}) — mode local`);
    }
  }

  /** Écoute les events on-chain via viem watchContractEvent. */
  #watchEvents() {
    if (!this.#publicClient || !this.#contractAddress) return;

    this.#unwatch = this.#publicClient.watchContractEvent({
      address  : this.#contractAddress,
      abi      : TREASURY_ABI,
      eventName: 'RevenueDistributed',
      onLogs   : (logs) => {
        for (const log of logs) {
          const { burned, rewarded, daoReserve, devTeam } = log.args;
          this.#totalBurned     += burned;
          this.#totalRewarded   += rewarded;
          this.#totalDaoReserve += daoReserve;
          this.#totalDevTeam    += devTeam;
          console.info(`[Treasury] RevenueDistributed — Burn:${burned} Users:${rewarded} DAO:${daoReserve} Dev:${devTeam}`);
        }
      },
    });
  }

  // ─── Solde ────────────────────────────────────────────────────

  async getBalance() {
    if (!this.#contract) return 0n;
    try {
      return await this.#contract.read.getBalance();
    } catch (e) {
      throw TreasuryError.contractError(e.message);
    }
  }

  // ─── Distribution ─────────────────────────────────────────────

  /**
   * Distribue les revenus selon 15% burn / 55% users / 25% DAO / 5% dev.
   *
   * @param {number} totalAmount
   * @param {object|null} rewards            — rétrocompatibilité UserRewards
   * @param {Array<{
   *   wallet?: import('./wallet.js').SkyWallet,
   *   economics?: import('../../core/src/economics.js').NodeEconomics,
   *   share?: number
   * }>} recipients — nœuds recevant les 55% users, pondérés par share
   */
  async distributeRewards(totalAmount, rewards = null, recipients = []) {
    if (!totalAmount || totalAmount <= 0) return { burn: 0, users: 0, dao: 0, dev: 0, distributions: [] };

    const total = BigInt(Math.floor(Number(totalAmount)));
    const burn  = total * BURN_RATE  / 100n;
    const users = total * USERS_RATE / 100n;
    const dao   = total * DAO_RATE   / 100n;
    const dev   = total - burn - users - dao;

    this.#totalBurned     += burn;
    this.#totalRewarded   += users;
    this.#totalDaoReserve += dao;
    this.#totalDevTeam    += dev;

    // Rétrocompatibilité
    if (rewards && typeof rewards.totalSkyEarned === 'number') {
      rewards.totalSkyEarned += Number(users);
    }

    const record = {
      ts: Date.now(),
      burn : Number(burn),
      users: Number(users),
      dao  : Number(dao),
      dev  : Number(dev),
      distributions: [],
    };

    // ── Dispatch des 55% users aux wallets des nœuds ─────────────
    if (recipients.length > 0) {
      const usersAmount = Number(users);
      const totalShares = recipients.reduce((s, r) => s + (r.share ?? 1), 0);

      for (const recipient of recipients) {
        const share     = recipient.share ?? 1;
        const allocated = Math.floor((share / totalShares) * usersAmount);
        if (allocated <= 0) continue;

        const dist = { address: recipient.wallet?.address ?? 'unknown', amount: allocated, status: 'pending' };

        try {
          if (recipient.economics && typeof recipient.economics.receiveDistribution === 'function') {
            await recipient.economics.receiveDistribution(allocated, recipient.wallet ?? null);
            dist.status = 'credited';
          } else if (recipient.wallet && typeof recipient.wallet.creditLocal === 'function') {
            recipient.wallet.creditLocal(allocated);
            dist.status = 'credited';
          } else {
            dist.status = 'no_wallet';
          }
          console.info(`[Treasury] +${allocated} SKY → ${dist.address.slice(0, 10)}…`);
        } catch (e) {
          dist.status = 'failed';
          dist.error  = e.message;
          console.warn(`[Treasury] Distribution échouée (${dist.address}) : ${e.message}`);
        }
        record.distributions.push(dist);
      }
    }

    this.#distributionHistory.push(record);
    if (this.#distributionHistory.length > 500) this.#distributionHistory.shift();

    console.info(`[Treasury] Burn:${burn} | Users:${users} | DAO:${dao} | Dev:${dev} SKY | wallets: ${record.distributions.length}`);
    return record;
  }

  // ─── Rebalance ────────────────────────────────────────────────

  async triggerRebalance() {
    this.#lastRebalance = Date.now();
    this.#rebalanceCount++;

    if (this.#contract && this.#walletClient) {
      try {
        const hash = await this.#contract.write.triggerRebalance();
        await this.#publicClient.waitForTransactionReceipt({ hash });
        console.info(`[Treasury] Rebalance #${this.#rebalanceCount} — tx: ${hash}`);
      } catch (e) {
        console.warn(`[Treasury] Rebalance on-chain échoué : ${e.message}`);
      }
    } else {
      console.info(`[Treasury] Rebalance local #${this.#rebalanceCount}`);
    }
  }

  // ─── Score éthique ────────────────────────────────────────────

  async recordEthicalScore(nodeId, score) {
    const s = Math.max(0, Math.min(1, score));
    this.#ethicalScores.set(nodeId, s);

    if (this.#contract && this.#walletClient) {
      try {
        const nodeIdBytes32 = padHex(toHex(new TextEncoder().encode(nodeId).slice(0, 32)), { size: 32 });
        const scoreU256     = BigInt(Math.floor(s * 1_000_000));
        const hash = await this.#contract.write.recordEthicalScore([nodeIdBytes32, scoreU256]);
        await this.#publicClient.waitForTransactionReceipt({ hash });
        console.info(`[Treasury] Score éthique ${s.toFixed(4)} on-chain — tx: ${hash}`);
      } catch (e) {
        console.warn(`[Treasury] recordEthicalScore échoué : ${e.message}`);
      }
    } else {
      console.debug(`[Treasury] Score éthique local : ${nodeId.slice(0,16)}… → ${s.toFixed(4)}`);
    }
  }

  // ─── Logs sécurisés ───────────────────────────────────────────

  async logSecureTransfer(gematriaSessionId, amount) {
    if (!this.#contract || !this.#walletClient) return;
    try {
      const sessionBytes32 = padHex(toHex(new TextEncoder().encode(gematriaSessionId).slice(0, 32)), { size: 32 });
      const hash = await this.#contract.write.logSecureTransfer([sessionBytes32, BigInt(amount)]);
      await this.#publicClient.waitForTransactionReceipt({ hash });
    } catch (e) {
      console.warn(`[Treasury] logSecureTransfer échoué : ${e.message}`);
    }
  }

  // ─── Nettoyage ───────────────────────────────────────────────

  destroy() {
    if (this.#unwatch) { this.#unwatch(); this.#unwatch = null; }
  }

  // ─── Stats ────────────────────────────────────────────────────

  async getStats() {
    const balance = await this.getBalance().catch(() => 0n);
    return {
      balance           : balance.toString(),
      totalBurned       : this.#totalBurned.toString(),
      totalRewarded     : this.#totalRewarded.toString(),
      totalDaoReserve   : this.#totalDaoReserve.toString(),
      totalDevTeam      : this.#totalDevTeam.toString(),
      lastRebalance     : this.#lastRebalance,
      rebalanceCount    : this.#rebalanceCount,
      ethicalScores     : this.#ethicalScores.size,
      providerConnected : !!this.#publicClient,
      signerConnected   : !!this.#walletClient,
      contractAddress   : this.#contractAddress,
      chainId           : this.#chainId,
      distributionCount : this.#distributionHistory.length,
    };
  }

  getEthicalScores()                 { return new Map(this.#ethicalScores); }
  getDistributionHistory(limit = 50) { return this.#distributionHistory.slice(-limit); }
}
