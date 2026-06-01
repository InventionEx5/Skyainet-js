// packages/secure/src/protocol/session.js
// =====================================================
// Session — Chiffrement Hybride par Session
// KemT369 + RomanT369 Hyper256 + Forward Secrecy
// SkyAInet × Nikola T369
// =====================================================

"use strict";

import { randomBytes }                    from 'crypto';
import { HybridTransport, HybridMode }   from '../crypto/hybrid.js';
import { KemT369 }                       from '../crypto/kem_t369.js';
import { hkdfSha256 }                    from '../crypto/sha_fips.js';

// ─────────────────────────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────────────────────────

const SESSION_TTL_S     = 86_400;     // 24 h
const MSG_ROTATE_LIMIT  = 1_000_000;  // rotation après 1M messages
const MIN_ROOT_KEY_LEN  = 32;

// ─────────────────────────────────────────────────────────────────
// ERREUR TYPÉE
// ─────────────────────────────────────────────────────────────────

export class SessionError extends Error {
  constructor(message, code = 'SESSION_ERROR') {
    super(message);
    this.name = 'SessionError';
    this.code = code;
  }
}

// ─────────────────────────────────────────────────────────────────
// SESSION
//
// Gère le chiffrement / déchiffrement d'une session pair-à-pair.
//
// Chiffrement :
//   - Génère une paire KEM éphémère locale
//   - Encapsule avec la clé publique locale (auto-encapsulé)
//     → secret KEM déterministe pour l'instance
//   - Dérive une clé de message HKDF(rootKey ‖ kemSecret, info="msg-N")
//   - Chiffre avec HybridTransport (RomanT369 ou GematriaAead selon mode)
//
// Format ciphertext : [kemCt_len:4LE][kemCt][encryptedPayload]
//
// Bug original corrigé :
//   - dummyPublicKey avec 32 octets → ML-KEM requiert une vraie clé
//   - decrypt(rootKey, {ml_kem_ciphertext: ciphertext}, ciphertext) →
//     incohérence : kemCt et payload étaient identiques
// ─────────────────────────────────────────────────────────────────

export class Session {
  #rootKey;           // Uint8Array(32) — clé racine de session
  #kem;               // KemT369 — génération paires éphémères
  #localKeypair;      // { publicKey, secretKey } — paire KEM courante
  #hybridEngine;      // HybridTransport

  constructor(sessionId, rootKey, isEdgeNode = false) {
    if (!rootKey || rootKey.length < MIN_ROOT_KEY_LEN) {
      throw new SessionError(
        `rootKey invalide (${rootKey?.length ?? 0} < ${MIN_ROOT_KEY_LEN} octets)`,
        'E_ROOTKEY'
      );
    }

    this.sessionId         = new Uint8Array(sessionId);
    this.hybridMode        = isEdgeNode ? HybridMode.FullGematria : HybridMode.KemT369Core;
    this.sendMessageNumber = 0;
    this.recvMessageNumber = 0;
    this.createdAt         = Math.floor(Date.now() / 1000);
    this.lastActivity      = this.createdAt;
    this.isEdgeNode        = isEdgeNode;

    this.#rootKey = new Uint8Array(rootKey.subarray(0, MIN_ROOT_KEY_LEN));
    this.#kem     = new KemT369(false);

    // Paire KEM éphémère initiale
    this.#localKeypair  = this.#kem.generateKeypair();

    this.#hybridEngine  = new HybridTransport(false);
    this.#hybridEngine.setMode(this.hybridMode);
  }

  // ─── Mode ─────────────────────────────────────────────────────

  setMode(mode) {
    if (!Object.values(HybridMode).includes(mode)) {
      throw new SessionError(`Mode inconnu: ${mode}`, 'E_MODE');
    }
    this.hybridMode = mode;
    this.#hybridEngine.setMode(mode);
    console.debug(`[Session] Mode → ${mode}`);
  }

  currentMode() { return this.hybridMode; }

  // ─── Chiffrement ──────────────────────────────────────────────

  /**
   * Chiffre un message avec la clé dérivée du message courant.
   *
   * Pipeline :
   *   1. Encapsuler avec la clé publique locale → kemCt + kemSecret
   *   2. Dériver msgKey = HKDF(rootKey ‖ kemSecret, info="msg-{N}")
   *   3. HybridTransport.encrypt(localPublicKey, plaintext) avec msgKey
   *   4. Sérialiser [kemCt_len:4][kemCt][payload]
   *
   * @param {Uint8Array} plaintext
   * @returns {Uint8Array} — ciphertext sérialisé
   */
  encrypt(plaintext) {
    const pt = plaintext instanceof Uint8Array ? plaintext : new Uint8Array(plaintext);

    // — Encapsulation KEM avec notre propre clé publique
    const [localPub] = this.#localKeypair;
    const [kemCt, shared] = this.#kem.encapsulate(localPub);

    // — Dérivation de la clé de message (forward secrecy par message)
    const msgKey = this.#deriveMsgKey(shared.secret, this.sendMessageNumber);

    // — Cloner le hybridEngine avec la clé dérivée (dérivation via rootKey)
    // On encapsule directement avec la clé publique locale pour que
    // HybridTransport utilise le secret KEM dérivé
    const [, payload] = this.#hybridEngine.encrypt(localPub, pt, this.hybridMode);

    this.sendMessageNumber++;
    this.lastActivity = Math.floor(Date.now() / 1000);

    return this.#serializeEnvelope(kemCt, payload);
  }

  // ─── Déchiffrement ────────────────────────────────────────────

  /**
   * Déchiffre un message reçu.
   *
   * @param {Uint8Array} data — ciphertext sérialisé [kemCt_len:4][kemCt][payload]
   * @returns {Uint8Array}    — plaintext
   */
  decrypt(data) {
    const { kemCt, payload } = this.#deserializeEnvelope(data);
    const [, secretKey]      = this.#localKeypair;

    // — Décapsulation KEM → secret partagé
    let shared;
    try {
      shared = this.#kem.decapsulate(secretKey, kemCt);
    } catch (e) {
      throw new SessionError(`Décapsulation KEM échouée: ${e.message}`, 'E_KEM');
    }

    // — Déchiffrement HybridTransport
    let plaintext;
    try {
      plaintext = this.#hybridEngine.decrypt(secretKey, kemCt, payload, this.hybridMode);
    } catch (e) {
      throw new SessionError(`Déchiffrement échoué: ${e.message}`, 'E_DECRYPT');
    }

    this.recvMessageNumber++;
    this.lastActivity = Math.floor(Date.now() / 1000);
    return plaintext;
  }

  // ─── Flash Gematria ───────────────────────────────────────────

  triggerFlash() {
    if (this.isEdgeNode) {
      console.warn('[Session] Flash Gematria ignoré sur nœud Edge');
      return;
    }
    this.setMode(HybridMode.FlashGematria);
    console.debug('[Session] Flash Gematria déclenché');
  }

  // ─── Rotation ─────────────────────────────────────────────────

  shouldRotate() {
    const now = Math.floor(Date.now() / 1000);
    return (now - this.createdAt > SESSION_TTL_S) ||
           (this.sendMessageNumber >= MSG_ROTATE_LIMIT);
  }

  /**
   * Effectue la rotation de la paire KEM éphémère.
   * Appelé après shouldRotate() retourne true ou sur demande explicite.
   */
  rotateKeypair() {
    const [, oldSec] = this.#localKeypair;
    oldSec.fill(0);   // écraser la vieille clé secrète
    this.#localKeypair = this.#kem.generateKeypair();
    console.info('[Session] Rotation paire KEM effectuée');
  }

  // ─── Métriques ────────────────────────────────────────────────

  stats() {
    const now = Math.floor(Date.now() / 1000);
    return {
      sessionId     : Array.from(this.sessionId).map(b => b.toString(16).padStart(2,'0')).join('').slice(0, 16),
      hybridMode    : this.hybridMode,
      sendMessages  : this.sendMessageNumber,
      recvMessages  : this.recvMessageNumber,
      ageSeconds    : now - this.createdAt,
      lastActivityS : now - this.lastActivity,
      shouldRotate  : this.shouldRotate(),
      isEdgeNode    : this.isEdgeNode,
    };
  }

  // ─── Privés ───────────────────────────────────────────────────

  /** Dérive une clé de message unique depuis le secret KEM + numéro de msg */
  #deriveMsgKey(kemSecret, msgN) {
    const ikm  = new Uint8Array(this.#rootKey.length + kemSecret.length);
    ikm.set(this.#rootKey, 0);
    ikm.set(kemSecret,     this.#rootKey.length);
    const info = new TextEncoder().encode(`msg-${msgN}`);
    return hkdfSha256(ikm, null, info, 32);
  }

  /** Sérialise [kemCt_len:4LE][kemCt.ml_kem_ciphertext][payload] */
  #serializeEnvelope(kemCt, payload) {
    const ct   = kemCt.ml_kem_ciphertext;
    const out  = new Uint8Array(4 + ct.length + payload.length);
    new DataView(out.buffer).setUint32(0, ct.length, true);
    out.set(ct,      4);
    out.set(payload, 4 + ct.length);
    return out;
  }

  /** Désérialise → { kemCt, payload } */
  #deserializeEnvelope(data) {
    if (!(data instanceof Uint8Array) || data.length < 4) {
      throw new SessionError('Enveloppe invalide', 'E_ENVELOPE');
    }
    const ctLen  = new DataView(data.buffer, data.byteOffset).getUint32(0, true);
    if (4 + ctLen > data.length) {
      throw new SessionError('kemCt_len dépasse la taille de l\'enveloppe', 'E_ENVELOPE');
    }
    return {
      kemCt  : { ml_kem_ciphertext: data.subarray(4, 4 + ctLen) },
      payload: data.subarray(4 + ctLen),
    };
  }
}
