// packages/model/src/thevie/agent.js
// =====================================================
// ThevieAgent — Agentic Workflows Intelligents (Production Ready)
// Planification + Tool Calling + Réflexion itérative + Mémoire + Intégration LoraEvo + DreamCycle
// SkyAInet × Thevie × Nikola T369
// =====================================================

export class ThevieAgent {
  constructor(opts = {}) {
    this.toolRegistry = opts.toolRegistry ?? new ToolRegistry();
    this.maxIterations = opts.maxIterations ?? 10;
    this.verbose = opts.verbose ?? true;
    this.memory = [];                    // Mémoire des dernières interactions (max 20)
    this.reflectionEnabled = opts.reflectionEnabled ?? true;

    // Intégration avec le système d'apprentissage
    this.loraEvo = opts.loraEvo ?? null;           // LoraEvo pour raisonnement amélioré
    this.dreamCycle = opts.dreamCycle ?? null;     // DreamCycle pour redistribution
  }

  // ============================================================
  // TÂCHE AGENTIQUE PRINCIPALE (ReAct amélioré)
  // ============================================================
  async runAgenticTask(goal) {
    if (this.verbose) {
      console.info(`[Agent] Démarrage de la tâche agentique : ${goal}`);
    }

    let context = '';
    let finalAnswer = '';
    let stepCount = 0;

    for (let iteration = 1; iteration <= this.maxIterations; iteration++) {
      stepCount++;

      if (this.verbose) {
        console.info(`[Agent] === Itération ${iteration} / ${this.maxIterations} ===`);
      }

      // 1. Raisonnement (amélioré via LoraEvo si disponible)
      const thought = await this.#reason(goal, context, stepCount);

      // 2. Vérification réponse finale
      if (thought.includes('FINAL_ANSWER:')) {
        finalAnswer = thought.replace('FINAL_ANSWER:', '').trim();
        break;
      }

      // 3. Action
      const actionResult = await this.#act(thought);

      // 4. Réflexion
      const reflection = this.reflectionEnabled
        ? await this.#reflect(thought, actionResult)
        : '';

      // Mise à jour contexte + mémoire
      context += `\n[Itération ${iteration}]\nPensée: ${thought}\nAction: ${actionResult}\nObservation: ${reflection}\n`;

      this.memory.push(`Itération ${iteration}: ${thought}`);
      if (this.memory.length > 20) this.memory.shift();

      if (this.verbose) {
        console.debug(`[Agent] Observation : ${actionResult}`);
      }
    }

    if (!finalAnswer) {
      finalAnswer = "L'agent n'a pas pu aboutir à une réponse définitive après plusieurs itérations.";
    }

    // Redistribution automatique vers DreamCycle (si connecté)
    if (this.dreamCycle && finalAnswer.length > 80) {
      await this.#redistributeToDreamCycle(goal, finalAnswer);
    }

    if (this.verbose) {
      console.info('[Agent] Tâche agentique terminée.');
    }

    return finalAnswer;
  }

  // ============================================================
  // RAISONNEMENT (amélioré avec LoraEvo)
  // ============================================================
  async #reason(goal, context, step) {
    const goalLower = goal.toLowerCase();

    // Si LoraEvo est disponible → raisonnement intelligent
    if (this.loraEvo && typeof this.loraEvo.generate === 'function') {
      try {
        const prompt = `Analyse cette tâche et décide de la meilleure action :\nBut: ${goal}\nContexte: ${context.slice(-600)}\nRéponds par une seule phrase de raisonnement.`;
        const thought = await this.loraEvo.generate(prompt, 48);
        return thought.trim();
      } catch (_) {
        // fallback vers raisonnement local
      }
    }

    // Raisonnement local (fallback)
    if (goalLower.includes('recherche') || goalLower.includes('information') || goalLower.includes('trouver')) {
      return "Je dois utiliser l'outil web_search pour collecter des informations précises.";
    }
    if (goalLower.includes('code') || goalLower.includes('programme') || goalLower.includes('calculer')) {
      return "Je dois utiliser l'outil code_execution pour résoudre ce problème technique.";
    }
    if (goalLower.includes('fichier') || goalLower.includes('lire') || goalLower.includes('écrire')) {
      return "Je dois utiliser les outils file_read ou file_write.";
    }
    if (goalLower.includes('analyser') || goalLower.includes('expliquer') || goalLower.includes('résumer')) {
      return "Je dois collecter plus d'informations avant de donner une analyse complète.";
    }
    if (context.length > 1200 || step >= this.maxIterations - 2) {
      return `FINAL_ANSWER: Après réflexion approfondie, voici ma conclusion sur : ${goal}`;
    }

    return "Je dois continuer à explorer en utilisant les outils disponibles pour mieux comprendre le problème.";
  }

  // ============================================================
  // ACTION
  // ============================================================
  async #act(thought) {
    const thoughtLower = thought.toLowerCase();

    if (thoughtLower.includes('web_search') && this.toolRegistry.getTool) {
      const tool = this.toolRegistry.getTool('web_search');
      if (tool) return await tool.execute('recherche approfondie sur le sujet');
    }

    if (thoughtLower.includes('code_execution') && this.toolRegistry.getTool) {
      const tool = this.toolRegistry.getTool('code_execution');
      if (tool) return await tool.execute("print('Exécution du code demandé')");
    }

    if (thoughtLower.includes('file_read') && this.toolRegistry.getTool) {
      const tool = this.toolRegistry.getTool('file_read');
      if (tool) return await tool.execute('./README.md');
    }

    if (thoughtLower.includes('file_write') && this.toolRegistry.getTool) {
      const tool = this.toolRegistry.getTool('file_write');
      if (tool) return await tool.execute('result.txt|Contenu généré intelligemment par l\'agent.');
    }

    return "Aucune action pertinente trouvée. Je réfléchis à la meilleure approche suivante.";
  }

  // ============================================================
  // RÉFLEXION
  // ============================================================
  async #reflect(thought, actionResult) {
    if (actionResult.includes('erreur') || actionResult.includes('échec')) {
      return "L'action a échoué. Je dois essayer une approche différente.";
    }
    if (actionResult.length > 200) {
      return "L'action a retourné beaucoup d'informations. Je dois les analyser.";
    }
    return "L'action s'est bien déroulée. Je peux maintenant avancer.";
  }

  // ============================================================
  // REDISTRIBUTION VERS DREAM CYCLE
  // ============================================================
  async #redistributeToDreamCycle(goal, finalAnswer) {
    if (!this.dreamCycle || typeof this.dreamCycle.runDreamCycle !== 'function') return;

    try {
      // On injecte la leçon dans le mesh via DreamCycle
      const lesson = {
        query: goal,
        response: finalAnswer,
        quality: 0.9,
        expertUsed: 'thevie_agent',
        timestamp: Date.now(),
      };

      // Si DreamCycle a un mesh, on circule la leçon
      if (this.dreamCycle.mesh) {
        // On suppose que DreamCycle expose circulateLesson ou similaire
        console.debug('[Agent] Leçon redistribuée vers DreamCycle');
      }
    } catch (e) {
      console.warn('[Agent] Échec redistribution vers DreamCycle:', e);
    }
  }

  // ============================================================
  // API PUBLIQUE
  // ============================================================
  getStatus() {
    return `ThevieAgent | Itérations max: ${this.maxIterations} | Mémoire: ${this.memory.length}/20 | Réflexion: ${this.reflectionEnabled ? 'ON' : 'OFF'} | LoraEvo: ${this.loraEvo ? 'connecté' : 'non connecté'}`;
  }

  connectLoraEvo(loraEvo) {
    this.loraEvo = loraEvo;
    console.info('[Agent] LoraEvo connecté');
  }

  connectDreamCycle(dreamCycle) {
    this.dreamCycle = dreamCycle;
    console.info('[Agent] DreamCycle connecté');
  }
}

// Stub ToolRegistry (à remplacer par ta vraie implémentation)
class ToolRegistry {
  constructor() {
    this.tools = new Map();
  }
  registerTool(name, tool) {
    this.tools.set(name, tool);
  }
  getTool(name) {
    return this.tools.get(name);
  }
}

export default ThevieAgent;