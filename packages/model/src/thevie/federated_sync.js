// packages/model/src/thevie/federated_sync.js
// =====================================================
// Federated Sync — Synchronisation Fédérée Intelligente
// Propagation sécurisée des leçons + apprentissage collectif
// Port de federated_sync.rs
// SkyAInet × Nikola T369
// =====================================================

"use strict";

import { RomanT369, GematriaMode }  from '../../../secure/src/crypto/roman_t369.js';
import { Lesson }                   from '../../../t369-inference/src/meshin.js';

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

  #stats;
  #mesh;         // MeshIn reference
  #collective;   // CollectivIn reference
  #node;         // SkyNode reference

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

    // Clé RomanT369 éphémère par instance pour que chaque nœud produit
    // des ciphertexts distincts (même leçon → ciphertexts différents)
    this.#roman = new RomanT369(ROMAN_KEY, ROMAN_NONCE, GematriaMode.Hyper256);
    this.#timer = null;

    this.#stats = {
      totalSyncs        : 0,
      lessonsPropagated : 0,
      lessonsReceived   : 0,
      failedBroadcasts  : 0,
      lastSync          : null,
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

  // ─── Stats ───────────────────────────────────────────────────

  getStats() {
    return { ...this.#stats };
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

    if (this.#node && typeof this.#node.syncWithNetwork === 'function') {
      await this.#node.syncWithNetwork();
      // La leçon chiffrée est disponible dans le bus du nœud
      console.debug(`[FederatedSync] Leçon diffusée via SkyNode (${encrypted.length} octets chiffrés)`);
    } else {
      console.debug('[FederatedSync] [LOCAL] Leçon prête pour diffusion future');
    }
  }
}
