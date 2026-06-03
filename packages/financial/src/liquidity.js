// packages/financial/src/liquidity.js
// =====================================================
// LiquidityManager — Gestion de Liquidité Uniswap V4
// Slippage protection + Treasury + Rewards
// viem — SkyAInet × Nikola T369
// =====================================================

"use strict";

import {
  createPublicClient, createWalletClient,
  http, webSocket,
  parseAbi,
  getContract,
} from 'viem';
import { privateKeyToAccount }  from 'viem/accounts';
import { HybridTransport }      from '../../secure/src/crypto/hybrid.js';

// ─────────────────────────────────────────────────────────────────
// ABI IUniswapV4Router
// ─────────────────────────────────────────────────────────────────

const UNISWAP_V4_ABI = parseAbi([
  'function addLiquidity(address pool, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline) returns (uint256 amount0, uint256 amount1, uint256 liquidity)',
  'function removeLiquidity(address pool, uint256 liquidity, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline) returns (uint256 amount0, uint256 amount1)',
  'event LiquidityAdded(address indexed pool, uint256 amount0, uint256 amount1, uint256 liquidity)',
  'event LiquidityRemoved(address indexed pool, uint256 amount0, uint256 amount1)',
]);

// ─────────────────────────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────────────────────────

const SLIPPAGE_MIN     = 0.001;
const SLIPPAGE_MAX     = 0.08;
const SLIPPAGE_DEFAULT = 0.005;
const DEADLINE_MINUTES = 30;
const REWARD_LIQUIDITY = 85;

// ─────────────────────────────────────────────────────────────────
// ERREUR TYPÉE
// ─────────────────────────────────────────────────────────────────

export class LiquidityError extends Error {
  constructor(message, code = 'LIQUIDITY_ERROR') {
    super(message);
    this.name = 'LiquidityError';
    this.code = code;
  }
  static txFailed(msg)           { return new LiquidityError(`Transaction failed: ${msg}`,  'TX_FAILED'); }
  static insufficientLiquidity() { return new LiquidityError('Insufficient liquidity',      'INSUFFICIENT_LIQUIDITY'); }
  static invalidAmount()         { return new LiquidityError('Amount must be > 0',          'INVALID_AMOUNT'); }
}

// ─────────────────────────────────────────────────────────────────
// POSITION
// ─────────────────────────────────────────────────────────────────

export class LiquidityPosition {
  constructor({ pool, amount0, amount1, liquidity, recipient, txHash = null, addedAt = Date.now() }) {
    this.pool      = pool;
    this.amount0   = BigInt(amount0);
    this.amount1   = BigInt(amount1);
    this.liquidity = BigInt(liquidity);
    this.recipient = recipient;
    this.txHash    = txHash;
    this.addedAt   = addedAt;
  }

  toJSON() {
    return {
      pool     : this.pool,
      amount0  : this.amount0.toString(),
      amount1  : this.amount1.toString(),
      liquidity: this.liquidity.toString(),
      recipient: this.recipient,
      txHash   : this.txHash,
      addedAt  : this.addedAt,
    };
  }
}

// ─────────────────────────────────────────────────────────────────
// LIQUIDITY MANAGER
// ─────────────────────────────────────────────────────────────────

export class LiquidityManager {
  #publicClient;
  #walletClient;
  #contract;
  #hybrid;
  #treasury;
  #positions;
  #totalLiquidityProvided;
  #unwatch;

  /**
   * @param {object} opts
   * @param {string}  opts.rpcUrl
   * @param {string}  opts.routerAddress
   * @param {string}  [opts.privateKey]
   * @param {number}  [opts.chainId]
   * @param {object}  [opts.treasury]
   * @param {number}  [opts.slippageTolerance]
   * @param {number}  [opts.deadlineMinutes]
   */
  constructor(opts = {}) {
    this.routerAddress     = opts.routerAddress    ?? null;
    this.slippageTolerance = Math.max(SLIPPAGE_MIN, Math.min(SLIPPAGE_MAX, opts.slippageTolerance ?? SLIPPAGE_DEFAULT));
    this.deadlineMinutes   = opts.deadlineMinutes  ?? DEADLINE_MINUTES;
    this.lastAddLiquidity  = null;

    this.#hybrid                 = new HybridTransport(true);
    this.#treasury               = opts.treasury ?? null;
    this.#positions              = new Map();
    this.#totalLiquidityProvided = 0n;
    this.#publicClient           = null;
    this.#walletClient           = null;
    this.#contract               = null;
    this.#unwatch                = null;

    if (opts.rpcUrl && opts.routerAddress) {
      this.#init(opts.rpcUrl, opts.routerAddress, opts.privateKey, opts.chainId ?? 1);
    }
  }

  // ─── Initialisation ───────────────────────────────────────────

  #init(rpcUrl, routerAddress, privateKey = null, chainId = 1) {
    try {
      const chain     = { id: chainId, name: 'skyainet', nativeCurrency: { name: 'SKY', symbol: 'SKY', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } };
      const transport = rpcUrl.startsWith('ws') ? webSocket(rpcUrl) : http(rpcUrl);

      this.#publicClient = createPublicClient({ chain, transport });

      if (privateKey) {
        const account      = privateKeyToAccount(privateKey);
        this.#walletClient = createWalletClient({ account, chain, transport });
      }

      this.#contract = getContract({
        address: routerAddress,
        abi    : UNISWAP_V4_ABI,
        client : { public: this.#publicClient, wallet: this.#walletClient },
      });

      // Écoute des events pour mise à jour automatique
      this.#unwatch = this.#publicClient.watchContractEvent({
        address  : routerAddress,
        abi      : UNISWAP_V4_ABI,
        eventName: 'LiquidityAdded',
        onLogs   : (logs) => {
          for (const log of logs) {
            this.#totalLiquidityProvided += log.args.liquidity ?? 0n;
            console.debug(`[Liquidity] Event LiquidityAdded — pool: ${log.args.pool} | liq: ${log.args.liquidity}`);
          }
        },
      });

      console.info(`[Liquidity] Initialisé | router: ${routerAddress}`);
    } catch (e) {
      console.warn(`[Liquidity] Provider non disponible (${e.message}) — mode local`);
    }
  }

  // ─── Ajout de liquidité ───────────────────────────────────────

  async addLiquidity({ pool, amount0, amount1, recipient, rewards = null }) {
    const a0 = BigInt(amount0 ?? 0);
    const a1 = BigInt(amount1 ?? 0);
    if (a0 === 0n || a1 === 0n) throw LiquidityError.invalidAmount();

    const a0Min    = this.#applySlippage(a0);
    const a1Min    = this.#applySlippage(a1);
    const deadline = this.#deadline();

    console.info(
      `[Liquidity] addLiquidity → pool: ${pool?.slice(0,10)}… | ` +
      `amount0: ${a0} | amount1: ${a1} | slippage: ${(this.slippageTolerance*100).toFixed(2)}%`
    );

    let realA0 = a0, realA1 = a1, liq = 0n, txHash = null;

    if (this.#contract && this.#walletClient) {
      try {
        const hash = await this.#contract.write.addLiquidity([
          pool, a0, a1, a0Min, a1Min, recipient, deadline
        ]);

        const receipt = await this.#publicClient.waitForTransactionReceipt({ hash });
        txHash = hash;

        // Parser les valeurs retournées depuis l'event LiquidityAdded
        for (const log of receipt.logs) {
          try {
            const decoded = this.#publicClient.decodeEventLog({
              abi      : UNISWAP_V4_ABI,
              eventName: 'LiquidityAdded',
              data     : log.data,
              topics   : log.topics,
            });
            realA0 = decoded.amount0;
            realA1 = decoded.amount1;
            liq    = decoded.liquidity;
            break;
          } catch { /* log d'un autre contrat */ }
        }

        console.info(`[Liquidity] Liquidité ajoutée — liq: ${liq} | tx: ${txHash}`);
      } catch (e) {
        throw LiquidityError.txFailed(e.message);
      }
    } else {
      liq = BigInt(Math.floor(Math.sqrt(Number(a0) * Number(a1))));
      console.debug('[Liquidity] Mode local — estimation géométrique');
    }

    const pos = new LiquidityPosition({ pool, amount0: realA0, amount1: realA1, liquidity: liq, recipient, txHash });
    if (!this.#positions.has(pool)) this.#positions.set(pool, []);
    this.#positions.get(pool).push(pos);
    this.#totalLiquidityProvided += liq;
    this.lastAddLiquidity = Date.now();

    if (rewards && typeof rewards.totalSkyEarned === 'number') {
      rewards.totalSkyEarned += REWARD_LIQUIDITY;
    }
    if (this.#treasury) {
      await this.#treasury.distributeRewards(REWARD_LIQUIDITY, rewards).catch(() => {});
    }

    return pos;
  }

  // ─── Retrait de liquidité ─────────────────────────────────────

  async removeLiquidity({ pool, liquidity, recipient }) {
    const liq = BigInt(liquidity ?? 0);
    if (liq === 0n) throw LiquidityError.invalidAmount();

    const deadline = this.#deadline();
    let amount0 = 0n, amount1 = 0n, txHash = null;

    if (this.#contract && this.#walletClient) {
      try {
        const hash = await this.#contract.write.removeLiquidity([
          pool, liq, 0n, 0n, recipient, deadline
        ]);
        const receipt = await this.#publicClient.waitForTransactionReceipt({ hash });
        txHash = hash;

        for (const log of receipt.logs) {
          try {
            const decoded = this.#publicClient.decodeEventLog({
              abi      : UNISWAP_V4_ABI,
              eventName: 'LiquidityRemoved',
              data     : log.data,
              topics   : log.topics,
            });
            amount0 = decoded.amount0;
            amount1 = decoded.amount1;
            break;
          } catch { /* skip */ }
        }

        console.info(`[Liquidity] Liquidité retirée — tx: ${txHash}`);
      } catch (e) {
        throw LiquidityError.txFailed(e.message);
      }
    }

    // Mise à jour registre local
    const positions = this.#positions.get(pool) ?? [];
    let remaining = liq;
    for (let i = positions.length - 1; i >= 0 && remaining > 0n; i--) {
      if (positions[i].liquidity <= remaining) {
        remaining -= positions[i].liquidity;
        positions.splice(i, 1);
      }
    }
    this.#totalLiquidityProvided = this.#totalLiquidityProvided > liq
      ? this.#totalLiquidityProvided - liq : 0n;

    return { amount0, amount1, txHash };
  }

  // ─── Configuration ────────────────────────────────────────────

  setSlippageTolerance(tolerance) {
    this.slippageTolerance = Math.max(SLIPPAGE_MIN, Math.min(SLIPPAGE_MAX, tolerance));
    console.info(`[Liquidity] Slippage → ${(this.slippageTolerance * 100).toFixed(2)}%`);
  }

  setTreasury(treasury) { this.#treasury = treasury; }

  destroy() {
    if (this.#unwatch) { this.#unwatch(); this.#unwatch = null; }
  }

  // ─── Stats ────────────────────────────────────────────────────

  get totalLiquidityProvided() { return this.#totalLiquidityProvided; }

  getPositions(pool = null) {
    if (pool) return this.#positions.get(pool) ?? [];
    return [...this.#positions.values()].flat();
  }

  stats() {
    return {
      totalLiquidityProvided: this.#totalLiquidityProvided.toString(),
      activePositions       : this.getPositions().length,
      pools                 : this.#positions.size,
      slippageTolerance     : this.slippageTolerance,
      deadlineMinutes       : this.deadlineMinutes,
      lastAddLiquidity      : this.lastAddLiquidity,
      providerConnected     : !!this.#publicClient,
      signerConnected       : !!this.#walletClient,
    };
  }

  // ─── Privés ───────────────────────────────────────────────────

  #applySlippage(amount) {
    const factor = BigInt(Math.floor((1 - this.slippageTolerance) * 10_000));
    return amount * factor / 10_000n;
  }

  #deadline() {
    return BigInt(Math.floor(Date.now() / 1000) + this.deadlineMinutes * 60);
  }
}
