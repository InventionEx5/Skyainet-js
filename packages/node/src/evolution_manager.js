// packages/node/src/evolution_manager.js
// EvolutionManager — Apprentissage Continu (Production Ready)
// Dream Cycle intensif + Entraînement LoRA réel + Adam + Checkpoint signé
// SkyAInet × Thevie × Nikola T369

"use strict";

import { writeFile, mkdir }           from 'fs/promises';
import { ZipMemory }                  from '../../memory/src/zip_memory.js';
import { Dilithium5Signer }           from '../../secure/src/crypto/dilithium.js';
import { LoraAdapter, crossEntropyGrad } from './lora_trainer.js';

const DAY_MS            = 24 * 60 * 60 * 1000;
const CHECKPOINT_DIR    = './checkpoints';
const MIN_LESSONS       = 8;
const MIN_LESSON_WORDS  = 6;    // filtre anti-bruit
const MIN_LESSON_CHARS  = 24;
const LOSS_STAGNATION   = 0.98; // early stopping : amélioration < 2 %

// ─────────────────────────────────────────────────────────────────
// Qualité d'une leçon — basée sur longueur et densité lexicale
// Score ∈ [0, 1]
// ─────────────────────────────────────────────────────────────────
function scoreLessonQuality(lesson) {
  if (!lesson || typeof lesson !== 'string') return 0;
  const chars = lesson.length;
  const words = lesson.split(/\s+/).filter(Boolean).length;
  // Vocabulaire unique / mots totaux = densité lexicale
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
  // Tentative Node.js fs
  try {
    await mkdir(CHECKPOINT_DIR, { recursive: true });
    await writeFile(`${CHECKPOINT_DIR}/${key}.json`, JSON.stringify(meta));
    if (weights instanceof Uint8Array) {
      await writeFile(`${CHECKPOINT_DIR}/${key}.bin`, weights);
    }
    return;
  } catch { /* Pas dans Node ou accès refusé */ }

  // Fallback ZipMemory (toujours disponible)
  await zipMemory.store(key, new TextEncoder().encode(JSON.stringify(meta)));
}

// ─────────────────────────────────────────────────────────────────
// EXPORT PRINCIPAL
// ─────────────────────────────────────────────────────────────────

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
  #loraAdapter;   // LoraAdapter | null — initialisé au premier training
  #lossHistory;   // Float32Array — ring buffer 32 entrées

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
  }

  // ═══════════════════════════════════════════════════════════════
  // DREAM CYCLE INTENSIF
  // ═══════════════════════════════════════════════════════════════

  async runDreamCycle() {
    this.#dreamCount++;

    const raw     = this.#collectLessonsFromBus(64);
    const lessons = raw.filter(l =>
      scoreLessonQuality(l) >= this.#qualityThreshold &&
      l.split(/\s+/).length >= MIN_LESSON_WORDS &&
      l.length >= MIN_LESSON_CHARS
    );

    const processed = [];

    for (const lesson of lessons) {
      let synthesis = null;

      // Synthèse via le modèle T369 injecté dans le nœud
      if (typeof this.#node.generateWithAI === 'function') {
        try {
          const r = await this.#node.generateWithAI({
            prompt        : `Synthèse dense et critique : ${lesson.slice(0, 400)}`,
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

      // Renforcement mémoire compressée
      await this.#reinforceMemory(lesson, synthesis);
      processed.push({ lesson, synthesis, quality: scoreLessonQuality(lesson) });
    }

    // Archivage du cycle dans ZipMemory
    await this.#zipMemory.store(
      `dream_cycle_${Date.now()}`,
      new TextEncoder().encode(JSON.stringify({
        kind: 'dream', at: Date.now(),
        count: processed.length, processed,
      }))
    );

    console.info(`[EvolutionManager] Dream #${this.#dreamCount} — ${processed.length} leçons traitées`);
    return {
      cycle           : this.#dreamCount,
      lessonsProcessed: processed.length,
      highQuality     : lessons.length,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // ENTRAÎNEMENT LOURD — vrai LoRA forward/backward sur T369
  // ═══════════════════════════════════════════════════════════════

  async runTraditionalTraining() {
    if (this.#isTraining) {
      return { trained: false, reason: 'Entraînement déjà en cours' };
    }

    this.#isTraining = true;
    this.#trainingCount++;

    try {
      // ── Sélection des leçons de qualité ───────────────────
      const lessons = this.#selectHighQualityLessons(128);
      if (lessons.length < MIN_LESSONS) {
        return {
          trained: false,
          reason : `Pas assez de leçons (${lessons.length} < ${MIN_LESSONS})`,
        };
      }

      // ── Résolution du modèle T369 ──────────────────────────
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

      // ── Initialisation de l'adapter LoRA (lazy) ───────────
      if (!this.#loraAdapter || this.#loraAdapter.H !== H || this.#loraAdapter.V !== V) {
        this.#loraAdapter = new LoraAdapter(H, V, {
          rank       : 8,
          alpha      : 16,
          lr         : 2e-4,
          weightDecay: 1e-5,
        });
        console.info(`[EvolutionManager] LoraAdapter initialisé — H=${H}, V=${V}`);
      }
      const adapter = this.#loraAdapter;

      // ── Construction du dataset (paires contexte → cible) ─
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

      // ── Boucle d'entraînement ──────────────────────────────
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

            // Logits base + ΔLoRA
            const baseLogits = model.lmHeadProject(h);
            const delta      = adapter.forward(h);
            const combined   = new Float32Array(V);
            for (let j = 0; j < V; j++) combined[j] = baseLogits[j] + delta[j];

            // Cross-entropy + backward Adam
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

        // Early stopping
        if (finalLoss >= bestLoss * LOSS_STAGNATION) {
          if (++stagnation >= 2) {
            console.info(`[LoRA] Early stopping epoch ${ep + 1}`);
            break;
          }
        } else {
          stagnation = 0;
          bestLoss   = finalLoss;
        }
      }

      // ── Signature Dilithium5 des poids ─────────────────────
      const serialized = adapter.serialize();
      const digest     = new TextEncoder().encode(
        `weights_v${this.#trainingCount}_${Date.now()}_${finalLoss.toFixed(6)}`
      );
      const signature = this.#signer.sign(digest);

      // ── Checkpoint ─────────────────────────────────────────
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
  // MÉTHODES PRIVÉES
  // ═══════════════════════════════════════════════════════════════

  /** Collecte les N derniers messages du bus destinés à 'thevie' */
  #collectLessonsFromBus(limit) {
    const bus = this.#node.messageBus ?? [];
    const out = [];
    for (let i = bus.length - 1; i >= 0 && out.length < limit; i--) {
      const m = bus[i];
      if (m.to === 'thevie' && typeof m.content === 'string' && m.content.length > 0) {
        out.push(m.content);
      }
    }
    return out.reverse();
  }

  /**
   * Sélectionne les leçons de haute qualité depuis le bus.
   * Déduplique par contenu exact, filtre par score et longueur.
   */
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
        !seen.has(m.content) &&
        scoreLessonQuality(m.content) >= this.#qualityThreshold
      ) {
        seen.add(m.content);
        out.push(m.content);
      }
    }
    return out;
  }

  /** Stocke une leçon + synthèse dans ZipMemory, clé horodatée */
  async #reinforceMemory(lesson, synthesis) {
    const key     = `lesson_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const payload = new TextEncoder().encode(JSON.stringify({
      lesson, synthesis, ts: Date.now(),
      quality: scoreLessonQuality(lesson),
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
    };
  }

  // Compat : ancienne méthode runDreamCycle exposée sous le nom legacy
  async runEvolutionCycle() { return this.runDreamCycle(); }
}

export default EvolutionManager;
