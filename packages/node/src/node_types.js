// packages/core/src/node_types.js
// Node Types + NodeIdentity — Architecture & Identité Souveraine
// Dilithium5 + Réputation Dynamique + Attestation Post-Quantique
// SkyAInet × Nikola T369

"use strict";

import { Dilithium5Signer, Dilithium5KeyPair } from '../../secure/src/crypto/dilithium.js';
import { HybridTransport }                     from '../../secure/src/crypto/hybrid.js';
import { hkdfSha256, hmacSha256 }              from '../../secure/src/crypto/sha_fips.js';
import { randomBytes }                         from 'crypto';

// ─────────────────────────────────────────────────────────────────
// ÉNUMÉRATIONS
// ─────────────────────────────────────────────────────────────────

export const NodeType = Object.freeze({
  Mini       : 'Mini',
  Light      : 'Light',
  Full       : 'Full',
  Validator  : 'Validator',
  Sentinel   : 'Sentinel',
  DreamWeaver: 'DreamWeaver',
  Storage    : 'Storage',
  Compute    : 'Compute',
  Mixed      : 'Mixed',
});

export const NodeRole = Object.freeze({
  Core       : 'Core',
  Edge       : 'Edge',
  Full       : 'Full',
  Validator  : 'Validator',
  Storage    : 'Storage',
  Compute    : 'Compute',
  Sentinel   : 'Sentinel',
  DreamWeaver: 'DreamWeaver',
  Gateway    : 'Gateway',
});

export const NodeState = Object.freeze({
  Initializing: 'Initializing',
  Active      : 'Active',
  Sleeping    : 'Sleeping',
  Syncing     : 'Syncing',
  DreamMode   : 'DreamMode',
  Evolving    : 'Evolving',
  Gateway     : 'Gateway',
  Maintenance : 'Maintenance',
  Stopped     : 'Stopped',
  Idle        : 'Idle',
});

export const SubscriptionLevel = Object.freeze({
  Free     : 'Free',
  Pro      : 'Pro',
  Validator: 'Validator',
  Enterprise: 'Enterprise',
});

export const ReputationTier = Object.freeze({
  Newcomer : 'Newcomer',
  Reliable : 'Reliable',
  Trusted  : 'Trusted',
  Sovereign: 'Sovereign',
  Legend   : 'Legend',
});

// ─────────────────────────────────────────────────────────────────
// NODE CAPABILITIES
// ─────────────────────────────────────────────────────────────────

export class NodeCapabilities {
  constructor(level = SubscriptionLevel.Free) {
    Object.assign(this, NodeCapabilities.configFor(level));
  }

  static configFor(level) {
    switch (level) {
      case SubscriptionLevel.Free:
        return {
          storage_gb            : 8,
          compute_power         : 1.0,
          max_concurrent_tasks  : 2,
          supports_gpu          : false,
          supports_flash_gematria: true,
          zip_memory_enabled    : true,
          bandwidth_mbps        : 10,
          custom_features       : {},
        };
      case SubscriptionLevel.Pro:
        return {
          storage_gb            : 128,
          compute_power         : 6.0,
          max_concurrent_tasks  : 16,
          supports_gpu          : true,
          supports_flash_gematria: true,
          zip_memory_enabled    : true,
          bandwidth_mbps        : 100,
          custom_features       : {
            dynamic_site_generation: true,
            api_gateway            : true,
          },
        };
      case SubscriptionLevel.Validator:
        return {
          storage_gb            : 512,
          compute_power         : 12.0,
          max_concurrent_tasks  : 64,
          supports_gpu          : true,
          supports_flash_gematria: true,
          zip_memory_enabled    : true,
          bandwidth_mbps        : 1000,
          custom_features       : {
            consensus_participation: true,
            governance_voting      : true,
          },
        };
      case SubscriptionLevel.Enterprise:
        return {
          storage_gb            : 2048,
          compute_power         : 32.0,
          max_concurrent_tasks  : 256,
          supports_gpu          : true,
          supports_flash_gematria: true,
          zip_memory_enabled    : true,
          bandwidth_mbps        : 10_000,
          custom_features       : {
            consensus_participation: true,
            governance_voting      : true,
            dedicated_support      : true,
            sla_guarantee          : true,
          },
        };
      default:
        return NodeCapabilities.configFor(SubscriptionLevel.Free);
    }
  }

  /**
   * Ajuste les capacités en fonction de l'état courant du nœud.
   * Les modifications sont temporaires — ne pas appeler sur la config de référence.
   */
  adjustForState(state) {
    if (state === NodeState.Sleeping) {
      this.compute_power          = +(this.compute_power * 0.20).toFixed(3);
      this.bandwidth_mbps         = Math.max(1, Math.floor(this.bandwidth_mbps * 0.10));
      this.max_concurrent_tasks   = 1;
    } else if (state === NodeState.DreamMode) {
      this.compute_power          = +(this.compute_power * 0.60).toFixed(3);
      this.max_concurrent_tasks   = Math.max(1, Math.floor(this.max_concurrent_tasks * 0.50));
    } else if (state === NodeState.Maintenance) {
      this.max_concurrent_tasks   = 0;
    }
  }

  toJSON() { return { ...this }; }
}

// ─────────────────────────────────────────────────────────────────
// FONCTIONS UTILITAIRES
// ─────────────────────────────────────────────────────────────────

export function isPaidNodeType(type) {
  return [NodeType.Full, NodeType.Validator, NodeType.DreamWeaver, NodeType.Sentinel].includes(type);
}

export function monthlyPriceEur(type) {
  const prices = {
    [NodeType.Mini]       : 0,
    [NodeType.Light]      : 6,
    [NodeType.Full]       : 18,
    [NodeType.Validator]  : 55,
    [NodeType.Sentinel]   : 32,
    [NodeType.DreamWeaver]: 45,
    [NodeType.Storage]    : 12,
    [NodeType.Compute]    : 24,
    [NodeType.Mixed]      : 28,
  };
  return prices[type] ?? 0;
}

export function computeMultiplier(type) {
  const multipliers = {
    [NodeType.Mini]       : 1.0,
    [NodeType.Light]      : 2.5,
    [NodeType.Full]       : 6.0,
    [NodeType.Validator]  : 12.0,
    [NodeType.Sentinel]   : 4.0,
    [NodeType.DreamWeaver]: 8.5,
    [NodeType.Storage]    : 2.0,
    [NodeType.Compute]    : 10.0,
    [NodeType.Mixed]      : 7.0,
  };
  return multipliers[type] ?? 1.0;
}

export function isOperationalState(state) {
  return [NodeState.Active, NodeState.Gateway, NodeState.DreamMode, NodeState.Evolving].includes(state);
}

export function isPaidSubscription(level) {
  return level !== SubscriptionLevel.Free;
}

export function reputationTierFromScore(score) {
  if (score >= 0.95) return ReputationTier.Legend;
  if (score >= 0.85) return ReputationTier.Sovereign;
  if (score >= 0.70) return ReputationTier.Trusted;
  if (score >= 0.50) return ReputationTier.Reliable;
  return ReputationTier.Newcomer;
}

export function defaultCapabilitiesForType(nodeType) {
  if (nodeType === NodeType.Mini)                         return new NodeCapabilities(SubscriptionLevel.Free);
  if ([NodeType.Light, NodeType.Full, NodeType.Mixed,
       NodeType.Storage, NodeType.Compute].includes(nodeType)) return new NodeCapabilities(SubscriptionLevel.Pro);
  return new NodeCapabilities(SubscriptionLevel.Validator);
}

export function isEdgeNode(role)              { return role === NodeRole.Edge; }
export function requiresPaidSubscription(type){ return isPaidNodeType(type); }

// ─────────────────────────────────────────────────────────────────
// ATTESTATION
//
// Preuve cryptographique qu'un nœud a signé un challenge à un
// instant précis. Durée de validité : 5 minutes (anti-replay).
//
// Message signé : "attest:<alias>:<timestamp>:<nonce_hex>"
// Le nonce empêche la réutilisation d'une signature ancienne.
// ─────────────────────────────────────────────────────────────────

const ATTEST_TTL_MS   = 300_000;   // 5 min
const ATTEST_HMAC_KEY = new TextEncoder().encode('skyainet-attest-v1');
const TE              = new TextEncoder();

export class Attestation {
  constructor({ timestamp, signature, issuer, nonce, valid = true }) {
    this.timestamp = timestamp;
    this.signature = signature;   // Uint8Array — Dilithium5
    this.issuer    = issuer;
    this.nonce     = nonce;       // Uint8Array(16) — anti-replay
    this.valid     = valid;
  }

  isExpired()  { return Date.now() - this.timestamp > ATTEST_TTL_MS; }
  isRecent()   { return !this.isExpired(); }

  /** Message signé déterministe */
  static buildMessage(issuer, timestamp, nonce) {
    const nonceHex = Array.from(nonce).map(b => b.toString(16).padStart(2,'0')).join('');
    return TE.encode(`attest:${issuer}:${timestamp}:${nonceHex}`);
  }
}

// ─────────────────────────────────────────────────────────────────
// NODE IDENTITY
//
// Identité souveraine d'un nœud combinant :
//   - Clé Dilithium5 pour la signature post-quantique
//   - Réputation locale dynamique (EMA + peers)
//   - Gestion des attestations avec anti-replay par nonce
//   - HybridTransport disponible pour le chiffrement pair-à-pair
// ─────────────────────────────────────────────────────────────────

export class NodeIdentity {
  #signer;       // Dilithium5Signer
  #hybrid;       // HybridTransport — disponible pour chiffrement P2P
  #peers;        // Map<peerIdHex, { reputation, lastSeen }>
  #attestations; // Attestation[]

  constructor(sovereignAlias, opts = {}) {
    if (!sovereignAlias?.trim()) throw new Error('Alias souverain requis');

    this.#signer       = opts.signer ?? new Dilithium5Signer();
    this.#hybrid       = opts.hybrid ?? new HybridTransport(true);
    this.#peers        = new Map();
    this.#attestations = [];

    this.nodeId         = randomBytes(32);
    this.sovereignAlias = sovereignAlias.trim();
    this.publicKey      = this.#signer.publicKeyBytes();
    this.reputation     = opts.initialReputation ?? 0.82;
    this.capabilities   = opts.capabilities
      ?? defaultCapabilitiesForType(opts.nodeType ?? NodeType.Full);
    this.nodeType       = opts.nodeType ?? NodeType.Full;
    this.createdAt      = Date.now();
  }

  // ─── Accesseurs ───────────────────────────────────────────────

  get nodeIdHex() {
    return Array.from(this.nodeId).map(b => b.toString(16).padStart(2,'0')).join('');
  }

  get hybrid() { return this.#hybrid; }

  // ─── Signature ────────────────────────────────────────────────

  sign(message) {
    const msg = typeof message === 'string' ? TE.encode(message) : message;
    return this.#signer.sign(msg);
  }

  verify(message, signature) {
    const msg = typeof message === 'string' ? TE.encode(message) : message;
    return Dilithium5KeyPair.verify(this.publicKey, msg, signature);
  }

  // ─── Attestation ──────────────────────────────────────────────

  /**
   * Génère une attestation fraîche avec nonce aléatoire.
   * Le message est signé avec la clé Dilithium5 du nœud.
   */
  generateAttestation() {
    const timestamp = Date.now();
    const nonce     = randomBytes(16);
    const msg       = Attestation.buildMessage(this.sovereignAlias, timestamp, nonce);
    const signature = this.#signer.sign(msg);

    const attest    = new Attestation({ timestamp, signature, issuer: this.sovereignAlias, nonce });
    this.#attestations.push(attest);

    // Garder uniquement les 32 dernières
    if (this.#attestations.length > 32) this.#attestations.shift();

    return attest;
  }

  /**
   * Vérifie une attestation :
   *   1. Fraîcheur (TTL 5 min)
   *   2. Signature Dilithium5 via la clé publique du nœud
   *   3. Flag valid
   */
  verifyAttestation(attest) {
    if (!attest?.signature || !attest.issuer || !attest.nonce) return false;
    if (attest.isExpired?.() ?? (Date.now() - attest.timestamp > ATTEST_TTL_MS)) return false;
    if (!attest.valid) return false;

    const msg = Attestation.buildMessage(attest.issuer, attest.timestamp, attest.nonce);
    try {
      return Dilithium5KeyPair.verify(this.publicKey, msg, attest.signature);
    } catch { return false; }
  }

  /**
   * Retourne true si la dernière attestation est encore valide
   * et que la réputation du nœud est suffisante.
   */
  attest() {
    if (this.#attestations.length === 0) return false;
    const last = this.#attestations.at(-1);
    return this.verifyAttestation(last) && this.reputation > 0.65;
  }

  get attestations() { return [...this.#attestations]; }

  // ─── Réputation ───────────────────────────────────────────────

  /**
   * Met à jour la réputation par EMA (α = 0.15).
   * @param {number} delta — [-1, 1]
   */
  updateReputation(delta) {
    const alpha  = 0.15;
    const target = Math.max(0, Math.min(1, this.reputation + delta));
    this.reputation = +(this.reputation * (1 - alpha) + target * alpha).toFixed(4);
  }

  trustScore() {
    const bonus = this.attest() ? 0.12 : 0;
    return +Math.min(1, this.reputation + bonus).toFixed(4);
  }

  // ─── Gestion des pairs ────────────────────────────────────────

  registerPeer(peerId, initialReputation = 0.50) {
    const key = _peerKey(peerId);
    if (!this.#peers.has(key)) {
      this.#peers.set(key, {
        reputation: Math.max(0, Math.min(1, initialReputation)),
        lastSeen  : Date.now(),
      });
    }
    return this;
  }

  updatePeerReputation(peerId, delta) {
    const key  = _peerKey(peerId);
    const peer = this.#peers.get(key);
    if (!peer) return;
    peer.reputation = +Math.max(0, Math.min(1, peer.reputation + delta)).toFixed(4);
    peer.lastSeen   = Date.now();
  }

  isPeerTrusted(peerId, threshold = 0.68) {
    return (this.#peers.get(_peerKey(peerId))?.reputation ?? 0) > threshold;
  }

  getPeerReputation(peerId) {
    return this.#peers.get(_peerKey(peerId))?.reputation ?? null;
  }

  get registeredPeers() { return this.#peers; }

  // ─── Utilitaires ─────────────────────────────────────────────

  healthReport() {
    return {
      nodeId        : this.nodeIdHex.slice(0, 16),
      sovereignAlias: this.sovereignAlias,
      nodeType      : this.nodeType,
      reputation    : this.reputation,
      trustScore    : this.trustScore(),
      reputationTier: reputationTierFromScore(this.reputation),
      attestations  : this.#attestations.length,
      registeredPeers: this.#peers.size,
      capabilities  : this.capabilities.toJSON(),
    };
  }

  toJSON() {
    return {
      nodeId        : this.nodeIdHex,
      sovereignAlias: this.sovereignAlias,
      publicKey     : Array.from(this.publicKey).map(b => b.toString(16).padStart(2,'0')).join(''),
      nodeType      : this.nodeType,
      reputation    : this.reputation,
      trustScore    : this.trustScore(),
      reputationTier: reputationTierFromScore(this.reputation),
      attestations  : this.#attestations.length,
      trustedPeers  : this.#peers.size,
      createdAt     : this.createdAt,
    };
  }
}

// ─────────────────────────────────────────────────────────────────
// HELPER INTERNE
// ─────────────────────────────────────────────────────────────────

function _peerKey(peerId) {
  if (typeof peerId === 'string') return peerId.toLowerCase();
  return Array.from(peerId).map(b => b.toString(16).padStart(2,'0')).join('');
}

// ─────────────────────────────────────────────────────────────────
// EXPORT PAR DÉFAUT — compatibilité
// ─────────────────────────────────────────────────────────────────

export default {
  NodeType, NodeRole, NodeState, SubscriptionLevel, ReputationTier,
  NodeCapabilities, NodeIdentity, Attestation,
  isPaidNodeType, monthlyPriceEur, computeMultiplier,
  isOperationalState, isPaidSubscription, reputationTierFromScore,
  defaultCapabilitiesForType, isEdgeNode, requiresPaidSubscription,
};
