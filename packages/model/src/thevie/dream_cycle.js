// packages/model/src/thevie/dream_cycle.js
// =====================================================
// DreamCycle v3 — Intensif, Continu, Jamais Sauté
//
// Philosophie :
//   • Le Dream Cycle ne saute JAMAIS — si MeshIn est trop petit,
//     les neurones manquants sont créés dynamiquement (neurogenèse).
//   • Seuil d'entraînement : 1 leçon suffit (plus de blocage à 8).
//   • Le "Dream Cycle léger" devient un cycle INTENSIF :
//     toutes les étapes tournent à pleine puissance à chaque appel.
//   • qualityThreshold utilisé uniquement pour les métriques —
//     jamais pour rejeter une leçon ou sauter un cycle.
//
// Architecture :
//   runDreamCycle()       — Dream intensif : neurogenèse + recombinaison
//                           sémantique multi-passes + diffusion onirique
//                           + propagation sagesse + rétro-propagation MeshIn
//   runTraditionalTraining() — vrai backward LoRA, 1 leçon suffit
//   #ensureMinNeurons()   — neurogenèse dynamique si mesh trop petit
//
// SkyAInet × Thevie × Nikola T369
// =====================================================

"use strict";

import { Dilithium5Signer }                from '../../../secure/src/crypto/dilithium.js';
import { LoraAdapter, crossEntropyGrad }   from '../../node/src/lora_trainer.js';

// ─────────────────────────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────────────────────────

// Seuil d'entraînement : 1 leçon suffit pour lancer un training
const MIN_LESSONS_TRAIN  = 1;

// Neurones minimaux pour le Dream Cycle
// Si mesh en dessous → neurogenèse dynamique, jamais de skip
const MIN_NEURONS_DREAM  = 1;

const WISDOM_FLOOR       = 0.50;
const WISDOM_CAP         = 0.990;
const LOSS_IMPROVE_RATIO = 0.98;
const CHECKPOINT_PREFIX  = 'dream_ckpt';

// Intensité du Dream Cycle
// Nombre de passes de recombinaison sémantique par cycle
const DREAM_PASSES       = 3;

// Divergence minimale pour la recombinaison — abaissée pour plus de leçons
const MIN_DIVERGENCE     = 0.01;

// ─────────────────────────────────────────────────────────────────
// DREAM CYCLE
// ─────────────────────────────────────────────────────────────────

export class DreamCycle {

  // ── Champs privés ─────────────────────────────────────────────
  #signer;
  #loraAdapter;
  #model;
  #trainingCount;
  #lastTraining;
  #isTraining;
  #lossHistory;         // Float32Array ring buffer 32
  #dreamLessonsTotal;   // compteur total de leçons générées par le Dream

  constructor(opts = {}) {
    // Paramètres publics — valeurs par défaut intensives
    this.dreamFrequency    = opts.dreamFrequency    ?? 75;
    this.wisdomBoost       = opts.wisdomBoost       ?? 0.032;
    this.topPercent        = opts.topPercent        ?? 0.35;   // plus de neurones sélectionnés
    this.creativityFactor  = opts.creativityFactor  ?? 0.55;   // plus de créativité
    this.cyclesCompleted   = 0;
    this.minNeuronsForDream= MIN_NEURONS_DREAM;                // 1 — jamais de skip
    this.qualityThreshold  = opts.qualityThreshold  ?? 0.82;   // métrique seulement

    this.#signer           = new Dilithium5Signer();
    this.#loraAdapter      = null;
    this.#model            = opts.model ?? null;
    this.#trainingCount    = 0;
    this.#lastTraining     = null;
    this.#isTraining       = false;
    this.#lossHistory      = new Float32Array(32);
    this.#dreamLessonsTotal= 0;

    if (opts.loraTrainer && typeof opts.loraTrainer.train === 'function') {
      this._legacyTrainer = opts.loraTrainer;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // DREAM CYCLE INTENSIF
  //
  // Le cycle ne saute JAMAIS :
  //   • Si mesh null/vide     → neurogenèse dynamique (crée les neurones)
  //   • Si collective null    → sagesse locale estimée depuis le mesh
  //   • Si evolution null     → diffusion interne de secours
  //
  // Étapes (toutes tournent à chaque appel, sans condition de saut) :
  //   1. Neurogenèse — s'assurer que mesh a assez de neurones actifs
  //   2. Sélection   — top neurones sages (topPercent du mesh)
  //   3. Multi-passes recombinaison — DREAM_PASSES passes de cross-lessons
  //   4. Propagation sagesse collective (propagateWisdom + massiveFuse)
  //   5. Diffusion onirique via InDream (in-place, Float32Array)
  //   6. Rétro-propagation MeshIn — sagesses modifiées réinjectées
  //   7. Diversité anti-convergence si peu de leçons générées
  // ═══════════════════════════════════════════════════════════════

  /**
   * @param {MeshIn|null}      mesh       — réseau neuronal (créé si null)
   * @param {CollectivIn|null} collective — conscience collective
   * @param {InDream|null}     evolution  — moteur de diffusion onirique
   */
  async runDreamCycle(mesh, collective, evolution) {
    this.cyclesCompleted++;
    const start = Date.now();

    // ── 1. Neurogenèse dynamique ──────────────────────────────
    // Si mesh absent ou trop petit, on crée les neurones manquants.
    // Le cycle ne saute JAMAIS à cause d'un manque de neurones.
    mesh = this.#ensureMinNeurons(mesh);

    // ── 2. Sélection des neurones sages ──────────────────────
    // Prend topPercent du mesh — minimum 1 neurone garanti par #ensureMinNeurons
    let topIds = this.#selectTopWiseNeurons(mesh);

    // Cas extrême : mesh tout juste créé, 1 seul neurone
    // → on travaille quand même avec ce neurone unique
    if (topIds.length === 0) topIds = [0];

    // ── 3. Multi-passes recombinaison sémantique ─────────────
    // DREAM_PASSES passes — chaque passe génère de nouvelles leçons
    // en combinant tous les neurones disponibles (pas juste les paires).
    const allLessons = [];

    for (let pass = 0; pass < DREAM_PASSES; pass++) {
      // Variation de l'intensité créative par passe (montée progressive)
      const passCreativity = this.creativityFactor * (1 + pass * 0.2);

      for (let i = 0; i < topIds.length; i++) {
        for (let j = i + 1; j < topIds.length; j++) {
          const lesson = this.#generateCrossLesson(
            mesh, topIds[i], topIds[j], passCreativity
          );
          if (lesson !== null) allLessons.push(lesson);
        }
        // Auto-recombinaison : neurone avec lui-même à créativité boostée
        // → génère des leçons d'auto-approfondissement
        if (topIds.length === 1) {
          const selfLesson = this.#generateSelfLesson(mesh, topIds[i], passCreativity);
          if (selfLesson) allLessons.push(selfLesson);
        }
      }
    }

    this.#dreamLessonsTotal += allLessons.length;

    // ── 4. Propagation sagesse collective ────────────────────
    if (collective) {
      // Plus de neurones actifs → propagation plus forte
      const strength = Math.min(topIds.length / 16, 1.0) * this.creativityFactor;
      collective.propagateWisdom(strength);

      // Anti-convergence : injection systématique de diversité
      // (pas conditionnelle — toujours active pour maintenir la richesse)
      const diversityStrength = 0.12 + Math.random() * 0.15;
      collective.diversityInjection(diversityStrength);

      // Fusion massive — met à jour globalWisdom
      collective.massiveFuse();

      // Boost de sagesse borné entre FLOOR et CAP
      const boost = this.wisdomBoost * Math.min(topIds.length / 12, 2.0);
      collective.globalWisdom = Math.min(
        WISDOM_CAP,
        Math.max(WISDOM_FLOOR, collective.globalWisdom + boost)
      );
    }

    // ── 5. Diffusion onirique (InDream) ──────────────────────
    // Opère in-place sur le vecteur de sagesses — zéro allocation externe
    const wisdomVec = new Float32Array(topIds.length);
    for (let i = 0; i < topIds.length; i++) {
      wisdomVec[i] = mesh._wisdom?.[topIds[i]] ?? 0.5;
    }

    if (evolution && typeof evolution.runDreamCycle === 'function') {
      // Plusieurs passes de diffusion pour un effet plus profond
      evolution.runDreamCycle(wisdomVec);
      evolution.runDreamCycle(wisdomVec); // 2e passe — intensification
    } else {
      // Diffusion de secours si InDream absent — perturbation créative interne
      this.#internalDiffusion(wisdomVec);
    }

    // ── 6. Rétro-propagation MeshIn ──────────────────────────
    // Les sagesses modifiées par la diffusion sont réinjectées dans le mesh
    if (typeof mesh.learn === 'function') {
      mesh.learn(topIds, this.wisdomBoost * 0.6);
    } else if (mesh._wisdom instanceof Float32Array) {
      // Rétro-propagation directe sur le TypedArray si learn() absent
      for (let i = 0; i < topIds.length; i++) {
        const id = topIds[i];
        mesh._wisdom[id] = Math.min(
          WISDOM_CAP,
          Math.max(0, mesh._wisdom[id] + wisdomVec[i] * this.wisdomBoost * 0.3)
        );
      }
    }

    // ── 7. Connexions Hebbiannes inter-neurones ───────────────
    // Renforcer les synapses entre les neurones qui ont co-activé
    if (typeof mesh.hebbianUpdate === 'function') {
      for (let i = 0; i < Math.min(topIds.length - 1, 8); i++) {
        mesh.hebbianUpdate(topIds[i], topIds[i + 1], true);
      }
    }

    const duration = Date.now() - start;
    console.info(
      `[DreamCycle] #${this.cyclesCompleted} — ${allLessons.length} leçons` +
      ` (${DREAM_PASSES} passes) | neurones: ${topIds.length}` +
      ` | sagesse: ${collective?.globalWisdom?.toFixed(3) ?? 'local'}` +
      ` | ${duration}ms`
    );

    return {
      cycle           : this.cyclesCompleted,
      lessonsProcessed: allLessons.length,
      highQuality     : allLessons.filter(l => l.quality >= this.qualityThreshold).length,
      neuronsUsed     : topIds.length,
      passes          : DREAM_PASSES,
      durationMs      : duration,
      dreamLessonsTotal: this.#dreamLessonsTotal,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // ENTRAÎNEMENT LOURD — seuil 1 leçon, vrai LoRA backward
  // ═══════════════════════════════════════════════════════════════

  /**
   * @param {string[]} lessons — 1 leçon suffit pour déclencher l'entraînement
   */
  async runTraditionalTraining(lessons = []) {
    if (this.#isTraining) {
      return { trained: false, reason: 'Training already running' };
    }
    // Seuil 1 — jamais de rejet pour manque de leçons
    if (lessons.length < MIN_LESSONS_TRAIN) {
      return { trained: false, reason: 'Bus empty — no lessons available' };
    }

    this.#isTraining = true;
    this.#trainingCount++;

    try {
      if (this.#model)         return await this.#runRealLoRA(lessons);
      if (this._legacyTrainer) return await this.#runLegacyTrainer(lessons);
      throw new Error('No T369 model injected. Call injectModel(model) first.');
    } finally {
      this.#isTraining = false;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // PRIVÉ — Neurogenèse dynamique
  //
  // S'assure que le mesh a au moins MIN_NEURONS_DREAM neurones actifs.
  // Si le mesh est null ou trop petit, crée les neurones manquants.
  // Retourne toujours un mesh valide — jamais null.
  // ─────────────────────────────────────────────────────────────

  #ensureMinNeurons(mesh) {
    // Mesh null → créer un mesh minimal in-memory
    if (!mesh) {
      mesh = this.#createMinimalMesh(4);
      console.debug('[DreamCycle] Mesh absent — mesh minimal créé (4 neurones)');
      return mesh;
    }

    // Compter les neurones actifs
    let activeCount = 0;
    if (mesh._active instanceof Uint8Array) {
      for (let i = 0; i < (mesh._count ?? mesh._active.length); i++) {
        if (mesh._active[i]) activeCount++;
      }
    } else if (mesh.neurons) {
      activeCount = Object.keys(mesh.neurons).length;
    }

    // Assez de neurones → rien à faire
    if (activeCount >= MIN_NEURONS_DREAM) return mesh;

    // Neurogenèse : ajouter les neurones manquants
    const needed = MIN_NEURONS_DREAM - activeCount;
    console.debug(`[DreamCycle] Neurogenèse — ajout de ${needed} neurone(s)`);

    if (typeof mesh.addNeuron === 'function') {
      for (let i = 0; i < needed; i++) {
        // Sagesse initiale aléatoire entre 0.5 et 0.8 pour un démarrage sain
        mesh.addNeuron(0.5 + Math.random() * 0.3);
      }
    } else if (mesh._wisdom instanceof Float32Array && mesh._active instanceof Uint8Array) {
      // Insertion directe dans les TypedArrays si addNeuron absent
      const count = mesh._count ?? 0;
      for (let i = 0; i < needed; i++) {
        const idx = count + i;
        if (idx < mesh._wisdom.length) {
          mesh._wisdom[idx] = 0.5 + Math.random() * 0.3;
          mesh._active[idx] = 1;
        }
      }
      if (mesh._count !== undefined) mesh._count += needed;
    } else {
      // Dernier recours : mesh minimal complet
      mesh = this.#createMinimalMesh(Math.max(4, MIN_NEURONS_DREAM));
    }

    return mesh;
  }

  /** Crée un mesh minimal in-memory pour les cas où aucun mesh n'est disponible. */
  #createMinimalMesh(size) {
    const wisdom = new Float32Array(size).map(() => 0.5 + Math.random() * 0.3);
    const active = new Uint8Array(size).fill(1);
    return {
      _wisdom: wisdom,
      _active: active,
      _count : size,
      learn  : (ids, boost) => {
        for (const id of ids) {
          if (id < wisdom.length) wisdom[id] = Math.min(WISDOM_CAP, wisdom[id] + boost);
        }
      },
      hebbianUpdate: () => {},
    };
  }

  // ─────────────────────────────────────────────────────────────
  // PRIVÉ — Sélection des neurones sages (TypedArray + legacy)
  // ─────────────────────────────────────────────────────────────

  #selectTopWiseNeurons(mesh) {
    if (!mesh) return [];

    // MeshIn v2 — TypedArray plat
    if (mesh._wisdom instanceof Float32Array && mesh._active instanceof Uint8Array) {
      const count = mesh._count ?? mesh._wisdom.length;
      const pairs = [];
      for (let i = 0; i < count; i++) {
        if (mesh._active[i]) pairs.push([i, mesh._wisdom[i]]);
      }
      pairs.sort((a, b) => b[1] - a[1]);
      // Prendre au moins 1, au plus topPercent du mesh
      const take = Math.max(1, Math.ceil(pairs.length * this.topPercent));
      return pairs.slice(0, take).map(([id]) => id);
    }

    // Legacy (mesh.neurons objet)
    if (mesh.neurons && typeof mesh.neurons === 'object') {
      const entries = Object.entries(mesh.neurons)
        .map(([id, n]) => [parseInt(id, 10), n.personality?.wisdom ?? n.wisdom ?? 0])
        .sort((a, b) => b[1] - a[1]);
      const take = Math.max(1, Math.ceil(entries.length * this.topPercent));
      return entries.slice(0, take).map(([id]) => id);
    }

    return [];
  }

  // ─────────────────────────────────────────────────────────────
  // PRIVÉ — Recombinaison sémantique entre deux neurones
  // ─────────────────────────────────────────────────────────────

  #generateCrossLesson(mesh, idA, idB, creativityOverride = null) {
    const wA  = mesh._wisdom?.[idA] ?? 0.5;
    const wB  = mesh._wisdom?.[idB] ?? 0.5;
    const cf  = creativityOverride ?? this.creativityFactor;

    // Divergence normalisée [0, 1]
    const divergence = Math.abs(wA - wB) / Math.max(wA + wB, 1e-6);

    // Seuil abaissé — MIN_DIVERGENCE = 0.01, presque toujours généré
    if (divergence < MIN_DIVERGENCE) return null;

    const quality  = Math.min(0.5 + divergence * cf * 0.8, 0.98);
    const wTotal   = wA + wB || 1;
    const alpha    = wA / wTotal;

    return {
      query     : `Dream synthesis [n${idA}×n${idB}]: ` +
                  `wisdom ${(alpha * 100).toFixed(0)}%A / ${((1 - alpha) * 100).toFixed(0)}%B` +
                  ` — creative divergence ${(divergence * 100).toFixed(1)}%`,
      response  : `Creative emergence (factor: ${cf.toFixed(2)}, quality: ${quality.toFixed(3)})`,
      quality,
      expertUsed: 'dream_cycle',
      neuronA   : idA,
      neuronB   : idB,
      divergence,
      timestamp : Date.now(),
    };
  }

  // ─────────────────────────────────────────────────────────────
  // PRIVÉ — Auto-recombinaison (neurone unique → auto-approfondissement)
  // Utilisé quand le mesh n'a qu'un seul neurone actif
  // ─────────────────────────────────────────────────────────────

  #generateSelfLesson(mesh, id, creativityOverride = null) {
    const w  = mesh._wisdom?.[id] ?? 0.5;
    const cf = creativityOverride ?? this.creativityFactor;

    return {
      query     : `Self-deepening dream [n${id}]: wisdom ${(w * 100).toFixed(1)}%`,
      response  : `Internal consolidation (factor: ${cf.toFixed(2)}, wisdom: ${w.toFixed(3)})`,
      quality   : Math.min(w * cf + 0.2, 0.98),
      expertUsed: 'dream_cycle_self',
      neuronA   : id,
      neuronB   : id,
      divergence: 0,
      timestamp : Date.now(),
    };
  }

  // ─────────────────────────────────────────────────────────────
  // PRIVÉ — Diffusion interne de secours (si InDream absent)
  // Perturbation créative pondérée par creativityFactor
  // ─────────────────────────────────────────────────────────────

  #internalDiffusion(vec) {
    const cf = this.creativityFactor;
    for (let i = 0; i < vec.length; i++) {
      const perturbed = Math.sin(vec[i] * 1.12) * cf + vec[i] * (1 - cf);
      vec[i] = Math.max(0, Math.min(WISDOM_CAP, perturbed * 1.02));
    }
  }

  // ─────────────────────────────────────────────────────────────
  // PRIVÉ — Vrai entraînement LoRA sur le modèle T369
  // ─────────────────────────────────────────────────────────────

  async #runRealLoRA(lessons) {
    const model = this.#model;
    if (!model.tokenizer) {
      throw new Error('model.tokenizer not initialized. Call model.setTokenizer(t) first.');
    }
    const { hiddenSize: H, vocabSize: V } = model.config;

    if (!this.#loraAdapter || this.#loraAdapter.H !== H) {
      this.#loraAdapter = new LoraAdapter(H, V, {
        rank       : 8,
        alpha      : 16,
        lr         : 2e-4,
        weightDecay: 1e-5,
      });
      console.info(`[DreamCycle] LoraAdapter initialized — H=${H}, V=${V}, r=8`);
    }
    const adapter = this.#loraAdapter;

    // Dataset — toutes les leçons, aucune rejetée
    const pairs = [];
    for (const lesson of lessons) {
      if (!lesson?.trim()) continue;
      const toks = model.tokenizer.encode(lesson.slice(0, 512));
      for (let i = 1; i < toks.length; i++) {
        pairs.push({ tokens: toks.slice(0, i), target: toks[i] });
      }
    }

    if (pairs.length === 0) {
      throw new Error('Empty dataset after tokenization.');
    }

    const EPOCHS    = 4;
    const BSIZE     = 4;
    let   bestLoss  = Infinity;
    let   finalLoss = Infinity;
    let   stagnation = 0;
    const epochLosses = [];

    for (let ep = 0; ep < EPOCHS; ep++) {
      const idx = Array.from({ length: pairs.length }, (_, i) => i);
      for (let i = idx.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [idx[i], idx[j]] = [idx[j], idx[i]];
      }

      let total = 0, n = 0;
      for (let b = 0; b < idx.length; b += BSIZE) {
        for (const pi of idx.slice(b, b + BSIZE)) {
          const { tokens, target } = pairs[pi];
          let h;
          try { h = model.hiddenForLastToken(tokens); } catch { continue; }

          const base     = model.lmHeadProject(h);
          const delta    = adapter.forward(h);
          const combined = new Float32Array(V);
          for (let j = 0; j < V; j++) combined[j] = base[j] + delta[j];

          const { loss, dLogits } = crossEntropyGrad(combined, target);
          adapter.step(h, dLogits);
          total += loss; n++;
        }
      }

      finalLoss = n > 0 ? total / n : Infinity;
      epochLosses.push(finalLoss);
      this.#lossHistory[ep % 32] = finalLoss;
      console.debug(`[LoRA] Epoch ${ep + 1}/${EPOCHS} — loss: ${finalLoss.toFixed(4)} (${n} samples)`);

      if (finalLoss >= bestLoss * LOSS_IMPROVE_RATIO) {
        if (++stagnation >= 2) break;
      } else { stagnation = 0; bestLoss = finalLoss; }
    }

    const serialized = adapter.serialize();
    const digest     = new TextEncoder().encode(
      `weights_v${this.#trainingCount}_${Date.now()}_${finalLoss.toFixed(6)}`
    );
    const signature = this.#signer.sign(digest);

    const meta = {
      version   : this.#trainingCount,
      timestamp : Date.now(),
      finalLoss, bestLoss,
      epochs    : epochLosses.length, epochLosses,
      pairs     : pairs.length, lessons: lessons.length,
      signature : Array.from(signature.subarray(0, 64)),
    };

    const ckptKey = `${CHECKPOINT_PREFIX}_v${this.#trainingCount}`;
    this.#persistCheckpoint(ckptKey, meta, serialized);
    this.#lastTraining = Date.now();

    console.info(
      `[DreamCycle] ✅ Training #${this.#trainingCount} — ` +
      `loss: ${finalLoss.toFixed(4)} | best: ${bestLoss.toFixed(4)} | ` +
      `${pairs.length} pairs | sig: ${signature.length}B`
    );

    return {
      trained: true, lessons: lessons.length, pairs: pairs.length,
      finalLoss, bestLoss, epochs: epochLosses.length, epochLosses,
      signatureBytes: signature.length, checkpointId: ckptKey,
      adapterParams: adapter.numParams(),
    };
  }

  // ─────────────────────────────────────────────────────────────
  // PRIVÉ — Trainer legacy { train() }
  // ─────────────────────────────────────────────────────────────

  async #runLegacyTrainer(lessons) {
    const result  = await this._legacyTrainer.train({
      lessons, dataset: new TextEncoder().encode(lessons.join('\n')),
      epochs: 4, learningRate: 2e-4, batchSize: 4,
    });
    const digest    = new TextEncoder().encode(
      `legacy_v${this.#trainingCount}_${Date.now()}_${result.finalLoss?.toFixed(4) ?? '?'}`
    );
    const signature = this.#signer.sign(digest);
    const ckptKey   = `${CHECKPOINT_PREFIX}_legacy_v${this.#trainingCount}`;
    this.#persistCheckpoint(ckptKey, { ...result, version: this.#trainingCount,
      signature: Array.from(signature.subarray(0, 64)) }, null);
    this.#lastTraining = Date.now();
    return {
      trained: true, lessons: lessons.length,
      finalLoss: result.finalLoss, epochs: result.epochs,
      signatureBytes: signature.length, checkpointId: ckptKey,
    };
  }

  // ─────────────────────────────────────────────────────────────
  // PRIVÉ — Persistance checkpoint (Node.js → ZipMemory → skip)
  // ─────────────────────────────────────────────────────────────

  async #persistCheckpoint(key, meta, weights) {
    try {
      const fs = await import('fs/promises').catch(() => null);
      if (fs) {
        await fs.mkdir('./checkpoints', { recursive: true });
        await fs.writeFile(`./checkpoints/${key}.json`, JSON.stringify(meta));
        if (weights) await fs.writeFile(`./checkpoints/${key}.bin`, weights);
        console.debug(`[DreamCycle] Checkpoint saved: ./checkpoints/${key}`);
        return;
      }
    } catch { /* Not Node.js or write access denied */ }
    // Silent skip in browser — no localStorage dependency
    console.debug(`[DreamCycle] Checkpoint skipped (not Node.js): ${key}`);
  }

  // ═══════════════════════════════════════════════════════════════
  // API PUBLIQUE
  // ═══════════════════════════════════════════════════════════════

  /** true si le nombre de requêtes atteint le seuil de déclenchement */
  shouldTrigger(totalQueries) {
    return totalQueries > 0 && totalQueries % this.dreamFrequency === 0;
  }

  /** Injecte le modèle T369 pour activer le vrai LoRA backward */
  injectModel(model) {
    if (!model || typeof model.hiddenForLastToken !== 'function') {
      throw new Error('Invalid model: hiddenForLastToken() required');
    }
    this.#model = model;
    const { hiddenSize: H, vocabSize: V } = model.config;
    if (this.#loraAdapter && (this.#loraAdapter.H !== H || this.#loraAdapter.V !== V)) {
      this.#loraAdapter = null;
      console.info('[DreamCycle] LoRA adapter reset — model config changed');
    }
    console.info(`[DreamCycle] T369 model injected — H=${H}, V=${V}`);
  }

  injectLoRATrainer(trainer) {
    if (trainer && typeof trainer.train === 'function') {
      this._legacyTrainer = trainer;
      console.info('[DreamCycle] Legacy LoRATrainer injected (fallback)');
    }
  }

  getStats() {
    const filled  = Math.min(this.#trainingCount * 4, 32);
    let   lossAvg = 0;
    for (let i = 0; i < filled; i++) lossAvg += this.#lossHistory[i];

    return {
      cyclesCompleted   : this.cyclesCompleted,
      trainings         : this.#trainingCount,
      lastTraining      : this.#lastTraining,
      isTraining        : this.#isTraining,
      hasModel          : !!this.#model,
      hasLoRAAdapter    : !!this.#loraAdapter,
      hasLegacyTrainer  : !!this._legacyTrainer,
      adapterParams     : this.#loraAdapter?.numParams() ?? 0,
      avgLoss           : filled > 0 ? +(lossAvg / filled).toFixed(4) : null,
      dreamLessonsTotal : this.#dreamLessonsTotal,
      dreamPasses       : DREAM_PASSES,
      minNeuronsForDream: MIN_NEURONS_DREAM,
    };
  }
}

export default DreamCycle;