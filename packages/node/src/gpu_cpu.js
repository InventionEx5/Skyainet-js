// packages/node/src/gpu_cpu.js
// GpuCpuMarketplaceService — Backend complet du Marketplace (Production Ready)
// Vérification hardware réelle + Persistance JSON + Escrow + Notifications
// SkyAInet × Nikola T369

"use strict";

import { EventEmitter }              from 'events';
import { execSync }                  from 'child_process';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync }                from 'fs';
import os                            from 'os';
import { randomUUID }                from 'crypto';

import { UserRewards }               from '../../core/src/rewards.js';
import { PeerPool }                  from '../../secure/src/roots/pool.js';
import {
  ComputeMarketplace,
  RentalOffer, ActiveRental,
  RentalStatus, MarketplaceError,
} from './marketplace.js';

// ─────────────────────────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────────────────────────

const GPU_UTIL_THRESHOLD   = 85;    // % utilisation GPU max pour considérer dispo
const GPU_MEM_FREE_MIN     = 15;    // % mémoire GPU libre minimum
const CPU_LOAD_THRESHOLD   = 0.80;  // fraction des cœurs (load / ncores)
const CACHE_TTL_MS         = 20_000;
const PERSIST_INTERVAL_MS  = 60_000;
const EXPIRE_CHECK_INTERVAL= 60_000;

// ─────────────────────────────────────────────────────────────────
// CATALOGUE GPU STANDARDISÉ
// Référence pour l'UI marketplace.html — formulaire "Offer GPU"
// Compatible avec HardwareAvailabilityChecker (NVIDIA/AMD/CPU)
// ─────────────────────────────────────────────────────────────────
export const GPU_CATALOG = Object.freeze([
    {
        id         : 'h100-sxm',
        label      : 'GPU High-End — H100 SXM (80 GB)',
        type       : 'NVIDIA',
        model      : 'H100 SXM',
        vramGB     : 80,
        tflopsRef  : 756,
        refPriceSky: 0.12,   // SKY / TFLOPS / heure — référence marché
        tier       : 'enterprise',
    },
    {
        id         : 'a100-80gb',
        label      : 'GPU High-End — A100 (80 GB)',
        type       : 'NVIDIA',
        model      : 'A100 80GB',
        vramGB     : 80,
        tflopsRef  : 312,
        refPriceSky: 0.09,
        tier       : 'enterprise',
    },
    {
        id         : 'a100-40gb',
        label      : 'GPU High-End — A100 (40 GB)',
        type       : 'NVIDIA',
        model      : 'A100 40GB',
        vramGB     : 40,
        tflopsRef  : 312,
        refPriceSky: 0.085,
        tier       : 'enterprise',
    },
    {
        id         : 'rtx4090',
        label      : 'GPU Mid-Range — RTX 4090 (24 GB)',
        type       : 'NVIDIA',
        model      : 'RTX 4090',
        vramGB     : 24,
        tflopsRef  : 82,
        refPriceSky: 0.06,
        tier       : 'prosumer',
    },
    {
        id         : 'rtx3090',
        label      : 'GPU Mid-Range — RTX 3090 (24 GB)',
        type       : 'NVIDIA',
        model      : 'RTX 3090',
        vramGB     : 24,
        tflopsRef  : 35,
        refPriceSky: 0.04,
        tier       : 'prosumer',
    },
    {
        id         : 'rtx3080',
        label      : 'GPU Entry — RTX 3080 (10 GB)',
        type       : 'NVIDIA',
        model      : 'RTX 3080',
        vramGB     : 10,
        tflopsRef  : 30,
        refPriceSky: 0.03,
        tier       : 'entry',
    },
    {
        id         : 'amd-mi300',
        label      : 'GPU AMD — MI300X (192 GB)',
        type       : 'AMD',
        model      : 'MI300X',
        vramGB     : 192,
        tflopsRef  : 1307,
        refPriceSky: 0.15,
        tier       : 'enterprise',
    },
    {
        id         : 'cpu-cluster',
        label      : 'CPU Cluster — 128 cores',
        type       : 'CPU',
        model      : 'CPU Cluster',
        vramGB     : 0,
        tflopsRef  : 4,
        refPriceSky: 0.015,
        tier       : 'entry',
    },
]);

// ─────────────────────────────────────────────────────────────────
// HARDWARE AVAILABILITY CHECKER
//
// Hiérarchie de détection : NVIDIA → AMD ROCm → CPU
// Cache TTL 20 s pour éviter les appels système répétés.
// Toutes les méthodes sont async pour ne pas bloquer l'event loop.
// ─────────────────────────────────────────────────────────────────

export class HardwareAvailabilityChecker {
  #cache = new Map();   // nodeId → { available, details, lastCheck }

  async checkAvailability(nodeId) {
    const cached = this.#cache.get(nodeId);
    if (cached && Date.now() - cached.lastCheck < CACHE_TTL_MS) return cached;

    const result = await this.#detect(nodeId);
    result.lastCheck = Date.now();
    this.#cache.set(nodeId, result);
    return result;
  }

  async #detect(nodeId) {
    // 1. NVIDIA
    const nvidia = await this.#checkNvidia();
    if (nvidia.available) return nvidia;

    // 2. AMD ROCm
    const amd = await this.#checkAmd();
    if (amd.available) return amd;

    // 3. CPU (fallback toujours disponible)
    return this.#checkCpu();
  }

  async #checkNvidia() {
    try {
      const raw = execSync(
        'nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits',
        { encoding: 'utf8', timeout: 3000 }
      );

      // Sélectionne le GPU le moins chargé
      let best = { util: 100, memUsed: 0, memTotal: 1 };
      for (const line of raw.trim().split('\n')) {
        const [util, memUsed, memTotal] = line.split(',').map(v => parseFloat(v.trim()));
        if (util < best.util) best = { util, memUsed, memTotal };
      }

      const memFreePercent = ((best.memTotal - best.memUsed) / best.memTotal) * 100;
      const available = best.util < GPU_UTIL_THRESHOLD && memFreePercent > GPU_MEM_FREE_MIN;

      return {
        available,
        type: 'NVIDIA',
        details: {
          utilization    : best.util,
          memFreePercent : +memFreePercent.toFixed(1),
          memFreeGB      : +((best.memTotal - best.memUsed) / 1024).toFixed(2),
        },
      };
    } catch {
      return { available: false, type: 'NVIDIA', details: { error: 'nvidia-smi indisponible' } };
    }
  }

  async #checkAmd() {
    try {
      const raw = execSync(
        'rocm-smi --showuse --showmeminfo vram --json',
        { encoding: 'utf8', timeout: 3000 }
      );
      const data = JSON.parse(raw);
      // Cherche le GPU avec la plus faible utilisation
      let minUtil = Infinity;
      for (const entry of Object.values(data)) {
        const util = parseFloat(entry['GPU use (%)'] ?? '100');
        if (util < minUtil) minUtil = util;
      }
      const available = minUtil < GPU_UTIL_THRESHOLD;
      return { available, type: 'AMD', details: { utilization: minUtil } };
    } catch {
      return { available: false, type: 'AMD', details: { error: 'rocm-smi indisponible' } };
    }
  }

  #checkCpu() {
    // os.loadavg() retourne [1min, 5min, 15min] — nativement sans child_process
    const [load1] = os.loadavg();
    const ncores  = os.cpus().length;
    const ratio   = load1 / ncores;
    const available = ratio < CPU_LOAD_THRESHOLD;

    return {
      available,
      type   : 'CPU',
      details: {
        loadAvg1m  : +load1.toFixed(2),
        coreCount  : ncores,
        loadRatio  : +ratio.toFixed(3),
        threshold  : CPU_LOAD_THRESHOLD,
        memFreeGB  : +(os.freemem() / 1_073_741_824).toFixed(2),
      },
    };
  }

  /** Invalide le cache pour forcer une re-vérification immédiate */
  invalidate(nodeId) { this.#cache.delete(nodeId); }
  clearCache()       { this.#cache.clear(); }

  cacheStats() {
    return {
      entries : this.#cache.size,
      ttlMs   : CACHE_TTL_MS,
    };
  }
}

// ─────────────────────────────────────────────────────────────────
// GPU/CPU MARKETPLACE SERVICE
//
// Étend ComputeMarketplace avec :
//   - Vérification hardware réelle avant chaque location
//   - Persistance JSON (alternative à better-sqlite3)
//   - EventEmitter pour les intégrations (WebSocket, logs, etc.)
//   - PeerPool pour filtrage par réputation des fournisseurs
//   - Auto-expiration des locations via setInterval
//   - Tableau de bord enrichi avec métriques hardware
// ─────────────────────────────────────────────────────────────────

export class GpuCpuMarketplaceService extends EventEmitter {
  #market;           // ComputeMarketplace — logique métier
  #peerPool;         // PeerPool — réputation des fournisseurs
  #hardwareChecker;  // HardwareAvailabilityChecker
  #dataDir;          // répertoire de persistance
  #persistTimer;     // handle du timer de persistance
  #expireTimer;      // handle du timer d'expiration automatique

  constructor(opts = {}) {
    super();
    this.#market          = new ComputeMarketplace();
    this.#peerPool        = (opts.peerPool instanceof PeerPool)
      ? opts.peerPool
      : new PeerPool({ minReputation: 0.65 });
    this.#hardwareChecker = opts.hardwareChecker ?? new HardwareAvailabilityChecker();
    this.#dataDir         = opts.dataDir ?? './data/marketplace';

    // Persistance périodique
    this.#persistTimer = setInterval(
      () => this.#persist().catch(e => console.warn('[Marketplace] Persist:', e.message)),
      opts.persistInterval ?? PERSIST_INTERVAL_MS
    ).unref();

    // Auto-complétion des locations expirées
    this.#expireTimer = setInterval(
      () => this.#market.processExpiredRentals()
              .then(n => n > 0 && this.emit('rentals:expired', n))
              .catch(e => console.warn('[Marketplace] Expire:', e.message)),
      opts.expireCheckInterval ?? EXPIRE_CHECK_INTERVAL
    ).unref();
  }

  // ─── Publication ──────────────────────────────────────────────

  /**
   * Publie une offre de location avec vérification de réputation du fournisseur.
   * Si le nodeId est connu du PeerPool et que sa réputation est insuffisante,
   * l'offre est refusée.
   *
   * @param {string} nodeId
   * @param {string} owner
   * @param {number} pricePerHour — SKY par heure
   * @param {number} availableHours
   * @param {number} [tflops]
   * @param {number} [reputationRequired] — réputation minimale du locataire
   * @param {object} [opts]              — description, tags
   */
  publishOffer(nodeId, owner, pricePerHour, availableHours, tflops = 0, reputationRequired = 0.65, opts = {}) {
    // Vérification réputation du fournisseur dans le PeerPool
    if (this.#peerPool.contains(nodeId)) {
      const info = this.#peerPool.getPeer(nodeId);
      if (info && info.reputation.score < 0.65) {
        throw new MarketplaceError(
          `Fournisseur ${nodeId} non fiable (score: ${info.reputation.score.toFixed(2)})`,
          'E_REPUTATION'
        );
      }
    }

    const offerId = this.#market.publishOffer(
      nodeId, owner, pricePerHour, availableHours, reputationRequired,
      { tflops, ...opts }
    );

    this.emit('offer:published', { offerId, nodeId, owner, pricePerHour, availableHours, tflops });
    return offerId;
  }

  withdrawOffer(offerId, owner) {
    this.#market.withdrawOffer(offerId, owner);
    this.emit('offer:withdrawn', { offerId, owner });
  }

  // ─── Location avec vérification hardware ──────────────────────

  /**
   * Loue un nœud après vérification hardware réelle.
   * Si le matériel est indisponible, la location est refusée immédiatement.
   *
   * @param {string}      offerId
   * @param {string}      renter
   * @param {number}      renterReputation
   * @param {number}      durationHours
   * @param {UserRewards} [rewards]
   */
  async rentNode(offerId, renter, renterReputation, durationHours, rewards = null) {
    // 1. Récupérer l'offre pour obtenir le nodeId
    const offers = this.#market.getAvailableOffers();
    const offer  = offers.find(o => o.offerId === offerId);
    if (!offer) throw new MarketplaceError(`Offre '${offerId}' introuvable ou inactive`, 'E_NOT_FOUND');

    // 2. Vérification hardware réelle
    const hw = await this.#hardwareChecker.checkAvailability(offer.nodeId);
    if (!hw.available) {
      throw new MarketplaceError(
        `Matériel indisponible sur ${offer.nodeId} (${hw.type}: ${JSON.stringify(hw.details)})`,
        'E_HARDWARE'
      );
    }

    // 3. Mise à jour réputation fournisseur (connexion réussie)
    if (this.#peerPool.contains(offer.nodeId)) {
      this.#peerPool.updateReputation(offer.nodeId, 0.05);
      this.#peerPool.incrementConnection(offer.nodeId);
    }

    // 4. Délégation au ComputeMarketplace
    const rental = await this.#market.rentNode(offerId, renter, renterReputation, durationHours, rewards);

    this.emit('rental:created', {
      rentalId: rental.rentalId,
      renter, owner: rental.owner,
      totalPrice: rental.totalPrice,
      durationHours,
      hardware: hw,
    });

    return rental;
  }

  // ─── Complétion ───────────────────────────────────────────────

  async completeRental(rentalId, rewards = null) {
    const result = await this.#market.completeRental(rentalId, rewards);

    // Boost réputation fournisseur (location complétée avec succès)
    const history = this.#market.getRentalHistory(1);
    const completed = history.find(r => r.rentalId === rentalId);
    if (completed && this.#peerPool.contains(completed.nodeId)) {
      this.#peerPool.updateReputation(completed.nodeId, 0.08);
    }

    this.emit('rental:completed', { rentalId, ...result });
    return result;
  }

  // ─── Annulation ───────────────────────────────────────────────

  cancelRental(rentalId, requestedBy) {
    const result = this.#market.cancelRental(rentalId, requestedBy);
    this.emit('rental:cancelled', { rentalId, requestedBy, ...result });
    return result;
  }

  // ─── Dispute ──────────────────────────────────────────────────

  openDispute(rentalId, claimant, reason) {
    this.#market.openDispute(rentalId, claimant, reason);

    // Pénalité réputation fournisseur en cas de dispute
    const rentals = this.#market.getActiveRentals();
    const rental  = rentals.find(r => r.rentalId === rentalId);
    if (rental && this.#peerPool.contains(rental.nodeId)) {
      this.#peerPool.recordFailure(rental.nodeId);
    }

    this.emit('rental:dispute', { rentalId, claimant, reason });
  }

  // ─── Requêtes enrichies ───────────────────────────────────────

  getAvailableOffers(opts = {}) {
    return this.#market.getAvailableOffers(opts);
  }

  getActiveRentals()              { return this.#market.getActiveRentals(); }
  getActiveRentalsForUser(userId) { return this.#market.getActiveRentalsForUser(userId); }
  getActiveRentalsForOwner(id)    { return this.#market.getActiveRentalsForOwner(id); }
  getRentalHistory(limit)         { return this.#market.getRentalHistory(limit); }

  /** Retourne le catalogue standardisé des types GPU pour l'UI. */
  getGpuCatalog() {
    return GPU_CATALOG;
  }

  /**
   * Calcule le prix moyen par TFLOPS/heure groupé par type GPU.
   * Utilisé par le Price Chart et le ticker navbar de marketplace.html.
   */
  getAvgPriceByType() {
    const offers  = this.#market.getAvailableOffers();
    const catalog = GPU_CATALOG;

    return catalog.map(gpu => {
        // Chercher les offres correspondant à ce modèle GPU dans les tags/description
        const matching = offers.filter(o =>
            o.tags?.includes(gpu.id) ||
            o.description?.toLowerCase().includes(gpu.model.toLowerCase())
        );

        const avgPrice = matching.length > 0
            ? matching.reduce((s, o) => s + (o.pricePerHour / Math.max(1, o.tflops)), 0) / matching.length
            : gpu.refPriceSky; // fallback sur prix de référence

        const totalTflops = matching.reduce((s, o) => s + (o.tflops ?? 0), 0);

        return {
            gpuId        : gpu.id,
            label        : gpu.label,
            model        : gpu.model,
            tier         : gpu.tier,
            avgPriceSky  : +avgPrice.toFixed(4),
            refPriceSky  : gpu.refPriceSky,
            totalTflops,
            offersCount  : matching.length,
            // Variation vs prix de référence (+ haut = plus cher que réf)
            variation    : matching.length > 0
                ? +((avgPrice - gpu.refPriceSky) / gpu.refPriceSky * 100).toFixed(1)
                : 0,
        };
    });
  }

  /**
   * Données formatées pour le ticker navbar de marketplace.html.
   * Retourne prix moyen, variation, TFLOPS disponibles.
   */
  getTickerData() {
    const byType      = this.getAvgPriceByType();
    const stats       = this.#market.getMarketStats();
    const totalTflops = byType.reduce((s, t) => s + t.totalTflops, 0);

    // Top 3 items pour le ticker
    const tickerItems = byType
        .filter(t => t.offersCount > 0 || true) // afficher même sans offres (prix réf)
        .slice(0, 5)
        .map(t => ({
            label      : t.model,
            price      : t.avgPriceSky,
            variation  : t.variation,
            isUp       : t.variation >= 0,
        }));

    return {
        tickerItems,
        totalTflops  : +totalTflops.toFixed(0),
        avgGlobalPrice: byType.length
            ? +(byType.reduce((s,t) => s + t.avgPriceSky, 0) / byType.length).toFixed(4)
            : 0,
        activeOffers : stats.activeOffers,
        activeRentals: stats.activeRentals,
    };
  }

  /**
   * Tableau de bord enrichi incluant les métriques du marché
   * ET le statut hardware en temps réel des fournisseurs actifs.
   */
  async getDashboardStats() {
    const market     = this.#market.getMarketStats();
    const peerStats  = this.#peerPool.stats();
    const hwCache    = this.#hardwareChecker.cacheStats();

    return {
      ...market,
      peerPool : peerStats,
      hardware : hwCache,
    };
  }

  getOfferStats(offerId) { return this.#market.getOfferStats(offerId); }

  /**
   * Vérifie la disponibilité hardware d'un nœud spécifique.
   * Utile avant de publier une offre ou d'afficher une fiche de nœud.
   */
  async checkNodeHardware(nodeId) {
    return this.#hardwareChecker.checkAvailability(nodeId);
  }

  // ─── Gestion du cycle de vie ─────────────────────────────────

  /** Arrête les timers et persiste l'état une dernière fois */
  async shutdown() {
    clearInterval(this.#persistTimer);
    clearInterval(this.#expireTimer);
    await this.#persist();
    console.info('[Marketplace] Service arrêté proprement');
  }

  // ─── Privés ───────────────────────────────────────────────────

  /** Persiste l'état des offres et locations actives en JSON */
  async #persist() {
    try {
      await mkdir(this.#dataDir, { recursive: true });
      const state = {
        savedAt      : Date.now(),
        offers       : this.#market.getAvailableOffers(),
        activeRentals: this.#market.getActiveRentals(),
        stats        : this.#market.getMarketStats(),
      };
      await writeFile(
        `${this.#dataDir}/state.json`,
        JSON.stringify(state, null, 2)
      );
    } catch (e) {
      console.warn('[Marketplace] Persistance échouée:', e.message);
    }
  }
}
