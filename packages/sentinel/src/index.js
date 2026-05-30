// packages/sentinel/src/index.js
// =====================================================
// Sentinel — Point d'entrée du module
// SkyAInet – Identité Souveraine, Auto‑Healing, Anti‑Fork
// =====================================================

// Identité du nœud
export { NodeIdentity, Attestation } from './node_identity.js';

// Auto‑Healing
export { Sentinel, IssueSeverity, HealingAction, DetectedIssue } from './auto_healing.js';

// Anti‑Fork
export { AntiFork, ForkSeverity, ForkEvent } from './anti_fork.js';

// Export par défaut (agrégation)
import { NodeIdentity } from './node_identity.js';
import { Sentinel } from './auto_healing.js';
import { AntiFork } from './anti_fork.js';

export default {
  NodeIdentity,
  Sentinel,
  AntiFork,
};