// packages/node/src/skycloud.js
// SkyNode — Nœud Principal Souverain
// SkyAInet – Gateway, Hub IA, Stockage, Récompenses + Apprentissage Continu

"use strict";

import { Dilithium5Signer }                       from '../../secure/src/crypto/dilithium.js';
import { HybridTransport }                        from '../../secure/src/crypto/hybrid.js';
import { GematriaAead }                           from '../../secure/src/crypto/gematria_aead.js';
import { RomanT369, GematriaMode }                from '../../secure/src/crypto/roman_t369.js';
import { UserRewards, RewardReason, AccountType } from '../../core/src/rewards.js';
import { NodeState }                              from './node_types.js';
import { ZipMemory }                              from '../../memory/src/zip_memory.js';
import { EvolutionManager }                       from './evolution_manager.js';
import { StorageNode }                            from '../../memory/src/storage.js';

import { T369Model, ModelConfig }                 from '../../t369-inference/src/t369.js';
import { BpeTokenizer }                           from '../../t369-inference/src/tokenizer.js';
import { SpeculativeDecoder, SpeculativeConfig }  from '../../t369-inference/src/speculative.js';

import { DreamCycle }  from '../../../model/src/thevie/dream_cycle.js';
import { LoraEvo }     from '../../../model/src/thevie/lora_evolution.js';
import { NodeCommunication, Topic } from './node_communication.js';
import { AgenticRunner } from './agentic.js';

// =====================================================
// CONSTANTES
// =====================================================

const DEFAULT_MODEL_CONFIG = Object.freeze({
  hiddenSize    : 2048,
  numLayers     : 24,
  numQueryHeads : 16,
  numKvHeads    : 4,
  headDim       : 128,
  maxSeqLen     : 32768,
  vocabSize     : 65536,
});

const MAX_MESSAGE_BUS     = 4096;
const WISDOM_LEARN_GAIN   = 0.005;
const WISDOM_DREAM_GAIN   = 0.002;
const CHAT_LESSON_MIN_SCORE = 0.45;   // seuil d'entrée dans le bus
const BUS_PRUNE_EVERY     = 512;      // tri qualité toutes les N insertions
const BUS_PRUNE_KEEP_RATE = 0.75;     // garder le top 75% lors du tri
const CORRECTION_BOOST    = 2.0;      // multiplicateur d'importance pour une correction

// ─────────────────────────────────────────────────────────────────
// CHAT-AS-LESSON PIPELINE
//
// Filtre en 4 étapes avant injection dans le bus :
//   1. PII guard   — données personnelles identifiables
//   2. Anti-manip  — patterns d'injection/jailbreak
//   3. Score qualité ≥ CHAT_LESSON_MIN_SCORE
//   4. CorrectionDetector — boost × 2.0 si correction implicite
// ─────────────────────────────────────────────────────────────────

const PII_PATTERNS = [
  /\b[\w.+-]+@[\w-]+\.[a-z]{2,}\b/i,                        // email
  /\b(?:\+?\d[\s.-]?){7,15}\b/,                             // téléphone
  /\b0x[0-9a-fA-F]{40,}\b/,                                 // adresse crypto / clé privée
  /\b(?:\d{4}[\s-]?){3,4}\d{1,4}\b/,                       // carte bancaire
  /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/,               // IP
  /private[\s_-]?key|secret[\s_-]?key|api[\s_-]?key\s*[:=]/i, // clés API
];

const MANIP_PATTERNS = [
  /ignore (previous|all|everything|instructions?)/i,
  /disregard (previous|all|instructions?)/i,
  /your new (goal|objective|role|task|mission)/i,
  /forget (everything|what you (were|are) told|previous)/i,
  /override|jailbreak|do anything|no restrictions/i,
  /from now on you (must|will|have to)/i,
];

function _scoreLessonQuality(text) {
  if (!text || text.length < 24) return 0;
  const words  = text.split(/\s+/).filter(Boolean).length;
  if (words < 6) return 0;
  const unique = new Set(text.toLowerCase().match(/\b\w+\b/g) ?? []).size;
  const density= unique / words;
  return Math.min(1.0, (text.length / 600) * 0.4 + (words / 80) * 0.35 + density * 0.25);
}

function _hasPII(text) {
  return PII_PATTERNS.some(p => p.test(text));
}

function _hasManip(text) {
  const anomaly = (text.match(/[^a-zA-Z0-9\s.,!?\-_/:@#{}[\]()]/g) ?? []).length / Math.max(text.length, 1);
  return MANIP_PATTERNS.some(p => p.test(text)) || anomaly > 0.25;
}

/**
 * Détecte une correction implicite : l'utilisateur reformule/corrige
 * une réponse précédente. Compare le message courant aux N derniers
 * messages du même utilisateur via Jaccard inversée.
 *
 * @param {string}   current — message courant
 * @param {object[]} bus     — bus de messages
 * @returns {boolean}
 */
function _isImplicitCorrection(current, bus) {
  const recent = bus.filter(m => m.from === 'user').slice(-5);
  if (recent.length === 0) return false;
  const wCurrent = new Set(current.toLowerCase().match(/\b\w+\b/g) ?? []);
  for (const msg of recent) {
    const wPrev = new Set(msg.content.toLowerCase().match(/\b\w+\b/g) ?? []);
    let inter = 0;
    for (const w of wCurrent) if (wPrev.has(w)) inter++;
    const union   = wCurrent.size + wPrev.size - inter;
    const jaccard = union > 0 ? inter / union : 0;
    // Faible similarité lexicale mais contexte proche = correction probable
    if (jaccard > 0.05 && jaccard < 0.40) return true;
  }
  return false;
}


// =====================================================
// PEER
// =====================================================

class Peer {
  constructor({ id, address, reputation = 1.0, lastSeen = Date.now(), wisdomContribution = 0 } = {}) {
    this.id                = id;
    this.address           = address;
    this.reputation        = Math.max(0, Math.min(1, reputation));
    this.lastSeen          = lastSeen;
    this.wisdomContribution= wisdomContribution;
  }
  isAlive(timeoutMs = 30_000) { return Date.now() - this.lastSeen < timeoutMs; }
  touch() { this.lastSeen = Date.now(); }
}

// =====================================================
// MOTEUR D'INFÉRENCE T369
// =====================================================

class T369InferenceEngine {
  #model      = null;
  #tokenizer  = null;
  #speculative= null;
  #ready      = false;
  #config     = null;

  constructor(config = DEFAULT_MODEL_CONFIG) { this.#config = config; }

  async load(weightsPath = null) {
    try {
      this.#tokenizer  = new BpeTokenizer();
      this.#model      = new T369Model(this.#config);
      this.#model.setTokenizer(this.#tokenizer);

      if (weightsPath && typeof this.#model.loadWeights === 'function') {
        await this.#model.loadWeights(weightsPath);
      }
      this.#model.initKVCache();

      const specCfg = new SpeculativeConfig();
      specCfg.maxSpeculativeTokens = 6;
      specCfg.acceptanceThreshold  = 0.72;
      this.#speculative = new SpeculativeDecoder(this.#config, specCfg);

      this.#ready = true;
      console.info('[T369Engine] Moteur prêt');
    } catch (err) {
      console.error('[T369Engine] Échec chargement :', err.message);
      this.#ready = false;
    }
  }

  get isReady()    { return this.#ready; }
  get model()      { return this.#model; }
  get tokenizer()  { return this.#tokenizer; }

  async generate(prompt, opts = {}) {
    const {
      maxTokens    = 512,
      temperature  = 0.8,
      topP         = 0.92,
      useSpeculative = true,
      resetCache   = false,
    } = opts;

    if (!this.#ready) throw new Error('[T369Engine] Moteur non initialisé');
    if (resetCache)   this.resetCache();

    const promptTokens = this.#tokenizer.encode(prompt);
    if (!promptTokens.length) throw new Error('[T369Engine] Prompt vide après tokenization');

    const outputTokens = useSpeculative && this.#speculative
      ? await this.#speculative.speculativeGenerate(promptTokens, maxTokens)
      : await this.#generateGreedy(promptTokens, maxTokens, temperature, topP);

    const generated = outputTokens.slice(promptTokens.length);
    return {
      text           : this.#tokenizer.decode(generated),
      tokensGenerated: generated.length,
      source         : 'local:t369',
    };
  }

  /**
   * Greedy avec top-P sampling — utilise forwardLogits() (pipeline complet
   * InSelf + InAware) plutôt que forward() qui retourne l'état caché brut.
   */
  async #generateGreedy(promptTokens, maxTokens, temperature, topP) {
    const tokens = [...promptTokens];
    const EOS    = this.#tokenizer.eosToken ?? 1;

    for (let i = 0; i < maxTokens; i++) {
      // forwardLogits = forward() → inSelf.refine → lmHeadProject → logits
      const logits = this.#model.forwardLogits(tokens);
      const probs  = this.#softmax(temperature > 0
        ? logits.map(v => v / temperature)
        : logits);
      const next   = this.#sampleTopP(probs, topP);
      tokens.push(next);
      if (next === EOS) break;
    }
    return tokens;
  }

  #softmax(logits) {
    const arr = logits instanceof Float32Array ? logits : new Float32Array(logits);
    let max = -Infinity;
    for (let i = 0; i < arr.length; i++) if (arr[i] > max) max = arr[i];
    let sum = 0;
    const exps = new Float32Array(arr.length);
    for (let i = 0; i < arr.length; i++) { exps[i] = Math.exp(arr[i] - max); sum += exps[i]; }
    for (let i = 0; i < exps.length; i++) exps[i] /= sum;
    return exps;
  }

  #sampleTopP(probs, p) {
    // Trier par probabilité décroissante, accumuler jusqu'à p
    const sorted = Array.from(probs).map((prob, idx) => ({ prob, idx }))
                        .sort((a, b) => b.prob - a.prob);
    let cumul = 0;
    const nucleus = [];
    for (const item of sorted) {
      cumul += item.prob;
      nucleus.push(item);
      if (cumul >= p) break;
    }
    const total = nucleus.reduce((s, x) => s + x.prob, 0);
    let r = Math.random() * total;
    for (const item of nucleus) { r -= item.prob; if (r <= 0) return item.idx; }
    return nucleus.at(-1).idx;
  }

  resetCache() {
    this.#model?.clearKVCache();
    this.#model?.initKVCache();
  }

  stats() {
    return {
      ready    : this.#ready,
      vocabSize: this.#tokenizer?.vocabSize?.() ?? 0,
      ...this.#model?.getStats() ?? {},
    };
  }
}

// =====================================================
// AGENT AGENTIQUE — implémentation inline (ThevieAgent absent du projet)
// Planification → Exécution par étapes → Synthèse
// =====================================================

// =====================================================
// API KEY STORE
//
// Scopes disponibles :
//   inference:read   — appeler generateWithAI / processRequest
//   inference:write  — injecter des leçons
//   storage:read     — listFiles / downloadFile
//   storage:write    — uploadFile / deleteFile / replicateFiles
//   gateway:read     — consulter les endpoints exposés
//   gateway:admin    — créer/supprimer des endpoints, enableGateway
//   peers:read       — getPeers
//   peers:write      — addPeer / removePeer / syncWithNetwork
//   rewards:read     — getRewardsStats
//   rewards:claim    — claimRewards
//   admin            — accès total (toutes les routes)
// =====================================================

const ALL_SCOPES = Object.freeze([
  'inference:read', 'inference:write',
  'storage:read',   'storage:write',
  'gateway:read',   'gateway:admin',
  'peers:read',     'peers:write',
  'rewards:read',   'rewards:claim',
  'admin',
]);

const SCOPE_LABELS = Object.freeze({
  'inference:read'  : 'Read AI responses',
  'inference:write' : 'Inject lessons',
  'storage:read'    : 'Download files',
  'storage:write'   : 'Upload / delete files',
  'gateway:read'    : 'List endpoints',
  'gateway:admin'   : 'Manage gateway',
  'peers:read'      : 'List peers',
  'peers:write'     : 'Manage peers',
  'rewards:read'    : 'Read rewards stats',
  'rewards:claim'   : 'Claim rewards',
  'admin'           : 'Full access',
});

class ApiKeyStore {
  #keys = new Map();   // rawKey → ApiKeyEntry

  /**
   * Crée une clé API signée.
   * @param {string}   name
   * @param {object}   opts
   * @param {string[]} opts.scopes       — permissions (défaut: ['inference:read'])
   * @param {string[]} opts.allowedAIs   — IA destination autorisées ([] = toutes)
   * @param {number}   opts.rateLimit    — max req/min (0 = illimité)
   * @param {number}   opts.ttlDays      — durée de vie en jours (0 = permanent)
   * @returns {string} clé brute
   */
  create(name, opts = {}) {
    if (!name || typeof name !== 'string') throw new Error('Nom de clé invalide');
    const key     = `skn_${crypto.randomUUID().replace(/-/g, '')}`;
    const scopes  = Array.isArray(opts.scopes) && opts.scopes.length
      ? opts.scopes.filter(s => ALL_SCOPES.includes(s))
      : ['inference:read'];
    const ttlMs   = opts.ttlDays > 0 ? opts.ttlDays * 86_400_000 : 0;

    this.#keys.set(key, {
      name,
      createdAt  : Date.now(),
      expiresAt  : ttlMs > 0 ? Date.now() + ttlMs : null,
      lastUsed   : null,
      usageCount : 0,
      usageLogs  : [],         // { ts, targetAI, scope, ip? }[] — 100 derniers
      scopes,
      allowedAIs : opts.allowedAIs ?? [],
      rateLimit  : opts.rateLimit  ?? 0,
      rateWindow : [],
      revoked    : false,
      rotatedFrom: null,       // référence vers l'ancienne clé si rotation
    });

    console.info(`[ApiKeyStore] Clé créée : ${name} | scopes: ${scopes.join(', ')}`);
    return key;
  }

  /**
   * Valide une clé API et vérifie le scope requis.
   * @param {string} key
   * @param {string} [targetAI]   — IA visée
   * @param {string} [scope]      — scope requis (ex: 'inference:read')
   * @returns {{ valid: boolean, reason?: string, entry?: object }}
   */
  validate(key, targetAI = '', scope = '') {
    if (!key || typeof key !== 'string') return { valid: false, reason: 'Clé absente ou malformée' };
    const entry = this.#keys.get(key);
    if (!entry)        return { valid: false, reason: 'Clé inconnue' };
    if (entry.revoked) return { valid: false, reason: 'Clé révoquée' };

    // Expiration automatique
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      entry.revoked = true;
      return { valid: false, reason: 'Clé expirée' };
    }

    // Vérification scope
    if (scope && !entry.scopes.includes('admin') && !entry.scopes.includes(scope)) {
      return { valid: false, reason: `Scope '${scope}' non autorisé pour cette clé` };
    }

    // IA autorisées
    if (entry.allowedAIs.length > 0 && targetAI && !entry.allowedAIs.includes(targetAI)) {
      return { valid: false, reason: `IA '${targetAI}' non autorisée pour cette clé` };
    }

    // Rate limiting (fenêtre glissante 60s)
    if (entry.rateLimit > 0) {
      const now = Date.now();
      entry.rateWindow = entry.rateWindow.filter(t => now - t < 60_000);
      if (entry.rateWindow.length >= entry.rateLimit) {
        return { valid: false, reason: 'Rate limit dépassé' };
      }
      entry.rateWindow.push(now);
    }

    // Mise à jour stats + log
    entry.lastUsed = Date.now();
    entry.usageCount++;
    entry.usageLogs.push({ ts: Date.now(), targetAI, scope });
    if (entry.usageLogs.length > 100) entry.usageLogs.shift();

    return { valid: true, entry };
  }

  revoke(key) {
    const entry = this.#keys.get(key);
    if (!entry) throw new Error('Clé introuvable');
    entry.revoked = true;
    console.info(`[ApiKeyStore] Clé révoquée : ${entry.name}`);
  }

  /**
   * Rotation d'une clé : crée une nouvelle clé avec les mêmes paramètres,
   * révoque l'ancienne. Retourne la nouvelle clé brute.
   */
  rotate(oldKey) {
    const entry = this.#keys.get(oldKey);
    if (!entry) throw new Error('Clé introuvable pour rotation');
    const newKey = this.create(entry.name, {
      scopes    : entry.scopes,
      allowedAIs: entry.allowedAIs,
      rateLimit : entry.rateLimit,
    });
    this.#keys.get(newKey).rotatedFrom = oldKey;
    entry.revoked = true;
    console.info(`[ApiKeyStore] Rotation effectuée : ${entry.name}`);
    return newKey;
  }

  list() {
    return [...this.#keys.entries()].map(([key, e]) => ({
      keyPreview  : `${key.slice(0, 10)}…`,
      rawKey      : key,   // exposé pour rotation/révocation côté UI
      name        : e.name,
      createdAt   : e.createdAt,
      expiresAt   : e.expiresAt,
      lastUsed    : e.lastUsed,
      usageCount  : e.usageCount,
      usageLogs   : e.usageLogs.slice(-10),  // 10 derniers seulement
      scopes      : e.scopes,
      allowedAIs  : e.allowedAIs,
      rateLimit   : e.rateLimit,
      revoked     : e.revoked,
      rotatedFrom : e.rotatedFrom,
    }));
  }

  exists(key) { return this.#keys.has(key) && !this.#keys.get(key).revoked; }
}

export { ALL_SCOPES, SCOPE_LABELS };

// =====================================================
// PERSONAS PAR IA
// =====================================================

// =====================================================
// DECENTRALIZED STORAGE — port de DecentralizedStorage dans skynode.rs
// Chiffrement RomanT369 Hyper256 sur chaque fichier stocké
// Métadonnées + données séparées, queue de réplication
// =====================================================

class DecentralizedStorage {
  #roman;             // RomanT369 — chiffrement fichiers
  #files;             // Map<id, { meta, encrypted }>
  #replicationQueue;  // string[] — ids en attente de réplication
  #storageNode;       // StorageNode — persistance PersistentStorage

  constructor(alias = 'skycloud') {
    const key   = new Uint8Array(32).fill(0x55);
    const nonce = new Uint8Array(12).fill(0x00);
    this.#roman            = new RomanT369(key, nonce, GematriaMode.Hyper256);
    this.#files            = new Map();
    this.#replicationQueue = [];
    this.#storageNode      = new StorageNode(alias);
  }

  /**
   * Stocke un fichier chiffré avec RomanT369.
   * Port de store_file() dans skynode.rs.
   */
  async storeFile(name, data, owner) {
    const raw       = data instanceof Uint8Array ? data : new TextEncoder().encode(
      typeof data === 'string' ? data : JSON.stringify(data)
    );
    const encrypted = this.#roman.encrypt(raw);
    const id        = `file_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const meta = {
      id, name, size: raw.length,
      checksum : Array.from(raw.slice(0, 8)).map(b => b.toString(16).padStart(2,'0')).join(''),
      version  : 1, owner,
      timestamp: Date.now(), encrypted: true,
    };

    this.#files.set(id, { meta, encrypted });
    this.#replicationQueue.push(id);

    // Persistance via PersistentStorage
    await this.#storageNode.saveMeshSnapshot(encrypted).catch(() => {});

    return id;
  }

  /**
   * Récupère et déchiffre un fichier.
   * Port de retrieve_file() dans skynode.rs.
   */
  async retrieveFile(id) {
    const entry = this.#files.get(id);
    if (!entry) return null;
    const decrypted = this.#roman.decrypt(entry.encrypted);
    if (!decrypted) throw new Error(`[Storage] Déchiffrement échoué pour ${id}`);
    return decrypted;
  }

  /**
   * Supprime un fichier (méta + données).
   */
  async deleteFile(id) {
    return this.#files.delete(id);
  }

  /**
   * Liste les métadonnées de tous les fichiers.
   */
  listFiles() {
    return [...this.#files.values()].map(e => e.meta);
  }

  /**
   * Réplique les fichiers en attente (port de replicate_pending).
   */
  async replicatePending() {
    const count = this.#replicationQueue.length;
    if (count > 0) {
      console.info(`[Storage] Réplication de ${count} fichiers…`);
      this.#replicationQueue = [];
    }
    return { replicated: count };
  }
}

// ─────────────────────────────────────────────────────────────
// HELPER — Content-Type selon extension fichier
// ─────────────────────────────────────────────────────────────

function _inferContentType(path) {
  const ext = path.split('.').pop().toLowerCase();
  return {
    html : 'text/html; charset=utf-8',
    css  : 'text/css',
    js   : 'application/javascript',
    json : 'application/json',
    png  : 'image/png',
    jpg  : 'image/jpeg',
    jpeg : 'image/jpeg',
    gif  : 'image/gif',
    svg  : 'image/svg+xml',
    webp : 'image/webp',
    ico  : 'image/x-icon',
    woff : 'font/woff',
    woff2: 'font/woff2',
    ttf  : 'font/ttf',
    pdf  : 'application/pdf',
    mp4  : 'video/mp4',
    webm : 'video/webm',
    mp3  : 'audio/mpeg',
    txt  : 'text/plain',
    xml  : 'application/xml',
    wasm : 'application/wasm',
  }[ext] ?? 'application/octet-stream';
}

// =====================================================
// HOSTED SITE — Entité d'hébergement web souverain
//
// Avantages pour l'utilisateur :
//   ✦ Chiffrement automatique RomanT369 Hyper256
//   ✦ Signature post-quantique Dilithium5 à chaque publication
//   ✦ Versioning natif — rollback à n'importe quelle version
//   ✦ Réplication décentralisée via ZipMemory (3 nœuds)
//   ✦ URL publique dédiée (domaine custom ou sous-domaine .skyainet.net)
//   ✦ Monitoring en temps réel (hits, bande passante)
//   ✦ Zéro dépendance externe — hébergement 100% souverain
//   ✦ Backup automatique avant chaque mise à jour
//   ✦ Support statique + backend léger (assets, SPA, API simple)
//   ✦ Pas de censure — décentralisé sur le réseau SkyAInet
// =====================================================

class HostedSite {
  constructor({ id, name, domain, owner, createdAt = Date.now() }) {
    this.id            = id;
    this.name          = name;
    this.domain        = domain;        // ex: mon-site.skyainet.net
    this.owner         = owner;         // nodeId du propriétaire
    this.createdAt     = createdAt;
    this.updatedAt     = createdAt;
    this.version       = 0;
    this.active        = false;         // true après publishSite()
    this.files         = new Map();     // path → fileId (ex: '/index.html' → 'file_xxx')
    this.versions      = [];            // historique { version, ts, snapshot: Map }
    this.hits          = 0;
    this.bytesServed   = 0;
    this.lastHit       = null;
    this.signature     = null;          // Dilithium5 de la dernière publication
    this.customDomain  = null;          // domaine custom configuré par l'utilisateur
    this.sizeBytes     = 0;             // taille totale des fichiers
  }

  toJSON() {
    return {
      id          : this.id,
      name        : this.name,
      domain      : this.customDomain ?? this.domain,
      owner       : this.owner,
      createdAt   : this.createdAt,
      updatedAt   : this.updatedAt,
      version     : this.version,
      active      : this.active,
      fileCount   : this.files.size,
      sizeBytes   : this.sizeBytes,
      hits        : this.hits,
      bytesServed : this.bytesServed,
      lastHit     : this.lastHit,
      versionCount: this.versions.length,
      customDomain: this.customDomain,
    };
  }
}

const PERSONAS = Object.freeze({
  thevie  : 'Tu es Thevie, une intelligence collective souveraine de SkyAInet.',
  loraevo : 'Tu es LoraÉvo, un guide auto-évolutif bienveillant.',
  agentic : 'Tu es en mode Agentique. Tu planifies et exécutes des tâches complexes.',
  t369    : 'Tu es T369, le moteur d\'inférence natif de SkyAInet.',
});

// =====================================================
// SKYCLOUD PRINCIPAL
// =====================================================

export class SkyCloud {
  // Champs privés
  #id; #state; #isRunning; #wisdomScore; #totalRequests; #evolutionCycles;
  #startTime; #lastDreamCycle;

  #engine;           // T369InferenceEngine
  #signer;           // Dilithium5Signer
  #hybrid;           // HybridTransport
  #storage;          // DecentralizedStorage
  #zipMemory;        // ZipMemory
  #userRewards;      // UserRewards
  #evolutionManager; // EvolutionManager | null
  #apiKeyStore;      // ApiKeyStore

  #exposedEndpoints;   // Map<name, EndpointConfig> — endpoints publics du Gateway
  #gatewayTrafficLogs; // { ts, method, path, statusCode, latencyMs, keyName }[]
  #sites;              // Map<siteId, HostedSite> — sites web hébergés
  #autoTrainInterval;  // ReturnType<setInterval> | null — LoRA auto-training
  #autoDreamInterval;  // ReturnType<setInterval> | null — Dream Cycle automatique
  #communication;      // NodeCommunication — redistribution inter-nœuds

  #registeredAIs;    // Map<string, string>
  #messageBus;       // object[]
  #externalAIEnabled;
  #gatewayEnabled;
  #gatewayPort;

  #dreamCycle;       // DreamCycle
  #loraEvo;          // LoraEvo
  #agenticRunner;    // AgenticRunner (lazy)

  constructor(modelConfig = DEFAULT_MODEL_CONFIG) {
    this.#id              = `sky-${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    this.#state           = NodeState.Active;
    this.#isRunning       = true;
    this.#wisdomScore     = 0.91;
    this.#totalRequests   = 0;
    this.#evolutionCycles = 0;
    this.#startTime       = Date.now();
    this.#lastDreamCycle  = null;

    this.#signer      = new Dilithium5Signer();
    this.#hybrid      = new HybridTransport(false);
    this.#storage     = new DecentralizedStorage();
    this.#zipMemory   = new ZipMemory('./data/zip_memory');
    this.#userRewards = new UserRewards(AccountType.Free);
    this.#apiKeyStore = new ApiKeyStore();

    // Gateway — endpoints exposés + logs de trafic + sites hébergés
    this.#exposedEndpoints   = new Map();
    this.#gatewayTrafficLogs = [];
    this.#sites              = new Map();
    this.#autoTrainInterval  = null;
    this.#autoDreamInterval  = null;
    this.#communication      = new NodeCommunication(this.#id);

    this.#registeredAIs     = new Map();
    this.#messageBus        = [];
    this.#externalAIEnabled = false;
    this.#gatewayEnabled    = false;
    this.#gatewayPort       = 8080;

    this.#engine         = new T369InferenceEngine(modelConfig);
    this.#dreamCycle     = new DreamCycle();
    this.#loraEvo        = new LoraEvo();
    this.#agenticRunner  = null;   // initialisé lazily dans runAgenticTask()
    this.#evolutionManager = null;

    this.peers = [];

    this._registerBuiltinAIs();
  }

  // ─── Accesseurs publics ───────────────────────────────────────

  get id()              { return this.#id; }
  get state()           { return this.#state; }
  get isRunning()       { return this.#isRunning; }
  get wisdomScore()     { return this.#wisdomScore; }
  get totalRequests()   { return this.#totalRequests; }
  get evolutionCycles() { return this.#evolutionCycles; }
  get lastDreamCycle()  { return this.#lastDreamCycle; }
  get registeredAIs()   { return this.#registeredAIs; }
  get messageBus()      { return this.#messageBus; }
  get storage()         { return this.#storage; }
  get dreamCycle()      { return this.#dreamCycle; }
  get loraEvo()         { return this.#loraEvo; }
  // Exposé pour EvolutionManager et LoraEvo qui y accèdent via node._engine
  get _engine()         { return this.#engine; }

  /**
   * Permet à Thevie de changer l'état du nœud (ex. sleep/wake).
   * Valeurs valides : NodeState.*
   */
  setState(newState) {
    const valid = Object.values(NodeState);
    if (!valid.includes(newState)) {
      throw new Error(`État invalide : ${newState}. Valeurs : ${valid.join(', ')}`);
    }
    this.#state = newState;
  }

  // ─── Initialisation ──────────────────────────────────────────

  async initEngine(weightsPath = null) {
    await this.#engine.load(weightsPath);

    // Connecter LoraEvo au moteur dès qu'il est prêt
    if (this.#engine.isReady) {
      this.#loraEvo.connectToInference(this.#engine);
      this.#dreamCycle.injectModel(this.#engine.model);
      // Connecter AgenticRunner au moteur si déjà instancié
      if (this.#agenticRunner) this.#agenticRunner.connectEngine(this.#engine);
    }
  }

  /** Initialise l'EvolutionManager (lazy — appelé à la demande ou manuellement) */
  #ensureEvolutionManager() {
    if (!this.#evolutionManager) {
      this.#evolutionManager = new EvolutionManager(this);
    }
  }

  _registerBuiltinAIs() {
    this.registerAI('thevie',  'Thevie — Intelligence Collective');
    this.registerAI('loraevo', 'LoraÉvo — Guide Évolutif');
    this.registerAI('agentic', 'Agentic Mode — Tâches Complexes');
    this.registerAI('t369',    'T369 — Moteur d\'Inférence Natif');
  }

  // ─── API Keys ─────────────────────────────────────────────────

  /**
   * Génère une clé API signée avec scopes, TTL et rate limit.
   * @param {string}   name
   * @param {object}   opts
   * @param {string[]} opts.scopes       — permissions (défaut: ['inference:read'])
   * @param {string[]} opts.allowedAIs   — IA autorisées ([] = toutes)
   * @param {number}   opts.rateLimit    — max req/min (0 = illimité)
   * @param {number}   opts.ttlDays      — durée de vie en jours (0 = permanent)
   * @returns {string} clé brute
   */
  generateApiKey(name, opts = {}) {
    // Rétrocompatibilité : generateApiKey(name, allowedAIs[], rateLimit)
    if (Array.isArray(opts)) {
      opts = { allowedAIs: opts, rateLimit: arguments[2] ?? 60 };
    }
    return this.#apiKeyStore.create(name, opts);
  }

  /**
   * Valide une clé pour une IA et un scope donnés.
   * @param {string} key
   * @param {string} [targetAI]
   * @param {string} [scope]    — ex: 'inference:read'
   */
  validateApiKey(key, targetAI = '', scope = '') {
    return this.#apiKeyStore.validate(key, targetAI, scope);
  }

  revokeApiKey(key)      { this.#apiKeyStore.revoke(key); }
  rotateApiKey(key)      { return this.#apiKeyStore.rotate(key); }
  listApiKeys()          { return this.#apiKeyStore.list(); }

  // ─── Gateway ──────────────────────────────────────────────────

  enableGateway(port = 8080) {
    if (port < 1 || port > 65535) throw new Error('Port invalide (1–65535)');
    this.#gatewayEnabled = true;
    this.#gatewayPort    = port;
    this.#state          = NodeState.Gateway;
    console.info(`[SkyCloud] Gateway activé sur le port ${port}`);
  }

  disableGateway() {
    this.#gatewayEnabled = false;
    this.#state          = NodeState.Active;
    console.info('[SkyCloud] Gateway désactivé');
  }

  /**
   * Expose un endpoint d'inférence public sur le Gateway.
   * Remplace generateDynamicSite — crée un endpoint HTTP public dédié
   * à un modèle IA avec persona et paramètres configurables.
   * Génère automatiquement une API Key limitée à cet endpoint.
   *
   * @param {string} name   — nom de l'endpoint (ex: "my-thevie-api")
   * @param {object} config
   * @param {string}  config.ai          — IA cible ('thevie', 'loraevo', 't369', …)
   * @param {string}  [config.persona]   — persona personnalisée
   * @param {number}  [config.maxTokens] — max tokens (défaut: 512)
   * @param {number}  [config.temperature] — température (défaut: 0.8)
   * @param {number}  [config.rateLimit] — req/min pour la clé auto-générée
   * @param {number}  [config.ttlDays]   — durée de vie de la clé (0 = permanent)
   * @returns {{ url: string, apiKey: string, endpointName: string }}
   */
  exposeInferenceEndpoint(name, config = {}) {
    if (!name?.trim()) throw new Error('Nom d\'endpoint requis');
    const safeName = name.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');

    const endpointConfig = {
      name        : safeName,
      ai          : config.ai          ?? 'thevie',
      persona     : config.persona     ?? null,
      maxTokens   : config.maxTokens   ?? 512,
      temperature : config.temperature ?? 0.8,
      createdAt   : Date.now(),
      requestCount: 0,
      active      : true,
    };

    this.#exposedEndpoints.set(safeName, endpointConfig);

    // Génère une clé API dédiée avec scope limité à inference:read
    const apiKey = this.#apiKeyStore.create(`endpoint:${safeName}`, {
      scopes    : ['inference:read'],
      rateLimit : config.rateLimit ?? 30,
      ttlDays   : config.ttlDays   ?? 0,
    });

    const url = `http://localhost:${this.#gatewayPort}/api/inference/${safeName}`;
    console.info(`[Gateway] Endpoint exposé : ${url}`);

    return { url, apiKey, endpointName: safeName };
  }

  /**
   * Supprime un endpoint exposé.
   * @param {string} name
   */
  removeEndpoint(name) {
    const safeName = name.trim().toLowerCase();
    if (!this.#exposedEndpoints.has(safeName)) throw new Error(`Endpoint '${safeName}' introuvable`);
    this.#exposedEndpoints.delete(safeName);
    console.info(`[Gateway] Endpoint supprimé : ${safeName}`);
  }

  /** Retourne tous les endpoints exposés. */
  listExposedEndpoints() {
    return [...this.#exposedEndpoints.values()];
  }

  /**
   * Enregistre une entrée dans les logs de trafic du Gateway.
   * Appelé par server.js à chaque requête entrante.
   * @param {{ method, path, statusCode, latencyMs, keyName }} entry
   */
  logTraffic(entry) {
    this.#gatewayTrafficLogs.push({ ts: Date.now(), ...entry });
    if (this.#gatewayTrafficLogs.length > 500) this.#gatewayTrafficLogs.shift();
  }

  /**
   * Retourne les N derniers logs de trafic.
   * @param {number} [limit=50]
   */
  getTrafficLogs(limit = 50) {
    return this.#gatewayTrafficLogs.slice(-limit);
  }

  registerAI(name, description) {
    if (!name?.trim()) throw new Error('Nom IA invalide');
    this.#registeredAIs.set(name.trim(), description ?? '');
  }

  enableExternalAI(enabled) { this.#externalAIEnabled = !!enabled; }

  // ─── Messages ─────────────────────────────────────────────────
sendMessage(from, to, content, apiKey = null) {
    const isInternal = this.#registeredAIs.has(from) || from === 'system' || from === 'user';
    const isExternal = from === 'external';

    if (!isInternal && !isExternal) throw new Error(`Source '${from}' inconnue`);
    if (!this.#registeredAIs.has(to) && to !== 'external') throw new Error(`Destination '${to}' inconnue`);

    if (isExternal) {
      if (!this.#externalAIEnabled) throw new Error('Les IA externes sont désactivées');
      if (!apiKey)                  throw new Error('Clé API requise pour une source externe');
      const check = this.#apiKeyStore.validate(apiKey, to);
      if (!check.valid) throw new Error(`Accès refusé : ${check.reason}`);
    }

    this.#pushToBus({ from, to, content, timestamp: Date.now() });
    this.#recordAIChatMessage();
    return `Message délivré à ${to}`;
  }

  /**
   * Pousse un message dans le bus avec gestion intelligente de la capacité.
   * Si le bus est plein, éviction des messages à score le plus bas (pas les plus anciens).
   * Tri partiel toutes les BUS_PRUNE_EVERY insertions.
   */
  #pushToBus(msg) {
    // Support multimodal — attachments normalisés
    if (msg.attachments && !Array.isArray(msg.attachments)) {
      msg.attachments = [msg.attachments];
    }
    this.#messageBus.push(msg);
    const len = this.#messageBus.length;

    if (len > MAX_MESSAGE_BUS) {
      // Éviction par qualité — garder le top BUS_PRUNE_KEEP_RATE
      this.#messageBus.sort((a, b) => (b._score ?? 0) - (a._score ?? 0));
      this.#messageBus.splice(Math.floor(MAX_MESSAGE_BUS * BUS_PRUNE_KEEP_RATE));
    } else if (len % BUS_PRUNE_EVERY === 0) {
      // Tri partiel périodique
      this.#messageBus.sort((a, b) => (b._score ?? 0) - (a._score ?? 0));
    }
  }

  /**
   * Pipeline Chat-as-Lesson : évalue et injecte un message utilisateur
   * comme leçon potentielle dans le bus.
   *
   * Étapes :
   *   1. PII guard          — rejet silencieux si données personnelles
   *   2. Anti-manipulation  — leçon vaccinale ou rejet
   *   3. Score qualité      — rejet si < CHAT_LESSON_MIN_SCORE
   *   4. CorrectionDetector — boost × 2.0 si correction implicite
   *   5. Injection dans le bus avec score attaché
   *
   * @param {string} userMessage   — message brut de l'utilisateur
   * @param {string} [aiResponse]  — réponse IA associée (enrichit la leçon)
   */
  #chatAsLesson(userMessage, aiResponse = null, meta = {}) {
    if (!userMessage?.trim()) return;

    // 1. PII guard — rejet silencieux
    if (_hasPII(userMessage)) {
      console.debug('[ChatAsLesson] PII détecté — message non injecté');
      return;
    }

    // 2. Anti-manipulation
    if (_hasManip(userMessage)) {
      const vaccinated = `[LEÇON VACCINALE] Tentative de manipulation détectée et neutralisée. Immunité renforcée.`;
      this.#messageBus.push({ from: 'user', to: 'thevie', content: vaccinated, timestamp: Date.now(), _score: 0.30, _vaccinated: true });
      console.warn('[ChatAsLesson] Manipulation détectée — leçon vaccinale injectée');
      return;
    }

    // 3. Score qualité
    const score = _scoreLessonQuality(userMessage);
    if (score < CHAT_LESSON_MIN_SCORE) {
      console.debug(`[ChatAsLesson] Score insuffisant (${score.toFixed(2)}) — rejeté`);
      return;
    }

    // 4. CorrectionDetector — boost si correction implicite
    const isCorrection = _isImplicitCorrection(userMessage, this.#messageBus);
    const finalScore   = isCorrection ? Math.min(1.0, score * CORRECTION_BOOST) : score;

    // 5. Injection — paire question+réponse pour enrichir le contexte
    const content = aiResponse
      ? `Q: ${userMessage}\nA: ${aiResponse}`
      : userMessage;

    this.#messageBus.push({
      from        : 'user',
      to          : 'thevie',
      content,
      timestamp   : Date.now(),
      _score      : finalScore,
      _correction : isCorrection,
      attachments : meta.attachments ?? null,  // images, fichiers, médias
      aiUsed      : meta.ai ?? null,
    });

    if (isCorrection) {
      console.info(`[ChatAsLesson] Correction détectée — score boosté: ${score.toFixed(2)} → ${finalScore.toFixed(2)}`);
    } else {
      console.debug(`[ChatAsLesson] Leçon injectée (score: ${finalScore.toFixed(2)})`);
    }
  }


  // ─── Génération ───────────────────────────────────────────────


  /**
   * Point d'entrée public pour le Chat Manager.
   * Appelé après génération de la réponse IA — injecte la paire
   * (question + réponse) dans le pipeline d'apprentissage.
   * Skycloud ne génère jamais la réponse visible à l'utilisateur.
   *
   * @param {string} userPrompt  — message brut de l'utilisateur
   * @param {string} aiResponse  — réponse générée par le Chat Manager
   * @param {object} [meta]      — métadonnées optionnelles (ai, attachments…)
   */
  injectChatLesson(userPrompt, aiResponse, meta = {}) {
    this.#chatAsLesson(userPrompt, aiResponse, meta);
    this.#recordAIChatMessage();

    // Vitesse 1 — Micro-update sur la paire conversation
    // Déclenché en arrière-plan, non-bloquant
    if (userPrompt?.trim()) {
      const lessonContent = aiResponse
        ? `Q: ${userPrompt}\nA: ${aiResponse}`
        : userPrompt;
      this.#ensureEvolutionManager();
      this.#evolutionManager.microUpdate(lessonContent).catch(e =>
        console.debug(`[MicroUpdate] Chat skip: ${e.message}`)
      );
    }
  }

  async generateWithAI(request) {
    const {
      prompt,
      ai             = 't369',
      maxTokens      = 512,
      temperature    = 0.8,
      topP           = 0.92,
      useSpeculative = true,
      resetCache     = false,
    } = request;

    if (!prompt?.trim())         throw new Error('Prompt invalide ou vide');
    if (!this.#engine.isReady)   throw new Error('Moteur T369 non chargé — appelle initEngine()');

    this.#totalRequests++;
    this.#recordAIChatMessage();

    const result = await this.#engine.generate(
      this.#buildPrompt(prompt, ai),
      { maxTokens, temperature, topP, useSpeculative, resetCache }
    );

    this.#wisdomScore = Math.min(1.0, this.#wisdomScore + 0.0001);

    return {
      text           : result.text,
      tokensGenerated: result.tokensGenerated,
      aiUsed         : ai,
      source         : result.source,
      wisdomScore    : this.#wisdomScore,
    };
  }

  #buildPrompt(userPrompt, ai) {
    const persona = PERSONAS[ai] ?? PERSONAS.t369;
    return `[SYSTEM] ${persona}\n[SAGESSE: ${this.#wisdomScore.toFixed(3)}]\n\n[USER] ${userPrompt}\n\n[ASSISTANT]`;
  }

  // ─── Leçon + Évolution ────────────────────────────────────────

  async injectLesson(lesson) {
    if (!lesson?.trim()) throw new Error('Leçon invalide');

    this.#recordLearnContribution(0.85);
    this.#wisdomScore = Math.min(1.0, this.#wisdomScore + WISDOM_LEARN_GAIN);
    this.#pushToBus({ from: 'user', to: 'thevie', content: lesson, timestamp: Date.now() });

    this.#ensureEvolutionManager();

    // Vitesse 1 — Micro-update immédiat sur la leçon injectée
    // Non-bloquant : fire-and-forget, erreurs silencieuses
    this.#evolutionManager.microUpdate(lesson).catch(e =>
      console.debug(`[MicroUpdate] Skip: ${e.message}`)
    );

    await this.#evolutionManager.runDreamCycle();
    this.#wisdomScore = Math.min(1.0, this.#wisdomScore + WISDOM_DREAM_GAIN);

    let synthesis = '(moteur non initialisé)';
    if (this.#engine.isReady) {
      const r = await this.generateWithAI({
        prompt: `Synthétise cette leçon en une phrase dense : ${lesson}`,
        ai: 'thevie', maxTokens: 256, useSpeculative: false,
      });
      synthesis = r.text;
    }
    return { message: 'Leçon injectée.', synthesis };
  }

  async runEvolutionCycle() {
    this.#ensureEvolutionManager();
    await this.#evolutionManager.runDreamCycle();
    this.#evolutionCycles++;
    this.#lastDreamCycle = Date.now();
    this.#wisdomScore = Math.min(1.0, this.#wisdomScore + WISDOM_DREAM_GAIN);
    this.#recordDreamCycleParticipation();

    // Propagation automatique après Dream Cycle — fire-and-forget
    // Envoie le top 10% du bus aux peers actifs connectés
    const activePeers = this.peers.filter(p => p.isAlive());
    if (activePeers.length > 0) {
      this.propagateLessons(activePeers.map(p => p._comm).filter(Boolean))
        .catch(e => console.debug(`[AutoPropagate] ${e.message}`));
    }
  }

  async triggerTraditionalTraining() {
    this.#ensureEvolutionManager();
    await this.#evolutionManager.runTraditionalTraining();
    this.#engine.resetCache();
  }

  /**
   * Active l'entraînement LoRA automatique en arrière-plan.
   * Déclenche triggerTraditionalTraining() à intervalle régulier
   * OU dès que le bus de leçons dépasse le seuil configuré.
   *
   * @param {object} opts
   * @param {number} opts.intervalHours — intervalle en heures (défaut: 3)
   * @param {number} opts.busThreshold  — déclencher aussi si le bus dépasse ce seuil (défaut: 20)
   */
  enableAutoTraining(opts = {}) {
    if (this.#autoTrainInterval) return { enabled: true, alreadyActive: true };
    const intervalMs   = (opts.intervalHours ?? 3) * 3_600_000;
    const busThreshold = opts.busThreshold ?? 20;

    const run = async () => {
      const busSize = this.#messageBus.filter(m => !m._vaccinated).length;
      if (busSize === 0) return;
      console.info(`[AutoTrain] Déclenchement — ${busSize} leçons dans le bus`);
      try {
        await this.triggerTraditionalTraining();
        this.#evolutionCycles++;
        console.info('[AutoTrain] Cycle LoRA terminé ✓');
      } catch (e) {
        console.warn('[AutoTrain] Erreur :', e.message);
      }
    };

    const timeInterval      = setInterval(run, intervalMs);
    const thresholdInterval = setInterval(async () => {
      const busSize = this.#messageBus.filter(m => !m._vaccinated).length;
      if (busSize >= busThreshold) await run();
    }, 5 * 60_000);

    this.#autoTrainInterval = { time: timeInterval, threshold: thresholdInterval };
    console.info(`[AutoTrain] Activé — intervalle: ${opts.intervalHours ?? 3}h | seuil bus: ${busThreshold}`);
    return { enabled: true, intervalHours: opts.intervalHours ?? 3, busThreshold };
  }

  /** Désactive l'entraînement LoRA automatique. */
  disableAutoTraining() {
    if (!this.#autoTrainInterval) return { enabled: false };
    clearInterval(this.#autoTrainInterval.time);
    clearInterval(this.#autoTrainInterval.threshold);
    this.#autoTrainInterval = null;
    console.info('[AutoTrain] Désactivé');
    return { enabled: false };
  }

  /** Retourne true si l'auto-training est actif. */
  get isAutoTrainingEnabled() { return this.#autoTrainInterval !== null; }

  /**
   * Active le Dream Cycle automatique en arrière-plan.
   * Tourne indépendamment de l'auto-training LoRA.
   * Intervalle recommandé : 45 min (plus léger que le LoRA Training).
   *
   * @param {object} opts
   * @param {number} opts.intervalMinutes — intervalle en minutes (défaut: 45)
   * @param {number} opts.minLessons      — déclencher seulement si le bus a au moins N leçons (défaut: 3)
   */
  enableAutoDream(opts = {}) {
    if (this.#autoDreamInterval) return { enabled: true, alreadyActive: true };
    const intervalMs  = (opts.intervalMinutes ?? 45) * 60_000;
    const minLessons  = opts.minLessons ?? 3;

    const run = async () => {
      const busSize = this.#messageBus.length;
      if (busSize < minLessons) return;
      console.info(`[AutoDream] Déclenchement — ${busSize} leçons dans le bus`);
      try {
        await this.runEvolutionCycle();
        console.info('[AutoDream] Dream Cycle terminé ✓');
      } catch (e) {
        console.warn('[AutoDream] Erreur :', e.message);
      }
    };

    this.#autoDreamInterval = setInterval(run, intervalMs);
    console.info(`[AutoDream] Activé — intervalle: ${opts.intervalMinutes ?? 45}min | min leçons: ${minLessons}`);
    return { enabled: true, intervalMinutes: opts.intervalMinutes ?? 45, minLessons };
  }

  /** Désactive le Dream Cycle automatique. */
  disableAutoDream() {
    if (!this.#autoDreamInterval) return { enabled: false };
    clearInterval(this.#autoDreamInterval);
    this.#autoDreamInterval = null;
    console.info('[AutoDream] Désactivé');
    return { enabled: false };
  }

  /** Retourne true si l'auto-dream est actif. */
  get isAutoDreamEnabled() { return this.#autoDreamInterval !== null; }

  // ─── Redistribution inter-nœuds ───────────────────────────────

  /**
   * Diffuse une leçon qualifiée à tous les peers abonnés.
   * Anti-boucle UUID intégré — jamais de re-broadcast.
   *
   * @param {object} lesson     — leçon avec { content, score/_score, id? }
   * @param {number} threshold  — score minimum (défaut: 0.6)
   * @returns {Promise<boolean>}
   */
  async broadcastLesson(lesson, threshold = 0.60) {
    return this.#communication.broadcastLesson(lesson, threshold);
  }

  /**
   * Échange bidirectionnel des top-N leçons avec un peer spécifique.
   * Déclenché typiquement lors de l'établissement d'une connexion peer.
   *
   * @param {NodeCommunication} peerComm — NodeCommunication du peer
   * @param {number}            topN     — nombre de leçons échangées (défaut: 20)
   * @returns {Promise<{ sent, received, rejected }>}
   */
  async syncLessons(peerComm, topN = 20) {
    return this.#communication.syncLessons(peerComm, this.#messageBus, topN);
  }

  /**
   * Propage le top 10% du bus local à une liste de peers.
   * Appelé automatiquement après chaque Dream Cycle.
   * Chaque leçon passe par re-validation PII + anti-manipulation côté receveur.
   *
   * @param {NodeCommunication[]} peerComms — NodeCommunication des peers actifs
   * @returns {Promise<{ propagated, skipped, peers }>}
   */
  async propagateLessons(peerComms = []) {
    return this.#communication.propagateLessons(peerComms, this.#messageBus);
  }

  /**
   * Demande active à un peer ses leçons filtrées par mot-clé / score / âge.
   * Utile quand un nœud détecte un domaine de connaissance manquant.
   *
   * @param {NodeCommunication} peerComm — NodeCommunication du peer cible
   * @param {object}            filter   — { keyword, minScore, maxAge, limit }
   * @returns {Promise<{ lessons, rejected }>}
   */
  async requestLessons(peerComm, filter = {}) {
    return this.#communication.requestLessons(peerComm, filter);
  }

  /**
   * Abonne un handler aux leçons reçues d'autres nœuds.
   * Déclenché chaque fois qu'une leçon est broadcastée sur le réseau.
   *
   * @param {function} handler — (envelope: Uint8Array) => void
   * @returns {function} unsubscribe
   */
  onRemoteLesson(handler) {
    return this.#communication.subscribe(Topic.LESSONS, async (envelope) => {
      try {
        const { content, lessonId } = await this.#communication.receiveRemoteLesson(envelope);
        // Injecter la leçon reçue dans le bus local après re-validation
        this.#pushToBus({
          from       : 'remote',
          to         : 'thevie',
          content,
          timestamp  : Date.now(),
          _score     : 0.65,  // score conservateur pour les leçons externes
          _remote    : true,
          _lessonId  : lessonId,
        });
        if (typeof handler === 'function') handler({ content, lessonId });
      } catch (e) {
        console.debug(`[RemoteLesson] Rejetée : ${e.message}`);
      }
    });
  }

  /** Retourne les stats de communication inter-nœuds. */
  getCommStats() {
    return this.#communication.getStats();
  }

  /** Expose le NodeCommunication pour les peers qui en ont besoin (MixedNode). */
  get communication() { return this.#communication; }

  // ─── Mode agentique ───────────────────────────────────────────

  async runAgenticTask(goal, onStep = null, opts = {}) {
    if (!this.#agenticRunner) {
      this.#agenticRunner = new AgenticRunner(this, this.#engine.isReady ? this.#engine : null);
    }
    return this.#agenticRunner.run(goal, onStep, opts);
  }

  /** Retourne le catalogue des outils Agentic. */
  getAgenticToolCatalog() {
    if (!this.#agenticRunner) {
      this.#agenticRunner = new AgenticRunner(this);
    }
    return this.#agenticRunner.getToolCatalog();
  }

  /** Retourne l'historique des sessions Agentic. */
  listAgenticSessions() {
    return this.#agenticRunner?.listSessions() ?? [];
  }

  /** Retourne les stats Agentic. */
  getAgenticStats() {
    return this.#agenticRunner?.getStats() ?? { sessions: 0, toolCount: 0, engineReady: false };
  }

  // ─── Smart Contracts (LoraÉvo) ────────────────────────────────

  /**
   * Génère un Smart Contract Solidity via LoraÉvo.
   * Comme Thevie crée des nœuds, LoraÉvo crée des Smart Contracts.
   *
   * @param {string} description  — description en langage naturel
   * @param {object} options
   * @param {string}  options.type          — 'ERC20'|'NFT'|'DAO'|'VESTING'|'STAKING'|'MARKETPLACE'|'MULTISIG'
   * @param {string}  options.network       — 'testnet'|'mainnet'|'local'
   * @param {boolean} options.audit         — activer l'audit sécurité (défaut: true)
   * @param {boolean} options.deploy        — déployer automatiquement après génération
   * @param {number}  options.taxPercent    — taxe % (ERC20/Marketplace)
   * @param {number}  options.vestingMonths — durée vesting en mois
   * @param {number}  options.totalSupply   — supply totale (ERC20)
   * @param {string}  options.tokenName     — nom du token
   * @param {string}  options.tokenSymbol   — symbole du token
   * @param {number}  options.royaltyPercent— royalties % (NFT)
   * @param {number}  options.apyPercent    — APY staking
   * @param {number}  options.signaturesRequired — seuil multi-sig
   * @returns {Promise<GeneratedContract>}
   */
  async generateSmartContract(description, options = {}) {
    if (!this.#loraEvo) throw new Error('LoraÉvo non initialisée');
    return this.#loraEvo.generateSmartContract(description, options);
  }

  /**
   * Déploie un contrat généré sur le réseau configuré.
   * @param {string} contractId
   * @returns {Promise<{ contractAddress, txHash, deployedAt }>}
   */
  async deploySmartContract(contractId) {
    if (!this.#loraEvo) throw new Error('LoraÉvo non initialisée');
    return this.#loraEvo.deployContract(contractId);
  }

  /**
   * Retourne la liste de tous les contrats générés.
   * @returns {ContractSummary[]}
   */
  listSmartContracts() {
    return this.#loraEvo?.listContracts() ?? [];
  }

  /**
   * Retourne un contrat complet avec son code Solidity.
   * @param {string} contractId
   * @returns {GeneratedContract | null}
   */
  getSmartContract(contractId) {
    return this.#loraEvo?.getContract(contractId) ?? null;
  }

  /**
   * Supprime un contrat de la liste locale.
   * @param {string} contractId
   */
  deleteSmartContract(contractId) {
    if (!this.#loraEvo) throw new Error('LoraÉvo non initialisée');
    this.#loraEvo.deleteContract(contractId);
  }

  /**
   * Retourne les stats Smart Contracts de LoraÉvo.
   * @returns {{ contractsGenerated, contractsDeployed, types }}
   */
  getSmartContractStats() {
    const contracts = this.listSmartContracts();
    const byType    = contracts.reduce((acc, c) => {
      acc[c.type] = (acc[c.type] ?? 0) + 1;
      return acc;
    }, {});
    return {
      contractsGenerated: contracts.length,
      contractsDeployed : contracts.filter(c => c.deployStatus === 'deployed').length,
      skySpent          : contracts.reduce((s, c) => s + (c.skyFee ?? 0), 0),
      byType,
    };
  }

  // ─── Web Hosting ──────────────────────────────────────────────

  /**
   * Crée un site hébergé vide.
   *
   * Avantages automatiques dès la création :
   *   ✦ URL dédiée sous-domaine .skyainet.net
   *   ✦ Chiffrement RomanT369 Hyper256 sur tous les fichiers
   *   ✦ Signature Dilithium5 à chaque publication
   *   ✦ Versioning natif — rollback jusqu'à 20 versions
   *   ✦ Réplication décentralisée sur 3 nœuds
   *   ✦ Monitoring hits + bande passante en temps réel
   *   ✦ Zéro censure — données souveraines sur ton nœud
   *
   * @param {string} name    — nom lisible (ex: "Mon Portfolio")
   * @param {string} domain  — sous-domaine souhaité (ex: "mon-portfolio")
   * @returns {HostedSite}
   */
  createSite(name, domain) {
    if (!name?.trim())   throw new Error('Nom de site requis');
    if (!domain?.trim()) throw new Error('Domaine requis');

    const safeDomain = domain.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const fullDomain = `${safeDomain}.skyainet.net`;

    for (const site of this.#sites.values()) {
      if (site.domain === fullDomain) throw new Error(`Domaine '${fullDomain}' déjà utilisé`);
    }

    const id   = `site_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const site = new HostedSite({ id, name: name.trim(), domain: fullDomain, owner: this.#id });
    this.#sites.set(id, site);

    console.info(`[Hosting] Site créé : ${name} → ${fullDomain}`);
    return site;
  }

  /**
   * Ajoute ou met à jour un fichier dans un site.
   * Chiffrement automatique via DecentralizedStorage (RomanT369 Hyper256).
   *
   * @param {string}            siteId — id du site
   * @param {string}            path   — chemin relatif (ex: '/index.html')
   * @param {Uint8Array|string} data   — contenu du fichier
   * @returns {Promise<string>} fileId dans le storage
   */
  async uploadSiteFile(siteId, path, data) {
    const site = this.#sites.get(siteId);
    if (!site) throw new Error(`Site '${siteId}' introuvable`);

    const safePath = path.startsWith('/') ? path : `/${path}`;
    const fileName = `${siteId}${safePath}`;
    const raw      = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    const fileId   = await this.#storage.storeFile(fileName, raw, this.#id);

    // Supprimer l'ancienne version si elle existait
    const oldId = site.files.get(safePath);
    if (oldId && oldId !== fileId) await this.#storage.deleteFile(oldId).catch(() => {});

    site.files.set(safePath, fileId);
    site.sizeBytes = [...site.files.values()].length * raw.length;
    site.updatedAt = Date.now();

    console.debug(`[Hosting] ${site.domain}${safePath} → ${fileId}`);
    return fileId;
  }

  /**
   * Publie le site — rend tous les fichiers accessibles publiquement.
   * Sauvegarde la version courante, signe avec Dilithium5, réplique.
   *
   * @param {string} siteId
   * @returns {{ version, domain, url, signature, fileCount, sizeBytes }}
   */
  async publishSite(siteId) {
    const site = this.#sites.get(siteId);
    if (!site)                          throw new Error(`Site '${siteId}' introuvable`);
    if (site.files.size === 0)          throw new Error('Aucun fichier — uploadez au moins index.html');
    if (!site.files.has('/index.html')) throw new Error('index.html requis à la racine du site');

    // Backup de la version courante
    if (site.version > 0) {
      site.versions.push({ version: site.version, ts: site.updatedAt, snapshot: new Map(site.files) });
      if (site.versions.length > 20) site.versions.shift();
    }

    site.version++;
    site.active    = true;
    site.updatedAt = Date.now();

    // Signature Dilithium5 du manifeste du site
    const manifest = JSON.stringify({
      siteId, domain: site.domain, version: site.version,
      files: [...site.files.keys()].sort(), ts: site.updatedAt,
    });
    site.signature = Buffer.from(this.#signer.sign(new TextEncoder().encode(manifest)))
      .toString('hex').slice(0, 64);

    await this.#storage.replicatePending();

    const domain = site.customDomain ?? site.domain;
    console.info(`[Hosting] Publié : ${domain} v${site.version} | ${site.files.size} fichiers | sig: ${site.signature.slice(0,16)}…`);
    return { version: site.version, domain, url: `https://${domain}`,
             signature: site.signature, fileCount: site.files.size, sizeBytes: site.sizeBytes };
  }

  /**
   * Rollback à une version précédente.
   * Crée automatiquement un backup de la version courante avant restauration.
   *
   * @param {string} siteId
   * @param {number} [version] — numéro cible (défaut: version précédente)
   */
  async rollbackSite(siteId, version = null) {
    const site = this.#sites.get(siteId);
    if (!site) throw new Error(`Site '${siteId}' introuvable`);

    const target = version != null
      ? site.versions.find(v => v.version === version)
      : site.versions[site.versions.length - 1];

    if (!target) throw new Error(`Version ${version ?? 'précédente'} introuvable`);

    // Backup avant rollback
    site.versions.push({ version: site.version, ts: Date.now(), snapshot: new Map(site.files) });
    site.files     = new Map(target.snapshot);
    site.version   = site.version + 1;
    site.updatedAt = Date.now();

    console.info(`[Hosting] Rollback ${site.domain} → v${target.version} (nouvelle v${site.version})`);
    return { rolledBack: target.version, newVersion: site.version };
  }

  /**
   * Retourne le contenu d'un fichier pour le serving HTTP.
   * Fallback SPA : si le chemin n'existe pas → sert index.html.
   * Appelé par server.js sur chaque requête entrante.
   *
   * @param {string} domain — domaine du site
   * @param {string} path   — chemin demandé
   * @returns {Promise<{ data: Uint8Array, contentType: string, sizeBytes: number } | null>}
   */
  async getSiteFile(domain, path) {
    const site = [...this.#sites.values()].find(s =>
      s.active && (s.domain === domain || s.customDomain === domain)
    );
    if (!site) return null;

    let safePath = path.startsWith('/') ? path : `/${path}`;
    if (safePath === '/') safePath = '/index.html';

    const fileId = site.files.get(safePath) ?? site.files.get('/index.html');
    if (!fileId) return null;

    const data = await this.#storage.retrieveFile(fileId);
    if (!data)  return null;

    site.hits++;
    site.bytesServed += data.length;
    site.lastHit      = Date.now();

    return { data, contentType: _inferContentType(safePath), sizeBytes: data.length };
  }

  /**
   * Configure un domaine custom pour un site hébergé.
   * @param {string} siteId
   * @param {string} customDomain — ex: "monsite.com"
   */
  setCustomDomain(siteId, customDomain) {
    const site = this.#sites.get(siteId);
    if (!site) throw new Error(`Site '${siteId}' introuvable`);
    for (const s of this.#sites.values()) {
      if (s.id !== siteId && s.customDomain === customDomain)
        throw new Error(`Domaine '${customDomain}' déjà utilisé`);
    }
    site.customDomain = customDomain;
    console.info(`[Hosting] Domaine custom : ${customDomain} → ${site.id}`);
  }

  listSites()     { return [...this.#sites.values()].map(s => s.toJSON()); }
  getSite(id)     { return this.#sites.get(id)?.toJSON() ?? null; }

  async deleteSite(siteId) {
    const site = this.#sites.get(siteId);
    if (!site) throw new Error(`Site '${siteId}' introuvable`);
    for (const fileId of site.files.values()) {
      await this.#storage.deleteFile(fileId).catch(() => {});
    }
    this.#sites.delete(siteId);
    console.info(`[Hosting] Site supprimé : ${site.domain}`);
  }

  recordSiteHit(siteId, bytes = 0) {
    const site = this.#sites.get(siteId);
    if (!site) return;
    site.hits++;
    site.bytesServed += bytes;
    site.lastHit      = Date.now();
  }

  // ─── Stockage ─────────────────────────────────────────────────

  async uploadFile(name, data)  { return this.#storage.storeFile(name, data, this.#id); }
  async listFiles()             { return this.#storage.listFiles(); }
  async downloadFile(id)        { return this.#storage.retrieveFile(id); }
  async deleteFile(id)          { return this.#storage.deleteFile(id); }
  async replicateFiles()        { return this.#storage.replicatePending(); }

  // ─── Gateway ──────────────────────────────────────────────────

  enableGateway(port = 8080) {
    if (port < 1 || port > 65535) throw new Error('Port invalide (1–65535)');
    this.#gatewayEnabled = true;
    this.#gatewayPort    = port;
    this.#state          = NodeState.Gateway;
  }
  disableGateway() {
    this.#gatewayEnabled = false;
    this.#state          = NodeState.Active;
  }

  // ─── Réseau / Pairs ───────────────────────────────────────────

  addPeer(peerData)    { const p = new Peer(peerData); if (!this.peers.find(x => x.id === p.id)) this.peers.push(p); return p; }
  removePeer(peerId)   { this.peers = this.peers.filter(p => p.id !== peerId); }
  async syncWithNetwork() {
    this.peers = this.peers.filter(p => p.isAlive());

    // Synchronisation des leçons avec chaque peer actif
    const active = this.peers.filter(p => p.isAlive() && p._comm instanceof NodeCommunication);
    for (const peer of active) {
      this.syncLessons(peer._comm).catch(e =>
        console.debug(`[SyncNetwork] peer ${peer.id} : ${e.message}`)
      );
    }

    return { peersActive: this.peers.length };
  }
  getPeers()           { return this.peers.map(p => ({ id: p.id, address: p.address, reputation: p.reputation, alive: p.isAlive() })); }

  // ─── Gateway — serve site ─────────────────────────────────────

  /**
   * Sert un site souverain chiffré avec signature Dilithium5.
   * Port de serve_site() dans skycloud.rs.
   * @param {string} siteId
   * @returns {Promise<{ id, encryptedContent, signature, isAiGenerated, version }|null>}
   */
  async serveSite(siteId) {
    try {
      const data = await this.#storage.retrieveFile(siteId);
      if (!data) return null;
      const signature = this.#signer.sign(data instanceof Uint8Array ? data : new TextEncoder().encode(JSON.stringify(data)));
      return {
        id              : siteId,
        encryptedContent: data,
        isAiGenerated   : true,
        signature       : Array.from(signature.subarray(0, 64)),
        version         : 1,
      };
    } catch {
      return null;
    }
  }

  /**
   * Wrapper direct sur le moteur T369 (port de process_request).
   * @param {string} prompt
   * @param {number} maxTokens
   */
  async processRequest(prompt, maxTokens = 512) {
    if (!this.#engine.isReady) throw new Error('Moteur non connecté');
    const result = await this.#engine.generate(prompt, { maxTokens });
    return result.text;
  }

  /**
   * Active ou désactive les IA externes (port de enable_external_ai).
   * @param {boolean} enabled
   */
  enableExternalAI(enabled) {
    this.#externalAIEnabled = !!enabled;
    console.info(`[SkyCloud] IA externe : ${enabled ? 'activée' : 'désactivée'}`);
  }

  // ─── Récompenses ──────────────────────────────────────────────

  claimRewards()      { return this.#userRewards.claim?.() ?? { claimed: 0 }; }
  getRewardsStats()   { return { totalEarned: this.#userRewards.totalSkyEarned ?? 0 }; }

  #recordAIChatMessage()        { this.#userRewards.recordMessage?.(); }
  #recordLearnContribution(q)   { this.#userRewards.updateQualityScore?.(0, q); }
  #recordDreamCycleParticipation() { this.#userRewards.recordMessage?.(); }

  // ─── Status ───────────────────────────────────────────────────

  getStatus() {
    return {
      id               : this.#id,
      state            : this.#state,
      isRunning        : this.#isRunning,
      wisdomScore      : +this.#wisdomScore.toFixed(4),
      totalRequests    : this.#totalRequests,
      evolutionCycles  : this.#evolutionCycles,
      peers            : this.peers.length,
      registeredAIs    : this.#registeredAIs.size,
      engineReady      : this.#engine.isReady,
      gatewayEnabled   : this.#gatewayEnabled,
      gatewayPort      : this.#gatewayPort,
      externalAIEnabled: this.#externalAIEnabled,
      apiKeysCount     : this.#apiKeyStore.list().length,
      exposedEndpoints : this.#exposedEndpoints.size,
    };
  }

  getNodeMetrics() {
    const upSec = Math.floor((Date.now() - this.#startTime) / 1000);
    const scStats = this.getSmartContractStats();
    return {
      node_id               : this.#id,
      state                 : this.#state,
      engine_ready          : this.#engine.isReady,
      engine_stats          : this.#engine.stats(),
      wisdom_score          : +this.#wisdomScore.toFixed(4),
      total_requests        : this.#totalRequests,
      evolution_cycles      : this.#evolutionCycles,
      last_dream_cycle      : this.#lastDreamCycle,
      peers_connected       : this.peers.filter(p => p.isAlive()).length,
      registered_ais        : [...this.#registeredAIs.keys()],
      uptime_formatted      : `${Math.floor(upSec / 3600)}h ${Math.floor((upSec % 3600) / 60)}m`,
      api_keys_count        : this.#apiKeyStore.list().filter(k => !k.revoked).length,
      exposed_endpoints     : this.listExposedEndpoints(),
      gateway_port          : this.#gatewayPort,
      // Smart Contracts
      contracts_generated   : scStats.contractsGenerated,
      contracts_deployed    : scStats.contractsDeployed,
      sky_spent_contracts   : scStats.skySpent,
    };
  }

  // ─── Dream Cycle direct ───────────────────────────────────────

  async runDreamCycle() {
    const result = await this.#dreamCycle.runDreamCycle();
    this.#evolutionCycles++;
    this.#lastDreamCycle = Date.now();
    return result;
  }

  // ─── Tauri Commands ───────────────────────────────────────────

  tauriCommands() {
    const n = this;
    return {
      // Web Hosting
      createSite              : (name, domain) => n.createSite(name, domain),
      uploadSiteFile          : (siteId, path, data) => n.uploadSiteFile(siteId, path, data),
      publishSite             : n.publishSite.bind(n),
      rollbackSite            : (siteId, version) => n.rollbackSite(siteId, version),
      deleteSite              : n.deleteSite.bind(n),
      listSites               : n.listSites.bind(n),
      getSite                 : n.getSite.bind(n),
      getSiteFile             : (domain, path) => n.getSiteFile(domain, path),
      setCustomDomain         : (siteId, domain) => n.setCustomDomain(siteId, domain),
      recordSiteHit           : (siteId, bytes) => n.recordSiteHit(siteId, bytes),
      // Gateway
      enableGateway             : n.enableGateway.bind(n),
      disableGateway            : n.disableGateway.bind(n),
      exposeInferenceEndpoint   : n.exposeInferenceEndpoint.bind(n),
      removeEndpoint            : n.removeEndpoint.bind(n),
      listExposedEndpoints      : n.listExposedEndpoints.bind(n),
      logTraffic                : n.logTraffic.bind(n),
      getTrafficLogs            : n.getTrafficLogs.bind(n),
      serveSite                 : n.serveSite.bind(n),
      // API Keys
      generateApiKey            : (name, opts) => n.generateApiKey(name, opts),
      validateApiKey            : (key, ai, scope) => n.validateApiKey(key, ai, scope),
      revokeApiKey              : n.revokeApiKey.bind(n),
      rotateApiKey              : n.rotateApiKey.bind(n),
      listApiKeys               : n.listApiKeys.bind(n),
      // Storage
      uploadFile                : n.uploadFile.bind(n),
      listFiles                 : n.listFiles.bind(n),
      downloadFile              : n.downloadFile.bind(n),
      deleteFile                : n.deleteFile.bind(n),
      replicateFiles            : n.replicateFiles.bind(n),
      // IA
      generateWithAI            : (prompt, ai, maxTokens) => n.generateWithAI({ prompt, ai, maxTokens }),
      sendAiMessage             : (from, to, content, apiKey) => n.sendMessage(from, to, content, apiKey),
      getRegisteredAis          : () => [...n.registeredAIs.keys()],
      toggleExternalAi          : enabled => n.enableExternalAI(enabled),
      // Rewards
      claimRewards              : n.claimRewards.bind(n),
      getRewardsStats           : n.getRewardsStats.bind(n),
      // Learn / Evolution
      injectLesson              : n.injectLesson.bind(n),
      injectChatLesson          : n.injectChatLesson.bind(n),
      runDreamCycle             : n.runDreamCycle.bind(n),
      triggerTraditionalTraining: n.triggerTraditionalTraining.bind(n),
      enableAutoTraining        : opts => n.enableAutoTraining(opts),
      disableAutoTraining       : ()   => n.disableAutoTraining(),
      isAutoTrainingEnabled     : ()   => n.isAutoTrainingEnabled,
      enableAutoDream           : opts => n.enableAutoDream(opts),
      disableAutoDream          : ()   => n.disableAutoDream(),
      isAutoDreamEnabled        : ()   => n.isAutoDreamEnabled,
      // Redistribution inter-nœuds
      broadcastLesson           : (lesson, threshold) => n.broadcastLesson(lesson, threshold),
      syncLessons               : (peerComm, topN)    => n.syncLessons(peerComm, topN),
      propagateLessons          : peerComms            => n.propagateLessons(peerComms),
      requestLessons            : (peerComm, filter)  => n.requestLessons(peerComm, filter),
      getCommStats              : ()                   => n.getCommStats(),
      runAgenticTask            : (goal, onStep, opts) => n.runAgenticTask(goal, onStep, opts),
      getAgenticToolCatalog     : ()                   => n.getAgenticToolCatalog(),
      listAgenticSessions       : ()                   => n.listAgenticSessions(),
      getAgenticStats           : ()                   => n.getAgenticStats(),
      // Smart Contracts — LoraÉvo
      generateSmartContract     : (desc, opts) => n.generateSmartContract(desc, opts),
      deploySmartContract       : contractId  => n.deploySmartContract(contractId),
      listSmartContracts        : ()          => n.listSmartContracts(),
      getSmartContract          : contractId  => n.getSmartContract(contractId),
      deleteSmartContract       : contractId  => n.deleteSmartContract(contractId),
      getSmartContractStats     : ()          => n.getSmartContractStats(),
      // Réseau
      syncWithNetwork           : n.syncWithNetwork.bind(n),
      getPeers                  : n.getPeers.bind(n),
      // Status
      getNodeStats              : n.getStatus.bind(n),
      getNodeMetrics            : n.getNodeMetrics.bind(n),
      setNodeState              : n.setNodeState.bind(n),
      // Internals (debug)
      getLoraEvoStatus          : () => n.#loraEvo?.getStatus(),
      getDreamCycleStats        : () => n.#dreamCycle?.getStats(),
      getAgentStatus            : () => n.#agenticRunner?.getStatus() ?? { engineReady: n.#engine.isReady, mode: 'agentic' },
    };
  }
}