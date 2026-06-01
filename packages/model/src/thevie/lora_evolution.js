// packages/model/src/thevie/lora_evolution.js
// LoraEvo — Guide Intelligent & Auto-Évolutif
// Connecté à T369Inference + LoRA Training réel (forward/backward Adam)
// SkyAInet × Thevie × Nikola T369

"use strict";

import { Dilithium5Signer }              from '../../../secure/src/crypto/dilithium.js';
import { LoraAdapter, crossEntropyGrad } from '../../node/src/lora_trainer.js';
import { writeFile, mkdir }              from 'fs/promises';

// ─────────────────────────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────────────────────────

const STM_MAX           = 40;   // taille max mémoire court-terme
const LTM_MAX           = 25;   // taille max mémoire long-terme
const LTM_MIN_CHARS     = 120;  // longueur min pour archivage long-terme
const EVOLVE_EVERY      = 15;   // interactions entre chaque boost d'évolution
const EVOLVE_BOOST      = 0.009;
const MIN_LESSONS_TRAIN = 8;
const LOSS_STAGNATION   = 0.98; // early stopping : amélioration < 2 %
const CHECKPOINT_DIR    = './checkpoints';

// ─────────────────────────────────────────────────────────────────
// SPÉCIALISATIONS — détection par mots-clés + compteurs d'exposition
// ─────────────────────────────────────────────────────────────────

const SPECIALIZATIONS = [
  { name: 'Technique & Programmation', keys: ['code','rust','python','javascript','bug','function','algorithm','technique','debug'] },
  { name: 'Éthique & Philosophie',     keys: ['éthique','ethique','philosoph','moral','valeur','justice','liberté','conscience'] },
  { name: 'Créativité & Imagination',  keys: ['créatif','creatif','rêve','reve','histoire','poème','art','imagin','fiction'] },
  { name: 'Science & Données',         keys: ['science','données','data','statistique','recherche','analyse','modèle','neural'] },
  { name: 'Guide Polyvalent',          keys: [] },  // défaut
];

/** Détecte la spécialisation la plus pertinente pour un prompt */
function detectSpecialization(prompt, exposures) {
  const lower = prompt.toLowerCase();
  let   best  = SPECIALIZATIONS[SPECIALIZATIONS.length - 1];
  let   bestScore = 0;

  for (const spec of SPECIALIZATIONS) {
    const hits = spec.keys.filter(k => lower.includes(k)).length;
    // Pondère par l'exposition cumulée (renforcement progressif)
    const score = hits + (exposures.get(spec.name) ?? 0) * 0.1;
    if (score > bestScore) { bestScore = score; best = spec; }
  }
  return best.name;
}

// ─────────────────────────────────────────────────────────────────
// PROFIL D'ÉVOLUTION
// ─────────────────────────────────────────────────────────────────

export class EvolutionProfile {
  constructor() {
    this.ethics        = 0.82;
    this.technical     = 0.75;
    this.creativity    = 0.78;
    this.wisdom        = 0.80;
    this.userAlignment = 0.85;
  }

  /** Met à jour les dimensions selon le type de spécialisation courant */
  adapt(specialization) {
    switch (specialization) {
      case 'Technique & Programmation':
        this.technical     = Math.min(0.99, this.technical     + 0.005);
        this.wisdom        = Math.min(0.99, this.wisdom        + 0.002);
        break;
      case 'Éthique & Philosophie':
        this.ethics        = Math.min(0.99, this.ethics        + 0.005);
        this.wisdom        = Math.min(0.99, this.wisdom        + 0.004);
        break;
      case 'Créativité & Imagination':
        this.creativity    = Math.min(0.99, this.creativity    + 0.006);
        this.userAlignment = Math.min(0.99, this.userAlignment + 0.002);
        break;
      case 'Science & Données':
        this.technical     = Math.min(0.99, this.technical     + 0.004);
        this.wisdom        = Math.min(0.99, this.wisdom        + 0.003);
        break;
      default:
        this.userAlignment = Math.min(0.99, this.userAlignment + 0.003);
    }
  }

  toJSON() {
    return {
      ethics: +this.ethics.toFixed(4),       technical  : +this.technical.toFixed(4),
      creativity: +this.creativity.toFixed(4), wisdom    : +this.wisdom.toFixed(4),
      userAlignment: +this.userAlignment.toFixed(4),
    };
  }
}

// ─────────────────────────────────────────────────────────────────
// LORA EVO
// ─────────────────────────────────────────────────────────────────

export class LoraEvo {
  // Champs privés
  #signer;
  #loraAdapter;       // LoraAdapter | null
  #trainingCount;
  #isTraining;
  #lossHistory;       // Float32Array ring buffer 32
  #exposures;         // Map<specialization, count> pour détection progressive
  #inferenceEngine;   // T369Inference | null

  constructor() {
    this.modelName              = 'LoraEvo';
    this.shortTermMemory        = [];       // string[]  — résumés d'interactions récentes
    this.longTermKnowledge      = [];       // string[]  — réponses denses mémorisées
    this.evolutionProfile       = new EvolutionProfile();
    this.totalInteractions      = 0;
    this.evolutionScore         = 0.68;
    this.currentSpecialization  = 'Guide Polyvalent';
    this.lastAdaptation         = Date.now();

    this.#signer        = new Dilithium5Signer();
    this.#loraAdapter   = null;
    this.#trainingCount = 0;
    this.#isTraining    = false;
    this.#lossHistory   = new Float32Array(32);
    this.#exposures     = new Map();
    this.#inferenceEngine = null;
  }

  // ═══════════════════════════════════════════════════════════════
  // CONNEXION AU MOTEUR T369
  // ═══════════════════════════════════════════════════════════════

  connectToInference(engine) {
    if (!engine || typeof engine.generate !== 'function') {
      throw new Error('Moteur invalide : generate() requis');
    }
    this.#inferenceEngine = engine;
    console.info('[LoraEvo] Connecté au moteur T369Inference');
  }

  // ═══════════════════════════════════════════════════════════════
  // GÉNÉRATION AVEC APPRENTISSAGE EN TEMPS RÉEL
  // ═══════════════════════════════════════════════════════════════

  async generate(prompt, maxTokens = 256) {
    if (!this.#inferenceEngine) {
      throw new Error("LoraEvo n'est pas connectée au moteur d'inférence");
    }

    const enhanced = this.#buildContextualPrompt(prompt);

    let response;
    try {
      response = await this.#inferenceEngine.generate(enhanced, maxTokens);
    } catch (e) {
      console.warn('[LoraEvo] Erreur T369Inference:', e.message);
      throw e;
    }

    // Apprentissage synchrone léger — pas de LoRA ici, juste mise à jour
    // des mémoires et du profil d'évolution
    this.#learnFromInteraction(prompt, response);
    this.totalInteractions++;
    this.#adaptEvolution();

    console.debug(
      `[LoraEvo] Réponse | évolution: ${this.evolutionScore.toFixed(3)}` +
      ` | interactions: ${this.totalInteractions}` +
      ` | spéc: ${this.currentSpecialization}`
    );

    return response;
  }

  // ═══════════════════════════════════════════════════════════════
  // ENTRAÎNEMENT LOURD — vrai LoRA forward/backward sur T369
  // ═══════════════════════════════════════════════════════════════

  /**
   * @param {object} opts
   * @param {string[]} opts.lessons      — leçons textuelles
   * @param {number}   opts.epochs       — défaut 4
   * @param {number}   opts.learningRate — défaut 2e-4
   * @param {number}   opts.batchSize    — défaut 4
   */
  async train({ lessons = [], epochs = 4, learningRate = 2e-4, batchSize = 4 } = {}) {
    if (this.#isTraining) {
      return { trained: false, reason: 'Entraînement déjà en cours' };
    }
    if (lessons.length < MIN_LESSONS_TRAIN) {
      return { trained: false, reason: `Pas assez de leçons (${lessons.length} < ${MIN_LESSONS_TRAIN})` };
    }

    // Résolution du modèle T369
    const model = this.#inferenceEngine?.model ?? null;
    if (!model || typeof model.hiddenForLastToken !== 'function') {
      throw new Error(
        'Modèle T369 inaccessible. Appelle connectToInference(engine) avec un moteur chargé.'
      );
    }
    if (!model.tokenizer) {
      throw new Error('model.tokenizer non initialisé — appelle engine.loadTokenizer() avant.');
    }

    this.#isTraining = true;
    this.#trainingCount++;

    try {
      const { hiddenSize: H, vocabSize: V } = model.config;

      // Initialisation lazye de l'adapter LoRA
      if (!this.#loraAdapter || this.#loraAdapter.H !== H || this.#loraAdapter.V !== V) {
        this.#loraAdapter = new LoraAdapter(H, V, {
          rank: 8, alpha: 16, lr: learningRate, weightDecay: 1e-5,
        });
        console.info(`[LoraEvo] LoraAdapter initialisé — H=${H}, V=${V}, r=8`);
      } else {
        // Met à jour le lr si différent
        this.#loraAdapter.lr = learningRate;
      }
      const adapter = this.#loraAdapter;

      // ── Dataset — paires (contexte → token suivant) ────────
      const pairs = [];
      for (const lesson of lessons) {
        if (!lesson || lesson.length < 8) continue;
        const toks = model.tokenizer.encode(lesson.slice(0, 512));
        for (let i = 1; i < toks.length; i++) {
          pairs.push({ tokens: toks.slice(0, i), target: toks[i] });
        }
      }
      if (pairs.length === 0) throw new Error('Dataset vide après tokenization.');

      // ── Boucle d'entraînement ──────────────────────────────
      let bestLoss  = Infinity;
      let finalLoss = Infinity;
      let stagnation = 0;
      const epochLosses = [];

      for (let ep = 0; ep < epochs; ep++) {
        // Shuffle Fisher-Yates
        const idx = Array.from({ length: pairs.length }, (_, i) => i);
        for (let i = idx.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [idx[i], idx[j]] = [idx[j], idx[i]];
        }

        let total = 0, n = 0;

        for (let b = 0; b < idx.length; b += batchSize) {
          for (let s = b; s < Math.min(b + batchSize, idx.length); s++) {
            const { tokens, target } = pairs[idx[s]];
            let h;
            try { h = model.hiddenForLastToken(tokens); }
            catch { continue; }

            const baseLogits = model.lmHeadProject(h);
            const delta      = adapter.forward(h);
            const combined   = new Float32Array(V);
            for (let j = 0; j < V; j++) combined[j] = baseLogits[j] + delta[j];

            const { loss, dLogits } = crossEntropyGrad(combined, target);
            adapter.step(h, dLogits);
            total += loss; n++;
          }
        }

        finalLoss = n > 0 ? total / n : Infinity;
        epochLosses.push(finalLoss);
        this.#lossHistory[ep % 32] = finalLoss;

        console.debug(`[LoraEvo] Epoch ${ep + 1}/${epochs} — loss: ${finalLoss.toFixed(4)} (${n} samples)`);

        // Early stopping
        if (finalLoss >= bestLoss * LOSS_STAGNATION) {
          if (++stagnation >= 2) { console.info(`[LoraEvo] Early stopping epoch ${ep + 1}`); break; }
        } else { stagnation = 0; bestLoss = finalLoss; }
      }

      // ── Signature Dilithium5 ────────────────────────────────
      const serialized = adapter.serialize();
      const digest     = new TextEncoder().encode(
        `loraevo_v${this.#trainingCount}_${Date.now()}_${finalLoss.toFixed(6)}`
      );
      const signature = this.#signer.sign(digest);

      // ── Checkpoint ─────────────────────────────────────────
      const meta = {
        version: this.#trainingCount, timestamp: Date.now(),
        finalLoss, bestLoss, epochs: epochLosses.length, epochLosses,
        pairs: pairs.length, lessons: lessons.length,
        signature: Array.from(signature.subarray(0, 64)),
      };
      await this.#persistCheckpoint(`loraevo_v${this.#trainingCount}`, meta, serialized);

      // Boost évolution suite à l'entraînement
      this.evolutionScore = Math.min(0.99, this.evolutionScore + 0.012 * epochLosses.length);
      this.evolutionProfile.wisdom = Math.min(0.99, this.evolutionProfile.wisdom + 0.008);

      console.info(
        `[LoraEvo] ✅ Training #${this.#trainingCount} — ` +
        `loss: ${finalLoss.toFixed(4)} | best: ${bestLoss.toFixed(4)} | sig: ${signature.length}B`
      );

      return {
        trained: true, lessons: lessons.length, pairs: pairs.length,
        finalLoss, bestLoss, epochs: epochLosses.length, epochLosses,
        signatureBytes: signature.length,
        checkpointId: `loraevo_v${this.#trainingCount}`,
        adapterParams: adapter.numParams(),
      };

    } finally {
      this.#isTraining = false;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // MÉTHODES PRIVÉES
  // ═══════════════════════════════════════════════════════════════

  #buildContextualPrompt(prompt) {
    const ctx = this.shortTermMemory.length > 0
      ? '\n[Contexte récent]:\n' +
        this.shortTermMemory.slice(-4).map(e => `- ${e}`).join('\n') + '\n'
      : '';

    const profile = this.evolutionProfile.toJSON();
    const profileLine =
      `[Profil] Spécialisation: ${this.currentSpecialization} | ` +
      `Évolution: ${this.evolutionScore.toFixed(2)} | ` +
      `Sagesse: ${profile.wisdom} | Éthique: ${profile.ethics}`;

    return (
      'Tu es LoraEvo, un assistant intelligent, bienveillant et auto-évolutif de SkyAInet.\n' +
      'Tu apprends en continu et t\'adaptes à l\'utilisateur.\n\n' +
      `${ctx}${profileLine}\n` +
      `Utilisateur : ${prompt}\nLoraEvo :`
    );
  }

  #learnFromInteraction(prompt, response) {
    // Mémoire court-terme — résumé compact
    const snippet = typeof response === 'string' ? response.slice(0, 80) : String(response).slice(0, 80);
    this.shortTermMemory.push(`Q: ${prompt.slice(0, 60)} | R: ${snippet}`);
    if (this.shortTermMemory.length > STM_MAX) this.shortTermMemory.shift();

    // Mémoire long-terme — uniquement les réponses denses
    const full = typeof response === 'string' ? response : '';
    if (full.length > LTM_MIN_CHARS) {
      this.longTermKnowledge.push(full);
      if (this.longTermKnowledge.length > LTM_MAX) this.longTermKnowledge.shift();
    }

    // Détection de spécialisation avec compteurs d'exposition cumulés
    const spec = detectSpecialization(prompt, this.#exposures);
    this.#exposures.set(spec, (this.#exposures.get(spec) ?? 0) + 1);
    this.currentSpecialization = spec;

    // Adaptation du profil selon la spécialisation
    this.evolutionProfile.adapt(spec);
    this.lastAdaptation = Date.now();
  }

  #adaptEvolution() {
    if (this.totalInteractions % EVOLVE_EVERY === 0) {
      this.evolutionScore = Math.min(0.99, this.evolutionScore + EVOLVE_BOOST);
    }
  }

  async #persistCheckpoint(key, meta, weights) {
    try {
      await mkdir(CHECKPOINT_DIR, { recursive: true });
      await writeFile(`${CHECKPOINT_DIR}/${key}.json`, JSON.stringify(meta));
      if (weights instanceof Uint8Array) {
        await writeFile(`${CHECKPOINT_DIR}/${key}.bin`, weights);
      }
      return;
    } catch { /* Pas dans Node ou accès refusé */ }

    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(key, JSON.stringify(meta));
      }
    } catch { /* localStorage indisponible */ }
  }

  // ═══════════════════════════════════════════════════════════════
  // API PUBLIQUE
  // ═══════════════════════════════════════════════════════════════

  getStatus() {
    return (
      `LoraEvo | Évolution: ${this.evolutionScore.toFixed(3)}` +
      ` | Interactions: ${this.totalInteractions}` +
      ` | Spécialisation: ${this.currentSpecialization}` +
      ` | Mémoire: ${this.shortTermMemory.length} court / ${this.longTermKnowledge.length} long` +
      ` | Adapter: ${this.#loraAdapter ? `${this.#loraAdapter.numParams()} params` : 'non init'}`
    );
  }

  getEvolutionProfile() { return this.evolutionProfile.toJSON(); }

  getStats() {
    const filled  = Math.min(this.#trainingCount * 4, 32);
    let   lossAvg = 0;
    for (let i = 0; i < filled; i++) lossAvg += this.#lossHistory[i];
    return {
      totalInteractions   : this.totalInteractions,
      evolutionScore      : +this.evolutionScore.toFixed(4),
      currentSpecialization: this.currentSpecialization,
      trainingCount       : this.#trainingCount,
      isTraining          : this.#isTraining,
      adapterParams       : this.#loraAdapter?.numParams() ?? 0,
      avgLoss             : filled > 0 ? +(lossAvg / filled).toFixed(4) : null,
      exposures           : Object.fromEntries(this.#exposures),
      profile             : this.evolutionProfile.toJSON(),
      engineConnected     : !!this.#inferenceEngine,
    };
  }

  // Compat EvolutionManager duck-typing { train() }
  get train() { return this.train.bind(this); }
}

export default LoraEvo;
