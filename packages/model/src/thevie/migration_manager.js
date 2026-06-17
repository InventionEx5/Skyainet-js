// packages/model/src/thevie/migration_manager.js
// =====================================================
// Migration Manager — Voyage Sécurisé Inter-Nœuds
// RomanT369 + Checksum + TravelPackage standardisé
// Port de migration_manager.rs
// SkyAInet × Nikola T369
// =====================================================

"use strict";

import { randomBytes }                from 'crypto';
import { RomanT369, GematriaMode }    from '#roman_t369';
import { Personality }                from '#personality';

// ─────────────────────────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────────────────────────

const PACKAGE_VERSION = '3.0';
const ROMAN_KEY       = new Uint8Array(32).fill(0x55);
const ROMAN_NONCE     = new Uint8Array(12).fill(0x00);
const TE              = new TextEncoder();
const TD              = new TextDecoder();

// ─────────────────────────────────────────────────────────────────
// TRAVEL PACKAGE — structure sérialisable inter-nœuds
// ─────────────────────────────────────────────────────────────────

export class TravelPackage {
  constructor({
    version           = PACKAGE_VERSION,
    personality       = {},
    totalEvolutions   = 0,
    totalExperiences  = 0,
    memorySnapshot    = null,
    adapter           = null,
    adapterParams     = 0,
    checksum          = '',
    timestamp         = Date.now(),
  } = {}) {
    this.version          = version;
    this.personality      = personality;   // Personality.toJSON()
    this.totalEvolutions  = totalEvolutions;
    this.totalExperiences = totalExperiences;
    this.memorySnapshot   = memorySnapshot; // string | null — leçons importantes
    this.adapter          = adapter;        // hex | null — poids LoRA (poids vivants)
    this.adapterParams    = adapterParams;  // nombre de paramètres de l'adapter
    this.checksum         = checksum;
    this.timestamp        = timestamp;
  }
}

// ─────────────────────────────────────────────────────────────────
// MIGRATION MANAGER
//
// Prépare et restaure un neurone/personnalité pour le voyage
// inter-nœuds via un TravelPackage chiffré RomanT369.
//
// Flux :
//   prepareTravel(personality, evolutionStats, memory?)
//     → sérialise en JSON → chiffre RomanT369 → "ROMAN|<hex>"
//
//   receiveTraveler(travelData)
//     → déchiffre → parse → valide version + checksum
//     → reconstruit Personality + retourne le package
//
// Sécurité :
//   - Chiffrement RomanT369 Hyper256 (clé éphémère par instance si requis)
//   - Checksum HMAC-like sur les traits principaux (tamper detection)
//   - Validation de version avant restauration
//   - Timestamp TTL : rejet des packages > 24 h (configurable)
// ─────────────────────────────────────────────────────────────────

export class MigrationManager {
  #roman;
  #enabled;
  #encryptionEnabled;
  #maxAgMs;        // TTL en ms des travel packages

  /**
   * @param {object}  [opts]
   * @param {boolean} opts.enabled           — active/désactive le manager
   * @param {boolean} opts.encryptionEnabled — chiffrement RomanT369
   * @param {number}  opts.maxAgeHours       — TTL des packages (défaut 24 h)
   * @param {Uint8Array} opts.key            — clé RomanT369 personnalisée
   */
  constructor(opts = {}) {
    this.#enabled           = opts.enabled           ?? true;
    this.#encryptionEnabled = opts.encryptionEnabled ?? true;
    this.#maxAgMs           = (opts.maxAgeHours ?? 24) * 3_600_000;

    const key   = opts.key instanceof Uint8Array ? opts.key : ROMAN_KEY;
    const nonce = opts.nonce instanceof Uint8Array ? opts.nonce : ROMAN_NONCE;
    this.#roman = new RomanT369(key, nonce, GematriaMode.Hyper256);
  }

  // ─── Préparation du voyage ────────────────────────────────────

  /**
   * Prépare un TravelPackage chiffré pour migration inter-nœuds.
   *
   * @param {Personality}   personality     — personnalité du neurone
   * @param {object}        evolutionStats  — { totalEvolutions }
   * @param {object}        [memory]        — { size, getBestLessons() }
   * @returns {string|null} — "ROMAN|<hex>" si chiffré, JSON sinon
   */
  prepareTravel(personality, evolutionStats = {}, memory = null, opts = {}) {
    if (!this.#enabled) return null;
    if (!(personality instanceof Personality)) {
      throw new TypeError('Expected Personality instance');
    }

    const personalityJson = personality.toJSON();
    const checksum        = this.#calculateChecksum(personality, evolutionStats);

    // Snapshot des meilleures leçons (si mémoire disponible)
    let memorySnapshot = null;
    if (memory && typeof memory.getBestLessons === 'function') {
      const best = memory.getBestLessons(5);
      if (best.length > 0) {
        memorySnapshot = JSON.stringify(best.map(l => ({
          query   : l.query?.slice(0, 100),
          quality : l.quality,
          expert  : l.expertUsed,
        })));
      }
    }

    // Poids vivants : l'adapter LoRA voyage avec le neurone (Fusion L2)
    let adapterHex = null, adapterParams = 0;
    const ad = opts.adapter;
    if (ad) {
      const bytes = (ad instanceof Uint8Array) ? ad
                  : (typeof ad.serialize === 'function' ? ad.serialize() : null);
      if (bytes) {
        adapterHex    = _toHex(bytes);
        adapterParams = typeof ad.numParams === 'function' ? ad.numParams() : bytes.length;
      }
    }

    const pkg = new TravelPackage({
      version         : PACKAGE_VERSION,
      personality     : personalityJson,
      totalEvolutions : evolutionStats.totalEvolutions ?? 0,
      totalExperiences: memory?.size ?? 0,
      memorySnapshot,
      adapter         : adapterHex,
      adapterParams,
      checksum,
      timestamp       : Date.now(),
    });

    const serialized = JSON.stringify(pkg);

    let result;
    if (this.#encryptionEnabled) {
      const encrypted = this.#roman.encrypt(TE.encode(serialized));
      result = 'ROMAN|' + _toHex(encrypted);
    } else {
      result = serialized;
    }

    console.info(`[MigrationManager] ✈️ Voyage préparé (${result.length} octets, chiffré: ${this.#encryptionEnabled})`);
    return result;
  }

  // ─── Réception d'un voyageur ──────────────────────────────────

  /**
   * Reçoit et restaure un TravelPackage depuis un pair.
   *
   * @param {string} travelData — "ROMAN|<hex>" ou JSON brut
   * @returns {{ personality: Personality, package: TravelPackage } | null}
   */
  receiveTraveler(travelData) {
    if (!this.#enabled || !travelData?.trim()) return null;

    // — Déchiffrement
    let jsonStr;
    try {
      if (travelData.startsWith('ROMAN|')) {
        const hex       = travelData.slice(6);
        const encrypted = _fromHex(hex);
        const decrypted = this.#roman.decrypt(encrypted);
        if (!decrypted) throw new Error('Déchiffrement RomanT369 échoué');
        jsonStr = TD.decode(decrypted);
      } else {
        jsonStr = travelData;
      }
    } catch (e) {
      console.error(`[MigrationManager] Déchiffrement échoué : ${e.message}`);
      return null;
    }

    // — Parsing
    let pkg;
    try {
      pkg = JSON.parse(jsonStr);
    } catch (e) {
      console.error(`[MigrationManager] JSON invalide : ${e.message}`);
      return null;
    }

    // — Validation de version
    if (pkg.version !== PACKAGE_VERSION) {
      console.warn(`[MigrationManager] Version incompatible : ${pkg.version} (attendu: ${PACKAGE_VERSION})`);
      return null;
    }

    // — Validation TTL
    if (Date.now() - (pkg.timestamp ?? 0) > this.#maxAgMs) {
      console.warn(`[MigrationManager] Package expiré (${Math.floor((Date.now() - pkg.timestamp) / 3_600_000)}h)`);
      return null;
    }

    // — Reconstruction de la Personality
    let personality;
    try {
      personality = new Personality(pkg.personality);
    } catch (e) {
      console.error(`[MigrationManager] Reconstruction Personality échouée : ${e.message}`);
      return null;
    }

    // — Validation du checksum (tamper detection)
    const expectedChecksum = this.#calculateChecksumFromJson(pkg.personality, { totalEvolutions: pkg.totalEvolutions });
    if (pkg.checksum !== expectedChecksum) {
      console.warn('[MigrationManager] ⚠️ Checksum invalide — données potentiellement altérées');
      return null;
    }

    console.info(
      `[MigrationManager] ✅ Voyageur reçu — sagesse: ${personality.wisdom.toFixed(3)} | ` +
      `évolutions: ${pkg.totalEvolutions} | expériences: ${pkg.totalExperiences}`
    );

    return {
      personality,
      package: new TravelPackage(pkg),
      adapterBytes: pkg.adapter ? _fromHex(pkg.adapter) : null,
    };
  }

  // ─── Configuration ───────────────────────────────────────────

  get enabled()           { return this.#enabled; }
  get encryptionEnabled() { return this.#encryptionEnabled; }

  setEnabled(v)           { this.#enabled = !!v; }
  setEncryption(v)        { this.#encryptionEnabled = !!v; }

  /**
   * Génère une clé aléatoire pour usage en production.
   * @returns {Uint8Array}
   */
  static generateKey() {
    return randomBytes(32);
  }

  /** Décode les octets de l'adapter LoRA d'un package reçu (ou null). */
  static decodeAdapter(pkg) {
    return pkg && pkg.adapter ? _fromHex(pkg.adapter) : null;
  }

  // ─── Privés ───────────────────────────────────────────────────

  /**
   * Checksum déterministe sur les traits principaux (tamper detection).
   * Format : "wisdom:benevolence:creativity:cooperation:totalEvolutions"
   */
  #calculateChecksum(personality, evolutionStats) {
    return this.#calculateChecksumFromJson(personality.toJSON(), evolutionStats);
  }

  #calculateChecksumFromJson(pJson, evolutionStats) {
    const w  = (pJson.wisdom       ?? 0).toFixed(4);
    const b  = (pJson.benevolence  ?? 0).toFixed(4);
    const c  = (pJson.creativity   ?? 0).toFixed(4);
    const co = (pJson.cooperation  ?? 0).toFixed(4);
    const e  = evolutionStats?.totalEvolutions ?? 0;
    return `${w}:${b}:${c}:${co}:${e}`;
  }
}

// ─────────────────────────────────────────────────────────────────
// HELPERS INTERNES
// ─────────────────────────────────────────────────────────────────

function _toHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2,'0')).join('');
}

function _fromHex(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    out[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return out;
}
