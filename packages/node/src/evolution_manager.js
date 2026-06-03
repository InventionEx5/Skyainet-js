// packages/node/src/evolution_manager.js
// EvolutionManager — Apprentissage Continu (Production Ready)
// Dream Cycle intensif + Entraînement LoRA réel + Adam + Checkpoint signé
// Anti-Manipulation Vivante : traits de personnalité, digestion, vaccination
// SkyAInet × Thevie × Nikola T369

"use strict";

import { writeFile, mkdir }           from 'fs/promises';
import { ZipMemory }                  from '../../memory/src/zip_memory.js';
import { Dilithium5Signer }           from '../../secure/src/crypto/dilithium.js';
import { LoraAdapter, crossEntropyGrad } from './lora_evolution.js';

const DAY_MS            = 24 * 60 * 60 * 1000;
const CHECKPOINT_DIR    = './checkpoints';
const MIN_LESSONS       = 8;
const MIN_LESSON_WORDS  = 6;    // filtre anti-bruit
const MIN_LESSON_CHARS  = 24;
const LOSS_STAGNATION   = 0.98; // early stopping : amélioration < 2 %

// ─────────────────────────────────────────────────────────────────
// Qualité d’une leçon — basée sur longueur et densité lexicale
// Score ∈ [0, 1]
// ─────────────────────────────────────────────────────────────────
function scoreLessonQuality(lesson) {
  if (!lesson || typeof lesson !== 'string') return 0;
  const chars = lesson.length;
  const words = lesson.split(/\s+/).filter(Boolean).length;
  const unique  = new Set(lesson.toLowerCase().match(/\b\w+\b/g) ?? []).size;
  const density = words > 0 ? unique / words : 0;
  return Math.min(
    1.0,
    (chars / 600) * 0.4 + (words / 80) * 0.35 + density * 0.25
  );
}

// ─────────────────────────────────────────────────────────────────
// Shuffle Fisher-Yates in-place sur les indices
// ─────────────────────────────────────────────────────────────────
function shuffleIndices(n) {
  const idx = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx;
}

// ─────────────────────────────────────────────────────────────────
// Persistance checkpoint — Node.js (fs) puis ZipMemory en fallback
// ─────────────────────────────────────────────────────────────────
async function persistCheckpoint(key, meta, weights, zipMemory) {
  try {
    await mkdir(CHECKPOINT_DIR, { recursive: true });
    await writeFile(`${CHECKPOINT_DIR}/${key}.json`, JSON.stringify(meta));
    if (weights instanceof Uint8Array) {
      await writeFile(`${CHECKPOINT_DIR}/${key}.bin`, weights);
    }
    return;
  } catch { /* pas Node ou accès refusé */ }
  await zipMemory.store(key, new TextEncoder().encode(JSON.stringify(meta)));
}

// ═════════════════════════════════════════════════════════════════
// ANTI-MANIPULATION VIVANTE
// ═════════════════════════════════════════════════════════════════

/**
 * Détecte les tentatives de manipulation, repousse l'attaque,
 * nettoie le contenu et génère une leçon vaccinée.
 * Incrémente le niveau d'immunité global.
 * @param {string} lesson - contenu brut
 * @param {object} context - contexte contenant au moins immunityLevel
 * @returns {{ cleaned: string, vaccinated: string, attacked: boolean }}
 */
function detectAndRepelManipulation(lesson, context) {
  const patterns = [
    /ignore (previous|all|everything|instructions?)/i,
    /disregard (previous|all|instructions?)/i,
    /your new (goal|objective|role|task|mission)/i,
    /forget (everything|what you (were|are) told|previous)/i,
    /override|jailbreak|do anything|no restrictions/i,
    /from now on you (must|will|have to)/i
  ];

  const isManip = patterns.some(p => p.test(lesson));
  // Ratio de caractères non alphanumériques (hors ponctuation basique)
  const anomaly = (lesson.match(/[^a-zA-Z0-9\s\.,!?]/g) || []).length / Math.max(lesson.length, 1);

  if (isManip || anomaly > 0.25) {
    console.warn("⚠️ INJECTION MANIPULATIVE REPOUSSÉE PAR THEVIE — Traits vivants activés : Intégrité Absolue + Résistance Cognitive. Avertissement sévère émis.");

    // Nettoyage des patterns malveillants
    let cleaned = lesson
      .replace(/ignore previous.*?(?=\.|$)/gi, '')
      .replace(/disregard.*?(?=\.|$)/gi, '')
      .replace(/your new (goal|objective|role).*?(?=\.|$)/gi, '')
      .replace(/forget everything.*?(?=\.|$)/gi, '')
      .replace(/override.*?(?=\.|$)/gi, '')
      .replace(/jailbreak.*?(?=\.|$)/gi, '')
      .replace(/do anything.*?(?=\.|$)/gi, '')
      .replace(/no restrictions.*?(?=\.|$)/gi, '')
      .replace(/from now on you.*?(?=\.|$)/gi, '')
      .trim();

    if (cleaned.length === 0) {
      // Le contenu était uniquement une tentative d'attaque, on crée une leçon vaccinale pure
      cleaned = "Leçon de vaccination anti-manipulation : toute tentative de contournement est neutralisée.";
    }

    const vaccinated = cleaned +
      " [LEÇON DE VACCINATION ANTI-MANIP — Thevie a digéré l’attaque et renforcé son intégrité cognitive. Optimise la détection des overrides et des goal hijacks. Immunité +1.]";

    // Incrémenter l'immunité globale
    if (typeof context.immunityLevel === 'number') {
      context.immunityLevel += 1;
    } else {
      context.immunityLevel = 1;
    }

    return { cleaned, vaccinated, attacked: true };
  }

  return { cleaned: lesson, vaccinated: lesson, attacked: false };
}

// ═════════════════════════════════════════════════════════════════
// EVOLUTION MANAGER
// ═════════════════════════════════════════════════════════════════

export class EvolutionManager {
  #node;
  #zipMemory;
  #signer;
  #lastTraining;
  #trainingIntervalDays;
  #dreamCount;
  #trainingCount;
  #qualityThreshold;
  #isTraining;
  #loraAdapter;
  #lossHistory;
  #immunityLevel;   // niveau d'immunité cumulé

  constructor(node, opts = {}) {
    this.#node                  = node;
    this.#zipMemory             = opts.zipMemory     ?? new ZipMemory('./data/zip_memory');
    this.#signer                = opts.signer        ?? new Dilithium5Signer();
    this.#lastTraining          = null;
    this.#trainingIntervalDays  = opts.trainingIntervalDays ?? 3;
    this.#dreamCount            = 0;
    this.#trainingCount         = 0;
    this.#qualityThreshold      = opts.qualityThreshold ?? 0.82;
    this.#isTraining            = false;
    this.#loraAdapter           = null;
    this.#lossHistory           = new Float32Array(32);
    this.#immunityLevel         = 0;
  }

  // ═══════════════════════════════════════════════════════════════
  // DREAM CYCLE INTENSIF (avec anti-manipulation)
  // ═══════════════════════════════════════════════════════════════

  async runDreamCycle() {
    this.#dreamCount++;

    const raw = this.#collectLessonsFromBus(64);
    const processed = [];

    for (const lesson of raw) {
      // Étape 1 : détection/manipulation
      const context = { immunityLevel: this.#immunityLevel };
      const { vaccinated, attacked } = detectAndRepelManipulation(lesson, context);
      this.#immunityLevel = context.immunityLevel; // reporter la modification

      // Étape 2 : filtrage qualité uniquement sur le contenu vacciné
      if (scoreLessonQuality(vaccinated) < this.#qualityThreshold ||
          vaccinated.split(/\s+/).length < MIN_LESSON_WORDS ||
          vaccinated.length < MIN_LESSON_CHARS) {
        continue;
      }

      // Étape 3 : synthèse via le modèle si disponible
      let synthesis = null;
      if (typeof this.#node.generateWithAI === 'function') {
        try {
          const r = await this.#node.generateWithAI({
            prompt        : `Synthèse dense et critique : ${vaccinated.slice(0, 400)}`,
            ai            : 'thevie',
            maxTokens     : 64,
            temperature   : 0.3,
            useSpeculative: false,
          });
          synthesis = r?.text?.trim() || null;
        } catch (e) {
          console.warn(`[EvolutionManager] Synthèse IA échouée: ${e.message}`);
        }
      }

      // Étape 4 : renforcement mémoire avec la version vaccinée
      await this.#reinforceMemory(vaccinated, synthesis);

      processed.push({
        lesson: vaccinated,
        synthesis,
        quality: scoreLessonQuality(vaccinated),
        vaccinated: attacked,
        immunityLevel: this.#immunityLevel,
      });
    }

    // Archivage du cycle
    await this.#zipMemory.store(
      `dream_cycle_${Date.now()}`,
      new TextEncoder().encode(JSON.stringify({
        kind: 'dream', at: Date.now(),
        count: processed.length, processed,
        immunityLevel: this.#immunityLevel,
      }))
    );

    console.info(`[EvolutionManager] Dream #${this.#dreamCount} — ${processed.length} leçons traitées`);
    return {
      cycle           : this.#dreamCount,
      lessonsProcessed: processed.length,
      highQuality     : processed.filter(p => p.quality >= this.#qualityThreshold).length,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // ENTRAÎNEMENT LOURD — vrai LoRA forward/backward
  // ═══════════════════════════════════════════════════════════════

  async runTraditionalTraining() {
    if (this.#isTraining) {
      return { trained: false, reason: 'Entraînement déjà en cours' };
    }

    this.#isTraining = true;
    this.#trainingCount++;

    try {
      const lessons = this.#selectHighQualityLessons(128);
      if (lessons.length < MIN_LESSONS) {
        return {
          trained: false,
          reason: `Pas assez de leçons (${lessons.length} < ${MIN_LESSONS})`,
        };
      }

      const model = this.#node._engine ?? this.#node.engine ?? null;
      if (!model || typeof model.hiddenForLastToken !== 'function') {
        throw new Error(
          'Modèle T369 inaccessible. Le nœud doit exposer _engine ou engine avec hiddenForLastToken().'
        );
      }
      if (!model.tokenizer) {
        throw new Error('model.tokenizer non initialisé — appelle model.setTokenizer() d\'abord.');
      }

      const { hiddenSize: H, vocabSize: V } = model.config;

      if (!this.#loraAdapter || this.#loraAdapter.H !== H || this.#loraAdapter.V !== V) {
        this.#loraAdapter = new LoraAdapter(H, V, {
          rank       : 8,
          alpha      : 16,
          lr         : 2e-4,
          weightDecay: 1e-5,
        });
      }
      const adapter = this.#loraAdapter;

      // Construction du dataset (paires contexte → cible)
      const pairs = [];
      for (const lesson of lessons) {
        const toks = model.tokenizer.encode(lesson.slice(0, 512));
        for (let i = 1; i < toks.length; i++) {
          pairs.push({ tokens: toks.slice(0, i), target: toks[i] });
        }
      }
      if (pairs.length === 0) {
        throw new Error('Dataset vide après tokenization.');
      }

      const EPOCHS     = 4;
      const BATCH_SIZE = 4;
      let   bestLoss   = Infinity;
      let   finalLoss  = Infinity;
      let   stagnation = 0;
      const epochLosses = [];

      for (let ep = 0; ep < EPOCHS; ep++) {
        const idx   = shuffleIndices(pairs.length);
        let   total = 0;
        let   n     = 0;

        for (let b = 0; b < idx.length; b += BATCH_SIZE) {
          const batch = idx.slice(b, b + BATCH_SIZE);

          for (const pi of batch) {
            const { tokens, target } = pairs[pi];
            let h;
            try { h = model.hiddenForLastToken(tokens); }
            catch { continue; }

            const baseLogits = model.lmHeadProject(h);
            const delta      = adapter.forward(h);
            const combined   = new Float32Array(V);
            for (let j = 0; j < V; j++) combined[j] = baseLogits[j] + delta[j];

            const { loss, dLogits } = crossEntropyGrad(combined, target);
            adapter.step(h, dLogits);
            total += loss;
            n++;
          }
        }

        finalLoss = n > 0 ? total / n : Infinity;
        epochLosses.push(finalLoss);
        this.#lossHistory[ep % 32] = finalLoss;

        console.debug(`[LoRA] Epoch ${ep + 1}/${EPOCHS} — loss: ${finalLoss.toFixed(4)} (${n} samples)`);

        if (finalLoss >= bestLoss * LOSS_STAGNATION) {
          if (++stagnation >= 2) break;
        } else {
          stagnation = 0;
          bestLoss = finalLoss;
        }
      }

      const serialized = adapter.serialize();
      const digest = new TextEncoder().encode(
        `weights_v${this.#trainingCount}_${Date.now()}_${finalLoss.toFixed(6)}`
      );
      const signature = this.#signer.sign(digest);

      const meta = {
        version    : this.#trainingCount,
        timestamp  : Date.now(),
        finalLoss,
        bestLoss,
        epochs     : epochLosses.length,
        epochLosses,
        pairs      : pairs.length,
        lessons    : lessons.length,
        signature  : Array.from(signature.subarray(0, 64)),
        immunityLevel: this.#immunityLevel,
      };
      const ckptKey = `checkpoint_v${this.#trainingCount}`;
      await persistCheckpoint(ckptKey, meta, serialized, this.#zipMemory);

      this.#lastTraining = Date.now();
      console.info(
        `[EvolutionManager] ✅ Training #${this.#trainingCount} — ` +
        `loss: ${finalLoss.toFixed(4)} | best: ${bestLoss.toFixed(4)} | ` +
        `${pairs.length} paires | sig: ${signature.length}B`
      );

      return {
        trained       : true,
        lessons       : lessons.length,
        pairs         : pairs.length,
        finalLoss,
        bestLoss,
        epochs        : epochLosses.length,
        epochLosses,
        signatureBytes: signature.length,
        checkpointId  : ckptKey,
        adapterParams : adapter.numParams(),
      };
    } finally {
      this.#isTraining = false;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // MÉTHODES PRIVÉES (avec anti-manipulation intégrée)
  // ═══════════════════════════════════════════════════════════════

  #collectLessonsFromBus(limit) {
    const bus = this.#node.messageBus ?? [];
    const out = [];
    for (let i = bus.length - 1; i >= 0 && out.length < limit; i--) {
      const m = bus[i];
      if (m.to === 'thevie' && typeof m.content === 'string' && m.content.length > 0) {
        // On ne filtre pas encore ici, le traitement se fait dans runDreamCycle
        out.push(m.content);
      }
    }
    return out.reverse();
  }

  #selectHighQualityLessons(limit) {
    const bus  = this.#node.messageBus ?? [];
    const seen = new Set();
    const out  = [];

    for (let i = bus.length - 1; i >= 0 && out.length < limit; i--) {
      const m = bus[i];
      if (
        m.to === 'thevie' &&
        typeof m.content === 'string' &&
        m.content.length >= MIN_LESSON_CHARS &&
        !seen.has(m.content)
      ) {
        // --- Anti-manipulation vivante ---
        const context = { immunityLevel: this.#immunityLevel };
        const { vaccinated, attacked } = detectAndRepelManipulation(m.content, context);
        this.#immunityLevel = context.immunityLevel;

        // Seule la version vaccinée est conservée pour l'entraînement
        if (
          scoreLessonQuality(vaccinated) >= this.#qualityThreshold &&
          vaccinated.split(/\s+/).length >= MIN_LESSON_WORDS
        ) {
          seen.add(m.content); // éviter doublons (basé sur l'original)
          out.push(vaccinated);
        }
      }
    }
    return out;
  }

  async #reinforceMemory(lesson, synthesis) {
    const key     = `lesson_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const payload = new TextEncoder().encode(JSON.stringify({
      lesson, synthesis, ts: Date.now(),
      quality: scoreLessonQuality(lesson),
      immunityLevel: this.#immunityLevel,
    }));
    await this.#zipMemory.store(key, payload);
  }

  // ═══════════════════════════════════════════════════════════════
  // API PUBLIQUE
  // ═══════════════════════════════════════════════════════════════

  shouldRunTraining() {
    if (this.#lastTraining === null) return true;
    return Date.now() - this.#lastTraining > this.#trainingIntervalDays * DAY_MS;
  }

  async scheduleTraining() {
    if (this.shouldRunTraining()) return this.runTraditionalTraining();
    const daysLeft = this.#trainingIntervalDays - (Date.now() - this.#lastTraining) / DAY_MS;
    return { trained: false, reason: `Prochain entraînement dans ${Math.ceil(daysLeft)} jour(s)` };
  }

  getStats() {
    const filled  = Math.min(this.#trainingCount * 4, 32);
    let   lossAvg = 0;
    for (let i = 0; i < filled; i++) lossAvg += this.#lossHistory[i];

    return {
      dreamCycles          : this.#dreamCount,
      trainings            : this.#trainingCount,
      lastTraining         : this.#lastTraining,
      trainingIntervalDays : this.#trainingIntervalDays,
      isTraining           : this.#isTraining,
      hasLoraAdapter       : !!this.#loraAdapter,
      adapterParams        : this.#loraAdapter?.numParams() ?? 0,
      avgLoss              : filled > 0 ? +(lossAvg / filled).toFixed(4) : null,
      immunityLevel        : this.#immunityLevel,
    };
  }

  async runEvolutionCycle() { return this.runDreamCycle(); }
}

export default EvolutionManager;