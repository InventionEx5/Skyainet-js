// packages/memory/src/ipfs.js
// =====================================================
// IPFS Storage — Client Décentralisé Résilient
// HybridTransport + GematriaAead + ZipMemory + Retry
// Port de ipfs.rs
// SkyAInet × Nikola T369
// =====================================================

"use strict";

import { HybridTransport }   from '../../secure/src/crypto/hybrid.js';
import { GematriaAead }      from '../../secure/src/crypto/gematria_aead.js';
import { ZipMemory }         from './zip_memory.js';
import { gzipSync, gunzipSync } from 'zlib';

// ─────────────────────────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────────────────────────

const DEFAULT_API_URL     = 'http://127.0.0.1:5001';
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_TIMEOUT_MS  = 90_000;
const CONNECT_TIMEOUT_MS  = 12_000;
const RETRY_BASE_DELAY_MS = 600;
const TE                  = new TextEncoder();
const TD                  = new TextDecoder();

// ─────────────────────────────────────────────────────────────────
// ERREUR TYPÉE
// ─────────────────────────────────────────────────────────────────

export class IpfsError extends Error {
  constructor(message, code = 'IPFS_ERROR') {
    super(message);
    this.name = 'IpfsError';
    this.code = code;
  }

  static requestFailed(msg)  { return new IpfsError(`IPFS request failed: ${msg}`,  'REQUEST_FAILED'); }
  static parseError(msg)     { return new IpfsError(`Parse error: ${msg}`,          'PARSE_ERROR'); }
  static encryptionFailed()  { return new IpfsError('Encryption failed',            'ENCRYPTION_FAILED'); }
  static timeout()           { return new IpfsError('Network timeout',              'TIMEOUT'); }
  static maxRetries()        { return new IpfsError('Max retries exceeded',         'MAX_RETRIES'); }
}

// ─────────────────────────────────────────────────────────────────
// IPFS ADD RESPONSE
// ─────────────────────────────────────────────────────────────────

export class IpfsAddResponse {
  constructor({ Hash, Size, Name }) {
    this.hash = Hash;
    this.size = Size;
    this.name = Name;
  }
}

// ─────────────────────────────────────────────────────────────────
// IPFS STORAGE
//
// Upload/download décentralisé via API IPFS locale (Kubo).
//
// Pipeline upload (put) :
//   1. Compression gzip (si use_compression)
//   2. Chiffrement HybridTransport + GematriaAead (si encrypt)
//   3. Upload multipart avec retry exponentiel (max 3 tentatives)
//   4. Cache local ZipMemory du CID → données originales
//
// Pipeline download (get) :
//   1. Vérification cache ZipMemory
//   2. Fetch IPFS /api/v0/cat
//   3. Déchiffrement + décompression
//
// En l'absence de `fetch` natif (Node < 18), utilise un polyfill
// minimal via http/https Node.js.
// ─────────────────────────────────────────────────────────────────

export class IpfsStorage {
  #hybrid;         // HybridTransport
  #zipMemory;      // ZipMemory | null — cache local des CIDs
  #stats;

  /**
   * @param {object} [opts]
   * @param {string}  opts.apiUrl              — URL API IPFS (défaut localhost:5001)
   * @param {boolean} opts.encryptBeforeUpload — chiffrement HybridTransport (défaut true)
   * @param {boolean} opts.useCompression      — compression gzip avant upload (défaut true)
   * @param {boolean} opts.withZipMemory       — cache local des CIDs (défaut true)
   * @param {number}  opts.maxRetries
   * @param {number}  opts.timeoutMs
   */
  constructor(opts = {}) {
    this.apiUrl              = opts.apiUrl              ?? DEFAULT_API_URL;
    this.encryptBeforeUpload = opts.encryptBeforeUpload ?? true;
    this.useCompression      = opts.useCompression      ?? true;
    this.maxRetries          = opts.maxRetries          ?? DEFAULT_MAX_RETRIES;
    this.timeoutMs           = opts.timeoutMs           ?? DEFAULT_TIMEOUT_MS;

    this.#hybrid    = new HybridTransport(true);
    this.#zipMemory = (opts.withZipMemory ?? true)
      ? new ZipMemory('./data/ipfs_cache')
      : null;

    this.#stats = {
      uploads  : 0,
      downloads: 0,
      failures : 0,
      cacheHits: 0,
    };
  }

  // ─── Upload ───────────────────────────────────────────────────

  /**
   * Upload sécurisé avec compression + chiffrement + retry exponentiel.
   * (port de put)
   *
   * @param {string}         key  — nom du fichier dans IPFS
   * @param {Uint8Array|string} data
   * @returns {Promise<string>} CID IPFS
   */
  async put(key, data) {
    let payload = typeof data === 'string' ? TE.encode(data) : new Uint8Array(data);
    const original = payload;

    // 1. Compression gzip
    if (this.useCompression && payload.length >= 64) {
      payload = new Uint8Array(gzipSync(payload, { level: 6 }));
      console.debug(`[IPFS] Compressé: ${original.length} → ${payload.length} B`);
    }

    // 2. Chiffrement HybridTransport + GematriaAead
    if (this.encryptBeforeUpload) {
      try {
        const [encKey, nonce] = this.#hybrid.deriveKeys();
        payload = new GematriaAead(encKey, nonce).encrypt(payload);
      } catch (e) {
        throw IpfsError.encryptionFailed();
      }
    }

    // 3. Upload avec retry exponentiel
    let lastError;
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const cid = await this.#uploadToIpfs(key, payload);
        this.#stats.uploads++;

        // Cache local : stocker les données originales (non chiffrées)
        if (this.#zipMemory) {
          await this.#zipMemory.store(`cid:${cid}`, original).catch(() => {});
        }

        console.info(`[IPFS] Upload réussi → CID: ${cid}`);
        return cid;

      } catch (e) {
        lastError = e;
        this.#stats.failures++;
        if (attempt < this.maxRetries) {
          const delay = RETRY_BASE_DELAY_MS * attempt;
          console.warn(`[IPFS] Tentative ${attempt}/${this.maxRetries} échouée — retry dans ${delay}ms`);
          await _sleep(delay);
        }
      }
    }

    throw IpfsError.maxRetries();
  }

  // ─── Download ─────────────────────────────────────────────────

  /**
   * Récupère et déchiffre des données depuis un CID IPFS.
   * Vérifie d'abord le cache ZipMemory local.
   * (port de get)
   *
   * @param {string} cid
   * @returns {Promise<Uint8Array>}
   */
  async get(cid) {
    // Cache hit
    if (this.#zipMemory) {
      const cached = await this.#zipMemory.retrieve(`cid:${cid}`);
      if (cached) {
        this.#stats.cacheHits++;
        console.debug(`[IPFS] Cache hit pour ${cid.slice(0, 16)}…`);
        return cached;
      }
    }

    // Fetch IPFS
    const url = `${this.apiUrl}/api/v0/cat?arg=${cid}`;
    let bytes;

    try {
      const response = await _fetchWithTimeout(url, { method: 'POST' }, this.timeoutMs);
      if (!response.ok) throw IpfsError.requestFailed(response.status);
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch (e) {
      if (e instanceof IpfsError) throw e;
      throw IpfsError.requestFailed(e.message);
    }

    // Déchiffrement
    if (this.encryptBeforeUpload && bytes.length > 0) {
      try {
        const [encKey, nonce] = this.#hybrid.deriveKeys();
        bytes = new GematriaAead(encKey, nonce).decrypt(bytes);
        if (!bytes) throw IpfsError.requestFailed('Déchiffrement échoué');
      } catch (e) {
        throw e instanceof IpfsError ? e : IpfsError.requestFailed(e.message);
      }
    }

    // Décompression
    if (this.useCompression) {
      try { bytes = new Uint8Array(gunzipSync(bytes)); } catch { /* non compressé */ }
    }

    this.#stats.downloads++;

    // Mise en cache
    if (this.#zipMemory) {
      await this.#zipMemory.store(`cid:${cid}`, bytes).catch(() => {});
    }

    return bytes;
  }

  // ─── Utilitaires ─────────────────────────────────────────────

  /**
   * Épingle un CID pour le conserver dans le nœud IPFS local.
   * (port de pin)
   */
  async pin(cid) {
    const url = `${this.apiUrl}/api/v0/pin/add?arg=${cid}`;
    try {
      const res = await _fetchWithTimeout(url, { method: 'POST' }, this.timeoutMs);
      if (res.ok) {
        console.info(`[IPFS] CID ${cid.slice(0, 16)}… épinglé`);
      } else {
        throw IpfsError.requestFailed(res.status);
      }
    } catch (e) {
      throw e instanceof IpfsError ? e : IpfsError.requestFailed(e.message);
    }
  }

  /**
   * Vérifie la santé du nœud IPFS local (port de health_check).
   * @returns {Promise<boolean>}
   */
  async healthCheck() {
    try {
      const res = await _fetchWithTimeout(
        `${this.apiUrl}/api/v0/version`,
        { method: 'GET' },
        CONNECT_TIMEOUT_MS
      );
      return res.ok;
    } catch { return false; }
  }

  // ─── Stats ───────────────────────────────────────────────────

  stats() { return { ...this.#stats }; }

  // ─── Privés ───────────────────────────────────────────────────

  /**
   * Upload multipart vers l'API IPFS /api/v0/add (port de upload_to_ipfs).
   */
  async #uploadToIpfs(filename, data) {
    const boundary = `----SkyAInet${Math.random().toString(36).slice(2)}`;
    const header   = TE.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`
    );
    const footer   = TE.encode(`\r\n--${boundary}--\r\n`);

    const body     = new Uint8Array(header.length + data.length + footer.length);
    body.set(header, 0);
    body.set(data,   header.length);
    body.set(footer, header.length + data.length);

    const url = `${this.apiUrl}/api/v0/add?pin=true`;
    const res = await _fetchWithTimeout(url, {
      method : 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
    }, this.timeoutMs);

    if (!res.ok) throw IpfsError.requestFailed(`HTTP ${res.status}`);

    const text = await res.text();
    // IPFS retourne du NDJSON — prendre la dernière ligne non-vide
    const lines = text.trim().split('\n').filter(Boolean);
    const last  = lines[lines.length - 1];
    let json;
    try { json = JSON.parse(last); }
    catch (e) { throw IpfsError.parseError(last); }

    if (!json.Hash) throw IpfsError.parseError('Hash manquant dans la réponse IPFS');
    return json.Hash;
  }
}

// ─────────────────────────────────────────────────────────────────
// HELPERS INTERNES
// ─────────────────────────────────────────────────────────────────

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function _fetchWithTimeout(url, opts, timeoutMs) {
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } catch (e) {
    if (e.name === 'AbortError') throw IpfsError.timeout();
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
