// packages/node/src/node_identity.js
// NodeIdentity — Identité Souveraine & Attestation Post-Quantique
// Dilithium5 + HybridTransport + Réputation Dynamique + Peer Trust

import { Dilithium5Signer } from '../../secure/src/crypto/dilithium.js';
import { HybridTransport } from '../../secure/src/crypto/hybrid.js';
import { randomBytes } from 'crypto';

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

  constructor(sovereignAlias) {
    if (!sovereignAlias || typeof sovereignAlias !== 'string') {
      throw new Error('Alias souverain requis');
    }

    this.#signer = new Dilithium5Signer();
    this.#hybrid = new HybridTransport(true);

    this.nodeId = randomBytes(32);
    this.sovereignAlias = sovereignAlias;
    this.publicKey = this.#signer.publicKeyBytes();
    this.reputation = 0.82;
    this.attestations = [];
    this.registeredPeers = new Map(); // peerId (hex) → reputation
  }

  // =====================================================
  // ATTESTATION CRYPTOGRAPHIQUE
  // =====================================================
  generateAttestation() {
    const timestamp = Date.now();
    const message = `attest:\( {this.sovereignAlias}: \){timestamp}`;
    const signature = this.#signer.sign(Buffer.from(message));

    const attestation = new Attestation(timestamp, signature, this.sovereignAlias);
    this.attestations.push(attestation);

    return attestation;
  }

  verifyAttestation(attestation) {
    if (!attestation?.signature || !attestation.issuer) return false;

    const message = `attest:\( {attestation.issuer}: \){attestation.timestamp}`;
    const isValidSig = this.#signer.verify(Buffer.from(message), attestation.signature);
    const isRecent = (Date.now() - attestation.timestamp) < 300_000; // 5 minutes

    return isValidSig && attestation.valid && isRecent;
  }

  attest() {
    if (this.attestations.length === 0) return false;
    const last = this.attestations[this.attestations.length - 1];
    return this.verifyAttestation(last) && this.reputation > 0.65;
  }

  // =====================================================
  // RÉPUTATION & PEERS
  // =====================================================
  updateReputation(delta) {
    this.reputation = Math.max(0, Math.min(1, this.reputation + delta));
  }

  registerPeer(peerId, initialReputation = 0.5) {
    const key = Buffer.isBuffer(peerId) ? peerId.toString('hex') : peerId;
    this.registeredPeers.set(key, Math.max(0, Math.min(1, initialReputation)));
  }

  updatePeerReputation(peerId, delta) {
    const key = Buffer.isBuffer(peerId) ? peerId.toString('hex') : peerId;
    if (this.registeredPeers.has(key)) {
      const current = this.registeredPeers.get(key);
      this.registeredPeers.set(key, Math.max(0, Math.min(1, current + delta)));
    }
  }

  isPeerTrusted(peerId) {
    const key = Buffer.isBuffer(peerId) ? peerId.toString('hex') : peerId;
    return (this.registeredPeers.get(key) ?? 0) > 0.68;
  }

  trustScore() {
    const base = this.reputation;
    const bonus = this.attest() ? 0.12 : 0;
    return Math.min(1, base + bonus);
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
    };
  }
}