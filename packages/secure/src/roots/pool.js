// packages/secure/src/roots/pool.js
// =====================================================
// PeerPool — Gestion Intelligente des Pairs
// Sélection par réputation + diversité + DID (via Contact)
// SkyAInet × Nikola T369
// =====================================================

"use strict";

import { randomBytes } from 'crypto';

// ─────────────────────────────────────────────────────────────────
// ERREUR TYPÉE
// ─────────────────────────────────────────────────────────────────

export class PeerPoolError extends Error {
  constructor(message, code = 'POOL_ERROR') {
    super(message);
    this.name = 'PeerPoolError';
    this.code = code;
  }
}

// ─────────────────────────────────────────────────────────────────
// RÉPUTATION — modèle EMA (exponential moving average)
//
// α = 0.15 : les événements récents pèsent plus,
// la réhabilitation est progressive sans reset brutal.
// ─────────────────────────────────────────────────────────────────

const REPUTATION_ALPHA = 0.15;
const REPUTATION_INIT  = 0.70;
const REPUTATION_MIN   = 0.01;
const REPUTATION_MAX   = 1.00;

export class PeerReputation {
  #score;
  #events;    // ring buffer 32 entrées { ts, delta }

  constructor(initialScore = REPUTATION_INIT) {
    this.#score  = Math.max(REPUTATION_MIN, Math.min(REPUTATION_MAX, initialScore));
    this.#events = [];
  }

  get score() { return this.#score; }

  /** @param {number} delta — [-1, 1] : négatif = pénalité, positif = récompense */
  update(delta) {
    const bounded = Math.max(-1, Math.min(1, delta));
    const target  = Math.max(REPUTATION_MIN, Math.min(REPUTATION_MAX, this.#score + bounded * 0.3));
    this.#score   = this.#score * (1 - REPUTATION_ALPHA) + target * REPUTATION_ALPHA;
    this.#score   = Math.max(REPUTATION_MIN, Math.min(REPUTATION_MAX, this.#score));
    this.#events.push({ ts: Date.now(), delta: bounded });
    if (this.#events.length > 32) this.#events.shift();
  }

  /** Décroissance temporelle — appeler périodiquement (ex. toutes les heures) */
  decay(factor = 0.998) {
    this.#score = Math.max(REPUTATION_MIN, this.#score * factor);
  }

  toJSON() {
    return { score: +this.#score.toFixed(4), events: this.#events.length };
  }
}

// ─────────────────────────────────────────────────────────────────
// TIERS DE RÉPUTATION
// ─────────────────────────────────────────────────────────────────

export const ReputationTier = Object.freeze({
  UNTRUSTED : 0,    // < 0.40
  LOW       : 1,    // 0.40 – 0.59
  MEDIUM    : 2,    // 0.60 – 0.79
  HIGH      : 3,    // 0.80 – 0.89
  ELITE     : 4,    // ≥ 0.90

  fromScore(s) {
    if (s >= 0.90) return ReputationTier.ELITE;
    if (s >= 0.80) return ReputationTier.HIGH;
    if (s >= 0.60) return ReputationTier.MEDIUM;
    if (s >= 0.40) return ReputationTier.LOW;
    return ReputationTier.UNTRUSTED;
  },
});

// ─────────────────────────────────────────────────────────────────
// PEER INFO
// ─────────────────────────────────────────────────────────────────

export class PeerInfo {
  constructor(addr, contactId = null) {
    this.addr            = addr;
    this.reputation      = new PeerReputation();
    this.lastSeen        = Date.now();
    this.connectionCount = 0;
    this.contactId       = contactId;   // Uint8Array(32) | null
    this.failureCount    = 0;
    this.addedAt         = Date.now();
  }

  isAlive(timeoutMs = 30_000) {
    return Date.now() - this.lastSeen < timeoutMs;
  }

  touch() { this.lastSeen = Date.now(); }
}

// ─────────────────────────────────────────────────────────────────
// PEER POOL
//
// Gère uniquement les pairs réseau et leur réputation.
// La gestion des contacts (identité, DID, UI) est dans contacts/.
//
// Les méthodes acceptant un contactManager en paramètre utilisent
// duck typing : l'objet doit exposer get(nodeId) et
// contact.hasDecentralizedIdentity() — découplage complet,
// pas d'import de Contact ou ContactManager ici.
// ─────────────────────────────────────────────────────────────────

export class PeerPool {
  #peers;          // Map<hex, PeerInfo>
  #minReputation;

  constructor(opts = {}) {
    this.#peers         = new Map();
    this.#minReputation = opts.minReputation ?? 0.60;
  }

  // ─── Fluent builder ───────────────────────────────────────────

  withMinReputation(threshold) {
    this.#minReputation = Math.max(0, Math.min(1, threshold));
    return this;
  }

  // ─── Gestion des pairs ────────────────────────────────────────

  addPeer(nodeId, addr) {
    const hex = this.#toHex(nodeId);
    if (!this.#peers.has(hex)) this.#peers.set(hex, new PeerInfo(addr));
    return this;
  }

  /**
   * Ajoute un pair avec un Contact associé.
   * Le contactId est stocké pour le filtrage DID ultérieur.
   * contact peut être null ou toute instance avec une propriété nodeId.
   */
  addPeerWithContact(nodeId, addr, contact = null) {
    const hex       = this.#toHex(nodeId);
    const contactId = contact?.nodeId ?? null;
    if (!this.#peers.has(hex)) this.#peers.set(hex, new PeerInfo(addr, contactId));
    return this;
  }

  removePeer(nodeId) { return this.#peers.delete(this.#toHex(nodeId)); }
  getPeer(nodeId)    { return this.#peers.get(this.#toHex(nodeId)) ?? null; }
  contains(nodeId)   { return this.#peers.has(this.#toHex(nodeId)); }
  len()              { return this.#peers.size; }
  isEmpty()          { return this.#peers.size === 0; }

  // ─── Sélection ────────────────────────────────────────────────

  /** Sélection aléatoire parmi tous les pairs vivants (broadcast, découverte). */
  getRandomPeers(count) {
    const alive = this.#alivePeers();
    if (alive.length === 0) throw new PeerPoolError('No peers available', 'E_EMPTY');
    return this.#shuffleSample(alive.map(([, i]) => i.addr), count);
  }

  /**
   * Pairs dont la réputation ≥ seuil.
   * Si contactManager fourni, filtre aussi sur DID vérifié.
   * Tri : ELITE → HIGH → MEDIUM, shuffle dans chaque tier.
   */
  getHighReputationPeers(count, minReputation = null, contactManager = null) {
    const threshold  = minReputation ?? this.#minReputation;
    const candidates = [];

    for (const [, info] of this.#peers) {
      if (!info.isAlive() || info.reputation.score < threshold) continue;
      if (contactManager && info.contactId) {
        const contact = contactManager.get(info.contactId);
        if (contact && !contact.hasDecentralizedIdentity()) continue;
      }
      candidates.push(info);
    }

    if (candidates.length < count) {
      throw new PeerPoolError(
        `Not enough peers (requested: ${count}, available: ${candidates.length})`,
        'E_INSUFFICIENT'
      );
    }

    candidates.sort((a, b) =>
      ReputationTier.fromScore(b.reputation.score) - ReputationTier.fromScore(a.reputation.score)
    );
    return candidates.slice(0, count).map(i => i.addr);
  }

  /**
   * Sélection diverse : round-robin par tier de réputation.
   * Résiste aux attaques Sybil concentrées sur un seul tier.
   */
  getDiversePeers(count) {
    const alive = this.#alivePeers().map(([, i]) => i);
    if (alive.length < count) {
      throw new PeerPoolError(
        `Not enough peers (requested: ${count}, available: ${alive.length})`,
        'E_INSUFFICIENT'
      );
    }

    const buckets = new Map();
    for (const info of alive) {
      const tier = ReputationTier.fromScore(info.reputation.score);
      if (!buckets.has(tier)) buckets.set(tier, []);
      buckets.get(tier).push(info);
    }

    const tiers  = [...buckets.keys()].sort((a, b) => b - a);
    const result = [];
    while (result.length < count) {
      let added = false;
      for (const tier of tiers) {
        if (result.length >= count) break;
        const bucket = buckets.get(tier);
        if (!bucket?.length) continue;
        const idx = Math.floor(Math.random() * bucket.length);
        result.push(bucket.splice(idx, 1)[0].addr);
        added = true;
      }
      if (!added) break;
    }
    return result;
  }

  /**
   * Pairs avec DID complet (verificationLevel ≥ 2) et réputation ≥ seuil.
   * Réservé aux paiements et données sensibles.
   */
  getTrustedPeers(count, contactManager) {
    if (!contactManager) {
      throw new PeerPoolError('ContactManager requis pour getTrustedPeers', 'E_CONTACT');
    }

    const candidates = [];
    for (const [, info] of this.#peers) {
      if (!info.isAlive() || info.reputation.score < this.#minReputation) continue;
      if (!info.contactId) continue;
      const contact = contactManager.get(info.contactId);
      if (contact?.hasDecentralizedIdentity() && contact.verificationLevel >= 2) {
        candidates.push(info);
      }
    }

    if (candidates.length < count) {
      throw new PeerPoolError(
        `Not enough trusted peers (requested: ${count}, available: ${candidates.length})`,
        'E_INSUFFICIENT'
      );
    }

    candidates.sort((a, b) => b.reputation.score - a.reputation.score);
    return this.#shuffleSample(candidates.map(i => i.addr), count);
  }

  // ─── Mise à jour ──────────────────────────────────────────────

  /** delta ∈ [-1, 1] : +0.2 = succès, -0.3 = timeout, -0.8 = malveillant */
  updateReputation(nodeId, delta) {
    this.#getOrThrow(nodeId).reputation.update(delta);
    return this;
  }

  incrementConnection(nodeId) {
    const info = this.#getOrThrow(nodeId);
    info.connectionCount++;
    info.touch();
    return this;
  }

  recordFailure(nodeId) {
    const info = this.#getOrThrow(nodeId);
    info.failureCount++;
    info.reputation.update(-0.2 - Math.min(info.failureCount * 0.05, 0.3));
    return this;
  }

  decayAll(factor = 0.998) {
    for (const [, info] of this.#peers) info.reputation.decay(factor);
    return this;
  }

  // ─── Lecture ─────────────────────────────────────────────────

  getPeersByReputation() {
    return [...this.#peers.values()]
      .map(i => ({
        addr : i.addr,
        score: i.reputation.score,
        tier : ReputationTier.fromScore(i.reputation.score),
      }))
      .sort((a, b) => b.score - a.score);
  }

  stats() {
    const peers      = [...this.#peers.values()];
    const alive      = peers.filter(p => p.isAlive()).length;
    const avgScore   = peers.length > 0
      ? peers.reduce((s, p) => s + p.reputation.score, 0) / peers.length : 0;
    const tierCounts = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 };
    for (const p of peers) tierCounts[ReputationTier.fromScore(p.reputation.score)]++;
    return {
      total        : peers.length,
      alive,
      avgScore     : +avgScore.toFixed(4),
      tierCounts,
      minReputation: this.#minReputation,
    };
  }

  // ─── Privés ───────────────────────────────────────────────────

  #toHex(nodeId) {
    if (typeof nodeId === 'string') return nodeId.toLowerCase();
    return Array.from(nodeId).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  #getOrThrow(nodeId) {
    const info = this.#peers.get(this.#toHex(nodeId));
    if (!info) throw new PeerPoolError('Peer not found', 'E_NOT_FOUND');
    return info;
  }

  #alivePeers() {
    return [...this.#peers.entries()].filter(([, i]) => i.isAlive());
  }

  /** Fisher-Yates tronqué — O(k) au lieu de O(n log n). */
  #shuffleSample(arr, count) {
    const a = [...arr];
    const n = Math.min(count, a.length);
    for (let i = a.length - 1; i > a.length - 1 - n; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a.slice(a.length - n);
  }
}
