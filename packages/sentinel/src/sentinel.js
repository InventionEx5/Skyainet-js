// packages/sentinel/src/sentinel.js
// =====================================================
// Sentinel — Superviseur Unifié du Réseau SkyAInet
// Orchestre AntiFork + AutoHealing + Monitoring continu
// SkyAInet × Nikola T369
// =====================================================

"use strict";

import { UserRewards }         from '../../core/src/rewards.js';
import { AntiFork, ForkSeverity } from './anti_fork.js';
import { Sentinel as AutoHealing, IssueSeverity, HealingAction } from './auto_healing.js';

// ─────────────────────────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────────────────────────

const MONITOR_INTERVAL_MS   = 30_000;  // vérification toutes les 30 s
const PEER_SYNC_INTERVAL_MS = 60_000;  // sync réseau toutes les 60 s
const HISTORY_MAX           = 512;

// ─────────────────────────────────────────────────────────────────
// SENTINEL PRINCIPAL
//
// Point d'entrée unique pour la supervision d'un SkyNode.
// Délègue à AntiFork pour la détection de fork et à AutoHealing
// pour la guérison. Ajoute un monitoring périodique automatique.
// ─────────────────────────────────────────────────────────────────

export class Sentinel {
  #antiFork;          // AntiFork
  #autoHealing;       // AutoHealing (Sentinel interne)
  #node;              // SkyNode
  #rewards;           // UserRewards | null
  #monitorTimer;      // handle setInterval
  #peerSyncTimer;     // handle setInterval
  #eventHistory;      // { type, ts, summary }[]
  #isRunning;

  constructor(node, opts = {}) {
    if (!node) throw new Error('SkyNode requis');
    this.#node         = node;
    this.#rewards      = opts.rewards ?? null;
    this.#antiFork     = new AntiFork({
      thresholdHeight : opts.forkThresholdHeight   ?? 5,
      thresholdHashMiss: opts.forkThresholdHashMiss ?? 2,
      quarantineTtlMs : opts.quarantineTtlMs        ?? 3_600_000,
    });
    this.#autoHealing  = new AutoHealing();
    this.#eventHistory = [];
    this.#isRunning    = false;
    this.#monitorTimer = null;
    this.#peerSyncTimer= null;
  }

  // ─── Démarrage / Arrêt ───────────────────────────────────────

  /**
   * Lance le monitoring périodique automatique.
   * - Toutes les 30 s : détection de problèmes + guérison si nécessaire
   * - Toutes les 60 s : sync réseau + détection de fork sur les pairs
   */
  start() {
    if (this.#isRunning) return this;

    this.#isRunning = true;

    this.#monitorTimer = setInterval(async () => {
      await this.#runHealthCheck();
    }, MONITOR_INTERVAL_MS).unref();

    this.#peerSyncTimer = setInterval(async () => {
      await this.#runPeerCheck();
    }, PEER_SYNC_INTERVAL_MS).unref();

    console.info('[Sentinel] Démarré — monitoring toutes les 30 s');
    return this;
  }

  stop() {
    clearInterval(this.#monitorTimer);
    clearInterval(this.#peerSyncTimer);
    this.#isRunning = false;
    console.info('[Sentinel] Arrêté');
  }

  get isRunning() { return this.#isRunning; }

  // ─── Vérification manuelle ────────────────────────────────────

  /**
   * Déclenche immédiatement une vérification complète du nœud.
   * Utile pour une intégration dans une boucle applicative
   * (ex. processQuery dans thevie.js après N requêtes).
   */
  async runCheck() {
    await this.#runHealthCheck();
    await this.#runPeerCheck();
  }

  // ─── Fork detection — API directe ────────────────────────────

  /**
   * Vérifie manuellement une liste de pairs pour détecter un fork.
   * @param {number} localHeight
   * @param {string} localHash
   * @param {Array<{peerId, height, hash, reputation}>} peers
   * @returns {import('./anti_fork.js').ForkEvent[]}
   */
  detectFork(localHeight, localHash, peers) {
    const events = this.#antiFork.detectFork(
      localHeight, localHash, peers, this.#node, this.#rewards
    );
    if (events.length > 0) this.#record('fork', `${events.length} fork(s)`);
    return events;
  }

  // ─── Guérison manuelle ────────────────────────────────────────

  async healNode() {
    const issues = this.#autoHealing.detectIssues(this.#node);
    if (issues.length > 0) {
      await this.#autoHealing.triggerHealing(issues, this.#node, this.#rewards);
      this.#record('heal', `${issues.length} issue(s) traité(s)`);
    }
    return issues;
  }

  // ─── Accès aux sous-modules ──────────────────────────────────

  get antiFork()    { return this.#antiFork; }
  get autoHealing() { return this.#autoHealing; }

  // ─── Rapport global ───────────────────────────────────────────

  fullReport() {
    const status = this.#node.getStatus();
    return {
      node           : { id: status.id, wisdomScore: status.wisdomScore, state: status.state, peers: status.peers, engineReady: status.engineReady },
      antiFork       : this.#antiFork.summary(),
      autoHealing    : this.#autoHealing.summary(),
      eventHistory   : this.#eventHistory.slice(-20),
      isRunning      : this.#isRunning,
    };
  }

  // ─── Privés ───────────────────────────────────────────────────

  async #runHealthCheck() {
    try {
      const issues = this.#autoHealing.detectIssues(this.#node);
      if (issues.length > 0) {
        await this.#autoHealing.triggerHealing(issues, this.#node, this.#rewards);
        this.#record('health', `${issues.length} issue(s)`);
      }
    } catch (e) {
      console.warn('[Sentinel] Health check:', e.message);
    }
  }

  async #runPeerCheck() {
    try {
      // Sync réseau
      await this.#node.syncWithNetwork().catch(() => {});

      // Récupère les pairs actifs
      const peers    = this.#node.getPeers();
      if (peers.length === 0) return;

      const status   = this.#node.getStatus();
      // Hash local fictif basé sur le wisdomScore + evolutionCycles (proxy stable)
      const localHash = `${status.wisdomScore.toFixed(6)}:${status.evolutionCycles}`;

      // Construit les données de pairs pour AntiFork
      const peerData = peers.map(p => ({
        peerId    : p.id,
        height    : 0,         // sans blockchain réelle, hauteur = 0 pour tous
        hash      : localHash, // on suppose que les pairs honnêtes ont le même hash
        reputation: p.reputation ?? 0.7,
      }));

      this.#antiFork.detectFork(0, localHash, peerData, this.#node, this.#rewards);
      this.#antiFork.pruneEvents(30);

    } catch (e) {
      console.warn('[Sentinel] Peer check:', e.message);
    }
  }

  #record(type, summary) {
    this.#eventHistory.push({ type, summary, ts: new Date().toISOString() });
    if (this.#eventHistory.length > HISTORY_MAX) this.#eventHistory.shift();
  }
}

// Export des types utilitaires pour les callers
export { ForkSeverity, IssueSeverity, HealingAction };
export { AntiFork }   from './anti_fork.js';
export { Sentinel as AutoHealing } from './auto_healing.js';
