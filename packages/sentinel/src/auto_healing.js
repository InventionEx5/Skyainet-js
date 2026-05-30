// packages/sentinel/src/auto_healing.js
// =====================================================
// Sentinel — Auto‑Healing & Self‑Defense Intelligent
// SkyAInet – Détection avancée + Actions autonomes + Intégration Thevie & Rewards
// =====================================================

import { UserRewards, RewardReason } from '../../core/src/rewards.js';
import { SkyAInetNode } from '../../node/src/node.js';

// ----------------------------------------------------------------------
// Niveaux de gravité
// ----------------------------------------------------------------------
export const IssueSeverity = Object.freeze({
  Low:      'Low',
  Medium:   'Medium',
  High:     'High',
  Critical: 'Critical',
});

// ----------------------------------------------------------------------
// Actions de guérison
// ----------------------------------------------------------------------
export const HealingAction = Object.freeze({
  TriggerFlashGematria: 'TriggerFlashGematria',
  EnterLowPowerMode:    'EnterLowPowerMode',
  WakeNode:             'WakeNode',
  BoostReputation:       'BoostReputation',
  RebalanceCollective:  'RebalanceCollective',
  PruneOldData:         'PruneOldData',
  StartDreamCycle:      'StartDreamCycle',
});

// ----------------------------------------------------------------------
// Problème détecté
// ----------------------------------------------------------------------
export class DetectedIssue {
  constructor(message, severity, affectedNode = null) {
    this.message = message;
    this.severity = severity;
    this.timestamp = new Date();
    this.affectedNode = affectedNode; // string (peerId)
  }
}

// ----------------------------------------------------------------------
// Sentinel
// ----------------------------------------------------------------------
export class Sentinel {
  constructor() {
    this.issuesDetected = 0;
    this.healsPerformed = 0;
    this.lastHealing = null;        // Date | null
    this.healingHistory = [];       // Array<{ action: string, timestamp: Date }>
  }

  // ---------- Détection avancée ----------
  /**
   * Analyse un nœud et retourne les problèmes détectés.
   * @param {SkyAInetNode} node
   * @returns {Array<DetectedIssue>}
   */
  detectIssues(node) {
    const issues = [];

    // Sagesse collective trop basse (reputation_score est utilisé comme proxy)
    if (node.metadata.reputationScore < 0.55) {
      issues.push(new DetectedIssue(
        'Sagesse collective trop basse',
        IssueSeverity.High,
        node.metadata.peerId,
      ));
    }

    // Réputation critique
    if (node.metadata.reputationScore < 0.45) {
      issues.push(new DetectedIssue(
        'Réputation du nœud critique',
        IssueSeverity.Critical,
        node.metadata.peerId,
      ));
    }

    // Nœud en veille
    if (node.state === 'Sleeping') {
      issues.push(new DetectedIssue(
        'Nœud inactif depuis longtemps',
        IssueSeverity.Medium,
        node.metadata.peerId,
      ));
    }

    if (issues.length > 0) {
      this.issuesDetected += issues.length;
      console.warn(`[Sentinel] ${issues.length} problème(s) détecté(s)`);
    }

    return issues;
  }

  // ---------- Choix de l'action ----------
  /**
   * Sélectionne la meilleure action en fonction de la gravité.
   * @param {DetectedIssue} issue
   * @returns {string} clé de HealingAction
   */
  chooseHealingAction(issue) {
    switch (issue.severity) {
      case IssueSeverity.Critical: return HealingAction.TriggerFlashGematria;
      case IssueSeverity.High:     return HealingAction.StartDreamCycle;
      case IssueSeverity.Medium:   return HealingAction.EnterLowPowerMode;
      default:                     return HealingAction.PruneOldData;
    }
  }

  // ---------- Exécution de la guérison ----------
  /**
   * Applique les actions de guérison sur le nœud et attribue des récompenses.
   * @param {Array<DetectedIssue>} issues
   * @param {SkyAInetNode} node        – mutable
   * @param {UserRewards} rewards      – mutable
   */
  async triggerHealing(issues, node, rewards) {
    for (const issue of issues) {
      const action = this.chooseHealingAction(issue);

      switch (action) {
        case HealingAction.TriggerFlashGematria:
          await node.triggerFlashGematria();
          rewards.addReward(RewardReason.HealingContribution, 25);
          break;

        case HealingAction.EnterLowPowerMode:
          await node.enterLowPowerMode();
          break;

        case HealingAction.WakeNode:
          await node.wake();
          break;

        case HealingAction.BoostReputation:
          node.metadata.reputationScore = Math.min(
            1.0,
            node.metadata.reputationScore + 0.12,
          );
          break;

        case HealingAction.RebalanceCollective:
          console.debug('[Sentinel] Rebalancing collective wisdom');
          // Appel à une fonction de rééquilibrage si disponible
          break;

        case HealingAction.PruneOldData:
          if (node.zipMemory) {
            await node.zipMemory.compressInactiveData();
          }
          break;

        case HealingAction.StartDreamCycle:
          await node.runEvolutionCycle();
          break;
      }

      this.healingHistory.push({
        action,
        timestamp: new Date(),
      });
      this.healsPerformed += 1;
    }

    this.lastHealing = new Date();
    console.info(`[Sentinel] Healing completed: ${issues.length} action(s) performed`);
  }

  // ---------- Résumé ----------
  summary() {
    return `Sentinel | Issues: ${this.issuesDetected} | Heals: ${this.healsPerformed} | Last healing: ${this.lastHealing?.toISOString() ?? 'never'}`;
  }
}