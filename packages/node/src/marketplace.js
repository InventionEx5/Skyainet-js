// packages/node/src/marketplace.js
// ComputeMarketplace — Marché de Puissance de Calcul Décentralisé
// Location sécurisée + Réputation + Paiements intelligents + Rewards

import { HybridTransport } from '../../secure/src/crypto/hybrid.js';
import { UserRewards, RewardReason } from '../../core/src/rewards.js';
import { randomUUID } from 'crypto';

export const RentalStatus = Object.freeze({
  Active: 'Active',
  Completed: 'Completed',
  Cancelled: 'Cancelled',
  Disputed: 'Disputed',
});

export class RentalOffer {
  constructor(nodeId, owner, pricePerHour, availableHours, reputationRequired = 0.6) {
    this.offerId = `offer-${randomUUID()}`;
    this.nodeId = nodeId;
    this.owner = owner;
    this.pricePerHour = pricePerHour;
    this.availableHours = availableHours;
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
  }
}

export class ComputeMarketplace {
  #offers = new Map();
  #activeRentals = new Map();
  #totalVolumeSky = 0;
  #hybrid;

  constructor() {
    this.#hybrid = new HybridTransport(true);
  }

  // =====================================================
  // PUBLICATION D'OFFRE
  // =====================================================
  publishOffer(nodeId, owner, pricePerHour, availableHours, reputationRequired = 0.6) {
    const offer = new RentalOffer(nodeId, owner, pricePerHour, availableHours, reputationRequired);
    this.#offers.set(offer.offerId, offer);
    console.info(`[Marketplace] Nouvelle offre publiée → ${offer.offerId}`);
    return offer.offerId;
  }

  // =====================================================
  // LOCATION D'UN NŒUD
  // =====================================================
  async rentNode(offerId, renter, renterReputation, durationHours, rewards = null) {
    const offer = this.#offers.get(offerId);
    if (!offer) throw new Error('Offre introuvable');
    if (!offer.isActive || offer.availableHours < durationHours) {
      throw new Error('Offre non disponible ou durée insuffisante');
    }
    if (renterReputation < offer.reputationRequired) {
      throw new Error(`Réputation insuffisante (requis: ${offer.reputationRequired}, actuel: ${renterReputation})`);
    }

    const totalPrice = offer.pricePerHour * durationHours;
    const rentalId = `rental-${randomUUID()}`;

    const rental = new ActiveRental(rentalId, offer.nodeId, renter, offer.owner, totalPrice, durationHours);
    this.#activeRentals.set(rentalId, rental);

    offer.availableHours -= durationHours;
    this.#totalVolumeSky += totalPrice;

    // Récompense au propriétaire (92%)
    if (rewards instanceof UserRewards) {
      const ownerReward = Math.floor(totalPrice * 0.92);
      rewards.addReward(RewardReason.RentalIncome, ownerReward);
    }

    console.info(`[Marketplace] Location confirmée : ${totalPrice} SKY pour ${durationHours}h`);
    return rental;
  }

  // =====================================================
  // TERMINAISON DE LOCATION
  // =====================================================
  async completeRental(rentalId, rewards = null) {
    const rental = this.#activeRentals.get(rentalId);
    if (!rental) throw new Error('Location introuvable');
    if (rental.status !== RentalStatus.Active) {
      throw new Error('Location déjà terminée');
    }

    rental.status = RentalStatus.Completed;

    // Paiement au propriétaire (93%)
    const ownerReward = Math.floor(rental.totalPrice * 0.93);

    if (rewards instanceof UserRewards) {
      rewards.addReward(RewardReason.RentalIncome, ownerReward);
    }

    console.info(`[Marketplace] Location terminée → ${ownerReward} SKY payés au propriétaire`);
    return ownerReward;
  }

  // =====================================================
  // REQUÊTES
  // =====================================================
  getAvailableOffers() {
    return Array.from(this.#offers.values())
      .filter(o => o.isActive && o.availableHours > 0);
  }

  getActiveRentals() {
    return Array.from(this.#activeRentals.values());
  }

  getMarketStats() {
    return {
      totalVolume: this.#totalVolumeSky,
      totalOffers: this.#offers.size,
      activeRentals: this.#activeRentals.size,
    };
  }

  // Getters utiles
  get hybrid() { return this.#hybrid; }
}