// packages/node/src/marketplace.js
// ComputeMarketplace — Marché de Puissance de Calcul Décentralisé (Version Complète)
// Intégré avec PeerPool + PeerReputation + Rewards + Gestion UI complète

import { HybridTransport } from '../../secure/src/crypto/hybrid.js';
import { UserRewards, RewardReason } from '../../core/src/rewards.js';
import { PeerPool } from '../../secure/src/roots/pool.js';
import { PeerReputation } from '../../secure/src/roots/reputation.js';
import { randomUUID } from 'crypto';

export const RentalStatus = Object.freeze({
  Active: 'Active',
  Completed: 'Completed',
  Cancelled: 'Cancelled',
  Disputed: 'Disputed',
});

export class RentalOffer {
  constructor(nodeId, owner, pricePerHour, availableHours, tflops = 100, reputationRequired = 0.6) {
    this.offerId = `offer-${randomUUID()}`;
    this.nodeId = nodeId;
    this.owner = owner;
    this.pricePerHour = pricePerHour;
    this.availableHours = availableHours;
    this.tflops = tflops;
    this.minDurationHours = 2;
    this.reputationRequired = Math.max(0.4, Math.min(0.95, reputationRequired));
    this.createdAt = new Date();
    this.isActive = true;
  }
}

export class ActiveRental {
  constructor(rentalId, nodeId, renter, owner, totalPrice, durationHours) {
    this.rentalId = rentalId;
    this.nodeId = nodeId;
    this.renter = renter;
    this.owner = owner;
    this.startTime = new Date();
    this.endTime = new Date(Date.now() + durationHours * 3600 * 1000);
    this.totalPrice = totalPrice;
    this.status = RentalStatus.Active;
    this.remainingHours = durationHours;
  }
}

export class ComputeMarketplace {
  #offers = new Map();
  #activeRentals = new Map();
  #totalVolumeSky = 0;
  #hybrid;
  #peerPool;

  constructor() {
    this.#hybrid = new HybridTransport(true);
    this.#peerPool = new PeerPool().withMinReputation(0.65);
  }

  // =====================================================
  // PUBLICATION D'OFFRE (avec validation réputation)
  // =====================================================
  publishOfferWithPeerValidation(nodeId, owner, pricePerHour, availableHours, tflops = 100, reputationRequired = 0.6) {
    // Vérification réputation du fournisseur
    const providerRep = this.#peerPool.getPeer(nodeId);
    if (providerRep && providerRep.reputation.score < 0.65) {
      throw new Error('Fournisseur non fiable (réputation trop basse)');
    }

    const offer = new RentalOffer(nodeId, owner, pricePerHour, availableHours, tflops, reputationRequired);
    this.#offers.set(offer.offerId, offer);

    console.info(`[Marketplace] Offre publiée → \( {offer.offerId} ( \){tflops} TFLOPS)`);
    return offer.offerId;
  }

  // =====================================================
  // LOCATION (avec validation réputation)
  // =====================================================
  async rentNodeWithPeerValidation(offerId, renter, renterReputation, durationHours, rewards = null) {
    const offer = this.#offers.get(offerId);
    if (!offer) throw new Error('Offre introuvable');
    if (!offer.isActive || offer.availableHours < durationHours) {
      throw new Error('Offre non disponible ou durée insuffisante');
    }

    // Vérification réputation du locataire
    if (renterReputation < offer.reputationRequired) {
      throw new Error(`Réputation insuffisante (requis: ${offer.reputationRequired}, actuel: ${renterReputation})`);
    }

    const totalPrice = offer.pricePerHour * durationHours;
    const rentalId = `rental-${randomUUID()}`;

    const rental = new ActiveRental(rentalId, offer.nodeId, renter, offer.owner, totalPrice, durationHours);
    this.#activeRentals.set(rentalId, rental);

    offer.availableHours -= durationHours;
    this.#totalVolumeSky += totalPrice;

    if (rewards instanceof UserRewards) {
      const ownerReward = Math.floor(totalPrice * 0.92);
      rewards.addReward(RewardReason.RentalIncome, ownerReward);
    }

    console.info(`[Marketplace] Location confirmée : ${totalPrice} SKY pour ${durationHours}h`);
    return rental;
  }

  // =====================================================
  // GESTION DES LOCATIONS (UI)
  // =====================================================
  async completeRental(rentalId, rewards = null) {
    const rental = this.#activeRentals.get(rentalId);
    if (!rental) throw new Error('Location introuvable');
    if (rental.status !== RentalStatus.Active) throw new Error('Location déjà terminée');

    rental.status = RentalStatus.Completed;
    const ownerReward = Math.floor(rental.totalPrice * 0.93);

    if (rewards instanceof UserRewards) {
      rewards.addReward(RewardReason.RentalIncome, ownerReward);
    }

    console.info(`[Marketplace] Location terminée → ${ownerReward} SKY payés`);
    return ownerReward;
  }

  cancelRental(rentalId) {
    const rental = this.#activeRentals.get(rentalId);
    if (!rental || rental.status !== RentalStatus.Active) {
      throw new Error('Location non annulable');
    }
    rental.status = RentalStatus.Cancelled;
    console.info(`[Marketplace] Location annulée : ${rentalId}`);
  }

  getActiveRentalsForUser(userId) {
    return Array.from(this.#activeRentals.values())
      .filter(r => r.renter === userId && r.status === RentalStatus.Active);
  }

  // =====================================================
  // GESTION DES OFFRES (UI)
  // =====================================================
  getPublishedOffersForUser(ownerId) {
    return Array.from(this.#offers.values())
      .filter(o => o.owner === ownerId && o.isActive);
  }

  updateOfferPrice(offerId, newPrice) {
    const offer = this.#offers.get(offerId);
    if (!offer) throw new Error('Offre introuvable');
    offer.pricePerHour = newPrice;
    console.info(`[Marketplace] Prix mis à jour → ${offerId}`);
  }

  removeOffer(offerId) {
    if (this.#offers.delete(offerId)) {
      console.info(`[Marketplace] Offre supprimée → ${offerId}`);
      return true;
    }
    return false;
  }

  // =====================================================
  // DASHBOARD & STATISTIQUES (pour marketplace.html)
  // =====================================================
  getDashboardStats() {
    const activeOffers = this.getAvailableOffers();
    const totalTflops = activeOffers.reduce((sum, o) => sum + o.tflops, 0);
    const avgPrice = activeOffers.length > 0
      ? activeOffers.reduce((sum, o) => sum + o.pricePerHour, 0) / activeOffers.length
      : 0;

    return {
      availableTflops: Math.round(totalTflops),
      averagePricePerHour: Math.round(avgPrice * 100) / 100,
      activeOffers: activeOffers.length,
      totalVolume24h: this.#totalVolumeSky,
      totalRentals: this.#activeRentals.size,
    };
  }

  getFilteredOffers(minReputation = 0.6) {
    return Array.from(this.#offers.values())
      .filter(o => o.isActive && o.availableHours > 0 && o.reputationRequired >= minReputation)
      .sort((a, b) => b.tflops - a.tflops);
  }

  getAvailableOffers() {
    return Array.from(this.#offers.values())
      .filter(o => o.isActive && o.availableHours > 0);
  }

  getActiveRentals() {
    return Array.from(this.#activeRentals.values())
      .filter(r => r.status === RentalStatus.Active);
  }

  getMarketStats() {
    return {
      totalVolume: this.#totalVolumeSky,
      totalOffers: this.#offers.size,
      activeRentals: this.#activeRentals.size,
    };
  }

  // =====================================================
  // GETTERS
  // =====================================================
  get hybrid() { return this.#hybrid; }
  get peerPool() { return this.#peerPool; }
}