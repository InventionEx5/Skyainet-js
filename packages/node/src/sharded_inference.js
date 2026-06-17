// packages/node/src/sharded_inference.js
// =====================================================
// ShardedInference — Inférence distribuée souveraine (Fusion L6)
//
// Mesh souverain façon Petals : le modèle (N couches) est partitionné en
// tranches contiguës réparties sur les nœuds du réseau. Une requête
// d'inférence traverse une chaîne de nœuds couvrant toutes les couches,
// chaque nœud exécutant sa tranche puis passant l'activation au suivant.
//
// Trois piliers :
//   1. Sharding         — assignShards() partitionne les couches (pondéré capacité)
//   2. Routage souverain — buildRoute() choisit les nœuds pondérés par réputation
//   3. Consensus utile   — PoUW (travail utile crédité) + PoSI (stake × inférence)
//
// Zéro dépendance — pur JS, testable en isolation avec des nœuds factices.
//
// SkyAInet × Thevie × Nikola T369
// =====================================================

"use strict";

const EPS = 1e-9;

// ─────────────────────────────────────────────────────────────────
// SHARD PLAN — résultat d'un partitionnement
// ─────────────────────────────────────────────────────────────────

export class ShardPlan {
  /**
   * @param {number} numLayers
   * @param {{nodeId, start, end, replica}[]} assignments — tranches [start, end)
   */
  constructor(numLayers, assignments) {
    this.numLayers   = numLayers;
    this.assignments = assignments;
  }

  /** Les nœuds (assignations) couvrant une couche donnée. */
  nodesFor(layer) {
    return this.assignments.filter(a => layer >= a.start && layer < a.end);
  }

  /** true si la réplique 0 couvre l'intégralité [0, numLayers). */
  covers() {
    const seen = new Uint8Array(this.numLayers);
    for (const a of this.assignments) {
      if (a.replica !== 0) continue;
      for (let l = a.start; l < a.end; l++) seen[l] = 1;
    }
    for (let l = 0; l < this.numLayers; l++) if (!seen[l]) return false;
    return true;
  }

  /** Nombre de répliques distinctes. */
  get replicas() {
    return new Set(this.assignments.map(a => a.replica)).size;
  }
}

// ─────────────────────────────────────────────────────────────────
// MESH INFERENCE ROUTER
// ─────────────────────────────────────────────────────────────────

export class MeshInferenceRouter {
  #numLayers;
  #nodes;        // Map<nodeId, { reputation, stake, capacity, online }>
  #work;         // Map<nodeId, number> — couches·inférences servies (PoUW)

  /**
   * @param {number} numLayers — nombre de couches du modèle
   */
  constructor(numLayers) {
    if (!(numLayers > 0)) throw new Error('numLayers doit être > 0');
    this.#numLayers = numLayers;
    this.#nodes     = new Map();
    this.#work      = new Map();
  }

  // ─── Registre des nœuds ───────────────────────────────────────

  registerNode(nodeId, { reputation = 0.5, stake = 0, capacity = 1, online = true } = {}) {
    this.#nodes.set(nodeId, {
      reputation: _clamp01(reputation),
      stake     : Math.max(0, stake),
      capacity  : Math.max(0.01, capacity),
      online    : !!online,
    });
    if (!this.#work.has(nodeId)) this.#work.set(nodeId, 0);
    return nodeId;
  }

  setOnline(nodeId, online) {
    const n = this.#nodes.get(nodeId); if (n) n.online = !!online;
  }

  // ─── 1. Sharding ──────────────────────────────────────────────

  /**
   * Partitionne les couches en tranches contiguës réparties sur les nœuds en
   * ligne, proportionnellement à leur capacité. `redundancy` répliques pour la
   * tolérance aux pannes (chaque réplique part d'un nœud décalé).
   * @param {{redundancy?: number}} [opts]
   * @returns {ShardPlan}
   */
  assignShards({ redundancy = 1 } = {}) {
    const online = [...this.#nodes.entries()].filter(([, n]) => n.online);
    if (online.length === 0) throw new Error('Aucun nœud en ligne pour le sharding');

    const totalCap     = online.reduce((s, [, n]) => s + n.capacity, 0) || online.length;
    const reps         = Math.max(1, Math.min(redundancy, online.length));
    const assignments  = [];

    for (let r = 0; r < reps; r++) {
      // Rotation des nœuds par réplique → diversité des chaînes
      const shift   = r % online.length;
      const ordered = online.slice(shift).concat(online.slice(0, shift));

      let layer = 0;
      for (let i = 0; i < ordered.length && layer < this.#numLayers; i++) {
        const [nodeId, n] = ordered[i];
        const isLast = (i === ordered.length - 1);
        const count  = isLast
          ? this.#numLayers - layer                                   // la dernière prend le reste
          : Math.max(1, Math.round((n.capacity / totalCap) * this.#numLayers));
        const start = layer;
        const end   = Math.min(this.#numLayers, layer + count);
        if (start < end) assignments.push({ nodeId, start, end, replica: r });
        layer = end;
      }
    }

    return new ShardPlan(this.#numLayers, assignments);
  }

  // ─── 2. Routage souverain (pondéré réputation) ───────────────

  /**
   * Construit une route : une chaîne de tranches contiguës couvrant toutes les
   * couches, chaque tranche confiée au meilleur nœud disponible (score
   * réputation × stake). Bascule automatiquement sur une réplique si un nœud
   * est hors ligne.
   * @param {ShardPlan} plan
   * @returns {{nodeId, start, end, score}[]}
   */
  buildRoute(plan) {
    const route = [];
    let layer = 0;
    let guard = 0;

    while (layer < this.#numLayers) {
      if (++guard > this.#numLayers + 1) throw new Error('Couverture incomplète du modèle');

      const candidates = plan.nodesFor(layer).filter(a => this.#nodes.get(a.nodeId)?.online);
      if (candidates.length === 0) throw new Error(`Aucun nœud en ligne pour la couche ${layer}`);

      // Meilleur nœud par score souverain
      let best = candidates[0];
      for (const c of candidates) if (this.#score(c.nodeId) > this.#score(best.nodeId)) best = c;

      // Avancer jusqu'à la fin de la tranche du nœud choisi (bornée à partir de `layer`)
      const end = Math.max(layer + 1, Math.min(best.end, this.#numLayers));
      route.push({ nodeId: best.nodeId, start: layer, end, score: +this.#score(best.nodeId).toFixed(4) });
      layer = end;
    }
    return route;
  }

  /**
   * Exécute un forward distribué : passe l'activation à travers la chaîne de
   * nœuds, chacun exécutant sa tranche via executeShard. Crédite le PoUW.
   * @param {*} input
   * @param {Function} executeShard — async (nodeId, {start,end}, activation) => activation
   * @param {{plan?: ShardPlan, redundancy?: number}} [opts]
   * @returns {Promise<{ output, hops, route }>}
   */
  async runDistributed(input, executeShard, opts = {}) {
    const plan  = opts.plan ?? this.assignShards({ redundancy: opts.redundancy ?? 1 });
    const route = this.buildRoute(plan);

    let activation = input;
    for (const hop of route) {
      activation = await executeShard(hop.nodeId, { start: hop.start, end: hop.end }, activation);
      this.recordWork(hop.nodeId, hop.end - hop.start);
    }
    return { output: activation, hops: route.length, route };
  }

  // ─── 3. Consensus utile : PoUW + PoSI ────────────────────────

  /** Proof of Useful Work — crédite les couches·inférences servies par un nœud. */
  recordWork(nodeId, layers) {
    this.#work.set(nodeId, (this.#work.get(nodeId) ?? 0) + Math.max(0, layers));
    return this.#work.get(nodeId);
  }

  /**
   * Proof of Stake & Inference — score de consensus combinant réputation,
   * stake et travail utile (normalisés sur le réseau).
   * @returns {number} [0, 1]
   */
  posiScore(nodeId) {
    const n = this.#nodes.get(nodeId);
    if (!n) return 0;
    const maxStake = Math.max(...[...this.#nodes.values()].map(x => x.stake), EPS);
    const maxWork  = Math.max(...[...this.#work.values()], EPS);
    const normStake = n.stake / maxStake;
    const normWork  = (this.#work.get(nodeId) ?? 0) / maxWork;
    return +(_clamp01(0.4 * n.reputation + 0.3 * normStake + 0.3 * normWork)).toFixed(4);
  }

  /** Met à jour la réputation d'un nœud (bornée [0,1]) après une inférence. */
  updateReputation(nodeId, delta) {
    const n = this.#nodes.get(nodeId);
    if (n) n.reputation = _clamp01(n.reputation + delta);
    return n?.reputation ?? 0;
  }

  // ─── Introspection ────────────────────────────────────────────

  reputationOf(nodeId) { return this.#nodes.get(nodeId)?.reputation ?? 0; }
  workOf(nodeId)       { return this.#work.get(nodeId) ?? 0; }

  /** Classement des nœuds par score PoSI (validateurs en tête). */
  leaderboard() {
    return [...this.#nodes.keys()]
      .map(id => ({ nodeId: id, posi: this.posiScore(id), reputation: this.reputationOf(id), work: this.workOf(id) }))
      .sort((a, b) => b.posi - a.posi);
  }

  stats() {
    const nodes  = [...this.#nodes.values()];
    const online = nodes.filter(n => n.online).length;
    return {
      numLayers   : this.#numLayers,
      nodes       : nodes.length,
      onlineNodes : online,
      totalStake  : nodes.reduce((s, n) => s + n.stake, 0),
      totalWork   : [...this.#work.values()].reduce((s, w) => s + w, 0),
    };
  }

  // ─── Privé ────────────────────────────────────────────────────

  /** Score souverain de sélection d'un nœud : réputation + bonus de stake. */
  #score(nodeId) {
    const n = this.#nodes.get(nodeId);
    if (!n || !n.online) return -1;
    return 0.6 * n.reputation + 0.4 * Math.tanh(n.stake / 100);
  }
}

export default MeshInferenceRouter;

// ─────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────

function _clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
