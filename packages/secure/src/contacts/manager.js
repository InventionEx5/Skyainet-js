// packages/secure/src/contacts/manager.js
// =====================================================
// ContactManager v6.3 — Version Finale (Best of Both + DID Bonus)
// SkyAInet × Nikola T369
// =====================================================

import { Contact } from './contact.js';
import { ContactVerification } from './verification.js';

// =====================================================
// DID ( Decentralized Identity ) — Version minimale
// =====================================================
export class Did {
  constructor(publicKey) {
    this.publicKey = new Uint8Array(publicKey);
    const hex = Array.from(this.publicKey)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
    this.id = `did:skyainet:${hex.slice(0, 16)}`;
  }

  toShortString() {
    return this.id;
  }
}

// =====================================================
// ERREURS
// =====================================================
export class ContactManagerError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ContactManagerError';
  }
}

// =====================================================
// CONTACT MANAGER
// =====================================================
export class ContactManager {
  constructor() {
    this.contacts = new Map();           // nodeIdHex → Contact
    this.favorites = [];                 // nodeIdHex[]
    this.verification = ContactVerification;
    this.maxContacts = 500;
  }

  withMaxContacts(max) {
    this.maxContacts = max;
    return this;
  }

  // ==================== HELPERS ====================

  #toHex(arr) {
    if (typeof arr === 'string') return arr;
    return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  #getContact(nodeId) {
    const hex = this.#toHex(nodeId);
    return this.contacts.get(hex);
  }

  #setContact(nodeId, contact) {
    const hex = this.#toHex(nodeId);
    this.contacts.set(hex, contact);
  }

  // ==================== MÉTHODES DE BASE ====================

  addOrUpdate(contact) {
    const hex = this.#toHex(contact.nodeId);

    if (this.contacts.size >= this.maxContacts && !this.contacts.has(hex)) {
      throw new ContactManagerError('Maximum number of contacts reached');
    }

    const isNew = !this.contacts.has(hex);
    this.#setContact(contact.nodeId, contact);

    if (isNew) {
      console.info(`[ContactManager] Nouveau contact ajouté : ${contact.name} (total: ${this.contacts.size})`);
    } else {
      console.debug(`[ContactManager] Contact mis à jour : ${contact.name}`);
    }
  }

  get(nodeId) {
    return this.#getContact(nodeId) || null;
  }

  getContactMut(nodeId) {
    return this.#getContact(nodeId) || null;
  }

  remove(nodeId) {
    const hex = this.#toHex(nodeId);
    if (this.contacts.delete(hex)) {
      this.favorites = this.favorites.filter(id => id !== hex);
      console.debug('[ContactManager] Contact supprimé');
      return;
    }
    throw new ContactManagerError('Contact not found');
  }

  // ==================== DID + BONUS RÉPUTATION ====================

  linkDidToContact(nodeId, did) {
    const contact = this.#getContact(nodeId);
    if (!contact) throw new ContactManagerError('Contact not found');
    if (contact.revoked) throw new ContactManagerError('Contact is revoked');

    contact.setDid(did);

    if (contact.hasDecentralizedIdentity() && contact.verificationLevel >= 2) {
      contact.updateReputation(12);
      console.debug(`[ContactManager] +12 points de réputation accordés à ${contact.name} (DID vérifié)`);
    }

    console.debug(`[ContactManager] DID lié au contact ${contact.name}`);
  }

  createAndLinkDid(nodeId, publicKey) {
    const did = new Did(publicKey);
    this.linkDidToContact(nodeId, did);
    return did.toShortString();
  }

  applyDidReputationBonus(nodeId) {
    const contact = this.#getContact(nodeId);
    if (!contact) throw new ContactManagerError('Contact not found');

    if (!contact.hasDecentralizedIdentity() || contact.verificationLevel < 2) {
      throw new ContactManagerError('Invalid DID');
    }

    contact.updateReputation(12);
    console.debug(`[ContactManager] +12 points de réputation accordés manuellement à ${contact.name} (DID vérifié)`);
  }

  getContactsWithDid() {
    return Array.from(this.contacts.values()).filter(c => c.hasDecentralizedIdentity());
  }

  canJoinGroup(nodeId) {
    const contact = this.#getContact(nodeId);
    return contact
      ? (contact.hasDecentralizedIdentity() && contact.verificationLevel >= 2 && !contact.revoked)
      : false;
  }

  // ==================== RÉPUTATION & INTERACTIONS ====================

  updateReputation(nodeId, delta) {
    const contact = this.#getContact(nodeId);
    if (!contact) throw new ContactManagerError('Contact not found');
    contact.updateReputation(delta);
  }

  touchContact(nodeId) {
    const contact = this.#getContact(nodeId);
    if (!contact) throw new ContactManagerError('Contact not found');
    contact.touch();
  }

  revokeContact(nodeId, reason = null) {
    const contact = this.#getContact(nodeId);
    if (!contact) throw new ContactManagerError('Contact not found');
    contact.revoke(reason);
    console.warn(`[ContactManager] Contact révoqué : ${contact.name}`);
  }

  // ==================== FAVORIS ====================

  toggleFavorite(nodeId) {
    const hex = this.#toHex(nodeId);
    if (!this.contacts.has(hex)) {
      throw new ContactManagerError('Contact not found');
    }
    if (this.favorites.includes(hex)) {
      this.favorites = this.favorites.filter(id => id !== hex);
    } else {
      this.favorites.push(hex);
    }
  }

  getFavorites() {
    return this.favorites
      .map(hex => this.contacts.get(hex))
      .filter(Boolean);
  }

  // ==================== RECHERCHE & TRI ====================

  getSortedByReputation() {
    return Array.from(this.contacts.values())
      .sort((a, b) => (b.reputationScore || 0) - (a.reputationScore || 0));
  }

  getSortedByLastInteraction() {
    return Array.from(this.contacts.values())
      .sort((a, b) => {
        const la = a.lastInteraction ? a.lastInteraction.getTime() : 0;
        const lb = b.lastInteraction ? b.lastInteraction.getTime() : 0;
        return lb - la;
      });
  }

  searchByName(query) {
    const q = query.toLowerCase();
    return Array.from(this.contacts.values())
      .filter(c => c.name.toLowerCase().includes(q));
  }

  getRecommendedContacts(limit = 10) {
    return Array.from(this.contacts.values())
      .sort((a, b) => {
        const scoreA = (a.reputationScore || 0) + (a.lastInteraction ? 15 : 0);
        const scoreB = (b.reputationScore || 0) + (b.lastInteraction ? 15 : 0);
        return scoreB - scoreA;
      })
      .slice(0, limit);
  }

  getActiveContacts() {
    return Array.from(this.contacts.values()).filter(c => !c.revoked);
  }

  // ==================== AUTO-ORGANISATION ====================

  decayReputations() {
    const now = new Date();
    let decayed = 0;

    for (const contact of this.contacts.values()) {
      if (contact.lastInteraction) {
        const days = Math.floor((now - contact.lastInteraction) / (1000 * 60 * 60 * 24));
        if (days > 30) {
          const decay = Math.min(Math.floor(days * 0.8), 25);
          contact.reputationScore = Math.max((contact.reputationScore || 0) - decay, 0);
          decayed++;
        }
      }
    }

    if (decayed > 0) {
      console.debug(`[ContactManager] Réputation dégradée pour ${decayed} contacts`);
    }
  }

  cleanupInactive(maxInactiveDays) {
    const before = this.contacts.size;
    for (const [hex, contact] of this.contacts) {
      if (contact.revoked) {
        this.contacts.delete(hex);
        continue;
      }
      if (contact.daysSinceLastInteraction) {
        const days = contact.daysSinceLastInteraction();
        if (days > maxInactiveDays) {
          this.contacts.delete(hex);
        }
      }
    }
    return before - this.contacts.size;
  }

  autoOrganize() {
    this.decayReputations();

    const before = this.contacts.size;
    for (const [hex, contact] of this.contacts) {
      const score = contact.reputationScore || 0;
      if (score <= 8 && contact.verificationLevel < 2 && (contact.interactionCount || 0) <= 5) {
        this.contacts.delete(hex);
      }
    }

    const removed = before - this.contacts.size;
    if (removed > 0) {
      console.warn(`[ContactManager] ${removed} contacts de faible qualité nettoyés`);
    }
    console.info(`[ContactManager] Auto-organisation terminée (${this.contacts.size} contacts restants)`);
  }

  // ==================== STATISTIQUES ====================

  stats() {
    const total = this.contacts.size;
    const verified = Array.from(this.contacts.values())
      .filter(c => (c.verificationLevel || 0) >= 2).length;
    const favorites = this.favorites.length;
    const avgReputation = total > 0
      ? Math.floor(Array.from(this.contacts.values())
          .reduce((sum, c) => sum + (c.reputationScore || 0), 0) / total)
      : 0;

    return {
      totalContacts: total,
      verifiedContacts: verified,
      favoriteContacts: favorites,
      averageReputation: avgReputation,
    };
  }
}

export default ContactManager;