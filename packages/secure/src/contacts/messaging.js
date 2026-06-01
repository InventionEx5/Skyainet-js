// packages/secure/src/messaging.js
// =====================================================
// Messaging — Secure Messaging + ZipMemory Storage
// KemT369 + Messages Éphémères + Burn After Read
// SkyAInet × Nikola T369
// =====================================================

"use strict";

import { randomUUID }                from 'crypto';
import { KemT369 }                  from './crypto/kem_t369.js';
import { GematriaAead }             from './crypto/gematria_aead.js';
import { hkdfSha256 }               from './crypto/sha_fips.js';
import { ContactManager, Contact }  from './roots/pool.js';
import { ZipMemory }                from '../../memory/src/zip_memory.js';

// ─────────────────────────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────────────────────────

const TE = new TextEncoder();
const TD = new TextDecoder();

// ─────────────────────────────────────────────────────────────────
// ERREUR TYPÉE
// ─────────────────────────────────────────────────────────────────

export class MessagingError extends Error {
  constructor(message, code = 'MSG_ERROR') {
    super(message);
    this.name = 'MessagingError';
    this.code = code;
  }
}

// ─────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────

export const MessageType = Object.freeze({
  Text    : 'Text',
  File    : 'File',
  Reaction: 'Reaction',
  System  : 'System',
});

// ─────────────────────────────────────────────────────────────────
// MESSAGE
// ─────────────────────────────────────────────────────────────────

export class Message {
  constructor({
    id, senderId, recipientId, content,
    messageType = MessageType.Text,
    isEphemeral = false, expiresAt = null, burnAfterRead = false,
  }) {
    this.id            = id;
    this.senderId      = new Uint8Array(senderId);
    this.recipientId   = new Uint8Array(recipientId);
    this.content       = content instanceof Uint8Array ? content : new Uint8Array(content);
    this.messageType   = messageType;
    this.timestamp     = Date.now();
    this.isEphemeral   = isEphemeral;
    this.expiresAt     = expiresAt;     // timestamp ms | null
    this.isRead        = false;
    this.burnAfterRead = burnAfterRead;
    this.version       = 1;
  }

  isExpired() {
    return this.isEphemeral && this.expiresAt != null && Date.now() > this.expiresAt;
  }
}

// ─────────────────────────────────────────────────────────────────
// CONVERSATION
// ─────────────────────────────────────────────────────────────────

export class Conversation {
  constructor(id, participants, isGroup = false) {
    this.id           = id;
    this.participants = participants.map(p => new Uint8Array(p));
    this.lastActivity = Date.now();
    this.isGroup      = isGroup;
    this.messageCount = 0;
  }
}

// ─────────────────────────────────────────────────────────────────
// MESSAGING MANAGER
//
// Chiffrement :
//   1. Génère une paire KEM éphémère locale
//   2. Encapsule → sharedSecret
//   3. Dérive la clé de message HKDF(sharedSecret, info="msg-key")
//   4. Chiffre le plaintext avec GematriaAead(msgKey, nonce)
//   5. Sérialise [kemCt_len:4LE][kemCt][nonce:12][ciphertext]
//
// Stockage : ZipMemory.store(key, bytes) — seules méthodes disponibles.
// Index des clés par conversation : Map<convId, string[]> en mémoire.
//
// Bugs originaux corrigés :
//   - KemT369.encapsulate() requiert une publicKey → auto-encapsulation
//     avec la clé locale générée à la construction
//   - ZipMemory.compressAndStore/decompress/listKeysStartingWith/delete
//     n'existent pas → store/retrieve + index en mémoire
// ─────────────────────────────────────────────────────────────────

export class MessagingManager {
  #kem;              // KemT369
  #localKeypair;     // { publicKey, secretKey } — paire KEM locale
  #convIndex;        // Map<convId, string[]> — index des clés de messages
  #conversations;    // Map<convId, Conversation>

  constructor(contactManager, zipMemory) {
    if (!(contactManager instanceof ContactManager)) {
      throw new MessagingError('ContactManager requis', 'E_INPUT');
    }

    this.contactManager  = contactManager;
    this.zipMemory       = zipMemory instanceof ZipMemory ? zipMemory : new ZipMemory('./data/messaging');
    this.#kem            = new KemT369(false);
    this.#localKeypair   = this.#kem.generateKeypair();
    this.#convIndex      = new Map();
    this.#conversations  = new Map();
  }

  // ─── Envoi ────────────────────────────────────────────────────

  /**
   * Chiffre et stocke un message.
   *
   * @param {Uint8Array} senderId
   * @param {Uint8Array} recipientId
   * @param {Uint8Array|string} plaintext
   * @param {object} [opts]
   * @param {boolean} opts.isEphemeral
   * @param {boolean} opts.burnAfterRead
   * @param {number}  opts.expireMinutes — null = pas d'expiration
   * @returns {string} messageId
   */
  async sendMessage(senderId, recipientId, plaintext, opts = {}) {
    const { isEphemeral = false, burnAfterRead = false, expireMinutes = null } = opts;

    // — Vérification du contact destinataire
    const contact = this.contactManager.get(recipientId);
    if (!contact || contact.verificationLevel < 1) {
      throw new MessagingError('Contact non vérifié (niveau ≥ 1 requis)', 'E_UNVERIFIED');
    }

    // — Chiffrement KemT369 + GematriaAead
    const pt        = typeof plaintext === 'string' ? TE.encode(plaintext) : plaintext;
    const encrypted = this.#encryptPayload(pt);

    // — Construction du message
    const messageId = randomUUID();
    const expiresAt = expireMinutes ? Date.now() + expireMinutes * 60_000 : null;

    const msg = new Message({
      id: messageId, senderId, recipientId,
      content: encrypted, messageType: MessageType.Text,
      isEphemeral, expiresAt, burnAfterRead,
    });

    // — Sérialisation + stockage ZipMemory
    const key        = `msg:${this.#convId(senderId, recipientId)}:${messageId}`;
    const serialized = TE.encode(JSON.stringify(this.#serializeMsg(msg)));
    await this.zipMemory.store(key, serialized);

    // — Mise à jour de l'index + conversation
    const convId = this.#convId(senderId, recipientId);
    if (!this.#convIndex.has(convId)) this.#convIndex.set(convId, []);
    this.#convIndex.get(convId).push(key);

    if (!this.#conversations.has(convId)) {
      this.#conversations.set(convId, new Conversation(convId, [senderId, recipientId]));
    }
    const conv = this.#conversations.get(convId);
    conv.lastActivity = Date.now();
    conv.messageCount++;

    console.info('[Messaging] Message envoyé et stocké');
    return messageId;
  }

  // ─── Lecture ──────────────────────────────────────────────────

  /**
   * Récupère les messages d'une conversation depuis ZipMemory.
   * Filtre les messages éphémères expirés.
   * Trie par timestamp croissant.
   */
  async getMessages(convId) {
    const keys    = this.#convIndex.get(convId) ?? [];
    const results = [];

    for (const key of keys) {
      try {
        const raw    = await this.zipMemory.retrieve(key);
        if (!raw) continue;
        const parsed = JSON.parse(TD.decode(raw));
        const msg    = this.#deserializeMsg(parsed);

        if (msg.isExpired()) continue;   // éphémère expiré → silencieux
        results.push(msg);
      } catch { /* entrée corrompue — on saute */ }
    }

    results.sort((a, b) => a.timestamp - b.timestamp);
    return results;
  }

  // ─── Marquer comme lu / Burn after read ───────────────────────

  async markAsRead(convId, messageId) {
    const key = `msg:${convId}:${messageId}`;

    const raw = await this.zipMemory.retrieve(key);
    if (!raw) return;

    try {
      const parsed    = JSON.parse(TD.decode(raw));
      parsed.isRead   = true;

      if (parsed.burnAfterRead) {
        // ZipMemory n'a pas delete — on écrase avec un marqueur vide
        await this.zipMemory.store(key, TE.encode('{"burned":true}'));
        // Retirer de l'index
        const idx = this.#convIndex.get(convId);
        if (idx) {
          const i = idx.indexOf(key);
          if (i !== -1) idx.splice(i, 1);
        }
        console.debug('[Messaging] Message brûlé après lecture');
      } else {
        await this.zipMemory.store(key, TE.encode(JSON.stringify(parsed)));
      }
    } catch { /* entrée corrompue */ }
  }

  // ─── Nettoyage ────────────────────────────────────────────────

  async cleanupExpiredMessages() {
    for (const [convId, keys] of this.#convIndex) {
      const alive = [];
      for (const key of keys) {
        const raw = await this.zipMemory.retrieve(key).catch(() => null);
        if (!raw) continue;
        try {
          const parsed = JSON.parse(TD.decode(raw));
          const msg    = this.#deserializeMsg(parsed);
          if (!msg.isExpired()) alive.push(key);
          else await this.zipMemory.store(key, TE.encode('{"expired":true}'));
        } catch { alive.push(key); }
      }
      this.#convIndex.set(convId, alive);
    }
    console.debug('[Messaging] Nettoyage éphémères terminé');
  }

  // ─── Privés ───────────────────────────────────────────────────

  /**
   * Chiffre un plaintext avec KemT369 (auto-encapsulation) + GematriaAead.
   * Format : [kemCt_len:4LE][kemCt][nonce:12][ciphertext]
   */
  #encryptPayload(pt) {
    const [localPub]      = this.#localKeypair;
    const [kemCt, shared] = this.#kem.encapsulate(localPub);

    // Dériver clé + nonce depuis le secret KEM
    const msgKey  = hkdfSha256(shared.secret, null, TE.encode('msg-key'),   32);
    const nonce   = hkdfSha256(shared.secret, null, TE.encode('msg-nonce'), 12);

    const ct      = new GematriaAead(msgKey, nonce).encrypt(pt);
    const kemBytes= kemCt.ml_kem_ciphertext;

    const out = new Uint8Array(4 + kemBytes.length + 12 + ct.length);
    new DataView(out.buffer).setUint32(0, kemBytes.length, true);
    out.set(kemBytes, 4);
    out.set(nonce,    4 + kemBytes.length);
    out.set(ct,       4 + kemBytes.length + 12);
    return out;
  }

  #serializeMsg(msg) {
    return {
      id           : msg.id,
      senderId     : Array.from(msg.senderId),
      recipientId  : Array.from(msg.recipientId),
      content      : Array.from(msg.content),
      messageType  : msg.messageType,
      timestamp    : msg.timestamp,
      isEphemeral  : msg.isEphemeral,
      expiresAt    : msg.expiresAt,
      isRead       : msg.isRead,
      burnAfterRead: msg.burnAfterRead,
      version      : msg.version,
    };
  }

  #deserializeMsg(p) {
    const msg = new Message({
      id           : p.id,
      senderId     : new Uint8Array(p.senderId),
      recipientId  : new Uint8Array(p.recipientId),
      content      : new Uint8Array(p.content),
      messageType  : p.messageType,
      isEphemeral  : p.isEphemeral,
      expiresAt    : p.expiresAt ?? null,
      burnAfterRead: p.burnAfterRead,
    });
    msg.timestamp = p.timestamp;
    msg.isRead    = p.isRead ?? false;
    msg.version   = p.version ?? 1;
    return msg;
  }

  /** ID de conversation déterministe et symétrique */
  #convId(a, b) {
    const ha = _hex(a).slice(0, 8);
    const hb = _hex(b).slice(0, 8);
    return ha < hb ? `conv_${ha}${hb}` : `conv_${hb}${ha}`;
  }
}

// ─────────────────────────────────────────────────────────────────
// HELPER INTERNE
// ─────────────────────────────────────────────────────────────────

function _hex(arr) {
  if (typeof arr === 'string') return arr;
  return Array.from(arr).map(b => b.toString(16).padStart(2,'0')).join('');
}
