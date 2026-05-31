// packages/node/src/node_communication.js
// NodeCommunication — Réseau de Nœuds Vivant & Sécurisé
// HybridTransport + GematriaAead + GossipSub + Lesson Propagation

import { HybridTransport } from '../../secure/src/crypto/hybrid.js';
import { ContributionProof } from './pouw.js';

export class NodeMessage {
  constructor(from, to = null, messageType, payload, signature = null) {
    this.from = from;
    this.to = to;
    this.messageType = messageType;
    this.payload = payload;
    this.timestamp = Date.now();
    this.signature = signature;
  }
}

export class CommunicationStats {
  constructor() {
    this.messagesSent = 0;
    this.messagesReceived = 0;
    this.lessonsPropagated = 0;
    this.failedBroadcasts = 0;
    this.lastSuccessfulSync = null;
  }
}

export class NodeCommunication {
  #peerId;
  #hybridTransport;
  #lastBroadcast = null;
  #receivedLessons = [];
  #stats = new CommunicationStats();

  constructor(peerId, hybridTransport = null) {
    if (!peerId) throw new Error('peerId requis');
    this.#peerId = peerId;
    this.#hybridTransport = hybridTransport || new HybridTransport(true);
  }

  // =====================================================
  // BROADCAST DE LEÇON
  // =====================================================
  async broadcastLesson(lesson, qualityThreshold = 0.7) {
    if (!lesson || lesson.score < qualityThreshold) return;

    const lessonData = Buffer.from(JSON.stringify(lesson));

    // Chiffrement hybride (KemT369 + GematriaAead)
    let encrypted;
    try {
      encrypted = await this.#hybridTransport.encrypt(lessonData);
    } catch (e) {
      this.#stats.failedBroadcasts++;
      throw new Error(`Encryption failed: ${e.message}`);
    }

    const topic = 'skyainet/lessons/v2';

    try {
      await this.#hybridTransport.publish(topic, encrypted);
      this.#stats.messagesSent++;
      this.#stats.lessonsPropagated++;
      this.#lastBroadcast = Date.now();
    } catch (e) {
      this.#stats.failedBroadcasts++;
      throw new Error(`GossipSub publish failed: ${e.message}`);
    }
  }

  // =====================================================
  // RÉCEPTION DE LEÇON
  // =====================================================
  async receiveRemoteLesson(encryptedData) {
    if (!encryptedData || encryptedData.length === 0) {
      throw new Error('Données chiffrées vides');
    }

    let decrypted;
    try {
      decrypted = await this.#hybridTransport.decrypt(encryptedData);
    } catch (e) {
      throw new Error(`Decryption failed: ${e.message}`);
    }

    let lesson;
    try {
      lesson = JSON.parse(decrypted.toString());
    } catch (e) {
      throw new Error(`Deserialization failed: ${e.message}`);
    }

    // Reconstruit l’objet ContributionProof
    const proof = new ContributionProof(
      lesson.nodeId,
      lesson.contributionType,
      lesson.score,
      lesson.metadata,
      lesson.thevieBoost || 0,
      lesson.compressedSize || 0
    );
    proof.timestamp = lesson.timestamp || Date.now();
    proof.proofHash = lesson.proofHash;
    proof.epoch = lesson.epoch || 0;

    this.#receivedLessons.push(proof);
    this.#stats.messagesReceived++;

    return proof;
  }

  // =====================================================
  // COORDINATION FLASH GEMATRIA GLOBAL
  // =====================================================
  async coordinateGlobalFlash() {
    const signal = Buffer.from('FLASH_GEMATRIA|GLOBAL|PRIORITY');

    try {
      await this.#hybridTransport.publish('skyainet/signals/v2', signal);
      this.#stats.messagesSent++;
      this.#lastBroadcast = Date.now();
    } catch (e) {
      throw new Error(`Global flash signal failed: ${e.message}`);
    }
  }

  // =====================================================
  // STATISTIQUES & MAINTENANCE
  // =====================================================
  getStats() {
    return { ...this.#stats };
  }

  pruneOldLessons(maxAgeDays = 90) {
    const cutoff = Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000);
    this.#receivedLessons = this.#receivedLessons.filter(l => l.timestamp > cutoff);
  }

  get peerId() { return this.#peerId; }
  get receivedLessons() { return [...this.#receivedLessons]; }
}