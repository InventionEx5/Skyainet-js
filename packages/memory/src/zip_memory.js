// packages/memory/src/zip_memory.js
// =====================================================
// ZipMemory — Compression Intelligente & Stockage Léger
// Hot Cache LRU + Persistance fs/promises + Stats temps réel
// Port de zip_memory.rs
// SkyAInet × Nikola T369
// =====================================================

"use strict";

import { gzipSync, gunzipSync }  from 'zlib';
import fs                        from 'fs';
import path                      from 'path';

// ─────────────────────────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────────────────────────

const HOT_CACHE_MAX  = 512;    // entrées LRU max (port de max_hot_cache_size)
const GZIP_LEVEL     = 6;      // compromis vitesse/ratio (≈ zstd niveau 4)
const MIN_COMPRESS   = 64;     // sous ce seuil, pas de compression

// ─────────────────────────────────────────────────────────────────
// ZIP MEMORY
//
// Stockage clé-valeur avec :
//   store(key, data)    — compresse gzip + écrit sur disque + met en cache
//   retrieve(key)       — lit du cache LRU ou du disque + décompresse
//   delete(key)         — supprime disque + cache
//   has(key)            — vérifie existence disque ou cache
//   list()              — liste toutes les clés persistées
//   stats()             — métriques complètes
//   printReport()       — rapport ASCII (port de print_report)
//   clearHotCache()     — vide le cache LRU sans toucher au disque
//
// Hot Cache LRU :
//   Map<key, Uint8Array> avec VecDeque simulé par un tableau
//   d'ordre d'accès — O(1) insertion, O(n) éviction (n ≤ 512).
//
// Persistance :
//   Chaque entrée → fichier "{basePath}/{key}.gz"
//   Les clés peuvent contenir des sous-dossiers via path.join.
// ─────────────────────────────────────────────────────────────────

export class ZipMemory {
  #basePath;
  #hotCache;      // Map<key, Uint8Array> — données décompressées
  #cacheOrder;    // string[]             — ordre LRU (plus récent en fin)
  #stats;
  #ready;         // Promise<void>        — init du répertoire

  constructor(basePath = './data/zip_memory') {
    this.#basePath   = basePath;
    this.#hotCache   = new Map();
    this.#cacheOrder = [];
    this.#stats      = {
      totalOriginalBytes   : 0,
      totalCompressedBytes : 0,
      itemsStored          : 0,
      itemsRetrieved       : 0,
      cacheHits            : 0,
      cacheMisses          : 0,
    };
    this.#ready = fs.promises.mkdir(basePath, { recursive: true }).catch(() => {});
  }

  // ─── Écriture ────────────────────────────────────────────────

  /**
   * Compresse et stocke une entrée (port de save).
   *
   * Si les données sont petites (< MIN_COMPRESS octets),
   * elles sont stockées sans compression.
   *
   * @param {string}         key
   * @param {Uint8Array|Buffer|string} data
   * @returns {Promise<boolean>}
   */
  async store(key, data) {
    await this.#ready;

    const raw        = _toBytes(data);
    const shouldGzip = raw.length >= MIN_COMPRESS;
    const stored     = shouldGzip ? gzipSync(raw, { level: GZIP_LEVEL }) : raw;
    const filePath   = this.#keyToPath(key, shouldGzip);

    try {
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      await fs.promises.writeFile(filePath, stored);
    } catch (e) {
      console.warn(`[ZipMemory] Écriture échouée pour "${key}": ${e.message}`);
      // Fallback : stockage en cache uniquement
      this.#cacheSet(key, raw);
      return false;
    }

    this.#stats.totalOriginalBytes    += raw.length;
    this.#stats.totalCompressedBytes  += stored.length;
    this.#stats.itemsStored++;

    this.#cacheSet(key, raw);
    return true;
  }

  // ─── Lecture ─────────────────────────────────────────────────

  /**
   * Récupère une entrée depuis le cache LRU ou le disque (port de load).
   *
   * @param {string} key
   * @returns {Promise<Uint8Array|null>}
   */
  async retrieve(key) {
    // Hot cache hit
    if (this.#hotCache.has(key)) {
      this.#stats.cacheHits++;
      this.#updateLru(key);
      return this.#hotCache.get(key);
    }

    this.#stats.cacheMisses++;

    // Cherche fichier compressé puis non-compressé
    const gzPath  = this.#keyToPath(key, true);
    const rawPath = this.#keyToPath(key, false);

    let fileData;
    let isGzip = false;

    try {
      fileData = await fs.promises.readFile(gzPath);
      isGzip   = true;
    } catch {
      try {
        fileData = await fs.promises.readFile(rawPath);
      } catch {
        return null;  // clé inexistante
      }
    }

    const raw = isGzip ? gunzipSync(fileData) : fileData;
    const out  = raw instanceof Uint8Array ? raw : new Uint8Array(raw);

    this.#cacheSet(key, out);
    this.#stats.itemsRetrieved++;
    return out;
  }

  // ─── Suppression ─────────────────────────────────────────────

  async delete(key) {
    this.#hotCache.delete(key);
    this.#cacheOrder = this.#cacheOrder.filter(k => k !== key);

    for (const compressed of [true, false]) {
      try { await fs.promises.unlink(this.#keyToPath(key, compressed)); } catch { /* absent */ }
    }
  }

  // ─── Existence & Listing ──────────────────────────────────────

  async has(key) {
    if (this.#hotCache.has(key)) return true;
    try { await fs.promises.access(this.#keyToPath(key, true));  return true; } catch {}
    try { await fs.promises.access(this.#keyToPath(key, false)); return true; } catch {}
    return false;
  }

  /**
   * Liste toutes les clés persistées sur disque.
   * @returns {Promise<string[]>}
   */
  async list() {
    await this.#ready;
    const keys = [];
    await this.#walk(this.#basePath, keys);
    return keys;
  }

  // ─── Cache ───────────────────────────────────────────────────

  clearHotCache() {
    this.#hotCache.clear();
    this.#cacheOrder = [];
  }

  // ─── Stats (port de get_stats + print_report) ─────────────────

  stats() {
    const ratio = this.#stats.totalOriginalBytes > 0
      ? this.#stats.totalCompressedBytes / this.#stats.totalOriginalBytes : 1;
    const saved = Math.max(0, this.#stats.totalOriginalBytes - this.#stats.totalCompressedBytes);

    return {
      itemsStored          : this.#stats.itemsStored,
      itemsRetrieved       : this.#stats.itemsRetrieved,
      cacheHits            : this.#stats.cacheHits,
      cacheMisses          : this.#stats.cacheMisses,
      cacheSize            : this.#hotCache.size,
      compressionRatio     : +ratio.toFixed(4),
      savedBytes           : saved,
      savedMB              : +(saved / 1_048_576).toFixed(3),
      totalOriginalMB      : +(this.#stats.totalOriginalBytes / 1_048_576).toFixed(3),
      totalCompressedMB    : +(this.#stats.totalCompressedBytes / 1_048_576).toFixed(3),
    };
  }

  printReport() {
    const s = this.stats();
    const hitRate = (s.cacheHits + s.cacheMisses) > 0
      ? (s.cacheHits / (s.cacheHits + s.cacheMisses) * 100).toFixed(1) : '0.0';

    console.log('\n╔═════════════════════════════════════════════╗');
    console.log('║         ZIP MEMORY REPORT                   ║');
    console.log('╠═════════════════════════════════════════════╣');
    console.log(`║ Items stockés     : ${String(s.itemsStored).padStart(12)}           ║`);
    console.log(`║ Compression ratio : ${s.compressionRatio.toFixed(3).padStart(12)}x          ║`);
    console.log(`║ Espace économisé  : ${(s.savedMB + ' MB').padStart(12)}           ║`);
    console.log(`║ Cache hit rate    : ${(hitRate + ' %').padStart(12)}           ║`);
    console.log(`║ Cache size        : ${String(s.cacheSize + '/' + HOT_CACHE_MAX).padStart(12)}           ║`);
    console.log('╚═════════════════════════════════════════════╝\n');
  }

  // ─── Privés ───────────────────────────────────────────────────

  #keyToPath(key, compressed) {
    const safe = key.replace(/[^a-zA-Z0-9_\-:/]/g, '_');
    const ext  = compressed ? '.gz' : '.bin';
    return path.join(this.#basePath, safe + ext);
  }

  #cacheSet(key, data) {
    if (this.#hotCache.size >= HOT_CACHE_MAX) {
      const oldest = this.#cacheOrder.shift();
      if (oldest) this.#hotCache.delete(oldest);
    }
    this.#hotCache.set(key, data);
    this.#updateLru(key);
  }

  #updateLru(key) {
    this.#cacheOrder = this.#cacheOrder.filter(k => k !== key);
    this.#cacheOrder.push(key);
  }

  async #walk(dir, keys) {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await this.#walk(full, keys);
      } else {
        const rel = path.relative(this.#basePath, full)
          .replace(/\.(gz|bin)$/, '')
          .replace(/_/g, '/');
        keys.push(rel);
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────
// HELPER INTERNE
// ─────────────────────────────────────────────────────────────────

function _toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (Buffer.isBuffer(data))      return new Uint8Array(data);
  if (typeof data === 'string')   return new TextEncoder().encode(data);
  return new Uint8Array(data);
}
