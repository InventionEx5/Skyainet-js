// packages/sentinel/src/anti_fork.js
// =====================================================
// AntiFork — Détection & Auto‑Défense Anti‑Fork
// SkyAInet — hauteur, hash, réputation + quarantaine
// SkyAInet × Nikola T369
// =====================================================

"use strict";

import { randomUUID }          from 'crypto';
import { Dilithium5Signer }    from '../../secure/src/crypto/dilithium.js';
import { hmacSha256 }          from '../../secure/src/crypto/sha_fips.js';
import { UserRewards }         from '../../core/src/rewards.js';

// ─────────────────────────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────────────────────────

const QUARANTINE_TTL_MS       = 3_600_000;   // 1 h par défaut
const REPUTATION_PENALTY      = 0.25;        // pénalité par quarantaine
const REPUTATION_FLOOR        = 0.10;
const REWARD_FORK_DETECTED    = 35;          // SKY par détection réussie
const TE                      = new TextEncoder();

// ─────────────────────────────────────────────────────────────────
// NIVEAUX DE GRAVITÉ
// ─────────────────────────────────────────────────────────────────

export const ForkSeverity = Object.freeze({
  Warning : 'Warning',
  Minor   : 'Minor',
  Major   : 'Major',
  Critical: 'Critical',
});

// ─────────────────────────────────────────────────────────────────
// FORK EVENT
// ─────────────────────────────────────────────────────────────────

export class ForkEvent {
  constructor(severity, description, affectedNodes, evidence) {
    this.id            = randomUUID();
    this.timestamp     = new Date();
    this.severity      = severity;
    this.description   = description;
    this.affectedNodes = affectedNodes;
    this.evidence      = evidence;
  }

  toJSON() {
    return {
      id           : this.id,
      timestamp    : this.timestamp.toISOString(),
      severity     : this.severity,
      description  : this.description,
      affectedNodes: this.affectedNodes,
      evidence     : this.evidence,
    };
  }

  static fromJSON(json) {
    const e = new ForkEvent(json.severity, json.description, json.affectedNodes, json.evidence);
    e.id        = json.id ?? randomUUID();
    e.timestamp = new Date(json.timestamp);
    return e;
  }
}

// ─────────────────────────────────────────────────────────────────
// ANTI FORK
// ─────────────────────────────────────────────────────────────────

export class AntiFork {
  #signer;            // Dilithium5Signer — signature des preuves de fork
  #quarantined;       // Map<peerId, { since, reputation }>
  #events;            // ForkEvent[]
  #peerReputations;   // Map<peerId, number> — suivi local des réputations

  constructor(opts = {}) {
    this.forkThresholdHeight    = opts.thresholdHeight    ?? 5;
    this.forkThresholdHashMiss  = opts.thresholdHashMiss  ?? 2;
    this.quarantineTtlMs        = opts.quarantineTtlMs    ?? QUARANTINE_TTL_MS;

    this.#signer           = new Dilithium5Signer();
    this.#quarantined      = new Map();
    this.#events           = [];
    this.#peerReputations  = new Map();
  }

  // ─── Détection ────────────────────────────────────────────────

  /**
   * Analyse les pairs et détecte les forks potentiels.
   *
   * Deux critères indépendants :
   *   1. Écart de hauteur > forkThresholdHeight → Major
   *   2. Hash différent ET pair réputé (score > 0.60) → Critical
   *
   * Si des forks sont détectés, les pairs impliqués sont mis en
   * quarantaine et des récompenses de sécurité sont attribuées.
   *
   * @param {number}   localHeight
   * @param {string}   localHash
   * @param {Array<{peerId:string, height:number, hash:string, reputation:number}>} peers
   * @param {object}   node     — SkyNode (lecture seule via getStatus/getPeers)
   * @param {UserRewards|null} rewards
   * @returns {ForkEvent[]}
   */
  detectFork(localHeight, localHash, peers, node, rewards = null) {
    const detected = [];

    // Expire les quarantaines périmées avant la détection
    this.#expireQuarantines();

    for (const peer of peers) {
      const { peerId, height, hash, reputation } = peer;

      // Mise à jour de la réputation locale du pair
      this.#peerReputations.set(peerId, Math.max(0, Math.min(1, reputation)));

      // 1. Écart de hauteur
      const heightDiff = Math.abs(height - localHeight);
      if (heightDiff > this.forkThresholdHeight) {
        const evt = new ForkEvent(
          ForkSeverity.Major,
          `Fork par hauteur avec le pair ${peerId}`,
          [peerId],
          `heightDiff=${heightDiff} (local=${localHeight}, peer=${height})`
        );
        detected.push(evt);
        this.#applyQuarantine(peerId, node, REPUTATION_PENALTY);
      }

      // 2. Hash différent (seulement si pair réputé — évite les faux positifs)
      if (hash !== localHash && reputation > 0.60 && !detected.find(e => e.affectedNodes.includes(peerId))) {
        const evidenceHash = this.#signEvidence(`${localHash}|${hash}|${peerId}`);
        const evt = new ForkEvent(
          ForkSeverity.Critical,
          `Mismatch de hash avec le pair ${peerId}`,
          [peerId],
          `local=${localHash.slice(0,16)}… peer=${hash.slice(0,16)}… sig=${evidenceHash}`
        );
        detected.push(evt);
        this.#applyQuarantine(peerId, node, REPUTATION_PENALTY * 1.5);
      }
    }

    if (detected.length > 0) {
      this.#events.push(...detected);
      console.warn(`[AntiFork] ${detected.length} fork(s) détecté(s) — sévérités: ${detected.map(e => e.severity).join(', ')}`);

      // Récompense de sécurité — UserRewards.addReward n'existe pas
      if (rewards instanceof UserRewards) {
        rewards.totalSkyEarned += REWARD_FORK_DETECTED * detected.length;
      }
    }

    return detected;
  }

  // ─── Quarantaine ──────────────────────────────────────────────

  /**
   * Met un pair en quarantaine et pénalise sa réputation locale.
   * N'accède pas aux champs internes de SkyNode (tout est privé) —
   * notifie via `node.removePeer(peerId)` si disponible.
   */
  #applyQuarantine(peerId, node, penalty) {
    const currentRep = this.#peerReputations.get(peerId) ?? 0.5;
    this.#quarantined.set(peerId, {
      since     : Date.now(),
      reputation: Math.max(REPUTATION_FLOOR, currentRep - penalty),
    });
    this.#peerReputations.set(peerId, Math.max(REPUTATION_FLOOR, currentRep - penalty));

    // Déconnecte le pair du nœud si l'API le permet
    if (node && typeof node.removePeer === 'function') {
      node.removePeer(peerId);
    }

    console.warn(`[AntiFork] Pair ${peerId.slice(0, 16)} mis en quarantaine (-${(penalty*100).toFixed(0)}% rép)`);
  }

  quarantineNode(peerId, node) {
    this.#applyQuarantine(peerId, node, REPUTATION_PENALTY);
  }

  releaseQuarantine(peerId) {
    return this.#quarantined.delete(peerId);
  }

  isQuarantined(peerId) {
    return this.#quarantined.has(peerId);
  }

  // ─── Signature de preuve ──────────────────────────────────────

  /**
   * Signe une preuve de fork avec Dilithium5 et retourne les 8 premiers
   * octets en hex — suffisant comme fingerprint d'évidence dans les logs.
   */
  #signEvidence(evidence) {
    const sig = this.#signer.sign(TE.encode(evidence));
    return Array.from(sig.subarray(0, 8)).map(b => b.toString(16).padStart(2,'0')).join('');
  }

  // ─── Nettoyage ────────────────────────────────────────────────

  #expireQuarantines() {
    const now = Date.now();
    for (const [peerId, entry] of this.#quarantined) {
      if (now - entry.since > this.quarantineTtlMs) {
        this.#quarantined.delete(peerId);
        console.debug(`[AntiFork] Quarantaine expirée pour ${peerId.slice(0,16)}`);
      }
    }
  }

  pruneEvents(maxAgeDays = 30) {
    const cutoff = Date.now() - maxAgeDays * 86_400_000;
    const before = this.#events.length;
    this.#events  = this.#events.filter(e => e.timestamp.getTime() > cutoff);
    return before - this.#events.length;
  }

  // ─── Lecture ─────────────────────────────────────────────────

  getEvents(severity = null) {
    return severity
      ? this.#events.filter(e => e.severity === severity)
      : [...this.#events];
  }

  getQuarantined() {
    return [...this.#quarantined.entries()].map(([id, e]) => ({
      peerId    : id,
      since     : new Date(e.since).toISOString(),
      reputation: e.reputation,
    }));
  }

  getPeerReputation(peerId) {
    return this.#peerReputations.get(peerId) ?? null;
  }

  summary() {
    return {
      totalEvents     : this.#events.length,
      quarantined     : this.#quarantined.size,
      thresholdHeight : this.forkThresholdHeight,
      criticalEvents  : this.#events.filter(e => e.severity === ForkSeverity.Critical).length,
      majorEvents     : this.#events.filter(e => e.severity === ForkSeverity.Major).length,
    };
  }
}
