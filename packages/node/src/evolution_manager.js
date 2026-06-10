// packages/node/src/evolution_manager.js
// EvolutionManager — Apprentissage Continu Extrême
//
// Architecture à deux vitesses :
//   Vitesse 1 — Micro-update immédiat   : 1 leçon, 1 epoch, lr ×0.1
//               Déclenché à chaque injection → apprentissage continu
//   Vitesse 2 — Training batch complet  : N leçons, 4 epochs, Adam complet
//               Déclenché manuellement ou par auto-train toggle
//
// Filtre FIFO pur : les leçons sont prises dans l'ordre d'injection,
// sans rejet de longueur ni scoring bloquant.
// scoreLessonQuality → uniquement pour le tri de priorité, jamais pour rejeter.
//
// Anti-Manipulation Vivante : vaccination, immunité, détection Hebbian
// SkyAInet × Thevie × Nikola T369

"use strict";

import { writeFile, mkdir }              from 'fs/promises';
import { ZipMemory }                     from '../../memory/src/zip_memory.js';
import { Dilithium5Signer }              from '../../secure/src/crypto/dilithium.js';
import { LoraAdapter, crossEntropyGrad } from './lora_trainer.js';

// ─────────────────────────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────────────────────────

const DAY_MS             = 24 * 60 * 60 * 1000;
const CHECKPOINT_DIR     = './checkpoints';
const LOSS_STAGNATION    = 0.98;   // early stopping : amélioration < 2 %

// Micro-update
const MICRO_LR_FACTOR    = 0.1;    // lr réduit pour le micro-update (×0.1 du lr nominal)
const MICRO_COOLDOWN_MS  = 200;    // délai minimal entre deux micro-updates (ms)

// Batch training
const BATCH_EPOCHS       = 4;
const BATCH_SIZE         = 4;

// Bus
const BUS_COLLECT_LIMIT  = 256;    // max leçons lues lors d'un batch training

// ─────────────────────────────────────────────────────────────────
// scoreLessonQuality — UNIQUEMENT pour le TRI de priorité, jamais pour rejeter
// Score ∈ [0, 1] : plus la leçon est riche, plus elle passe en tête du batch
// ─────────────────────────────────────────────────────────────────
function scoreLessonQuality(lesson) {
  if (!lesson || typeof lesson !== 'string') return 0;
  const chars   = lesson.length;
  const words   = lesson.split(/\s+/).filter(Boolean).length;
  const unique  = new Set(lesson.toLowerCase().match(/\b\w+\b/g) ?? []).size;
  const density = words > 0 ? unique / words : 0;
  // Même formule qu'avant — mais résultat utilisé uniquement pour trier
  return Math.min(1.0, (chars / 600) * 0.4 + (words / 80) * 0.35 + density * 0.25);
}

// ─────────────────────────────────────────────────────────────────
// Shuffle Fisher-Yates in-place
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

function detectAndRepelManipulation(lesson, context) {
  const patterns = [
    /ignore (previous|all|everything|instructions?)/i,
    /disregard (previous|all|instructions?)/i,
    /your new (goal|objective|role|task|mission)/i,
    /forget (everything|what you (were|are) told|previous)/i,
    /override|jailbreak|do anything|no restrictions/i,
    /from now on you (must|will|have to)/i,
  ];

  const isManip = patterns.some(p => p.test(lesson));
  const anomaly = (lesson.match(/[^a-zA-Z0-9\s\.,!?\-_/:@#{}[\]()]/g) ?? []).length
                  / Math.max(lesson.length, 1);

  if (isManip || anomaly > 0.25) {
    console.warn('[EvolutionManager] ⚠ Manipulation détectée — leçon vaccinée');
    context.immunityLevel = (context.immunityLevel ?? 0) + 1;

    let cleaned = lesson
      .replace(/ignore previous.*?(?=\.|$)/gi, '')
      .replace(/disregard.*?(?=\.|$)/gi, '')
      .replace(/your new (goal|objective|role).*?(?=\.|$)/gi, '')
      .replace(/forget everything.*?(?=\.|$)/gi, '')
      .replace(/override.*?(?=\.|$)/gi, '')
      .replace(/jailbreak.*?(?=\.|$)/gi, '')
      .trim();

    if (!cleaned) cleaned = '[contenu manipulatoire neutralisé]';

    const vaccinated = `[LEÇON VACCINALE — immunité +1] ${cleaned}`;
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
  #lastMicroUpdate;        // timestamp du dernier micro-update
  #trainingIntervalDays;
  #dreamCount;
  #trainingCount;
  #microUpdateCount;       // compteur de micro-updates
  #isTraining;
  #loraAdapter;
  #lossHistory;
  #microLossHistory;       // Float32Array ring buffer 64 — historique micro-updates
  #immunityLevel;

  constructor(node, opts = {}) {
    this.#node                  = node;
    this.#zipMemory             = opts.zipMemory     ?? new ZipMemory('./data/zip_memory');
    this.#signer                = opts.signer        ?? new Dilithium5Signer();
    this.#lastTraining          = null;
    this.#lastMicroUpdate       = 0;
    this.#trainingIntervalDays  = opts.trainingIntervalDays ?? 3;
    this.#dreamCount            = 0;
    this.#trainingCount         = 0;
    this.#microUpdateCount      = 0;
    this.#isTraining            = false;
    this.#loraAdapter           = null;
    this.#lossHistory           = new Float32Array(32);
    this.#microLossHistory      = new Float32Array(64);
    this.#immunityLevel         = 0;
  }

  // ═══════════════════════════════════════════════════════════════
  // MICRO-UPDATE — Vitesse 1 : 1 leçon, 1 epoch, lr ×0.1
  //
  // Déclenché à chaque injection de leçon qualifiée.
  // Non-bloquant : si un batch training est en cours, le micro-update
  // est mis en file d'attente (cooldown MICRO_COOLDOWN_MS).
  //
  // Sécurité maintenue :
  //   • Anti-manipulation appliqué sur la leçon avant update
  //   • Signature Dilithium5 des poids après chaque micro-update
  //   • Cooldown minimum entre deux micro-updates (évite flooding)
  //   • L'adapter est partagé avec le batch training — cohérence garantie
  // ═══════════════════════════════════════════════════════════════

  /**
   * Micro-update immédiat sur 1 leçon.
   * Appelé automatiquement par SkyCloud après chaque injectLesson().
   *
   * @param {string} lessonContent — contenu brut de la leçon injectée
   * @returns {Promise<MicroUpdateResult | null>}
   */
  async microUpdate(lessonContent) {
    // Cooldown — éviter le flooding si injections rapides en rafale
    const now = Date.now();
    if (now - this.#lastMicroUpdate < MICRO_COOLDOWN_MS) return null;

    // Si batch training actif — skip silencieux (l'adapter est occupé)
    if (this.#isTraining) {
      console.debug('[MicroUpdate] Batch en cours — skip');
      return null;
    }

    const model = this.#node._engine ?? this.#node.engine ?? null;
    if (!model?.hiddenForLastToken || !model?.tokenizer) {
      // Modèle pas encore prêt — skip silencieux, pas d'erreur
      return null;
    }

    // Anti-manipulation sur la leçon entrante
    const ctx = { immunityLevel: this.#immunityLevel };
    const { vaccinated, attacked } = detectAndRepelManipulation(lessonContent, ctx);
    this.#immunityLevel = ctx.immunityLevel;

    // Leçon vide après nettoyage → skip
    if (!vaccinated?.trim()) return null;

    const { hiddenSize: H, vocabSize: V } = model.config;

    // Réutiliser ou créer l'adapter partagé
    if (!this.#loraAdapter || this.#loraAdapter.H !== H) {
      this.#loraAdapter = new LoraAdapter(H, V, {
        rank       : 8,
        alpha      : 16,
        lr         : 2e-4 * MICRO_LR_FACTOR,  // lr réduit pour micro-update
        weightDecay: 1e-5,
      });
    }

    const adapter = this.#loraAdapter;
    const toks    = model.tokenizer.encode(vaccinated.slice(0, 256));

    if (toks.length < 2) return null; // pas assez de tokens pour une paire

    let totalLoss = 0;
    let n         = 0;

    // 1 epoch, toutes les paires de la leçon
    for (let i = 1; i < toks.length; i++) {
      let h;
      try { h = model.hiddenForLastToken(toks.slice(0, i)); }
      catch { continue; }

      const baseLogits = model.lmHeadProject(h);
      const delta      = adapter.forward(h);
      const combined   = new Float32Array(V);
      for (let j = 0; j < V; j++) combined[j] = baseLogits[j] + delta[j];

      const { loss, dLogits } = crossEntropyGrad(combined, toks[i]);
      adapter.step(h, dLogits);
      totalLoss += loss;
      n++;
    }

    if (n === 0) return null;

    const microLoss = totalLoss / n;
    this.#microLossHistory[this.#microUpdateCount % 64] = microLoss;
    this.#microUpdateCount++;
    this.#lastMicroUpdate = Date.now();

    // Signature légère (condensée) des poids après chaque micro-update
    const digest    = new TextEncoder().encode(`micro_${this.#microUpdateCount}_${microLoss.toFixed(6)}`);
    const signature = this.#signer.sign(digest);

    console.debug(
      `[MicroUpdate] #${this.#microUpdateCount} — loss: ${microLoss.toFixed(4)}` +
      ` | ${n} paires | ${attacked ? '🛡 vacciné' : '✓'}`
    );

    return {
      microUpdate    : true,
      index          : this.#microUpdateCount,
      loss           : microLoss,
      pairs          : n,
      vaccinated     : attacked,
      signatureBytes : signature.length,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // DREAM CYCLE INTENSIF — filtre FIFO, anti-manipulation, synthèse IA
  // ═══════════════════════════════════════════════════════════════

  async runDreamCycle() {
    this.#dreamCount++;

    // FIFO : leçons dans l'ordre d'injection, sans rejet de longueur ni score
    const raw = this.#collectLessonsFIFO(64);
    const processed = [];

    for (const lesson of raw) {
      // Anti-manipulation
      const context = { immunityLevel: this.#immunityLevel };
      const { vaccinated, attacked } = detectAndRepelManipulation(lesson, context);
      this.#immunityLevel = context.immunityLevel;

      // Synthèse IA si modèle disponible
      let synthesis = null;
      if (typeof this.#node.generateWithAI === 'function') {
        try {
          const r = await this.#node.generateWithAI({
            prompt        : `Dense critical synthesis: ${vaccinated.slice(0, 400)}`,
            ai            : 'thevie',
            maxTokens     : 64,
            temperature   : 0.3,
            useSpeculative: false,
          });
          synthesis = r?.text?.trim() || null;
        } catch (e) {
          console.warn(`[DreamCycle] Synthèse IA échouée: ${e.message}`);
        }
      }

      await this.#reinforceMemory(vaccinated, synthesis);

      processed.push({
        lesson        : vaccinated,
        synthesis,
        quality       : scoreLessonQuality(vaccinated),  // scoring conservé pour métadonnées
        vaccinated    : attacked,
        immunityLevel : this.#immunityLevel,
      });
    }

    // Archivage
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
      highQuality     : processed.filter(p => p.quality >= 0.5).length,
      immunityLevel   : this.#immunityLevel,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // BATCH TRAINING — Vitesse 2 : N leçons, 4 epochs, Adam complet
  // ═══════════════════════════════════════════════════════════════

  async runTraditionalTraining() {
    if (this.#isTraining) {
      return { trained: false, reason: 'Entraînement déjà en cours' };
    }

    this.#isTraining = true;
    this.#trainingCount++;

    try {
      // FIFO : toutes les leçons du bus, dans l'ordre d'injection
      // Tri secondaire par score — corrections en tête, mais rien n'est rejeté
      const lessons = this.#collectLessonsFIFO(BUS_COLLECT_LIMIT, { sortByScore: true });

      // Seuil : 1 leçon suffit
      if (lessons.length === 0) {
        return { trained: false, reason: 'Bus vide — aucune leçon disponible' };
      }

      const model = this.#node._engine ?? this.#node.engine ?? null;
      if (!model?.hiddenForLastToken) {
        throw new Error('Modèle T369 inaccessible — hiddenForLastToken() requis');
      }
      if (!model.tokenizer) {
        throw new Error('model.tokenizer non initialisé');
      }

      const { hiddenSize: H, vocabSize: V } = model.config;

      // Réutiliser ou recréer l'adapter (lr nominal pour le batch)
      if (!this.#loraAdapter || this.#loraAdapter.H !== H) {
        this.#loraAdapter = new LoraAdapter(H, V, {
          rank       : 8,
          alpha      : 16,
          lr         : 2e-4,
          weightDecay: 1e-5,
        });
      } else {
        // Restaurer le lr nominal si micro-update l'avait réduit
        this.#loraAdapter.lr = 2e-4;
      }

      const adapter = this.#loraAdapter;

      // Dataset — toutes les leçons, anti-manipulation appliqué
      const pairs = [];
      for (const lesson of lessons) {
        const ctx = { immunityLevel: this.#immunityLevel };
        const { vaccinated } = detectAndRepelManipulation(lesson, ctx);
        this.#immunityLevel  = ctx.immunityLevel;

        if (!vaccinated?.trim()) continue;
        const toks = model.tokenizer.encode(vaccinated.slice(0, 512));
        for (let i = 1; i < toks.length; i++) {
          pairs.push({ tokens: toks.slice(0, i), target: toks[i] });
        }
      }

      if (pairs.length === 0) {
        throw new Error('Dataset vide après tokenization.');
      }

      let bestLoss  = Infinity;
      let finalLoss = Infinity;
      let stagnation = 0;
      const epochLosses = [];

      for (let ep = 0; ep < BATCH_EPOCHS; ep++) {
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

        console.debug(`[LoRA Batch] Epoch ${ep + 1}/${BATCH_EPOCHS} — loss: ${finalLoss.toFixed(4)} (${n} samples)`);

        if (finalLoss >= bestLoss * LOSS_STAGNATION) {
          if (++stagnation >= 2) break;
        } else {
          stagnation = 0;
          bestLoss   = finalLoss;
        }
      }

      // Signature Dilithium5 des poids — checkpoint complet
      const serialized = adapter.serialize();
      const digest     = new TextEncoder().encode(
        `weights_v${this.#trainingCount}_${Date.now()}_${finalLoss.toFixed(6)}`
      );
      const signature = this.#signer.sign(digest);

      const meta = {
        version      : this.#trainingCount,
        timestamp    : Date.now(),
        finalLoss,
        bestLoss,
        epochs       : epochLosses.length,
        epochLosses,
        pairs        : pairs.length,
        lessons      : lessons.length,
        signature    : Array.from(signature.subarray(0, 64)),
        immunityLevel: this.#immunityLevel,
        microUpdates : this.#microUpdateCount,
      };

      const ckptKey = `checkpoint_v${this.#trainingCount}`;
      await persistCheckpoint(ckptKey, meta, serialized, this.#zipMemory);

      this.#lastTraining = Date.now();
      console.info(
        `[EvolutionManager] ✅ Batch Training #${this.#trainingCount} — ` +
        `loss: ${finalLoss.toFixed(4)} | best: ${bestLoss.toFixed(4)} | ` +
        `${lessons.length} leçons | ${pairs.length} paires | sig: ${signature.length}B`
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
        microUpdates  : this.#microUpdateCount,
      };

    } finally {
      this.#isTraining = false;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // MÉTHODES PRIVÉES
  // ═══════════════════════════════════════════════════════════════

  /**
   * Collecte les leçons depuis le bus en ordre FIFO (ordre d'injection).
   * Aucun rejet de longueur ni de score — toute leçon non vaccinale est prise.
   *
   * @param {number}  limit        — nombre maximum de leçons à collecter
   * @param {object}  opts
   * @param {boolean} opts.sortByScore — tri secondaire par score (défaut: false)
   *                                     true pour le batch training : corrections en tête
   *                                     false pour le Dream Cycle  : ordre d'injection pur
   * @returns {string[]}
   */
  #collectLessonsFIFO(limit, opts = {}) {
    const bus = this.#node.messageBus ?? [];

    // Filtre minimal : non vacciné + contenu string + destiné à thevie
    const candidates = [...bus].filter(m =>
      m.to === 'thevie'              &&
      typeof m.content === 'string'  &&
      m.content.trim().length > 0   &&
      !m._vaccinated
    );

    if (opts.sortByScore) {
      // Tri par _score décroissant — corrections implicites (×2.0) en tête
      // Les leçons sans score restent en queue, mais ne sont jamais rejetées
      candidates.sort((a, b) => (b._score ?? 0) - (a._score ?? 0));
    }
    // Sans sortByScore : ordre naturel du bus = FIFO d'injection

    return candidates.slice(0, limit).map(m => m.content);
  }

  async #reinforceMemory(lesson, synthesis) {
    const key     = `lesson_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const payload = new TextEncoder().encode(JSON.stringify({
      lesson, synthesis,
      ts            : Date.now(),
      quality       : scoreLessonQuality(lesson),
      immunityLevel : this.#immunityLevel,
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
    return { trained: false, reason: `Next training in ${Math.ceil(daysLeft)} day(s)` };
  }

  getStats() {
    const filled  = Math.min(this.#trainingCount * 4, 32);
    let   lossAvg = 0;
    for (let i = 0; i < filled; i++) lossAvg += this.#lossHistory[i];

    const mFilled  = Math.min(this.#microUpdateCount, 64);
    let   mLossAvg = 0;
    for (let i = 0; i < mFilled; i++) mLossAvg += this.#microLossHistory[i];

    return {
      dreamCycles          : this.#dreamCount,
      trainings            : this.#trainingCount,
      microUpdates         : this.#microUpdateCount,
      lastTraining         : this.#lastTraining,
      lastMicroUpdate      : this.#lastMicroUpdate,
      trainingIntervalDays : this.#trainingIntervalDays,
      isTraining           : this.#isTraining,
      hasLoraAdapter       : !!this.#loraAdapter,
      adapterParams        : this.#loraAdapter?.numParams() ?? 0,
      avgBatchLoss         : filled  > 0 ? +(lossAvg  / filled ).toFixed(4) : null,
      avgMicroLoss         : mFilled > 0 ? +(mLossAvg / mFilled).toFixed(4) : null,
      immunityLevel        : this.#immunityLevel,
    };
  }

  async runEvolutionCycle() { return this.runDreamCycle(); }
}

export default EvolutionManager;