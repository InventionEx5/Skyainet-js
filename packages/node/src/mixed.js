// packages/node/src/mixed.js
// MixedNode — Nœud Hybride Souverain Dynamique
// Compute + Storage + Validator + Orchestration intelligente

import { NodeCapabilities, NodeState, SubscriptionLevel, NodeType } from '../../core/src/node_types.js';
import { StorageNode } from './storage.js';
import { UserRewards, RewardReason } from '../../core/src/rewards.js';

export class MixedNode {
  #hybridTransport = null;
  #zipMemory = null;

  constructor(sovereignAlias, subscription = SubscriptionLevel.Pro) {
    if (!sovereignAlias) throw new Error('sovereignAlias requis');

    this.nodeId = `mixed-${sovereignAlias.toLowerCase()}`;
    this.sovereignAlias = sovereignAlias;
    this.capabilities = new NodeCapabilities(subscription);
    this.currentState = NodeState.Active;
    this.activeRoles = [NodeType.Full];
    this.storage = null;
    this.computePower = this.capabilities.compute_power;
    this.validatorStake = 0;
    this.totalTasksProcessed = 0;
    this.lastRoleSwitch = null;

    // Infrastructure partagée (optionnelle)
    this.#hybridTransport = null;
    this.#zipMemory = null;
  }

  // =====================================================
  // GESTION DYNAMIQUE DES RÔLES
  // =====================================================
  async activateRole(role) {
    if (this.activeRoles.includes(role)) return;

    this.activeRoles.push(role);
    this.lastRoleSwitch = new Date();

    if (role === NodeType.Storage) {
      this.storage = new StorageNode(this.sovereignAlias, SubscriptionLevel.Pro);
      console.info('[MixedNode] Rôle Storage activé');
    }

    if (role === NodeType.Validator) {
      this.validatorStake = 12000;
      console.info(`[MixedNode] Rôle Validator activé avec stake ${this.validatorStake}`);
    }
  }

  deactivateRole(role) {
    this.activeRoles = this.activeRoles.filter(r => r !== role);

    if (role === NodeType.Storage) {
      this.storage = null;
    }
  }

  // =====================================================
  // EXÉCUTION DE TÂCHE (Orchestration intelligente)
  // =====================================================
  async executeTask(taskType, data = null, rewards = null) {
    this.totalTasksProcessed++;

    switch (taskType) {
      case 'inference':
        if (this.activeRoles.includes(NodeType.Full)) {
          if (rewards instanceof UserRewards) {
            rewards.addReward(RewardReason.ComputeContribution, 12);
          }
          return 'Tâche d\'inférence exécutée sur MixedNode';
        }
        break;

      case 'upload':
        if (this.activeRoles.includes(NodeType.Storage) && this.storage) {
          if (!data) throw new Error('Aucune donnée à uploader');
          const cid = await this.storage.uploadFile('mixed_task.bin', data);
          if (rewards instanceof UserRewards) {
            rewards.addReward(RewardReason.StorageContribution, 8);
          }
          return `Fichier stocké avec succès → CID: ${cid}`;
        }
        throw new Error('Storage non activé');

      case 'validation':
        if (this.activeRoles.includes(NodeType.Validator)) {
          if (this.validatorStake < 10000) {
            throw new Error('Stake insuffisant pour validation');
          }
          if (rewards instanceof UserRewards) {
            rewards.addReward(RewardReason.Validation, 15);
          }
          return 'Validation PoUW effectuée avec succès';
        }
        break;

      default:
        throw new Error(`Aucun rôle actif capable d'exécuter la tâche: ${taskType}`);
    }

    throw new Error(`Rôle non activé pour la tâche: ${taskType}`);
  }

  // =====================================================
  // MÉTRIQUES & SANTÉ
  // =====================================================
  getTotalPower() {
    let power = this.computePower;
    if (this.storage) power += 0.22;
    if (this.validatorStake > 0) power += 0.18;
    return power;
  }

  healthReport() {
    return `MixedNode \( {this.sovereignAlias} | Rôles: [ \){this.activeRoles.join(', ')}] | Power: ${this.getTotalPower().toFixed(3)} | Tasks: ${this.totalTasksProcessed} | Storage: ${this.storage ? this.storage.usedStorageGb || 0 : 0} Go | Stake: ${this.validatorStake}`;
  }

  // Getters / Setters utiles
  get hybridTransport() { return this.#hybridTransport; }
  set hybridTransport(t) { this.#hybridTransport = t; }

  get zipMemory() { return this.#zipMemory; }
  set zipMemory(z) { this.#zipMemory = z; }
}