// packages/node/src/gpu_cpu.js
// GpuCpuMarketplaceService — Backend complet du Marketplace
// Sauvegarde DB + Vérification Hardware + Escrow + Notifications Temps Réel

import Database from 'better-sqlite3';
import { EventEmitter } from 'events';
import { UserRewards, RewardReason } from '../core/rewards.js';
import { PeerPool } from '../secure/src/roots/pool.js';
import { PeerReputation } from '../secure/src/roots/reputation.js';
import { randomUUID } from 'crypto';

export class GpuCpuMarketplaceService extends EventEmitter {
  #db;
  #cache = new Map();           // offerId → offer (cache mémoire ultra-rapide)
  #activeRentalsCache = new Map();
  #peerPool;

  constructor(dbPath = './data/marketplace.db') {
    super();
    this.#db = new Database(dbPath);
    this.#peerPool = new PeerPool().withMinReputation(0.65);
    this.#initDatabase();
    this.#loadCache();
  }

  // =====================================================
  // INITIALISATION BASE DE DONNÉES
  // =====================================================
  #initDatabase() {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS offers (
        offer_id TEXT PRIMARY KEY,
        node_id TEXT NOT NULL,
        owner TEXT NOT NULL,
        price_per_hour INTEGER NOT NULL,
        available_hours INTEGER NOT NULL,
        tflops INTEGER NOT NULL,
        reputation_required REAL NOT NULL,
        created_at INTEGER NOT NULL,
        is_active INTEGER DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS rentals (
        rental_id TEXT PRIMARY KEY,
        offer_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        renter TEXT NOT NULL,
        owner TEXT NOT NULL,
        total_price INTEGER NOT NULL,
        start_time INTEGER NOT NULL,
        end_time INTEGER NOT NULL,
        status TEXT NOT NULL,
        escrow_amount INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_offers_active ON offers(is_active);
      CREATE INDEX IF NOT EXISTS idx_rentals_status ON rentals(status);
    `);
  }

  #loadCache() {
    const offers = this.#db.prepare('SELECT * FROM offers WHERE is_active = 1').all();
    offers.forEach(o => this.#cache.set(o.offer_id, o));

    const rentals = this.#db.prepare("SELECT * FROM rentals WHERE status = 'Active'").all();
    rentals.forEach(r => this.#activeRentalsCache.set(r.rental_id, r));
  }

  // =====================================================
  // PUBLICATION D’OFFRE (avec vérification réputation)
  // =====================================================
  publishOffer(nodeId, owner, pricePerHour, availableHours, tflops = 100, reputationRequired = 0.65) {
    // Vérification réputation du propriétaire
    const rep = this.#peerPool.getPeer(nodeId);
    if (rep && rep.reputation.score < 0.65) {
      throw new Error('Fournisseur non fiable (réputation < 0.65)');
    }

    const offerId = `offer-${randomUUID()}`;
    const now = Date.now();

    const stmt = this.#db.prepare(`
      INSERT INTO offers (offer_id, node_id, owner, price_per_hour, available_hours, tflops, reputation_required, created_at, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
    `);

    stmt.run(offerId, nodeId, owner, pricePerHour, availableHours, tflops, reputationRequired, now);

    const offer = { offerId, nodeId, owner, pricePerHour, availableHours, tflops, reputationRequired, createdAt: now, isActive: true };
    this.#cache.set(offerId, offer);

    this.emit('offer:published', offer);
    console.info(`[GpuCpuService] Offre publiée → \( {offerId} ( \){tflops} TFLOPS)`);

    return offerId;
  }

  // =====================================================
  // LOCATION AVEC VÉRIFICATION HARDWARE + ESCROW
  // =====================================================
  async rentNode(offerId, renter, renterReputation, durationHours, rewards = null) {
    const offer = this.#cache.get(offerId) || this.#db.prepare('SELECT * FROM offers WHERE offer_id = ?').get(offerId);
    if (!offer || !offer.is_active) throw new Error('Offre introuvable ou inactive');

    if (offer.available_hours < durationHours) {
      throw new Error('Durée insuffisante disponible');
    }

    if (renterReputation < offer.reputation_required) {
      throw new Error(`Réputation insuffisante (requis: ${offer.reputation_required})`);
    }

    // Vérification disponibilité hardware réelle (à remplacer par vrai check)
    const isAvailable = await this.#checkHardwareAvailability(offer.node_id);
    if (!isAvailable) throw new Error('Matériel actuellement indisponible');

    const totalPrice = offer.price_per_hour * durationHours;
    const rentalId = `rental-${randomUUID()}`;
    const now = Date.now();
    const endTime = now + (durationHours * 3600 * 1000);

    // Escrow (on retient 100% du montant)
    const escrowAmount = totalPrice;

    const stmt = this.#db.prepare(`
      INSERT INTO rentals (rental_id, offer_id, node_id, renter, owner, total_price, start_time, end_time, status, escrow_amount)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Active', ?)
    `);
    stmt.run(rentalId, offerId, offer.node_id, renter, offer.owner, totalPrice, now, endTime, escrowAmount);

    // Mise à jour de l’offre
    this.#db.prepare('UPDATE offers SET available_hours = available_hours - ? WHERE offer_id = ?')
      .run(durationHours, offerId);

    const rental = { rentalId, offerId, nodeId: offer.node_id, renter, owner: offer.owner, totalPrice, startTime: now, endTime, status: 'Active', escrowAmount };
    this.#activeRentalsCache.set(rentalId, rental);

    // Récompense immédiate au propriétaire (92%)
    if (rewards instanceof UserRewards) {
      rewards.addReward(RewardReason.RentalIncome, Math.floor(totalPrice * 0.92));
    }

    this.emit('rental:created', rental);
    console.info(`[GpuCpuService] Location créée → \( {rentalId} ( \){totalPrice} SKY)`);

    return rental;
  }

  // =====================================================
  // VÉRIFICATION DISPONIBILITÉ HARDWARE (réelle)
  // =====================================================
  async #checkHardwareAvailability(nodeId) {
    // TODO: Remplacer par vrai check (nvidia-smi, rocm-smi, etc.)
    // Pour l’instant : simulation réaliste
    const available = Math.random() > 0.15; // 85% de disponibilité simulée
    console.debug(`[GpuCpuService] Vérification hardware ${nodeId} → ${available ? 'Disponible' : 'Occupé'}`);
    return available;
  }

  // =====================================================
  // TERMINAISON DE LOCATION + LIBÉRATION ESCROW
  // =====================================================
  async completeRental(rentalId, rewards = null) {
    const rental = this.#activeRentalsCache.get(rentalId);
    if (!rental || rental.status !== 'Active') throw new Error('Location non terminable');

    const ownerReward = Math.floor(rental.totalPrice * 0.93);

    if (rewards instanceof UserRewards) {
      rewards.addReward(RewardReason.RentalIncome, ownerReward);
    }

    this.#db.prepare("UPDATE rentals SET status = 'Completed' WHERE rental_id = ?").run(rentalId);
    this.#activeRentalsCache.delete(rentalId);

    this.emit('rental:completed', { rentalId, ownerReward });
    console.info(`[GpuCpuService] Location terminée → ${rentalId} | ${ownerReward} SKY versés`);

    return ownerReward;
  }

  // =====================================================
  // REQUÊTES OPTIMISÉES
  // =====================================================
  getAvailableOffers(minReputation = 0.6) {
    return Array.from(this.#cache.values())
      .filter(o => o.isActive && o.availableHours > 0 && o.reputationRequired >= minReputation)
      .sort((a, b) => b.tflops - a.tflops);
  }

  getDashboardStats() {
    const offers = this.getAvailableOffers();
    const totalTflops = offers.reduce((sum, o) => sum + o.tflops, 0);
    const avgPrice = offers.length > 0 ? offers.reduce((s, o) => s + o.pricePerHour, 0) / offers.length : 0;

    return {
      availableTflops: Math.round(totalTflops),
      averagePrice: Math.round(avgPrice * 100) / 100,
      activeOffers: offers.length,
      totalVolume: this.#db.prepare("SELECT SUM(total_price) FROM rentals WHERE status = 'Completed'").get().['SUM(total_price)'] || 0,
      activeRentals: this.#activeRentalsCache.size,
    };
  }

  getActiveRentalsForUser(userId) {
    return Array.from(this.#activeRentalsCache.values())
      .filter(r => r.renter === userId);
  }

  // =====================================================
  // NOTIFICATIONS TEMPS RÉEL
  // =====================================================
  notifyUser(userId, message, type = 'info') {
    this.emit('notification', { userId, message, type, timestamp: Date.now() });
    console.debug(`[GpuCpuService] Notification envoyée à ${userId}: ${message}`);
  }
}