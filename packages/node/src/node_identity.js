// packages/node/src/node_identity.js
// NodeIdentity — Identité Souveraine & Attestation Post-Quantique
// Dilithium5 + HybridTransport + Réputation Dynamique + Peer Trust
// Intégré avec NodeAttestation + PeerReputation + PeerPool + EpochRekeyManager

import { Dilithium5Signer } from '../../secure/src/crypto/dilithium.js';
import { HybridTransport } from '../../secure/src/crypto/hybrid.js';
import { randomBytes } from 'crypto';
import { NodeAttestation } from '../../secure/src/roots/attestation.js';
import { PeerReputation } from '../../secure/src/roots/reputation.js';
import { PeerPool } from '../../secure/src/roots/pool.js';
import { EpochRekeyManager } from '../../secure/src/roots/epoch_rekey.js';

export class Attestation {
  constructor(timestamp, signature, issuer, valid = true) {
    this.timestamp = timestamp;
    this.signature = signature;
    this.issuer = issuer;
    this.valid = valid;
  }
}

export class NodeIdentity {
  #signer;
  #hybrid;
  #peerPool;
  #epochRekeyManager;

  constructor(sovereignAlias) {
    if (!sovereignAlias || typeof sovereignAlias !== 'string') {
      throw new Error('Alias souverain requis');
    }

    this.#signer = new Dilithium5Signer();
    this.#hybrid = new HybridTransport(true);
    this.#peerPool = new PeerPool().withMinReputation(0.68);
    this.#epochRekeyManager = new EpochRekeyManager(3600);

    this.nodeId = randomBytes(32);
    this.sovereignAlias = sovereignAlias;
    this.publicKey = this.#signer.publicKeyBytes();
    this.reputation = 0.82;
    this.attestations = [];
    this.registeredPeers = new Map(); // peerId (hex) → PeerReputation
  }

  // =====================================================
  // ATTESTATION CRYPTOGRAPHIQUE (NodeAttestation)
  // =====================================================
  generateAttestation() {
    const timestamp = Date.now();
    const message = `attest:\( {this.sovereignAlias}: \){timestamp}`;
    const signature = this.#signer.sign(Buffer.from(message));

    const attestation = new Attestation(timestamp, signature, this.sovereignAlias);
    this.attestations.push(attestation);

    return attestation;
  }

  createNodeAttestation() {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = this.#signer.sign(Buffer.from(this.sovereignAlias));
    return NodeAttestation.create(
      this.nodeId,
      this.publicKey,
      signature,
      0,
      null
    );
  }

  verifyAttestation(attestation) {
    if (!attestation?.signature || !attestation.issuer) return false;

    const message = `attest:\( {attestation.issuer}: \){attestation.timestamp}`;
    const isValidSig = this.#signer.verify(Buffer.from(message), attestation.signature);
    const isRecent = (Date.now() - attestation.timestamp) < 300_000;

    return isValidSig && attestation.valid && isRecent;
  }

  verifyNodeAttestation(attestation, contactManager = null) {
    if (!attestation) return false;
    try {
      return attestation.verify(this.#signer, contactManager);
    } catch {
      return false;
    }
  }

  attest() {
    if (this.attestations.length === 0) return false;
    const last = this.attestations[this.attestations.length - 1];
    return this.verifyAttestation(last) && this.reputation > 0.65;
  }

  // =====================================================
  // RÉPUTATION & PEERS (avec PeerReputation + PeerPool)
  // =====================================================
  updateReputation(delta) {
    this.reputation = Math.max(0, Math.min(1, this.reputation + delta));
    if (this.#peerPool) {
      this.#peerPool.updateReputation(this.nodeId, this.reputation);
    }
  }

  registerPeer(peerId, initialReputation = 0.5) {
    const key = Buffer.isBuffer(peerId) ? peerId.toString('hex') : peerId;
    const rep = new PeerReputation();
    rep.score = Math.max(0, Math.min(1, initialReputation));
    this.registeredPeers.set(key, rep);
    this.#peerPool.addPeer(key, 'unknown');
  }

  updatePeerReputation(peerId, delta) {
    const key = Buffer.isBuffer(peerId) ? peerId.toString('hex') : peerId;
    const rep = this.registeredPeers.get(key);
    if (rep) {
      rep.update(delta);
      this.#peerPool.updateReputation(key, rep.score);
    }
  }

  isPeerTrusted(peerId) {
    const key = Buffer.isBuffer(peerId) ? peerId.toString('hex') : peerId;
    const rep = this.registeredPeers.get(key);
    return rep ? rep.isTrusted() : false;
  }

  trustScore() {
    const base = this.reputation;
    const bonus = this.attest() ? 0.12 : 0;
    return Math.min(1, base + bonus);
  }

  // =====================================================
  // EPOCH REKEY (EpochRekeyManager)
  // =====================================================
  forceRekeyOnNode() {
    this.#epochRekeyManager.forceRekey();
    console.info(`[NodeIdentity] Rekey forcé pour ${this.sovereignAlias}`);
  }

  shouldRekey() {
    return this.#epochRekeyManager.shouldRekey();
  }

  // =====================================================
  // UTILITAIRES
  // =====================================================
  healthReport() {
    return `NodeIdentity ${this.sovereignAlias} | Reputation: ${this.reputation.toFixed(3)} | Attestations: ${this.attestations.length} | Trusted Peers: ${this.registeredPeers.size}`;
  }

  toJSON() {
    return {
      nodeId: this.nodeId.toString('hex'),
      sovereignAlias: this.sovereignAlias,
      publicKey: this.publicKey.toString('hex'),
      reputation: this.reputation,
      attestations: this.attestations.length,
      trustedPeers: this.registeredPeers.size,
      trustScore: this.trustScore(),
      shouldRekey: this.shouldRekey(),
    };
  }
}