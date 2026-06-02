// packages/secure/src/secure.js
// =====================================================
// SkyAInet Secure Package — Point d'entrée central
// 38 modules — Crypto, Contacts, Defense, Device,
// Protocol, Roots, Suites, Transport, Utils, Blockchain
// SkyAInet × Nikola T369
// =====================================================

"use strict";

// ─────────────────────────────────────────────────────────────────
// CRYPTO
// ─────────────────────────────────────────────────────────────────

export { RomanT369, GematriaMode, ROMAN_T369_ALPHABET }   from './crypto/roman_t369.js';
export { GematriaAead, GematriaAeadError }                from './crypto/gematria_aead.js';
export { KemT369, KemError }                              from './crypto/kem_t369.js';
export { Dilithium5KeyPair, Dilithium5Signer, DilithiumError } from './crypto/dilithium.js';
export { HybridTransport, HybridMode }                    from './crypto/hybrid.js';
export { DoubleRatchet, DoubleRatchetError }              from './crypto/double_ratchet.js';
export {
  hkdfSha256, hkdfSha256Unchecked,
  hmacSha256, constantTimeEq as constantTimeEqSha,
  deriveGematriaAeadKeys, deriveAesKey,
  Sha256Hasher,
}                                                         from './crypto/sha_fips.js';
export { Aes256GcmFips, AesError }                        from './crypto/aes_fips.js';
export {
  constantTimeEq, select, addMod, subMod, sampleUniformMod,
}                                                         from './crypto/constant_time.js';
export { MarkovSteganography }                            from './crypto/steganography.js';

// ─────────────────────────────────────────────────────────────────
// CONTACTS
// ─────────────────────────────────────────────────────────────────

export { Contact, ContactError }                          from './contacts/contact.js';
export { ContactManager }                                 from './contacts/manager.js';
export { MessagingManager, MessagingError, Message, MessageType, Conversation } from './contacts/messaging.js';
export {
  ContactVerification, GroupVerification,
  VerificationGroup, VerificationLevel,
  VerificationError,
}                                                         from './contacts/verification.js';

// ─────────────────────────────────────────────────────────────────
// ROOTS
// ─────────────────────────────────────────────────────────────────

export { PeerPool, PeerPoolError, PeerInfo, PeerReputation, ReputationTier } from './roots/pool.js';
export { Did, DidRegistry, DidError, ServiceEndpoint, ServiceType }          from './roots/did.js';
export { NodeAttestation, AttestationManager, AttestationError }             from './roots/attestation.js';
export { CircuitBuilder, Circuit, CircuitBuilderError }                      from './roots/builder.js';
export { EpochRekeyManager, RekeyError, createManager as createRekeyManager, Channel } from './roots/epoch_rekey.js';

// ─────────────────────────────────────────────────────────────────
// PROTOCOL
// ─────────────────────────────────────────────────────────────────

export { Handshake, HandshakeMessage, HandshakeError, NodeRole as HandshakeNodeRole, CryptoSuite } from './protocol/handshake.js';
export { Session, SessionError }                          from './protocol/session.js';

// ─────────────────────────────────────────────────────────────────
// SUITES
// ─────────────────────────────────────────────────────────────────

export { PostQuantumSuite, PostQuantumError }             from './suites/post_quantum.js';
export { GematriaSuite, GematriaError }                   from './suites/gematria.js';

// ─────────────────────────────────────────────────────────────────
// TRANSPORT
// ─────────────────────────────────────────────────────────────────

export { Libp2pTransportReal }                            from './transport/libp2p.js';
export {
  Transport, HybridTransportTrait,
  TransportLayer, CryptoSuite as TransportCryptoSuite,
  TransportMessage, TransportError,
}                                                         from './transport/trait.js';

// ─────────────────────────────────────────────────────────────────
// DEVICE
// ─────────────────────────────────────────────────────────────────

export { DeviceKeyManager, DeviceKey, DeviceStatus, DeviceKeyError } from './device/device_key.js';
export { MediaEncryptor, MediaFrame }                     from './device/encryptor.js';
export { GroupManager, Group as SenderKeyGroup, GroupError } from './device/sender_keys.js';
export {
  RedTeamClassifier, CoverageMetrics, StealthProfile,
  defaultRedTeamClassifier,
}                                                         from './device/red_team.js';

// ─────────────────────────────────────────────────────────────────
// DEFENSE
// ─────────────────────────────────────────────────────────────────

export { DecoyCircuitManager, DecoyCircuit }              from './defense/decoy_circuits.js';
export { CanvasBlocker, CanvasProtectionLevel }           from './defense/canvas_blocker.js';
export { AntiDebug }                                      from './defense/anti_debug.js';

// ─────────────────────────────────────────────────────────────────
// BLOCKCHAIN
// ─────────────────────────────────────────────────────────────────

export { EpochManager, EpochStatus, EpochError }          from './blockchain/epoch.js';
export { BroadcastSession, SessionStatus, BroadcastError } from './blockchain/broadcast.js';

// ─────────────────────────────────────────────────────────────────
// UTILS
// ─────────────────────────────────────────────────────────────────

export {
  nowTimestamp, nowMs, elapsedSince, elapsedMsSince,
  formatTimestamp, formatDuration,
  isFresh, isExpired, expiresAt,
  logTimestamp,
}                                                         from './utils/time.js';
export {
  createReproducibleRng, deterministicHash,
  deterministicHashStr, generateDeterministicBytes, seedFromData,
}                                                         from './utils/reproducible.js';
export { MarkovChain, MarkovError }                       from './utils/markov.js';

// ─────────────────────────────────────────────────────────────────
// VERSION
// ─────────────────────────────────────────────────────────────────

export const VERSION = '1.0.0';

export const SECURE_PACKAGE_INFO = Object.freeze({
  name       : 'skyainet-secure',
  version    : VERSION,
  description: 'SkyAInet Secure Package — Post-Quantum Cryptography, Contacts, Defense',
  modules    : {
    crypto    : ['RomanT369', 'GematriaAead', 'KemT369', 'Dilithium5Signer', 'HybridTransport', 'DoubleRatchet', 'Aes256GcmFips'],
    contacts  : ['Contact', 'ContactManager', 'MessagingManager', 'ContactVerification', 'GroupVerification'],
    roots     : ['PeerPool', 'Did', 'NodeAttestation', 'CircuitBuilder', 'EpochRekeyManager'],
    protocol  : ['Handshake', 'Session'],
    suites    : ['PostQuantumSuite', 'GematriaSuite'],
    transport : ['Libp2pTransportReal', 'HybridTransportTrait'],
    device    : ['DeviceKeyManager', 'MediaEncryptor', 'GroupManager', 'RedTeamClassifier'],
    defense   : ['DecoyCircuitManager', 'CanvasBlocker', 'AntiDebug'],
    blockchain: ['EpochManager', 'BroadcastSession'],
    utils     : ['MarkovChain', 'createReproducibleRng', 'nowTimestamp'],
  },
});
