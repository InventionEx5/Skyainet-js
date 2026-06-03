// packages/governance/src/conviction_voting.js
// =====================================================
// Conviction Voting — Vote par Conviction Temporelle
// Plus tu maintiens ton vote, plus il pèse
// Port de conviction_voting.rs — SkyAInet × Nikola T369
// =====================================================

"use strict";

// ─────────────────────────────────────────────────────────────────
// ERREUR TYPÉE
// ─────────────────────────────────────────────────────────────────

export class ConvictionError extends Error {
  constructor(message, code = 'CONVICTION_ERROR') {
    super(message);
    this.name = 'ConvictionError';
    this.code = code;
  }
  static notFound()      { return new ConvictionError('Vote introuvable',           'VOTE_NOT_FOUND'); }
  static votingEnded()   { return new ConvictionError('Période de vote terminée',   'VOTING_ENDED'); }
  static alreadyLocked() { return new ConvictionError('Conviction déjà verrouillée','ALREADY_LOCKED'); }
  static invalidPower()  { return new ConvictionError('Poids de vote invalide (≥1)','INVALID_POWER'); }
}

// ─────────────────────────────────────────────────────────────────
// CONVICTION VOTE — unité de vote
// ─────────────────────────────────────────────────────────────────

export class ConvictionVote {
  constructor({ voter, proposalId, baseWeight, inFavor }) {
    this.voter                = voter;         // hex string
    this.proposalId           = proposalId;
    this.baseWeight           = BigInt(baseWeight);
    this.startTime            = Date.now();
    this.convictionMultiplier = 1.0;
    this.finalWeight          = this.baseWeight;
    this.isLocked             = true;
    this.direction            = inFavor;       // true = POUR, false = CONTRE
  }

  toJSON() {
    return {
      voter                : this.voter,
      proposalId           : this.proposalId,
      baseWeight           : this.baseWeight.toString(),
      startTime            : this.startTime,
      convictionMultiplier : +this.convictionMultiplier.toFixed(4),
      finalWeight          : this.finalWeight.toString(),
      isLocked             : this.isLocked,
      direction            : this.direction,
    };
  }
}

// ─────────────────────────────────────────────────────────────────
// CONVICTION VOTING
//
// Mécanisme : le poids d'un vote croît avec le temps passé à
// maintenir sa position — récompense la conviction et décourage
// les retournements de dernière minute.
//
// Formule :
//   multiplier = 1 + (elapsed/period) × (maxMultiplier - 1)
//   finalWeight = baseWeight × multiplier
//
//   elapsed = Date.now() - vote.startTime
//   period  = convictionPeriodMs (défaut 7 jours)
//   max     = maxMultiplier (défaut 4.0 → jusqu'à 4×)
//
// Chaque combinaison (proposalId, voter) est unique — un voter
// ne peut voter qu'une fois par proposition.
//
// releaseVote() libère le vote (avant la fin de la période).
// ─────────────────────────────────────────────────────────────────

export class ConvictionVoting {
  #votes;   // Map<"proposalId:voter", ConvictionVote>

  /**
   * @param {object} [opts]
   * @param {number} opts.convictionPeriodDays — durée pour atteindre le max (défaut 7)
   * @param {number} opts.maxMultiplier        — multiplicateur maximum (défaut 4.0)
   */
  constructor(opts = {}) {
    this.#votes             = new Map();
    this.convictionPeriodMs = (opts.convictionPeriodDays ?? 7) * 86_400_000;
    this.maxMultiplier      = opts.maxMultiplier ?? 4.0;
  }

  // ─── Vote ─────────────────────────────────────────────────────

  /**
   * Enregistre un vote avec conviction.
   * Verrouille immédiatement — le poids augmente avec le temps.
   *
   * @param {number}  proposalId
   * @param {string}  voter        — identifiant hex du votant
   * @param {number}  baseWeight   — poids de base (≥ 1)
   * @param {boolean} inFavor
   */
  castVote(proposalId, voter, baseWeight, inFavor) {
    if (!baseWeight || baseWeight < 1) throw ConvictionError.invalidPower();

    const key = `${proposalId}:${voter}`;
    if (this.#votes.has(key))          throw ConvictionError.alreadyLocked();

    const vote = new ConvictionVote({ voter, proposalId, baseWeight, inFavor });
    this.#votes.set(key, vote);

    console.info(
      `[Conviction] Vote proposition ${proposalId} | ${voter.slice(0,12)}… | ` +
      `base: ${baseWeight} | ${inFavor ? 'POUR' : 'CONTRE'}`
    );
  }

  // ─── Calcul du poids ──────────────────────────────────────────

  /**
   * Calcule le poids actuel de conviction d'un vote.
   *
   * multiplier = 1 + min(elapsed/period, 1) × (maxMultiplier - 1)
   *
   * @param {number} proposalId
   * @param {string} voter
   * @returns {bigint} poids actuel
   */
  calculateCurrentWeight(proposalId, voter) {
    const key  = `${proposalId}:${voter}`;
    const vote = this.#votes.get(key);
    if (!vote) throw ConvictionError.notFound();

    const elapsed    = Date.now() - vote.startTime;
    const timeRatio  = Math.min(elapsed / this.convictionPeriodMs, 1.0);
    const multiplier = 1 + timeRatio * (this.maxMultiplier - 1);

    return BigInt(Math.floor(Number(vote.baseWeight) * multiplier));
  }

  /**
   * Met à jour les multiplicateurs de tous les votes d'une proposition.
   * Appeler régulièrement (ex. avant de lire les totaux).
   *
   * @param {number} proposalId
   */
  updateAllWeights(proposalId) {
    for (const vote of this.#votes.values()) {
      if (vote.proposalId !== proposalId) continue;

      const elapsed    = Date.now() - vote.startTime;
      const timeRatio  = Math.min(elapsed / this.convictionPeriodMs, 1.0);
      vote.convictionMultiplier = 1 + timeRatio * (this.maxMultiplier - 1);
      vote.finalWeight = BigInt(Math.floor(Number(vote.baseWeight) * vote.convictionMultiplier));
    }
  }

  // ─── Agrégation ───────────────────────────────────────────────

  /**
   * Retourne les poids totaux (POUR / CONTRE) d'une proposition
   * après mise à jour des multiplicateurs.
   *
   * @param {number} proposalId
   * @returns {{ forWeight: bigint, againstWeight: bigint, voterCount: number }}
   */
  getProposalWeights(proposalId) {
    this.updateAllWeights(proposalId);

    let forWeight     = 0n;
    let againstWeight = 0n;
    let voterCount    = 0;

    for (const vote of this.#votes.values()) {
      if (vote.proposalId !== proposalId) continue;
      if (vote.direction) forWeight     += vote.finalWeight;
      else                againstWeight += vote.finalWeight;
      voterCount++;
    }

    return { forWeight, againstWeight, voterCount };
  }

  /**
   * Taux d'approbation pondéré par conviction [0, 1].
   */
  getApprovalRate(proposalId) {
    const { forWeight, againstWeight } = this.getProposalWeights(proposalId);
    const total = forWeight + againstWeight;
    return total > 0n ? Number(forWeight) / Number(total) : 0;
  }

  // ─── Gestion des votes ────────────────────────────────────────

  /**
   * Libère un vote (retrait avant la fin de la période).
   * Le poids accumulé est perdu — décourage les retraits tardifs.
   */
  releaseVote(proposalId, voter) {
    const key = `${proposalId}:${voter}`;
    if (!this.#votes.delete(key)) throw ConvictionError.notFound();
    console.debug(`[Conviction] Vote libéré — proposition ${proposalId} | ${voter.slice(0,12)}…`);
  }

  getVote(proposalId, voter) {
    return this.#votes.get(`${proposalId}:${voter}`) ?? null;
  }

  getMultiplier(proposalId, voter) {
    const vote = this.getVote(proposalId, voter);
    if (!vote) throw ConvictionError.notFound();
    return vote.convictionMultiplier;
  }

  // ─── Stats ────────────────────────────────────────────────────

  stats() {
    const votes      = [...this.#votes.values()];
    const now        = Date.now();
    const avgAge     = votes.length > 0
      ? votes.reduce((s, v) => s + (now - v.startTime), 0) / votes.length / 86_400_000
      : 0;
    const avgMult    = votes.length > 0
      ? votes.reduce((s, v) => s + v.convictionMultiplier, 0) / votes.length
      : 0;

    return {
      totalVotes          : votes.length,
      convictionPeriodDays: this.convictionPeriodMs / 86_400_000,
      maxMultiplier       : this.maxMultiplier,
      avgVoteAgeDays      : +avgAge.toFixed(2),
      avgMultiplier       : +avgMult.toFixed(4),
    };
  }
}
