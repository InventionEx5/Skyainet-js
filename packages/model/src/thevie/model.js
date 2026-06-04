// packages/model/src/thevie/model.js
// =====================================================
// Model Package — Point d'entrée central
// Thevie + tous les sous-modules du dossier model/
// SkyAInet × Nikola T369
// =====================================================

"use strict";

// ─────────────────────────────────────────────────────────────────
// THEVIE — Intelligence Collective Principale
// ─────────────────────────────────────────────────────────────────

export { Thevie }                                           from './thevie/thevie.js';

// ─────────────────────────────────────────────────────────────────
// PERSONNALITÉ & RÉSEAU NEURONAL
// ─────────────────────────────────────────────────────────────────

export { Personality, PersonalityProfile }                  from './thevie/personality.js';
export { Synapse }                                          from './thevie/synapse.js';
export { Neurone }                                          from './thevie/neurone.js';

// ─────────────────────────────────────────────────────────────────
// MÉMOIRE & REPLAY
// ─────────────────────────────────────────────────────────────────

export { ReplayBuffer, Experience }                         from './thevie/replay_buffer.js';

// ─────────────────────────────────────────────────────────────────
// DREAM CYCLE
// ─────────────────────────────────────────────────────────────────

export { DreamCycle }                                       from './thevie/dream_cycle.js';

// ─────────────────────────────────────────────────────────────────
// ÉVOLUTION LORA
// ─────────────────────────────────────────────────────────────────

export { LoraEvo }                                          from './thevie/lora_evolution.js';

// ─────────────────────────────────────────────────────────────────
// MIGRATION INTER-NŒUDS
// ─────────────────────────────────────────────────────────────────

export { MigrationManager, TravelPackage }                  from './thevie/migration_manager.js';

// ─────────────────────────────────────────────────────────────────
// DISTILLATION TEACHER → STUDENT
// ─────────────────────────────────────────────────────────────────

export {
  DistillationManager,
  DistillationConfig,
  TrainingExample,
}                                                           from './thevie/distillation_manager.js';

// ─────────────────────────────────────────────────────────────────
// BENCHMARK
// ─────────────────────────────────────────────────────────────────

export { TheviesBenchmark, PowerScore, runFullBenchmark }   from './thevie/benchmark.js';

// ─────────────────────────────────────────────────────────────────
// REGISTRE DES MODÈLES
// ─────────────────────────────────────────────────────────────────

export { ModelRegistry, ModelInfo }                         from './thevie/model_registry.js';

// ─────────────────────────────────────────────────────────────────
// FLASH SCHEDULER
// ─────────────────────────────────────────────────────────────────

export { FlashScheduler, ThevieFlashScheduler }             from './thevie/flash_scheduler.js';

// ─────────────────────────────────────────────────────────────────
// SYNCHRONISATION FÉDÉRÉE
// ─────────────────────────────────────────────────────────────────

export { FederatedSync }                                    from './thevie/federated_sync.js';

// ─────────────────────────────────────────────────────────────────
// VERSION
// ─────────────────────────────────────────────────────────────────

export const VERSION = '1.0.0';

export const PACKAGE_INFO = Object.freeze({
  name       : 'skyainet-model',
  version    : VERSION,
  description: 'SkyAInet Model Package — Thevie + Personnalité + Mémoire + Dream + LoRA + Migration + Distillation + Benchmark + Registry + Scheduler + Sync',
  modules    : [
    'Thevie',
    'Personality', 'Synapse', 'Neurone',
    'ReplayBuffer',
    'DreamCycle',
    'LoraEvo',
    'MigrationManager',
    'DistillationManager',
    'TheviesBenchmark',
    'ModelRegistry',
    'FlashScheduler',
    'FederatedSync',
  ],
});
