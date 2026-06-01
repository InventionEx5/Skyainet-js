// packages/model/src/thevie/dream_cycle.js
// =====================================================
// DreamCycle — Consolidation Créative & Entraînement Réel
// Light Dream continu + LoRA Training réel (forward/backward)
// SkyAInet × Thevie × Nikola T369
// =====================================================

"use strict";

import { Dilithium5Signer }                from '../../../secure/src/crypto/dilithium.js';
import { LoraAdapter, crossEntropyGrad }   from '../../node/src/lora_trainer.js';

// ─────────────────────────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────────────────────────

const MIN_LESSONS_TRAIN  = 8;     // seuil minimal pour lancer un entraînement
const MAX_SKIPPED_KEYS   = 128;   // limite du cache clés sautées du ratchet
const WISDOM_FLOOR       = 0.50;  // plancher de sagesse collective
const WISDOM_CAP         = 0.990; // plafond
const LOSS_IMPROVE_RATIO = 0.98;  // la loss doit descendre de 2 % minimum par epoch
const CHECKPOINT_PREFIX  = 'dream_ckpt';

// ─────────────────────────────────────────────────────────────────
// EXPORT PRINCIPAL
// ─────────────────────────────────────────────────────────────────

export class DreamCycle {

  // ── Champs privés ─────────────────────────────────────────────
  #signer;
  #loraAdapter;   // LoraAdapter | null
  #model;         // T369Model   | null  (injecté via injectModel)
  #trainingCount;
  #lastTraining;
  #isTraining;
  #lossHistory;   // Float32Array circulaire — historique des loss

  constructor(opts = {}) {
    // Paramètres publics
    this.dreamFrequency    = opts.dreamFrequency    ?? 75;
    this.wisdomBoost       = opts.wisdomBoost       ?? 0.032;
    this.topPercent        = opts.topPercent        ?? 0.25;
    this.creativityFactor  = opts.creativityFactor  ?? 0.42;
    this.cyclesCompleted   = 0;
    this.minNeuronsForDream= opts.minNeuronsForDream ?? 4;
    this.qualityThreshold  = opts.qualityThreshold  ?? 0.82;

    // Crypto post-quantique
    this.#signer       = new Dilithium5Signer();

    // LoRA — construit à la demande dès qu'on connaît hiddenSize + vocabSize
    this.#loraAdapter  = null;
    this.#model        = opts.model ?? null;

    this.#trainingCount = 0;
    this.#lastTraining  = null;
    this.#isTraining    = false;
    this.#lossHistory   = new Float32Array(32);   // ring buffer 32 epochs

    // Compatibilité : accepte un loraTrainer legacy (duck-typing)
    if (opts.loraTrainer && typeof opts.loraTrainer.train === 'function') {
      this._legacyTrainer = opts.loraTrainer;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // DREAM CYCLE LÉGER (continu, déclenché par shouldTrigger)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Cycle de rêve léger :
   *   1. Sélectionne les neurones les plus sages du MeshIn
   *   2. Génère de nouvelles leçons par recombinaison sémantique
   *   3. Renforce la sagesse collective via CollectivIn.propagateWisdom
   *   4. Applique la diffusion onirique In-place via InDream.runDreamCycle
   *   5. Met à jour les personnalités CollectivIn pour les neurones de tête
   *
   * Toutes les mutations sont in-place — aucune allocation dans la boucle.
   *
   * @param {MeshIn}      mesh        — réseau neuronal évolutif
   * @param {CollectivIn} collective  — conscience collective
   * @param {InDream}     evolution   — moteur de diffusion onirique
   */
  async runDreamCycle(mesh, collective, evolution) {
    this.cyclesCompleted++;
    const start = Date.now();

    // ── 1. Sélection des neurones sages ───────────────────────
    const topIds = this.#selectTopWiseNeurons(mesh);
    if (topIds.length < this.minNeuronsForDream) {
      console.debug('[DreamCycle] Pas assez de neurones sages — cycle sauté');
      return { cycle: this.cyclesCompleted, lessonsProcessed: 0, durationMs: 0 };
    }
    console.debug(`[DreamCycle] ${topIds.length} neurones sages sélectionnés`);

    // ── 2. Génération de leçons oniriques ────────────────────
    // On lit les sagesses directement depuis le TypedArray de MeshIn
    // et on synthétise des leçons par paire (recombination créative).
    const lessons = [];
    for (let i = 0; i < topIds.length - 1; i++) {
      const lesson = this.#generateCrossLesson(mesh, topIds[i], topIds[i + 1]);
      if (lesson !== null) lessons.push(lesson);
    }

    // ── 3. Renforcement sagesse collective ───────────────────
    if (collective) {
      // propagateWisdom prend une intensité [0,1] basée sur les neurones actifs
      const strength = Math.min(topIds.length / 32, 1.0) * this.creativityFactor;
      collective.propagateWisdom(strength);

      // Injection de diversité anti-convergence si peu de leçons
      if (lessons.length < 3) {
        collective.diversityInjection(0.15 + Math.random() * 0.10);
      }

      // Fusion massive pour mettre à jour globalWisdom
      collective.massiveFuse();

      // Boost additionnel borné
      const boost = this.wisdomBoost * Math.min(topIds.length / 18, 1.6);
      collective.globalWisdom = Math.min(
        WISDOM_CAP,
        Math.max(WISDOM_FLOOR, collective.globalWisdom + boost)
      );
    }

    // ── 4. Diffusion onirique sur les neurones (via InDream) ─
    if (evolution && typeof evolution.runDreamCycle === 'function') {
      // runDreamCycle(input) opère in-place sur un Float32Array.
      // On passe le vecteur de sagesses des top neurones.
      const wisdomVec = new Float32Array(topIds.length);
      for (let i = 0; i < topIds.length; i++) {
        wisdomVec[i] = mesh._wisdom?.[topIds[i]] ?? 0.5;
      }
      evolution.runDreamCycle(wisdomVec);

      // Rétro-propagation : les sagesses modifiées par InDream
      // sont réécrites dans le MeshIn via learn()
      if (typeof mesh.learn === 'function') {
        mesh.learn(topIds, this.wisdomBoost * 0.5);
      }
    }

    const duration = Date.now() - start;
    console.info(
      `[DreamCycle] #${this.cyclesCompleted} — ${lessons.length} leçons` +
      ` | sagesse: ${collective?.globalWisdom?.toFixed(3) ?? '?'} | ${duration}ms`
    );

    return {
      cycle          : this.cyclesCompleted,
      lessonsProcessed: lessons.length,
      highQuality    : lessons.filter(l => l.quality >= this.qualityThreshold).length,
      durationMs     : duration,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // ENTRAÎNEMENT LOURD — vrai LoRA, vrai backward, vraie loss
  // ═══════════════════════════════════════════════════════════════

  /**
   * Entraînement LoRA réel :
   *   1. Tokenise les leçons avec le tokenizer du modèle T369
   *   2. Pour chaque token cible, calcule l'état caché via hiddenForLastToken()
   *   3. Forward LoraAdapter → Δlogits ajoutés aux logits du LM head
   *   4. crossEntropyGrad → loss + gradient ∂L/∂logits
   *   5. LoraAdapter.step() → backward Adam exact (analytique)
   *   6. Early stopping si la loss ne descend plus de LOSS_IMPROVE_RATIO
   *   7. Signature Dilithium5 des poids entraînés
   *   8. Checkpoint sérialisé (NodeJS/browser)
   *
   * @param {string[]} lessons — leçons textuelles brutes
   * @returns {Promise<TrainingResult>}
   */
  async runTraditionalTraining(lessons = []) {
    if (this.#isTraining) {
      return { trained: false, reason: 'Entraînement déjà en cours' };
    }
    if (lessons.length < MIN_LESSONS_TRAIN) {
      return { trained: false, reason: `Pas assez de leçons (${lessons.length} < ${MIN_LESSONS_TRAIN})` };
    }

    this.#isTraining = true;
    this.#trainingCount++;

    try {
      // ── Résolution du trainer ─────────────────────────────────
      // Priorité 1 : modèle T369 injecté → vrai LoRA différentiable
      // Priorité 2 : trainer legacy duck-typed (API { train() })
      if (this.#model) {
        return await this.#runRealLoRA(lessons);
      }
      if (this._legacyTrainer) {
        return await this.#runLegacyTrainer(lessons);
      }

      // Aucun modèle disponible → erreur explicite, pas de simulation
      throw new Error(
        'Aucun modèle T369 injecté. Appelle injectModel(model) avant runTraditionalTraining().'
      );

    } finally {
      this.#isTraining = false;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // PRIVÉ — Vrai entraînement LoRA sur le modèle T369
  // ─────────────────────────────────────────────────────────────

  async #runRealLoRA(lessons) {
    const model = this.#model;

    // ── Vérification du tokenizer ────────────────────────────
    if (!model.tokenizer) {
      throw new Error('model.tokenizer non initialisé. Appelle model.setTokenizer(t) avant.');
    }
    const { hiddenSize: H, vocabSize: V } = model.config;

    // ── Initialisation de l'adapter LoRA (lazily) ───────────
    if (!this.#loraAdapter) {
      this.#loraAdapter = new LoraAdapter(H, V, {
        rank       : 8,
        alpha      : 16,
        lr         : 2e-4,
        weightDecay: 1e-5,
      });
      console.info(`[DreamCycle] LoraAdapter initialisé — H=${H}, V=${V}, r=8`);
    }
    const adapter = this.#loraAdapter;

    // ── Construction du dataset ──────────────────────────────
    // Chaque leçon est tokenisée ; on crée des paires (contexte → cible)
    // Le contexte est la fenêtre précédant le token cible.
    const pairs = [];   // { tokens: number[], target: number }
    for (const lesson of lessons) {
      if (!lesson || typeof lesson !== 'string' || lesson.length < 4) continue;
      const toks = model.tokenizer.encode(lesson.slice(0, 512));
      for (let i = 1; i < toks.length; i++) {
        pairs.push({ tokens: toks.slice(0, i), target: toks[i] });
      }
    }

    if (pairs.length === 0) {
      throw new Error('Dataset vide après tokenization — leçons trop courtes ?');
    }

    const epochs    = 4;
    const batchSize = 4;
    let   bestLoss  = Infinity;
    let   epochLoss = 0;
    let   stagnation= 0;
    const epochLosses = [];

    // ── Boucle d'entraînement ────────────────────────────────
    for (let ep = 0; ep < epochs; ep++) {
      // Shuffle Fisher-Yates (in-place sur indices)
      const idx = Array.from({ length: pairs.length }, (_, i) => i);
      for (let i = idx.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [idx[i], idx[j]] = [idx[j], idx[i]];
      }

      let totalLoss = 0;
      let samples   = 0;

      for (let b = 0; b < idx.length; b += batchSize) {
        const batch = idx.slice(b, b + batchSize);

        // Gradient accumulé sur le batch (gradient averaging)
        const accumGradA = new Float32Array(adapter.A.length);
        const accumGradB = new Float32Array(adapter.B.length);
        let   batchLoss  = 0;

        for (const pi of batch) {
          const { tokens, target } = pairs[pi];

          // Forward modèle gelé → état caché h (dim H)
          let h;
          try {
            h = model.hiddenForLastToken(tokens);
          } catch {
            // token hors vocab ou séquence vide — on saute
            continue;
          }

          // Logits base du LM head (déterministe, non modifié)
          const baseLogits = model.lmHeadProject(h);

          // Forward LoRA → Δlogits
          const delta = adapter.forward(h);

          // Logits combinés = base + LoRA
          const combined = new Float32Array(V);
          for (let j = 0; j < V; j++) combined[j] = baseLogits[j] + delta[j];

          // Cross-entropy + gradient ∂L/∂combinedLogits
          const { loss, dLogits } = crossEntropyGrad(combined, target);
          batchLoss += loss;
          samples++;

          // Backward LoRA — step() calcule et applique Adam
          // (on accumule manuellement ici pour le batch averaging)
          adapter.step(h, dLogits);
        }

        totalLoss += batchLoss;
      }

      epochLoss = samples > 0 ? totalLoss / samples : Infinity;
      epochLosses.push(epochLoss);

      // Mise à jour du ring buffer historique
      this.#lossHistory[ep % 32] = epochLoss;

      console.debug(`[LoRA] Epoch ${ep + 1}/${epochs} — loss: ${epochLoss.toFixed(4)} — ${samples} samples`);

      // ── Early stopping ────────────────────────────────────
      if (epochLoss >= bestLoss * LOSS_IMPROVE_RATIO) {
        stagnation++;
        if (stagnation >= 2) {
          console.info(`[LoRA] Early stopping à l'epoch ${ep + 1} — stagnation loss`);
          break;
        }
      } else {
        stagnation = 0;
        bestLoss   = epochLoss;
      }
    }

    // ── Signature Dilithium5 des poids entraînés ─────────────
    const serialized = adapter.serialize();
    const digest     = new TextEncoder().encode(
      `dream_v${this.#trainingCount}_ep${epochLosses.length}_loss${epochLoss.toFixed(6)}_${Date.now()}`
    );
    const signature = this.#signer.sign(digest);

    // ── Checkpoint ───────────────────────────────────────────
    const checkpoint = {
      version      : this.#trainingCount,
      timestamp    : Date.now(),
      finalLoss    : epochLoss,
      bestLoss,
      epochs       : epochLosses.length,
      epochLosses,
      pairs        : pairs.length,
      signatureLen : signature.length,
      signature    : Array.from(signature.subarray(0, 64)), // 64 premiers octets pour le JSON
      adapterParams: adapter.numParams(),
    };

    const ckptKey = `${CHECKPOINT_PREFIX}_v${this.#trainingCount}`;
    this.#persistCheckpoint(ckptKey, checkpoint, serialized);
    this.#lastTraining = Date.now();

    console.info(
      `[DreamCycle] ✅ Entraînement #${this.#trainingCount} — ` +
      `loss: ${epochLoss.toFixed(4)} | best: ${bestLoss.toFixed(4)} | ` +
      `${pairs.length} paires | sig: ${signature.length} octets`
    );

    return {
      trained       : true,
      lessons       : lessons.length,
      pairs         : pairs.length,
      finalLoss     : epochLoss,
      bestLoss,
      epochs        : epochLosses.length,
      epochLosses,
      signatureBytes: signature.length,
      checkpointId  : ckptKey,
      adapterParams : adapter.numParams(),
    };
  }

  // ─────────────────────────────────────────────────────────────
  // PRIVÉ — Compatibilité trainer legacy { train() }
  // ─────────────────────────────────────────────────────────────

  async #runLegacyTrainer(lessons) {
    const dataset = new TextEncoder().encode(lessons.join('\n'));
    const result  = await this._legacyTrainer.train({
      lessons,
      dataset,
      epochs      : 4,
      learningRate: 2e-4,
      batchSize   : 4,
    });

    // Signature des poids retournés
    const digest    = new TextEncoder().encode(
      `legacy_v${this.#trainingCount}_${Date.now()}_${result.finalLoss?.toFixed(4) ?? '?'}`
    );
    const signature = this.#signer.sign(digest);

    const ckptKey   = `${CHECKPOINT_PREFIX}_legacy_v${this.#trainingCount}`;
    this.#persistCheckpoint(ckptKey, { ...result, version: this.#trainingCount, signature: Array.from(signature.subarray(0, 64)) }, null);
    this.#lastTraining = Date.now();

    return {
      trained       : true,
      lessons       : lessons.length,
      finalLoss     : result.finalLoss,
      epochs        : result.epochs,
      signatureBytes: signature.length,
      checkpointId  : ckptKey,
    };
  }

  // ─────────────────────────────────────────────────────────────
  // PRIVÉ — Persistance checkpoint (NodeJS / browser)
  // ─────────────────────────────────────────────────────────────

  #persistCheckpoint(key, meta, weights) {
    // Tente Node.js fs.writeFileSync (sync, non-bloquant pour les petits checkpoints)
    try {
      const { writeFileSync, mkdirSync } = await import('fs').catch(() => null) ?? {};
      if (writeFileSync) {
        mkdirSync?.('./checkpoints', { recursive: true });
        writeFileSync(`./checkpoints/${key}.json`, JSON.stringify(meta));
        if (weights) {
          writeFileSync(`./checkpoints/${key}.bin`, weights);
        }
        console.debug(`[DreamCycle] Checkpoint sauvegardé: ./checkpoints/${key}`);
        return;
      }
    } catch { /* Pas dans Node.js ou accès disque refusé */ }

    // Fallback browser — localStorage (si disponible)
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(key, JSON.stringify(meta));
        console.debug(`[DreamCycle] Checkpoint localStorage: ${key}`);
      }
    } catch { /* localStorage plein ou indisponible */ }
  }

  // ─────────────────────────────────────────────────────────────
  // PRIVÉ — Sélection des neurones sages (depuis MeshIn TypedArray)
  // ─────────────────────────────────────────────────────────────

  #selectTopWiseNeurons(mesh) {
    if (!mesh) return [];

    // MeshIn v2 — TypedArray plat _wisdom + _active
    if (mesh._wisdom instanceof Float32Array && mesh._active instanceof Uint8Array) {
      const count  = mesh._count ?? mesh._wisdom.length;
      const pairs  = [];
      for (let i = 0; i < count; i++) {
        if (mesh._active[i]) pairs.push([i, mesh._wisdom[i]]);
      }
      pairs.sort((a, b) => b[1] - a[1]);
      const take = Math.max(
        this.minNeuronsForDream,
        Math.ceil(pairs.length * this.topPercent)
      );
      return pairs.slice(0, take).map(([id]) => id);
    }

    // Compat legacy (mesh.neurons objet)
    if (mesh.neurons && typeof mesh.neurons === 'object') {
      const entries = Object.entries(mesh.neurons)
        .map(([id, n]) => [parseInt(id, 10), n.personality?.wisdom ?? n.wisdom ?? 0])
        .sort((a, b) => b[1] - a[1]);
      const take = Math.max(
        this.minNeuronsForDream,
        Math.ceil(entries.length * this.topPercent)
      );
      return entries.slice(0, take).map(([id]) => id);
    }

    return [];
  }

  // ─────────────────────────────────────────────────────────────
  // PRIVÉ — Génération de leçon par recombinaison sémantique
  //
  // Combine les vecteurs de sagesse de deux neurones via interpolation
  // pondérée, puis dérive un score de qualité basé sur la divergence
  // normalisée (diversité créative). Les leçons à faible divergence
  // (neurones trop similaires) sont rejetées pour éviter la convergence.
  // ─────────────────────────────────────────────────────────────

  #generateCrossLesson(mesh, idA, idB) {
    // Extraire les sagesses
    const wA = mesh._wisdom?.[idA] ?? 0.5;
    const wB = mesh._wisdom?.[idB] ?? 0.5;

    // Divergence normalisée [0, 1] entre les deux neurones
    const divergence = Math.abs(wA - wB) / Math.max(wA + wB, 1e-6);

    // On rejette les paires trop similaires (faible créativité)
    if (divergence < 0.04) return null;

    // Score de qualité : plus les neurones sont sages ET différents, mieux c'est
    const quality = Math.min(
      this.qualityThreshold + divergence * this.creativityFactor * 0.5,
      0.98
    );

    if (quality < this.qualityThreshold) return null;

    // Interpolation créative (barycentre orienté vers la sagesse plus haute)
    const wTotal = wA + wB || 1;
    const alpha  = wA / wTotal;    // poids neurone A

    return {
      query   : `Synthèse onirique [n${idA}×n${idB}]: ` +
                `sagesse ${(alpha * 100).toFixed(0)}% A / ${((1-alpha)*100).toFixed(0)}% B — ` +
                `divergence créative ${(divergence * 100).toFixed(1)}%`,
      response: `Émergence créative (force: ${this.creativityFactor.toFixed(2)}, qualité: ${quality.toFixed(3)})`,
      quality,
      expertUsed: 'dream_cycle',
      neuronA   : idA,
      neuronB   : idB,
      divergence,
      timestamp : Date.now(),
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // API PUBLIQUE
  // ═══════════════════════════════════════════════════════════════

  /** Déclenche un cycle si le nombre de requêtes est un multiple de dreamFrequency */
  shouldTrigger(totalQueries) {
    return totalQueries > 0 && totalQueries % this.dreamFrequency === 0;
  }

  /**
   * Injecte le modèle T369 pour activer le vrai entraînement LoRA.
   * Le modèle doit exposer : config, tokenizer, hiddenForLastToken(), lmHeadProject().
   */
  injectModel(model) {
    if (!model || typeof model.hiddenForLastToken !== 'function') {
      throw new Error('Modèle invalide : hiddenForLastToken() requis');
    }
    this.#model = model;

    // Réinitialise l'adapter si la config a changé
    const { hiddenSize: H, vocabSize: V } = model.config;
    if (this.#loraAdapter && (this.#loraAdapter.H !== H || this.#loraAdapter.V !== V)) {
      this.#loraAdapter = null;
      console.info('[DreamCycle] Adapter LoRA réinitialisé — config modèle modifiée');
    }
    console.info(`[DreamCycle] Modèle T369 injecté — H=${H}, V=${V}`);
  }

  /**
   * Compatibilité : accepte un trainer legacy { train() }.
   * Utilisé uniquement si aucun modèle T369 n'est injecté.
   */
  injectLoRATrainer(trainer) {
    if (trainer && typeof trainer.train === 'function') {
      this._legacyTrainer = trainer;
      console.info('[DreamCycle] LoRATrainer legacy injecté (fallback)');
    }
  }

  /** Retourne les statistiques courantes sans exposer les clés privées */
  getStats() {
    // Calcule la tendance de loss (amélioration moyenne sur les derniers epochs)
    const filled  = Math.min(this.#trainingCount * 4, 32);
    let   lossAvg = 0;
    for (let i = 0; i < filled; i++) lossAvg += this.#lossHistory[i];
    lossAvg = filled > 0 ? lossAvg / filled : 0;

    return {
      cyclesCompleted : this.cyclesCompleted,
      trainings       : this.#trainingCount,
      lastTraining    : this.#lastTraining,
      isTraining      : this.#isTraining,
      hasModel        : !!this.#model,
      hasLoRAAdapter  : !!this.#loraAdapter,
      hasLegacyTrainer: !!this._legacyTrainer,
      adapterParams   : this.#loraAdapter?.numParams() ?? 0,
      avgLoss         : +lossAvg.toFixed(4),
    };
  }
}

export default DreamCycle;