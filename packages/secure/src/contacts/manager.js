// packages/secure/src/contacts/manager.js
// =====================================================
// ContactManager — Registre Central des Contacts
// SkyAInet × Nikola T369
// =====================================================

"use strict";

import { Contact, ContactError } from './contact.js';

// ─────────────────────────────────────────────────────────────────
// CONTACT MANAGER
//
// Registre Map<nodeIdHex, Contact> avec CRUD complet,
// recherche full-text, filtres, tris, et sérialisation.
//
// Règles d'intégrité :
//   - Un contact révoqué peut être consulté mais pas ajouté.
//   - update() remplace silencieusement un contact existant.
//   - list() exclut les révoqués par défaut (includeRevoked = false).
// ─────────────────────────────────────────────────────────────────

export class ContactManager {
  #contacts = new Map();    // hex → Contact

  // ─── Écriture ────────────────────────────────────────────────

  /**
   * Ajoute un contact. Lève si la valeur n'est pas une instance Contact
   * ou si le contact est révoqué.
   */
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

  /**
   * Met à jour un contact existant (remplace) ou l'ajoute s'il est absent.
   * Contrairement à add(), accepte les contacts révoqués pour permettre
   * la mise à jour d'un contact qui vient d'être révoqué.
   */
  update(contact) {
    if (!(contact instanceof Contact)) {
      throw new ContactError('Expected Contact instance', 'E_INPUT');
    }
    this.#contacts.set(contact.nodeIdHex(), contact);
    return this;
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

  /**
   * Tous les contacts, révoqués exclus par défaut.
   * @param {boolean} includeRevoked
   * @returns {Contact[]}
   */
  list(includeRevoked = false) {
    const all = [...this.#contacts.values()];
    return includeRevoked ? all : all.filter(c => !c.revoked);
  }

  /** Alias de list() — compatibilité avec callers existants. */
  getAll(includeRevoked = false) { return this.list(includeRevoked); }

  /** Contacts dont verificationLevel ≥ minLevel. */
  getVerified(minLevel = 1) {
    return this.list().filter(c => c.verificationLevel >= minLevel);
  }

  /** Contacts avec DID complet (hasDecentralizedIdentity === true). */
  getDIDContacts() {
    return this.list().filter(c => c.hasDecentralizedIdentity());
  }

  /** Contacts marqués favoris. */
  getFavorites() {
    return this.list().filter(c => c.favorite);
  }

  /**
   * Recherche full-text sur alias, DID et nodeIdHex.
   * Insensible à la casse. Retourne tous les contacts si query vide.
   * Utilisé par la barre de recherche du HTML.
   */
  search(query) {
    if (!query?.trim()) return this.list();
    const q = query.toLowerCase().trim();
    return this.list().filter(c =>
      c.alias?.toLowerCase().includes(q) ||
      c.did?.toLowerCase().includes(q)   ||
      c.nodeIdHex().includes(q)
    );
  }

  /** Retourne le premier contact correspondant au prédicat. */
  find(fn) {
    return this.list().find(fn) ?? null;
  }

  /** Retourne tous les contacts correspondant au prédicat. */
  filter(fn) {
    return this.list().filter(fn);
  }

  size(includeRevoked = false) {
    return includeRevoked ? this.#contacts.size : this.list().length;
  }

  // ─── Tris ─────────────────────────────────────────────────────

  /** Tri décroissant par réputation. */
  sortedByReputation() {
    return [...this.list()].sort((a, b) => b.reputation - a.reputation);
  }

  /** Tri décroissant par activité (lastInteractionMs le plus récent d'abord). */
  sortedByActivity() {
    return [...this.list()].sort((a, b) =>
      (b.lastInteractionMs ?? 0) - (a.lastInteractionMs ?? 0)
    );
  }

  /** Tri par niveau de vérification décroissant puis réputation. */
  sortedByTrust() {
    return [...this.list()].sort((a, b) =>
      b.verificationLevel !== a.verificationLevel
        ? b.verificationLevel - a.verificationLevel
        : b.reputation - a.reputation
    );
  }

  // ─── Opérations groupées ─────────────────────────────────────

  /**
   * Révoque un contact par nodeId.
   * Met à jour le contact en place sans le supprimer du registre —
   * permet l'audit après révocation.
   */
  revokeContact(nodeId, reason = 'Révoqué') {
    const contact = this.get(nodeId);
    if (!contact) throw new ContactError('Contact introuvable', 'E_NOT_FOUND');
    contact.revoke(reason);
    return this;
  }

  /**
   * Enregistre une interaction pour un contact et met à jour lastSeen.
   * Crée silencieusement si absent (ne lève pas).
   */
  recordInteraction(nodeId) {
    const contact = this.get(nodeId);
    if (contact) contact.recordInteraction();
    return this;
  }

  // ─── Statistiques ─────────────────────────────────────────────

  stats() {
    const all      = this.list(true);
    const active   = all.filter(c => !c.revoked);
    const verified = active.filter(c => c.verificationLevel >= 1);
    const didFull  = active.filter(c => c.hasDecentralizedIdentity());
    const avgRep   = active.length > 0
      ? +(active.reduce((s, c) => s + c.reputation, 0) / active.length).toFixed(1)
      : 0;

    return {
      total     : all.length,
      active    : active.length,
      revoked   : all.length - active.length,
      verified  : verified.length,
      didFull   : didFull.length,
      favorites : active.filter(c => c.favorite).length,
      avgReputation: avgRep,
    };
  }

  // ─── Sérialisation ───────────────────────────────────────────

  /** Sérialise tous les contacts (y compris révoqués) pour l'archive HTML. */
  toJSON() {
    return this.list(true).map(c => c.toJSON());
  }
}

// ─────────────────────────────────────────────────────────────────
// HELPER INTERNE
// ─────────────────────────────────────────────────────────────────

function _hex(nodeId) {
  if (typeof nodeId === 'string') return nodeId.toLowerCase();
  if (nodeId instanceof Uint8Array) {
    return Array.from(nodeId).map(b => b.toString(16).padStart(2, '0')).join('');
  }
  return String(nodeId);
}
