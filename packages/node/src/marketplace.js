// packages/node/src/marketplace.js
// ComputeMarketplace — Marché de Puissance de Calcul Décentralisé
// Location sécurisée + Réputation + Paiements + Escrow + Rewards
// SkyAInet × Nikola T369

"use strict";

import { HybridTransport }           from '#hybrid';
import { UserRewards, RewardReason } from '#rewards';
import { randomUUID }                from 'crypto';

// ─────────────────────────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────────────────────────

const PLATFORM_FEE       = 0.07;  // 7 % de frais de plateforme
const OWNER_SHARE        = 1 - PLATFORM_FEE;           // 93 %
const ESCROW_RELEASE_LAG = 300;   // secondes après fin de location avant libération
const MIN_DURATION_HOURS = 1;
const MAX_DURATION_HOURS = 720;   // 30 jours
const MIN_REPUTATION     = 0.40;
const MAX_REPUTATION     = 0.95;

// ─────────────────────────────────────────────────────────────────
// STATUTS
// ─────────────────────────────────────────────────────────────────

export const RentalStatus = Object.freeze({
  Active   : 'Active',
  Completed: 'Completed',
  Cancelled: 'Cancelled',
  Disputed : 'Disputed',
});

// ─────────────────────────────────────────────────────────────────
// OFFRE DE LOCATION
// ─────────────────────────────────────────────────────────────────

export class RentalOffer {
  constructor({
    nodeId, owner,
    pricePerHour,
    availableHours,
    tflops            = 0,
    reputationRequired= 0.60,
    description       = '',
    tags              = [],
  }) {
    if (!nodeId?.trim())  throw new MarketplaceError('nodeId requis',         'E_INPUT');
    if (!owner?.trim())   throw new MarketplaceError('owner requis',          'E_INPUT');
    if (pricePerHour < 0) throw new MarketplaceError('Prix invalide',         'E_INPUT');
    if (availableHours <= 0) throw new MarketplaceError('Durée invalide',     'E_INPUT');

    this.offerId            = `offer-${randomUUID()}`;
    this.nodeId             = nodeId.trim();
    this.owner              = owner.trim();
    this.pricePerHour       = pricePerHour;
    this.availableHours     = availableHours;
    this.tflops             = Math.max(0, tflops);
    this.reputationRequired = Math.max(MIN_REPUTATION, Math.min(MAX_REPUTATION, reputationRequired));
    this.minDurationHours   = MIN_DURATION_HOURS;
    this.description        = description;
    this.tags               = tags;
    this.isActive           = true;
    this.createdAt          = Date.now();
    this.totalRentalsCount  = 0;
    this.totalRevenue       = 0;
  }
}

// ─────────────────────────────────────────────────────────────────
// LOCATION ACTIVE
// ─────────────────────────────────────────────────────────────────

export class ActiveRental {
  constructor({ rentalId, offerId, nodeId, renter, owner, totalPrice, durationHours, hardwareDetails = null }) {
    this.rentalId        = rentalId;
    this.offerId         = offerId;
    this.nodeId          = nodeId;
    this.renter          = renter;
    this.owner           = owner;
    this.startTime       = Date.now();
    this.endTime         = Date.now() + durationHours * 3_600_000;
    this.durationHours   = durationHours;
    this.totalPrice      = totalPrice;
    this.escrowAmount    = totalPrice;            // montant bloqué jusqu'à complétion
    this.ownerShare      = Math.floor(totalPrice * OWNER_SHARE);
    this.platformFee     = totalPrice - Math.floor(totalPrice * OWNER_SHARE);
    this.status          = RentalStatus.Active;
    this.hardwareDetails = hardwareDetails;
    this.completedAt     = null;
  }

  isExpired() { return Date.now() > this.endTime; }

  remainingMs() { return Math.max(0, this.endTime - Date.now()); }
}

// ─────────────────────────────────────────────────────────────────
// ERREUR TYPÉE
// ─────────────────────────────────────────────────────────────────

export class MarketplaceError extends Error {
  constructor(message, code = 'MARKET_ERROR') {
    super(message);
    this.name = 'MarketplaceError';
    this.code = code;
  }
}

// ─────────────────────────────────────────────────────────────────
// COMPUTE MARKETPLACE
// ─────────────────────────────────────────────────────────────────

export class ComputeMarketplace {
  #offers;           // Map<offerId, RentalOffer>
  #rentals;          // Map<rentalId, ActiveRental>
  #history;          // ActiveRental[] — locations terminées
  #totalVolumeSky;
  #totalFeesCollected;
  #hybrid;

  constructor() {
    this.#offers            = new Map();
    this.#rentals           = new Map();
    this.#history           = [];
    this.#totalVolumeSky    = 0;
    this.#totalFeesCollected= 0;
    this.#hybrid            = new HybridTransport(true);
  }

  // ─── Publication d'offre ─────────────────────────────────────

  publishOffer(nodeId, owner, pricePerHour, availableHours, reputationRequired = 0.60, opts = {}) {
    const offer = new RentalOffer({
      nodeId, owner, pricePerHour, availableHours, reputationRequired,
      tflops     : opts.tflops      ?? 0,
      description: opts.description ?? '',
      tags       : opts.tags        ?? [],
    });
    this.#offers.set(offer.offerId, offer);
    console.info(`[Marketplace] Offre publiée : ${offer.offerId} | ${pricePerHour} SKY/h`);
    return offer.offerId;
  }

  withdrawOffer(offerId, owner) {
    const offer = this.#getOffer(offerId);
    if (offer.owner !== owner) throw new MarketplaceError('Non autorisé', 'E_AUTH');
    offer.isActive = false;
    console.info(`[Marketplace] Offre retirée : ${offerId}`);
  }

  // ─── Location ─────────────────────────────────────────────────

  /**
   * Loue un nœud : valide l'offre, la réputation, puis crée la location
   * avec mise en escrow du montant total.
   *
   * @param {string}      offerId
   * @param {string}      renter             — identifiant du locataire
   * @param {number}      renterReputation   — score [0,1]
   * @param {number}      durationHours
   * @param {UserRewards} [rewards]          — instance de récompenses du propriétaire
   * @returns {ActiveRental}
   */
  async rentNode(offerId, renter, renterReputation, durationHours, rewards = null) {
    const offer = this.#getOffer(offerId);

    if (!offer.isActive) {
      throw new MarketplaceError('Offre inactive', 'E_UNAVAILABLE');
    }
    if (offer.availableHours < durationHours) {
      throw new MarketplaceError(
        `Durée insuffisante (disponible: ${offer.availableHours}h, demandé: ${durationHours}h)`,
        'E_DURATION'
      );
    }
    if (durationHours < MIN_DURATION_HOURS || durationHours > MAX_DURATION_HOURS) {
      throw new MarketplaceError(
        `Durée hors bornes (${MIN_DURATION_HOURS}–${MAX_DURATION_HOURS}h)`,
        'E_DURATION'
      );
    }
    if (renterReputation < offer.reputationRequired) {
      throw new MarketplaceError(
        `Réputation insuffisante (requis: ${offer.reputationRequired.toFixed(2)}, actuel: ${renterReputation.toFixed(2)})`,
        'E_REPUTATION'
      );
    }

    const totalPrice = offer.pricePerHour * durationHours;
    const rentalId   = `rental-${randomUUID()}`;

    const rental = new ActiveRental({
      rentalId, offerId,
      nodeId       : offer.nodeId,
      renter, owner: offer.owner,
      totalPrice, durationHours,
    });

    // Débit de la durée de l'offre + mise en escrow
    offer.availableHours   -= durationHours;
    offer.totalRentalsCount++;
    if (offer.availableHours === 0) offer.isActive = false;

    this.#rentals.set(rentalId, rental);
    this.#totalVolumeSky += totalPrice;

    // Récompense intermédiaire au propriétaire (part OWNER_SHARE à la création)
    if (rewards instanceof UserRewards) {
      rewards.totalSkyEarned += rental.ownerShare * 0.5;  // moitié à la réservation
    }

    console.info(
      `[Marketplace] Location créée : ${rentalId} | ${totalPrice} SKY | ${durationHours}h`
    );
    return rental;
  }

  // ─── Complétion ───────────────────────────────────────────────

  /**
   * Termine une location : libère l'escrow et crédite le propriétaire.
   * Peut être appelée manuellement ou automatiquement après expiration.
   *
   * @param {string}      rentalId
   * @param {UserRewards} [rewards]
   * @returns {{ ownerReward: number, platformFee: number }}
   */
  async completeRental(rentalId, rewards = null) {
    const rental = this.#getRental(rentalId);
    if (rental.status !== RentalStatus.Active) {
      throw new MarketplaceError(`Location déjà ${rental.status}`, 'E_STATUS');
    }

    rental.status      = RentalStatus.Completed;
    rental.completedAt = Date.now();

    // Libération escrow — solde restant (50 % déjà versé à la création)
    if (rewards instanceof UserRewards) {
      rewards.totalSkyEarned += rental.ownerShare * 0.5;
    }

    this.#totalFeesCollected += rental.platformFee;

    // Mise à jour revenu total de l'offre
    const offer = this.#offers.get(rental.offerId);
    if (offer) offer.totalRevenue += rental.ownerShare;

    this.#rentals.delete(rentalId);
    this.#history.push(rental);

    console.info(
      `[Marketplace] Location terminée : ${rentalId} | ` +
      `propriétaire: ${rental.ownerShare} SKY | plateforme: ${rental.platformFee} SKY`
    );

    return { ownerReward: rental.ownerShare, platformFee: rental.platformFee };
  }

  // ─── Annulation ───────────────────────────────────────────────

  /**
   * Annule une location active.
   * Si annulée avant 10 % du temps écoulé, remboursement intégral.
   * Sinon, le temps consommé est facturé au prorata.
   */
  cancelRental(rentalId, requestedBy) {
    const rental = this.#getRental(rentalId);
    if (rental.status !== RentalStatus.Active) {
      throw new MarketplaceError(`Location non annulable (${rental.status})`, 'E_STATUS');
    }
    if (requestedBy !== rental.renter && requestedBy !== rental.owner) {
      throw new MarketplaceError('Non autorisé à annuler cette location', 'E_AUTH');
    }

    const elapsed    = Date.now() - rental.startTime;
    const totalMs    = rental.durationHours * 3_600_000;
    const elapsedRatio = elapsed / totalMs;

    // Remboursement prorata
    const consumed     = Math.ceil(rental.totalPrice * elapsedRatio);
    const refund       = rental.totalPrice - consumed;

    rental.status      = RentalStatus.Cancelled;
    rental.completedAt = Date.now();

    // Restaurer les heures non consommées
    const offer = this.#offers.get(rental.offerId);
    if (offer) {
      const remainingHours = Math.floor((totalMs - elapsed) / 3_600_000);
      offer.availableHours += remainingHours;
      if (remainingHours > 0) offer.isActive = true;
    }

    this.#rentals.delete(rentalId);
    this.#history.push(rental);

    console.info(
      `[Marketplace] Location annulée : ${rentalId} | remboursement: ${refund} SKY`
    );
    return { refund, consumed };
  }

  // ─── Dispute ──────────────────────────────────────────────────

  openDispute(rentalId, claimant, reason) {
    const rental = this.#getRental(rentalId);
    if (rental.status !== RentalStatus.Active) {
      throw new MarketplaceError('Dispute impossible sur une location non active', 'E_STATUS');
    }
    if (claimant !== rental.renter && claimant !== rental.owner) {
      throw new MarketplaceError('Non autorisé', 'E_AUTH');
    }
    rental.status   = RentalStatus.Disputed;
    rental.dispute  = { claimant, reason, openedAt: Date.now() };
    console.warn(`[Marketplace] Dispute ouverte : ${rentalId} — ${reason}`);
  }

  // ─── Expiration automatique ───────────────────────────────────

  /**
   * À appeler périodiquement (ex. setInterval toutes les minutes).
   * Complète automatiquement les locations expirées.
   */
  async processExpiredRentals() {
    const expired = [...this.#rentals.values()].filter(r => r.isExpired());
    for (const r of expired) {
      await this.completeRental(r.rentalId).catch(e =>
        console.warn(`[Marketplace] Auto-complétion échouée pour ${r.rentalId}: ${e.message}`)
      );
    }
    return expired.length;
  }

  // ─── Requêtes ─────────────────────────────────────────────────

  getAvailableOffers(opts = {}) {
    const {
      minReputation = 0,
      maxPrice      = Infinity,
      minTflops     = 0,
      tags          = [],
      sortBy        = 'tflops',   // 'tflops' | 'price' | 'reputation'
    } = opts;

    let results = [...this.#offers.values()].filter(o =>
      o.isActive &&
      o.availableHours > 0 &&
      o.reputationRequired >= minReputation &&
      o.pricePerHour <= maxPrice &&
      o.tflops >= minTflops &&
      (tags.length === 0 || tags.some(t => o.tags.includes(t)))
    );

    if (sortBy === 'price')      results.sort((a, b) => a.pricePerHour - b.pricePerHour);
    else if (sortBy === 'reputation') results.sort((a, b) => b.reputationRequired - a.reputationRequired);
    else                         results.sort((a, b) => b.tflops - a.tflops);

    return results;
  }

  getActiveRentals()                { return [...this.#rentals.values()]; }
  getActiveRentalsForUser(userId)   { return [...this.#rentals.values()].filter(r => r.renter === userId); }
  getActiveRentalsForOwner(ownerId) { return [...this.#rentals.values()].filter(r => r.owner === ownerId); }
  getRentalHistory(limit = 100)     { return this.#history.slice(-limit); }

  /**
   * Prix moyen par type de nœud (Mini/Light/Full…).
   * Utilisé par le Price Chart de marketplace.html.
   */
  getAvgPriceByNodeType() {
    const NODE_TYPES  = ['Mini','Light','Full','Storage','Compute','Mixed','Sentinel','DreamWeaver','Validator'];
    const offers      = [...this.#offers.values()].filter(o => o.isActive);
    // Référence marché si pas d'offres
    const REF_PRICE   = { Mini:0, Light:0.8, Full:2.5, Storage:1.2,
                          Compute:3.5, Mixed:2.0, Sentinel:1.8,
                          DreamWeaver:4.5, Validator:6.0 };

    return NODE_TYPES.map(type => {
        const matching = offers.filter(o =>
            o.tags?.includes(type) ||
            o.description?.toLowerCase().includes(type.toLowerCase())
        );
        const avg = matching.length > 0
            ? matching.reduce((s, o) => s + o.pricePerHour, 0) / matching.length
            : REF_PRICE[type] ?? 0;

        return {
            type,
            avgPriceSky  : +avg.toFixed(2),
            refPriceSky  : REF_PRICE[type] ?? 0,
            offersCount  : matching.length,
            totalTflops  : matching.reduce((s, o) => s + (o.tflops ?? 0), 0),
            variation    : matching.length > 0
                ? +((avg - (REF_PRICE[type] ?? avg)) / Math.max(REF_PRICE[type] ?? avg, 0.01) * 100).toFixed(1)
                : 0,
        };
    });
  }

  /**
   * Données ticker navbar pour les nœuds.
   */
  getNodeTickerData() {
    const byType      = this.getAvgPriceByNodeType();
    const stats       = this.getMarketStats();
    return {
        tickerItems  : byType.slice(0,5).map(t => ({
            label    : t.type,
            price    : t.avgPriceSky,
            variation: t.variation,
            isUp     : t.variation >= 0,
        })),
        activeOffers : stats.activeOffers,
        totalVolume  : stats.totalVolumeSky,
    };
  }

  getOfferStats(offerId) {
    const offer = this.#getOffer(offerId);
    return {
      offerId         : offer.offerId,
      totalRentals    : offer.totalRentalsCount,
      totalRevenue    : offer.totalRevenue,
      availableHours  : offer.availableHours,
      isActive        : offer.isActive,
    };
  }

  getMarketStats() {
    const offers  = [...this.#offers.values()];
    const rentals = [...this.#rentals.values()];
    const active  = offers.filter(o => o.isActive && o.availableHours > 0);
    const avgPrice= active.length > 0
      ? active.reduce((s, o) => s + o.pricePerHour, 0) / active.length : 0;
    const totalTflops = active.reduce((s, o) => s + o.tflops, 0);

    return {
      totalVolumeSky    : this.#totalVolumeSky,
      totalFeesCollected: this.#totalFeesCollected,
      totalOffers       : offers.length,
      activeOffers      : active.length,
      activeRentals     : rentals.length,
      completedRentals  : this.#history.filter(r => r.status === RentalStatus.Completed).length,
      disputedRentals   : rentals.filter(r => r.status === RentalStatus.Disputed).length,
      availableTflops   : totalTflops,
      averagePricePerHour: +avgPrice.toFixed(2),
      platformFeeRate   : PLATFORM_FEE,
    };
  }

  get hybrid() { return this.#hybrid; }

  // ─── Privés ───────────────────────────────────────────────────

  #getOffer(offerId) {
    const offer = this.#offers.get(offerId);
    if (!offer) throw new MarketplaceError(`Offre '${offerId}' introuvable`, 'E_NOT_FOUND');
    return offer;
  }

  #getRental(rentalId) {
    const rental = this.#rentals.get(rentalId);
    if (!rental) throw new MarketplaceError(`Location '${rentalId}' introuvable`, 'E_NOT_FOUND');
    return rental;
  }

  // ── Handlers API (page Marketplace · compute) — migrés depuis skycloud.js ──
  //    Corrections de câblage : listOffers → getAvailableOffers, getMarketplaceStats → getMarketStats.
  apiHandlers() {
    return {
      'mp_publish_offer'      : (nodeId, owner, pricePerHour, hours, opts) =>
          this.publishOffer(nodeId, owner, pricePerHour, hours, 0, 0.50, opts ?? {}),
      'mp_withdraw_offer'     : (offerId, owner)  => this.withdrawOffer(offerId, owner),
      'mp_list_offers'        : (filters)         => this.getAvailableOffers(filters ?? {}),
      'mp_rent_node'          : (offerId, renter, reputation, hours) =>
          this.rentNode(offerId, renter, reputation, hours),
      'mp_complete_rental'    : (rentalId, owner)  => this.completeRental(rentalId, owner),
      'mp_cancel_rental'      : (rentalId, renter) => this.cancelRental(rentalId, renter),
      'mp_get_active_rentals' : (userId)  => this.getActiveRentalsForUser(userId),
      'mp_get_owner_rentals'  : (ownerId) => this.getActiveRentalsForOwner(ownerId),
      'mp_get_stats'          : ()        => this.getMarketStats() ?? {},
      'mp_get_history'        : ()        => (this.getRentalHistory ? this.getRentalHistory() : []),
    };
  }
}
