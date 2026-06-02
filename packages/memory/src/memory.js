// packages/memory/src/memory.js
// =====================================================
// Memory Package — Point d'entrée central
// Ré-exports de tous les modules du package memory/
// SkyAInet × Nikola T369
// =====================================================

"use strict";

// ─────────────────────────────────────────────────────────────────
// STOCKAGE CLÉ-VALEUR COMPRESSÉ
// ─────────────────────────────────────────────────────────────────

export { ZipMemory }                                from './zip_memory.js';

// ─────────────────────────────────────────────────────────────────
// STOCKAGE SOUVERAIN (fichiers chiffrés + facturation)
// ─────────────────────────────────────────────────────────────────

export { StorageNode, PersistentStorage }           from './storage.js';

// ─────────────────────────────────────────────────────────────────
// COMPRESSION HAUTE PERFORMANCE
// ─────────────────────────────────────────────────────────────────

export {
  Compression, CompressionResult, CompressionError,
  defaultCompression, fastCompression, maxCompression,
}                                                   from './compression.js';

// ─────────────────────────────────────────────────────────────────
// RECHERCHE SÉMANTIQUE VECTORIELLE
// ─────────────────────────────────────────────────────────────────

export { VectorStore, VectorEntry, VectorMetadata } from './vector_store.js';

// ─────────────────────────────────────────────────────────────────
// STOCKAGE DÉCENTRALISÉ IPFS
// ─────────────────────────────────────────────────────────────────

export { IpfsStorage, IpfsError, IpfsAddResponse }  from './ipfs.js';

// ─────────────────────────────────────────────────────────────────
// VERSION
// ─────────────────────────────────────────────────────────────────

export const VERSION = '1.0.0';

export const PACKAGE_INFO = Object.freeze({
  name       : 'skyainet-memory',
  version    : VERSION,
  description: 'SkyAInet Memory Package — ZipMemory, Storage, Compression, VectorStore, IPFS',
  modules    : [
    'ZipMemory', 'StorageNode', 'PersistentStorage',
    'Compression', 'VectorStore', 'IpfsStorage',
  ],
});
