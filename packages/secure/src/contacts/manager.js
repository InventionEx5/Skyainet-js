// packages/secure/src/contacts/manager.js
// =====================================================
// ContactManager — Registre central des contacts
// SkyAInet × Nikola T369
// =====================================================

"use strict";

import { Contact, ContactError } from './contact.js';

export class ContactManager {
  #contacts = new Map();    // hex → Contact

  // ─── Écriture ────────────────────────────────────────────────

  add(contact) {
    if (!(contact instanceof Contact)) {
      throw new ContactError('Expected Contact instance', 'E_INPUT');
    }
    if (contact.revoked) {
      throw new ContactError('Contact révoqué — ajout refusé', 'E_REVOKED');
    }
    this.#contacts.set(contact.nodeIdHex(), contact);
    return this;
  }

  update(contact) {
    return this.add(contact);
  }

  remove(nodeId) {
    return this.#contacts.delete(_hex(nodeId));
  }

  // ─── Lecture ─────────────────────────────────────────────────

  get(nodeId) {
    return this.#contacts.get(_hex(nodeId)) ?? null;
  }

  has(nodeId) {
    return this.#contacts.has(_hex(nodeId));
  }

  list(includeRevoked = false) {
    const all = [...this.#contacts.values()];
    return includeRevoked ? all : all.filter(c => !c.revoked);
  }

  getAll(includeRevoked = false) {
    return this.list(includeRevoked);
  }

  getVerified(minLevel = 1) {
    return this.list().filter(c => c.verificationLevel >= minLevel);
  }

  getFavorites() {
    return this.list().filter(c => c.favorite);
  }

  search(query) {
    if (!query?.trim()) return this.list();
    const q = query.toLowerCase();
    return this.list().filter(c =>
      (c.alias && c.alias.toLowerCase().includes(q)) ||
      (c.did && c.did.toLowerCase().includes(q))
    );
  }

  find(fn) {
    return this.list().find(fn) ?? null;
  }

  filter(fn) {
    return this.list().filter(fn);
  }

  size(includeRevoked = false) {
    return includeRevoked ? this.#contacts.size : this.list().length;
  }

  sortedByReputation() {
    return [...this.list()].sort((a, b) => b.reputation - a.reputation);
  }

  sortedByActivity() {
    return [...this.list()].sort((a, b) =>
      (b.lastInteractionMs ?? 0) - (a.lastInteractionMs ?? 0)
    );
  }

  // ─── Sérialisation ───────────────────────────────────────────

  toJSON() {
    return this.list(true).map(c => c.toJSON());
  }
}

// ─────────────────────────────────────────────────────────────────
// HELPER INTERNE
// ─────────────────────────────────────────────────────────────────

function _hex(nodeId) {
  if (typeof nodeId === 'string') return nodeId;
  if (nodeId instanceof Uint8Array) {
    return Array.from(nodeId).map(b => b.toString(16).padStart(2, '0')).join('');
  }
  return String(nodeId);
}