// packages/memory/src/storage.js
// StorageNode — Gestionnaire de Stockage Souverain
// ZipMemory + Compression gzip + Chiffrement Post-Quantique
// + PersistentStorage (port de persistent_storage.rs)
// SkyAInet × Nikola T369

"use strict";

import crypto                    from 'crypto';
import { gzipSync, gunzipSync }  from 'zlib';
import fs                        from 'fs';
import path                      from 'path';

import { ZipMemory }             from './zip_memory.js';
import { HybridTransport }       from '../../secure/src/crypto/hybrid.js';
import { GematriaAead }          from '../../secure/src/crypto/gematria_aead.js';
import { UserRewards }           from '../../core/src/rewards.js';

// ─────────────────────────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────────────────────────

const QUOTA_GB = Object.freeze({
  Free      : 5,
  Pro       : 50,
  Validator : 200,
  Enterprise: 1000,
});

const BILLING_RATE_BASE   = 0.50;
const BILLING_RATE_SHIELD = 0.70;
const BILLING_MIN         = 0.50;
const REWARD_PER_UPLOAD   = 3;
const HOT_CACHE_MAX       = 256;
const GB                  = 1024 ** 3;
const TE                  = new TextEncoder();
const TD                  = new TextDecoder();

// ─────────────────────────────────────────────────────────────────
// PERSISTENT STORAGE — port de persistent_storage.rs
//
// Remplace sled (KV embarqué Rust) par un stockage JSON sur disque
// via fs/promises. Même interface : save/load par catégorie
// (neuron, synapse, lesson, snapshot).
//
// Opérations :
//   saveNeuron(id, data)          → fichier {basePath}/neuron/{id}.bin
//   loadNeuron(id)                → Buffer | null
//   saveSynapse(from, to, data)   → fichier {basePath}/synapse/{from}-{to}.json
//   loadSynapse(from, to)         → object | null
//   saveLesson(id, lesson)        → fichier {basePath}/lesson/{id}.json
//   loadLesson(id)                → object | null
//   saveMeshSnapshot(data)        → fichier {basePath}/snapshot.bin
//   loadMeshSnapshot()            → Buffer | null
//   flush()                       → flush explicite (no-op sur fs natif)
//   getStats()                    → string récapitulatif
// ─────────────────────────────────────────────────────────────────

export class PersistentStorage {
  #basePath;
  #ready;   // Promise<void> — attend la création des répertoires

  constructor(basePath = './data/storage') {
    this.#basePath = basePath;
    this.#ready    = this.#init();
  }

  async #init() {
    const dirs = ['neuron', 'synapse', 'lesson'];
    await Promise.all(
      dirs.map(d => fs.promises.mkdir(path.join(this.#basePath, d), { recursive: true }))
    );
  }

  // ─── Neurones ─────────────────────────────────────────────────

  async saveNeuron(neuronId, data) {
    await this.#ready;
    const file = path.join(this.#basePath, 'neuron', `${neuronId}.bin`);
    await fs.promises.writeFile(file, data instanceof Uint8Array ? data : Buffer.from(data));
  }

  async loadNeuron(neuronId) {
    await this.#ready;
    try {
      return await fs.promises.readFile(path.join(this.#basePath, 'neuron', `${neuronId}.bin`));
    } catch { return null; }
  }

  // ─── Synapses ─────────────────────────────────────────────────

  async saveSynapse(from, to, synapseData) {
    await this.#ready;
    const file = path.join(this.#basePath, 'synapse', `${from}-${to}.json`);
    await fs.promises.writeFile(file, JSON.stringify(synapseData));
  }

  async loadSynapse(from, to) {
    await this.#ready;
    try {
      const raw = await fs.promises.readFile(path.join(this.#basePath, 'synapse', `${from}-${to}.json`), 'utf8');
      return JSON.parse(raw);
    } catch { return null; }
  }

  // ─── Leçons ───────────────────────────────────────────────────

  async saveLesson(lessonId, lesson) {
    await this.#ready;
    const file = path.join(this.#basePath, 'lesson', `${lessonId}.json`);
    await fs.promises.writeFile(file, JSON.stringify(lesson));
    console.debug(`[PersistentStorage] Leçon sauvegardée : ${lessonId}`);
  }

  async loadLesson(lessonId) {
    await this.#ready;
    try {
      const raw = await fs.promises.readFile(path.join(this.#basePath, 'lesson', `${lessonId}.json`), 'utf8');
      return JSON.parse(raw);
    } catch { return null; }
  }

  // ─── Snapshot Neural Mesh ─────────────────────────────────────

  async saveMeshSnapshot(data) {
    await this.#ready;
    await fs.promises.writeFile(path.join(this.#basePath, 'snapshot.bin'), data);
    console.info('[PersistentStorage] Snapshot Neural Mesh sauvegardé');
  }

  async loadMeshSnapshot() {
    await this.#ready;
    try {
      return await fs.promises.readFile(path.join(this.#basePath, 'snapshot.bin'));
    } catch { return null; }
  }

  // ─── Utilitaires ─────────────────────────────────────────────

  /** flush() est no-op sur fs natif — conservé pour compatibilité API Rust */
  async flush() {}

  async clearAll() {
    await this.#ready;
    await fs.promises.rm(this.#basePath, { recursive: true, force: true });
    await this.#init();
    console.warn('[PersistentStorage] Base de données entièrement vidée !');
  }

  async getStats() {
    await this.#ready;
    let count = 0;
    let sizeB = 0;

    const walk = async (dir) => {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          await walk(full);
        } else {
          const stat = await fs.promises.stat(full).catch(() => null);
          if (stat) { count++; sizeB += stat.size; }
        }
      }
    };

    await walk(this.#basePath);
    return `PersistentStorage → ${count} entrées | ${(sizeB / 1_048_576).toFixed(2)} MB`;
  }
}

// ─────────────────────────────────────────────────────────────────
// STORAGE NODE
// ─────────────────────────────────────────────────────────────────

export class StorageNode {
  #hybrid;
  #encryptedFiles;  // Map<cid, { filename, encryptedData, compressedSizeB, rawSizeB, uploadedAt }>
  #index;           // Map<filename, cid>
  #hotCache;        // Map<cid, Uint8Array> — LRU déchiffré
  #zipMemory;       // ZipMemory — métadonnées persistées
  #persistent;      // PersistentStorage — port de persistent_storage.rs

  constructor(sovereignAlias, subscription = 'Free') {
    if (!sovereignAlias?.trim()) throw new Error('sovereignAlias requis');

    this.nodeId               = `storage-${sovereignAlias.toLowerCase().replace(/\s+/g, '-')}`;
    this.sovereignAlias       = sovereignAlias.trim();
    this.currentState         = 'Active';
    this.capabilities         = { computePower: 0.95, storagePower: 1.0, bandwidth: 0.90 };

    this.maxStorageGb         = QUOTA_GB[subscription] ?? QUOTA_GB.Free;
    this.usedStorageGb        = 0;
    this.reservedGb           = 0;
    this.totalFiles           = 0;

    this.storageShieldEnabled = false;
    this.monthlyCostSky       = 0;
    this.lastBillingUpdate    = Date.now();

    this.#hybrid        = new HybridTransport(true);
    this.#encryptedFiles= new Map();
    this.#index         = new Map();
    this.#hotCache      = new Map();
    this.#zipMemory     = new ZipMemory(`./data/storage/${this.sovereignAlias}_zip`);
    this.#persistent    = new PersistentStorage(`./data/storage/${this.sovereignAlias}_db`);
  }

  // ─── Upload ───────────────────────────────────────────────────

  async uploadFile(filename, data, rewards = null) {
    if (!filename?.trim()) throw new Error("'filename' requis");

    const raw       = data instanceof Uint8Array ? data : new Uint8Array(data);
    const rawSizeGb = raw.length / GB;

    if (this.usedStorageGb + rawSizeGb > this.maxStorageGb) {
      throw new Error(
        `Quota dépassé (utilisé: ${this.usedStorageGb.toFixed(3)} Go, ` +
        `ajout: ${rawSizeGb.toFixed(3)} Go, max: ${this.maxStorageGb} Go)`
      );
    }

    const compressed = gzipSync(raw, { level: 6 });
    const compSizeGb = compressed.length / GB;
    const ratio      = raw.length > 0 ? raw.length / compressed.length : 1;

    const [key, nonce] = this.#hybrid.deriveKeys();
    const encrypted    = new GematriaAead(key, nonce).encrypt(compressed);

    const cid  = `skn:${crypto.randomUUID()}`;
    const meta = {
      filename,
      encryptedData  : encrypted,
      compressedSizeB: compressed.length,
      rawSizeB       : raw.length,
      uploadedAt     : Date.now(),
    };

    this.#encryptedFiles.set(cid, meta);
    this.#index.set(filename.trim(), cid);
    this.usedStorageGb += compSizeGb;
    this.totalFiles++;
    this.#updateMonthlyCost();

    // Persistance double : ZipMemory (métadonnées) + PersistentStorage (binaire)
    const metaJson = TE.encode(JSON.stringify({ filename, cid, compressedSizeB: compressed.length, rawSizeB: raw.length, uploadedAt: meta.uploadedAt }));
    await this.#zipMemory.store(cid, metaJson);
    await this.#persistent.saveLesson(cid.replace('skn:', ''), { filename, cid, compressedSizeB: compressed.length, rawSizeB: raw.length });

    if (rewards instanceof UserRewards) {
      rewards.totalSkyEarned += REWARD_PER_UPLOAD;
    }

    console.debug(`[Storage] Upload: ${filename} → ${cid.slice(0,20)}… | ${(raw.length/1024).toFixed(1)} KB → ${(compressed.length/1024).toFixed(1)} KB (×${ratio.toFixed(2)})`);
    return cid;
  }

  // ─── Download ─────────────────────────────────────────────────

  async downloadFile(cidOrFilename) {
    const cid = cidOrFilename.startsWith('skn:')
      ? cidOrFilename
      : this.#index.get(cidOrFilename) ?? null;
    if (!cid) return null;

    if (this.#hotCache.has(cid)) return this.#hotCache.get(cid);

    const entry = this.#encryptedFiles.get(cid);
    if (!entry) return null;

    const [key, nonce] = this.#hybrid.deriveKeys();
    let compressed;
    try {
      compressed = new GematriaAead(key, nonce).decrypt(entry.encryptedData);
    } catch (e) {
      throw new Error(`Déchiffrement échoué pour ${cid}: ${e.message}`);
    }

    const raw = gunzipSync(compressed);

    if (this.#hotCache.size >= HOT_CACHE_MAX) {
      this.#hotCache.delete(this.#hotCache.keys().next().value);
    }
    this.#hotCache.set(cid, raw);
    return raw;
  }

  // ─── Delete ───────────────────────────────────────────────────

  async deleteFile(cidOrFilename) {
    const cid = cidOrFilename.startsWith('skn:')
      ? cidOrFilename
      : this.#index.get(cidOrFilename) ?? null;
    if (!cid) return false;

    const entry = this.#encryptedFiles.get(cid);
    if (!entry) return false;

    this.#encryptedFiles.delete(cid);
    this.#index.delete(entry.filename);
    this.#hotCache.delete(cid);
    this.totalFiles    = Math.max(0, this.totalFiles - 1);
    this.usedStorageGb = Math.max(0, this.usedStorageGb - entry.compressedSizeB / GB);
    this.#updateMonthlyCost();
    return true;
  }

  // ─── Listing ──────────────────────────────────────────────────

  listFiles() {
    return [...this.#encryptedFiles.entries()].map(([cid, e]) => ({
      cid,
      filename       : e.filename,
      rawSizeB       : e.rawSizeB,
      compressedSizeB: e.compressedSizeB,
      ratio          : e.rawSizeB > 0 ? +(e.rawSizeB / e.compressedSizeB).toFixed(2) : 1,
      uploadedAt     : e.uploadedAt,
    }));
  }

  hasCid(cid)       { return this.#encryptedFiles.has(cid); }
  hasFile(filename) { return this.#index.has(filename); }
  getCid(filename)  { return this.#index.get(filename) ?? null; }

  // ─── PersistentStorage — API exposée (port de persistent_storage.rs) ──

  /**
   * Sauvegarde un neurone sérialisé (pour NeuralMesh / MeshIn.persist()).
   */
  async saveNeuron(neuronId, data) {
    return this.#persistent.saveNeuron(neuronId, data);
  }

  async loadNeuron(neuronId) {
    return this.#persistent.loadNeuron(neuronId);
  }

  async saveSynapse(from, to, data) {
    return this.#persistent.saveSynapse(from, to, data);
  }

  async loadSynapse(from, to) {
    return this.#persistent.loadSynapse(from, to);
  }

  async saveLesson(lessonId, lesson) {
    return this.#persistent.saveLesson(lessonId, lesson);
  }

  async loadLesson(lessonId) {
    return this.#persistent.loadLesson(lessonId);
  }

  /**
   * Snapshot complet du NeuralMesh (sérialisé JSON ou binaire).
   */
  async saveMeshSnapshot(data) {
    const bytes = typeof data === 'string' ? TE.encode(data) : data;
    return this.#persistent.saveMeshSnapshot(bytes);
  }

  async loadMeshSnapshot() {
    return this.#persistent.loadMeshSnapshot();
  }

  // ─── Réplication ──────────────────────────────────────────────

  async replicatePending() {
    let count = 0;
    for (const [cid, entry] of this.#encryptedFiles) {
      const existing = await this.#zipMemory.retrieve(cid);
      if (!existing) {
        await this.#zipMemory.store(
          cid,
          TE.encode(JSON.stringify({ filename: entry.filename, cid, compressedSizeB: entry.compressedSizeB, rawSizeB: entry.rawSizeB, uploadedAt: entry.uploadedAt }))
        );
        count++;
      }
    }
    return { replicated: count };
  }

  // ─── Facturation ──────────────────────────────────────────────

  toggleStorageShield() {
    this.storageShieldEnabled = !this.storageShieldEnabled;
    this.#updateMonthlyCost();
    console.info(`[Storage] Shield ${this.storageShieldEnabled ? 'activé' : 'désactivé'}`);
  }

  #updateMonthlyCost() {
    const rate = this.storageShieldEnabled ? BILLING_RATE_SHIELD : BILLING_RATE_BASE;
    this.monthlyCostSky    = Math.max(BILLING_MIN, this.usedStorageGb * rate);
    this.lastBillingUpdate = Date.now();
  }

  // ─── État & rapport ───────────────────────────────────────────

  enterSleepMode() {
    this.currentState = 'Sleeping';
    this.#hotCache.clear();
    console.info('[Storage] Mode veille — hot cache vidé');
  }

  wakeUp() {
    this.currentState = 'Active';
    console.info('[Storage] Réveillé');
  }

  getStorageStats() {
    const usagePct = this.maxStorageGb > 0 ? (this.usedStorageGb / this.maxStorageGb) * 100 : 0;
    return {
      usedGb         : +this.usedStorageGb.toFixed(4),
      maxGb          : this.maxStorageGb,
      usagePercent   : +usagePct.toFixed(1),
      totalFiles     : this.totalFiles,
      hotCacheEntries: this.#hotCache.size,
      shieldEnabled  : this.storageShieldEnabled,
      monthlyCostSky : +this.monthlyCostSky.toFixed(2),
    };
  }

  async getFullStats() {
    const storage  = this.getStorageStats();
    const dbStats  = await this.#persistent.getStats();
    return { ...storage, persistentDb: dbStats };
  }

  healthReport() {
    const s = this.getStorageStats();
    return {
      nodeId        : this.nodeId,
      alias         : this.sovereignAlias,
      state         : this.currentState,
      usedGb        : s.usedGb,
      maxGb         : s.maxGb,
      usagePercent  : s.usagePercent,
      totalFiles    : s.totalFiles,
      shieldEnabled : s.shieldEnabled,
      monthlyCostSky: s.monthlyCostSky,
    };
  }
}

export default StorageNode;
