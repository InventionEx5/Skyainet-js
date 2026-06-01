// packages/sentinel/src/auto_healing.js
// =====================================================
// Sentinel — Auto‑Healing & Self‑Defense Intelligent
// SkyAInet — Détection avancée + Actions autonomes
// SkyAInet × Nikola T369
// =====================================================

"use strict";

import { UserRewards }  from '../../core/src/rewards.js';
import { NodeState }    from '../../core/src/node_types.js';

// ─────────────────────────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────────────────────────

const WISDOM_THRESHOLD_HIGH     = 0.55;    // en dessous → High
const WISDOM_THRESHOLD_CRITICAL = 0.45;    // en dessous → Critical
const REP_BOOST                 = 0.12;
const REP_CAP                   = 1.0;
const REWARD_HEALING            = 25;      // SKY par guérison
const HEALING_HISTORY_MAX       = 256;

// ─────────────────────────────────────────────────────────────────
// NIVEAUX DE GRAVITÉ
// ─────────────────────────────────────────────────────────────────

export const IssueSeverity = Object.freeze({
  Low     : 'Low',
  Medium  : 'Medium',
  High    : 'High',
  Critical: 'Critical',
});

// ─────────────────────────────────────────────────────────────────
// ACTIONS DE GUÉRISON
// ─────────────────────────────────────────────────────────────────

export const HealingAction = Object.freeze({
  TriggerFlashGematria : 'TriggerFlashGematria',   // génération IA pour stimuler la sagesse
  StartDreamCycle      : 'StartDreamCycle',        // runEvolutionCycle
  SyncNetwork          : 'SyncNetwork',            // syncWithNetwork
  BoostReputation      : 'BoostReputation',        // incrémente wisdomScore interne
  RebalanceCollective  : 'RebalanceCollective',    // diversityInjection sur le mesh
  PruneOldData         : 'PruneOldData',           // replicateFiles / nettoyage
  InjectLesson         : 'InjectLesson',           // injectLesson avec contenu correctif
});

// ─────────────────────────────────────────────────────────────────
// PROBLÈME DÉTECTÉ
// ─────────────────────────────────────────────────────────────────

export class DetectedIssue {
  constructor(message, severity, affectedNode = null) {
    this.message      = message;
    this.severity     = severity;
    this.timestamp    = new Date();
    this.affectedNode = affectedNode;
  }
}

// ─────────────────────────────────────────────────────────────────
// SENTINEL / AUTO HEALING
// ─────────────────────────────────────────────────────────────────

export class Sentinel {
  #healingHistory;   // { action, issue, ts }[]

  constructor() {
    this.issuesDetected = 0;
    this.healsPerformed = 0;
    this.lastHealing    = null;
    this.#healingHistory= [];
  }

  // ─── Détection ────────────────────────────────────────────────

  /**
   * Analyse l'état d'un SkyNode via `getStatus()` (API publique)
   * et retourne la liste des problèmes détectés.
   *
   * Critères :
   *   - wisdomScore < WISDOM_THRESHOLD_HIGH     → High
   *   - wisdomScore < WISDOM_THRESHOLD_CRITICAL → Critical (additif)
   *   - state === Sleeping ou Idle              → Medium
   *   - engineReady === false                   → High
   *   - peers === 0                             → Low
   *
   * @param {object} node  — SkyNode instance
   * @returns {DetectedIssue[]}
   */
  detectIssues(node) {
    const status = node.getStatus();
    const issues = [];
    const id     = status.id ?? 'unknown';

    if (status.wisdomScore < WISDOM_THRESHOLD_CRITICAL) {
      issues.push(new DetectedIssue('Sagesse critique — risque de dégradation', IssueSeverity.Critical, id));
    } else if (status.wisdomScore < WISDOM_THRESHOLD_HIGH) {
      issues.push(new DetectedIssue('Sagesse trop basse', IssueSeverity.High, id));
    }

    if (status.state === NodeState.Sleeping || status.state === NodeState.Idle) {
      issues.push(new DetectedIssue('Nœud inactif', IssueSeverity.Medium, id));
    }

    if (status.engineReady === false) {
      issues.push(new DetectedIssue('Moteur T369 non initialisé', IssueSeverity.High, id));
    }

    if (status.peers === 0) {
      issues.push(new DetectedIssue('Aucun pair connecté', IssueSeverity.Low, id));
    }

    if (issues.length > 0) {
      this.issuesDetected += issues.length;
      console.warn(`[Sentinel] ${issues.length} problème(s) : ${issues.map(i => i.message).join(' | ')}`);
    }

    return issues;
  }

  // ─── Sélection de l'action ────────────────────────────────────

  chooseHealingAction(issue) {
    switch (issue.severity) {
      case IssueSeverity.Critical:
        return issue.message.includes('Moteur')
          ? HealingAction.StartDreamCycle
          : HealingAction.TriggerFlashGematria;
      case IssueSeverity.High:
        return issue.message.includes('Moteur')
          ? HealingAction.InjectLesson
          : HealingAction.StartDreamCycle;
      case IssueSeverity.Medium:
        return HealingAction.SyncNetwork;
      default:
        return HealingAction.PruneOldData;
    }
  }

  // ─── Exécution ────────────────────────────────────────────────

  /**
   * Applique les actions de guérison sur le nœud.
   *
   * Toutes les actions utilisent l'API publique de SkyNode :
   *   - runEvolutionCycle()      — StartDreamCycle
   *   - generateWithAI(...)      — TriggerFlashGematria (stimulus IA)
   *   - syncWithNetwork()        — SyncNetwork
   *   - injectLesson(...)        — InjectLesson
   *   - replicateFiles()         — PruneOldData
   *
   * Aucune mutation directe des champs privés.
   *
   * @param {DetectedIssue[]} issues
   * @param {object}          node     — SkyNode
   * @param {UserRewards|null} rewards
   */
  async triggerHealing(issues, node, rewards = null) {
    for (const issue of issues) {
      const action = this.chooseHealingAction(issue);

      try {
        switch (action) {
          case HealingAction.TriggerFlashGematria:
            // Stimule la sagesse via une génération IA ciblée
            await node.generateWithAI({
              prompt        : 'Auto-guérison : renforce la sagesse collective et l\'intégrité du nœud.',
              ai            : 'thevie',
              maxTokens     : 64,
              useSpeculative: false,
            });
            break;

          case HealingAction.StartDreamCycle:
            await node.runEvolutionCycle();
            break;

          case HealingAction.SyncNetwork:
            await node.syncWithNetwork();
            break;

          case HealingAction.InjectLesson:
            await node.injectLesson(
              'Leçon auto-corrective : maintenir la cohérence du réseau et la qualité des contributions.'
            );
            break;

          case HealingAction.PruneOldData:
            await node.replicateFiles?.().catch(() => {});
            break;

          case HealingAction.BoostReputation:
            // Sagesse indirectement boostée via une leçon + dream cycle
            await node.injectLesson('Consolidation de la réputation par injection de connaissance.');
            break;

          case HealingAction.RebalanceCollective:
            // Déclenche un cycle d'évolution plus profond
            await node.runEvolutionCycle();
            await node.syncWithNetwork();
            break;
        }

        // Récompense de guérison
        if (rewards instanceof UserRewards) {
          rewards.totalSkyEarned += REWARD_HEALING;
        }

        this.#record(action, issue);
        this.healsPerformed++;
        console.info(`[Sentinel] ✅ Action ${action} appliquée (${issue.severity}: ${issue.message})`);

      } catch (err) {
        console.error(`[Sentinel] ❌ Action ${action} échouée : ${err.message}`);
        this.#record(action, issue, err.message);
      }
    }

    this.lastHealing = new Date();
    console.info(`[Sentinel] Healing terminé — ${issues.length} action(s)`);
  }

  // ─── Basique (compatibilité Thevie) ──────────────────────────

  /**
   * Version synchrone légère pour les appelants qui ne veulent pas
   * await (ex. processQuery dans thevie.js).
   * Détecte et lance la guérison en arrière-plan.
   */
  detectAndHealAsync(node, rewards = null) {
    const issues = this.detectIssues(node);
    if (issues.length > 0) {
      this.triggerHealing(issues, node, rewards).catch(e =>
        console.warn('[Sentinel] Healing background:', e.message)
      );
    }
    return issues;
  }

  // ─── Lecture ─────────────────────────────────────────────────

  getHistory(limit = 50) {
    return this.#healingHistory.slice(-limit);
  }

  summary() {
    return {
      issuesDetected: this.issuesDetected,
      healsPerformed: this.healsPerformed,
      lastHealing   : this.lastHealing?.toISOString() ?? null,
      historySize   : this.#healingHistory.length,
    };
  }

  // ─── Privés ───────────────────────────────────────────────────

  #record(action, issue, error = null) {
    this.#healingHistory.push({
      action,
      severity : issue.severity,
      message  : issue.message,
      ts       : new Date().toISOString(),
      error,
    });
    if (this.#healingHistory.length > HEALING_HISTORY_MAX) this.#healingHistory.shift();
  }
}
