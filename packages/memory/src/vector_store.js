// packages/memory/src/vector_store.js
// =====================================================
// VectorStore — Recherche Sémantique Avancée (port de vector_store.rs)
// Cosinus boosted qualité + filtres + cache LRU + persistance ZipMemory
// SkyAInet × Nikola T369
// =====================================================

"use strict";

import { ZipMemory } from '#zip_memory';

// ─────────────────────────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────────────────────────

const CACHE_SIZE_MAX = 32;
const EPS            = 1e-8;    // division par zéro cosinus

// ─────────────────────────────────────────────────────────────────
// VECTOR METADATA
// ─────────────────────────────────────────────────────────────────

export class VectorMetadata {
  constructor({ quality = 0.5, expert = 'unknown', source = '', tags = [], importance = 0.5 } = {}) {
    this.quality    = Math.max(0, Math.min(1, quality));
    this.expert     = expert;
    this.source     = source;
    this.tags       = Array.isArray(tags) ? tags : [];
    this.importance = Math.max(0, Math.min(1, importance));
    this.timestamp  = Date.now();
  }
}

// ─────────────────────────────────────────────────────────────────
// VECTOR ENTRY
// ─────────────────────────────────────────────────────────────────

export class VectorEntry {
  constructor(id, embedding, metadata, contentPreview = '') {
    this.id             = id;
    this.embedding      = embedding instanceof Float32Array ? embedding : new Float32Array(embedding);
    this.metadata       = metadata instanceof VectorMetadata ? metadata : new VectorMetadata(metadata ?? {});
    this.contentPreview = contentPreview.slice(0, 256);
  }
}

// ─────────────────────────────────────────────────────────────────
// VECTOR STORE
//
// Stockage + recherche vectorielle cosinus avec :
//   - Boost qualité : score_final = cosine × (0.6 + 0.4 × quality)
//   - Filtre expert, filtre qualité min
//   - Cache LRU des 32 dernières recherches (clé = hash de l'embedding)
//   - Persistance optionnelle via ZipMemory
//   - Batch insert + suppression + stats
// ─────────────────────────────────────────────────────────────────

export class VectorStore {
  #vectors;       // Map<id, VectorEntry>
  #dimension;
  #cache;         // Map<cacheKey, SearchResult[]> — LRU
  #cacheOrder;    // string[] — ordre LRU
  #archive;       // ZipMemory | null
  #totalSearches;

  /**
   * @param {number}        dimension — dimension des vecteurs (défaut 128)
   * @param {object}        [opts]
   * @param {string}        opts.archivePath — chemin ZipMemory pour persistance
   * @param {number}        opts.cacheSize   — taille max du cache (défaut 32)
   */
  constructor(dimension = 128, opts = {}) {
    this.#dimension    = dimension;
    this.#vectors      = new Map();
    this.#cache        = new Map();
    this.#cacheOrder   = [];
    this.#totalSearches= 0;
    this.#archive      = opts.archivePath ? new ZipMemory(opts.archivePath) : null;
  }

  // ─── Insertion ───────────────────────────────────────────────

  /**
   * Insère ou remplace un vecteur.
   * Invalide le cache si un vecteur existant est modifié.
   */
  insert(id, embedding, metadata = null, contentPreview = '') {
    const emb = embedding instanceof Float32Array ? embedding : new Float32Array(embedding);
    if (emb.length !== this.#dimension) {
      throw new RangeError(`Dimension mismatch: attendu ${this.#dimension}, reçu ${emb.length}`);
    }
    const isNew = !this.#vectors.has(id);
    this.#vectors.set(id, new VectorEntry(id, emb, metadata, contentPreview));
    if (!isNew) this.#cache.clear();  // invalidation partielle
  }

  /**
   * Insertion en batch (port de batch_insert).
   * @param {{ id, embedding, metadata, contentPreview }[]} entries
   */
  batchInsert(entries) {
    for (const e of entries) {
      this.insert(e.id, e.embedding, e.metadata ?? null, e.contentPreview ?? '');
    }
    this.#cache.clear();
  }

  // ─── Recherche ───────────────────────────────────────────────

  /**
   * Recherche cosinus avec boost qualité, filtre expert, filtre qualité min.
   *
   * Score final = cosine × (0.6 + 0.4 × metadata.quality)
   *
   * @param {Float32Array|number[]} queryEmbedding
   * @param {number}  topK
   * @param {object}  [opts]
   * @param {number}  opts.minQuality    — qualité minimum [0, 1]
   * @param {string}  opts.expertFilter  — filtre sur metadata.expert
   * @param {string[]} opts.tags         — filtre sur metadata.tags (au moins un)
   * @returns {{ entry: VectorEntry, score: number }[]}
   */
  search(queryEmbedding, topK = 5, opts = {}) {
    const query = queryEmbedding instanceof Float32Array
      ? queryEmbedding : new Float32Array(queryEmbedding);

    if (query.length !== this.#dimension) {
      throw new RangeError(`Query dimension mismatch: ${query.length} ≠ ${this.#dimension}`);
    }

    // Cache lookup
    const cacheKey = this.#cacheKey(query, opts);
    if (this.#cache.has(cacheKey)) {
      return this.#cache.get(cacheKey).slice(0, topK);
    }

    const { minQuality = 0, expertFilter = null, tags = [] } = opts;
    const qNorm = _norm(query);

    const results = [];

    for (const entry of this.#vectors.values()) {
      // Filtres
      if (entry.metadata.quality < minQuality) continue;
      if (expertFilter && entry.metadata.expert !== expertFilter) continue;
      if (tags.length > 0 && !tags.some(t => entry.metadata.tags.includes(t))) continue;

      const cosine  = qNorm > 0 ? _dot(query, entry.embedding) / (qNorm * _norm(entry.embedding) + EPS) : 0;
      const boosted = cosine * (0.6 + 0.4 * entry.metadata.quality);
      results.push({ entry, score: boosted });
    }

    results.sort((a, b) => b.score - a.score);
    const top = results.slice(0, topK);

    // Mise en cache LRU
    this.#cacheSet(cacheKey, top);
    this.#totalSearches++;
    return top;
  }

  /**
   * Recherche hybride : combine score cosinus + importance des métadonnées.
   * Utile pour prioriser les leçons critiques même si peu similaires.
   */
  hybridSearch(queryEmbedding, topK = 5, importanceWeight = 0.3) {
    const baseResults = this.search(queryEmbedding, topK * 3);
    const hybrid = baseResults.map(({ entry, score }) => ({
      entry,
      score: score * (1 - importanceWeight) + entry.metadata.importance * importanceWeight,
    }));
    hybrid.sort((a, b) => b.score - a.score);
    return hybrid.slice(0, topK);
  }

  // ─── Bridge mémoire sémantique → RAG / volant (Fusion L4) ────

  /**
   * Ajoute une leçon en mémoire sémantique (sucre sur insert avec métadonnées
   * orientées leçon). L'embedding provient du modèle.
   */
  addLesson(id, embedding, text = '', { quality = 0.7, expert = 'lesson', importance = 0.6, tags = [] } = {}) {
    this.insert(id, embedding, new VectorMetadata({ quality, expert, importance, tags, source: 'lesson' }), text);
    return id;
  }

  /**
   * Récupère les contenus/leçons les plus pertinents pour une requête (RAG).
   * @param {Float32Array|number[]} queryEmbedding
   * @param {number} k
   * @param {{minQuality?: number}} [opts]
   * @returns {{ id, text, score, quality }[]}
   */
  retrieveLessons(queryEmbedding, k = 5, { minQuality = 0 } = {}) {
    return this.search(queryEmbedding, k, { minQuality }).map(({ entry, score }) => ({
      id     : entry.id,
      text   : entry.contentPreview,
      score  : +score.toFixed(4),
      quality: entry.metadata.quality,
    }));
  }

  // ─── CRUD ────────────────────────────────────────────────────

  get(id)    { return this.#vectors.get(id) ?? null; }
  has(id)    { return this.#vectors.has(id); }

  remove(id) {
    const deleted = this.#vectors.delete(id);
    if (deleted) this.#cache.clear();
    return deleted;
  }

  /** Supprime les vecteurs dont la qualité est inférieure au seuil. */
  pruneByQuality(minQuality = 0.3) {
    let removed = 0;
    for (const [id, entry] of this.#vectors) {
      if (entry.metadata.quality < minQuality) { this.#vectors.delete(id); removed++; }
    }
    if (removed > 0) this.#cache.clear();
    return removed;
  }

  // ─── Persistance ─────────────────────────────────────────────

  /**
   * Persiste tous les vecteurs dans ZipMemory.
   * @param {ZipMemory} [archive] — optionnel, utilise l'archive interne si absent
   */
  async saveToDisk(archive = null) {
    const zip = archive ?? this.#archive;
    if (!zip) return;
    const TE = new TextEncoder();

    for (const [id, entry] of this.#vectors) {
      const key  = `vector:${id}`;
      const data = TE.encode(JSON.stringify({
        id      : entry.id,
        embedding: Array.from(entry.embedding),
        metadata : entry.metadata,
        preview  : entry.contentPreview,
      }));
      await zip.store(key, data);
    }
    console.info(`[VectorStore] ${this.#vectors.size} vecteurs persistés`);
  }

  /**
   * Charge les vecteurs depuis ZipMemory.
   * @param {string[]} ids — liste d'ids à charger
   */
  async loadFromDisk(ids, archive = null) {
    const zip = archive ?? this.#archive;
    if (!zip) return;
    const TD = new TextDecoder();
    let loaded = 0;

    for (const id of ids) {
      const raw = await zip.retrieve(`vector:${id}`);
      if (!raw) continue;
      try {
        const obj = JSON.parse(TD.decode(raw));
        this.insert(obj.id, obj.embedding, obj.metadata, obj.preview ?? '');
        loaded++;
      } catch { /* corrompu */ }
    }
    console.info(`[VectorStore] ${loaded}/${ids.length} vecteurs chargés`);
    return loaded;
  }

  // ─── Stats ───────────────────────────────────────────────────

  stats() {
    let sumQ = 0, sumI = 0;
    for (const e of this.#vectors.values()) {
      sumQ += e.metadata.quality;
      sumI += e.metadata.importance;
    }
    const n = this.#vectors.size;
    return {
      totalVectors  : n,
      totalSearches : this.#totalSearches,
      cacheSize     : this.#cache.size,
      dimension     : this.#dimension,
      avgQuality    : n > 0 ? +(sumQ / n).toFixed(4) : 0,
      avgImportance : n > 0 ? +(sumI / n).toFixed(4) : 0,
    };
  }

  get size()         { return this.#vectors.size; }
  get totalSearches(){ return this.#totalSearches; }

  // ─── Privés ───────────────────────────────────────────────────

  #cacheKey(query, opts) {
    // Hash rapide : somme et produit des N premiers éléments + options
    let h = 0;
    for (let i = 0; i < Math.min(16, query.length); i++) h = (h * 31 + (query[i] * 1000) | 0) >>> 0;
    return `${h}:${opts.minQuality ?? 0}:${opts.expertFilter ?? ''}:${(opts.tags ?? []).join(',')}`;
  }

  #cacheSet(key, value) {
    if (this.#cacheOrder.length >= CACHE_SIZE_MAX) {
      const oldest = this.#cacheOrder.shift();
      this.#cache.delete(oldest);
    }
    this.#cache.set(key, value);
    this.#cacheOrder.push(key);
  }
}

// ─────────────────────────────────────────────────────────────────
// HELPERS VECTORIELS
// ─────────────────────────────────────────────────────────────────

function _dot(a, b) {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

function _norm(a) {
  let s = 0;
  for (const v of a) s += v * v;
  return Math.sqrt(s);
}
