// packages/secure/src/roots/epoch_rekey.js
// =====================================================
// EpochRekeyManager — Rotation Sécurisée des Clés
// Compatible Contact + DID + GroupManager + RomanT369
// DiamantRoots v2 — Post-Quantique + Double Ratchet
// SkyAInet × Nikola T369
// =====================================================

import { RomanT369, GematriaMode } from '../crypto/roman_t369.js';
import { DoubleRatchet } from '../crypto/double_ratchet.js';

export class RekeyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RekeyError';
  }
}

export class EpochRekeyManager {
  constructor(rekeyInterval = 3600) {
    this.currentEpoch = 0;
    this.rekeyInterval = rekeyInterval;
    this.lastRekey = Math.floor(Date.now() / 1000);
    this.forceRekeyOnNext = false;
    this.roman = new RomanT369(new Uint8Array(32).fill(0x42), new Uint8Array(12), GematriaMode.Hyper256);
  }

  /**
   * Vérifie si un rekey est nécessaire
   */
  shouldRekey() {
    if (this.forceRekeyOnNext) return true;

    const now = Math.floor(Date.now() / 1000);
    return now - this.lastRekey > this.rekeyInterval;
  }

  /**
   * Effectue la rotation des clés via Double Ratchet + RomanT369
   */
  performRekey(sharedSecrets, contact = null) {
    if (!sharedSecrets || sharedSecrets.length === 0) {
      throw new RekeyError('Invalid circuit');
    }

    // Vérification DID
    if (contact) {
      if (!contact.hasDecentralizedIdentity || contact.verificationLevel < 2) {
        throw new RekeyError('Contact not verified for rekey');
      }
    }

    const newEpoch = this.currentEpoch + 1;

    for (let i = 0; i < sharedSecrets.length; i++) {
      const secret = sharedSecrets[i];

      // Double Ratchet pour la rotation
      const ratchet = new DoubleRatchet(secret);
      const newKey = ratchet.encrypt(new TextEncoder().encode('epoch_rekey_v6'));

      if (newKey.length >= 32) {
        // Renforcement final avec RomanT369
        const reinforced = this.roman.encrypt(newKey.subarray(0, 32));
        sharedSecrets[i] = reinforced.subarray(0, 32);
      }

      console.debug(`[EpochRekey] Clé ${i} rekeyée → Epoch ${newEpoch}`);
    }

    this.currentEpoch = newEpoch;
    this.lastRekey = Math.floor(Date.now() / 1000);
    this.forceRekeyOnNext = false;

    console.info(`[EpochRekey] Rekey terminé avec succès → Nouvel epoch: ${newEpoch}`);
    return newEpoch;
  }

  /**
   * Force un rekey au prochain appel
   */
  forceRekey() {
    this.forceRekeyOnNext = true;
    console.warn('[EpochRekey] Rekey forcé pour le prochain cycle');
  }

  /**
   * Temps restant avant le prochain rekey (en secondes)
   */
  timeUntilNextRekey() {
    const now = Math.floor(Date.now() / 1000);
    const elapsed = Math.max(0, now - this.lastRekey);
    return Math.max(0, this.rekeyInterval - elapsed);
  }
}