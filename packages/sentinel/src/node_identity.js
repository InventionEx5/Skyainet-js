// packages/sentinel/src/node_identity.js
// =====================================================
// NodeIdentity — Identité Souveraine & Attestation Post‑Quantique
// SkyAInet – Dilithium5 + HybridTransport + Réputation Dynamique + Peer Trust
// =====================================================

import { Dilithium5Signer } from '../../secure/src/crypto/dilithium.js';
import { HybridTransport } from '../../secure/src/crypto/hybrid.js';

// ----------------------------------------------------------------------
// Attestation
// ----------------------------------------------------------------------
export class Attestation {
  constructor({ timestamp, signature, issuer, valid = true }) {
    this.timestamp = timestamp;          // ms epoch
    this.signature = signature;          // Uint8Array
    this.valid = valid;
    this.issuer = issuer;
  }

  toJSON() {
    return {
      timestamp: this.timestamp,
      signature: Array.from(this.signature),
      valid: this.valid,
      issuer: this.issuer,
    };
  }

  static fromJSON(json) {
    return new Attestation({
      timestamp: json.timestamp,
      signature: new Uint8Array(json.signature),
      valid: json.valid,
      issuer: json.issuer,
    });
  }
}

// ----------------------------------------------------------------------
// NodeIdentity
// ----------------------------------------------------------------------
export class NodeIdentity {
  // ---------- constructeur ----------
  constructor(sovereignAlias, nodeId, signer, hybrid) {
    this.nodeId = nodeId;                         // Uint8Array(32)
    this.sovereignAlias = sovereignAlias;
    this.publicKey = signer.publicKeyBytes();     // Uint8Array
    this.reputation = 0.82;
    this.attestations = [];                       // Attestation[]
    this.registeredPeers = new Map();             // Map<hexPeerId, reputation>

    this.signer = signer;                         // Dilithium5Signer
    this.hybrid = hybrid;                         // HybridTransport
  }

  // ---------- factory statique ----------
  static create(sovereignAlias) {
    const signer = new Dilithium5Signer();
    const hybrid = new HybridTransport(true);
    const nodeId = crypto.getRandomValues(new Uint8Array(32));
    return new NodeIdentity(sovereignAlias, nodeId, signer, hybrid);
  }

  // ---------- helper hex ----------
  get nodeIdHex() {
    return Array.from(this.nodeId, b => b.toString(16).padStart(2, '0')).join('');
  }

  static nowMs() {
    return Date.now();
  }

  // ---------- attestations ----------
  generateAttestation() {
    const timestamp = NodeIdentity.nowMs();
    const message = new TextEncoder().encode(
      `attest:${this.sovereignAlias}:${timestamp}`
    );
    const signature = this.signer.sign(message);

    const att = new Attestation({
      timestamp,
      signature,
      issuer: this.sovereignAlias,
      valid: true,
    });
    this.attestations.push(att);
    return att;
  }

  verifyAttestation(attestation) {
    if (!attestation.valid) return false;
    const age = NodeIdentity.nowMs() - attestation.timestamp;
    if (age > 300_000) return false; // 5 minutes

    const message = new TextEncoder().encode(
      `attest:${attestation.issuer}:${attestation.timestamp}`
    );
    try {
      this.signer.verify(message, attestation.signature);
      return true;
    } catch {
      return false;
    }
  }

  isAttested() {
    if (this.attestations.length === 0) return false;
    const last = this.attestations[this.attestations.length - 1];
    return this.verifyAttestation(last) && this.reputation > 0.65;
  }

  // ---------- réputation ----------
  updateReputation(delta) {
    this.reputation = Math.min(1.0, Math.max(0.0, this.reputation + delta));
    console.info(`[NodeIdentity] Reputation updated: ${this.reputation.toFixed(3)}`);
  }

  // ---------- gestion des pairs ----------
  registerPeer(peerIdBytes, initialReputation) {
    const hex = NodeIdentity._bytesToHex(peerIdBytes);
    this.registeredPeers.set(hex, Math.min(1.0, Math.max(0.0, initialReputation)));
  }

  updatePeerReputation(peerIdBytes, delta) {
    const hex = NodeIdentity._bytesToHex(peerIdBytes);
    const current = this.registeredPeers.get(hex);
    if (current !== undefined) {
      this.registeredPeers.set(hex, Math.min(1.0, Math.max(0.0, current + delta)));
    }
  }

  isPeerTrusted(peerIdBytes) {
    const hex = NodeIdentity._bytesToHex(peerIdBytes);
    const rep = this.registeredPeers.get(hex);
    return rep !== undefined && rep > 0.68;
  }

  // ---------- score de confiance ----------
  get trustScore() {
    const bonus = this.isAttested() ? 0.12 : 0.0;
    return Math.min(1.0, this.reputation + bonus);
  }

  // ---------- rapport ----------
  healthReport() {
    return `NodeIdentity ${this.sovereignAlias} | Reputation: ${this.reputation.toFixed(3)} | Attestations: ${this.attestations.length} | Trusted Peers: ${this.registeredPeers.size}`;
  }

  // ---------- sérialisation ----------
  toJSON() {
    return {
      nodeId: Array.from(this.nodeId),
      sovereignAlias: this.sovereignAlias,
      publicKey: Array.from(this.publicKey),
      reputation: this.reputation,
      attestations: this.attestations.map(a => a.toJSON()),
      registeredPeers: [...this.registeredPeers].map(([hex, rep]) => [hex, rep]),
    };
  }

  static fromJSON(json, signer, hybrid) {
    const nodeId = new Uint8Array(json.nodeId);
    const identity = new NodeIdentity(json.sovereignAlias, nodeId, signer, hybrid);
    identity.publicKey = new Uint8Array(json.publicKey);
    identity.reputation = json.reputation;
    identity.attestations = json.attestations.map(a => Attestation.fromJSON(a));
    identity.registeredPeers = new Map(json.registeredPeers);
    return identity;
  }

  // ---------- utilitaire ----------
  static _bytesToHex(bytes) {
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  }
}