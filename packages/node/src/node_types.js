// packages/core/src/node_types.js
// Node Types — Architecture des Nœuds SkyAInet × Thevie

export const NodeType = Object.freeze({
  Mini: 'Mini',
  Light: 'Light',
  Full: 'Full',
  Validator: 'Validator',
  Sentinel: 'Sentinel',
  DreamWeaver: 'DreamWeaver',
});

export const NodeRole = Object.freeze({
  Core: 'Core',
  Edge: 'Edge',
  Validator: 'Validator',
  Sentinel: 'Sentinel',
  DreamWeaver: 'DreamWeaver',
});

export const NodeState = Object.freeze({
  Active: 'Active',
  Sleeping: 'Sleeping',
  Syncing: 'Syncing',
  DreamMode: 'DreamMode',
  Evolving: 'Evolving',
  Gateway: 'Gateway',
  Maintenance: 'Maintenance',
});

export const SubscriptionLevel = Object.freeze({
  Free: 'Free',
  Pro: 'Pro',
  Validator: 'Validator',
});

export const ReputationTier = Object.freeze({
  Newcomer: 'Newcomer',
  Reliable: 'Reliable',
  Trusted: 'Trusted',
  Sovereign: 'Sovereign',
  Legend: 'Legend',
});

// =====================================================
// NODE CAPABILITIES (classe optimisée)
// =====================================================
export class NodeCapabilities {
  constructor(level = SubscriptionLevel.Free) {
    const cfg = this._getConfig(level);
    this.storage_gb = cfg.storage_gb;
    this.compute_power = cfg.compute_power;
    this.max_concurrent_tasks = cfg.max_concurrent_tasks;
    this.supports_gpu = cfg.supports_gpu;
    this.supports_flash_gematria = cfg.supports_flash_gematria;
    this.zip_memory_enabled = cfg.zip_memory_enabled;
    this.custom_features = { ...cfg.custom_features };
  }

  _getConfig(level) {
    switch (level) {
      case SubscriptionLevel.Free:
        return {
          storage_gb: 8,
          compute_power: 1.0,
          max_concurrent_tasks: 2,
          supports_gpu: false,
          supports_flash_gematria: true,
          zip_memory_enabled: true,
          custom_features: {},
        };
      case SubscriptionLevel.Pro:
        return {
          storage_gb: 128,
          compute_power: 6.0,
          max_concurrent_tasks: 16,
          supports_gpu: true,
          supports_flash_gematria: true,
          zip_memory_enabled: true,
          custom_features: {
            dynamic_site_generation: true,
            api_gateway: true,
          },
        };
      case SubscriptionLevel.Validator:
        return {
          storage_gb: 512,
          compute_power: 12.0,
          max_concurrent_tasks: 64,
          supports_gpu: true,
          supports_flash_gematria: true,
          zip_memory_enabled: true,
          custom_features: {
            consensus_participation: true,
            governance_voting: true,
          },
        };
      default:
        return this._getConfig(SubscriptionLevel.Free);
    }
  }

  adjustForState(state) {
    switch (state) {
      case NodeState.Sleeping:
        this.compute_power *= 0.2;
        this.max_concurrent_tasks = 1;
        break;
      case NodeState.DreamMode:
        this.compute_power *= 0.6;
        break;
    }
  }

  toJSON() {
    return { ...this };
  }
}

// =====================================================
// MÉTHODES UTILITAIRES SUR LES ENUMS
// =====================================================

export function isPaidNodeType(type) {
  return [NodeType.Full, NodeType.Validator, NodeType.DreamWeaver].includes(type);
}

export function monthlyPriceEur(type) {
  const prices = {
    [NodeType.Mini]: 0,
    [NodeType.Light]: 6,
    [NodeType.Full]: 18,
    [NodeType.Validator]: 55,
    [NodeType.Sentinel]: 32,
    [NodeType.DreamWeaver]: 45,
  };
  return prices[type] ?? 0;
}

export function computeMultiplier(type) {
  const multipliers = {
    [NodeType.Mini]: 1.0,
    [NodeType.Light]: 2.5,
    [NodeType.Full]: 6.0,
    [NodeType.Validator]: 12.0,
    [NodeType.Sentinel]: 4.0,
    [NodeType.DreamWeaver]: 8.5,
  };
  return multipliers[type] ?? 1.0;
}

export function isOperationalState(state) {
  return [NodeState.Active, NodeState.Gateway, NodeState.DreamMode].includes(state);
}

export function isPaidSubscription(level) {
  return level !== SubscriptionLevel.Free;
}

export function reputationTierFromScore(score) {
  if (score >= 0.95) return ReputationTier.Legend;
  if (score >= 0.85) return ReputationTier.Sovereign;
  if (score >= 0.70) return ReputationTier.Trusted;
  if (score >= 0.50) return ReputationTier.Reliable;
  return ReputationTier.Newcomer;
}

export function reputationTierName(tier) {
  return tier;
}

export function defaultCapabilitiesForType(nodeType) {
  if (nodeType === NodeType.Mini) {
    return new NodeCapabilities(SubscriptionLevel.Free);
  }
  if (nodeType === NodeType.Light || nodeType === NodeType.Full) {
    return new NodeCapabilities(SubscriptionLevel.Pro);
  }
  return new NodeCapabilities(SubscriptionLevel.Validator);
}

export function isEdgeNode(role) {
  return role === NodeRole.Edge;
}

export function requiresPaidSubscription(nodeType) {
  return isPaidNodeType(nodeType);
}

// =====================================================
// EXPORT GLOBAL (pour compatibilité)
// =====================================================
export default {
  NodeType,
  NodeRole,
  NodeState,
  SubscriptionLevel,
  ReputationTier,
  NodeCapabilities,
  isPaidNodeType,
  monthlyPriceEur,
  computeMultiplier,
  isOperationalState,
  isPaidSubscription,
  reputationTierFromScore,
  reputationTierName,
  defaultCapabilitiesForType,
  isEdgeNode,
  requiresPaidSubscription,
};