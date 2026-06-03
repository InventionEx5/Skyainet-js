// packages/node/src/node.js
// =====================================================
// SkyAInet Node Package — Point d'entrée central
// Ré-exports de tous les modules du package node/
// SkyAInet × Nikola T369
// =====================================================

"use strict";

// ─────────────────────────────────────────────────────────────────
// NŒUD PRINCIPAL
// ─────────────────────────────────────────────────────────────────

export { SkyCloud as SkyNode, SkyCloud }                                from './skycloud.js';

// ─────────────────────────────────────────────────────────────────
// TYPES, ÉTATS & IDENTITÉ
// ─────────────────────────────────────────────────────────────────

export {
  NodeType,
  NodeRole,
  NodeState,
  SubscriptionLevel,
  ReputationTier,
  NodeCapabilities,
  NodeIdentity,
  Attestation,
  isPaidNodeType,
  monthlyPriceEur,
  computeMultiplier,
  isOperationalState,
  isPaidSubscription,
  reputationTierFromScore,
  defaultCapabilitiesForType,
  isEdgeNode,
  requiresPaidSubscription,
}                                                 from './node_types.js';

// ─────────────────────────────────────────────────────────────────
// COMMUNICATION & RÔLES MIXTES
// ─────────────────────────────────────────────────────────────────

export {
  NodeCommunication,
  MixedNode,
  NodeMessage,
  CommunicationStats,
  ContributionProof,    // ré-export de commodité (source : pouw.js)
  Topic,
}                                                 from './node_communication.js';

// ─────────────────────────────────────────────────────────────────
// PROOF OF USEFUL WORK
// ─────────────────────────────────────────────────────────────────

export {
  PoUWEngine,
  PoUWStats,
  DreamScoring,
}                                                 from './pouw.js';

// ─────────────────────────────────────────────────────────────────
// VALIDATION
// ─────────────────────────────────────────────────────────────────

export { ValidatorNode }                          from './validator.js';

// ─────────────────────────────────────────────────────────────────
// ÉVOLUTION
// ─────────────────────────────────────────────────────────────────

export { EvolutionManager }                       from './evolution_manager.js';

// ─────────────────────────────────────────────────────────────────
// MARKETPLACE COMPUTE
// ─────────────────────────────────────────────────────────────────

export {
  ComputeMarketplace,
  RentalOffer,
  ActiveRental,
  RentalStatus,
  MarketplaceError,
}                                                 from './marketplace.js';

export {
  GpuCpuMarketplaceService,
  HardwareAvailabilityChecker,
}                                                 from './gpu_cpu.js';

// ─────────────────────────────────────────────────────────────────
// SERVEUR HTTP
// server.js démarre le serveur à l'import (app.listen au niveau module).
// Ne pas ré-exporter ici pour éviter de déclencher le listen lors
// d'un simple import du package. Importer server.js directement :
//   import { app, server, wss, state } from './server.js';
// ─────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────
// VERSION
// ─────────────────────────────────────────────────────────────────

export const VERSION = '1.0.0';

export const PACKAGE_INFO = Object.freeze({
  name       : 'skyainet-node',
  version    : VERSION,
  description: 'SkyAInet Node Package — Nœud Souverain, PoUW, Marketplace, Évolution',
  modules    : [
    'SkyCloud',
    'NodeType', 'NodeState', 'NodeIdentity',
    'NodeCommunication', 'MixedNode',
    'PoUWEngine', 'DreamScoring',
    'ValidatorNode',
    'EvolutionManager',
    'ComputeMarketplace', 'GpuCpuMarketplaceService',
  ],
});