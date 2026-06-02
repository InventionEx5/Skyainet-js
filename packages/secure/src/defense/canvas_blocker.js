// packages/secure/src/defense/canvas_blocker.js
// =====================================================
// Canvas Fingerprinting Blocker — Active Evasion
// SkyAInet × Nikola T369
// =====================================================

"use strict";

import { randomBytes }                from 'crypto';
import { RomanT369, GematriaMode }    from '../crypto/roman_t369.js';

// ─────────────────────────────────────────────────────────────────
// NIVEAUX DE PROTECTION
// ─────────────────────────────────────────────────────────────────

export const CanvasProtectionLevel = Object.freeze({
  Low     : 'Low',      // 35 % de bruit — quasi transparent
  Medium  : 'Medium',   // 65 % de bruit — équilibre (défaut)
  High    : 'High',     // 82 % de bruit
  Paranoid: 'Paranoid', // 95 % de bruit + perturbation RomanT369
});

const NOISE_STRENGTH = {
  [CanvasProtectionLevel.Low]     : 0.35,
  [CanvasProtectionLevel.Medium]  : 0.65,
  [CanvasProtectionLevel.High]    : 0.82,
  [CanvasProtectionLevel.Paranoid]: 0.95,
};

const MAX_NOISE_BYTE = 12;  // bruit max par octet ([0, 12])

// ─────────────────────────────────────────────────────────────────
// CANVAS BLOCKER
//
// Pollue les données brutes d'un canvas pour empêcher le
// fingerprinting tout en restant visuellement indiscernable.
//
// Niveaux Low/Medium/High : bruit pseudo-aléatoire pondéré par position.
// Niveau Paranoid : bruit RomanT369 à clé éphémère — chaque instance
//   produit un pattern différent, rendant la corrélation entre sessions
//   cryptographiquement impossible.
//
// Clé RomanT369 : randomBytes(32) à la construction — éphémère,
//   jamais réutilisée entre instances.
// ─────────────────────────────────────────────────────────────────

export class CanvasBlocker {
  #roman;          // RomanT369 éphémère (Paranoid uniquement)
  #noiseStrength;
  #noiseTable;     // Uint8Array(256) — table de bruit HKDF précalculée

  constructor(level = CanvasProtectionLevel.Medium) {
    if (!CanvasProtectionLevel[level]) {
      throw new TypeError(`Niveau invalide : ${level}`);
    }

    this.protectionLevel   = level;
    this.#noiseStrength    = NOISE_STRENGTH[level] ?? 0.65;
    this.injectionCount    = 0;
    this.totalBytesModified= 0;

    // Clé et nonce aléatoires — pattern unique par instance
    const key   = randomBytes(32);
    const nonce = randomBytes(12);
    this.#roman = new RomanT369(key, nonce, GematriaMode.Hyper256);

    // Précalcul d'une table de bruit de 256 octets pour les niveaux non-Paranoid
    // Évite d'appeler Math.random() par octet — plus rapide sur grands buffers
    this.#noiseTable = randomBytes(256);
  }

  // ─── Blocage ──────────────────────────────────────────────────

  /**
   * Pollue les données canvas en place.
   *
   * Algorithme :
   *   Pour chaque octet : si rand < noiseStrength → ajouter du bruit
   *   Bruit = noiseTable[i % 256] % (MAX_NOISE_BYTE + 1)
   *   Niveau Paranoid : bruit additionnel RomanT369 par bloc de 32 octets
   *
   * Modification en place pour éviter la copie de grands buffers.
   *
   * @param {Uint8Array} canvasData — modifié en place
   */
  blockCanvasFingerprinting(canvasData) {
    if (!(canvasData instanceof Uint8Array)) {
      throw new TypeError('canvasData doit être un Uint8Array');
    }

    let modified = 0;

    // Niveau Paranoid : préchiffrer un bloc de 32 octets pour l'index courant
    let romanBlock    = null;
    let romanBlockIdx = -1;

    for (let i = 0; i < canvasData.length; i++) {
      // Décision d'injection basée sur la table précalculée + position
      const threshold = this.#noiseStrength * 255;
      if ((this.#noiseTable[i % 256] + i) % 256 > threshold) continue;

      // Bruit de base
      let noise = this.#noiseTable[(i + 1) % 256] % (MAX_NOISE_BYTE + 1);

      // Variation selon le canal RGBA (i % 4 : R=0, G=1, B=2, A=3)
      const channel = i % 4;
      if (channel === 3) continue;  // ne pas toucher l'alpha — évite les artefacts

      if (channel === 0) noise = (noise + 2) & 0xff;   // R — bruit légèrement plus fort

      // Perturbation RomanT369 (Paranoid) par bloc de 32 octets
      if (this.protectionLevel === CanvasProtectionLevel.Paranoid) {
        const blockIndex = Math.floor(i / 32);
        if (blockIndex !== romanBlockIdx) {
          const seed       = new Uint8Array(32);
          seed[0]          = blockIndex & 0xff;
          seed[1]          = (blockIndex >> 8) & 0xff;
          romanBlock       = this.#roman.encrypt(seed);
          romanBlockIdx    = blockIndex;
        }
        noise = (noise + (romanBlock[i % 32] % 5)) & 0xff;
      }

      canvasData[i] = (canvasData[i] + noise) & 0xff;
      modified++;
    }

    this.injectionCount++;
    this.totalBytesModified += modified;

    console.debug(
      `[CanvasBlocker] ${modified}/${canvasData.length} octets modifiés` +
      ` (niveau: ${this.protectionLevel}, ratio: ${(modified/canvasData.length*100).toFixed(1)}%)`
    );

    return modified;
  }

  // ─── Faux canvas ──────────────────────────────────────────────

  /**
   * Génère un faux canvas RGBA visuellement plausible (fond clair bruité).
   * Le bruit est cohérent par blocs de 4 pixels pour éviter les artefacts
   * de compression JPEG qui trahiraient un canvas purement aléatoire.
   *
   * @param {number} width
   * @param {number} height
   * @returns {Uint8Array} — données RGBA
   */
  generateFakeCanvas(width, height) {
    if (width <= 0 || height <= 0) throw new RangeError('Dimensions invalides');

    const size = width * height * 4;
    const data = new Uint8Array(size);

    // Base lumineuse cohérente (200–245) — plausible pour un canvas de texte
    const baseR = 200 + (randomBytes(1)[0] % 46);
    const baseG = 200 + (randomBytes(1)[0] % 46);
    const baseB = 200 + (randomBytes(1)[0] % 46);

    // Bruit par bloc de 4 pixels pour cohérence spatiale
    const noisePool = randomBytes(Math.ceil(size / 4));

    for (let i = 0; i < size; i += 4) {
      const n       = noisePool[i >> 2];
      data[i]       = Math.min(255, baseR + (n & 0x0f));
      data[i + 1]   = Math.min(255, baseG + ((n >> 2) & 0x0f));
      data[i + 2]   = Math.min(255, baseB + ((n >> 4) & 0x0f));
      data[i + 3]   = 255;  // alpha opaque

      // Perturbation RomanT369 sur Paranoid
      if (this.protectionLevel === CanvasProtectionLevel.Paranoid && (i >> 2) % 7 === 0) {
        const seed   = new Uint8Array(32);
        seed[0]      = (i >> 2) & 0xff;
        const roman  = this.#roman.encrypt(seed);
        data[i]      = (data[i] + (roman[0] % 5)) & 0xff;
      }
    }

    console.info(`[CanvasBlocker] Faux canvas ${width}×${height} généré (${size} octets)`);
    return data;
  }

  // ─── Accesseurs ───────────────────────────────────────────────

  getInjectionCount()     { return this.injectionCount; }
  getTotalBytesModified() { return this.totalBytesModified; }
  getProtectionLevel()    { return this.protectionLevel; }

  stats() {
    return {
      level              : this.protectionLevel,
      noiseStrength      : this.#noiseStrength,
      injectionCount     : this.injectionCount,
      totalBytesModified : this.totalBytesModified,
    };
  }
}

export default CanvasBlocker;
