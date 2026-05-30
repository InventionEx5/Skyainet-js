// packages/secure/src/index.js
// =====================================================
// @skyainet/secure — Point d'entrée principal
// SkyAInet × Nikola T369 — Secure Messaging + Defense + Blockchain
// Version 6.0 — Production Ready
// =====================================================

// === DEVICE ===
export {
  DeviceKeyManager,
  DeviceKey,
  DeviceStatus,
  DeviceKeyError,
} from './device/device_key.js';

// === DEFENSE ===
export {
  CanvasBlocker,
  CanvasProtectionLevel,
} from './defense/canvas_blocker.js';

export {
  DecoyCircuitManager,
  DecoyCircuit,
} from './defense/decoy_circuits.js';

export {
  AntiDebug,
} from './defense/anti_debug.js';

// === CONTACTS ===
export {
  Contact,
  createDefaultContact,
} from './contacts/contact.js';

export {
  ContactManager,
  ContactManagerError,
  Did,
} from './contacts/manager.js';

export {
  ContactVerification,
  GroupVerification,
  Group,
  VerificationError,
  VerificationLevel,
} from './contacts/verification.js';

// === MESSAGING ===
export {
  MessagingManager,
  MessagingError,
  Message,
  Conversation,
  MessageType,
} from './messaging.js';

// === BLOCKCHAIN ===
export {
  EpochManager,
  EpochError,
  EpochStatus,
} from './blockchain/epoch.js';

export {
  BroadcastSession,
  BroadcastError,
  SessionStatus,
} from './blockchain/broadcast.js';

// === CRYPTO (stubs / à implémenter) ===
// Décommente quand les fichiers seront prêts
// export { Dilithium5Signer, DilithiumError } from './crypto/dilithium.js';
// export { RomanT369, GematriaMode } from './crypto/roman_t369.js';
// export { KemT369 } from './crypto/kem_t369.js';
// export { DoubleRatchet } from './crypto/double_ratchet.js';
// export { hkdfSha256 } from './crypto/sha_fips.js';

// === UTILITAIRES ===
export const VERSION = '6.0.0';
export const AUTHOR = 'SkyAInet × Nikola T369';

/**
 * Crée une instance complète du système Secure
 * (helper pour démarrage rapide)
 */
export function createSecureSystem(options = {}) {
  const {
    maxDevices = 10,
    maxDecoys = 50,
    maxContacts = 500,
    epochDuration = 3600,
    rekeyThreshold = 0.66,
  } = options;

  console.info('[Secure] Système Secure initialisé (v' + VERSION + ')');

  return {
    version: VERSION,
    deviceKeyManager: null,
    decoyCircuitManager: null,
    canvasBlocker: null,
    antiDebug: new (await import('./defense/anti_debug.js')).default(),
    contactManager: null,
    messagingManager: null,
    epochManager: new (await import('./blockchain/epoch.js')).default(epochDuration, rekeyThreshold),
    broadcastSession: null,
  };
}

// Export par défaut pour import facile
export default {
  VERSION,
  AUTHOR,
  createSecureSystem,
};