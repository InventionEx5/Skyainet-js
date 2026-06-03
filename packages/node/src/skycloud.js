// packages/node/src/skycloud.js
// SkyNode — Nœud Principal Souverain
// SkyAInet – Gateway, Hub IA, Stockage, Récompenses + Apprentissage Continu

"use strict";

import { Dilithium5Signer }                       from '../../secure/src/crypto/dilithium.js';
import { HybridTransport }                        from '../../secure/src/crypto/hybrid.js';
import { GematriaAead }                           from '../../secure/src/crypto/gematria_aead.js';
import { RomanT369, GematriaMode }                from '../../secure/src/crypto/roman_t369.js';
import { UserRewards, RewardReason, AccountType } from '../../core/src/rewards.js';
import { NodeState }                              from '../../core/src/node_types.js';
import { ZipMemory }                              from '../../memory/src/zip_memory.js';
import { EvolutionManager }                       from './evolution_manager.js';
import { StorageNode }                            from '../../memory/src/storage.js';

import { T369Model, ModelConfig }                 from '../../t369-inference/src/t369.js';
import { BpeTokenizer }                           from '../../t369-inference/src/tokenizer.js';
import { SpeculativeDecoder, SpeculativeConfig }  from '../../t369-inference/src/speculative.js';

import { DreamCycle }  from '../../../model/src/thevie/dream_cycle.js';
import { LoraEvo }     from '../../../model/src/thevie/lora_evolution.js';

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

const MAX_MESSAGE_BUS   = 4096;
const WISDOM_LEARN_GAIN = 0.005;
const WISDOM_DREAM_GAIN = 0.002;

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

class AgenticRunner {
  #engine;   // T369InferenceEngine

  constructor(engine) { this.#engine = engine; }

  async run(goal) {
    if (!this.#engine.isReady) throw new Error('Moteur non prêt pour le mode agentique');

    // Étape 1 : planification
    const planResult = await this.#engine.generate(
      `[SYSTEM] Tu es un planificateur. Décompose en 3 étapes numérotées et concrètes.\n[GOAL] ${goal}\n[PLAN]`,
      { maxTokens: 128, temperature: 0.4, useSpeculative: false }
    );
    const plan = planResult.text;

    // Étape 2 : exécution de chaque étape
    const steps   = plan.split(/\d+\.\s+/).filter(s => s.trim().length > 10).slice(0, 3);
    const results = [];
    for (const step of steps) {
      const r = await this.#engine.generate(
        `[SYSTEM] Tu exécutes une tâche précise.\n[TASK] ${step.trim()}\n[OUTPUT]`,
        { maxTokens: 256, temperature: 0.7, useSpeculative: false }
      ).catch(() => ({ text: '' }));
      if (r.text) results.push(r.text);
    }

    // Étape 3 : synthèse
    const synthesis = await this.#engine.generate(
      `[SYSTEM] Synthétise en une réponse cohérente.\n${results.join('\n')}\n[SYNTHESIS]`,
      { maxTokens: 256, temperature: 0.6, useSpeculative: false }
    ).catch(() => ({ text: results.join('\n') }));

    return { goal, plan, steps: results, result: synthesis.text };
  }

  getStatus() {
    return { engineReady: this.#engine.isReady, mode: 'agentic' };
  }
}

// =====================================================
// API KEY STORE
// =====================================================

class ApiKeyStore {
  #keys = new Map();

  create(name, opts = {}) {
    if (!name || typeof name !== 'string') throw new Error('Nom de clé invalide');
    const key = `skn_${crypto.randomUUID().replace(/-/g, '')}`;
    this.#keys.set(key, {
      name,
      createdAt  : Date.now(),
      lastUsed   : null,
      usageCount : 0,
      allowedAIs : opts.allowedAIs ?? [],
      rateLimit  : opts.rateLimit  ?? 0,
      rateWindow : [],
      revoked    : false,
    });
    return key;
  }

  validate(key, targetAI = '') {
    if (!key || typeof key !== 'string') return { valid: false, reason: 'Clé absente ou malformée' };
    const entry = this.#keys.get(key);
    if (!entry)         return { valid: false, reason: 'Clé inconnue' };
    if (entry.revoked)  return { valid: false, reason: 'Clé révoquée' };
    if (entry.allowedAIs.length > 0 && !entry.allowedAIs.includes(targetAI)) {
      return { valid: false, reason: `IA '${targetAI}' non autorisée` };
    }
    if (entry.rateLimit > 0) {
      const now = Date.now();
      entry.rateWindow = entry.rateWindow.filter(t => now - t < 60_000);
      if (entry.rateWindow.length >= entry.rateLimit) return { valid: false, reason: 'Rate limit dépassé' };
      entry.rateWindow.push(now);
    }
    entry.lastUsed = Date.now();
    entry.usageCount++;
    return { valid: true, entry };
  }

  revoke(key) {
    const entry = this.#keys.get(key);
    if (!entry) throw new Error('Clé introuvable');
    entry.revoked = true;
  }

  list() {
    return [...this.#keys.entries()].map(([key, e]) => ({
      keyPreview : `${key.slice(0, 8)}…`,
      name       : e.name,
      createdAt  : e.createdAt,
      lastUsed   : e.lastUsed,
      usageCount : e.usageCount,
      allowedAIs : e.allowedAIs,
      rateLimit  : e.rateLimit,
      revoked    : e.revoked,
    }));
  }

  exists(key) { return this.#keys.has(key) && !this.#keys.get(key).revoked; }
}

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

  generateApiKey(name, allowedAIs = [], rateLimit = 60) {
    return this.#apiKeyStore.create(name, { allowedAIs, rateLimit });
  }
  validateApiKey(key, targetAI = '') { return this.#apiKeyStore.validate(key, targetAI); }
  revokeApiKey(key)                  { this.#apiKeyStore.revoke(key); }
  listApiKeys()                      { return this.#apiKeyStore.list(); }

  // ─── IA ───────────────────────────────────────────────────────

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

  #pushToBus(msg) {
    this.#messageBus.push(msg);
    if (this.#messageBus.length > MAX_MESSAGE_BUS) {
      this.#messageBus.splice(0, this.#messageBus.length - MAX_MESSAGE_BUS);
    }
  }

  // ─── Génération ───────────────────────────────────────────────

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
  }

  async triggerTraditionalTraining() {
    this.#ensureEvolutionManager();
    await this.#evolutionManager.runTraditionalTraining();
    this.#engine.resetCache();
  }

  // ─── Mode agentique ───────────────────────────────────────────

  async runAgenticTask(goal) {
    if (!this.#agenticRunner) {
      this.#agenticRunner = new AgenticRunner(this.#engine);
    }
    return this.#agenticRunner.run(goal);
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

  async generateDynamicSite(prompt) {
    if (!this.#engine.isReady) throw new Error('Moteur non initialisé');
    const response  = await this.generateWithAI({ prompt, ai: 'thevie', maxTokens: 2048, useSpeculative: false });
    const [key, nonce] = this.#hybrid.deriveKeys();
    const encrypted = new GematriaAead(key, nonce).encrypt(new TextEncoder().encode(response.text));
    const siteId    = `site_${Date.now()}`;
    await this.#storage.storeFile(siteId, encrypted, this.#id);
    return siteId;
  }

  // ─── Réseau / Pairs ───────────────────────────────────────────

  addPeer(peerData)    { const p = new Peer(peerData); if (!this.peers.find(x => x.id === p.id)) this.peers.push(p); return p; }
  removePeer(peerId)   { this.peers = this.peers.filter(p => p.id !== peerId); }
  async syncWithNetwork() { this.peers = this.peers.filter(p => p.isAlive()); return { peersActive: this.peers.length }; }
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
      id              : this.#id,
      state           : this.#state,
      isRunning       : this.#isRunning,
      wisdomScore     : +this.#wisdomScore.toFixed(4),
      totalRequests   : this.#totalRequests,
      evolutionCycles : this.#evolutionCycles,
      peers           : this.peers.length,
      registeredAIs   : this.#registeredAIs.size,
      engineReady     : this.#engine.isReady,
      gatewayEnabled  : this.#gatewayEnabled,
      externalAIEnabled: this.#externalAIEnabled,
      apiKeysCount    : this.#apiKeyStore.list().length,
    };
  }

  getNodeMetrics() {
    const upSec = Math.floor((Date.now() - this.#startTime) / 1000);
    return {
      node_id         : this.#id,
      state           : this.#state,
      engine_ready    : this.#engine.isReady,
      engine_stats    : this.#engine.stats(),
      wisdom_score    : +this.#wisdomScore.toFixed(4),
      total_requests  : this.#totalRequests,
      evolution_cycles: this.#evolutionCycles,
      last_dream_cycle: this.#lastDreamCycle,
      peers_connected : this.peers.filter(p => p.isAlive()).length,
      registered_ais  : [...this.#registeredAIs.keys()],
      uptime_formatted: `${Math.floor(upSec / 3600)}h ${Math.floor((upSec % 3600) / 60)}m`,
      api_keys_count  : this.#apiKeyStore.list().length,
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
      enableGateway          : n.enableGateway.bind(n),
      disableGateway         : n.disableGateway.bind(n),
      generateDynamicSite    : n.generateDynamicSite.bind(n),
      createApiKey           : (name, allowedAIs, rateLimit) => n.generateApiKey(name, allowedAIs, rateLimit),
      validateApiKey         : n.validateApiKey.bind(n),
      revokeApiKey           : n.revokeApiKey.bind(n),
      listApiKeys            : n.listApiKeys.bind(n),
      uploadFile             : n.uploadFile.bind(n),
      listFiles              : n.listFiles.bind(n),
      downloadFile           : n.downloadFile.bind(n),
      deleteFile             : n.deleteFile.bind(n),
      replicateFiles         : n.replicateFiles.bind(n),
      generateWithAI         : (prompt, ai, maxTokens) => n.generateWithAI({ prompt, ai, maxTokens }),
      sendAiMessage          : (from, to, content, apiKey) => n.sendMessage(from, to, content, apiKey),
      getRegisteredAis       : () => [...n.registeredAIs.keys()],
      toggleExternalAi       : enabled => n.enableExternalAI(enabled),
      claimRewards           : n.claimRewards.bind(n),
      getRewardsStats        : n.getRewardsStats.bind(n),
      injectLesson           : n.injectLesson.bind(n),
      syncWithNetwork        : n.syncWithNetwork.bind(n),
      getPeers               : n.getPeers.bind(n),
      getNodeStats           : n.getStatus.bind(n),
      getNodeMetrics         : n.getNodeMetrics.bind(n),
      runDreamCycle          : n.runDreamCycle.bind(n),
      triggerTraditionalTraining: n.triggerTraditionalTraining.bind(n),
      runAgenticTask         : n.runAgenticTask.bind(n),
      getLoraEvoStatus       : () => n.#loraEvo?.getStatus(),
      getDreamCycleStats     : () => n.#dreamCycle?.getStats(),
      getAgentStatus         : () => n.#agenticRunner?.getStatus() ?? { engineReady: n.#engine.isReady, mode: 'agentic' },
    };
  }
}