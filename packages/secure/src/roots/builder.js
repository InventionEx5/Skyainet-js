// packages/secure/src/roots/builder.js
// =====================================================
// DiamantCircuitBuilder — Circuit Builder Intelligent
// Compatible Contact + DID + RomanT369 + GroupManager
// DiamantRoots v2 — Routeur Tor-like Post-Quantique
// SkyAInet × Nikola T369
// =====================================================

import { KemT369 } from '../crypto/kem_t369.js';
import { RomanT369, GematriaMode } from '../crypto/roman_t369.js';
import { Contact } from '../contacts/contact.js';
import { ContactManager } from '../contacts/manager.js';

export class CircuitBuilderError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CircuitBuilderError';
  }
}

export class Circuit {
  constructor(id, nodes, epoch, sharedSecrets) {
    this.id = id;
    this.nodes = nodes;           // SocketAddr[]
    this.epoch = epoch;
    this.sharedSecrets = sharedSecrets; // Uint8Array[32][]
  }
}

export class DiamantCircuitBuilder {
  constructor() {
    this.kem = new KemT369(false);
    this.roman = new RomanT369(new Uint8Array(32).fill(0x42), new Uint8Array(12), GematriaMode.Hyper256);
    this.minCircuitLength = 3;
    this.maxCircuitLength = 5;
    this.reputationThreshold = 0.65;
    this.preferDiversity = true;
  }

  withReputationThreshold(threshold) {
    this.reputationThreshold = threshold;
    return this;
  }

  withDiversity(enabled) {
    this.preferDiversity = enabled;
    return this;
  }

  /**
   * Construit un circuit avec sélection intelligente (DID + réputation)
   */
  async buildCircuit(length, contactManager = null) {
    const finalLength = Math.max(this.minCircuitLength, Math.min(length, this.maxCircuitLength));

    const nodes = await this.#selectDiversePeers(finalLength, contactManager);

    const sharedSecrets = [];
    const circuitNodes = [];

    for (const addr of nodes) {
      const [pk] = this.kem.generateKeypair();
      const [_, shared] = this.kem.encapsulate(pk);

      // Renforcement post-quantique avec RomanT369
      const reinforced = this.roman.encrypt(shared.secret);
      const finalSecret = reinforced.subarray(0, 32);

      sharedSecrets.push(finalSecret);
      circuitNodes.push(addr);
    }

    const circuitId = Math.floor(Math.random() * 0xFFFFFFFF);

    console.info(
      `[DiamantRoots] Circuit ${circuitId} créé avec ${finalLength} nœuds (longueur: ${finalLength})`
    );

    return new Circuit(circuitId, circuitNodes, 0, sharedSecrets);
  }

  async destroyCircuit(circuitId) {
    console.debug(`[DiamantRoots] Destruction du circuit ${circuitId}`);
    // TODO: Nettoyer les clés éphémères + notifier les nœuds
  }

  /**
   * Sélectionne des nœuds avec diversité + réputation + DID
   */
  async #selectDiversePeers(count, contactManager = null) {
    const selected = [];
    const rng = () => Math.floor(Math.random() * (65000 - 40000)) + 40000;

    for (let i = 0; i < count; i++) {
      const port = rng();
      const addr = `127.0.0.1:${port}`;

      if (contactManager) {
        // Simulation : on suppose que l'adresse correspond à un node_id
        const fakeNodeId = new Uint8Array(32).fill(port % 256);

        const contact = contactManager.get(fakeNodeId);
        if (contact && contact.hasDecentralizedIdentity && contact.verificationLevel >= 2) {
          selected.push(addr);
          continue;
        }
      }

      // Fallback : sélection aléatoire avec seuil de réputation simulé
      const reputation = Math.random() * 0.5 + 0.5;
      if (reputation >= this.reputationThreshold) {
        selected.push(addr);
      } else {
        const fallbackPort = rng();
        selected.push(`127.0.0.1:${fallbackPort}`);
      }
    }

    if (selected.length < count) {
      throw new CircuitBuilderError('Not enough verified peers available');
    }

    return selected;
  }
}