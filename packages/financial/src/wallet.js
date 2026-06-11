// packages/financial/src/wallet.js
// =====================================================
// SkyWallet — Couche d'abstraction Wallet SKY Token
//
// Responsabilités :
//   • Connexion wallet (privateKey ou browser injected)
//   • Lecture du solde SKY (balanceOf ERC-20)
//   • Envoi de SKY (transfer ERC-20)
//   • Historique des transactions (Transfer events)
//   • Validation des adresses (isAddress)
//   • Conversion wei ↔ SKY (18 décimales)
//
// Séparation des rôles :
//   treasury.js  → distribution globale, burn, DAO
//   wallet.js    → wallet utilisateur, send/receive, balance
//
// SkyAInet × Nikola T369
// =====================================================

"use strict";

import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  parseUnits,
  formatUnits,
  isAddress,
  getContract,
  decodeEventLog,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

// ─────────────────────────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────────────────────────

const SKY_DECIMALS     = 18;
const TX_HISTORY_LIMIT = 50;   // transactions gardées en mémoire

// ABI minimal ERC-20 SKY Token
const SKY_TOKEN_ABI = parseAbi([
  // Lecture
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  // Écriture
  'function transfer(address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transferFrom(address from, address to, uint256 amount) returns (bool)',
  // Events
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event Approval(address indexed owner, address indexed spender, uint256 value)',
]);

// ─────────────────────────────────────────────────────────────────
// ERREURS
// ─────────────────────────────────────────────────────────────────

export class WalletError extends Error {
  constructor(message, code = 'WALLET_ERROR') {
    super(message);
    this.name = 'WalletError';
    this.code = code;
  }
  static notConnected()          { return new WalletError('Wallet not connected. Call connect() first.',            'NOT_CONNECTED'); }
  static invalidAddress(addr)    { return new WalletError(`Invalid address: ${addr}`,                              'INVALID_ADDRESS'); }
  static insufficientBalance(have, need) {
    return new WalletError(`Insufficient balance — have: ${have} SKY, need: ${need} SKY`, 'INSUFFICIENT_BALANCE');
  }
  static transferFailed(msg)     { return new WalletError(`Transfer failed: ${msg}`,                               'TRANSFER_FAILED'); }
  static noTokenContract()       { return new WalletError('SKY Token contract address not configured.',             'NO_CONTRACT'); }
}

// ─────────────────────────────────────────────────────────────────
// TRANSACTION — enregistrement
// ─────────────────────────────────────────────────────────────────

export class WalletTransaction {
  /**
   * @param {'send'|'receive'|'approve'} type
   * @param {string}  from
   * @param {string}  to
   * @param {number}  amount       — en SKY (pas en wei)
   * @param {string}  [txHash]
   * @param {string}  [label]      — étiquette lisible
   */
  constructor(type, from, to, amount, txHash = null, label = null) {
    this.id        = `tx_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    this.type      = type;
    this.from      = from;
    this.to        = to;
    this.amount    = amount;
    this.txHash    = txHash;
    this.label     = label ?? (type === 'send' ? `To ${to.slice(0, 8)}…` : `From ${from.slice(0, 8)}…`);
    this.timestamp = Date.now();
    this.status    = 'pending';   // pending | confirmed | failed
  }

  confirm(txHash = null) {
    this.status = 'confirmed';
    if (txHash) this.txHash = txHash;
    return this;
  }

  fail(reason = null) {
    this.status = 'failed';
    this.failReason = reason;
    return this;
  }

  toJSON() {
    return {
      id       : this.id,
      type     : this.type,
      from     : this.from,
      to       : this.to,
      amount   : this.amount,
      txHash   : this.txHash,
      label    : this.label,
      timestamp: this.timestamp,
      status   : this.status,
    };
  }
}

// ─────────────────────────────────────────────────────────────────
// SKY WALLET
// ─────────────────────────────────────────────────────────────────

export class SkyWallet {
  #publicClient;      // viem PublicClient — lecture on-chain
  #walletClient;      // viem WalletClient — écriture on-chain
  #tokenContract;     // instance ERC-20 SKY Token
  #account;           // viem Account | null
  #address;           // string | null — adresse connectée
  #tokenAddress;      // string | null — adresse du contrat SKY
  #chainId;
  #balance;           // number — solde en SKY (cache)
  #lastBalanceFetch;  // timestamp du dernier fetch
  #txHistory;         // WalletTransaction[]
  #unwatchTransfers;  // stop listener Transfer events

  /**
   * @param {object}  opts
   * @param {string}  opts.rpcUrl         — URL RPC
   * @param {string}  opts.tokenAddress   — adresse contrat SKY ERC-20
   * @param {number}  [opts.chainId]      — défaut: 1
   * @param {string}  [opts.privateKey]   — clé privée `0x…` (optionnel)
   * @param {string}  [opts.walletAddress]— adresse en lecture seule (sans clé privée)
   */
  constructor(opts = {}) {
    this.#tokenAddress   = opts.tokenAddress   ?? null;
    this.#chainId        = opts.chainId        ?? 1;
    this.#account        = null;
    this.#address        = opts.walletAddress  ?? null;
    this.#balance        = 0;
    this.#lastBalanceFetch = 0;
    this.#txHistory      = [];
    this.#unwatchTransfers = null;
    this.#publicClient   = null;
    this.#walletClient   = null;
    this.#tokenContract  = null;

    if (opts.rpcUrl) {
      this.#initClients(opts.rpcUrl, opts.privateKey);
    }
  }

  // ─── Initialisation ───────────────────────────────────────────

  #initClients(rpcUrl, privateKey = null) {
    try {
      const chain = {
        id             : this.#chainId,
        name           : 'skyainet',
        nativeCurrency : { name: 'SKY', symbol: 'SKY', decimals: SKY_DECIMALS },
        rpcUrls        : { default: { http: [rpcUrl] } },
      };
      const transport = http(rpcUrl);

      this.#publicClient = createPublicClient({ chain, transport });

      if (privateKey) {
        this.#account      = privateKeyToAccount(privateKey);
        this.#address      = this.#account.address;
        this.#walletClient = createWalletClient({ account: this.#account, chain, transport });
      }

      if (this.#tokenAddress && this.#publicClient) {
        this.#tokenContract = getContract({
          address: this.#tokenAddress,
          abi    : SKY_TOKEN_ABI,
          client : { public: this.#publicClient, wallet: this.#walletClient },
        });
        this.#watchIncomingTransfers();
      }

      console.info(`[SkyWallet] Initialisé | address: ${this.#address ?? 'read-only'} | token: ${this.#tokenAddress}`);
    } catch (e) {
      console.warn(`[SkyWallet] Provider non disponible (${e.message}) — mode local`);
    }
  }

  // ─── Connexion ────────────────────────────────────────────────

  /**
   * Connecte un wallet par clé privée.
   * Pour une app desktop (Tauri) ou un nœud serveur.
   * En production, préférer connectBrowser() pour les apps web.
   *
   * @param {string} privateKey — clé privée `0x…`
   * @param {string} rpcUrl
   */
  connect(privateKey, rpcUrl) {
    if (!privateKey?.startsWith('0x') || privateKey.length < 66) {
      throw new WalletError('Invalid private key format', 'INVALID_KEY');
    }
    this.#initClients(rpcUrl, privateKey);
    return { address: this.#address, connected: true };
  }

  /**
   * Connexion via wallet injecté dans le navigateur (MetaMask, etc.).
   * Demande les permissions à l'utilisateur.
   *
   * @returns {Promise<{ address: string, chainId: number }>}
   */
  async connectBrowser() {
    if (typeof window === 'undefined' || !window.ethereum) {
      throw new WalletError('No browser wallet detected (MetaMask or compatible required)', 'NO_BROWSER_WALLET');
    }

    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    if (!accounts?.length) {
      throw new WalletError('User denied wallet connection', 'USER_REJECTED');
    }

    this.#address = accounts[0];
    const chainId = parseInt(await window.ethereum.request({ method: 'eth_chainId' }), 16);
    this.#chainId = chainId;

    // Pas de viem WalletClient — on appelle eth_sendTransaction directement
    console.info(`[SkyWallet] Browser wallet connecté : ${this.#address}`);
    return { address: this.#address, chainId };
  }

  /**
   * Connexion en lecture seule — aucune signature possible.
   * Utile pour afficher le solde d'une adresse sans clé privée.
   *
   * @param {string} address — adresse `0x…`
   */
  connectReadOnly(address) {
    if (!isAddress(address)) throw WalletError.invalidAddress(address);
    this.#address = address;
    console.info(`[SkyWallet] Read-only : ${address}`);
    return { address, readOnly: true };
  }

  // ─── Solde ────────────────────────────────────────────────────

  /**
   * Lit le solde SKY on-chain (balanceOf).
   * Cache de 30 secondes pour éviter les appels répétés.
   *
   * @param {boolean} force — ignorer le cache
   * @returns {Promise<number>} solde en SKY
   */
  async getBalance(force = false) {
    if (!this.#address) throw WalletError.notConnected();

    const now = Date.now();
    if (!force && now - this.#lastBalanceFetch < 30_000 && this.#balance > 0) {
      return this.#balance;
    }

    if (!this.#tokenContract) {
      // Mode hors-ligne — retourner le cache local
      console.debug('[SkyWallet] getBalance — mode local (pas de provider)');
      return this.#balance;
    }

    try {
      const rawBalance   = await this.#tokenContract.read.balanceOf([this.#address]);
      this.#balance      = Number(formatUnits(rawBalance, SKY_DECIMALS));
      this.#lastBalanceFetch = now;
      return this.#balance;
    } catch (e) {
      console.warn(`[SkyWallet] getBalance échoué : ${e.message}`);
      return this.#balance; // retourner le cache
    }
  }

  /**
   * Crédite le solde local (pour les rewards claims, sans tx on-chain).
   * @param {number} amount
   */
  creditLocal(amount) {
    if (amount <= 0) throw new WalletError('Amount must be positive', 'INVALID_AMOUNT');
    this.#balance += amount;
    this.#txHistory.unshift(new WalletTransaction(
      'receive', 'rewards', this.#address ?? 'local', amount, null, 'Rewards claim'
    ).confirm());
    this.#pruneHistory();
    return this.#balance;
  }

  /**
   * Débite le solde local (pour les abonnements SKY, sans tx on-chain).
   * @param {number} amount
   * @param {string} label
   */
  debitLocal(amount, label = 'Subscription') {
    if (amount <= 0) throw new WalletError('Amount must be positive', 'INVALID_AMOUNT');
    if (this.#balance < amount) throw WalletError.insufficientBalance(this.#balance, amount);
    this.#balance -= amount;
    this.#txHistory.unshift(new WalletTransaction(
      'send', this.#address ?? 'local', 'subscription', amount, null, label
    ).confirm());
    this.#pruneHistory();
    return this.#balance;
  }

  // ─── Envoi ────────────────────────────────────────────────────

  /**
   * Envoie des SKY à une adresse.
   *
   * Modes :
   *   1. walletClient configuré (clé privée) → viem transfer on-chain
   *   2. window.ethereum disponible          → MetaMask eth_sendTransaction
   *   3. Aucun provider                      → mise à jour locale uniquement
   *
   * @param {string}  to         — adresse destination `0x…`
   * @param {number}  amount     — montant en SKY
   * @param {string}  [label]    — étiquette pour l'historique
   * @returns {Promise<WalletTransaction>}
   */
  async sendSKY(to, amount, label = null) {
    if (!this.#address) throw WalletError.notConnected();
    if (!isAddress(to))  throw WalletError.invalidAddress(to);
    if (amount <= 0)     throw new WalletError('Amount must be positive', 'INVALID_AMOUNT');

    const balance = await this.getBalance();
    if (balance < amount) throw WalletError.insufficientBalance(balance, amount);

    const tx = new WalletTransaction('send', this.#address, to, amount, null, label ?? `To ${to.slice(0, 8)}…`);

    try {
      // Mode 1 — viem WalletClient (clé privée)
      if (this.#walletClient && this.#tokenContract) {
        const amountWei = parseUnits(amount.toString(), SKY_DECIMALS);
        const hash      = await this.#tokenContract.write.transfer([to, amountWei]);
        await this.#publicClient.waitForTransactionReceipt({ hash });
        tx.confirm(hash);
        this.#balance -= amount;
        console.info(`[SkyWallet] Transfer OK — ${amount} SKY → ${to} | tx: ${hash}`);

      // Mode 2 — MetaMask / browser wallet
      } else if (typeof window !== 'undefined' && window.ethereum && this.#tokenAddress) {
        const amountHex = '0x' + parseUnits(amount.toString(), SKY_DECIMALS).toString(16);
        // Encode ERC-20 transfer(address,uint256)
        const data = '0xa9059cbb' +
          to.replace('0x', '').padStart(64, '0') +
          amountHex.replace('0x', '').padStart(64, '0');

        const hash = await window.ethereum.request({
          method: 'eth_sendTransaction',
          params: [{ from: this.#address, to: this.#tokenAddress, data }],
        });
        tx.confirm(hash);
        this.#balance -= amount;
        console.info(`[SkyWallet] Browser transfer OK — ${amount} SKY → ${to} | tx: ${hash}`);

      // Mode 3 — Local uniquement (pas de provider)
      } else {
        console.warn('[SkyWallet] No provider — local balance update only');
        this.#balance -= amount;
        tx.confirm(`local_${Date.now()}`);
      }

    } catch (e) {
      tx.fail(e.message);
      console.error(`[SkyWallet] Transfer failed : ${e.message}`);
      throw WalletError.transferFailed(e.message);
    }

    this.#txHistory.unshift(tx);
    this.#pruneHistory();
    return tx;
  }

  // ─── Historique ───────────────────────────────────────────────

  /**
   * Récupère l'historique des transactions Transfer depuis les logs on-chain.
   * Complète l'historique local avec les données blockchain.
   *
   * @param {number} limit — nombre de transactions max
   * @returns {Promise<WalletTransaction[]>}
   */
  async getTransactionHistory(limit = TX_HISTORY_LIMIT) {
    if (!this.#address) throw WalletError.notConnected();

    // Si on a un provider, enrichir avec les Transfer events on-chain
    if (this.#publicClient && this.#tokenAddress) {
      try {
        const block = await this.#publicClient.getBlockNumber();
        const from  = block > 10000n ? block - 10000n : 0n; // ~10k derniers blocks

        // Logs sortants (from = mon adresse)
        const outLogs = await this.#publicClient.getLogs({
          address  : this.#tokenAddress,
          event    : SKY_TOKEN_ABI.find(a => a.name === 'Transfer'),
          args     : { from: this.#address },
          fromBlock: from,
          toBlock  : 'latest',
        }).catch(() => []);

        // Logs entrants (to = mon adresse)
        const inLogs = await this.#publicClient.getLogs({
          address  : this.#tokenAddress,
          event    : SKY_TOKEN_ABI.find(a => a.name === 'Transfer'),
          args     : { to: this.#address },
          fromBlock: from,
          toBlock  : 'latest',
        }).catch(() => []);

        // Fusionner + trier par block décroissant
        const allLogs = [...outLogs, ...inLogs].sort((a, b) =>
          Number(b.blockNumber - a.blockNumber)
        );

        // Convertir en WalletTransaction
        for (const log of allLogs.slice(0, limit)) {
          const { from: logFrom, to: logTo, value } = log.args;
          const amount = Number(formatUnits(value, SKY_DECIMALS));
          const type   = logFrom.toLowerCase() === this.#address.toLowerCase() ? 'send' : 'receive';
          const hash   = log.transactionHash;

          // Ne pas dupliquer les tx déjà dans l'historique local
          if (!this.#txHistory.find(t => t.txHash === hash)) {
            const tx = new WalletTransaction(type, logFrom, logTo, amount, hash);
            tx.confirm(hash);
            this.#txHistory.push(tx);
          }
        }

        // Trier par timestamp décroissant
        this.#txHistory.sort((a, b) => b.timestamp - a.timestamp);
        this.#pruneHistory();

      } catch (e) {
        console.warn(`[SkyWallet] getTransactionHistory on-chain échoué : ${e.message}`);
      }
    }

    return this.#txHistory.slice(0, limit).map(t => t.toJSON());
  }

  // ─── Events en temps réel ────────────────────────────────────

  /**
   * Écoute les Transfer events entrants pour mise à jour automatique du solde.
   */
  #watchIncomingTransfers() {
    if (!this.#publicClient || !this.#tokenAddress || !this.#address) return;

    try {
      this.#unwatchTransfers = this.#publicClient.watchContractEvent({
        address  : this.#tokenAddress,
        abi      : SKY_TOKEN_ABI,
        eventName: 'Transfer',
        args     : { to: this.#address },
        onLogs   : (logs) => {
          for (const log of logs) {
            const amount = Number(formatUnits(log.args.value, SKY_DECIMALS));
            this.#balance += amount;
            const tx = new WalletTransaction(
              'receive', log.args.from, this.#address, amount,
              log.transactionHash, `From ${log.args.from.slice(0, 8)}…`
            ).confirm(log.transactionHash);
            this.#txHistory.unshift(tx);
            this.#pruneHistory();
            console.info(`[SkyWallet] Received ${amount} SKY from ${log.args.from}`);
          }
        },
      });
    } catch (e) {
      console.debug(`[SkyWallet] watchTransfers non disponible : ${e.message}`);
    }
  }

  // ─── Utilitaires ─────────────────────────────────────────────

  /** Valide une adresse `0x…`. */
  static validateAddress(address) {
    return isAddress(address);
  }

  /** Formate un montant SKY en string lisible. */
  static formatSKY(amount, decimals = 4) {
    return Number(amount).toFixed(decimals).replace(/\.?0+$/, '');
  }

  /** Convertit SKY → wei. */
  static toWei(amount) {
    return parseUnits(amount.toString(), SKY_DECIMALS);
  }

  /** Convertit wei → SKY. */
  static fromWei(wei) {
    return Number(formatUnits(BigInt(wei), SKY_DECIMALS));
  }

  #pruneHistory() {
    if (this.#txHistory.length > TX_HISTORY_LIMIT) {
      this.#txHistory = this.#txHistory.slice(0, TX_HISTORY_LIMIT);
    }
  }

  // ─── API publique ─────────────────────────────────────────────

  get address()          { return this.#address; }
  get isConnected()      { return !!this.#address; }
  get hasSigningKey()    { return !!this.#walletClient; }
  get cachedBalance()    { return this.#balance; }
  get txHistory()        { return this.#txHistory.map(t => t.toJSON()); }

  /**
   * Résumé pour la popup Wallet de skyainet.html.
   */
  async getSummary() {
    const balance = await this.getBalance().catch(() => this.#balance);
    return {
      address        : this.#address,
      balance,
      balanceFormatted: SkyWallet.formatSKY(balance),
      isConnected    : this.isConnected,
      hasSigningKey  : this.hasSigningKey,
      tokenAddress   : this.#tokenAddress,
      chainId        : this.#chainId,
      txCount        : this.#txHistory.length,
    };
  }

  destroy() {
    if (this.#unwatchTransfers) {
      this.#unwatchTransfers();
      this.#unwatchTransfers = null;
    }
  }
}

export default SkyWallet;
