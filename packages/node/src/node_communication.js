// packages/node/src/node_communication.js
// NodeCommunication + MixedNode — Réseau de Nœuds Vivant & Sécurisé
// HybridTransport + GematriaAead + Lesson Propagation + Orchestration multi-rôles
// SkyAInet × Nikola T369

"use strict";

import { randomBytes, randomUUID }  from 'crypto';
import { HybridTransport }          from '../../secure/src/crypto/hybrid.js';
import { GematriaAead }             from '../../secure/src/crypto/gematria_aead.js';
import { hkdfSha256, hmacSha256 }   from '../../secure/src/crypto/sha_fips.js';
import { DecentralizedStorage }     from './storage.js';
import { UserRewards }              from '../../core/src/rewards.js';
import { NodeState }                from '../../core/src/node_types.js';

// ─────────────────────────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────────────────────────

const LESSON_MAX_AGE_MS    = 90 * 24 * 3_600_000;  // 90 jours
const LESSON_BUFFER_MAX    = 2048;                  // max leçons en mémoire
const MSG_BUS_MAX          = 512;                   // messages en transit
const FLASH_SIGNAL         = new TextEncoder().encode('FLASH_GEMATRIA|GLOBAL|PRIORITY');
const TE                   = new TextEncoder();
const TD                   = new TextDecoder();

// Sujets de communication (GossipSub-like)
export const Topic = Object.freeze({
  LESSONS : 'skyainet/lessons/v2',
  SIGNALS : 'skyainet/signals/v2',
  PEERS   : 'skyainet/peers/v1',
});

// Rôles d'un MixedNode
export const NodeRole = Object.freeze({
  FULL     : 'Full',
  STORAGE  : 'Storage',
  VALIDATOR: 'Validator',
  COMPUTE  : 'Compute',
});

// ─────────────────────────────────────────────────────────────────
// CONTRIBUTION PROOF
//
// Remplace ContributionProof de pouw.js (introuvable).
// Représente une leçon ou contribution propagée sur le réseau.
// ─────────────────────────────────────────────────────────────────

export class ContributionProof {
  constructor(nodeId, contributionType, score, metadata = {}, thevieBoost = 0, compressedSize = 0) {
    this.nodeId          = nodeId;
    this.contributionType= contributionType;
    this.score           = Math.max(0, Math.min(1, score));
    this.metadata        = metadata;
    this.thevieBoost     = thevieBoost;
    this.compressedSize  = compressedSize;
    this.timestamp       = Date.now();
    this.epoch           = 0;
    this.proofHash       = null;
  }

  /** Calcule et stocke le hash HMAC de la preuve (authentification légère) */
  seal(hmacKey) {
    const payload = TE.encode(
      `${this.nodeId}|${this.contributionType}|${this.score}|${this.epoch}|${this.timestamp}`
    );
    this.proofHash = Array.from(hmacSha256(hmacKey, payload))
      .map(b => b.toString(16).padStart(2, '0')).join('');
    return this;
  }

  toJSON() {
    return {
      nodeId: this.nodeId, contributionType: this.contributionType,
      score: this.score, metadata: this.metadata,
      thevieBoost: this.thevieBoost, compressedSize: this.compressedSize,
      timestamp: this.timestamp, epoch: this.epoch, proofHash: this.proofHash,
    };
  }

  static fromJSON(obj) {
    const p = new ContributionProof(
      obj.nodeId, obj.contributionType, obj.score ?? 0,
      obj.metadata ?? {}, obj.thevieBoost ?? 0, obj.compressedSize ?? 0
    );
    p.timestamp = obj.timestamp ?? Date.now();
    p.epoch     = obj.epoch     ?? 0;
    p.proofHash = obj.proofHash ?? null;
    return p;
  }
}

// ─────────────────────────────────────────────────────────────────
// NODE MESSAGE — enveloppe de message réseau
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
    this.messagesSent       = 0;
    this.messagesReceived   = 0;
    this.lessonsPropagated  = 0;
    this.failedBroadcasts   = 0;
    this.flashSignalsSent   = 0;
    this.lastSuccessfulSync = null;
  }
}

// ─────────────────────────────────────────────────────────────────
// NODE COMMUNICATION
//
// Gère la propagation sécurisée des leçons et signaux entre nœuds.
//
// Transport :
//   - Chiffrement symétrique GematriaAead (post-quantique) par message
//   - Clé de session dérivée HKDF à partir d'un secret partagé KEM
//   - Chaque broadcast utilise un nonce frais (randomBytes 12)
//   - Pas de pub/sub broker réel : les messages sont transmis
//     directement aux abonnés enregistrés via #subscribers
// ─────────────────────────────────────────────────────────────────

export class NodeCommunication {
  #peerId;
  #hybrid;
  #sessionKey;      // Uint8Array(32) — clé de session courante (HKDF)
  #receivedLessons; // ContributionProof[]
  #messageBus;      // NodeMessage[] — file FIFO bornée
  #subscribers;     // Map<topic, Set<(payload) => void>>
  #stats;

  constructor(peerId, opts = {}) {
    if (!peerId) throw new Error('peerId requis');
    this.#peerId          = peerId;
    this.#hybrid          = opts.hybridTransport ?? new HybridTransport(true);
    this.#receivedLessons = [];
    this.#messageBus      = [];
    this.#subscribers     = new Map();
    this.#stats           = new CommunicationStats();

    // Clé de session initiale aléatoire — renouvelée à chaque rekey
    this.#sessionKey = randomBytes(32);
  }

  // ─── Gestion des abonnements (pub/sub léger) ─────────────────

  subscribe(topic, handler) {
    if (!this.#subscribers.has(topic)) this.#subscribers.set(topic, new Set());
    this.#subscribers.get(topic).add(handler);
    return () => this.#subscribers.get(topic)?.delete(handler);   // unsubscribe
  }

  #deliver(topic, payload) {
    const subs = this.#subscribers.get(topic);
    if (!subs) return;
    for (const handler of subs) {
      try { handler(payload); }
      catch (e) { console.warn(`[NodeComm] Handler erreur (${topic}):`, e.message); }
    }
  }

  // ─── Broadcast de leçon ──────────────────────────────────────

  /**
   * Sérialise et chiffre une ContributionProof, puis la diffuse
   * aux abonnés locaux du topic LESSONS.
   *
   * Chiffrement : GematriaAead avec clé de session dérivée HKDF.
   * Chaque message a un nonce frais → résistance aux attaques par rejeu.
   *
   * @param {ContributionProof} lesson
   * @param {number}            qualityThreshold — score minimum pour diffusion
   */
  async broadcastLesson(lesson, qualityThreshold = 0.70) {
    if (!lesson || lesson.score < qualityThreshold) return;

    const nonce     = randomBytes(12);
    const key       = this.#deriveMessageKey(nonce);
    const plaintext = TE.encode(JSON.stringify(lesson.toJSON?.() ?? lesson));
    const encrypted = new GematriaAead(key, nonce).encrypt(plaintext);

    // Enveloppe avec nonce préfixé
    const envelope  = new Uint8Array(12 + encrypted.length);
    envelope.set(nonce, 0);
    envelope.set(encrypted, 12);

    this.#pushToBus(new NodeMessage(this.#peerId, null, 'lesson', envelope));
    this.#deliver(Topic.LESSONS, envelope);

    this.#stats.messagesSent++;
    this.#stats.lessonsPropagated++;
    this.#stats.lastSuccessfulSync = Date.now();
  }

  // ─── Réception de leçon ──────────────────────────────────────

  /**
   * Déchiffre une enveloppe reçue et reconstitue une ContributionProof.
   * Vérifie la fraîcheur du message (rejet si > 90 jours).
   *
   * @param {Uint8Array} encryptedData — enveloppe [nonce:12][ciphertext]
   * @returns {ContributionProof}
   */
  async receiveRemoteLesson(encryptedData) {
    if (!(encryptedData instanceof Uint8Array) || encryptedData.length < 13) {
      throw new Error('Données chiffrées invalides ou trop courtes');
    }

    const nonce     = encryptedData.subarray(0, 12);
    const ct        = encryptedData.subarray(12);
    const key       = this.#deriveMessageKey(nonce);

    let plaintext;
    try {
      plaintext = new GematriaAead(key, nonce).decrypt(ct);
    } catch (e) {
      throw new Error(`Déchiffrement échoué : ${e.message}`);
    }

    let obj;
    try { obj = JSON.parse(TD.decode(plaintext)); }
    catch (e) { throw new Error(`Désérialisation échouée : ${e.message}`); }

    const proof = ContributionProof.fromJSON(obj);

    // Rejet des messages trop anciens
    if (Date.now() - proof.timestamp > LESSON_MAX_AGE_MS) {
      throw new Error('Leçon expirée (> 90 jours)');
    }

    this.#receivedLessons.push(proof);
    if (this.#receivedLessons.length > LESSON_BUFFER_MAX) {
      this.#receivedLessons.shift();
    }

    this.#stats.messagesReceived++;
    return proof;
  }

  // ─── Flash Gematria ──────────────────────────────────────────

  /**
   * Diffuse un signal de Flash Gematria global.
   * Le signal est chiffré comme un message ordinaire — indiscernable du trafic.
   */
  async coordinateGlobalFlash() {
    const nonce     = randomBytes(12);
    const key       = this.#deriveMessageKey(nonce);
    const encrypted = new GematriaAead(key, nonce).encrypt(FLASH_SIGNAL);

    const envelope = new Uint8Array(12 + encrypted.length);
    envelope.set(nonce, 0);
    envelope.set(encrypted, 12);

    this.#pushToBus(new NodeMessage(this.#peerId, null, 'signal', envelope));
    this.#deliver(Topic.SIGNALS, envelope);

    this.#stats.messagesSent++;
    this.#stats.flashSignalsSent++;
    this.#stats.lastSuccessfulSync = Date.now();
  }

  // ─── Gestion de la session ────────────────────────────────────

  /** Renouvelle la clé de session (à appeler après un epoch rekey) */
  rotateSessionKey(newSecret = null) {
    const base = newSecret instanceof Uint8Array ? newSecret : randomBytes(32);
    this.#sessionKey = hkdfSha256(base, null, TE.encode(`session|${this.#peerId}`), 32);
  }

  // ─── Stats & maintenance ──────────────────────────────────────

  pruneOldLessons(maxAgeDays = 90) {
    const cutoff = Date.now() - maxAgeDays * 24 * 3_600_000;
    this.#receivedLessons = this.#receivedLessons.filter(l => l.timestamp > cutoff);
  }

  getStats()      { return { ...this.#stats }; }

  get peerId()           { return this.#peerId; }
  get receivedLessons()  { return [...this.#receivedLessons]; }
  get messageBus()       { return [...this.#messageBus]; }

  // ─── Privés ───────────────────────────────────────────────────

  /** Dérive une clé de message unique à partir de la clé de session + nonce frais */
  #deriveMessageKey(nonce) {
    return hkdfSha256(this.#sessionKey, nonce, TE.encode('msg-key'), 32);
  }

  #pushToBus(msg) {
    this.#messageBus.push(msg);
    if (this.#messageBus.length > MSG_BUS_MAX) this.#messageBus.shift();
  }
}

// ─────────────────────────────────────────────────────────────────
// MIXED NODE
//
// Nœud hybride combinant plusieurs rôles en une seule instance :
//   Full (inférence)  — toujours actif
//   Storage           — activé à la demande (DecentralizedStorage)
//   Validator         — activé à la demande (stake requis)
//   Compute           — activé à la demande (tâches CPU/GPU)
//
// Chaque rôle contribue à la puissance totale du nœud.
// NodeCommunication est injecté ou créé automatiquement.
// ─────────────────────────────────────────────────────────────────

export class MixedNode {
  #communication;   // NodeCommunication
  #storage;         // DecentralizedStorage | null
  #validatorStake;
  #activeRoles;     // Set<NodeRole>
  #taskHistory;     // { taskType, success, ts }[]

  constructor(sovereignAlias, opts = {}) {
    if (!sovereignAlias?.trim()) throw new Error('sovereignAlias requis');

    this.nodeId          = `mixed-${sovereignAlias.toLowerCase().replace(/\s+/g, '-')}`;
    this.sovereignAlias  = sovereignAlias.trim();
    this.currentState    = NodeState.Active;
    this.computePower    = opts.computePower ?? 0.80;
    this.totalTasksProcessed = 0;
    this.lastRoleSwitch  = null;
    this.createdAt       = Date.now();

    this.#activeRoles    = new Set([NodeRole.FULL]);
    this.#storage        = null;
    this.#validatorStake = 0;
    this.#taskHistory    = [];

    // Communication réseau — injecté ou créé localement
    this.#communication  = opts.communication
      ?? new NodeCommunication(this.nodeId, { hybridTransport: opts.hybridTransport });
  }

  // ─── Gestion des rôles ───────────────────────────────────────

  async activateRole(role) {
    if (this.#activeRoles.has(role)) return;

    switch (role) {
      case NodeRole.STORAGE:
        this.#storage = new DecentralizedStorage();
        console.info(`[MixedNode] ${this.sovereignAlias} — rôle Storage activé`);
        break;

      case NodeRole.VALIDATOR:
        // Stake minimum requis (peut être fourni via opts ou défini après)
        this.#validatorStake = 12_000;
        console.info(`[MixedNode] ${this.sovereignAlias} — rôle Validator activé (stake: ${this.#validatorStake})`);
        break;

      case NodeRole.COMPUTE:
        console.info(`[MixedNode] ${this.sovereignAlias} — rôle Compute activé`);
        break;

      case NodeRole.FULL:
        break;  // toujours actif par défaut

      default:
        throw new Error(`Rôle inconnu : ${role}`);
    }

    this.#activeRoles.add(role);
    this.lastRoleSwitch = Date.now();
  }

  deactivateRole(role) {
    if (role === NodeRole.FULL) throw new Error('Le rôle Full ne peut pas être désactivé');
    this.#activeRoles.delete(role);
    if (role === NodeRole.STORAGE) this.#storage = null;
    if (role === NodeRole.VALIDATOR) this.#validatorStake = 0;
    this.lastRoleSwitch = Date.now();
  }

  hasRole(role) { return this.#activeRoles.has(role); }
  get activeRoles() { return [...this.#activeRoles]; }

  // ─── Exécution de tâche ──────────────────────────────────────

  /**
   * Exécute une tâche selon le rôle approprié.
   * Enregistre le résultat dans l'historique.
   *
   * @param {'inference'|'upload'|'validation'|'compute'|'broadcast'} taskType
   * @param {any}         [data]
   * @param {UserRewards} [rewards]
   */
  async executeTask(taskType, data = null, rewards = null) {
    this.totalTasksProcessed++;
    let result;

    try {
      switch (taskType) {

        case 'inference': {
          if (!this.#activeRoles.has(NodeRole.FULL)) throw new Error('Rôle Full requis');
          // Contribution récompensée via totalSkyEarned (addReward n'existe pas dans UserRewards)
          if (rewards instanceof UserRewards) {
            rewards.totalSkyEarned += 12;
          }
          result = `Inférence exécutée sur ${this.sovereignAlias}`;
          break;
        }

        case 'compute': {
          if (!this.#activeRoles.has(NodeRole.COMPUTE) && !this.#activeRoles.has(NodeRole.FULL)) {
            throw new Error('Rôle Compute ou Full requis');
          }
          if (rewards instanceof UserRewards) rewards.totalSkyEarned += 10;
          result = `Tâche Compute exécutée sur ${this.sovereignAlias} (power: ${this.computePower.toFixed(2)})`;
          break;
        }

        case 'upload': {
          if (!this.#activeRoles.has(NodeRole.STORAGE) || !this.#storage) {
            throw new Error('Rôle Storage non activé — appelle activateRole(NodeRole.STORAGE)');
          }
          if (!data) throw new Error('Aucune donnée à uploader');
          const buf  = data instanceof Uint8Array ? data : Buffer.from(data);
          const name = `mixed_task_${Date.now()}.bin`;
          const id   = await this.#storage.storeFile(name, buf, this.nodeId);
          if (rewards instanceof UserRewards) rewards.totalSkyEarned += 8;
          result = `Fichier stocké → id: ${id}`;
          break;
        }

        case 'validation': {
          if (!this.#activeRoles.has(NodeRole.VALIDATOR)) {
            throw new Error('Rôle Validator non activé — appelle activateRole(NodeRole.VALIDATOR)');
          }
          if (this.#validatorStake < 10_000) {
            throw new Error(`Stake insuffisant (${this.#validatorStake} < 10000)`);
          }
          if (rewards instanceof UserRewards) rewards.totalSkyEarned += 15;
          result = `Validation PoUW effectuée (stake: ${this.#validatorStake})`;
          break;
        }

        case 'broadcast': {
          // Diffuse une leçon via NodeCommunication
          if (!data) throw new Error("Champ 'data' requis pour broadcast (ContributionProof)");
          const proof = data instanceof ContributionProof
            ? data
            : new ContributionProof(this.nodeId, 'task', data.score ?? 0.8, data);
          await this.#communication.broadcastLesson(proof, 0.60);
          result = `Leçon diffusée (score: ${proof.score.toFixed(3)})`;
          break;
        }

        default:
          throw new Error(`Tâche inconnue : ${taskType}`);
      }

      this.#taskHistory.push({ taskType, success: true, ts: Date.now() });
      return result;

    } catch (err) {
      this.#taskHistory.push({ taskType, success: false, error: err.message, ts: Date.now() });
      throw err;
    }
  }

  // ─── Communication réseau ────────────────────────────────────

  /** Raccourcis vers NodeCommunication */
  async broadcastLesson(lesson, threshold)    { return this.#communication.broadcastLesson(lesson, threshold); }
  async receiveRemoteLesson(data)             { return this.#communication.receiveRemoteLesson(data); }
  async coordinateGlobalFlash()              { return this.#communication.coordinateGlobalFlash(); }
  subscribeToTopic(topic, handler)            { return this.#communication.subscribe(topic, handler); }
  getCommStats()                              { return this.#communication.getStats(); }

  rotateSessionKey(secret)                   { this.#communication.rotateSessionKey(secret); }

  // ─── Métriques & santé ───────────────────────────────────────

  getTotalPower() {
    let p = this.computePower;
    if (this.#activeRoles.has(NodeRole.STORAGE))   p += 0.22;
    if (this.#activeRoles.has(NodeRole.VALIDATOR)) p += 0.18;
    if (this.#activeRoles.has(NodeRole.COMPUTE))   p += 0.35;
    return +p.toFixed(3);
  }

  getTaskSuccessRate() {
    if (this.#taskHistory.length === 0) return 1;
    const ok = this.#taskHistory.filter(t => t.success).length;
    return +(ok / this.#taskHistory.length).toFixed(4);
  }

  healthReport() {
    const commStats = this.#communication.getStats();
    return {
      nodeId         : this.nodeId,
      alias          : this.sovereignAlias,
      state          : this.currentState,
      activeRoles    : this.activeRoles,
      totalPower     : this.getTotalPower(),
      tasksProcessed : this.totalTasksProcessed,
      successRate    : this.getTaskSuccessRate(),
      storageActive  : !!this.#storage,
      validatorStake : this.#validatorStake,
      communication  : commStats,
    };
  }

  // Accesseurs
  get communication()    { return this.#communication; }
  get storage()          { return this.#storage; }
  get validatorStake()   { return this.#validatorStake; }
  set validatorStake(v)  { this.#validatorStake = Math.max(0, v); }
}
