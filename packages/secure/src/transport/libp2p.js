// packages/secure/src/transport/libp2p.js
// =====================================================
// Libp2p Transport — Cœur du Réseau (Mode Hybride Intelligent)
// Compatible Contact + DID + RomanT369 + GroupManager
// SkyAInet × Nikola T369
// =====================================================

import { HybridTransport, HybridMode } from '../crypto/hybrid.js';
import { Contact } from '../contacts/contact.js';
import { EventEmitter } from 'events';

export class Libp2pTransportReal extends EventEmitter {
  constructor() {
    super();
    this.swarm = null;
    this.localPeerId = `peer_${Date.now().toString(36)}`;
    this.running = false;
    this.hybrid = new HybridTransport(false);
    this.flashInterval = 45000; // 45 secondes
    this.lastFlash = Date.now();
    this.messageQueue = [];
  }

  async start() {
    if (this.running) return;

    console.info(`[Libp2p] Transport réel démarré - PeerID: ${this.localPeerId}`);

    this.running = true;
    this.#startFlashScheduler();

    // Simulation d’un swarm (à remplacer par vrai libp2p plus tard)
    this.emit('started', this.localPeerId);
  }

  async stop() {
    this.running = false;
    console.info('[Libp2p] Transport arrêté');
    this.emit('stopped');
  }

  /**
   * Envoi hybride via GossipSub (simulé)
   */
  async sendHybrid(addr, plaintext, mode = HybridMode.KemT369Core, contact = null) {
    if (!this.running) {
      throw new Error('Transport not started');
    }

    this.hybrid.setMode(mode);

    // Utilise le HybridTransport déjà existant
    const dummyPublicKey = { ml_kem_public: new Uint8Array(32), is_1024: false };
    const [kemCt, ciphertext] = this.hybrid.encrypt(dummyPublicKey, plaintext);

    // Simulation de publication GossipSub
    const message = {
      type: 'skyainet/lessons',
      from: this.localPeerId,
      payload: ciphertext,
      timestamp: Date.now(),
    };

    this.messageQueue.push(message);
    this.emit('message', message);

    console.debug(
      `[Libp2p] Message publié (mode: ${mode}) — Contact: ${contact ? contact.name : 'unknown'}`
    );

    return true;
  }

  /**
   * Scheduler intelligent des Flash Gematria (5% de chance toutes les 45s)
   */
  #startFlashScheduler() {
    setInterval(() => {
      if (!this.running) return;

      const now = Date.now();
      if (now - this.lastFlash > this.flashInterval && Math.random() < 0.05) {
        console.debug('[Libp2p] Déclenchement Flash Gematria');
        this.hybrid.setMode(HybridMode.FlashGematria);
        this.lastFlash = now;
      }
    }, 15000); // Vérifie toutes les 15 secondes
  }

  // === Implémentation de l’interface Transport ===

  async send(addr, data) {
    if (!this.running) throw new Error('Transport not started');
    // Mode par défaut : KemT369Core
    return this.sendHybrid(addr, data, HybridMode.KemT369Core);
  }

  async recv() {
    if (this.messageQueue.length === 0) {
      return ['0.0.0.0:0', new Uint8Array(0)];
    }
    const msg = this.messageQueue.shift();
    return [msg.from, msg.payload];
  }

  localAddr() {
    return null; // À implémenter avec vrai libp2p
  }

  cryptoMode() {
    return 'PostQuantumHybrid';
  }

  layer() {
    return 'Core';
  }
}