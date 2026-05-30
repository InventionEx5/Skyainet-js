// packages/secure/src/utils/compression.js
// =====================================================
// Compression Utilities — Haute Performance (Brotli)
// Compatible Contact + DID + GroupManager
// SkyAInet × Nikola T369
// =====================================================

import { brotliCompressSync, brotliDecompressSync } from 'zlib';

export class CompressionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CompressionError';
  }
}

export class Compression {
  constructor(level = 4) {
    // Niveau Brotli : 0 = aucun, 11 = maximum (4-6 = bon compromis)
    this.level = Math.max(0, Math.min(11, level));
  }

  /**
   * Compresse des données avec Brotli (très bon ratio + rapide)
   */
  compress(data) {
    if (!data || data.length === 0) {
      return new Uint8Array(0);
    }

    try {
      const compressed = brotliCompressSync(data, {
        params: {
          [require('zlib').constants.BROTLI_PARAM_QUALITY]: this.level,
        },
      });

      console.debug(
        `[Compression] Données compressées : ${data.length} → ${compressed.length} octets ` +
        `(${(100 - (compressed.length / data.length) * 100).toFixed(1)}% gain)`
      );

      return new Uint8Array(compressed);
    } catch (err) {
      throw new CompressionError(`Compression failed: ${err.message}`);
    }
  }

  /**
   * Décompresse des données avec Brotli
   */
  decompress(data) {
    if (!data || data.length < 4) {
      throw new CompressionError('Data too small to decompress');
    }

    try {
      const decompressed = brotliDecompressSync(data);
      console.debug(`[Compression] Données décompressées : ${data.length} → ${decompressed.length} octets`);
      return new Uint8Array(decompressed);
    } catch (err) {
      throw new CompressionError(`Decompression failed: ${err.message}`);
    }
  }
}

// Instance par défaut (niveau équilibré)
export const defaultCompression = new Compression(4);