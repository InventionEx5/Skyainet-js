// packages/governance/src/dao.js
// =====================================================
// DAO — Gouvernance Décentralisée Autonome
// Propositions, Votes pondérés, Quorum dynamique, Exécution sécurisée
// Port de dao.rs — SkyAInet × Nikola T369
// =====================================================

"use strict";

import { randomBytes } from 'crypto';

// ─────────────────────────────────────────────────────────────────
// ERREUR TYPÉE
// ─────────────────────────────────────────────────────────────────

export class DaoError extends Error {
  constructor(message, code = 'DAO_ERROR') {
    super(message);
    this.name = 'DaoError';
    this.code = code;
  }
  static notFound(id)         { return new DaoError(`Proposition introuvable : ${id}`,    'PROPOSAL_NOT_FOUND'); }
  static votingEnded()        { return new DaoError('Période de vote terminée',            'VOTING_ENDED'); }
  static alreadyExecuted()    { return new DaoError('Proposition déjà exécutée',           'ALREADY_EXECUTED'); }
  static insufficientQuorum() { return new DaoError('Quorum insuffisant',                  'INSUFFICIENT_QUORUM'); }
  static rejected()           { return new DaoError('Proposition rejetée par le vote',     'PROPOSAL_REJECTED'); }
  static invalidReputation()  { return new DaoError('Réputation invalide',                 'INVALID_REPUTATION'); }
}

// ─────────────────────────────────────────────────────────────────
// STATUTS & TYPES
// ─────────────────────────────────────────────────────────────────

export const ProposalStatus = Object.freeze({
  Active   : 'Active',
  Passed   : 'Passed',
  Rejected : 'Rejected',
  Executed : 'Executed',
  Cancelled: 'Cancelled',
});

export const ProposalCategory = Object.freeze({
  Governance: 'governance',
  Treasury  : 'treasury',
  Protocol  : 'protocol',
  Evolution : 'evolution',
  Security  : 'security',
});

// ─────────────────────────────────────────────────────────────────
// PROPOSAL
// ─────────────────────────────────────────────────────────────────

export class Proposal {
  constructor({
    id, title, description, proposer,
    durationDays = 7, category = ProposalCategory.Governance,
    quorum = 250, threshold = 0.62,
  }) {
    const now         = Date.now();
    this.id           = id;
    this.title        = title;
    this.description  = description;
    this.proposer     = proposer;         // hex string ou Uint8Array(32)
    this.votesFor     = 0n;              // BigInt — précision entière pour les poids
    this.votesAgainst = 0n;
    this.startTime    = now;
    this.endTime      = now + durationDays * 86_400_000;
    this.executed     = false;
    this.status       = ProposalStatus.Active;
    this.quorum       = BigInt(quorum);
    this.threshold    = Math.max(0, Math.min(1, threshold));
    this.category     = category;
    this.voters       = new Set();        // anti-double-vote
  }

  isActive()  { return this.status === ProposalStatus.Active && Date.now() < this.endTime; }
  isExpired() { return Date.now() >= this.endTime; }

  get totalVotes()    { return this.votesFor + this.votesAgainst; }
  get approvalRate()  {
    const total = this.totalVotes;
    return total > 0n ? Number(this.votesFor) / Number(total) : 0;
  }

  toJSON() {
    return {
      id           : this.id,
      title        : this.title,
      description  : this.description,
      proposer     : typeof this.proposer === 'string' ? this.proposer : _hex(this.proposer),
      votesFor     : this.votesFor.toString(),
      votesAgainst : this.votesAgainst.toString(),
      startTime    : this.startTime,
      endTime      : this.endTime,
      executed     : this.executed,
      status       : this.status,
      quorum       : this.quorum.toString(),
      threshold    : this.threshold,
      category     : this.category,
      approvalRate : +this.approvalRate.toFixed(4),
      voterCount   : this.voters.size,
    };
  }
}

// ─────────────────────────────────────────────────────────────────
// DAO
//
// Cycle de vie d'une proposition :
//   createProposal() → Active
//   vote() × N       → comptage pondéré (BigInt)
//   canExecute()     → vérifie quorum + seuil d'approbation
//   executeProposal()→ Executed + récompense proposeur
//   finalizeExpired()→ Passed/Rejected selon le résultat
//
// Vote pondéré :
//   votingPower = f(réputation, PoSI, tokens)
//   Anti-double-vote : Set<voterHex> par proposition
//
// Quorum dynamique :
//   Le quorum par défaut (250) peut être overridé par proposition.
//   canExecute() attend la fin de la période de vote.
// ─────────────────────────────────────────────────────────────────

export class Dao {
  #proposals;       // Map<id, Proposal>
  #nextId;

  constructor(opts = {}) {
    this.#proposals       = new Map();
    this.#nextId          = 1;
    this.defaultQuorum    = opts.defaultQuorum    ?? 250;
    this.defaultThreshold = opts.defaultThreshold ?? 0.62;
    this.defaultDuration  = opts.defaultDuration  ?? 7;   // jours
  }

  // ─── Création ────────────────────────────────────────────────

  /**
   * Crée une nouvelle proposition.
   * @returns {number} id de la proposition
   */
  createProposal({ title, description, proposer, durationDays, category, quorum, threshold }) {
    if (!title?.trim())       throw new DaoError('Titre requis',       'INVALID_TITLE');
    if (!description?.trim()) throw new DaoError('Description requise','INVALID_DESC');

    const id = this.#nextId++;
    const p  = new Proposal({
      id, title, description, proposer,
      durationDays: durationDays ?? this.defaultDuration,
      category    : category     ?? ProposalCategory.Governance,
      quorum      : quorum       ?? this.defaultQuorum,
      threshold   : threshold    ?? this.defaultThreshold,
    });

    this.#proposals.set(id, p);
    console.info(`[DAO] Proposition créée : "${title}" (ID: ${id})`);
    return id;
  }

  // ─── Vote ─────────────────────────────────────────────────────

  /**
   * Enregistre un vote pondéré.
   *
   * @param {number}          proposalId
   * @param {string|Uint8Array} voter       — identifiant unique du votant
   * @param {boolean}         inFavor
   * @param {number|bigint}   votingPower   — poids du vote (réputation × PoSI × tokens)
   */
  vote(proposalId, voter, inFavor, votingPower = 1) {
    const p      = this.#getOrThrow(proposalId);
    const voterHex = typeof voter === 'string' ? voter : _hex(voter);

    if (!p.isActive())           throw DaoError.votingEnded();
    if (p.executed)              throw DaoError.alreadyExecuted();
    if (p.voters.has(voterHex)) throw new DaoError('Voter a déjà voté', 'ALREADY_VOTED');

    const power = BigInt(Math.max(1, Math.floor(Number(votingPower))));
    if (inFavor) p.votesFor     += power;
    else         p.votesAgainst += power;

    p.voters.add(voterHex);

    console.debug(
      `[DAO] Vote proposition ${proposalId} | ${voterHex.slice(0,12)}… | power: ${power} | ${inFavor ? 'POUR' : 'CONTRE'}`
    );
  }

  // ─── Exécution ────────────────────────────────────────────────

  /**
   * Vérifie si une proposition peut être exécutée.
   * @returns {boolean}
   */
  canExecute(proposalId) {
    const p = this.#getOrThrow(proposalId);
    if (!p.isExpired())              throw new DaoError('Période de vote en cours', 'VOTING_ACTIVE');
    if (p.executed)                  throw DaoError.alreadyExecuted();
    if (p.totalVotes < p.quorum)     throw DaoError.insufficientQuorum();
    if (p.approvalRate < p.threshold)throw DaoError.rejected();
    return true;
  }

  /**
   * Exécute une proposition validée.
   * Distribue une récompense SKY au proposeur via UserRewards.
   *
   * @param {number}      proposalId
   * @param {object}      [node]     — SkyNode pour exécution on-chain
   * @param {UserRewards} [rewards]
   */
  async executeProposal(proposalId, node = null, rewards = null) {
    if (!this.canExecute(proposalId)) return;

    const p    = this.#getOrThrow(proposalId);
    p.executed = true;
    p.status   = ProposalStatus.Executed;

    // Récompense du proposeur
    if (rewards && typeof rewards.totalSkyEarned === 'number') {
      rewards.totalSkyEarned += 120;
    }

    // Propagation au nœud si disponible
    if (node && typeof node.syncWithNetwork === 'function') {
      await node.syncWithNetwork().catch(e =>
        console.warn(`[DAO] syncWithNetwork échoué : ${e.message}`)
      );
    }

    console.info(
      `[DAO] Proposition ${proposalId} exécutée — ` +
      `${p.votesFor} POUR / ${p.votesAgainst} CONTRE (${(p.approvalRate * 100).toFixed(1)}%)`
    );
  }

  /**
   * Finalise les propositions expirées non encore exécutées.
   * Met à jour leur statut (Passed/Rejected) selon le résultat.
   * @returns {number} nombre de propositions finalisées
   */
  finalizeExpired() {
    let count = 0;
    for (const p of this.#proposals.values()) {
      if (p.status !== ProposalStatus.Active || !p.isExpired()) continue;

      const hasQuorum = p.totalVotes >= p.quorum;
      const hasMajority = p.approvalRate >= p.threshold;

      p.status = hasQuorum && hasMajority
        ? ProposalStatus.Passed
        : ProposalStatus.Rejected;
      count++;

      console.info(`[DAO] Proposition ${p.id} finalisée → ${p.status}`);
    }
    return count;
  }

  // ─── Lecture ─────────────────────────────────────────────────

  getProposal(id)     { return this.#proposals.get(id) ?? null; }
  getAllProposals()    { return [...this.#proposals.values()]; }
  getActiveProposals(){ return [...this.#proposals.values()].filter(p => p.isActive()); }

  stats() {
    const all      = [...this.#proposals.values()];
    const active   = all.filter(p => p.isActive()).length;
    const executed = all.filter(p => p.executed).length;
    const passed   = all.filter(p => p.status === ProposalStatus.Passed).length;
    const rejected = all.filter(p => p.status === ProposalStatus.Rejected).length;
    return { total: all.length, active, executed, passed, rejected };
  }

  // ─── Privés ───────────────────────────────────────────────────

  #getOrThrow(id) {
    const p = this.#proposals.get(id);
    if (!p) throw DaoError.notFound(id);
    return p;
  }
}

// ─────────────────────────────────────────────────────────────────
// HELPER
// ─────────────────────────────────────────────────────────────────

function _hex(arr) {
  if (typeof arr === 'string') return arr;
  return Array.from(arr).map(b => b.toString(16).padStart(2,'0')).join('');
}
