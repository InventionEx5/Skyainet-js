// packages/secure/src/blockchain/broadcast.js
// =====================================================
// BroadcastSession v6.0 — Group Messaging Sécurisé + Sender Keys Rotation
// SkyAInet × Nikola T369 — Intégration Epoch + Double Ratchet + Gematria
// Version Ultra Améliorée (Production Ready)
// =====================================================

import { DoubleRatchet } from '../crypto/double_ratchet.js';

export class BroadcastError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BroadcastError';
  }
}

export const SessionStatus = Object.freeze({
  Active: 'Active',
  RotatingKeys: 'RotatingKeys',
  Closed: 'Closed',
});

export class BroadcastSession {
  constructor(sessionId, participants = []) {
    this.sessionId = new Uint8Array(sessionId);           // [u8; 16]
    this.participants = participants.map(p => new Uint8Array(p)); // [u8; 32][]
    this.senderKeys = new Map();                          // nodeIdHex → DoubleRatchet
    this.epoch = 0;
    this.status = SessionStatus.Active;
    this.createdAt = new Date();
    this.lastRotation = new Date();
    this.messageCount = 0;
    this.maxParticipants = 128; // Limite de sécurité
  }

  /**
   * Ajoute un participant avec sa propre Double Ratchet
   */
  addParticipant(nodeId, initialChainKey) {
    if (this.status !== SessionStatus.Active) {
      throw new BroadcastError('Session is closed');
    }

    if (this.participants.length >= this.maxParticipants) {
      throw new BroadcastError('Invalid session state');
    }

    const nodeIdHex = this.#toHex(nodeId);
    if (this.participants.some(p => this.#toHex(p) === nodeIdHex)) {
      return; // déjà présent
    }

    const ratchet = new DoubleRatchet(new Uint8Array(initialChainKey));
    this.senderKeys.set(nodeIdHex, ratchet);
    this.participants.push(new Uint8Array(nodeId));

    console.info(`[BroadcastSession] Participant ajouté : ${nodeIdHex.slice(0, 16)}`);
  }

  /**
   * Supprime un participant
   */
  removeParticipant(nodeId) {
    if (this.status !== SessionStatus.Active) {
      throw new BroadcastError('Session is closed');
    }

    const nodeIdHex = this.#toHex(nodeId);
    this.participants = this.participants.filter(p => this.#toHex(p) !== nodeIdHex);
    this.senderKeys.delete(nodeIdHex);

    console.debug(`[BroadcastSession] Participant retiré : ${nodeIdHex.slice(0, 16)}`);
  }

  /**
   * Rotation des Sender Keys (appelée à chaque changement d'epoch)
   */
  rotateSenderKeys() {
    if (this.status !== SessionStatus.Active) {
      throw new BroadcastError('Session is closed');
    }

    this.status = SessionStatus.RotatingKeys;

    for (const [nodeIdHex, ratchet] of this.senderKeys) {
      ratchet.rotateKeys();
      console.debug(`[BroadcastSession] Rotation des clés pour ${nodeIdHex.slice(0, 16)}`);
    }

    this.epoch += 1;
    this.lastRotation = new Date();
    this.status = SessionStatus.Active;

    console.info(`[BroadcastSession] Rotation des Sender Keys terminée → Nouvel epoch: ${this.epoch}`);
  }

  /**
   * Chiffre et diffuse un message à tous les participants
   */
  broadcastMessage(senderId, plaintext) {
    if (this.status !== SessionStatus.Active) {
      throw new BroadcastError('Session is closed');
    }

    const senderHex = this.#toHex(senderId);
    const ratchet = this.senderKeys.get(senderHex);
    if (!ratchet) {
      throw new BroadcastError('Participant not found');
    }

    const encrypted = ratchet.encrypt(plaintext);
    this.messageCount += 1;

    console.debug(
      `[BroadcastSession] Message diffusé (${encrypted.length} octets) par ${senderHex.slice(0, 16)}`
    );

    return encrypted;
  }

  /**
   * Déchiffre un message reçu
   */
  decryptMessage(senderId, ciphertext) {
    const senderHex = this.#toHex(senderId);
    const ratchet = this.senderKeys.get(senderHex);
    if (!ratchet) {
      throw new BroadcastError('Participant not found');
    }

    const decrypted = ratchet.decrypt(ciphertext);
    if (!decrypted) {
      throw new BroadcastError('Decryption failed');
    }
    return decrypted;
  }

  /**
   * Vérifie si la session doit faire une rotation
   */
  shouldRotate(currentGlobalEpoch) {
    return currentGlobalEpoch > this.epoch;
  }

  /**
   * Ferme la session
   */
  close() {
    this.status = SessionStatus.Closed;
    console.info(`[BroadcastSession] Session fermée : ${this.#toHex(this.sessionId).slice(0, 16)}`);
  }

  isActive() {
    return this.status === SessionStatus.Active;
  }

  // ==================== HELPERS ====================

  #toHex(arr) {
    if (typeof arr === 'string') return arr;
    return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
  }
}

export default BroadcastSession;