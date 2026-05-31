// packages/node/src/node_communication.js
// NodeCommunication — Réseau de Nœuds Vivant & Sécurisé
// HybridTransport + GematriaAead + GossipSub + Lesson Propagation
// Intégré avec PeerPool + PeerReputation (sélection intelligente + mise à jour dynamique)

import { HybridTransport } from '../../secure/src/crypto/hybrid.js';
import { ContributionProof } from './pouw.js';
import { PeerPool } from '../../secure/src/roots/pool.js';
import { PeerReputation } from '../../secure/src/roots/reputation.js';

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
  #peerPool = null;

  constructor(peerId, hybridTransport = null) {
    if (!peerId) throw new Error('peerId requis');
    this.#peerId = peerId;
    this.#hybridTransport = hybridTransport || new HybridTransport(true);
    this.#peerPool = new PeerPool().withMinReputation(0.65);
  }

  // =====================================================
  // INTÉGRATION PEERPOOL (injection ou accès direct)
  // =====================================================
  setPeerPool(peerPool) {
    if (peerPool instanceof PeerPool) {
      this.#peerPool = peerPool;
    }
  }

  get peerPool() {
    return this.#peerPool;
  }

  // =====================================================
  // BROADCAST DE LEÇON (avec sélection intelligente via PeerPool)
  // =====================================================
  async broadcastLesson(lesson, qualityThreshold = 0.7) {
    if (!lesson || lesson.score < qualityThreshold) return;

    const lessonData = Buffer.from(JSON.stringify(lesson));

    // Chiffrement hybride
    let encrypted;
    try {
      encrypted = await this.#hybridTransport.encrypt(lessonData);
    } catch (e) {
      this.#stats.failedBroadcasts++;
      throw new Error(`Encryption failed: ${e.message}`);
    }

    const topic = 'skyainet/lessons/v2';

    try {
      // === NOUVELLE LOGIQUE : Sélection intelligente des pairs ===
      let targetPeers = [];
      if (this.#peerPool && this.#peerPool.len() > 0) {
        try {
          targetPeers = this.#peerPool.getHighReputationPeers(3);
        } catch {
          targetPeers = this.#peerPool.getRandomPeers(3);
        }
      }

      // Publication GossipSub (comportement original conservé)
      await this.#hybridTransport.publish(topic, encrypted);

      // Mise à jour de réputation (boost léger après broadcast réussi)
      if (this.#peerPool) {
        this.#peerPool.updateReputation(this.#peerId, 0.015);
      }

      this.#stats.messagesSent++;
      this.#stats.lessonsPropagated++;
      this.#lastBroadcast = Date.now();

    } catch (e) {
      this.#stats.failedBroadcasts++;
      throw new Error(`GossipSub publish failed: ${e.message}`);
    }
  }

  // =====================================================
  // RÉCEPTION DE LEÇON (avec mise à jour de réputation)
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

    // === NOUVELLE LOGIQUE : Mise à jour de réputation du sender ===
    if (this.#peerPool && proof.nodeId) {
      const rep = new PeerReputation();
      rep.withContact(proof.nodeId);
      rep.recordSuccess(0.04); // Bonus pour leçon reçue

      this.#peerPool.updateReputation(proof.nodeId, rep.score);
    }

    return proof;
  }

  // =====================================================
  // COORDINATION FLASH GEMATRIA GLOBAL
  // =====================================================
  async coordinateGlobalFlash() {
    const signal = Buffer.from('FLASH_GEMATRIA|GLOBAL|PRIORITY');

    try {
      await this.#hybridTransport.publish('skyainet/signals/v2', signal);

      if (this.#peerPool) {
        this.#peerPool.updateReputation(this.#peerId, 0.01);
      }

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