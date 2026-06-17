// packages/t369-inference/src/meshin.js
// =====================================================
// MeshIn — Neural Mesh Distribué (Hebbian + Neurogenèse + Synapse + Sémantique)
// Port de neural_mesh.rs — TypedArrays plats + VectorStore léger intégré
// SkyAInet × Nikola T369
// =====================================================

"use strict";

// ─────────────────────────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────────────────────────

const MAX_NEURONS        = 1024;
const PRUNE_THRESH       = 0.22;    // synapse.strength minimum (≈ neural_mesh.rs)
const PRUNE_USAGE_MIN    = 12;      // usage_count minimum pour survie malgré faiblesse
const PRUNE_IDLE_MS      = 60_000;
const SYNAPSE_STRENGTH_MIN = 0.12;
const SYNAPSE_STRENGTH_MAX = 1.00;
const AUTO_CONNECT_K     = 4;       // top-K connexions automatiques
const EMBED_DIM          = 128;     // dimension embeddings sémantiques
const HEBB_POSITIVE      = 0.12;    // renforcement Hebbian positif
const HEBB_NEGATIVE      = 0.18;    // affaiblissement Hebbian négatif
const DECAY_THRESHOLD_H  = 8.0;    // heures avant décroissance synaptique
const DECAY_MAX          = 0.28;

// ─────────────────────────────────────────────────────────────────
// NEURON — compatibilité API index.js
// ─────────────────────────────────────────────────────────────────

export class Neuron {
  constructor(id, initialWisdom = 0.5, personality = null) {
    this.id           = id;
    this.wisdom       = Math.max(0, Math.min(1, initialWisdom));
    this.activation   = 0.0;
    this.activityScore= 0;
    this.connections  = [];          // NeuronId[]
    this.lastUsed     = Date.now();
    this.personality  = personality ?? { wisdom: initialWisdom, cooperation: 0.7, curiosity: 0.5 };
  }
}

// ─────────────────────────────────────────────────────────────────
// SYNAPSE — structure port de synapse.rs
// ─────────────────────────────────────────────────────────────────

class Synapse {
  constructor(from, to, strength = 0.5) {
    this.from       = from;
    this.to         = to;
    this.strength   = Math.max(SYNAPSE_STRENGTH_MIN, Math.min(SYNAPSE_STRENGTH_MAX, strength));
    this.usageCount = 0;
    this.lastUsed   = Date.now();
  }
}

// ─────────────────────────────────────────────────────────────────
// LESSON — port de neural_mesh.rs Lesson
// ─────────────────────────────────────────────────────────────────

export class Lesson {
  constructor({ query, response, quality, expertUsed = 'unknown', timestamp = null }) {
    this.query      = query;
    this.response   = response;
    this.quality    = Math.max(0, Math.min(1, quality));
    this.expertUsed = expertUsed;
    this.timestamp  = timestamp ?? Date.now();
  }
}

// ─────────────────────────────────────────────────────────────────
// VECTOR STORE léger — port de vector_store.rs (arrivera après)
// Stockage + recherche cosinus sur embeddings Float32
// ─────────────────────────────────────────────────────────────────

class VectorStore {
  #entries;   // Map<id, { embedding: Float32Array, metadata: object }>

  constructor() { this.#entries = new Map(); }

  insert(id, embedding, metadata = null) {
    this.#entries.set(id, { embedding: new Float32Array(embedding), metadata });
  }

  /**
   * Recherche cosinus — retourne les top-k (id, score) triés par similarité.
   * @param {Float32Array} query
   * @param {number}       k
   * @returns {{ id: string, score: number }[]}
   */
  search(query, k = 5) {
    const qNorm = _norm(query);
    if (qNorm === 0) return [];

    const scores = [];
    for (const [id, { embedding }] of this.#entries) {
      const dot    = _dot(query, embedding);
      const denom  = qNorm * _norm(embedding);
      const cosine = denom > 0 ? dot / denom : 0;
      scores.push({ id, score: cosine });
    }

    scores.sort((a, b) => b.score - a.score);
    return scores.slice(0, k);
  }

  getMetadata(id) { return this.#entries.get(id)?.metadata ?? null; }
  size()          { return this.#entries.size; }
}

// ─────────────────────────────────────────────────────────────────
// MESH IN — Neural Mesh principal
// ─────────────────────────────────────────────────────────────────

export class MeshIn {
  // TypedArrays plats pour les propriétés scalaires — cache-friendly
  #wisdom;      // Float32Array[MAX_NEURONS]
  #activation;  // Float32Array[MAX_NEURONS]
  #lastUsed;    // Float64Array[MAX_NEURONS]   (timestamps ms)
  #active;      // Uint8Array[MAX_NEURONS]     (0 ou 1)
  #actScore;    // Float32Array[MAX_NEURONS]   (activity_score du rs)

  // Structures riches
  #neurons;     // Map<id, Neuron> — accès aux personnalités
  #synapses;    // Map<"from:to", Synapse>
  #vectorStore; // VectorStore — index sémantique des leçons
  #idCounter;   // prochain id
  #learnCalls;  // compteur pour pruning périodique

  constructor(initialSize = 64) {
    this.#wisdom      = new Float32Array(MAX_NEURONS);
    this.#activation  = new Float32Array(MAX_NEURONS);
    this.#lastUsed    = new Float64Array(MAX_NEURONS);
    this.#active      = new Uint8Array(MAX_NEURONS);
    this.#actScore    = new Float32Array(MAX_NEURONS);

    this.#neurons     = new Map();
    this.#synapses    = new Map();
    this.#vectorStore = new VectorStore();
    this.#idCounter   = 0;
    this.#learnCalls  = 0;

    this.totalSynapses = 0;
    this.averageWisdom = 0.5;

    const count = Math.min(initialSize, MAX_NEURONS);
    for (let i = 0; i < count; i++) this.addNeuron(0.5);
  }

  // ─── Neurogenèse ─────────────────────────────────────────────

  /**
   * Ajoute un neurone et établit automatiquement des connexions
   * avec les top-K neurones les plus pertinents (port de add_neuron + auto_establish_synapses).
   *
   * @param {number} initialWisdom
   * @param {object} [personality]
   * @returns {number} id du neurone
   */
  addNeuron(initialWisdom = 0.5, personality = null) {
    if (this.#idCounter >= MAX_NEURONS) return -1;

    const id   = this.#idCounter++;
    const wis  = Math.max(0, Math.min(1, initialWisdom));

    this.#wisdom[id]     = wis;
    this.#activation[id] = 0.0;
    this.#lastUsed[id]   = Date.now();
    this.#active[id]     = 1;
    this.#actScore[id]   = 0;

    const neuron = new Neuron(id, wis, personality);
    this.#neurons.set(id, neuron);

    // Connexions automatiques (port de auto_establish_synapses)
    this.#autoConnectNeuron(id);

    return id;
  }

  // ─── Apprentissage Hebbian ────────────────────────────────────

  /**
   * Renforce ou affaiblit les connexions selon le résultat (port de hebbian_update).
   * @param {number} from
   * @param {number} to
   * @param {boolean} success
   */
  hebbianUpdate(from, to, success) {
    const key = `${from}:${to}`;
    const syn = this.#synapses.get(key);
    if (!syn) return;

    if (success) {
      syn.strength = Math.min(SYNAPSE_STRENGTH_MAX, syn.strength + HEBB_POSITIVE);
    } else {
      syn.strength = Math.max(SYNAPSE_STRENGTH_MIN, syn.strength - HEBB_NEGATIVE);
    }
    syn.usageCount++;
    syn.lastUsed = Date.now();
  }

  /**
   * API héritée — compatible avec le code existant.
   * Met à jour sagesse + activation pour une liste de neurones.
   */
  learn(neuronIds, strength) {
    const now = Date.now();
    const s   = Math.max(0, Math.min(1, strength));

    for (const id of neuronIds) {
      if (id < 0 || id >= this.#idCounter || !this.#active[id]) continue;
      this.#wisdom[id]     = Math.min(0.99, this.#wisdom[id] + s * 0.1);
      this.#activation[id] = Math.min(1.0, this.#activation[id] + s);
      this.#lastUsed[id]   = now;
      this.#actScore[id]   += s;

      // Mise à jour de l'objet Neuron riche
      const n = this.#neurons.get(id);
      if (n) { n.wisdom = this.#wisdom[id]; n.activityScore = this.#actScore[id]; n.lastUsed = now; }
    }

    this.#updateAvg();

    // Neurogenèse si sagesse moyenne élevée
    if (this.averageWisdom > 0.85 && this.#idCounter < MAX_NEURONS) {
      this.addNeuron(0.6);
      this.totalSynapses++;
    }

    // Pruning périodique (toutes les 256 itérations)
    if (++this.#learnCalls % 256 === 0) this.pruneSynapses();
  }

  // ─── Connexions ───────────────────────────────────────────────

  /**
   * Crée une synapse entre deux neurones (port de connect).
   */
  connect(from, to, strength = 0.5) {
    if (from === to) return;
    const s = Math.max(SYNAPSE_STRENGTH_MIN, Math.min(SYNAPSE_STRENGTH_MAX, strength));
    this.#synapses.set(`${from}:${to}`, new Synapse(from, to, s));
    this.totalSynapses = this.#synapses.size;
  }

  /**
   * Top-K neurones les plus connectés depuis un neurone source
   * (port de get_top_connected).
   */
  getTopConnected(neuronId, k = 5) {
    const conns = [];
    for (const [, syn] of this.#synapses) {
      if (syn.from === neuronId) conns.push({ id: syn.to, strength: syn.strength });
    }
    conns.sort((a, b) => b.strength - a.strength);
    return conns.slice(0, k).map(c => c.id);
  }

  // ─── Leçons & Sémantique ─────────────────────────────────────

  /**
   * Circule une leçon dans le mesh : indexation sémantique + propagation Hebbian
   * (port de circulate_lesson).
   *
   * @param {number} fromNeuronId
   * @param {Lesson} lesson
   */
  circulateLesson(fromNeuronId, lesson) {
    if (!(lesson instanceof Lesson)) throw new TypeError('Expected Lesson instance');

    // Indexation sémantique
    const embedding = this.#embedText(lesson.query);
    this.#vectorStore.insert(
      `lesson_${lesson.timestamp}`,
      embedding,
      { query: lesson.query, quality: lesson.quality, expert: lesson.expertUsed }
    );

    // Propagation Hebbian vers les pairs connectés
    const peers = this.getTopConnected(fromNeuronId, 5);
    for (const peerId of peers) {
      this.hebbianUpdate(fromNeuronId, peerId, true);
    }

    // Renforcer le neurone source
    this.learn([fromNeuronId], lesson.quality);
  }

  /**
   * Recherche sémantique dans les leçons indexées (port de semantic_search).
   * @param {string} query
   * @param {number} topK
   * @returns {{ lesson: object, score: number }[]}
   */
  semanticSearch(query, topK = 5) {
    const embedding = this.#embedText(query);
    const results   = this.#vectorStore.search(embedding, topK);

    return results.map(({ id, score }) => ({
      lesson: this.#vectorStore.getMetadata(id) ?? { query },
      score : +score.toFixed(4),
    }));
  }

  // ─── Maintenance ──────────────────────────────────────────────

  /**
   * Élague les synapses faibles et peu utilisées (port de prune_weak_synapses).
   * Survie si strength > PRUNE_THRESH OU usageCount > PRUNE_USAGE_MIN.
   */
  pruneSynapses() {
    const before = this.#synapses.size;
    for (const [key, syn] of this.#synapses) {
      if (syn.strength <= PRUNE_THRESH && syn.usageCount <= PRUNE_USAGE_MIN) {
        this.#synapses.delete(key);
      }
    }
    const removed = before - this.#synapses.size;
    if (removed > 0) {
      console.debug(`[MeshIn] Pruning : ${removed} synapses supprimées`);
      this.totalSynapses = this.#synapses.size;
    }

    // Pruning des neurones inactifs (compat API héritée)
    const now = Date.now();
    for (let i = 0; i < this.#idCounter; i++) {
      if (this.#active[i] && this.#wisdom[i] < PRUNE_THRESH && now - this.#lastUsed[i] > PRUNE_IDLE_MS) {
        this.#active[i] = 0;
      }
    }
  }

  /**
   * Décroissance temporelle des synapses (port de decay_synapses).
   * Appliquée aux synapses inactives depuis > DECAY_THRESHOLD_H heures.
   */
  decaySynapses() {
    const now = Date.now();
    for (const syn of this.#synapses.values()) {
      const ageH = (now - syn.lastUsed) / 3_600_000;
      if (ageH > DECAY_THRESHOLD_H) {
        const decay = Math.min(ageH / 60, DECAY_MAX);
        syn.strength = Math.max(SYNAPSE_STRENGTH_MIN, syn.strength - decay);
      }
    }
  }

  /**
   * Maintenance complète : pruning + décroissance (port de run_maintenance).
   */
  runMaintenance() {
    this.pruneSynapses();
    this.decaySynapses();
    console.debug('[MeshIn] Maintenance terminée');
  }

  // ─── Statistiques (port de get_mesh_stats) ───────────────────

  getMeshStats() {
    const totalSyn = this.#synapses.size;
    let sumStr = 0;
    const inDegree = new Map();

    for (const syn of this.#synapses.values()) {
      sumStr += syn.strength;
      inDegree.set(syn.to, (inDegree.get(syn.to) ?? 0) + 1);
    }

    const avgStrength    = totalSyn > 0 ? sumStr / totalSyn : 0;
    const activeNeurons  = this.#activeCount();
    let sumAct = 0;
    for (let i = 0; i < this.#idCounter; i++) if (this.#active[i]) sumAct += this.#actScore[i];
    const avgActivity    = activeNeurons > 0 ? sumAct / activeNeurons : 0;

    let mostConnected = null;
    let maxIn = 0;
    for (const [id, count] of inDegree) {
      if (count > maxIn) { maxIn = count; mostConnected = id; }
    }

    return {
      totalNeurons        : activeNeurons,
      totalSynapses       : totalSyn,
      avgStrength         : +avgStrength.toFixed(4),
      avgActivity         : +avgActivity.toFixed(4),
      mostConnectedNeuron : mostConnected,
      vectorStoreSize     : this.#vectorStore.size(),
      averageWisdom       : +this.averageWisdom.toFixed(4),
    };
  }

  // ─── API héritée (compatibilité index.js) ────────────────────

  wisdomVector(size) {
    const out = new Float32Array(size);
    let j = 0;
    for (let i = 0; i < this.#idCounter && j < size; i++) {
      if (this.#active[i]) out[j++] = this.#wisdom[i];
    }
    return out;
  }

  get neurons() { return { size: this.#activeCount() }; }

  getStats() {
    return [this.#activeCount(), this.averageWisdom, this.totalSynapses];
  }

  // ─── Mesh souverain : vitalité + réplication (Fusion L6) ─────

  /**
   * Score de vitalité du mesh local [0,1] — signal de contribution/réputation
   * du nœud dans le mesh souverain (entrée PoSI). Combine sagesse moyenne,
   * densité synaptique et ratio de neurones actifs.
   */
  meshHealth() {
    const active      = this.#activeCount();
    const capacity    = Math.max(1, this.#idCounter);
    const density     = this.#synapses.size / Math.max(1, active * AUTO_CONNECT_K);
    const activeRatio = active / capacity;
    const score = 0.5 * this.averageWisdom + 0.3 * Math.min(1, density) + 0.2 * activeRatio;
    return +Math.max(0, Math.min(1, score)).toFixed(4);
  }

  /**
   * Capture l'état du mesh (poids + synapses) pour migration/réplication
   * inter-nœuds. Sérialisable JSON.
   */
  snapshot() {
    const n = this.#idCounter;
    const synapses = [];
    for (const syn of this.#synapses.values()) {
      synapses.push({ from: syn.from, to: syn.to, strength: +syn.strength.toFixed(4), usageCount: syn.usageCount });
    }
    return {
      idCounter    : n,
      wisdom       : Array.from(this.#wisdom.subarray(0, n)),
      active       : Array.from(this.#active.subarray(0, n)),
      actScore     : Array.from(this.#actScore.subarray(0, n)),
      synapses,
      averageWisdom: this.averageWisdom,
    };
  }

  /**
   * Restaure un mesh depuis un snapshot (réplication d'un nœud vers un autre).
   * @param {object} snap — produit par snapshot()
   */
  restore(snap) {
    if (!snap || !Array.isArray(snap.wisdom)) throw new TypeError('snapshot invalide');
    const n = Math.min(snap.idCounter ?? snap.wisdom.length, MAX_NEURONS);
    this.#neurons.clear();
    this.#synapses.clear();
    this.#idCounter = n;
    for (let i = 0; i < n; i++) {
      this.#wisdom[i]     = snap.wisdom[i] ?? 0.5;
      this.#active[i]     = snap.active?.[i] ?? 1;
      this.#actScore[i]   = snap.actScore?.[i] ?? 0;
      this.#activation[i] = 0;
      this.#lastUsed[i]   = Date.now();
      this.#neurons.set(i, new Neuron(i, this.#wisdom[i]));
    }
    for (const s of (snap.synapses ?? [])) {
      const syn = new Synapse(s.from, s.to, s.strength ?? 0.5);
      syn.usageCount = s.usageCount ?? 0;
      this.#synapses.set(`${s.from}:${s.to}`, syn);
    }
    this.totalSynapses = this.#synapses.size;
    this.averageWisdom = snap.averageWisdom ?? 0.5;
    this.#updateAvg();
    return this;
  }

  // ─── Privés ───────────────────────────────────────────────────

  /** Connexions automatiques pour un nouveau neurone (port de auto_establish_synapses). */
  #autoConnectNeuron(newId) {
    if (this.#idCounter <= 1) return;

    const candidates = [];
    for (const [id, n] of this.#neurons) {
      if (id === newId) continue;
      const score = this.#connectionScore(n);
      candidates.push({ id, score });
    }
    candidates.sort((a, b) => b.score - a.score);

    for (const { id, score } of candidates.slice(0, AUTO_CONNECT_K)) {
      const strength = Math.max(0.35, Math.min(0.95, score / 100));
      this.connect(newId, id, strength);
      this.connect(id, newId, strength * 0.85);
    }
  }

  /** Score de connexion (port de calculate_connection_score). */
  #connectionScore(neuron) {
    const p = neuron.personality;
    return (neuron.activityScore * 0.45)
         + (p.wisdom      * 28)
         + (p.cooperation * 22)
         + (p.curiosity   *  8);
  }

  /**
   * Embedding sémantique léger (port de embed_text).
   * Projection de caractères → vecteur normalisé de dimension EMBED_DIM.
   * Les fichiers neurone.rs/personality.rs/vector_store.rs peuvent l'enrichir.
   */
  #embedText(text) {
    const emb   = new Float32Array(EMBED_DIM);
    const bytes = new TextEncoder().encode(text);
    for (let i = 0; i < bytes.length; i++) {
      emb[i % EMBED_DIM] += bytes[i] / 255;
    }
    // Normalisation L2
    let norm = 0;
    for (const v of emb) norm += v * v;
    norm = Math.sqrt(norm);
    if (norm > 0) for (let i = 0; i < EMBED_DIM; i++) emb[i] /= norm;
    return emb;
  }

  #updateAvg() {
    let sum = 0, n = 0;
    for (let i = 0; i < this.#idCounter; i++) {
      if (this.#active[i]) { sum += this.#wisdom[i]; n++; }
    }
    this.averageWisdom = n ? sum / n : 0.5;
  }

  #activeCount() {
    let n = 0;
    for (let i = 0; i < this.#idCounter; i++) if (this.#active[i]) n++;
    return n;
  }
}

// ─────────────────────────────────────────────────────────────────
// HELPERS VECTORIELS
// ─────────────────────────────────────────────────────────────────

function _dot(a, b) {
  const n = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += a[i] * b[i];
  return sum;
}

function _norm(a) {
  let sum = 0;
  for (const v of a) sum += v * v;
  return Math.sqrt(sum);
}
