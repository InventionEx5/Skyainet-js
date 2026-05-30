// packages/secure/src/defense/canvas_blocker.js
// =====================================================
// Canvas Fingerprinting Blocker — Strong Edition
// SkyAInet × Nikola T369 — Active Evasion (AE)
// =====================================================

import { RomanT369, GematriaMode } from '../crypto/roman_t369.js';

export const CanvasProtectionLevel = Object.freeze({
  Low: 'Low',       // 35% de bruit
  Medium: 'Medium', // 65% de bruit (par défaut)
  High: 'High',     // 82% de bruit
  Paranoid: 'Paranoid', // 95% de bruit + perturbation RomanT369
});

export class CanvasBlocker {
  constructor(level = CanvasProtectionLevel.Medium) {
    let noiseStrength;
    switch (level) {
      case CanvasProtectionLevel.Low:
        noiseStrength = 0.35;
        break;
      case CanvasProtectionLevel.Medium:
        noiseStrength = 0.65;
        break;
      case CanvasProtectionLevel.High:
        noiseStrength = 0.82;
        break;
      case CanvasProtectionLevel.Paranoid:
        noiseStrength = 0.95;
        break;
      default:
        noiseStrength = 0.65;
    }

    this.noiseStrength = noiseStrength;
    this.protectionLevel = level;
    this.injectionCount = 0;
    this.totalBytesModified = 0;
    this.roman = new RomanT369(
      new Uint8Array(32).fill(0xAB),
      new Uint8Array(12).fill(0xCD),
      GematriaMode.Hyper256
    );
  }

  /**
   * Bloque et pollue activement le fingerprinting Canvas
   * @param {Uint8Array} canvasData - Données du canvas (modifié en place)
   */
  blockCanvasFingerprinting(canvasData) {
    if (!(canvasData instanceof Uint8Array)) {
      throw new Error('canvasData must be a Uint8Array');
    }

    let modified = 0;

    for (let i = 0; i < canvasData.length; i++) {
      if (Math.random() < this.noiseStrength) {
        const noise = Math.floor(Math.random() * 13); // 0..12

        let newVal = (canvasData[i] + noise) & 0xff;

        // Perturbation RomanT369 sur niveau Paranoid
        if (this.protectionLevel === CanvasProtectionLevel.Paranoid) {
          const romanNoise = this.roman.encrypt(new Uint8Array([newVal]))[0];
          newVal = (newVal + (romanNoise % 7)) & 0xff;
        }

        // Variation selon la position (bruit moins uniforme)
        if (i % 4 === 0) {
          newVal = (newVal + 3) & 0xff;
        }

        canvasData[i] = newVal % 255;
        modified++;
      }
    }

    this.injectionCount++;
    this.totalBytesModified += modified;

    console.debug(
      `[CanvasBlocker] Fingerprinting bloqué — ${modified} octets modifiés (niveau: ${this.protectionLevel})`
    );
  }

  /**
   * Génère un faux Canvas réaliste
   */
  generateFakeCanvas(width, height) {
    const size = width * height * 4;
    const fake = new Uint8Array(size);
    let rngIndex = 0; // pour simuler la position dans la boucle

    for (let i = 0; i < size; i += 4) {
      const base = 200 + Math.floor(Math.random() * 46); // 200..245

      fake[i]     = (base + Math.floor(Math.random() * 16)) & 0xff; // R
      fake[i + 1] = (base + Math.floor(Math.random() * 13)) & 0xff; // G
      fake[i + 2] = (base + Math.floor(Math.random() * 19)) & 0xff; // B
      fake[i + 3] = 255; // Alpha

      // Ajout de bruit RomanT369 sur Paranoid
      if (this.protectionLevel === CanvasProtectionLevel.Paranoid && rngIndex % 7 === 0) {
        const romanVal = this.roman.encrypt(new Uint8Array([fake[i]]))[0];
        fake[i] = (fake[i] + (romanVal % 5)) & 0xff;
      }

      rngIndex++;
    }

    console.info(
      `[CanvasBlocker] Faux Canvas généré (\( {width}x \){height}) — Niveau: ${this.protectionLevel}`
    );

    return fake;
  }

  getInjectionCount() {
    return this.injectionCount;
  }

  getTotalBytesModified() {
    return this.totalBytesModified;
  }

  getProtectionLevel() {
    return this.protectionLevel;
  }
}

// Default export pour facilité d'utilisation
export default CanvasBlocker;