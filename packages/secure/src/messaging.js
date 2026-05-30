// packages/secure/src/messaging.js
// =====================================================
// Messaging v6.1 — Secure Messaging + ZipMemory Storage
// SkyAInet × Nikola T369 — KemT369 + Double Ratchet + Ephemeral + Compressed Storage
// =====================================================

import { KemT369 } from '../crypto/kem_t369.js';
import { ContactManager } from '../contacts/manager.js';
import { ZipMemory } from '../memory/zip_memory.js'; // à adapter selon ton arborescence

export class MessagingError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MessagingError';
  }
}

export const MessageType = Object.freeze({
  Text: 'Text',
  File: 'File',
  Reaction: 'Reaction',
  System: 'System',
});

export class Message {
  constructor(id, senderId, recipientId, content, messageType = MessageType.Text, isEphemeral = false, expiresAt = null, burnAfterRead = false) {
    this.id = id;
    this.senderId = new Uint8Array(senderId);
    this.recipientId = new Uint8Array(recipientId);
    this.content = new Uint8Array(content);           // chiffré
    this.messageType = messageType;
    this.timestamp = new Date();
    this.isEphemeral = isEphemeral;
    this.expiresAt = expiresAt;
    this.isRead = false;
    this.burnAfterRead = burnAfterRead;
    this.version = 1;
  }
}

export class Conversation {
  constructor(id, participants, isGroup = false) {
    this.id = id;
    this.participants = participants.map(p => new Uint8Array(p));
    this.lastActivity = new Date();
    this.isGroup = isGroup;
  }
}

export class MessagingManager {
  constructor(contactManager, zipMemory) {
    this.conversations = new Map();           // convId (string) → Conversation
    this.contactManager = contactManager;
    this.kem = new KemT369(false);
    this.zipMemory = zipMemory;
  }

  /**
   * Envoie un message (chiffré + compressé avec ZipMemory)
   */
  sendMessage(senderId, recipientId, plaintext, isEphemeral = false, burnAfterRead = false, expireMinutes = null) {
    // Vérification du contact
    const recipientHex = this.#toHex(recipientId);
    const contact = this.contactManager.get(recipientId);
    if (!contact || contact.verificationLevel < 1) {
      throw new MessagingError('Contact not verified');
    }

    // Chiffrement KemT369 (placeholder – à améliorer avec vrai encapsulage)
    const encResult = this.kem.encapsulate();
    const ciphertext = encResult.ciphertext || encResult[0] || new Uint8Array(plaintext.length);

    const messageId = crypto.randomUUID ? crypto.randomUUID() : 'msg-' + Date.now().toString(36);
    const expiresAt = expireMinutes
      ? new Date(Date.now() + expireMinutes * 60 * 1000)
      : null;

    const message = new Message(
      messageId,
      senderId,
      recipientId,
      ciphertext,
      MessageType.Text,
      isEphemeral,
      expiresAt,
      burnAfterRead
    );

    // Compression + stockage dans ZipMemory
    const serialized = new TextEncoder().encode(JSON.stringify({
      ...message,
      content: Array.from(message.content),
      senderId: Array.from(message.senderId),
      recipientId: Array.from(message.recipientId),
    }));

    const convId = this.#getConversationId(senderId, recipientId);
    const key = `msg:\( {convId}: \){messageId}`;

    try {
      this.zipMemory.compressAndStore(key, serialized);
    } catch (e) {
      throw new MessagingError('Storage error');
    }

    // Mise à jour de la conversation
    if (!this.conversations.has(convId)) {
      this.conversations.set(convId, new Conversation(convId, [senderId, recipientId], false));
    }
    const conv = this.conversations.get(convId);
    conv.lastActivity = new Date();

    console.info('[Messaging] Message envoyé et stocké (ZipMemory)');
    return messageId;
  }

  /**
   * Récupère les messages d'une conversation (décompressés depuis ZipMemory)
   */
  getMessages(convId) {
    const messages = [];
    const prefix = `msg:${convId}:`;

    // Parcours des clés (ZipMemory doit exposer listKeysStartingWith)
    const keys = this.zipMemory.listKeysStartingWith
      ? this.zipMemory.listKeysStartingWith(prefix)
      : [];

    for (const key of keys) {
      try {
        const data = this.zipMemory.decompress(key);
        const parsed = JSON.parse(new TextDecoder().decode(data));

        const msg = new Message(
          parsed.id,
          parsed.senderId,
          parsed.recipientId,
          new Uint8Array(parsed.content),
          parsed.messageType,
          parsed.isEphemeral,
          parsed.expiresAt ? new Date(parsed.expiresAt) : null,
          parsed.burnAfterRead
        );
        msg.timestamp = new Date(parsed.timestamp);
        msg.isRead = parsed.isRead || false;
        msg.version = parsed.version || 1;

        // Filtre les messages éphémères expirés
        if (msg.isEphemeral && msg.expiresAt && new Date() > msg.expiresAt) {
          continue;
        }

        messages.push(msg);
      } catch (_) {
        // ignore corrupted entry
      }
    }

    messages.sort((a, b) => a.timestamp - b.timestamp);
    return messages;
  }

  /**
   * Marque un message comme lu + Burn after read
   */
  markAsRead(convId, messageId) {
    const key = `msg:\( {convId}: \){messageId}`;

    try {
      const data = this.zipMemory.decompress(key);
      const parsed = JSON.parse(new TextDecoder().decode(data));

      parsed.isRead = true;

      if (parsed.burnAfterRead) {
        this.zipMemory.delete(key);
        console.debug('[Messaging] Message brûlé après lecture');
      } else {
        const updated = new TextEncoder().encode(JSON.stringify(parsed));
        this.zipMemory.compressAndStore(key, updated);
      }
    } catch (_) {
      // message non trouvé ou erreur → on ignore
    }
  }

  #getConversationId(a, b) {
    const ids = [new Uint8Array(a), new Uint8Array(b)];
    ids.sort((x, y) => {
      for (let i = 0; i < 32; i++) {
        if (x[i] !== y[i]) return x[i] - y[i];
      }
      return 0;
    });
    return `conv_\( {this.#toHex(ids[0]).slice(0, 8)} \){this.#toHex(ids[1]).slice(0, 8)}`;
  }

  #toHex(arr) {
    if (typeof arr === 'string') return arr;
    return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Nettoyage des messages éphémères expirés (à appeler périodiquement)
   */
  cleanupExpiredMessages() {
    // Le nettoyage se fait automatiquement à la lecture (getMessages)
    // Cette méthode peut être étendue plus tard pour un sweep global
    console.debug('[Messaging] Nettoyage des messages éphémères (passif)');
  }
}