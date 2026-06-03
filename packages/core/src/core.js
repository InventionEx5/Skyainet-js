// packages/core/src/core.js
// =====================================================
// Core Package — Point d'entrée central
// Rewards, Economics, Constitution, Alignment, NodeTypes
// SkyAInet × Nikola T369
// =====================================================

"use strict";

// ─────────────────────────────────────────────────────────────────
// RÉCOMPENSES
// ─────────────────────────────────────────────────────────────────

export {
  UserRewards,
  AccountType,
  RewardReason,
}                                           from './rewards.js';

// ─────────────────────────────────────────────────────────────────
// ÉCONOMIE DES NŒUDS
// ─────────────────────────────────────────────────────────────────

export {
  NodeEconomics,
  Subscription,
  NodeTier,
  GatewayPlan,
  ApiKeysPlan,
  StoragePlan,
}                                           from './economics.js';

// ─────────────────────────────────────────────────────────────────
// CONSTITUTION PAEVF
// ─────────────────────────────────────────────────────────────────

export {
  Constitution,
  ConstitutionalRule,
  ComplianceLevel,
  RuleCategory,
  ConstitutionError,
}                                           from './constitution.js';

// ─────────────────────────────────────────────────────────────────
// ALIGNMENT KERNEL PAEVF
// ─────────────────────────────────────────────────────────────────

export {
  AlignmentKernel,
  EthicalScore,
  AlignmentError,
}                                           from './alignment_kernel.js';

// ─────────────────────────────────────────────────────────────────
// VERSION
// ─────────────────────────────────────────────────────────────────

export const VERSION = '1.0.0';

export const PACKAGE_INFO = Object.freeze({
  name       : 'skyainet-core',
  version    : VERSION,
  description: 'SkyAInet Core — Rewards, Economics, Constitution PAEVF, Alignment Kernel',
  modules    : [
    'UserRewards', 'AccountType', 'RewardReason',
    'NodeEconomics', 'Subscription',
    'Constitution', 'ConstitutionalRule',
    'AlignmentKernel', 'EthicalScore',
  ],
});