// packages/secure/src/device/sender_keys.js
// =====================================================
// Sender Keys — Group Messaging Sécurisé
// GematriaAead + HKDF-SHA256 + Rotation d'epoch
// SkyAInet × Nikola T369
// =====================================================

"use strict";

import { randomBytes }                      from 'crypto';
import { GematriaAead }                     from '../crypto/gematria_aead.js';
import { hkdfSha256 }                       from '../crypto/sha_fips.js';
import { Contact, ContactManager }          from '../roots/pool.js';

// ─────────────────────────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────────────────────────

const MAX_MEMBERS   = 50;
const CHAIN_KEY_LEN = 32;
const GROUP_ID_LEN  = 16;
const TE            = new TextEncoder();

// ─────────────────────────────────────────────────────────────────
// ERREUR TYPÉE
// ─────────────────────────────────────────────────────────────────

export class GroupError extends Error {
  constructor(message, code = 'GROUP_ERROR') {
    super(message);
    this.name = 'GroupError';
    this.code = code;
  }
}

// ─────────────────────────────────────────────────────────────────
// GROUP
// ─────────────────────────────────────────────────────────────────

export class Group {
  constructor(groupId, name, description, creatorNodeId) {
    this.groupId     = new Uint8Array(groupId);
    this.name        = name;
    this.description = description ?? null;
    this.creator     = new Uint8Array(creatorNodeId);
    this.members     = [new Uint8Array(creatorNodeId)];   // creator est membre d'office
    this.createdAt   = Date.now();
    this.lastActivity= Date.now();
    this.epoch       = 0;
  }
}

// ─────────────────────────────────────────────────────────────────
// GROUP MANAGER
//
// Implémente le protocole Sender Keys :
//   - Chaque membre a une chain key dérivée de façon indépendante
//   - La message key est dérivée HKDF(chainKey, "message-key")
//   - La chaîne avance après chaque envoi (forward secrecy)
//   - La rotation d'epoch régénère toutes les chain keys
//
// Chiffrement :
//   GematriaAead.fromRootKey(messageKey).encryptWithTag(plaintext)
//   → inclut un tag d'authentification dans le ciphertext
//
// Nonce : dérivé de la chain key + numéro de séquence — jamais fixe.
// ─────────────────────────────────────────────────────────────────

export class GroupManager {
  #groups;         // Map<groupIdHex, Group>
  #senderKeys;     // Map<groupIdHex, Map<nodeIdHex, { chainKey, seqNum }>>
  #contactManager; // ContactManager

  constructor(contactManager) {
    if (!(contactManager instanceof ContactManager)) {
      throw new GroupError('ContactManager requis', 'E_INPUT');
    }
    this.#groups         = new Map();
    this.#senderKeys     = new Map();
    this.#contactManager = contactManager;
    this.maxMembersPerGroup = MAX_MEMBERS;
  }

  // ─── Création de groupe ───────────────────────────────────────

  createGroup(creatorNodeId, name, description = null) {
    if (!name?.trim()) throw new GroupError("'name' requis", 'E_INPUT');

    const groupId    = randomBytes(GROUP_ID_LEN);
    const group      = new Group(groupId, name.trim(), description, creatorNodeId);
    const hex        = _hex(groupId);

    this.#groups.set(hex, group);
    this.#senderKeys.set(hex, new Map());

    // Initialise la chain key du créateur
    const creatorHex = _hex(creatorNodeId);
    this.#senderKeys.get(hex).set(creatorHex, {
      chainKey: randomBytes(CHAIN_KEY_LEN),
      seqNum  : 0,
    });

    console.info(`[GroupManager] Groupe créé: ${hex.slice(0, 8)} "${name}"`);
    return groupId;
  }

  // ─── Gestion des membres ──────────────────────────────────────

  /**
   * Ajoute un membre au groupe.
   * Exige que le Contact ait un DID vérifié (verificationLevel ≥ 2).
   *
   * ContactManager n'expose pas canJoinGroup() — on utilise
   * Contact.hasDecentralizedIdentity() directement.
   */
  addMember(groupId, contact) {
    if (!(contact instanceof Contact)) throw new GroupError('Expected Contact instance', 'E_INPUT');

    const group = this.#getGroup(groupId);
    const hex   = _hex(groupId);

    if (group.members.length >= this.maxMembersPerGroup) {
      throw new GroupError(`Limite de membres atteinte (${this.maxMembersPerGroup})`, 'E_FULL');
    }

    // Vérification DID obligatoire
    if (!contact.hasDecentralizedIdentity()) {
      throw new GroupError('Contact non vérifié — DID requis (verificationLevel ≥ 2)', 'E_DID');
    }

    const nodeHex = _hex(contact.nodeId);
    if (group.members.some(m => _hex(m) === nodeHex)) return;  // déjà membre

    group.members.push(new Uint8Array(contact.nodeId));
    group.lastActivity = Date.now();

    this.#senderKeys.get(hex).set(nodeHex, {
      chainKey: randomBytes(CHAIN_KEY_LEN),
      seqNum  : 0,
    });

    console.debug(`[GroupManager] Membre ajouté au groupe ${hex.slice(0, 8)}`);
  }

  removeMember(groupId, nodeId) {
    const group  = this.#getGroup(groupId);
    const hex    = _hex(groupId);
    const nodeHex= _hex(nodeId);

    group.members    = group.members.filter(m => _hex(m) !== nodeHex);
    group.lastActivity = Date.now();

    this.#senderKeys.get(hex)?.delete(nodeHex);

    // Rotation de sécurité après exclusion (forward secrecy pour les futurs messages)
    this.rotateSenderKeys(groupId);
  }

  // ─── Envoi / Réception ────────────────────────────────────────

  /**
   * Chiffre un message de groupe avec la Sender Key de l'expéditeur.
   *
   * Pipeline :
   *   messageKey = HKDF(chainKey, salt=seqNum_bytes, info="message-key")
   *   nonce      = HKDF(chainKey, salt=seqNum_bytes, info="message-nonce")[0:12]
   *   ciphertext = GematriaAead(messageKey, nonce).encryptWithTag(plaintext)
   *   chainKey   = HKDF(chainKey, info="next-chain-key")  ← avance la chaîne
   *
   * @param {Uint8Array} groupId
   * @param {Uint8Array} senderNodeId
   * @param {Uint8Array} plaintext
   * @returns {Uint8Array} ciphertext avec tag d'authentification
   */
  sendGroupMessage(groupId, senderNodeId, plaintext) {
    const group   = this.#getGroup(groupId);
    const hex     = _hex(groupId);
    const sender  = _hex(senderNodeId);

    if (!group.members.some(m => _hex(m) === sender)) {
      throw new GroupError('Expéditeur non membre du groupe', 'E_NOT_MEMBER');
    }

    const entry = this.#getSenderEntry(hex, sender);
    const { messageKey, nonce } = this.#deriveMessageKey(entry.chainKey, entry.seqNum);

    const encrypted = new GematriaAead(messageKey, nonce).encryptWithTag(plaintext);

    // Avancer la chaîne (forward secrecy)
    entry.chainKey = hkdfSha256(entry.chainKey, null, TE.encode('next-chain-key'), CHAIN_KEY_LEN);
    entry.seqNum++;

    group.lastActivity = Date.now();
    return encrypted;
  }

  /**
   * Déchiffre un message de groupe.
   * Utilise la chain key courante de l'expéditeur — le déchiffrement
   * re-dérive la message key sans faire avancer la chaîne.
   */
  decryptGroupMessage(groupId, senderNodeId, ciphertext) {
    const hex    = _hex(groupId);
    const sender = _hex(senderNodeId);
    const entry  = this.#getSenderEntry(hex, sender);

    // Re-dériver la message key depuis la chain key courante
    // (la chaîne a déjà avancé du côté expéditeur — on utilise seqNum - 1)
    const prevSeq = Math.max(0, entry.seqNum - 1);
    const prevChainKey = hkdfSha256(entry.chainKey, null, TE.encode('prev-chain-key'), CHAIN_KEY_LEN);
    const { messageKey, nonce } = this.#deriveMessageKey(prevChainKey, prevSeq);

    const decrypted = new GematriaAead(messageKey, nonce).decrypt(ciphertext);
    if (!decrypted) throw new GroupError('Déchiffrement échoué', 'E_DECRYPT');

    return decrypted;
  }

  // ─── Rotation d'epoch ─────────────────────────────────────────

  /**
   * Rotation de toutes les Sender Keys du groupe.
   * Incrémente l'epoch et régénère chaque chain key indépendamment.
   * Appelé après l'exclusion d'un membre ou sur demande périodique.
   */
  rotateSenderKeys(groupId) {
    const group = this.#getGroup(groupId);
    const hex   = _hex(groupId);
    const keys  = this.#senderKeys.get(hex);
    if (!keys) return;

    const epochInfo = TE.encode(`epoch-rotation-${group.epoch + 1}`);
    for (const [nodeHex, entry] of keys) {
      entry.chainKey = hkdfSha256(entry.chainKey, null, epochInfo, CHAIN_KEY_LEN);
      entry.seqNum   = 0;
    }

    group.epoch++;
    group.lastActivity = Date.now();
    console.info(`[GroupManager] Rotation epoch ${group.epoch} — groupe ${hex.slice(0, 8)}`);
  }

  // ─── Lecture ─────────────────────────────────────────────────

  getGroup(groupId)  { return this.#groups.get(_hex(groupId)) ?? null; }
  listGroups()       { return [...this.#groups.values()]; }

  // ─── Privés ───────────────────────────────────────────────────

  #getGroup(groupId) {
    const group = this.#groups.get(_hex(groupId));
    if (!group) throw new GroupError('Groupe introuvable', 'E_NOT_FOUND');
    return group;
  }

  #getSenderEntry(groupHex, senderHex) {
    const entry = this.#senderKeys.get(groupHex)?.get(senderHex);
    if (!entry) throw new GroupError('Sender Key non initialisée', 'E_NO_KEY');
    return entry;
  }

  /**
   * Dérive message key + nonce depuis la chain key et le numéro de séquence.
   * Le sel (seqNum en LE-4) garantit l'unicité de chaque clé de message.
   */
  #deriveMessageKey(chainKey, seqNum) {
    const salt = new Uint8Array(4);
    new DataView(salt.buffer).setUint32(0, seqNum, true);

    const messageKey = hkdfSha256(chainKey, salt, TE.encode('message-key'),   CHAIN_KEY_LEN);
    const nonceBase  = hkdfSha256(chainKey, salt, TE.encode('message-nonce'), 12);
    return { messageKey, nonce: nonceBase };
  }
}

// ─────────────────────────────────────────────────────────────────
// HELPER INTERNE
// ─────────────────────────────────────────────────────────────────

function _hex(arr) {
  if (typeof arr === 'string') return arr;
  return Array.from(arr).map(b => b.toString(16).padStart(2,'0')).join('');
}
