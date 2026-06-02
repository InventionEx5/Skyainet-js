// packages/secure/src/contacts/contact.js
// =====================================================
// Contact — Identité Décentralisée + Réputation + UI
// SkyAInet × Nikola T369
// =====================================================

"use strict";

import { Did } from '../roots/did.js';

// ─────────────────────────────────────────────────────────────────
// ERREUR TYPÉE
// ─────────────────────────────────────────────────────────────────

export class ContactError extends Error {
  constructor(message, code = 'CONTACT_ERROR') {
    super(message);
    this.name = 'ContactError';
    this.code = code;
  }
}

// ─────────────────────────────────────────────────────────────────
// CONTACT
//
// Représente un correspondant dans le carnet d'adresses SkyAInet.
//
// Dualité intentionnelle :
//   - Champs privés (#) pour la sécurité (nodeId, clé publique, DID)
//   - Champs publics pour le frontend HTML (alias, reputation, etc.)
//
// Niveau de vérification :
//   0 — aucune vérification
//   1 — signature Dilithium5 validée
//   2 — DID complet vérifié (signature + QR + DID instance)
// ─────────────────────────────────────────────────────────────────

export class Contact {
  #nodeId;            // Uint8Array(32) — immuable
  #verificationLevel; // 0 | 1 | 2
  #publicKey;         // Uint8Array | null
  #did;               // Did instance | null
  #revocationReason;  // string | null

  /**
   * @param {Uint8Array} nodeId
   * @param {object}    [opts]
   * @param {number}       opts.verificationLevel
   * @param {Uint8Array}   opts.publicKey
   * @param {string}       opts.alias
   * @param {string}       opts.did           — DID string (ex. "did:t369:…")
   * @param {number}       opts.reputation    — [0, 100]
   * @param {boolean}      opts.favorite
   * @param {boolean}      opts.revoked
   * @param {string}       opts.qrCodeHash
   * @param {number}       opts.interactionCount
   * @param {number}       opts.lastInteractionMs
   * @param {string}       opts.lastSeen
   */
  constructor(nodeId, opts = {}) {
    if (!(nodeId instanceof Uint8Array) || nodeId.length !== 32) {
      throw new ContactError('nodeId must be Uint8Array(32)', 'E_NODEID');
    }

    this.#nodeId            = new Uint8Array(nodeId);
    this.#verificationLevel = Math.max(0, Math.min(2, opts.verificationLevel ?? 0));
    this.#publicKey         = opts.publicKey instanceof Uint8Array
      ? new Uint8Array(opts.publicKey) : null;
    this.#did               = null;
    this.#revocationReason  = opts.revoked ? (opts.revocationReason ?? 'Révoqué') : null;

    // ── Champs UI — lisibles directement par le HTML ──────────
    this.alias             = opts.alias             ?? null;
    this.did               = opts.did               ?? null;   // DID string
    this.reputation        = Math.max(0, Math.min(100, opts.reputation ?? 50));
    this.favorite          = !!opts.favorite;
    this.revoked           = !!opts.revoked;
    this.qrCodeHash        = opts.qrCodeHash        ?? null;
    this.interactionCount  = Math.max(0, opts.interactionCount ?? 0);
    this.lastInteractionMs = opts.lastInteractionMs ?? null;
    this.lastSeen          = opts.lastSeen          ?? null;
    this.createdAt         = Date.now();
  }

  // ─── Accesseurs (lecture seule) ───────────────────────────────

  get nodeId()            { return this.#nodeId; }
  get verificationLevel() { return this.#verificationLevel; }
  get publicKey()         { return this.#publicKey; }
  get didInstance()       { return this.#did; }
  get revocationReason()  { return this.#revocationReason; }

  /** Compatibilité HTML : c.name */
  get name()     { return this.alias ?? ''; }
  /** Compatibilité HTML : c.verified */
  get verified() { return this.#verificationLevel >= 1; }

  // ─── DID ──────────────────────────────────────────────────────

  /**
   * Associe un DID à ce contact.
   * Accepte une instance Did ou une chaîne DID (niveau string seulement).
   * Élève automatiquement le verificationLevel à 2 si Did instance valide.
   */
  setDid(did) {
    if (did instanceof Did) {
      if (did.revoked) throw new ContactError('DID révoqué — association refusée', 'E_DID_REVOKED');
      this.#did = did;
      this.did  = did.toShortString();
      if (this.#verificationLevel < 2) this.#verificationLevel = 2;
    } else if (typeof did === 'string' && did.startsWith('did:')) {
      // DID string uniquement — pas d'instance, level 1 maximum
      this.did = did;
      if (this.#verificationLevel < 1) this.#verificationLevel = 1;
    } else {
      throw new ContactError('DID invalide — Did instance ou string "did:…" requis', 'E_DID');
    }
  }

  /**
   * true uniquement si le DID est une vraie instance Did non révoquée
   * et que le niveau de vérification est complet (2).
   */
  hasDecentralizedIdentity() {
    return this.#did instanceof Did
      && !this.#did.revoked
      && this.#verificationLevel >= 2;
  }

  // ─── Vérification ─────────────────────────────────────────────

  /**
   * Élève le niveau de vérification (monotone — ne peut pas descendre).
   * @param {0|1|2}        newLevel
   * @param {Uint8Array}   [publicKey] — clé publique Dilithium5
   */
  upgrade(newLevel, publicKey = null) {
    if (typeof newLevel !== 'number' || newLevel < 0 || newLevel > 2) {
      throw new ContactError('Niveau invalide (0, 1 ou 2)', 'E_UPGRADE');
    }
    if (newLevel > this.#verificationLevel) {
      this.#verificationLevel = newLevel;
    }
    if (publicKey instanceof Uint8Array && !this.#publicKey) {
      this.#publicKey = new Uint8Array(publicKey);
    }
  }

  // ─── Réputation ───────────────────────────────────────────────

  /**
   * Met à jour la réputation par EMA (α = 0.15).
   * Événements positifs : +5 à +30 selon le type.
   * Événements négatifs : -5 à -30.
   * @param {number} delta — variation brute en points [-100, 100]
   */
  updateReputation(delta) {
    if (typeof delta !== 'number') return;
    const alpha  = 0.15;
    const target = Math.max(0, Math.min(100, this.reputation + delta));
    this.reputation = +((this.reputation * (1 - alpha)) + (target * alpha)).toFixed(1);
  }

  // ─── Interactions ─────────────────────────────────────────────

  /** Enregistre une interaction et met à jour lastSeen. */
  recordInteraction() {
    this.interactionCount++;
    this.lastInteractionMs = Date.now();
    this.lastSeen          = 'just now';
  }

  /**
   * Met à jour lastSeen depuis un timestamp ms.
   * Utile pour la synchronisation depuis un pair distant.
   */
  updateLastSeen(timestampMs = Date.now()) {
    this.lastInteractionMs = timestampMs;
    const diff = Date.now() - timestampMs;
    if (diff < 60_000)         this.lastSeen = 'just now';
    else if (diff < 3_600_000) this.lastSeen = `${Math.floor(diff / 60_000)}m ago`;
    else if (diff < 86_400_000)this.lastSeen = `${Math.floor(diff / 3_600_000)}h ago`;
    else                       this.lastSeen = `${Math.floor(diff / 86_400_000)}d ago`;
  }

  // ─── Révocation ───────────────────────────────────────────────

  /**
   * Révoque le contact et son DID associé.
   * Opération irréversible — retire des favoris.
   */
  revoke(reason = 'Révoqué par administrateur') {
    this.revoked              = true;
    this.#revocationReason    = reason;
    this.favorite             = false;
    // Propagation au DID si instance disponible
    if (this.#did instanceof Did && !this.#did.revoked) {
      this.#did.revoke(reason);
    }
  }

  // ─── Utilitaires ─────────────────────────────────────────────

  nodeIdHex() {
    return Array.from(this.#nodeId).map(b => b.toString(16).padStart(2, '0')).join('');
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
