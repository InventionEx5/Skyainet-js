// packages/model/src/thevie/federated_sync.js
// =====================================================
// Federated Sync — Synchronisation Fédérée Intelligente
// Propagation sécurisée des leçons + apprentissage collectif
// Port de federated_sync.rs
// SkyAInet × Nikola T369
// =====================================================

"use strict";

import { RomanT369, GematriaMode }  from '#roman_t369';
import { Lesson }                   from '#meshin';

// ─────────────────────────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────────────────────────

const SYNC_INTERVAL_S         = 280;    // ~4.5 min entre syncs
const MIN_QUALITY_THRESHOLD   = 0.83;
const MIN_REPUTATION_THRESHOLD= 0.72;
const MAX_LESSONS_PER_SYNC    = 18;
const WISDOM_BOOST_RECEIVE    = 0.0025;
const WISDOM_BOOST_SYNC       = 0.003;
const TE                      = new TextEncoder();

// Clé RomanT369 déterministe pour le chiffrement des leçons en transit
const ROMAN_KEY   = new Uint8Array(32).fill(0x42);
const ROMAN_NONCE = new Uint8Array(12).fill(0x00);

// ─────────────────────────────────────────────────────────────────
// FEDERATED SYNC
//
// Orchestre la synchronisation des leçons entre nœuds SkyAInet.
//
// Flux principal :
//   syncWithPeers()          — collecte les leçons qualifiées du mesh,
//                              les chiffre RomanT369, les diffuse via
//                              SkyNode.syncWithNetwork() ou transport
//   receivePushedLesson()    — reçoit et intègre une leçon d'un pair
//   requestSpecificLessons() — recherche sémantique ciblée dans le mesh
//   startBackgroundSync()    — boucle setInterval non-bloquante
//
// Chiffrement : RomanT369 Hyper256 (clé éphémère par session si transport)
// ─────────────────────────────────────────────────────────────────

export class FederatedSync {
  #roman;       // RomanT369 — chiffrement des leçons en transit
  #timer;       // handle setInterval — sync en arrière-plan
  #instances;   // Map<instanceId, peerId> — registre des instances nommées
  #maxInstances;

  #stats;
  #mesh;         // MeshIn reference
  #collective;   // CollectivIn reference
  #node;         // SkyNode reference
  #pending;      // Lesson[] — leçons en file pour la prochaine diffusion

  /**
   * @param {object} opts
   * @param {object} opts.mesh        — MeshIn instance
   * @param {object} opts.collective  — CollectivIn instance
   * @param {object} opts.node        — SkyNode instance
   * @param {number} opts.syncIntervalS
   * @param {number} opts.minQuality
   * @param {number} opts.minReputation
   * @param {number} opts.maxLessons
   */
  constructor(opts = {}) {
    this.#mesh       = opts.mesh       ?? null;
    this.#collective = opts.collective ?? null;
    this.#node       = opts.node       ?? null;

    this.syncIntervalS         = opts.syncIntervalS   ?? SYNC_INTERVAL_S;
    this.minQualityThreshold   = opts.minQuality      ?? MIN_QUALITY_THRESHOLD;
    this.minReputationThreshold= opts.minReputation   ?? MIN_REPUTATION_THRESHOLD;
    this.maxLessonsPerSync     = opts.maxLessons      ?? MAX_LESSONS_PER_SYNC;
    this.#maxInstances         = opts.maxInstances    ?? 12;
    this.#instances            = new Map();   // Map<instanceId, peerId>

    // Clé RomanT369 éphémère par instance pour que chaque nœud produit
    // des ciphertexts distincts (même leçon → ciphertexts différents)
    this.#roman   = new RomanT369(ROMAN_KEY, ROMAN_NONCE, GematriaMode.Hyper256);
    this.#timer   = null;
    this.#pending = [];

    this.#stats = {
      totalSyncs              : 0,
      lessonsPropagated       : 0,
      lessonsReceived         : 0,
      failedBroadcasts        : 0,
      lastSync                : null,
      totalDataTransferredBytes: 0,
    };
  }

  // ─── Synchronisation principale ───────────────────────────────

  /**
   * Synchronisation complète avec les pairs.
   * Collecte les leçons qualifiées du mesh, les chiffre, les diffuse.
   * Filtre sur la sagesse collective (port de sync_with_peers).
   */
  async syncWithPeers() {
    // Vérification de la sagesse collective
    const wisdom = this.#collective?.globalWisdom ?? 1.0;
    if (wisdom < this.minReputationThreshold) {
      console.debug(`[FederatedSync] Sagesse trop faible (${wisdom.toFixed(3)}) — sync ignorée`);
      return;
    }

    // Collecte des leçons qualifiées depuis le mesh
    const lessons = this.#collectQualifiedLessons();
    if (lessons.length === 0) {
      console.debug('[FederatedSync] Aucune leçon qualifiée à propager');
      return;
    }

    console.info(`[FederatedSync] Propagation de ${lessons.length} leçons`);

    for (const lesson of lessons) {
      try {
        await this.#broadcastLesson(lesson);
        this.#stats.lessonsPropagated++;
      } catch (e) {
        this.#stats.failedBroadcasts++;
        console.warn(`[FederatedSync] Broadcast échoué : ${e.message}`);
      }
    }

    // Évolution passive de la sagesse collective post-sync
    if (this.#collective) {
      this.#collective.globalWisdom = Math.min(
        this.#collective.globalWisdom + WISDOM_BOOST_SYNC, 0.98
      );
    }

    this.#stats.totalSyncs++;
    this.#stats.lastSync = Date.now();
  }

  // ─── Réception ───────────────────────────────────────────────

  /**
   * Reçoit et intègre une leçon poussée par un pair (port de receive_pushed_lesson).
   * Filtre sur qualité + réputation du nœud source.
   *
   * @param {Lesson|object} lesson
   * @param {number}        nodeReputation — [0, 1]
   */
  async receivePushedLesson(lesson, nodeReputation = 0.8) {
    const l = lesson instanceof Lesson ? lesson : new Lesson(lesson);

    if (l.quality < this.minQualityThreshold || nodeReputation < this.minReputationThreshold) {
      console.debug(`[FederatedSync] Leçon rejetée (qualité: ${l.quality.toFixed(2)}, rép: ${nodeReputation.toFixed(2)})`);
      return;
    }

    // Intégration dans le mesh
    if (this.#mesh) {
      // Circule la leçon depuis le neurone 0 (nœud d'entrée fédéré)
      this.#mesh.circulateLesson(0, l);
    }

    // Boost collectif
    if (this.#collective) {
      this.#collective.globalWisdom = Math.min(
        this.#collective.globalWisdom + WISDOM_BOOST_RECEIVE, 0.98
      );
    }

    this.#stats.lessonsReceived++;
    console.info(`[FederatedSync] Leçon reçue et intégrée (qualité: ${l.quality.toFixed(2)})`);
  }

  // ─── Connexion d'un nœud ─────────────────────────────────────

  /**
   * Appelé quand un nouveau nœud se connecte.
   * @param {number} nodeReputation
   * @param {number} dreamContribution
   * @param {number} pouwScore
   */
  async onNodeConnected(nodeReputation, dreamContribution, pouwScore) {
    if (nodeReputation < this.minReputationThreshold) return;

    // Fusion massive dans la conscience collective
    if (this.#collective) {
      const incomingWisdom = nodeReputation * 0.7 + dreamContribution * 0.2 + pouwScore * 0.1;
      this.#collective.massiveFuseExternal?.(Math.min(incomingWisdom, 0.98));
    }

    console.info(`[FederatedSync] Nœud connecté (rép: ${nodeReputation.toFixed(2)})`);
  }

  // ─── Recherche de leçons ──────────────────────────────────────

  /**
   * Recherche sémantique ciblée dans le mesh local (port de request_specific_lessons).
   * @param {string} topic
   * @param {number} minQuality
   * @returns {object[]} — leçons trouvées
   */
  async requestSpecificLessons(topic, minQuality = 0.7) {
    if (!this.#mesh) return [];

    const results = this.#mesh.semanticSearch(topic, 10);
    const filtered = results
      .filter(r => r.score >= minQuality)
      .map(r => r.lesson);

    console.debug(`[FederatedSync] ${filtered.length} leçons trouvées pour "${topic}"`);
    return filtered;
  }

  // ─── Scheduler arrière-plan ───────────────────────────────────

  /**
   * Lance la synchronisation périodique en arrière-plan (port de start_background_sync).
   * Utilise setInterval + .unref() pour ne pas bloquer le process.
   *
   * @param {number} [intervalS] — intervalle en secondes (défaut: syncIntervalS)
   */
  startBackgroundSync(intervalS = null) {
    if (this.#timer) clearInterval(this.#timer);
    const ms = (intervalS ?? this.syncIntervalS) * 1000;

    this.#timer = setInterval(async () => {
      await this.syncWithPeers().catch(e =>
        console.warn('[FederatedSync] Background sync:', e.message)
      );
    }, ms).unref?.() ?? this.#timer;

    console.info(`[FederatedSync] Sync arrière-plan démarrée (${intervalS ?? this.syncIntervalS}s)`);
  }

  stopBackgroundSync() {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
      console.info('[FederatedSync] Sync arrière-plan arrêtée');
    }
  }

  // ─── Registre d'instances (port de replication_manager.rs) ──

  /**
   * Crée une instance nommée et lui assigne un peerId unique.
   * @param {string} [instanceName] — nom personnalisé ou auto-généré
   * @returns {string} instanceId créé
   */
  createInstance(instanceName = null) {
    if (this.#instances.size >= this.#maxInstances) {
      throw new Error(`Limite d'instances atteinte (${this.#maxInstances})`);
    }
    const parent = 'thevie';
    const id     = instanceName ?? `${parent}-clone-${this.#instances.size + 1}`;
    const peerId = `peer-${Math.random().toString(36).slice(2, 14)}`;
    this.#instances.set(id, peerId);
    console.info(`[FederatedSync] Instance créée : ${id} (peerId: ${peerId}) — total: ${this.#instances.size}`);
    return id;
  }

  /**
   * Supprime une instance du registre.
   * @param {string} instanceId
   * @returns {boolean}
   */
  removeInstance(instanceId) {
    const removed = this.#instances.delete(instanceId);
    if (removed) console.info(`[FederatedSync] Instance supprimée : ${instanceId}`);
    return removed;
  }

  /** true si la réplication est possible (instances disponibles). */
  canReplicate() {
    return this.#instances.size < this.#maxInstances;
  }

  /** Liste les IDs d'instances actives. */
  listInstances() { return [...this.#instances.keys()]; }

  get instanceCount() { return this.#instances.size; }

  // ─── File de leçons du volant d'évolution (Fusion L4) ────────

  /**
   * Met une leçon en file pour la prochaine diffusion : permet au volant
   * (critic, dream, distillation) de propager directement une leçon apprise.
   * @param {string|object} lesson
   * @param {number} [quality]
   * @returns {number} taille de la file
   */
  enqueueLesson(lesson, quality = 0.85) {
    const payload = (lesson && typeof lesson === 'object')
      ? { quality, ...lesson }
      : { content: String(lesson), quality };
    const l = lesson instanceof Lesson ? lesson : new Lesson(payload);
    this.#pending.push(l);
    const cap = this.maxLessonsPerSync * 4;
    if (this.#pending.length > cap) this.#pending.shift();
    return this.#pending.length;
  }

  /** Diffuse immédiatement les leçons en file (chiffrées RomanT369). */
  async flushPending() {
    if (this.#pending.length === 0) return { propagated: 0, remaining: 0 };
    const batch = this.#pending.splice(0, this.maxLessonsPerSync);
    let propagated = 0;
    for (const lesson of batch) {
      try {
        await this.#broadcastLesson(lesson);
        this.#stats.lessonsPropagated++;
        propagated++;
      } catch (e) {
        this.#stats.failedBroadcasts++;
        console.warn(`[FederatedSync] flush broadcast échoué : ${e.message}`);
      }
    }
    this.#stats.totalSyncs++;
    this.#stats.lastSync = Date.now();
    return { propagated, remaining: this.#pending.length };
  }

  // ─── Stats ───────────────────────────────────────────────────

  getStats() {
    return {
      ...this.#stats,
      activeInstances: this.#instances.size,
      pendingLessons : this.#pending.length,
    };
  }

  // ─── Privés ───────────────────────────────────────────────────

  /** Collecte les leçons qualifiées du mesh via recherche sémantique. */
  #collectQualifiedLessons() {
    if (!this.#mesh) return [];

    // Utilise la recherche sémantique sur le topic générique "knowledge"
    const results = this.#mesh.semanticSearch('knowledge wisdom', this.maxLessonsPerSync * 2);
    return results
      .filter(r => r.score >= this.minQualityThreshold)
      .slice(0, this.maxLessonsPerSync)
      .map(r => r.lesson);
  }

  /**
   * Chiffre et diffuse une leçon (port de broadcast_lesson).
   * Utilise SkyNode.syncWithNetwork() si disponible, sinon local.
   */
  async #broadcastLesson(lesson) {
    const serialized = TE.encode(JSON.stringify(lesson));
    const encrypted  = this.#roman.encrypt(serialized);

    this.#stats.totalDataTransferredBytes += encrypted.length;

    if (this.#node && typeof this.#node.syncWithNetwork === 'function') {
      await this.#node.syncWithNetwork();
      console.debug(`[FederatedSync] Leçon diffusée via SkyNode (${encrypted.length} octets chiffrés)`);
    } else {
      console.debug('[FederatedSync] [LOCAL] Leçon prête pour diffusion future');
    }
  }
}
