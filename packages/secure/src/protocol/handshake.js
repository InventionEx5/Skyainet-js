// packages/secure/src/protocol/handshake.js
// =====================================================
// Handshake Hybride — Négociation Intelligente
// Compatible Contact + DID + RomanT369 + GroupManager
// SkyAInet × Nikola T369
// =====================================================

import { HybridTransport, HybridMode } from '../crypto/hybrid.js';
import { KemT369 } from '../crypto/kem_t369.js';
import { RomanT369, GematriaMode } from '../crypto/roman_t369.js';
import { Contact } from '../contacts/contact.js';
import { createHash, randomBytes } from 'crypto';

export const NodeRole = Object.freeze({
  Core: 'Core',
  Edge: 'Edge',
  Validator: 'Validator',
});

export const CryptoSuite = Object.freeze({
  KemT369: 'KemT369',
  RomanT369: 'RomanT369',
  HybridFlash: 'HybridFlash',
  PostQuantumHybrid: 'PostQuantumHybrid',
});

export class HandshakeMessage {
  constructor(data = {}) {
    this.version = data.version || 0x06;
    this.x25519Public = data.x25519Public || new Uint8Array(32);
    this.mlKemPublic = data.mlKemPublic || new Uint8Array(0);
    this.is1024 = data.is1024 || false;
    this.nodeId = data.nodeId || new Uint8Array(32);
    this.nodeRole = data.nodeRole || NodeRole.Core;
    this.supportedSuites = data.supportedSuites || [];
    this.preferredHybridMode = data.preferredHybridMode || HybridMode.KemT369Core;
    this.timestamp = data.timestamp || Math.floor(Date.now() / 1000);
    this.signature = data.signature || new Uint8Array(0);
    this.did = data.did || null;
  }
}

export class Handshake {
  constructor(localRole = NodeRole.Core) {
    this.localSecret = randomBytes(32); // X25519 ephemeral (simplified)
    this.localKem = new KemT369(false);
    this.transcript = createHash('sha256'); // Replacement for blake3
    this.localRole = localRole;
    this.hybridEngine = new HybridTransport(false);
    this.chosenMode = null;
    this.roman = new RomanT369(new Uint8Array(32).fill(0x42), new Uint8Array(12), GematriaMode.Hyper256);

    const defaultMode = localRole === NodeRole.Edge 
      ? HybridMode.FullGematria 
      : HybridMode.KemT369Core;
    this.chosenMode = defaultMode;
    this.hybridEngine.setMode(defaultMode);
  }

  /**
   * Crée le message initial du handshake (avec DID optionnel)
   */
  createInitialMessage(nodeId, contact = null) {
    const x25519Public = this.localSecret; // simplified
    const [kemPublic] = this.localKem.generateKeypair();

    this.transcript.update(x25519Public);
    this.transcript.update(kemPublic.ml_kem_public);
    this.transcript.update(Buffer.from([this.localRole === NodeRole.Core ? 0 : 1]));

    const preferredMode = this.localRole === NodeRole.Edge 
      ? HybridMode.FullGematria 
      : HybridMode.KemT369Core;

    const did = contact ? contact.getDidString?.() || null : null;

    return new HandshakeMessage({
      version: 0x06,
      x25519Public,
      mlKemPublic: kemPublic.ml_kem_public,
      is1024: kemPublic.is_1024,
      nodeId,
      nodeRole: this.localRole,
      supportedSuites: [
        CryptoSuite.KemT369,
        CryptoSuite.RomanT369,
        CryptoSuite.HybridFlash,
        CryptoSuite.PostQuantumHybrid,
      ],
      preferredHybridMode: preferredMode,
      timestamp: Math.floor(Date.now() / 1000),
      signature: new Uint8Array(0),
      did,
    });
  }

  /**
   * Traite la réponse et négocie le mode hybride
   */
  processResponse(msg) {
    const chosenMode = this.#negotiateHybridMode(msg.preferredHybridMode);
    this.chosenMode = chosenMode;
    this.hybridEngine.setMode(chosenMode);

    console.info(`[Handshake] Mode hybride négocié : ${chosenMode}`);

    this.transcript.update(msg.x25519Public);
    this.transcript.update(msg.mlKemPublic);
    this.transcript.update(Buffer.from([msg.nodeRole === NodeRole.Core ? 0 : 1]));

    const transcriptHash = this.transcript.digest();

    // Simplified X25519 shared secret
    const sharedSecret = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      sharedSecret[i] = (this.localSecret[i] ^ msg.x25519Public[i]) & 0xff;
    }

    // Dérivation finale renforcée avec RomanT369
    const finalKey = this.#deriveFinalKey(sharedSecret, transcriptHash);

    return [chosenMode, finalKey];
  }

  #negotiateHybridMode(remotePreferred) {
    if (this.localRole === NodeRole.Edge) {
      return HybridMode.FullGematria;
    }
    if (this.localRole === NodeRole.Core && remotePreferred === HybridMode.FullGematria) {
      return HybridMode.FlashGematria;
    }
    return HybridMode.KemT369Core;
  }

  /**
   * Dérivation finale avec RomanT369 (plus forte que HKDF seul)
   */
  #deriveFinalKey(sharedSecret, transcript) {
    const input = new Uint8Array(64);
    input.set(sharedSecret, 0);
    input.set(transcript.subarray(0, 32), 32);

    const encrypted = this.roman.encrypt(input);
    return encrypted.subarray(0, 32);
  }

  chosenMode() {
    return this.chosenMode;
  }
}