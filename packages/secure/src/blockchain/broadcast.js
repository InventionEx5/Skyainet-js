// packages/secure/src/blockchain/broadcast.js
// =====================================================
// BroadcastSession — Group Messaging Sécurisé
// Double Ratchet + Sender Keys + Rotation par Epoch
// SkyAInet × Nikola T369
// =====================================================

"use strict";

import { randomBytes }    from 'crypto';
import { DoubleRatchet }  from '../crypto/double_ratchet.js';
import { hkdfSha256 }     from '../crypto/sha_fips.js';

// ─────────────────────────────────────────────────────────────────
// ERREUR TYPÉE
// ─────────────────────────────────────────────────────────────────

export class BroadcastError extends Error {
  constructor(message, code = 'BROADCAST_ERROR') {
    super(message);
    this.name = 'BroadcastError';
    this.code = code;
  }
}

// ─────────────────────────────────────────────────────────────────
// STATUTS DE SESSION
// ─────────────────────────────────────────────────────────────────

export const SessionStatus = Object.freeze({
  Active      : 'Active',
  RotatingKeys: 'RotatingKeys',
  Closed      : 'Closed',
});

// ─────────────────────────────────────────────────────────────────
// BROADCAST SESSION
//
// Chaque participant a un Double Ratchet indépendant (Sender Key).
// Cela garantit la forward secrecy par participant : si une clé
// d'un membre est compromise, les autres sessions restent sûres.
//
// Rotation des Sender Keys (rotateSenderKeys) :
//   Un nouveau rootKey est dérivé HKDF depuis l'ancien rootKey
//   et un sel aléatoire — remplace le DoubleRatchet de chaque
//   membre plutôt qu'appeler ratchet() (qui requiert un échange
//   de clé publique X25519 interactif non disponible en broadcast).
//
// Rotation d'epoch :
//   shouldRotate(globalEpoch) → true → rotateSenderKeys() → epoch++
// ─────────────────────────────────────────────────────────────────

export class BroadcastSession {
  // Map<nodeIdHex, DoubleRatchet>
  #senderKeys;
  // Map<nodeIdHex, Uint8Array(32)> — rootKeys courants (pour re-dérivation)
  #rootKeys;

  /**
   * @param {Uint8Array}    sessionId     — identifiant de session (16 octets)
   * @param {Uint8Array[]}  participants  — liste de nodeIds (32 octets chacun)
   */
  constructor(sessionId, participants = []) {
    if (!(sessionId instanceof Uint8Array) || sessionId.length !== 16) {
      throw new BroadcastError('sessionId must be Uint8Array(16)', 'E_INPUT');
    }

    this.sessionId      = new Uint8Array(sessionId);
    this.participants   = participants.map(p => new Uint8Array(p));
    this.epoch          = 0;
    this.status         = SessionStatus.Active;
    this.createdAt      = Date.now();
    this.lastRotation   = Date.now();
    this.messageCount   = 0;
    this.maxParticipants= 128;

    this.#senderKeys = new Map();
    this.#rootKeys   = new Map();
  }

  // ─── Gestion des participants ─────────────────────────────────

  /**
   * Ajoute un participant et initialise son Double Ratchet.
   * @param {Uint8Array} nodeId
   * @param {Uint8Array} initialChainKey — rootKey de 32 octets pour ce membre
   */
  addParticipant(nodeId, initialChainKey) {
    if (this.status !== SessionStatus.Active) {
      throw new BroadcastError('Session fermée — ajout impossible', 'E_STATE');
    }
    if (this.participants.length >= this.maxParticipants) {
      throw new BroadcastError(`Limite de participants atteinte (${this.maxParticipants})`, 'E_FULL');
    }

    const hex = _toHex(nodeId);
    if (this.#senderKeys.has(hex)) return;  // déjà présent — idempotent

    const rootKey = new Uint8Array(initialChainKey).subarray(0, 32);
    this.#rootKeys.set(hex, new Uint8Array(rootKey));
    this.#senderKeys.set(hex, new DoubleRatchet(rootKey));
    this.participants.push(new Uint8Array(nodeId));

    console.info(`[BroadcastSession] Participant ajouté : ${hex.slice(0, 16)}`);
  }

  removeParticipant(nodeId) {
    if (this.status !== SessionStatus.Active) {
      throw new BroadcastError('Session fermée', 'E_STATE');
    }
    const hex = _toHex(nodeId);
    this.participants = this.participants.filter(p => _toHex(p) !== hex);
    this.#senderKeys.delete(hex);
    this.#rootKeys.delete(hex);
    console.debug(`[BroadcastSession] Participant retiré : ${hex.slice(0, 16)}`);
  }

  // ─── Rotation des Sender Keys ─────────────────────────────────

  /**
   * Rotation des Sender Keys à chaque changement d'epoch.
   *
   * Pour chaque membre, dérive un nouveau rootKey :
   *   newRoot = HKDF(oldRoot, salt=epochSalt, info="broadcast-epoch-<N>")
   * Puis crée un nouveau DoubleRatchet avec ce rootKey.
   *
   * Le sel est commun à tous les membres de la session pour garantir
   * la cohérence, mais dérivé de façon aléatoire à chaque rotation
   * pour que deux rotations successives soient indépendantes.
   */
  rotateSenderKeys() {
    if (this.status !== SessionStatus.Active) {
      throw new BroadcastError('Session fermée', 'E_STATE');
    }

    this.status = SessionStatus.RotatingKeys;

    // Sel commun à tous les membres pour cette rotation
    const epochSalt = randomBytes(32);
    const info      = new TextEncoder().encode(`broadcast-epoch-${this.epoch + 1}`);

    for (const [hex, oldRoot] of this.#rootKeys) {
      const newRoot = hkdfSha256(oldRoot, epochSalt, info, 32);
      this.#rootKeys.set(hex, newRoot);
      this.#senderKeys.set(hex, new DoubleRatchet(newRoot));
      console.debug(`[BroadcastSession] Sender Key renouvelée : ${hex.slice(0, 16)}`);
    }

    this.epoch++;
    this.lastRotation = Date.now();
    this.status       = SessionStatus.Active;

    console.info(`[BroadcastSession] Rotation terminée → epoch ${this.epoch}`);
  }

  // ─── Chiffrement / Déchiffrement ─────────────────────────────

  /**
   * Chiffre un message avec le Double Ratchet de l'expéditeur.
   * @param {Uint8Array|string} senderId
   * @param {Uint8Array|string} plaintext
   * @returns {Uint8Array}
   */
  broadcastMessage(senderId, plaintext) {
    if (this.status !== SessionStatus.Active) {
      throw new BroadcastError('Session fermée', 'E_STATE');
    }

    const ratchet = this.#getRatchet(senderId);
    const encrypted = ratchet.encrypt(plaintext);
    this.messageCount++;

    console.debug(
      `[BroadcastSession] Message chiffré (${encrypted.length} octets)` +
      ` par ${_toHex(senderId).slice(0, 16)}`
    );

    return encrypted;
  }

  /**
   * Déchiffre un message reçu de l'expéditeur.
   * @param {Uint8Array|string} senderId
   * @param {Uint8Array}        ciphertext
   * @returns {Uint8Array}
   */
  decryptMessage(senderId, ciphertext) {
    const ratchet   = this.#getRatchet(senderId);
    const decrypted = ratchet.decrypt(ciphertext);
    if (!decrypted) throw new BroadcastError('Déchiffrement échoué', 'E_DECRYPT');
    return decrypted;
  }

  // ─── Cycle de vie ─────────────────────────────────────────────

  /** true si l'epoch global est en avance sur l'epoch local. */
  shouldRotate(globalEpoch) {
    return globalEpoch > this.epoch;
  }

  close() {
    this.status = SessionStatus.Closed;
    // Écraser les rootKeys en mémoire
    for (const key of this.#rootKeys.values()) key.fill(0);
    this.#rootKeys.clear();
    this.#senderKeys.clear();
    console.info(`[BroadcastSession] Session fermée : ${_toHex(this.sessionId).slice(0, 16)}`);
  }

  isActive() { return this.status === SessionStatus.Active; }

  // ─── Statistiques ─────────────────────────────────────────────

  stats() {
    return {
      sessionId    : _toHex(this.sessionId).slice(0, 16),
      epoch        : this.epoch,
      status       : this.status,
      participants : this.participants.length,
      messageCount : this.messageCount,
      lastRotation : this.lastRotation,
      createdAt    : this.createdAt,
    };
  }

  // ─── Privés ───────────────────────────────────────────────────

  #getRatchet(nodeId) {
    const hex     = _toHex(nodeId);
    const ratchet = this.#senderKeys.get(hex);
    if (!ratchet) throw new BroadcastError(`Participant introuvable : ${hex.slice(0, 16)}`, 'E_NOT_FOUND');
    return ratchet;
  }
}

export default BroadcastSession;

// ─────────────────────────────────────────────────────────────────
// HELPER INTERNE
// ─────────────────────────────────────────────────────────────────

function _toHex(arr) {
  if (typeof arr === 'string') return arr.toLowerCase();
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}
