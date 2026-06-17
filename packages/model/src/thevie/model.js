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

export { Thevie }                                           from '#thevie';

// ─────────────────────────────────────────────────────────────────
// PERSONNALITÉ & RÉSEAU NEURONAL
// ─────────────────────────────────────────────────────────────────

export { Personality, PersonalityProfile }                  from '#personality';
export { Synapse }                                          from '#synapse';
export { Neurone }                                          from '#neurone';

// ─────────────────────────────────────────────────────────────────
// MÉMOIRE & REPLAY
// ─────────────────────────────────────────────────────────────────

export { ReplayBuffer, Experience }                         from '#replay_buffer';

// ─────────────────────────────────────────────────────────────────
// DREAM CYCLE
// ─────────────────────────────────────────────────────────────────

export { DreamCycle }                                       from '#dream_cycle';

// ─────────────────────────────────────────────────────────────────
// ÉVOLUTION LORA
// ─────────────────────────────────────────────────────────────────

export { LoraEvo }                                          from '#lora_evolution';

// ─────────────────────────────────────────────────────────────────
// MIGRATION INTER-NŒUDS
// ─────────────────────────────────────────────────────────────────

export { MigrationManager, TravelPackage }                  from '#migration_manager';

// ─────────────────────────────────────────────────────────────────
// DISTILLATION TEACHER → STUDENT
// ─────────────────────────────────────────────────────────────────

export {
  DistillationManager,
  DistillationConfig,
  TrainingExample,
}                                                           from '#distillation_manager';

// ─────────────────────────────────────────────────────────────────
// BENCHMARK
// ─────────────────────────────────────────────────────────────────

export { TheviesBenchmark, PowerScore, runFullBenchmark }   from '#benchmark';

// ─────────────────────────────────────────────────────────────────
// REGISTRE DES MODÈLES
// ─────────────────────────────────────────────────────────────────

export { ModelRegistry, ModelInfo, AdapterInfo }            from '#model_registry';

// ─────────────────────────────────────────────────────────────────
// FUSION L0 — Base MoE clairsemée + Dynamic Adapter Swarm + Inference Core
// ─────────────────────────────────────────────────────────────────

export { MoEConfig, ExpertFFN, MoELayer, MoERouter, LoraAdapter }  from '#moe';
export {
  InferenceCore, BackendKind, InferenceBackend,
  LocalJSBackend, RemoteHTTPBackend, WebGPUBackend, WasmBackend,
  T369Inference, ParallelMode,
}                                                                  from '#inference';

// Fabrique de commodité : un cœur d'inférence prêt à l'emploi
// (backend LocalJS souverain par défaut ; tri-backend via opts).
import { InferenceCore as _InferenceCore } from '#inference';
export function createInferenceCore(opts = {}) { return new _InferenceCore(opts); }

// ─────────────────────────────────────────────────────────────────
// FLASH SCHEDULER
// ─────────────────────────────────────────────────────────────────

export { FlashScheduler, ThevieFlashScheduler }             from '#flash_scheduler';

// ─────────────────────────────────────────────────────────────────
// SYNCHRONISATION FÉDÉRÉE
// ─────────────────────────────────────────────────────────────────

export { FederatedSync }                                    from '#federated_sync';

// ─────────────────────────────────────────────────────────────────
// VERSION
// ─────────────────────────────────────────────────────────────────

export const VERSION = '1.1.0';

export const PACKAGE_INFO = Object.freeze({
  name       : 'skyainet-model',
  version    : VERSION,
  description: 'SkyAInet Model Package — Thevie + Personnalité + Mémoire + Dream + LoRA + Migration + Distillation + Benchmark + Registry + Scheduler + Sync + Fusion L0 (MoE Swarm + Inference Core)',
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
    'MoELayer', 'MoERouter', 'LoraAdapter', 'InferenceCore',
  ],
});
