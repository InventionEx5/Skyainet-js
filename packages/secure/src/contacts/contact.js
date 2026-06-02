// packages/secure/src/contacts/contact.js
// =====================================================
// Contact — Identité décentralisée robuste (DID + réputation + UI)
// Remplace tous les stubs/shims/simulations par de vraies logiques métier.
// SkyAInet × Nikola T369
// =====================================================

"use strict";

import { Did } from '../roots/did.js';

export class ContactError extends Error {
  constructor(message, code = 'CONTACT_ERROR') {
    super(message);
    this.name = 'ContactError';
    this.code = code;
  }
}

export class Contact {
  // ─── Champs privés (encapsulation stricte) ───────────────────
  #nodeId;            // Uint8Array(32)
  #verificationLevel; // 0-2
  #publicKey;         // Uint8Array | null
  #did;               // Did | null
  #revocationReason;  // string | null

  constructor(nodeId, opts = {}) {
    if (!(nodeId instanceof Uint8Array) || nodeId.length !== 32) {
      throw new ContactError('nodeId must be Uint8Array(32)', 'E_NODEID');
    }

    this.#nodeId            = new Uint8Array(nodeId);
    this.#verificationLevel = Math.max(0, Math.min(2, opts.verificationLevel ?? 0));
    this.#publicKey         = opts.publicKey instanceof Uint8Array ? new Uint8Array(opts.publicKey) : null;
    this.#did               = null;
    this.#revocationReason  = null;

    // Champs UI publics (lisibles directement par le frontend HTML)
    this.alias              = opts.alias             ?? null;
    this.did                = opts.did               ?? null;
    this.reputation         = Math.max(0, Math.min(100, opts.reputation ?? 50));
    this.favorite           = !!opts.favorite;
    this.revoked            = !!opts.revoked;
    this.qrCodeHash         = opts.qrCodeHash        ?? null;
    this.interactionCount   = Math.max(0, opts.interactionCount ?? 0);
    this.lastInteractionMs  = opts.lastInteractionMs ?? null;
    this.lastSeen           = opts.lastSeen          ?? null;
    this.createdAt          = Date.now();
  }

  // ─── Accesseurs (lecture seule) ───────────────────────────────
  get nodeId()            { return this.#nodeId; }
  get verificationLevel() { return this.#verificationLevel; }
  get publicKey()         { return this.#publicKey; }
  get didInstance()       { return this.#did; }

  get name()     { return this.alias ?? ''; }
  get verified() { return this.#verificationLevel >= 1; }
  get revocationReason() { return this.#revocationReason; }

  // ─── DID ──────────────────────────────────────────────────────
  setDid(did) {
    if (did instanceof Did) {
      this.#did = did;
      if (this.#verificationLevel < 2) this.#verificationLevel = 2;
      this.did = did.toShortString();
    } else if (typeof did === 'string') {
      this.did = did;
      if (this.#verificationLevel < 2) this.#verificationLevel = 2;
    }
  }

  hasDecentralizedIdentity() {
    return this.#did instanceof Did &&
           !this.#did.revoked &&
           this.#verificationLevel >= 2;
  }

  // ─── Mutations réelles et robustes ────────────────────────────
  upgrade(newLevel, publicKey = null) {
    if (typeof newLevel !== 'number' || newLevel < 0 || newLevel > 2) {
      throw new ContactError('niveau de vérification invalide (0-2)', 'E_UPGRADE');
    }
    if (newLevel > this.#verificationLevel) {
      this.#verificationLevel = newLevel;
    }
    if (publicKey instanceof Uint8Array && !this.#publicKey) {
      this.#publicKey = new Uint8Array(publicKey);
    }
  }

  updateReputation(delta) {
    if (typeof delta !== 'number') return;
    const alpha  = 0.15;
    const target = Math.max(0, Math.min(100, this.reputation + delta));
    this.reputation = +((this.reputation * (1 - alpha)) + (target * alpha)).toFixed(1);
  }

  recordInteraction() {
    this.interactionCount = (this.interactionCount || 0) + 1;
    this.lastInteractionMs = Date.now();

    const diff = Date.now() - this.lastInteractionMs;
    if (diff < 60_000)       this.lastSeen = 'à l\'instant';
    else if (diff < 3_600_000) this.lastSeen = `${Math.floor(diff / 60_000)}m ago`;
    else                     this.lastSeen = `${Math.floor(diff / 3_600_000)}h ago`;
  }

  revoke(reason = 'Révoqué par administrateur') {
    this.revoked = true;
    this.#revocationReason = reason;
    this.favorite = false;
    if (this.#did) this.#did.revoke(reason);
  }

  // ─── Utilitaires ─────────────────────────────────────────────
  nodeIdHex() {
    return Array.from(this.#nodeId)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  toJSON() {
    return {
      nodeId            : this.nodeIdHex(),
      did               : this.did,
      alias             : this.alias,
      name              : this.name,
      verificationLevel : this.#verificationLevel,
      verified          : this.verified,
      reputation        : this.reputation,
      favorite          : this.favorite,
      revoked           : this.revoked,
      revocationReason  : this.#revocationReason,
      qrCodeHash        : this.qrCodeHash,
      interactionCount  : this.interactionCount,
      lastInteractionMs : this.lastInteractionMs,
      lastSeen          : this.lastSeen,
      hasPublicKey      : this.#publicKey !== null,
      hasDID            : this.hasDecentralizedIdentity(),
      createdAt         : this.createdAt,
    };
  }

  equals(other) {
    if (!(other instanceof Contact)) return false;
    return this.nodeIdHex() === other.nodeIdHex();
  }
}