// packages/memory/src/storage.js
// StorageNode — Gestionnaire de Stockage Souverain
// ZipMemory + Compression zlib + Chiffrement GematriaAead + Facturation + Réplication
// SkyAInet × Nikola T369

"use strict";

import crypto             from 'crypto';
import { gzipSync, gunzipSync } from 'zlib';

import { ZipMemory }      from './zip_memory.js';
import { HybridTransport } from '../../secure/src/crypto/hybrid.js';
import { GematriaAead }   from '../../secure/src/crypto/gematria_aead.js';
import { UserRewards }    from '../../core/src/rewards.js';

// ─────────────────────────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────────────────────────

const QUOTA_GB = Object.freeze({
  Free      : 5,
  Pro       : 50,
  Validator : 200,
  Enterprise: 1000,
});

const BILLING_RATE_BASE   = 0.50;   // SKY / Go / mois
const BILLING_RATE_SHIELD = 0.70;   // SKY / Go / mois avec Shield
const BILLING_MIN         = 0.50;   // SKY minimum mensuel
const REWARD_PER_UPLOAD   = 3;      // SKY par upload
const HOT_CACHE_MAX       = 256;    // entrées max dans le hot cache
const GB                  = 1024 ** 3;

// ─────────────────────────────────────────────────────────────────
// STORAGE NODE
// ─────────────────────────────────────────────────────────────────

export class StorageNode {
  #hybrid;          // HybridTransport — dérive clé/nonce pour chiffrement
  #encryptedFiles;  // Map<cid, { filename, encryptedData, compressedSizeB, uploadedAt }>
  #index;           // Map<filename, cid> — index nom → CID
  #hotCache;        // Map<cid, Uint8Array> — cache déchiffré en mémoire (LRU simplifié)
  #zipMemory;       // ZipMemory — index persistant des métadonnées

  constructor(sovereignAlias, subscription = 'Free') {
    if (!sovereignAlias?.trim()) throw new Error('sovereignAlias requis');

    this.nodeId          = `storage-${sovereignAlias.toLowerCase().replace(/\s+/g, '-')}`;
    this.sovereignAlias  = sovereignAlias.trim();
    this.currentState    = 'Active';
    this.capabilities    = { computePower: 0.95, storagePower: 1.0, bandwidth: 0.90 };

    // Quota
    this.maxStorageGb    = QUOTA_GB[subscription] ?? QUOTA_GB.Free;
    this.usedStorageGb   = 0;
    this.reservedGb      = 0;
    this.totalFiles      = 0;

    // Facturation
    this.storageShieldEnabled = false;
    this.monthlyCostSky       = 0;
    this.lastBillingUpdate    = Date.now();

    // Stockage interne
    this.#hybrid        = new HybridTransport(true);
    this.#encryptedFiles= new Map();
    this.#index         = new Map();
    this.#hotCache      = new Map();
    this.#zipMemory     = new ZipMemory(`./data/storage/${this.sovereignAlias}_zip`);
  }

  // ─── Upload ───────────────────────────────────────────────────

  /**
   * Upload d'un fichier avec compression gzip + chiffrement GematriaAead.
   *
   * Pipeline :
   *   data (Uint8Array) → gzipSync → GematriaAead.encrypt → stockage Map
   *
   * La clé et le nonce sont dérivés via HybridTransport.deriveKeys() (ML-KEM
   * éphémère auto-encapsulé), garantissant un chiffrement post-quantique
   * sans nécessiter la clé publique du destinataire.
   *
   * Les métadonnées (filename, cid, taille) sont persistées dans ZipMemory.
   *
   * @param {string}           filename
   * @param {Uint8Array|Buffer} data
   * @param {UserRewards|null} rewards
   * @returns {Promise<string>} CID du fichier
   */
  async uploadFile(filename, data, rewards = null) {
    if (!filename?.trim()) throw new Error("'filename' requis");

    const raw    = data instanceof Uint8Array ? data : new Uint8Array(data);
    const rawSizeGb = raw.length / GB;

    if (this.usedStorageGb + rawSizeGb > this.maxStorageGb) {
      throw new Error(
        `Quota dépassé (utilisé: ${this.usedStorageGb.toFixed(3)} Go, ` +
        `ajout: ${rawSizeGb.toFixed(3)} Go, max: ${this.maxStorageGb} Go)`
      );
    }

    // — Compression gzip (natif Node, synchrone — pas de dépendance externe)
    const compressed    = gzipSync(raw, { level: 6 });
    const compSizeGb    = compressed.length / GB;
    const ratio         = raw.length > 0 ? raw.length / compressed.length : 1;

    // — Chiffrement GematriaAead (post-quantique via RomanT369 interne)
    const [key, nonce]  = this.#hybrid.deriveKeys();
    const encrypted     = new GematriaAead(key, nonce).encrypt(compressed);

    // — CID unique
    const cid = `skn:${crypto.randomUUID()}`;

    // — Stockage chiffré en mémoire
    this.#encryptedFiles.set(cid, {
      filename,
      encryptedData  : encrypted,
      compressedSizeB: compressed.length,
      rawSizeB       : raw.length,
      uploadedAt     : Date.now(),
    });
    this.#index.set(filename.trim(), cid);

    // — Mise à jour compteurs
    this.usedStorageGb += compSizeGb;
    this.totalFiles++;
    this.#updateMonthlyCost();

    // — Persistance des métadonnées dans ZipMemory
    await this.#zipMemory.store(
      cid,
      new TextEncoder().encode(JSON.stringify({ filename, cid, compressedSizeB: compressed.length, rawSizeB: raw.length, uploadedAt: Date.now() }))
    );

    // — Récompense
    if (rewards instanceof UserRewards) {
      rewards.totalSkyEarned += REWARD_PER_UPLOAD;
    }

    console.debug(
      `[Storage] Upload: ${filename} → ${cid.slice(0,20)}… | ` +
      `${(raw.length / 1024).toFixed(1)} KB → ${(compressed.length / 1024).toFixed(1)} KB (×${ratio.toFixed(2)})`
    );

    return cid;
  }

  // ─── Download ─────────────────────────────────────────────────

  /**
   * Télécharge et déchiffre un fichier par CID ou par nom.
   * Essaie d'abord le hot cache (données déjà déchiffrées).
   *
   * @param {string} cidOrFilename — CID (skn:...) ou nom de fichier
   * @returns {Promise<Uint8Array|null>} données originales décompressées
   */
  async downloadFile(cidOrFilename) {
    const cid = cidOrFilename.startsWith('skn:')
      ? cidOrFilename
      : this.#index.get(cidOrFilename) ?? null;

    if (!cid) return null;

    // Hot cache hit
    if (this.#hotCache.has(cid)) return this.#hotCache.get(cid);

    const entry = this.#encryptedFiles.get(cid);
    if (!entry) return null;

    // — Déchiffrement (même clé/nonce déterministe via secret KEM mis en cache)
    const [key, nonce] = this.#hybrid.deriveKeys();
    let   compressed;
    try {
      compressed = new GematriaAead(key, nonce).decrypt(entry.encryptedData);
    } catch (e) {
      throw new Error(`Déchiffrement échoué pour ${cid}: ${e.message}`);
    }

    // — Décompression
    const raw = gunzipSync(compressed);

    // — Hot cache (LRU simplifié : on vire le plus ancien si plein)
    if (this.#hotCache.size >= HOT_CACHE_MAX) {
      const oldest = this.#hotCache.keys().next().value;
      this.#hotCache.delete(oldest);
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
    this.totalFiles = Math.max(0, this.totalFiles - 1);
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

  hasCid(cid)           { return this.#encryptedFiles.has(cid); }
  hasFile(filename)     { return this.#index.has(filename); }
  getCid(filename)      { return this.#index.get(filename) ?? null; }

  // ─── Réplication ──────────────────────────────────────────────

  /**
   * Réplique les fichiers non encore persistés dans ZipMemory.
   * Utile pour la sauvegarde périodique ou avant un arrêt propre.
   */
  async replicatePending() {
    let count = 0;
    for (const [cid, entry] of this.#encryptedFiles) {
      const existing = await this.#zipMemory.retrieve(cid);
      if (!existing) {
        await this.#zipMemory.store(
          cid,
          new TextEncoder().encode(JSON.stringify({
            filename: entry.filename, cid,
            compressedSizeB: entry.compressedSizeB, rawSizeB: entry.rawSizeB,
            uploadedAt: entry.uploadedAt,
          }))
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
    console.info(`[Storage] Storage Shield ${this.storageShieldEnabled ? 'activé' : 'désactivé'}`);
  }

  #updateMonthlyCost() {
    const rate = this.storageShieldEnabled ? BILLING_RATE_SHIELD : BILLING_RATE_BASE;
    this.monthlyCostSky     = Math.max(BILLING_MIN, this.usedStorageGb * rate);
    this.lastBillingUpdate  = Date.now();
  }

  // ─── État & rapport ───────────────────────────────────────────

  enterSleepMode() {
    this.currentState = 'Sleeping';
    this.#hotCache.clear();   // libère la mémoire en veille
    console.info('[Storage] Mode veille — hot cache vidé');
  }

  wakeUp() {
    this.currentState = 'Active';
    console.info('[Storage] Réveillé');
  }

  getStorageStats() {
    const usagePct = this.maxStorageGb > 0
      ? (this.usedStorageGb / this.maxStorageGb) * 100 : 0;
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

  healthReport() {
    const s = this.getStorageStats();
    return {
      nodeId         : this.nodeId,
      alias          : this.sovereignAlias,
      state          : this.currentState,
      usedGb         : s.usedGb,
      maxGb          : s.maxGb,
      usagePercent   : s.usagePercent,
      totalFiles     : s.totalFiles,
      shieldEnabled  : s.shieldEnabled,
      monthlyCostSky : s.monthlyCostSky,
    };
  }
}

export default StorageNode;
