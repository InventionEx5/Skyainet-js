// packages/secure/src/roots/did.js
// =====================================================
// DID (Decentralized Identifier) t369
// SkyAInet × Nikola T369 — DID Core + Dilithium5 + Services
// =====================================================

"use strict";

import { Dilithium5Signer, Dilithium5KeyPair } from '../crypto/dilithium.js';
import { hkdfSha256, hmacSha256, constantTimeEq } from '../crypto/sha_fips.js';

// ─────────────────────────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────────────────────────

const DID_METHOD       = 'did:t369';
const DID_PREFIX_BYTES = 16;         // octets de la clé publique dans l'identifiant
const TE               = new TextEncoder();
const TD               = new TextDecoder();

// ─────────────────────────────────────────────────────────────────
// ERREUR TYPÉE
// ─────────────────────────────────────────────────────────────────

export class DidError extends Error {
  constructor(message, code = 'DID_ERROR') {
    super(message);
    this.name = 'DidError';
    this.code = code;
  }
}

// ─────────────────────────────────────────────────────────────────
// TYPES DE SERVICE
// ─────────────────────────────────────────────────────────────────

export const ServiceType = Object.freeze({
  Messaging : 'Messaging',
  Storage   : 'Storage',
  Compute   : 'Compute',
  Discovery : 'Discovery',
  Custom    : (name) => `Custom(${name})`,
});

// ─────────────────────────────────────────────────────────────────
// SERVICE ENDPOINT
// ─────────────────────────────────────────────────────────────────

export class ServiceEndpoint {
  constructor(id, type, serviceEndpoint, priority = 0) {
    if (!id?.trim())             throw new DidError("id du service invalide",       'E_INPUT');
    if (!serviceEndpoint?.trim()) throw new DidError("endpoint invalide",           'E_INPUT');

    this.id              = id.trim();
    this.type            = type;
    this.serviceEndpoint = serviceEndpoint.trim();
    this.priority        = priority;
    this.createdAt       = _nowSec();
  }
}

// ─────────────────────────────────────────────────────────────────
// DID
//
// L'identifiant est dérivé des 16 premiers octets de la clé publique
// Dilithium5 (2592 octets typiquement).
//
// Nouveauté vs l'original :
//   - La clé publique Dilithium5 (taille réelle) est acceptée, pas
//     seulement 32 octets. La restriction à 32 octets était un artefact
//     — Dilithium5 produit des clés de ~2592 octets.
//   - Un fingerprint HKDF-32 de la clé publique complète est calculé
//     et mémorisé pour des comparaisons rapides constant-time.
//   - La rotation de clé produit un historique horodaté (audit trail).
//   - toDidDocument() retourne un objet parseable, pas une chaîne JSON.
//   - verifyWithDilithium() accepte la clé publique directement
//     (vérification stateless, sans état du signer).
// ─────────────────────────────────────────────────────────────────

export class Did {
  #publicKey;     // Uint8Array — clé publique complète (taille réelle Dilithium5)
  #fingerprint;   // Uint8Array(32) — HKDF de la clé publique (comparaison rapide)
  #keyHistory;    // [{publicKey, fingerprint, rotatedAt}]

  /**
   * @param {Uint8Array} publicKey — clé publique Dilithium5 (≥ 16 octets)
   */
  constructor(publicKey) {
    const pk = publicKey instanceof Uint8Array ? publicKey : new Uint8Array(publicKey);
    if (pk.length < DID_PREFIX_BYTES) {
      throw new DidError(`Clé publique trop courte (min ${DID_PREFIX_BYTES} octets)`, 'E_INPUT');
    }

    this.#publicKey   = pk;
    this.#fingerprint = hkdfSha256(pk, null, TE.encode('did-fingerprint'), 32);
    this.#keyHistory  = [];

    this.id                 = `${DID_METHOD}:${_hex(pk.subarray(0, DID_PREFIX_BYTES))}`;
    this.authentication     = ['Dilithium5VerificationKey2020'];
    this.service            = [];           // ServiceEndpoint[]
    this.createdAt          = _nowSec();
    this.updatedAt          = _nowSec();
    this.revoked            = false;
    this.revocationReason   = null;
  }

  // ─── Factory ─────────────────────────────────────────────────

  /**
   * Crée un DID depuis une clé publique Dilithium5.
   * C'est le constructeur recommandé — clé de taille naturelle.
   */
  static fromDilithiumKey(dilithiumPublicKey) {
    const pk = dilithiumPublicKey instanceof Uint8Array
      ? dilithiumPublicKey
      : new Uint8Array(dilithiumPublicKey);
    return new Did(pk);
  }

  /**
   * Crée un DID + son signer Dilithium5 associé en une seule opération.
   * Retourne {did, signer} — le signer détient la clé secrète.
   */
  static generate() {
    const signer = new Dilithium5Signer();
    const did    = Did.fromDilithiumKey(signer.publicKeyBytes());
    return { did, signer };
  }

  // ─── Accesseurs ───────────────────────────────────────────────

  /** Retourne une copie de la clé publique (ne jamais exposer la référence) */
  getPublicKey()   { return new Uint8Array(this.#publicKey); }

  /** Retourne le fingerprint HKDF-32 pour comparaison rapide */
  getFingerprint() { return new Uint8Array(this.#fingerprint); }

  // ─── Services ─────────────────────────────────────────────────

  addService(id, serviceType, endpoint, priority = 0) {
    if (this.revoked) throw new DidError('DID révoqué — aucune modification possible', 'E_REVOKED');
    if (this.service.find(s => s.id === id)) {
      throw new DidError(`Service '${id}' existe déjà`, 'E_DUPLICATE');
    }
    this.service.push(new ServiceEndpoint(id, serviceType, endpoint, priority));
    this.updatedAt = _nowSec();
  }

  removeService(serviceId) {
    if (this.revoked) throw new DidError('DID révoqué', 'E_REVOKED');
    const before = this.service.length;
    this.service  = this.service.filter(s => s.id !== serviceId);
    if (this.service.length === before) {
      throw new DidError(`Service '${serviceId}' introuvable`, 'E_NOT_FOUND');
    }
    this.updatedAt = _nowSec();
  }

  getService(type) {
    return this.service
      .filter(s => s.type === type)
      .sort((a, b) => b.priority - a.priority);
  }

  // ─── Révocation ───────────────────────────────────────────────

  revoke(reason) {
    if (this.revoked) return;   // idempotent
    this.revoked          = true;
    this.revocationReason = reason ?? 'Non spécifiée';
    this.updatedAt        = _nowSec();
    console.warn(`[DID] Révoqué : ${this.id} (${this.revocationReason})`);
  }

  // ─── Vérification de signature ────────────────────────────────

  /**
   * Vérifie une signature Dilithium5 contre la clé publique de ce DID.
   * Stateless — pas besoin d'un signer initialisé côté vérificateur.
   *
   * @param {Uint8Array|string} message
   * @param {Uint8Array}        signature
   * @returns {true}
   * @throws {DidError}
   */
  verify(message, signature) {
    if (this.revoked) throw new DidError('DID révoqué — vérification refusée', 'E_REVOKED');

    const msg = typeof message === 'string' ? TE.encode(message) : message;
    const sig = signature instanceof Uint8Array ? signature : new Uint8Array(signature);

    const ok = Dilithium5KeyPair.verify(this.#publicKey, msg, sig);
    if (!ok) throw new DidError('Signature Dilithium5 invalide', 'E_SIG');
    return true;
  }

  /**
   * Vérifie via un Dilithium5Signer existant (compatibilité ascendante).
   * Délègue à verify() après extraction de la clé publique du signer.
   */
  verifyWithDilithium(message, signature, dilithiumSigner) {
    if (this.revoked) throw new DidError('DID révoqué', 'E_REVOKED');

    const msg = typeof message === 'string' ? TE.encode(message) : message;
    const sig = signature instanceof Uint8Array ? signature : new Uint8Array(signature);

    // Vérifie que la clé du signer correspond à celle du DID (constant-time)
    const signerPk = dilithiumSigner.publicKeyBytes();
    if (!constantTimeEq(
      hkdfSha256(signerPk,         null, TE.encode('did-fingerprint'), 32),
      this.#fingerprint
    )) {
      throw new DidError('La clé du signer ne correspond pas à ce DID', 'E_KEY_MISMATCH');
    }

    const ok = dilithiumSigner.verify(msg, sig);
    if (!ok) throw new DidError('Signature Dilithium5 invalide', 'E_SIG');
    return true;
  }

  // ─── Rotation de clé ──────────────────────────────────────────

  /**
   * Effectue la rotation de la clé publique.
   * L'ancienne clé est archivée dans l'historique (audit trail).
   * Le DID id change en conséquence.
   *
   * @param {Uint8Array} newPublicKey — nouvelle clé publique Dilithium5
   */
  rotatePublicKey(newPublicKey) {
    if (this.revoked) throw new DidError('DID révoqué — rotation impossible', 'E_REVOKED');

    const pk = newPublicKey instanceof Uint8Array ? newPublicKey : new Uint8Array(newPublicKey);
    if (pk.length < DID_PREFIX_BYTES) {
      throw new DidError(`Nouvelle clé trop courte (min ${DID_PREFIX_BYTES} octets)`, 'E_INPUT');
    }

    // Archive l'ancienne clé
    this.#keyHistory.push({
      publicKey  : this.#publicKey,
      fingerprint: this.#fingerprint,
      rotatedAt  : _nowSec(),
    });
    // Pas de limite sur l'historique : chaque rotation doit être auditée

    // Mise à jour
    this.#publicKey   = pk;
    this.#fingerprint = hkdfSha256(pk, null, TE.encode('did-fingerprint'), 32);
    this.id           = `${DID_METHOD}:${_hex(pk.subarray(0, DID_PREFIX_BYTES))}`;
    this.updatedAt    = _nowSec();

    console.info(`[DID] Rotation effectuée → ${this.id}`);
  }

  /**
   * Vérifie une signature avec une clé historique (index 0 = la plus récente).
   * Utile pendant la fenêtre de transition après une rotation.
   */
  verifyWithHistoricKey(message, signature, keyIndex = 0) {
    if (this.#keyHistory.length === 0) {
      throw new DidError('Aucun historique de clé', 'E_NO_HISTORY');
    }
    const entry = this.#keyHistory[keyIndex];
    if (!entry) throw new DidError(`Clé historique [${keyIndex}] introuvable`, 'E_NOT_FOUND');

    const msg = typeof message === 'string' ? TE.encode(message) : message;
    const sig = signature instanceof Uint8Array ? signature : new Uint8Array(signature);
    const ok  = Dilithium5KeyPair.verify(entry.publicKey, msg, sig);
    if (!ok) throw new DidError('Signature historique invalide', 'E_SIG');
    return true;
  }

  // ─── Sérialisation ───────────────────────────────────────────

  /**
   * Retourne le DID Document complet (objet parseable).
   * Conforme à la structure DID Core W3C (simplifiée).
   */
  toDidDocument() {
    return {
      '@context'      : ['https://www.w3.org/ns/did/v1', 'https://skyainet.io/did/v1'],
      id              : this.id,
      verificationMethod: [{
        id          : `${this.id}#keys-1`,
        type        : 'Dilithium5VerificationKey2020',
        controller  : this.id,
        publicKeyHex: _hex(this.#publicKey),
      }],
      authentication: [`${this.id}#keys-1`],
      service       : this.service.map(s => ({
        id             : s.id,
        type           : s.type,
        serviceEndpoint: s.serviceEndpoint,
        priority       : s.priority,
      })),
      created       : this.createdAt,
      updated       : this.updatedAt,
      revoked       : this.revoked,
      revocationReason: this.revocationReason,
    };
  }

  toShortString()  { return this.id; }
  toString()       { return this.id; }

  // ─── Comparaison ─────────────────────────────────────────────

  /**
   * Compare deux DID par fingerprint en constant-time.
   * Résistant aux timing attacks.
   */
  equals(other) {
    if (!(other instanceof Did)) return false;
    return constantTimeEq(this.#fingerprint, other.getFingerprint());
  }

  // ─── Sérialisation binaire ────────────────────────────────────

  /** Sérialise le DID en JSON encodé UTF-8 pour transmission/stockage */
  toBytes() {
    return TE.encode(JSON.stringify(this.toDidDocument()));
  }

  /** Désérialise un DID depuis ses bytes */
  static fromBytes(bytes) {
    const doc = JSON.parse(TD.decode(bytes));
    const pkHex = doc.verificationMethod?.[0]?.publicKeyHex;
    if (!pkHex) throw new DidError('Document DID invalide — publicKeyHex manquant', 'E_PARSE');

    const pk  = Uint8Array.from(pkHex.match(/.{2}/g).map(h => parseInt(h, 16)));
    const did = new Did(pk);

    // Restaure les services
    for (const s of (doc.service ?? [])) {
      did.service.push(new ServiceEndpoint(s.id, s.type, s.serviceEndpoint, s.priority));
    }
    did.createdAt       = doc.created;
    did.updatedAt       = doc.updated;
    did.revoked         = doc.revoked ?? false;
    did.revocationReason= doc.revocationReason ?? null;
    return did;
  }

  // ─── Helpers privés ───────────────────────────────────────────

  getKeyHistory() {
    return this.#keyHistory.map(e => ({
      fingerprint: _hex(e.fingerprint),
      rotatedAt  : e.rotatedAt,
    }));
  }
}

// ─────────────────────────────────────────────────────────────────
// DID REGISTRY — registre local en mémoire
//
// Permet de résoudre un DID par son id string, de révoquer,
// et de lister les DIDs actifs. Conçu pour être étendu par
// un registre distribué (P2P, blockchain) sans casser l'interface.
// ─────────────────────────────────────────────────────────────────

export class DidRegistry {
  #dids;    // Map<id_string, Did>

  constructor() {
    this.#dids = new Map();
  }

  register(did) {
    if (!(did instanceof Did)) throw new DidError('Expected Did instance', 'E_INPUT');
    if (this.#dids.has(did.id)) {
      throw new DidError(`DID '${did.id}' déjà enregistré`, 'E_DUPLICATE');
    }
    this.#dids.set(did.id, did);
    return this;
  }

  resolve(didId) {
    const did = this.#dids.get(didId);
    if (!did)          throw new DidError(`DID '${didId}' introuvable`, 'E_NOT_FOUND');
    if (did.revoked)   throw new DidError(`DID '${didId}' révoqué`, 'E_REVOKED');
    return did;
  }

  revoke(didId, reason) {
    const did = this.#dids.get(didId);
    if (!did) throw new DidError(`DID '${didId}' introuvable`, 'E_NOT_FOUND');
    did.revoke(reason);
  }

  list(includeRevoked = false) {
    return [...this.#dids.values()].filter(d => includeRevoked || !d.revoked);
  }

  size() { return this.#dids.size; }
}

// ─────────────────────────────────────────────────────────────────
// HELPERS INTERNES
// ─────────────────────────────────────────────────────────────────

function _nowSec() { return Math.floor(Date.now() / 1000); }

function _hex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ─────────────────────────────────────────────────────────────────
// DID DE TEST (valeur nulle, uniquement pour les tests unitaires)
// ─────────────────────────────────────────────────────────────────

export const TEST_DID = new Did(new Uint8Array(32));
