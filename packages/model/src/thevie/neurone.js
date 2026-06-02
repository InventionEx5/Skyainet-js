// packages/model/src/thevie/neurone.js
// =====================================================
// Neurone — Unité Vivante du Neural Mesh
// Port de neurone.rs — Naissance, Évolution, Réplication, Migration
// SkyAInet × Nikola T369
// =====================================================

"use strict";

import { Personality, PersonalityProfile } from './personality.js';
import { Lesson }                           from '../../t369-inference/src/meshin.js';

// ─────────────────────────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────────────────────────

const EXPERTS     = ['text', 'code', 'analysis', 'science', 'ethics', 'finance', 'creative', 'logic'];
const COMP_MIN    = 0.50;
const COMP_MAX    = 2.20;
const COMP_INIT   = 0.68;
const COMP_RANGE  = 0.22;

// ─────────────────────────────────────────────────────────────────
// MÉMOIRE LOCALE — buffer circulaire de leçons
// Port de LocalMemory — arrivera via memory.rs
// ─────────────────────────────────────────────────────────────────

class LocalMemory {
  #lessons;   // Lesson[]
  #maxSize;

  constructor(maxSize = 64) {
    this.#lessons = [];
    this.#maxSize = maxSize;
  }

  storeLesson(lesson) {
    this.#lessons.push(lesson);
    if (this.#lessons.length > this.#maxSize) this.#lessons.shift();
  }

  getRecentLessons(k = 5) {
    return this.#lessons.slice(-k);
  }

  getBestLessons(k = 5) {
    return [...this.#lessons]
      .sort((a, b) => b.quality - a.quality)
      .slice(0, k);
  }

  searchLessons(query) {
    const q = query.toLowerCase();
    return this.#lessons.filter(l =>
      l.query?.toLowerCase().includes(q) || l.response?.toLowerCase().includes(q)
    );
  }

  get size() { return this.#lessons.length; }

  toJSON() { return this.#lessons.map(l => ({ ...l })); }
}

// ─────────────────────────────────────────────────────────────────
// NEURONE
// ─────────────────────────────────────────────────────────────────

export class Neurone {
  #memory;           // LocalMemory
  #replicationCount; // u32

  /**
   * @param {number}      id
   * @param {Personality} personality
   * @param {object}      [opts]
   */
  constructor(id = 0, personality = null, opts = {}) {
    const now = Date.now();

    this.id               = id;
    this.personality      = personality instanceof Personality
      ? personality
      : new Personality(opts.profile ?? 'Default');

    this.activityScore    = 0;
    this.birthTime        = opts.birthTime    ?? now;
    this.lastActivity     = now;

    // Compétences MoE — initialisées avec variance aléatoire
    this.expertsCompetence = {};
    for (const expert of EXPERTS) {
      this.expertsCompetence[expert] = Math.max(COMP_MIN,
        Math.min(COMP_MAX, COMP_INIT + (Math.random() * COMP_RANGE * 2 - COMP_RANGE))
      );
    }

    this.#memory           = new LocalMemory(opts.memorySize ?? 64);
    this.#replicationCount = 0;
  }

  // ─── Création depuis une conscience collective ────────────────

  /**
   * Crée un neurone en héritant de la sagesse collective (port de Neurone::new).
   * @param {object} collectiveAvg — { wisdom, benevolence, creativity, … }
   * @param {number} mutationStr   — force de mutation à la naissance
   * @returns {Neurone}
   */
  static fromCollective(collectiveAvg, mutationStr = 0.035) {
    const p = new Personality(collectiveAvg).mutateAtBirth(mutationStr);
    return new Neurone(0, p);
  }

  // ─── Activité ─────────────────────────────────────────────────

  /** Incrémente l'activité après une interaction (port de increment_activity). */
  incrementActivity() {
    this.activityScore++;
    this.lastActivity = Date.now();
  }

  // ─── Évolution ───────────────────────────────────────────────

  /**
   * Évolution de la personnalité + compétences experts (port de evolve).
   * @param {number} quality       — [0, 1]
   * @param {number} globalWisdom  — sagesse collective (bonus si > 0.85)
   * @param {number} evolutionRate — taux de base
   * @param {number} mutationRate  — probabilité de mutation créative
   */
  evolve(quality, globalWisdom = 0.75, evolutionRate = 0.042, mutationRate = 0.012) {
    // Évolution de la personnalité
    this.personality.evolve(quality, evolutionRate, mutationRate);

    // Bonus collectif
    if (globalWisdom > 0.85) {
      this.personality.wisdom = Math.min(0.99, this.personality.wisdom + 0.008);
    }

    // Évolution locale des compétences experts (EMA)
    for (const expert of EXPERTS) {
      this.expertsCompetence[expert] = Math.max(COMP_MIN, Math.min(COMP_MAX,
        this.expertsCompetence[expert] * 0.965 + quality * 0.045
      ));
    }
  }

  // ─── Leçons ───────────────────────────────────────────────────

  /**
   * Partage une leçon avec le mesh et la stocke en mémoire locale
   * (port de share_lesson).
   * @param {object} mesh   — MeshIn instance
   * @param {Lesson} lesson
   */
  shareLesson(mesh, lesson) {
    if (!(lesson instanceof Lesson)) lesson = new Lesson(lesson);
    mesh.circulateLesson(this.id, lesson);
    this.#memory.storeLesson(lesson);
  }

  /**
   * Récupère la leçon la plus pertinente pour une requête donnée
   * (port de get_relevant_lesson).
   */
  getRelevantLesson(mesh, query) {
    // Chercher d'abord dans la mémoire locale (plus rapide)
    const local = this.#memory.searchLessons(query);
    if (local.length > 0) {
      return local.reduce((best, l) => l.quality > best.quality ? l : best);
    }
    // Fallback : recherche sémantique dans le mesh
    const results = mesh.semanticSearch(query, 3);
    return results[0]?.lesson ?? null;
  }

  // ─── Réplication ──────────────────────────────────────────────

  /**
   * Réplique le neurone en créant un enfant avec mutation plus marquée
   * (port de replicate).
   * @param {object} mesh — MeshIn
   * @returns {number} id du nouveau neurone
   */
  replicate(mesh) {
    const childPersonality = this.personality.cloneWithMutation(0.055);
    const childId = mesh.addNeuron(childPersonality.wisdom, {
      cooperation: childPersonality.cooperation,
      wisdom     : childPersonality.wisdom,
      curiosity  : childPersonality.curiosity,
    });
    this.#replicationCount++;
    console.info(`[Neurone] Réplication → enfant ${childId} (génération ${this.#replicationCount})`);
    return childId;
  }

  // ─── Migration ────────────────────────────────────────────────

  /**
   * Sérialise l'état pour migration vers un autre nœud (port de prepare_for_migration).
   * @returns {Uint8Array}
   */
  prepareForMigration() {
    return new TextEncoder().encode(JSON.stringify(this.toJSON()));
  }

  /**
   * Applique un état migré reçu d'un autre nœud (port de apply_migrated_state).
   * @param {Uint8Array|string} data
   */
  applyMigratedState(data) {
    try {
      const raw   = typeof data === 'string' ? data : new TextDecoder().decode(data);
      const state = JSON.parse(raw);

      this.personality      = new Personality(state.personality);
      this.activityScore    = state.activityScore ?? 0;
      this.expertsCompetence= state.expertsCompetence ?? this.expertsCompetence;
      this.lastActivity     = Date.now();

      if (Array.isArray(state.memory)) {
        for (const l of state.memory) this.#memory.storeLesson(new Lesson(l));
      }

      console.info(`[Neurone] ${this.id} restauré après migration (activité: ${this.activityScore})`);
    } catch (e) {
      console.error(`[Neurone] applyMigratedState échoué : ${e.message}`);
    }
  }

  // ─── Santé ───────────────────────────────────────────────────

  /**
   * Vérifie si le neurone est en bonne santé (port de is_healthy).
   * Critères : activité suffisante, sagesse minimale, compétences OK.
   */
  isHealthy() {
    return this.activityScore >= 10
      && this.personality.wisdom > 0.58
      && Object.values(this.expertsCompetence).every(c => c > 0.62);
  }

  // ─── Expert routing ──────────────────────────────────────────

  /** Retourne l'expert le plus compétent pour ce neurone. */
  getBestExpert() {
    let best = EXPERTS[0], max = 0;
    for (const e of EXPERTS) {
      if (this.expertsCompetence[e] > max) { max = this.expertsCompetence[e]; best = e; }
    }
    return { expert: best, competence: max };
  }

  // ─── Accesseurs ──────────────────────────────────────────────

  get replicationCount() { return this.#replicationCount; }
  get memory()           { return this.#memory; }
  get memorySize()       { return this.#memory.size; }

  // ─── Sérialisation ───────────────────────────────────────────

  toJSON() {
    return {
      id                : this.id,
      personality       : this.personality.toJSON(),
      activityScore     : this.activityScore,
      birthTime         : this.birthTime,
      lastActivity      : this.lastActivity,
      expertsCompetence : { ...this.expertsCompetence },
      replicationCount  : this.#replicationCount,
      memory            : this.#memory.toJSON(),
    };
  }

  static fromJSON(obj) {
    const n = new Neurone(obj.id, new Personality(obj.personality));
    n.activityScore      = obj.activityScore    ?? 0;
    n.birthTime          = obj.birthTime        ?? Date.now();
    n.lastActivity       = obj.lastActivity     ?? Date.now();
    n.expertsCompetence  = obj.expertsCompetence ?? n.expertsCompetence;
    n.#replicationCount  = obj.replicationCount  ?? 0;
    return n;
  }
}
