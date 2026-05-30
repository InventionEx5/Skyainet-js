// packages/secure/src/index.js
// =====================================================
// @skyainet/secure — Point d'entrée principal
// SkyAInet × Nikola T369
// Version 6.0 — Production Ready
// =====================================================

// ============================================
// 1. IMPORTS DES MODULES EXISTANTS (fournis)
// ============================================

// Crypto
export {
  Dilithium5Signer,
  Dilithium5KeyPair,
  DilithiumError,
} from './crypto/dilithium.js';

export {
  RomanT369,
  RomanT369Error,
} from './crypto/roman_t369.js';

export {
  KemT369,
  KemT369Error,
} from './crypto/kem_t369.js';

export {
  HybridEncryption,
  HybridError,
} from './crypto/hybrid.js';

export {
  DoubleRatchet,
  DoubleRatchetError,
} from './crypto/double_ratchet.js';

export {
  GematriaAead,
  GematriaAeadError,
} from './crypto/gematria_aead.js';

export {
  AesFips,
  AesFipsError,
} from './crypto/aes_fips.js';

export {
  ShaFips,
  ShaFipsError,
} from './crypto/sha_fips.js';

export {
  ConstantTime,
  ConstantTimeError,
} from './crypto/constant_time.js';

export {
  Steganography,
  SteganographyError,
} from './crypto/steganography.js';

// Protocol
export {
  Handshake,
  HandshakeError,
} from './protocol/handshake.js';

export {
  Session,
  SessionError,
} from './protocol/session.js';

// Transport
export {
  TransportTrait,
  TransportError,
} from './transport/trait.js';

export {
  Libp2pTransport,
  Libp2pTransportError,
} from './transport/libp2p_transport.js';

// Suites
export {
  GematriaSuite,
  GematriaSuiteError,
} from './suites/gematria.js';

export {
  PostQuantumSuite,
  PostQuantumSuiteError,
} from './suites/post_quantum.js';

// Roots
export {
  CircuitBuilder,
  CircuitBuilderError,
} from './roots/circuit/builder.js';

export {
  EpochRekey,
  EpochRekeyError,
} from './roots/circuit/epoch_rekey.js';

export {
  Pool,
  PoolError,
} from './roots/pool.js';

export {
  Reputation,
  ReputationError,
} from './roots/reputation.js';

export {
  Attestation,
  AttestationError,
} from './roots/attestation.js';

// Identity
export {
  Did,
  DidError,
} from './identity/did.js';

// Defense
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

export {
  PhysicalAccessProtection,
  PhysicalAccessError,
} from './defense/pa/index.js';

export {
  Deception,
  DeceptionError,
} from './defense/deception/index.js';

export {
  AntiExploit,
  AntiExploitError,
} from './defense/ae/index.js';

// Blockchain
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

// Device
export {
  DeviceKeyManager,
  DeviceKey,
  DeviceStatus,
  DeviceKeyError,
} from './device/device_key.js';

// Group
export {
  GroupManager,
  GroupError,
} from './group/index.js';

export {
  SenderKeys,
  SenderKeysError,
} from './group/sender_keys.js';

// Media
export {
  MediaEncryptor,
  MediaEncryptorError,
} from './media/encryptor.js';

// Metrics
export {
  RedTeam,
  RedTeamError,
} from './metrics/red_team.js';

// Contacts
export {
  Contact,
  createDefaultContact,
} from './contacts/contact.js';

export {
  ContactManager,
  ContactManagerError,
  Did as ContactDid,
} from './contacts/manager.js';

export {
  ContactVerification,
  GroupVerification,
  Group,
  VerificationError,
  VerificationLevel,
} from './contacts/verification.js';

// Messaging
export {
  MessagingManager,
  MessagingError,
  Message,
  Conversation,
  MessageType,
} from './messaging.js';

// Utils
export {
  Compression,
  CompressionError,
} from './utils/compression.js';

export {
  MarkovGenerator,
  MarkovError,
} from './utils/markov.js';

export {
  TimeUtils,
  TimeUtilsError,
} from './utils/time.js';

export {
  Reproducible,
  ReproducibleError,
} from './utils/reproducible.js';

// ============================================
// 2. UTILITAIRES
// ============================================
export const VERSION = '6.0.0';
export const AUTHOR = 'SkyAInet × Nikola T369';

export default {
  VERSION,
  AUTHOR,
};