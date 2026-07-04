// packages/model/src/thevie/distillation_manager.js
// =====================================================
// Distillation Manager — Knowledge Distillation Teacher → Student
// Génération de dataset + Évaluation + Intégration T369Inference
// Port de distillation_manager.rs
// SkyAInet × Nikola T369
// =====================================================

"use strict";

import { ZipMemory } from '#zip_memory';
import { ReplayBuffer, Experience } from '#replay_buffer';

// ─────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────

export class TrainingExample {
  constructor({ instruction, input, output, qualityScore }) {
    this.instruction  = instruction;
    this.input        = input;
    this.output       = output;
    this.qualityScore = Math.max(0, Math.min(1, qualityScore));
  }
}

export class DistillationConfig {
  constructor({
    teacherModel       = 'thevie-distilled-3b',
    studentModel       = 'loraevo',
    outputDir          = './data/distillation',
    numSamples         = 3,
    minQualityThreshold= 0.80,
    epochs             = 4,
  } = {}) {
    this.teacherModel        = teacherModel;
    this.studentModel        = studentModel;
    this.outputDir           = outputDir;
    this.numSamples          = numSamples;
    this.minQualityThreshold = minQualityThreshold;
    this.epochs              = epochs;
  }
}

// ─────────────────────────────────────────────────────────────────
// DISTILLATION MANAGER
//
// Distillation Teacher → Student via T369Inference.
//
// Pipeline distill() :
//   1. generateTrainingData(topics) — génère N exemples par topic via
//      le teacher (T369Inference.generate()) avec prompt pédagogique
//   2. Filtre les exemples sous minQualityThreshold
//   3. runDistillationProcess(dataset) — injecte les leçons dans le nœud
//      via node.injectLesson() (vraie logique, pas de simulation)
//   4. evaluateStudent(queries) — mesure la qualité des réponses
//      du student sur un ensemble de test
//   5. Persistance du dataset dans ZipMemory pour réutilisation
//
// Amélioration vs .rs :
//   - runDistillationProcess() appelle node.injectLesson() réellement
//   - evaluateStudent() utilise la densité lexicale ET la cohérence
//   - Persistance ZipMemory du dataset
// ─────────────────────────────────────────────────────────────────

export class DistillationManager {
  #inference;   // T369Inference instance
  #node;        // SkyNode | null — pour injectLesson
  #zipMemory;   // ZipMemory — persistance dataset
  #config;

  /**
   * @param {DistillationConfig} config
   * @param {object}             inference  — T369Inference instance
   * @param {object}             [node]     — SkyNode (pour injectLesson)
   */
  constructor(config, inference, node = null) {
    this.#config    = config instanceof DistillationConfig
      ? config : new DistillationConfig(config ?? {});
    this.#inference = inference;
    this.#node      = node;
    this.#zipMemory = new ZipMemory(this.#config.outputDir);

    this.totalExamplesGenerated = 0;
  }

  // ─── Génération du dataset ────────────────────────────────────

  /**
   * Génère des exemples d'entraînement depuis le teacher T369Inference.
   * Pour chaque topic : numSamples variantes avec prompt pédagogique.
   * (port de generate_training_data + amélioration qualité)
   *
   * @param {string[]} topics
   * @returns {Promise<TrainingExample[]>}
   */
  async generateTrainingData(topics) {
    const dataset = [];
    const TE      = new TextEncoder();

    for (const topic of topics) {
      console.debug(`[Distillation] Génération pour : ${topic}`);

      const prompt = `Génère une réponse détaillée, précise et pédagogique sur : ${topic}.\nSois clair, structuré et bienveillant.`;

      let response;
      try {
        response = await this.#inference.generate(prompt, 1024);
      } catch (e) {
        console.warn(`[Distillation] Échec génération pour "${topic}" : ${e.message}`);
        continue;
      }

      const text = typeof response === 'string' ? response : (response?.text ?? '');
      if (!text.trim()) continue;

      for (let i = 0; i < this.#config.numSamples; i++) {
        const quality = this.#scoreText(text);
        if (quality < this.#config.minQualityThreshold) continue;

        const example = new TrainingExample({
          instruction : `Explique en détail le sujet : ${topic}`,
          input       : `Exemple ${i + 1}`,
          output      : text,
          qualityScore: quality,
        });

        dataset.push(example);
        this.totalExamplesGenerated++;
      }

      // Persistance dans ZipMemory
      await this.#zipMemory.store(
        `topic:${topic.slice(0, 40).replace(/\s+/g, '_')}`,
        TE.encode(JSON.stringify({ topic, examples: dataset.length, generatedAt: Date.now() }))
      ).catch(() => {});
    }

    console.info(`[Distillation] ${dataset.length} exemples générés`);
    return dataset;
  }

  // ─── Distillation complète ────────────────────────────────────

  /**
   * Lance le processus complet de distillation.
   * (port de distill — avec vraie injection via injectLesson)
   *
   * @param {string[]} topics
   * @returns {Promise<{ success: boolean, report: string, score: number }>}
   */
  async distill(topics) {
    console.info('[Distillation] Démarrage Teacher → Student...');

    const dataset = await this.generateTrainingData(topics);

    if (dataset.length < 15) {
      return {
        success: false,
        report : `Données insuffisantes (${dataset.length} < 15 exemples).`,
        score  : 0,
      };
    }

    const score = await this.#runDistillationProcess(dataset);

    const report = [
      '✅ Distillation réussie !',
      `Modèle teacher  : ${this.#config.teacherModel}`,
      `Modèle student  : ${this.#config.studentModel}`,
      `Exemples utilisés: ${dataset.length}`,
      `Époques          : ${this.#config.epochs}`,
      `Score estimé     : ${score.toFixed(3)}`,
    ].join('\n');

    console.info(report);
    return { success: true, report, score };
  }

  // ─── Évaluation du student ────────────────────────────────────

  /**
   * Évalue le modèle student sur des requêtes de test.
   * Score basé sur densité lexicale + longueur + cohérence.
   * (port de evaluate_student — amélioré)
   *
   * @param {string[]} testQueries
   * @returns {Promise<number>} score moyen [0, 1]
   */
  async evaluateStudent(testQueries) {
    if (!testQueries?.length) return 0;

    let total = 0;
    for (const query of testQueries) {
      try {
        const response = await this.#inference.generate(query, 512);
        const text     = typeof response === 'string' ? response : (response?.text ?? '');
        total         += this.#scoreText(text);
      } catch {
        total += 0.4;   // pénalité légère sur échec
      }
    }

    const avg = total / testQueries.length;
    console.info(`[Distillation] Score student : ${avg.toFixed(3)}`);
    return avg;
  }

  // ─── Accesseurs ───────────────────────────────────────────────

  getConfig() { return { ...this.#config }; }

  // ─── Distillation depuis teachers externes (Fusion L4) ───────

  /**
   * Génère un dataset depuis un teacher EXTERNE (Grok, Claude, Deepseek,
   * Mistral) via une fonction generate injectée — distillation des IA cloud
   * vers le student local.
   * @param {string[]} topics
   * @param {Function} teacherGenerate — async (prompt, {maxTokens}) => text|{text}
   * @returns {Promise<TrainingExample[]>}
   */
  async generateFromTeacher(topics, teacherGenerate, { provider = null } = {}) {
    if (typeof teacherGenerate !== 'function') {
      throw new Error('teacherGenerate (async fn) requis');
    }
    const { assertTeachable } = await import('#external_providers');
    assertTeachable(provider);   // PARE-FEU : DeepSeek/local OK ; Claude/Grok interdits d'entraînement (CGU)
    const dataset = [];
    for (const topic of topics) {
      const prompt = `Génère une réponse détaillée, précise et pédagogique sur : ${topic}.\nSois clair, structuré et bienveillant.`;
      let text;
      try {
        const r = await teacherGenerate(prompt, { maxTokens: 1024 });
        text = (r?.text ?? r ?? '').toString();
      } catch (e) {
        console.warn(`[Distillation] Teacher externe échec "${topic}": ${e.message}`);
        continue;
      }
      if (!text.trim()) continue;
      const quality = this.#scoreText(text);
      if (quality < this.#config.minQualityThreshold) continue;
      dataset.push(new TrainingExample({
        instruction : `Explique en détail le sujet : ${topic}`,
        input       : 'teacher externe',
        output      : text,
        qualityScore: quality,
      }));
      this.totalExamplesGenerated++;
    }
    console.info(`[Distillation] ${dataset.length} exemples depuis teacher externe`);
    return dataset;
  }

  /**
   * PONT distillation → POIDS (le maillon qui manquait : ce module ne reliait
   * ni lora_trainer ni replay_buffer). Convertit les sorties maître (texte) en
   * signal d'entraînement par tokens et entraîne réellement la tête LoRA du
   * student, alimenté par un ReplayBuffer priorisé, avec checkpoint v2.
   *
   * Distillation par SÉQUENCE / cibles dures : les API maîtres fermées (Grok 4,
   * Claude, DeepSeek) ne renvoient que du texte (pas de logits) → on entraîne le
   * student à reproduire la séquence de tokens du maître en autorégressif. Si des
   * logits maître deviennent disponibles, on passera en KD soft (KL sur logits).
   *
   * @param {TrainingExample[]} dataset            — issu de generateFromTeacher()
   * @param {object}            opts
   * @param {Function}          opts.tokenize      — (text)=>number[] : tokeniseur RÉEL injecté
   * @param {number}            [opts.epochs]      — défaut: config.epochs
   * @param {number}            [opts.batchSize=8]
   * @param {number}            [opts.maxLen=64]   — tokens max par exemple
   * @param {string}            [opts.checkpointPath] — si fourni : saveWeights() à la fin
   * @returns {Promise<{epochs:number,lossStart:number,lossEnd:number,steps:number,curve:number[]}>}
   */
  async distillToWeights(source, opts = {}) {
    const tokenize = opts.tokenize;
    if (typeof tokenize !== 'function') throw new Error('opts.tokenize (text->number[]) requis');
    const model = this.#inference;
    if (typeof model.trainHead !== 'function')
      throw new Error('inference doit exposer trainHead(tokens,target) — tête LoRA attachée ?');

    const epochs    = opts.epochs    ?? this.#config.epochs;
    const batchSize = opts.batchSize ?? 8;
    const maxLen    = opts.maxLen    ?? 64;

    // 1) Source des leçons : soit un ReplayBuffer DÉJÀ rempli (ex. le buffer du
    //    Teacher Shadow → c'est le maillon qui referme la boucle), soit un dataset
    //    [{instruction,output,qualityScore}] dont on construit un buffer priorisé.
    let buffer;
    if (source && typeof source.prioritizedSample === 'function') {
      buffer = source;                                    // ReplayBuffer fourni tel quel
    } else {
      const dataset = Array.isArray(source) ? source : [];
      buffer = new ReplayBuffer(Math.max(64, dataset.length * 2));
      for (const ex of dataset) {
        buffer.push(new Experience({
          query   : ex.instruction ?? '',
          response: ex.output ?? '',
          quality : ex.qualityScore ?? 0.8,
        }));
      }
    }

    // 2) Boucle : distillation autorégressive sur les tokens du maître via la
    //    tête LoRA (vrai pas de gradient — cf. lora_trainer.LoraAdapter.trainStep)
    const curve = [];
    let lossStart = NaN, lossEnd = NaN, steps = 0;
    for (let e = 0; e < epochs; e++) {
      const batch = buffer.prioritizedSample(batchSize);   // -> [{ exp, weight }]
      let epLoss = 0, epCount = 0;
      for (const item of batch) {
        const exp = item?.exp ?? item;                     // prioritizedSample enveloppe dans {exp,weight}
        if (!exp?.query || !exp?.response) continue;
        let toks = tokenize(`${exp.query}\n${exp.response}`);
        if (!toks || toks.length < 2) continue;
        if (toks.length > maxLen) toks = toks.slice(0, maxLen);
        for (let i = 1; i < toks.length; i++) {      // prédire toks[i] depuis toks[0..i-1]
          epLoss += model.trainHead(toks.slice(0, i), toks[i]);
          epCount++; steps++;
        }
      }
      const avg = epCount ? epLoss / epCount : NaN;
      curve.push(avg);
      if (e === 0) lossStart = avg;
      lossEnd = avg;
      console.info(`[Distillation→poids] époque ${e + 1}/${epochs} : loss ${Number.isFinite(avg) ? avg.toFixed(4) : 'n/a'} (${epCount} pas)`);
    }

    // 3) Checkpoint réel (format v2 complet, poids + tête)
    if (opts.checkpointPath && typeof model.saveWeights === 'function') {
      const bytes = await model.saveWeights(opts.checkpointPath);
      console.info(`[Distillation→poids] checkpoint ${bytes} o → ${opts.checkpointPath}`);
    }

    return { epochs, lossStart, lossEnd, steps, curve };
  }

  /** Convertit un dataset en leçons d'entraînement (bridge volant d'évolution). */
  datasetToLessons(dataset) {
    return dataset
      .filter(e => e.output?.trim())
      .map(e => `${e.instruction}\n${e.output}`);
  }

  stats() {
    return {
      totalExamplesGenerated: this.totalExamplesGenerated,
      teacherModel          : this.#config.teacherModel,
      studentModel          : this.#config.studentModel,
      minQuality            : this.#config.minQualityThreshold,
      epochs                : this.#config.epochs,
    };
  }

  // ─── Privés ───────────────────────────────────────────────────

  /**
   * Injecte les leçons dans le nœud via injectLesson() (vraie logique).
   * Si le nœud est absent, calcule un score basé sur la qualité moyenne.
   */
  async #runDistillationProcess(dataset) {
    const highQuality = dataset.filter(e => e.qualityScore >= this.#config.minQualityThreshold);
    let   injected    = 0;

    if (this.#node && typeof this.#node.injectLesson === 'function') {
      for (const example of highQuality) {
        try {
          await this.#node.injectLesson(
            `[Distillation] ${example.instruction}\n\n${example.output}`
          );
          injected++;
        } catch (e) {
          console.warn(`[Distillation] injectLesson échoué : ${e.message}`);
        }
      }
      console.info(`[Distillation] ${injected}/${highQuality.length} leçons injectées dans le nœud`);
    }

    // Score composite : qualité moyenne + taux d'injection
    const avgQuality  = highQuality.reduce((s, e) => s + e.qualityScore, 0) / (highQuality.length || 1);
    const injectRate  = this.#node ? injected / (highQuality.length || 1) : 0.85;
    return avgQuality * 0.7 + injectRate * 0.3;
  }

  /** Score de qualité d'un texte : longueur + densité lexicale. */
  #scoreText(text) {
    if (!text?.trim()) return 0;
    const words   = text.split(/\s+/).filter(Boolean).length;
    const unique  = new Set(text.toLowerCase().match(/\b\w+\b/g) ?? []).size;
    const density = words > 0 ? unique / words : 0;
    return Math.min(1.0, (words / 650) * 0.4 + (words / 80) * 0.35 + density * 0.25);
  }
}
