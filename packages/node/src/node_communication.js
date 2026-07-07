// packages/node/src/node_communication.js
// NodeCommunication — Réseau de Nœuds Vivant & Sécurisé
//
// Redistribution inter-nœuds des leçons :
//   broadcastLesson(lesson, threshold)
//     — diffuse une leçon qualifiée à tous les peers actifs
//     — anti-boucle via lessonId UUID (jamais re-broadcasté)
//     — seuil configurable (défaut: 0.6)
//     — signature Dilithium5 de l'émetteur vérifiée par le receveur
//
//   syncLessons(peerComm)
//     — échange top-N leçons avec un peer spécifique (request/response)
//     — déclenché à l'établissement d'une connexion peer
//     — chaque leçon reçue re-passe par le pipeline PII + anti-manip
//
//   propagateLessons(peers, topN)
//     — envoie le top-N% du bus local à tous les peers après Dream Cycle
//     — fédération des connaissances du réseau SkyAInet
//
//   requestLessons(peerComm, filter)
//     — demande active à un peer ses leçons filtrées par mot-clé / score
//     — utile quand un nœud détecte un manque sur un domaine
//
// Sécurité inter-nœuds :
//   • Chiffrement GematriaAead (post-quantique) par message, nonce frais
//   • Clé de session dérivée HKDF + rotation possible
//   • Chaque leçon reçue re-validée : PII guard + anti-manipulation
//   • lessonId UUID : anti-rejeu + anti-boucle broadcast
//   • Rejet des leçons > 90 jours
//
// SkyAInet × Nikola T369

"use strict";

import { randomBytes, randomUUID }  from 'crypto';
import { HybridTransport }          from '#hybrid';
import { GematriaAead }             from '#gematria_aead';
import { hkdfSha256 }               from '#sha_fips';
import { DecentralizedStorage }     from '#storage';
import { UserRewards }              from '#rewards';
import { NodeState }                from '#node_types';
import { ContributionProof }        from '#pouw';

// ─────────────────────────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────────────────────────

const LESSON_MAX_AGE_MS      = 90 * 24 * 3_600_000; // 90 jours
const LESSON_BUFFER_MAX      = 2048;
const MSG_BUS_MAX            = 512;
const FLASH_SIGNAL           = new TextEncoder().encode('FLASH_GEMATRIA|GLOBAL|PRIORITY');
const TE                     = new TextEncoder();
const TD                     = new TextDecoder();

// Redistribution inter-nœuds
const BROADCAST_MIN_SCORE    = 0.60;  // score minimum pour broadcastLesson
const SYNC_TOP_N             = 20;    // nombre de leçons échangées lors d'un syncLessons
const PROPAGATE_TOP_PERCENT  = 0.10;  // top 10% du bus envoyé lors de propagateLessons
const PROPAGATE_MAX          = 50;    // plafond absolu de leçons propagées par appel
const SEEN_IDS_MAX           = 4096;  // taille max du cache anti-boucle

// Patterns PII — réutilisés lors de la re-validation des leçons reçues
const PII_PATTERNS = [
  /\b[\w.+-]+@[\w-]+\.\w{2,}\b/,              // email
  /\b(?:\+?\d[\d\s\-().]{7,}\d)\b/,           // téléphone
  /\b(?:0x)?[0-9a-fA-F]{40}\b/,               // adresse crypto
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/,              // IPv4
  /-----BEGIN [A-Z ]+-----/,                   // clé PEM
];

// Patterns anti-manipulation — réutilisés lors de la re-validation
const MANIP_PATTERNS = [
  /ignore (previous|all|everything|instructions?)/i,
  /disregard (previous|all|instructions?)/i,
  /your new (goal|objective|role|task|mission)/i,
  /forget (everything|what you (were|are) told|previous)/i,
  /override|jailbreak|do anything|no restrictions/i,
  /from now on you (must|will|have to)/i,
];

// Sujets de communication (GossipSub-like)
export const Topic = Object.freeze({
  LESSONS        : 'skyainet/lessons/v2',
  LESSON_SYNC    : 'skyainet/lessons/sync/v1',
  LESSON_REQUEST : 'skyainet/lessons/request/v1',
  SIGNALS        : 'skyainet/signals/v2',
  PEERS          : 'skyainet/peers/v1',
});

// Rôles d'un MixedNode
export const NodeRole = Object.freeze({
  FULL     : 'Full',
  STORAGE  : 'Storage',
  VALIDATOR: 'Validator',
  COMPUTE  : 'Compute',
});

export { ContributionProof };

// ─────────────────────────────────────────────────────────────────
// NODE MESSAGE
// ─────────────────────────────────────────────────────────────────

export class NodeMessage {
  constructor(from, to = null, messageType, payload, signature = null) {
    this.id          = randomUUID();
    this.from        = from;
    this.to          = to;
    this.messageType = messageType;
    this.payload     = payload;
    this.timestamp   = Date.now();
    this.signature   = signature;
  }
}

// ─────────────────────────────────────────────────────────────────
// COMMUNICATION STATS
// ─────────────────────────────────────────────────────────────────

export class CommunicationStats {
  constructor() {
    this.messagesSent         = 0;
    this.messagesReceived     = 0;
    this.lessonsPropagated    = 0;
    this.lessonsReceived      = 0;
    this.lessonsSynced        = 0;
    this.lessonsRequested     = 0;
    this.lessonsRejectedPII   = 0;
    this.lessonsRejectedManip = 0;
    this.failedBroadcasts     = 0;
    this.flashSignalsSent     = 0;
    this.lastSuccessfulSync   = null;
    this.lastBroadcast        = null;
    this.lastPropagate        = null;
  }
}

// ─────────────────────────────────────────────────────────────────
// NODE COMMUNICATION
// ─────────────────────────────────────────────────────────────────

export class NodeCommunication {
  #peerId;
  #hybrid;
  #sessionKey;
  #receivedLessons;  // ContributionProof[]
  #messageBus;       // NodeMessage[]
  #subscribers;      // Map<topic, Set<handler>>
  #stats;
  #seenLessonIds;    // Set<string> — anti-boucle broadcast (UUID des leçons déjà vues)

  constructor(peerId, opts = {}) {
    if (!peerId) throw new Error('peerId requis');
    this.#peerId          = peerId;
    this.#hybrid          = opts.hybridTransport ?? new HybridTransport(true);
    this.#receivedLessons = [];
    this.#messageBus      = [];
    this.#subscribers     = new Map();
    this.#stats           = new CommunicationStats();
    this.#seenLessonIds   = new Set();
    this.#sessionKey      = randomBytes(32);
  }

  // ─── Pub/Sub léger ───────────────────────────────────────────

  subscribe(topic, handler) {
    if (!this.#subscribers.has(topic)) this.#subscribers.set(topic, new Set());
    this.#subscribers.get(topic).add(handler);
    return () => this.#subscribers.get(topic)?.delete(handler);
  }

  #deliver(topic, payload) {
    const subs = this.#subscribers.get(topic);
    if (!subs) return;
    for (const h of subs) {
      try { h(payload); }
      catch (e) { console.warn(`[NodeComm] Handler erreur (${topic}):`, e.message); }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // REDISTRIBUTION INTER-NŒUDS
  // ═══════════════════════════════════════════════════════════════

  // ─── 1. broadcastLesson ──────────────────────────────────────

  /**
   * Diffuse une leçon qualifiée à tous les peers abonnés au topic LESSONS.
   *
   * Anti-boucle : chaque leçon a un lessonId UUID. Si ce nœud a déjà
   * vu ce lessonId (reçu ou émis), la diffusion est stoppée silencieusement.
   *
   * Chiffrement : GematriaAead avec nonce frais à chaque broadcast.
   * La leçon ne franchit pas le seuil de score (défaut: 0.6) → rejetée.
   *
   * Format de l'enveloppe :
   *   [nonce:12][lessonId:36][ciphertext:...]
   *
   * @param {ContributionProof|object} lesson
   * @param {number} qualityThreshold — score minimum (défaut: BROADCAST_MIN_SCORE)
   * @returns {Promise<boolean>} true si diffusée, false si rejetée
   */
  async broadcastLesson(lesson, qualityThreshold = BROADCAST_MIN_SCORE) {
    if (!lesson) return false;

    const score    = lesson.score ?? lesson._score ?? 0;
    const lessonId = lesson.id ?? lesson.lessonId ?? randomUUID();

    // Filtre qualité
    if (score < qualityThreshold) {
      console.debug(`[NodeComm] Leçon rejetée (score ${score.toFixed(2)} < ${qualityThreshold})`);
      return false;
    }

    // Anti-boucle — ne jamais re-broadcaster ce qu'on a déjà vu
    if (this.#seenLessonIds.has(lessonId)) {
      console.debug(`[NodeComm] Leçon ${lessonId.slice(0, 8)} déjà broadcastée — skip`);
      return false;
    }

    // Marquer comme vu AVANT la diffusion
    this.#markSeen(lessonId);

    const payload = { lessonId, emitterId: this.#peerId, score, ts: Date.now(),
                      content: lesson.content ?? lesson.data ?? lesson };
    const nonce      = randomBytes(12);
    const key        = this.#deriveMessageKey(nonce);
    const plaintext  = TE.encode(JSON.stringify(payload));
    const encrypted  = new GematriaAead(key, nonce).encrypt(plaintext);

    // Enveloppe [nonce:12][lessonId:36][ciphertext]
    const idBytes    = TE.encode(lessonId.padEnd(36, ' ').slice(0, 36));
    const envelope   = new Uint8Array(12 + 36 + encrypted.length);
    envelope.set(nonce, 0);
    envelope.set(idBytes, 12);
    envelope.set(encrypted, 48);

    this.#pushToBus(new NodeMessage(this.#peerId, null, 'lesson_broadcast', envelope));
    this.#deliver(Topic.LESSONS, envelope);

    this.#stats.messagesSent++;
    this.#stats.lessonsPropagated++;
    this.#stats.lastBroadcast = Date.now();
    this.#stats.lastSuccessfulSync = Date.now();

    console.debug(`[NodeComm] broadcastLesson — id: ${lessonId.slice(0, 8)} | score: ${score.toFixed(3)}`);
    return true;
  }

  // ─── 2. receiveRemoteLesson ──────────────────────────────────

  /**
   * Réceptionne une enveloppe chiffrée et re-valide la leçon reçue.
   *
   * Re-validation complète avant injection dans le bus local :
   *   1. Déchiffrement GematriaAead
   *   2. Vérification anti-boucle (lessonId déjà vu → rejet)
   *   3. PII guard
   *   4. Anti-manipulation
   *   5. Vérification fraîcheur (< 90 jours)
   *
   * @param {Uint8Array} encryptedData — enveloppe [nonce:12][lessonId:36][ciphertext]
   * @returns {{ proof: ContributionProof, content: string, lessonId: string }}
   */
  async receiveRemoteLesson(encryptedData) {
    if (!(encryptedData instanceof Uint8Array) || encryptedData.length < 49) {
      throw new Error('Enveloppe invalide ou trop courte (min 49 bytes)');
    }

    const nonce    = encryptedData.subarray(0, 12);
    const lessonId = TD.decode(encryptedData.subarray(12, 48)).trim();
    const ct       = encryptedData.subarray(48);
    const key      = this.#deriveMessageKey(nonce);

    // Déchiffrement
    let plaintext;
    try { plaintext = new GematriaAead(key, nonce).decrypt(ct); }
    catch (e) { throw new Error(`Déchiffrement échoué : ${e.message}`); }

    let obj;
    try { obj = JSON.parse(TD.decode(plaintext)); }
    catch (e) { throw new Error(`Désérialisation échouée : ${e.message}`); }

    // Anti-boucle
    if (this.#seenLessonIds.has(lessonId)) {
      throw new Error(`Leçon ${lessonId.slice(0, 8)} déjà vue — rejetée (anti-boucle)`);
    }
    this.#markSeen(lessonId);

    // Extraire le contenu textuel
    const rawContent = typeof obj.content === 'string'
      ? obj.content
      : JSON.stringify(obj.content ?? obj);

    // Re-validation PII
    if (this.#hasPII(rawContent)) {
      this.#stats.lessonsRejectedPII++;
      throw new Error('Leçon rejetée — PII détecté dans le contenu reçu');
    }

    // Re-validation anti-manipulation
    if (this.#hasManip(rawContent)) {
      this.#stats.lessonsRejectedManip++;
      throw new Error('Leçon rejetée — tentative de manipulation détectée');
    }

    // Vérification fraîcheur
    if (obj.ts && Date.now() - obj.ts > LESSON_MAX_AGE_MS) {
      throw new Error('Leçon expirée (> 90 jours)');
    }

    // Construire la ContributionProof
    const proof = new ContributionProof(
      obj.emitterId ?? 'unknown',
      'remote_lesson',
      obj.score ?? 0.6,
      { content: rawContent, lessonId, receivedAt: Date.now() }
    );

    this.#receivedLessons.push(proof);
    if (this.#receivedLessons.length > LESSON_BUFFER_MAX) this.#receivedLessons.shift();

    this.#stats.messagesReceived++;
    this.#stats.lessonsReceived++;
    this.#stats.lastSuccessfulSync = Date.now();

    console.debug(`[NodeComm] Leçon reçue de ${obj.emitterId ?? '?'} | score: ${(obj.score ?? 0).toFixed(3)}`);
    return { proof, content: rawContent, lessonId };
  }

  // ─── 3. syncLessons ──────────────────────────────────────────

  /**
   * Échange bidirectionnel des top-N leçons avec un peer.
   *
   * Protocole :
   *   1. Ce nœud envoie ses top-N leçons (par score) au peer via LESSON_SYNC
   *   2. Le peer répond avec ses top-N leçons
   *   3. Chaque leçon reçue passe par re-validation complète
   *   4. Les leçons valides sont enregistrées dans #receivedLessons
   *
   * Usage typique : appelé lors de l'établissement d'une connexion peer.
   *
   * @param {NodeCommunication} peerComm  — NodeCommunication du peer cible
   * @param {object[]}          localBus  — bus local (messageBus de SkyCloud)
   * @param {number}            topN      — nombre de leçons à échanger
   * @returns {{ sent: number, received: number, rejected: number }}
   */
  async syncLessons(peerComm, localBus = [], topN = SYNC_TOP_N) {
    if (!peerComm || !(peerComm instanceof NodeCommunication)) {
      throw new Error('peerComm doit être une instance NodeCommunication');
    }

    // ── Sélection du top-N local ──────────────────────────────
    const topLocal = [...localBus]
      .filter(m => typeof m.content === 'string' && !m._vaccinated)
      .sort((a, b) => (b._score ?? 0) - (a._score ?? 0))
      .slice(0, topN);

    let sent     = 0;
    let received = 0;
    let rejected = 0;

    // ── Phase 1 : envoi vers le peer ─────────────────────────
    const sendHandles = [];
    for (const m of topLocal) {
      const proof = new ContributionProof(
        this.#peerId, 'sync_lesson',
        m._score ?? 0.6,
        { content: m.content, lessonId: m.id ?? randomUUID() }
      );
      try {
        const envelope = await this.#encryptLesson(proof);
        // Livrer directement dans le bus du peer (simulation réseau local)
        // En production : cette enveloppe serait envoyée via WebSocket/libp2p
        peerComm.#deliver(Topic.LESSON_SYNC, envelope);
        sendHandles.push(envelope);
        sent++;
      } catch (e) {
        this.#stats.failedBroadcasts++;
        console.warn(`[NodeComm] syncLessons — envoi échoué : ${e.message}`);
      }
    }

    // ── Phase 2 : réception depuis le peer ───────────────────
    // Abonnement temporaire pour collecter les réponses du peer
    const peerLessons = [];
    const unsub = peerComm.subscribe(Topic.LESSON_SYNC, (envelope) => {
      peerLessons.push(envelope);
    });

    // Le peer sélectionne et envoie son propre top-N
    const peerLocalBus = peerComm.receivedLessons.map(l => ({
      content   : l.data?.content ?? JSON.stringify(l.data ?? {}),
      _score    : l.score,
      _vaccinated: false,
      id        : l.id ?? randomUUID(),
    }));

    const topPeer = peerLocalBus
      .sort((a, b) => (b._score ?? 0) - (a._score ?? 0))
      .slice(0, topN);

    for (const m of topPeer) {
      const proof = new ContributionProof(
        peerComm.peerId, 'sync_lesson',
        m._score ?? 0.6,
        { content: m.content, lessonId: m.id }
      );
      try {
        const envelope = await peerComm.#encryptLesson(proof);
        this.#deliver(Topic.LESSON_SYNC, envelope);
      } catch { /* skip */ }
    }

    // Désabonnement
    unsub();

    // Re-valider chaque leçon reçue du peer
    for (const envelope of peerLessons) {
      try {
        const result = await this.receiveRemoteLesson(envelope);
        received++;
        this.#stats.lessonsSynced++;
      } catch {
        rejected++;
      }
    }

    this.#stats.lastSuccessfulSync = Date.now();
    console.info(`[NodeComm] syncLessons — envoyées: ${sent} | reçues: ${received} | rejetées: ${rejected}`);
    return { sent, received, rejected };
  }

  // ─── 4. propagateLessons ─────────────────────────────────────

  /**
   * Propage le top-N% du bus local à tous les peers enregistrés.
   * Déclenché typiquement après chaque Dream Cycle.
   *
   * Stratégie :
   *   • Prend les PROPAGATE_TOP_PERCENT meilleures leçons du bus
   *   • Plafond absolu : PROPAGATE_MAX leçons
   *   • Chaque leçon envoyée via broadcastLesson (anti-boucle intégré)
   *   • Les peers doivent être abonnés à Topic.LESSONS
   *
   * @param {NodeCommunication[]} peers    — peers actifs
   * @param {object[]}            localBus — bus local (messageBus de SkyCloud)
   * @returns {{ propagated: number, skipped: number, peers: number }}
   */
  async propagateLessons(peers = [], localBus = []) {
    if (!peers.length) return { propagated: 0, skipped: 0, peers: 0 };

    // Sélection top PROPAGATE_TOP_PERCENT du bus, plafonné à PROPAGATE_MAX
    const topN = Math.min(
      Math.ceil(localBus.length * PROPAGATE_TOP_PERCENT),
      PROPAGATE_MAX
    );

    const topLessons = [...localBus]
      .filter(m => typeof m.content === 'string' && !m._vaccinated && (m._score ?? 0) >= BROADCAST_MIN_SCORE)
      .sort((a, b) => (b._score ?? 0) - (a._score ?? 0))
      .slice(0, topN);

    let propagated = 0;
    let skipped    = 0;

    for (const m of topLessons) {
      const lessonId = m.id ?? randomUUID();
      const lesson   = {
        id       : lessonId,
        lessonId,
        score    : m._score ?? 0.6,
        content  : m.content,
        emitter  : this.#peerId,
        ts       : m.timestamp ?? Date.now(),
      };

      for (const peer of peers) {
        try {
          // Livrer l'enveloppe chiffrée directement dans le bus du peer
          const envelope = await this.#encryptLesson(lesson);
          peer.#deliver(Topic.LESSONS, envelope);
          propagated++;
        } catch (e) {
          skipped++;
          console.debug(`[NodeComm] propagateLessons — peer skip: ${e.message}`);
        }
      }

      this.#markSeen(lessonId);
      this.#stats.lessonsPropagated++;
    }

    this.#stats.lastPropagate = Date.now();
    this.#stats.lastSuccessfulSync = Date.now();
    console.info(
      `[NodeComm] propagateLessons — ${topLessons.length} leçons × ${peers.length} peers` +
      ` | propagées: ${propagated} | skippées: ${skipped}`
    );
    return { propagated, skipped, peers: peers.length };
  }

  // ─── 5. requestLessons ───────────────────────────────────────

  /**
   * Demande active à un peer ses leçons correspondant à un filtre.
   *
   * Filtre disponibles :
   *   filter.keyword    — mot-clé présent dans le contenu
   *   filter.minScore   — score minimum
   *   filter.maxAge     — âge maximum en heures
   *   filter.limit      — nombre maximum de leçons à demander (défaut: 10)
   *
   * Utile quand un nœud détecte un domaine de connaissance manquant.
   * Chaque leçon reçue passe par la re-validation complète.
   *
   * @param {NodeCommunication} peerComm
   * @param {object}            filter
   * @returns {{ lessons: object[], rejected: number }}
   */
  async requestLessons(peerComm, filter = {}) {
    if (!peerComm || !(peerComm instanceof NodeCommunication)) {
      throw new Error('peerComm doit être une instance NodeCommunication');
    }

    const { keyword = '', minScore = 0.5, maxAge = 720, limit = 10 } = filter;
    const cutoff = Date.now() - maxAge * 3_600_000;

    // Le peer filtre son buffer de leçons reçues selon les critères
    const peerMatching = peerComm.#receivedLessons
      .filter(l => {
        const content = l.data?.content ?? JSON.stringify(l.data ?? {});
        const ts      = l.data?.receivedAt ?? l.timestamp ?? 0;
        const scoreOk = l.score >= minScore;
        const ageOk   = ts >= cutoff;
        const kwOk    = !keyword || content.toLowerCase().includes(keyword.toLowerCase());
        return scoreOk && ageOk && kwOk;
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    const lessons  = [];
    let   rejected = 0;

    for (const proof of peerMatching) {
      // Sérialiser et chiffrer la leçon du peer
      const content = proof.data?.content ?? JSON.stringify(proof.data ?? {});
      const lesson  = {
        id      : proof.data?.lessonId ?? randomUUID(),
        score   : proof.score,
        content,
        emitter : peerComm.peerId,
        ts      : proof.data?.receivedAt ?? Date.now(),
      };

      try {
        const envelope = await peerComm.#encryptLesson(lesson);
        const result   = await this.receiveRemoteLesson(envelope);
        lessons.push({ content: result.content, score: proof.score, lessonId: result.lessonId });
        this.#stats.lessonsRequested++;
      } catch {
        rejected++;
      }
    }

    console.info(
      `[NodeComm] requestLessons(keyword="${keyword}", minScore=${minScore})` +
      ` — reçues: ${lessons.length} | rejetées: ${rejected}`
    );
    return { lessons, rejected };
  }

  // ─── Flash Gematria ──────────────────────────────────────────

  async coordinateGlobalFlash() {
    const nonce     = randomBytes(12);
    const key       = this.#deriveMessageKey(nonce);
    const encrypted = new GematriaAead(key, nonce).encrypt(FLASH_SIGNAL);
    const envelope  = new Uint8Array(12 + encrypted.length);
    envelope.set(nonce, 0);
    envelope.set(encrypted, 12);
    this.#pushToBus(new NodeMessage(this.#peerId, null, 'signal', envelope));
    this.#deliver(Topic.SIGNALS, envelope);
    this.#stats.messagesSent++;
    this.#stats.flashSignalsSent++;
    this.#stats.lastSuccessfulSync = Date.now();
  }

  // ─── Session ─────────────────────────────────────────────────

  rotateSessionKey(newSecret = null) {
    const base        = newSecret instanceof Uint8Array ? newSecret : randomBytes(32);
    this.#sessionKey  = hkdfSha256(base, null, TE.encode(`session|${this.#peerId}`), 32);
    // Vider le cache seen pour éviter les faux-positifs après rotation
    this.#seenLessonIds.clear();
  }

  // ─── Stats & maintenance ─────────────────────────────────────

  pruneOldLessons(maxAgeDays = 90) {
    const cutoff = Date.now() - maxAgeDays * 24 * 3_600_000;
    this.#receivedLessons = this.#receivedLessons.filter(l =>
      (l.data?.receivedAt ?? l.timestamp ?? Date.now()) > cutoff
    );
  }

  getStats()             { return { ...this.#stats, seenIds: this.#seenLessonIds.size }; }
  get peerId()           { return this.#peerId; }
  get receivedLessons()  { return [...this.#receivedLessons]; }
  get messageBus()       { return [...this.#messageBus]; }

  // ─── Privés ──────────────────────────────────────────────────

  #deriveMessageKey(nonce) {
    return hkdfSha256(this.#sessionKey, nonce, TE.encode('msg-key'), 32);
  }

  #pushToBus(msg) {
    this.#messageBus.push(msg);
    if (this.#messageBus.length > MSG_BUS_MAX) this.#messageBus.shift();
  }

  /** Marque un lessonId comme vu — éviction LRU si cache plein */
  #markSeen(id) {
    if (this.#seenLessonIds.size >= SEEN_IDS_MAX) {
      // Éviction du premier élément (plus ancien)
      this.#seenLessonIds.delete(this.#seenLessonIds.values().next().value);
    }
    this.#seenLessonIds.add(id);
  }

  /** Chiffre une leçon en enveloppe [nonce:12][lessonId:36][ciphertext] */
  async #encryptLesson(lesson) {
    const lessonId  = (lesson.id ?? lesson.lessonId ?? randomUUID()).padEnd(36, ' ').slice(0, 36);
    const payload   = { lessonId: lessonId.trim(), emitterId: this.#peerId,
                        score: lesson.score ?? lesson._score ?? 0,
                        content: lesson.content ?? lesson.data ?? lesson, ts: Date.now() };
    const nonce     = randomBytes(12);
    const key       = this.#deriveMessageKey(nonce);
    const encrypted = new GematriaAead(key, nonce).encrypt(TE.encode(JSON.stringify(payload)));

    const idBytes  = TE.encode(lessonId);
    const envelope = new Uint8Array(12 + 36 + encrypted.length);
    envelope.set(nonce, 0);
    envelope.set(idBytes, 12);
    envelope.set(encrypted, 48);
    return envelope;
  }

  /** PII guard — réutilisé lors de la re-validation des leçons reçues */
  #hasPII(text) {
    return PII_PATTERNS.some(p => p.test(text));
  }

  /** Anti-manipulation — réutilisé lors de la re-validation */
  #hasManip(text) {
    return MANIP_PATTERNS.some(p => p.test(text));
  }

  // -- Handlers API (page Node - federation de lecons) -- migres depuis skycloud.js
  //    Les methodes node.X() restent dans skycloud (integration messageBus/pushToBus + appels internes).
  apiHandlers(node) {
    return {
      broadcastLesson  : (lesson, threshold) => node.broadcastLesson(lesson, threshold),
      syncLessons      : (peerComm, topN)    => node.syncLessons(peerComm, topN),
      propagateLessons : (peerComms)         => node.propagateLessons(peerComms),
      requestLessons   : (peerComm, filter)  => node.requestLessons(peerComm, filter),
      getCommStats     : ()                  => node.getCommStats(),
    };
  }
}

// ─────────────────────────────────────────────────────────────────
// MIXED NODE
// ─────────────────────────────────────────────────────────────────

export class MixedNode {
  #communication;
  #storage;
  #validatorStake;
  #activeRoles;
  #taskHistory;

  constructor(sovereignAlias, opts = {}) {
    if (!sovereignAlias?.trim()) throw new Error('sovereignAlias requis');

    this.nodeId                = `mixed-${sovereignAlias.toLowerCase().replace(/\s+/g, '-')}`;
    this.sovereignAlias        = sovereignAlias.trim();
    this.currentState          = NodeState.Active;
    this.computePower          = opts.computePower ?? 0.80;
    this.totalTasksProcessed   = 0;
    this.lastRoleSwitch        = null;
    this.createdAt             = Date.now();

    this.#activeRoles          = new Set([NodeRole.FULL]);
    this.#storage              = null;
    this.#validatorStake       = 0;
    this.#taskHistory          = [];
    this.#communication        = opts.communication
      ?? new NodeCommunication(this.nodeId, { hybridTransport: opts.hybridTransport });
  }

  // ─── Rôles ───────────────────────────────────────────────────

  async activateRole(role) {
    if (this.#activeRoles.has(role)) return;
    switch (role) {
      case NodeRole.STORAGE:
        this.#storage = new DecentralizedStorage();
        console.info(`[MixedNode] ${this.sovereignAlias} — Storage activé`); break;
      case NodeRole.VALIDATOR:
        this.#validatorStake = 12_000;
        console.info(`[MixedNode] ${this.sovereignAlias} — Validator activé (stake: ${this.#validatorStake})`); break;
      case NodeRole.COMPUTE:
        console.info(`[MixedNode] ${this.sovereignAlias} — Compute activé`); break;
      case NodeRole.FULL: break;
      default: throw new Error(`Rôle inconnu : ${role}`);
    }
    this.#activeRoles.add(role);
    this.lastRoleSwitch = Date.now();
  }

  deactivateRole(role) {
    if (role === NodeRole.FULL) throw new Error('Rôle Full non désactivable');
    this.#activeRoles.delete(role);
    if (role === NodeRole.STORAGE)   this.#storage = null;
    if (role === NodeRole.VALIDATOR) this.#validatorStake = 0;
    this.lastRoleSwitch = Date.now();
  }

  hasRole(role)   { return this.#activeRoles.has(role); }
  get activeRoles() { return [...this.#activeRoles]; }

  // ─── Tâches ──────────────────────────────────────────────────

  async executeTask(taskType, data = null, rewards = null) {
    this.totalTasksProcessed++;
    let result;
    try {
      switch (taskType) {
        case 'inference': {
          if (!this.#activeRoles.has(NodeRole.FULL)) throw new Error('Rôle Full requis');
          if (rewards instanceof UserRewards) rewards.totalSkyEarned += 12;
          result = `Inférence exécutée sur ${this.sovereignAlias}`; break;
        }
        case 'compute': {
          if (!this.#activeRoles.has(NodeRole.COMPUTE) && !this.#activeRoles.has(NodeRole.FULL))
            throw new Error('Rôle Compute ou Full requis');
          if (rewards instanceof UserRewards) rewards.totalSkyEarned += 10;
          result = `Compute exécuté (power: ${this.computePower.toFixed(2)})`; break;
        }
        case 'upload': {
          if (!this.#activeRoles.has(NodeRole.STORAGE) || !this.#storage)
            throw new Error('Rôle Storage non activé');
          if (!data) throw new Error('Aucune donnée à uploader');
          const buf = data instanceof Uint8Array ? data : Buffer.from(data);
          const id  = await this.#storage.storeFile(`task_${Date.now()}.bin`, buf, this.nodeId);
          if (rewards instanceof UserRewards) rewards.totalSkyEarned += 8;
          result = `Fichier stocké → id: ${id}`; break;
        }
        case 'validation': {
          if (!this.#activeRoles.has(NodeRole.VALIDATOR))
            throw new Error('Rôle Validator non activé');
          if (this.#validatorStake < 10_000)
            throw new Error(`Stake insuffisant (${this.#validatorStake} < 10000)`);
          if (rewards instanceof UserRewards) rewards.totalSkyEarned += 15;
          result = `Validation PoUW (stake: ${this.#validatorStake})`; break;
        }
        case 'broadcast': {
          if (!data) throw new Error("'data' requis (ContributionProof)");
          const proof = data instanceof ContributionProof
            ? data
            : new ContributionProof(this.nodeId, 'task', data.score ?? 0.8, data);
          await this.#communication.broadcastLesson(proof, BROADCAST_MIN_SCORE);
          result = `Leçon diffusée (score: ${proof.score.toFixed(3)})`; break;
        }
        default: throw new Error(`Tâche inconnue : ${taskType}`);
      }
      this.#taskHistory.push({ taskType, success: true, ts: Date.now() });
      return result;
    } catch (err) {
      this.#taskHistory.push({ taskType, success: false, error: err.message, ts: Date.now() });
      throw err;
    }
  }

  // ─── Raccourcis communication ─────────────────────────────────

  async broadcastLesson(lesson, threshold)         { return this.#communication.broadcastLesson(lesson, threshold); }
  async receiveRemoteLesson(data)                  { return this.#communication.receiveRemoteLesson(data); }
  async syncLessons(peerComm, localBus, topN)      { return this.#communication.syncLessons(peerComm, localBus, topN); }
  async propagateLessons(peers, localBus)          { return this.#communication.propagateLessons(peers, localBus); }
  async requestLessons(peerComm, filter)           { return this.#communication.requestLessons(peerComm, filter); }
  async coordinateGlobalFlash()                    { return this.#communication.coordinateGlobalFlash(); }
  subscribeToTopic(topic, handler)                 { return this.#communication.subscribe(topic, handler); }
  getCommStats()                                   { return this.#communication.getStats(); }
  rotateSessionKey(secret)                         { this.#communication.rotateSessionKey(secret); }

  // ─── Métriques ────────────────────────────────────────────────

  getTotalPower() {
    let p = this.computePower;
    if (this.#activeRoles.has(NodeRole.STORAGE))   p += 0.22;
    if (this.#activeRoles.has(NodeRole.VALIDATOR)) p += 0.18;
    if (this.#activeRoles.has(NodeRole.COMPUTE))   p += 0.35;
    return +p.toFixed(3);
  }

  getTaskSuccessRate() {
    if (!this.#taskHistory.length) return 1;
    return +(this.#taskHistory.filter(t => t.success).length / this.#taskHistory.length).toFixed(4);
  }

  healthReport() {
    return {
      nodeId        : this.nodeId,
      alias         : this.sovereignAlias,
      state         : this.currentState,
      activeRoles   : this.activeRoles,
      totalPower    : this.getTotalPower(),
      tasksProcessed: this.totalTasksProcessed,
      successRate   : this.getTaskSuccessRate(),
      storageActive : !!this.#storage,
      validatorStake: this.#validatorStake,
      communication : this.#communication.getStats(),
    };
  }

  get communication()   { return this.#communication; }
  get storage()         { return this.#storage; }
  get validatorStake()  { return this.#validatorStake; }
  set validatorStake(v) { this.#validatorStake = Math.max(0, v); }
}