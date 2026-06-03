// packages/governance/src/governance.js
// =====================================================
// Governance — Point d'entrée du package governance/
// PoSI + DAO + Conviction Voting
// SkyAInet × Nikola T369
// =====================================================

"use strict";

// ─────────────────────────────────────────────────────────────────
// PoSI — Proof of Sovereign Indexing
// ─────────────────────────────────────────────────────────────────

export { PoSI, PoSIScore, PoSIError }                from './posi.js';

// ─────────────────────────────────────────────────────────────────
// DAO — Gouvernance Décentralisée Autonome
// ─────────────────────────────────────────────────────────────────

export {
  Dao, Proposal, DaoError,
  ProposalStatus, ProposalCategory,
}                                                     from './dao.js';

// ─────────────────────────────────────────────────────────────────
// CONVICTION VOTING — Vote par conviction temporelle
// ─────────────────────────────────────────────────────────────────

export { ConvictionVoting, ConvictionVote, ConvictionError } from './conviction_voting.js';

// ─────────────────────────────────────────────────────────────────
// VERSION
// ─────────────────────────────────────────────────────────────────

export const VERSION = '1.0.0';

export const PACKAGE_INFO = Object.freeze({
  name       : 'skyainet-governance',
  version    : VERSION,
  description: 'SkyAInet Governance — PoSI, DAO, Conviction Voting',
  modules    : ['PoSI', 'Dao', 'ConvictionVoting'],
});
