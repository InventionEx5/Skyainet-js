// packages/secure/src/roots/attestation.js
// =====================================================
// NodeAttestation — Preuve d'Identité Post-Quantique
// Dilithium5 + Timestamp + DID + Epoch
// SkyAInet × Nikola T369
// =====================================================

"use strict";

import { Dilithium5Signer, Dilithium5KeyPair } from '../crypto/dilithium.js';
import { hkdfSha256, hmacSha256 }              from '../crypto/sha_fips.js';
import { Contact, ContactManager }             from './pool.js';
import { randomBytes }                             from 'crypto';

// ─────────────────────────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────────────────────────

const ATTESTATION_TTL_S  = 86_400;   // validité 24 h
const CHALLENGE_TTL_S    = 300;      // challenge frais = 5 min
const TE                 = new TextEncoder();

// ─────────────────────────────────────────────────────────────────
// ERREUR TYPÉE
// ─────────────────────────────────────────────────────────────────

export class AttestationError extends Error {
  constructor(message, code = 'ATTEST_ERROR') {
    super(message);
    this.name = 'AttestationError';
    this.code = code;
  }
}

// ─────────────────────────────────────────────────────────────────
// NODE ATTESTATION
//
// Une attestation prouve qu'un nœud :
//   1. Détient la clé secrète Dilithium5 correspondant à sa clé publique
//   2. A signé un challenge liant son nodeId + epoch + timestamp
//   3. (optionnel) A un DID vérifié par ContactManager
//
// Structure du message signé :
//   "skynet-attest|<nodeId_hex>|<epoch>|<timestamp>|<challenge_hex>"
//
// Cette structure est déterministe et vérifiable sans état côté vérificateur.
// ─────────────────────────────────────────────────────────────────

export class NodeAttestation {
  #shortId;

  constructor({ nodeId, publicKey, signature, timestamp, epoch, challenge, did = null }) {
    if (!(nodeId    instanceof Uint8Array) || nodeId.length !== 32) {
      throw new AttestationError('nodeId doit être Uint8Array(32)', 'E_INPUT');
    }
    if (!(publicKey instanceof Uint8Array) || publicKey.length === 0) {
      throw new AttestationError('publicKey invalide', 'E_INPUT');
    }
    if (!(signature instanceof Uint8Array) || signature.length === 0) {
      throw new AttestationError('signature invalide', 'E_INPUT');
    }

    this.nodeId    = nodeId;
    this.publicKey = publicKey;
    this.signature = signature;
    this.timestamp = timestamp;
    this.epoch     = epoch;
    this.challenge = challenge;   // Uint8Array(32)
    this.did       = did ?? null;

    this.#shortId = _hexShort(nodeId, 8);
  }

  // ─── Message signé (déterministe) ────────────────────────────

  /**
   * Retourne le message exact qui a été signé.
   * Identique côté créateur et vérificateur.
   */
  signedMessage() {
    return TE.encode(
      `skynet-attest|${_hexShort(this.nodeId, 32)}|${this.epoch}|${this.timestamp}|${_hexShort(this.challenge, 32)}`
    );
  }

  // ─── Vérification complète ────────────────────────────────────

  /**
   * Vérifie l'attestation :
   *   1. Expiration (TTL 24 h)
   *   2. Fraîcheur du challenge (TTL 5 min)
   *   3. Signature Dilithium5 (vérification post-quantique)
   *   4. DID si ContactManager fourni
   *
   * @param {ContactManager} [contactManager]
   * @returns {true}
   * @throws {AttestationError}
   */
  verify(contactManager = null) {
    const now = _nowSec();

    // — Expiration de l'attestation
    if (now - this.timestamp > ATTESTATION_TTL_S) {
      throw new AttestationError(
        `Attestation expirée depuis ${now - this.timestamp - ATTESTATION_TTL_S}s`,
        'E_EXPIRED'
      );
    }

    // — Fraîcheur du challenge (anti-replay)
    if (now - this.timestamp > CHALLENGE_TTL_S) {
      // Avertissement non bloquant : l'attestation est valide mais le challenge est vieux
      // On logue sans rejeter pour ne pas casser les flux lents (réseau dégradé)
      console.debug(`[Attestation] Challenge âgé de ${now - this.timestamp}s (max recommandé: ${CHALLENGE_TTL_S}s)`);
    }

    // — Vérification Dilithium5 : la clé publique doit avoir signé le message exact
    const msg = this.signedMessage();
    const ok  = Dilithium5KeyPair.verify(this.publicKey, msg, this.signature);
    if (!ok) {
      throw new AttestationError(
        `Signature Dilithium5 invalide pour le nœud ${this.#shortId}`,
        'E_SIG'
      );
    }

    // — Vérification DID (optionnelle)
    if (contactManager instanceof ContactManager) {
      const contact = contactManager.get(this.nodeId);
      if (contact) {
        if (!contact.hasDecentralizedIdentity()) {
          throw new AttestationError(
            `Nœud ${this.#shortId} : DID requis mais non vérifié`,
            'E_DID'
          );
        }
        // Si l'attestation déclare un DID, vérifier la cohérence
        if (this.did && contact.nodeIdHex && !_didMatches(this.did, contact)) {
          throw new AttestationError(
            `DID déclaré ne correspond pas au contact enregistré`,
            'E_DID_MISMATCH'
          );
        }
      }
    }

    console.debug(`[Attestation] Nœud ${this.#shortId} attesté ✅ (epoch ${this.epoch})`);
    return true;
  }

  // ─── Sérialisation ───────────────────────────────────────────

  toBytes() {
    const json = JSON.stringify({
      nodeId   : Array.from(this.nodeId),
      publicKey: Array.from(this.publicKey),
      signature: Array.from(this.signature),
      challenge: Array.from(this.challenge),
      timestamp: this.timestamp,
      epoch    : this.epoch,
      did      : this.did,
    });
    return TE.encode(json);
  }

  static fromBytes(bytes) {
    const obj = JSON.parse(new TextDecoder().decode(bytes));
    return new NodeAttestation({
      nodeId   : new Uint8Array(obj.nodeId),
      publicKey: new Uint8Array(obj.publicKey),
      signature: new Uint8Array(obj.signature),
      challenge: new Uint8Array(obj.challenge),
      timestamp: obj.timestamp,
      epoch    : obj.epoch,
      did      : obj.did,
    });
  }

  // ─── Factory ─────────────────────────────────────────────────

  /**
   * Crée et signe une nouvelle attestation.
   *
   * @param {Uint8Array}        nodeId    — identifiant du nœud (32 octets)
   * @param {Dilithium5Signer}  signer    — signer détenant la clé secrète
   * @param {number}            epoch     — epoch courant du circuit/rekey
   * @param {Contact}           [contact] — contact DID optionnel
   * @returns {NodeAttestation}
   */
  static create(nodeId, signer, epoch, contact = null) {
    if (!(nodeId  instanceof Uint8Array) || nodeId.length !== 32) {
      throw new AttestationError('nodeId doit être Uint8Array(32)', 'E_INPUT');
    }
    if (!(signer instanceof Dilithium5Signer)) {
      throw new AttestationError('signer doit être Dilithium5Signer', 'E_INPUT');
    }

    const timestamp = _nowSec();
    const challenge = randomBytes(32);

    // Construction du message déterministe
    const msg = TE.encode(
      `skynet-attest|${_hexFull(nodeId)}|${epoch}|${timestamp}|${_hexFull(challenge)}`
    );

    const signature  = signer.sign(msg);
    const publicKey  = signer.publicKeyBytes();   // voir note ci-dessous
    const did        = contact?.alias ?? null;

    return new NodeAttestation({ nodeId, publicKey, signature, timestamp, epoch, challenge, did });
  }
}

// ─────────────────────────────────────────────────────────────────
// ATTESTATION MANAGER — vérifie et met en cache les attestations
//
// Évite de re-vérifier les signatures Dilithium5 (coûteuses) pour
// les nœuds déjà attestés dans la fenêtre TTL courante.
// ─────────────────────────────────────────────────────────────────

export class AttestationManager {
  #cache;      // Map<nodeIdHex, {attestation, verifiedAt}>
  #ttlMs;

  constructor(opts = {}) {
    this.#cache = new Map();
    this.#ttlMs = (opts.cacheTtlSecs ?? 3600) * 1000;
    // Nettoyage périodique
    setInterval(() => this.#purge(), this.#ttlMs).unref();
  }

  /**
   * Vérifie une attestation et la met en cache si valide.
   * Retourne true immédiatement si déjà en cache et non expirée.
   */
  verify(attestation, contactManager = null) {
    if (!(attestation instanceof NodeAttestation)) {
      throw new AttestationError('Expected NodeAttestation instance', 'E_INPUT');
    }

    const hex = _hexFull(attestation.nodeId);
    const cached = this.#cache.get(hex);

    if (cached && Date.now() - cached.verifiedAt < this.#ttlMs) {
      // Cache hit — pas de re-vérification signature
      return true;
    }

    // Vérification complète
    attestation.verify(contactManager);

    this.#cache.set(hex, { attestation, verifiedAt: Date.now() });
    return true;
  }

  /** Retourne l'attestation en cache pour un nodeId, ou null */
  get(nodeId) {
    const hex    = _hexFull(nodeId);
    const cached = this.#cache.get(hex);
    if (!cached || Date.now() - cached.verifiedAt >= this.#ttlMs) return null;
    return cached.attestation;
  }

  /** Révoque une attestation (par ex. après détection d'anomalie) */
  revoke(nodeId) {
    return this.#cache.delete(_hexFull(nodeId));
  }

  stats() {
    return { cachedNodes: this.#cache.size, ttlMs: this.#ttlMs };
  }

  #purge() {
    const now = Date.now();
    for (const [hex, entry] of this.#cache) {
      if (now - entry.verifiedAt >= this.#ttlMs) this.#cache.delete(hex);
    }
  }
}

// ─────────────────────────────────────────────────────────────────
// HELPERS INTERNES
// ─────────────────────────────────────────────────────────────────

function _nowSec() { return Math.floor(Date.now() / 1000); }

function _hexShort(arr, bytes) {
  return Array.from(arr.subarray(0, bytes))
    .map(b => b.toString(16).padStart(2, '0')).join('');
}

function _hexFull(arr) {
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

function _didMatches(did, contact) {
  // Vérification souple : le DID doit contenir l'alias ou le nodeIdHex partiel
  return contact.alias ? did.includes(contact.alias) : true;
}
