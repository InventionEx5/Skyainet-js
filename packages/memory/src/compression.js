// packages/memory/src/compression.js
// =====================================================
// Compression — Haute Performance (Brotli)
// SkyAInet × Nikola T369
// =====================================================

"use strict";

import {
  brotliCompressSync,
  brotliDecompressSync,
  gzipSync,
  gunzipSync,
  constants as zlibConstants,
} from 'zlib';

// ─────────────────────────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────────────────────────

const BROTLI_PARAM_QUALITY   = zlibConstants.BROTLI_PARAM_QUALITY;
const BROTLI_PARAM_SIZE_HINT = zlibConstants.BROTLI_PARAM_SIZE_HINT;
const BROTLI_MAX_QUALITY     = zlibConstants.BROTLI_MAX_QUALITY;  // 11
const BROTLI_DEFAULT_QUALITY = 4;   // bon compromis vitesse/ratio

// Seuil en octets en dessous duquel la compression est inutile
// (overhead Brotli + header > gain potentiel)
const MIN_COMPRESS_SIZE = 64;

// ─────────────────────────────────────────────────────────────────
// ERREUR TYPÉE
// ─────────────────────────────────────────────────────────────────

export class CompressionError extends Error {
  constructor(message, code = 'COMPRESSION_ERROR') {
    super(message);
    this.name = 'CompressionError';
    this.code = code;
  }
}

// ─────────────────────────────────────────────────────────────────
// RÉSULTAT DE COMPRESSION
// ─────────────────────────────────────────────────────────────────

export class CompressionResult {
  constructor(data, originalSize, algo) {
    this.data         = data;            // Uint8Array compressé
    this.originalSize = originalSize;    // octets avant compression
    this.compressedSize = data.length;   // octets après compression
    this.algo         = algo;            // 'brotli' | 'gzip' | 'none'
    this.ratio        = originalSize > 0
      ? +(originalSize / data.length).toFixed(3)
      : 1;
    this.gainPercent  = originalSize > 0
      ? +(100 - (data.length / originalSize) * 100).toFixed(1)
      : 0;
  }
}

// ─────────────────────────────────────────────────────────────────
// COMPRESSION
// ─────────────────────────────────────────────────────────────────

export class Compression {
  #level;     // qualité Brotli [0, 11]

  /**
   * @param {number} level — qualité Brotli (0 = aucun, 11 = max, défaut 4)
   */
  constructor(level = BROTLI_DEFAULT_QUALITY) {
    this.#level = Math.max(0, Math.min(BROTLI_MAX_QUALITY, Math.floor(level)));
  }

  get level() { return this.#level; }

  // ─── Brotli ─────────────────────────────────────────────────

  /**
   * Compresse des données avec Brotli.
   *
   * Si les données sont vides ou trop petites pour bénéficier de la
   * compression (< 64 octets), elles sont retournées telles quelles.
   * Le hint de taille est passé à Brotli pour améliorer le ratio.
   *
   * @param {Uint8Array|Buffer} data
   * @returns {CompressionResult}
   */
  compress(data) {
    if (!data || data.length === 0) {
      return new CompressionResult(new Uint8Array(0), 0, 'none');
    }

    const input = data instanceof Uint8Array ? data : new Uint8Array(data);

    // En dessous du seuil, la compression coûte plus qu'elle ne rapporte
    if (input.length < MIN_COMPRESS_SIZE) {
      return new CompressionResult(input, input.length, 'none');
    }

    try {
      const compressed = brotliCompressSync(input, {
        params: {
          [BROTLI_PARAM_QUALITY]  : this.#level,
          [BROTLI_PARAM_SIZE_HINT]: input.length,
        },
      });

      const result = new CompressionResult(new Uint8Array(compressed), input.length, 'brotli');
      console.debug(
        `[Compression] Brotli q${this.#level}: ${input.length} → ${compressed.length} octets` +
        ` (${result.gainPercent}% gain, ×${result.ratio})`
      );
      return result;

    } catch (err) {
      throw new CompressionError(`Compression Brotli échouée: ${err.message}`, 'BROTLI_ERROR');
    }
  }

  /**
   * Décompresse des données Brotli.
   * Lance une CompressionError si les données sont corrompues ou trop courtes.
   *
   * @param {Uint8Array|Buffer} data
   * @returns {Uint8Array}
   */
  decompress(data) {
    if (!data || data.length < 4) {
      throw new CompressionError(
        `Données trop courtes pour décompresser (${data?.length ?? 0} octets)`,
        'TOO_SHORT'
      );
    }

    const input = data instanceof Uint8Array ? data : new Uint8Array(data);

    try {
      const decompressed = brotliDecompressSync(input);
      console.debug(
        `[Compression] Décompression Brotli: ${input.length} → ${decompressed.length} octets`
      );
      return new Uint8Array(decompressed);
    } catch (err) {
      throw new CompressionError(`Décompression Brotli échouée: ${err.message}`, 'BROTLI_ERROR');
    }
  }

  // ─── Gzip (fallback / interop) ───────────────────────────────

  /**
   * Compresse avec gzip (niveau 6).
   * Utile pour l'interopérabilité avec des systèmes qui ne supportent pas Brotli.
   *
   * @param {Uint8Array|Buffer} data
   * @returns {CompressionResult}
   */
  compressGzip(data) {
    if (!data || data.length === 0) {
      return new CompressionResult(new Uint8Array(0), 0, 'none');
    }
    const input = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (input.length < MIN_COMPRESS_SIZE) {
      return new CompressionResult(input, input.length, 'none');
    }

    try {
      const compressed = gzipSync(input, { level: 6 });
      return new CompressionResult(new Uint8Array(compressed), input.length, 'gzip');
    } catch (err) {
      throw new CompressionError(`Compression gzip échouée: ${err.message}`, 'GZIP_ERROR');
    }
  }

  /**
   * Décompresse des données gzip.
   *
   * @param {Uint8Array|Buffer} data
   * @returns {Uint8Array}
   */
  decompressGzip(data) {
    if (!data || data.length < 4) {
      throw new CompressionError(
        `Données gzip trop courtes (${data?.length ?? 0} octets)`,
        'TOO_SHORT'
      );
    }
    try {
      return new Uint8Array(gunzipSync(data instanceof Uint8Array ? data : new Uint8Array(data)));
    } catch (err) {
      throw new CompressionError(`Décompression gzip échouée: ${err.message}`, 'GZIP_ERROR');
    }
  }

  // ─── Utilitaires ─────────────────────────────────────────────

  /**
   * Estime si la compression sera bénéfique pour ce bloc de données.
   * Heuristique basée sur l'entropie approximative (variance des octets).
   * Les données déjà compressées ou chiffrées ont une haute entropie
   * et ne bénéficient pas de la compression.
   */
  static shouldCompress(data) {
    if (!data || data.length < MIN_COMPRESS_SIZE) return false;

    // Échantillon des 256 premiers octets
    const sample = data.subarray(0, Math.min(256, data.length));
    const freq   = new Uint32Array(256);
    for (const b of sample) freq[b]++;

    // Entropie de Shannon approximée
    let entropy = 0;
    const n = sample.length;
    for (const f of freq) {
      if (f > 0) {
        const p = f / n;
        entropy -= p * Math.log2(p);
      }
    }

    // Entropie max = 8 bits. Au-delà de 7.5 → données déjà compressées/chiffrées
    return entropy < 7.5;
  }

  /**
   * Clone l'instance avec un niveau différent.
   */
  withLevel(level) {
    return new Compression(level);
  }
}

// ─────────────────────────────────────────────────────────────────
// INSTANCES PAR DÉFAUT
// ─────────────────────────────────────────────────────────────────

/** Niveau équilibré — bon compromis vitesse/ratio pour la plupart des usages */
export const defaultCompression = new Compression(4);

/** Niveau rapide — priorité à la vitesse (ex. données temps réel) */
export const fastCompression = new Compression(1);

/** Niveau maximal — priorité au ratio (ex. archivage long terme) */
export const maxCompression = new Compression(BROTLI_MAX_QUALITY);
