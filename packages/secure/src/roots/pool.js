// packages/secure/src/roots/pool.js
// =====================================================
// PeerPool — Gestion Intelligente des Pairs
// Compatible Contact + DID + RomanT369 + GroupManager
// DiamantRoots v2 — Sélection par Réputation + Diversité
// SkyAInet × Nikola T369
// =====================================================

import { PeerReputation, ReputationTier } from './reputation.js';
import { Contact } from '../contacts/contact.js';
import { ContactManager } from '../contacts/manager.js';

export class PeerPoolError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PeerPoolError';
  }
}

export class PeerInfo {
  constructor(addr, contactId = null) {
    this.addr = addr;
    this.reputation = new PeerReputation();
    this.lastSeen = Date.now();
    this.connectionCount = 0;
    this.contactId = contactId; // Uint8Array(32) ou null
  }
}

export class PeerPool {
  constructor() {
    this.peers = new Map(); // nodeId (hex) → PeerInfo
    this.minReputationThreshold = 0.60;
  }

  withMinReputation(threshold) {
    this.minReputationThreshold = threshold;
    return this;
  }

  // === Gestion des pairs ===

  addPeer(nodeId, addr) {
    const idHex = this.#toHex(nodeId);
    this.peers.set(idHex, new PeerInfo(addr));
    console.debug(`[PeerPool] Pair ajouté : \( {idHex.slice(0, 16)} ( \){addr})`);
  }

  addPeerWithContact(nodeId, addr, contact = null) {
    const idHex = this.#toHex(nodeId);
    const contactId = contact ? contact.nodeId : null;

    const info = new PeerInfo(addr, contactId);
    this.peers.set(idHex, info);

    console.debug(`[PeerPool] Pair ajouté avec Contact : \( {idHex.slice(0, 16)} ( \){addr})`);
  }

  removePeer(nodeId) {
    const idHex = this.#toHex(nodeId);
    if (this.peers.delete(idHex)) {
      console.debug(`[PeerPool] Pair supprimé : ${idHex.slice(0, 16)}`);
      return true;
    }
    return false;
  }

  getPeer(nodeId) {
    const idHex = this.#toHex(nodeId);
    const info = this.peers.get(idHex);
    return info ? info.addr : null;
  }

  contains(nodeId) {
    return this.peers.has(this.#toHex(nodeId));
  }

  len() {
    return this.peers.size;
  }

  isEmpty() {
    return this.peers.size === 0;
  }

  // === Sélection intelligente ===

  getRandomPeers(count) {
    if (this.peers.size === 0) {
      throw new PeerPoolError(`Not enough peers available (requested: ${count}, available: 0)`);
    }

    const addrs = Array.from(this.peers.values()).map(p => p.addr);
    this.#shuffle(addrs);
    return addrs.slice(0, count);
  }

  getHighReputationPeers(count, minReputation = null, contactManager = null) {
    const threshold = minReputation ?? this.minReputationThreshold;

    const filtered = [];

    for (const info of this.peers.values()) {
      let ok = info.reputation.score >= threshold;

      if (contactManager && info.contactId) {
        const contact = contactManager.get(info.contactId);
        if (contact) {
          ok = ok && contact.hasDecentralizedIdentity();
        }
      }

      if (ok) filtered.push(info.addr);
    }

    if (filtered.length < count) {
      throw new PeerPoolError(`Not enough peers available (requested: ${count}, available: ${filtered.length})`);
    }

    this.#shuffle(filtered);
    return filtered.slice(0, count);
  }

  getDiversePeers(count) {
    return this.getHighReputationPeers(count);
  }

  getTrustedPeers(count, contactManager) {
    const filtered = [];

    for (const info of this.peers.values()) {
      if (info.contactId) {
        const contact = contactManager.get(info.contactId);
        if (contact && contact.hasDecentralizedIdentity() && contact.verificationLevel >= 2) {
          filtered.push(info.addr);
        }
      }
    }

    if (filtered.length < count) {
      throw new PeerPoolError(`Not enough peers available (requested: ${count}, available: ${filtered.length})`);
    }

    this.#shuffle(filtered);
    return filtered.slice(0, count);
  }

  // === Mise à jour ===

  updateReputation(nodeId, newScore) {
    const idHex = this.#toHex(nodeId);
    const info = this.peers.get(idHex);
    if (!info) throw new PeerPoolError('Peer not found');

    info.reputation.score = Math.max(0, Math.min(1, newScore));
    console.debug(`[PeerPool] Réputation mise à jour pour ${idHex.slice(0, 16)} : ${newScore.toFixed(2)}`);
  }

  getPeersByReputation() {
    return Array.from(this.peers.values())
      .map(info => [info.addr, info.reputation.score])
      .sort((a, b) => b[1] - a[1]);
  }

  incrementConnection(nodeId) {
    const idHex = this.#toHex(nodeId);
    const info = this.peers.get(idHex);
    if (!info) throw new PeerPoolError('Peer not found');

    info.connectionCount++;
    info.lastSeen = Date.now();
  }

  // === Helpers ===

  #toHex(nodeId) {
    if (typeof nodeId === 'string') return nodeId;
    return Array.from(nodeId).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  #shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
  }
}