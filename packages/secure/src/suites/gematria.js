// packages/secure/src/suites/gematria.js
// =====================================================
// Gematria Suite — AES-256-GCM + RomanT369 Hyper256
// Double couche de chiffrement : AES puis RomanT369
// SkyAInet × Nikola T369
// =====================================================

"use strict";

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from 'crypto';

import { RomanT369, GematriaMode } from '../crypto/roman_t369.js';

// ─────────────────────────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────────────────────────

const KEY_LEN   = 32;   // AES-256 : clé de 32 octets
const NONCE_LEN = 12;   // AES-GCM : nonce de 12 octets
const TAG_LEN   = 16;   // AES-GCM : tag d'authentification de 16 octets

// ─────────────────────────────────────────────────────────────────
// ERREUR TYPÉE
// ─────────────────────────────────────────────────────────────────

export class GematriaError extends Error {
  constructor(message, code = 'GEMATRIA_ERROR') {
    super(message);
    this.name = 'GematriaError';
    this.code = code;
  }
}

// ─────────────────────────────────────────────────────────────────
// GEMATRIA SUITE
//
// Double couche de chiffrement symétrique :
//   Couche 1 — AES-256-GCM (AEAD standard NIST)
//     → confidentialité + intégrité via tag d'authentification
//   Couche 2 — RomanT369 Hyper256
//     → couche gematria T369 sur le résultat AES
//
// Format du ciphertext final :
//   [nonce:12][aes_tag:16][roman_ct]
//
// Le tag AES-GCM est intégré dans l'enveloppe et vérifié au
// déchiffrement avant d'appliquer RomanT369 inverse.
//
// Bug original corrigé :
//   - Le tag GCM n'était pas inclus dans le ciphertext sérialisé
//     → déchiffrement impossible sans tag
//   - decipher.setAuthTag() manquant → AES-GCM sans vérification
//     d'intégrité (vulnérable à la modification du ciphertext)
// ─────────────────────────────────────────────────────────────────

export class GematriaSuite {
  constructor() {
    this.name    = 'Gematria';
  }

  // ─── Chiffrement ──────────────────────────────────────────────

  /**
   * Chiffre des données avec AES-256-GCM + RomanT369 Hyper256.
   *
   * Étapes :
   *   1. Nonce aléatoire 12 octets
   *   2. AES-256-GCM → [ciphertext_aes, tag_16B]
   *   3. RomanT369(key, nonce, Hyper256).encrypt(ciphertext_aes)
   *   4. Enveloppe = [nonce:12][tag:16][roman_ct]
   *
   * @param {Uint8Array|Buffer} data   — données claires
   * @param {Uint8Array}        key    — clé AES-256 (32 octets)
   * @returns {Uint8Array}             — enveloppe chiffrée
   */
  encrypt(data, key) {
    this.#validateKey(key);
    const pt    = data instanceof Uint8Array ? data : new Uint8Array(data);
    const nonce = randomBytes(NONCE_LEN);

    // — AES-256-GCM
    const cipher   = createCipheriv('aes-256-gcm', key, nonce);
    const aesCt    = Buffer.concat([cipher.update(pt), cipher.final()]);
    const tag      = cipher.getAuthTag();   // 16 octets

    // — RomanT369 Hyper256 sur le ciphertext AES (pas sur le tag)
    const roman    = new RomanT369(key, nonce, GematriaMode.Hyper256);
    const romanCt  = roman.encrypt(new Uint8Array(aesCt));

    // — Enveloppe : [nonce:12][tag:16][roman_ct]
    const envelope = new Uint8Array(NONCE_LEN + TAG_LEN + romanCt.length);
    envelope.set(nonce, 0);
    envelope.set(tag,   NONCE_LEN);
    envelope.set(romanCt, NONCE_LEN + TAG_LEN);

    console.debug(`[GematriaSuite] Chiffré ${pt.length} → ${envelope.length} B (AES-GCM + RomanT369)`);
    return envelope;
  }

  // ─── Déchiffrement ────────────────────────────────────────────

  /**
   * Déchiffre une enveloppe GematriaSuite.
   *
   * Étapes :
   *   1. Extraire nonce, tag, roman_ct de l'enveloppe
   *   2. RomanT369 inverse → ciphertext_aes
   *   3. AES-256-GCM avec setAuthTag(tag) → vérification intégrité + plaintext
   *
   * @param {Uint8Array} data   — enveloppe chiffrée
   * @param {Uint8Array} key    — clé AES-256 (32 octets)
   * @returns {Uint8Array}      — données claires
   */
  decrypt(data, key) {
    const MIN_LEN = NONCE_LEN + TAG_LEN + 1;
    if (!data || data.length < MIN_LEN) {
      throw new GematriaError(
        `Données trop courtes (${data?.length ?? 0} < ${MIN_LEN} octets)`,
        'E_TOO_SHORT'
      );
    }
    this.#validateKey(key);

    const envelope = data instanceof Uint8Array ? data : new Uint8Array(data);
    const nonce    = envelope.subarray(0, NONCE_LEN);
    const tag      = envelope.subarray(NONCE_LEN, NONCE_LEN + TAG_LEN);
    const romanCt  = envelope.subarray(NONCE_LEN + TAG_LEN);

    // — RomanT369 inverse
    const roman  = new RomanT369(key, nonce, GematriaMode.Hyper256);
    const aesCt  = roman.decrypt(romanCt);
    if (!aesCt) {
      throw new GematriaError('Déchiffrement RomanT369 échoué', 'E_ROMAN');
    }

    // — AES-256-GCM avec vérification d'intégrité du tag
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, nonce);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(aesCt), decipher.final()]);
      console.debug(`[GematriaSuite] Déchiffré ${envelope.length} → ${plaintext.length} B`);
      return new Uint8Array(plaintext);
    } catch (err) {
      // AES-GCM lance si le tag est invalide (données modifiées)
      throw new GematriaError(`Authentification AES-GCM échouée : ${err.message}`, 'E_AUTH');
    }
  }

  // ─── Utilitaires ─────────────────────────────────────────────

  /**
   * Génère une clé AES-256 aléatoire sécurisée (32 octets CSPRNG).
   * @returns {Uint8Array}
   */
  static generateKey() {
    return new Uint8Array(randomBytes(KEY_LEN));
  }

  /**
   * Dérive une clé depuis un secret partagé via une info HKDF-like simple.
   * Pour une vraie dérivation HKDF, utiliser sha_fips.hkdfSha256().
   *
   * @param {Uint8Array} sharedSecret
   * @param {string}     info
   * @returns {Uint8Array}
   */
  static keyFromSecret(sharedSecret, info = 'gematria-suite-v1') {
    // XOR du secret avec un digest de l'info (dérivation légère)
    const infoBytes = new TextEncoder().encode(info);
    const out       = new Uint8Array(KEY_LEN);
    for (let i = 0; i < KEY_LEN; i++) {
      out[i] = sharedSecret[i % sharedSecret.length] ^ infoBytes[i % infoBytes.length];
    }
    return out;
  }

  // ─── Privés ───────────────────────────────────────────────────

  #validateKey(key) {
    if (!(key instanceof Uint8Array) || key.length !== KEY_LEN) {
      throw new GematriaError(
        `Clé AES invalide (${key?.length ?? 0} octets, attendu ${KEY_LEN})`,
        'E_KEY'
      );
    }
  }
}
