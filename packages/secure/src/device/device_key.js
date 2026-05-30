// packages/secure/src/device/device_key.js
// =====================================================
// Device Key Management — Strong Edition + Error Handling
// SkyAInet × Nikola T369 — Signature Dilithium + Rotation + Révocation Fine
// =====================================================

import { Dilithium5Signer } from '../crypto/dilithium.js';

export class DeviceKeyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DeviceKeyError';
  }
}

export const DeviceStatus = Object.freeze({
  Active: 'Active',
  Revoked: 'Revoked',
  Expired: 'Expired',
});

export class DeviceKey {
  constructor(deviceId, publicKey, signature, expiresAt = null) {
    this.deviceId = new Uint8Array(deviceId);
    this.publicKey = new Uint8Array(publicKey);
    this.signature = new Uint8Array(signature);
    this.createdAt = new Date();
    this.lastRotation = new Date();
    this.expiresAt = expiresAt;
    this.status = DeviceStatus.Active;
    this.rotationCount = 0;
  }
}

export class DeviceKeyManager {
  constructor(identitySigner, maxDevices = 10) {
    this.identitySigner = identitySigner; // Dilithium5Signer
    this.devices = new Map();             // deviceId (hex) → DeviceKey
    this.maxDevices = maxDevices;
    this.defaultExpirationDays = 365;
  }

  /**
   * Enregistre un nouvel appareil avec signature Dilithium
   */
  registerDevice(devicePublicKey) {
    if (this.devices.size >= this.maxDevices) {
      throw new DeviceKeyError('Maximum number of devices reached');
    }

    if (!devicePublicKey || devicePublicKey.length !== 32) {
      throw new DeviceKeyError('Invalid public key length');
    }

    const deviceId = crypto.getRandomValues(new Uint8Array(32));
    const signature = this.identitySigner.sign(devicePublicKey);

    const now = new Date();
    const expiresAt = this.defaultExpirationDays
      ? new Date(now.getTime() + this.defaultExpirationDays * 24 * 60 * 60 * 1000)
      : null;

    const deviceKey = new DeviceKey(deviceId, devicePublicKey, signature, expiresAt);

    const deviceIdHex = this.#toHex(deviceId);
    this.devices.set(deviceIdHex, deviceKey);

    console.info(
      `[DeviceKeyManager] Nouvel appareil enregistré : ${deviceIdHex.slice(0, 16)} (total: ${this.devices.size})`
    );

    return deviceKey;
  }

  /**
   * Révoque un appareil
   */
  revokeDevice(deviceId) {
    const deviceIdHex = this.#toHex(deviceId);
    const device = this.devices.get(deviceIdHex);
    if (!device) throw new DeviceKeyError('Device not found');

    if (device.status === DeviceStatus.Revoked) return;

    device.status = DeviceStatus.Revoked;
    console.warn(`[DeviceKeyManager] Appareil révoqué : ${deviceIdHex.slice(0, 16)}`);
  }

  /**
   * Rotation d'une Device Key
   */
  rotateDeviceKey(deviceId, newPublicKey) {
    const deviceIdHex = this.#toHex(deviceId);
    const device = this.devices.get(deviceIdHex);
    if (!device) throw new DeviceKeyError('Device not found');

    if (device.status !== DeviceStatus.Active) {
      throw new DeviceKeyError('Device is revoked');
    }

    if (!newPublicKey || newPublicKey.length !== 32) {
      throw new DeviceKeyError('Invalid public key length');
    }

    device.publicKey = new Uint8Array(newPublicKey);
    device.signature = this.identitySigner.sign(newPublicKey);
    device.lastRotation = new Date();
    device.rotationCount++;

    console.debug(
      `[DeviceKeyManager] Rotation effectuée pour l’appareil \( {deviceIdHex.slice(0, 16)} (rotation # \){device.rotationCount})`
    );
  }

  /**
   * Vérifie la validité complète d’une Device Key
   */
  verifyDevice(device) {
    if (device.status === DeviceStatus.Revoked) {
      throw new DeviceKeyError('Device is revoked');
    }

    if (device.expiresAt && new Date() > device.expiresAt) {
      throw new DeviceKeyError('Device has expired');
    }

    // Vérification Dilithium réelle
    try {
      this.identitySigner.verify(device.publicKey, device.signature);
    } catch (e) {
      throw new DeviceKeyError('Signature verification failed');
    }

    return true;
  }

  /**
   * Vérifie si un appareil est valide
   */
  isDeviceValid(deviceId) {
    const deviceIdHex = this.#toHex(deviceId);
    const device = this.devices.get(deviceIdHex);
    if (!device) throw new DeviceKeyError('Device not found');

    return this.verifyDevice(device);
  }

  /**
   * Récupère un appareil
   */
  getDevice(deviceId) {
    const deviceIdHex = this.#toHex(deviceId);
    return this.devices.get(deviceIdHex) || null;
  }

  /**
   * Liste tous les appareils actifs
   */
  getActiveDevices() {
    return Array.from(this.devices.values()).filter(d => d.status === DeviceStatus.Active);
  }

  /**
   * Nettoie les appareils expirés ou révoqués
   */
  cleanupExpired() {
    const now = new Date();
    const before = this.devices.size;

    for (const [hex, device] of this.devices) {
      if (device.status === DeviceStatus.Revoked) {
        this.devices.delete(hex);
        continue;
      }
      if (device.expiresAt && now > device.expiresAt) {
        this.devices.delete(hex);
      }
    }

    const removed = before - this.devices.size;
    if (removed > 0) {
      console.debug(`[DeviceKeyManager] ${removed} appareils expirés/révoqués nettoyés`);
    }
    return removed;
  }

  /**
   * Retourne le nombre total d’appareils
   */
  deviceCount() {
    return this.devices.size;
  }

  // === Helpers ===

  #toHex(arr) {
    if (typeof arr === 'string') return arr;
    return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
  }
}