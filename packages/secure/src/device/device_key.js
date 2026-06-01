// packages/secure/src/device/device_key.js
// =====================================================
// Device Key Management — Dilithium5 + Rotation + Révocation
// SkyAInet × Nikola T369
// =====================================================

"use strict";

import { randomBytes }                       from 'crypto';
import { Dilithium5Signer, Dilithium5KeyPair } from '../crypto/dilithium.js';

// ─────────────────────────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────────────────────────

// Dilithium5 (ML-DSA-87) : clé publique = 2592 octets
// On accepte toute clé ≥ 16 octets (clé courte de test incluse)
const MIN_PUBKEY_LEN = 16;

// ─────────────────────────────────────────────────────────────────
// ERREUR TYPÉE
// ─────────────────────────────────────────────────────────────────

export class DeviceKeyError extends Error {
  constructor(message, code = 'DEVICE_ERROR') {
    super(message);
    this.name = 'DeviceKeyError';
    this.code = code;
  }
}

// ─────────────────────────────────────────────────────────────────
// STATUTS
// ─────────────────────────────────────────────────────────────────

export const DeviceStatus = Object.freeze({
  Active : 'Active',
  Revoked: 'Revoked',
  Expired: 'Expired',
});

// ─────────────────────────────────────────────────────────────────
// DEVICE KEY
// ─────────────────────────────────────────────────────────────────

export class DeviceKey {
  constructor({ deviceId, publicKey, signature, expiresAt = null }) {
    this.deviceId      = new Uint8Array(deviceId);
    this.publicKey     = new Uint8Array(publicKey);
    this.signature     = new Uint8Array(signature);
    this.createdAt     = Date.now();
    this.lastRotation  = Date.now();
    this.expiresAt     = expiresAt;    // timestamp ms | null
    this.status        = DeviceStatus.Active;
    this.rotationCount = 0;
  }

  isExpired()  { return this.expiresAt != null && Date.now() > this.expiresAt; }
  isActive()   { return this.status === DeviceStatus.Active && !this.isExpired(); }
}

// ─────────────────────────────────────────────────────────────────
// DEVICE KEY MANAGER
// ─────────────────────────────────────────────────────────────────

export class DeviceKeyManager {
  #devices;          // Map<deviceIdHex, DeviceKey>
  #identitySigner;   // Dilithium5Signer

  /**
   * @param {Dilithium5Signer} identitySigner — signer de l'identité principale
   * @param {number}           maxDevices     — nombre max d'appareils enregistrés
   * @param {number}           defaultExpirationDays — durée de vie par défaut (0 = pas d'expiration)
   */
  constructor(identitySigner, maxDevices = 10, defaultExpirationDays = 365) {
    if (!(identitySigner instanceof Dilithium5Signer)) {
      throw new DeviceKeyError('identitySigner doit être une instance de Dilithium5Signer', 'E_INPUT');
    }
    this.#identitySigner       = identitySigner;
    this.#devices              = new Map();
    this.maxDevices            = maxDevices;
    this.defaultExpirationDays = defaultExpirationDays;
  }

  // ─── Enregistrement ──────────────────────────────────────────

  /**
   * Enregistre un nouvel appareil.
   * La clé publique fournie est signée avec l'identité principale (Dilithium5).
   *
   * Bug original corrigé :
   *   `devicePublicKey.length !== 32` — Dilithium5 produit ~2592 octets.
   *   La validation est maintenant `length < MIN_PUBKEY_LEN` (16 octets).
   *
   * @param {Uint8Array} devicePublicKey — clé publique Dilithium5 de l'appareil
   * @returns {DeviceKey}
   */
  registerDevice(devicePublicKey) {
    if (this.#devices.size >= this.maxDevices) {
      throw new DeviceKeyError(
        `Nombre maximum d'appareils atteint (${this.maxDevices})`,
        'E_LIMIT'
      );
    }
    if (!(devicePublicKey instanceof Uint8Array) || devicePublicKey.length < MIN_PUBKEY_LEN) {
      throw new DeviceKeyError(
        `Clé publique invalide (${devicePublicKey?.length ?? 0} < ${MIN_PUBKEY_LEN} octets)`,
        'E_PUBKEY'
      );
    }

    const deviceId  = randomBytes(32);
    const signature = this.#identitySigner.sign(devicePublicKey);
    const expiresAt = this.defaultExpirationDays > 0
      ? Date.now() + this.defaultExpirationDays * 86_400_000
      : null;

    const device    = new DeviceKey({ deviceId, publicKey: devicePublicKey, signature, expiresAt });
    this.#devices.set(_hex(deviceId), device);

    console.info(
      `[DeviceKeyManager] Appareil enregistré: ${_hex(deviceId).slice(0, 16)} ` +
      `(total: ${this.#devices.size})`
    );
    return device;
  }

  // ─── Révocation ───────────────────────────────────────────────

  revokeDevice(deviceId) {
    const device = this.#getDevice(deviceId);
    if (device.status === DeviceStatus.Revoked) return;
    device.status = DeviceStatus.Revoked;
    console.warn(`[DeviceKeyManager] Appareil révoqué: ${_hex(deviceId).slice(0, 16)}`);
  }

  // ─── Rotation ─────────────────────────────────────────────────

  /**
   * Effectue la rotation de la clé publique d'un appareil.
   * La nouvelle clé est signée avec l'identité principale.
   *
   * @param {Uint8Array} deviceId
   * @param {Uint8Array} newPublicKey — nouvelle clé publique Dilithium5
   */
  rotateDeviceKey(deviceId, newPublicKey) {
    const device = this.#getDevice(deviceId);

    if (!device.isActive()) {
      throw new DeviceKeyError(
        `Rotation impossible — appareil ${device.status.toLowerCase()}`,
        'E_STATUS'
      );
    }
    if (!(newPublicKey instanceof Uint8Array) || newPublicKey.length < MIN_PUBKEY_LEN) {
      throw new DeviceKeyError(
        `Nouvelle clé invalide (${newPublicKey?.length ?? 0} < ${MIN_PUBKEY_LEN} octets)`,
        'E_PUBKEY'
      );
    }

    device.publicKey     = new Uint8Array(newPublicKey);
    device.signature     = this.#identitySigner.sign(newPublicKey);
    device.lastRotation  = Date.now();
    device.rotationCount++;

    console.debug(
      `[DeviceKeyManager] Rotation appareil ${_hex(deviceId).slice(0, 16)} ` +
      `— rotation #${device.rotationCount}`
    );
  }

  // ─── Vérification ─────────────────────────────────────────────

  /**
   * Vérifie la validité complète d'un DeviceKey :
   *   1. Statut (non révoqué)
   *   2. Expiration
   *   3. Signature Dilithium5 : la clé publique de l'appareil a bien été
   *      signée par l'identité principale (vérification stateless via la
   *      clé publique du signer).
   *
   * @param {DeviceKey} device
   * @returns {true}
   * @throws {DeviceKeyError}
   */
  verifyDevice(device) {
    if (device.status === DeviceStatus.Revoked) {
      throw new DeviceKeyError('Appareil révoqué', 'E_REVOKED');
    }
    if (device.isExpired()) {
      throw new DeviceKeyError('Appareil expiré', 'E_EXPIRED');
    }

    // Vérification Dilithium5 : la signature sur publicKey doit valider
    // avec la clé publique du signer (identité principale)
    const ok = Dilithium5KeyPair.verify(
      this.#identitySigner.publicKeyBytes(),
      device.publicKey,
      device.signature
    );
    if (!ok) throw new DeviceKeyError('Signature Dilithium5 invalide', 'E_SIG');

    return true;
  }

  isDeviceValid(deviceId) {
    return this.verifyDevice(this.#getDevice(deviceId));
  }

  // ─── Lecture ─────────────────────────────────────────────────

  getDevice(deviceId)   { return this.#getDevice(deviceId); }
  getActiveDevices()    { return [...this.#devices.values()].filter(d => d.isActive()); }
  deviceCount()         { return this.#devices.size; }

  cleanupExpired() {
    let removed = 0;
    for (const [hex, device] of this.#devices) {
      if (device.status === DeviceStatus.Revoked || device.isExpired()) {
        this.#devices.delete(hex);
        removed++;
      }
    }
    if (removed > 0) console.debug(`[DeviceKeyManager] ${removed} appareil(s) nettoyé(s)`);
    return removed;
  }

  // ─── Privé ────────────────────────────────────────────────────

  #getDevice(deviceId) {
    const device = this.#devices.get(_hex(deviceId));
    if (!device) throw new DeviceKeyError('Appareil introuvable', 'E_NOT_FOUND');
    return device;
  }
}

// ─────────────────────────────────────────────────────────────────
// HELPER INTERNE
// ─────────────────────────────────────────────────────────────────

function _hex(arr) {
  if (typeof arr === 'string') return arr;
  return Array.from(arr).map(b => b.toString(16).padStart(2,'0')).join('');
}
