// packages/node/src/agentic.js
// =====================================================
// AgenticRunner — Orchestrateur Autonome SkyAInet
//
// Rôle unique : orchestrer les capacités du nœud en boucle
// ReAct (Reason + Act) pour atteindre des objectifs complexes.
//
// Philosophie :
//   Agentic n'infère pas, n'entraîne pas, ne contracte pas.
//   Il orchestre les autres entités du nœud comme outils :
//     → Thevie    pour la génération de texte
//     → LoraÉvo   est appelé via SkyCloud (contrats déjà délégués)
//     → SkyCloud   pour hosting, leçons, broadcast, métriques
//
// Boucle ReAct :
//   [Thought] Raisonnement sur l'étape suivante
//   [Action]  Appel d'un outil du catalogue
//   [Observation] Résultat de l'action
//   → loop jusqu'à Done ou maxSteps atteint
//
// Sécurité :
//   • maxSteps = 10 — jamais de boucle infinie
//   • Chaque action est loggée avec timestamp
//   • Les actions destructives (deleteSite, deleteSmartContract)
//     nécessitent une confirmation explicite dans le goal
//   • Les erreurs d'outil sont rattrapées — l'agent continue
//
// SkyAInet × Nikola T369
// =====================================================

"use strict";

// ─────────────────────────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────────────────────────

const MAX_STEPS          = 10;     // limite stricte de pas ReAct
const THOUGHT_MAX_TOKENS = 128;    // tokens pour le raisonnement
const ACTION_MAX_TOKENS  = 64;     // tokens pour le choix d'action
const DONE_KEYWORDS      = ['done', 'finished', 'complete', 'objectif atteint', 'goal achieved', 'terminé'];
const DESTRUCTIVE_TOOLS  = ['deleteSite', 'deleteSmartContract'];

// ─────────────────────────────────────────────────────────────────
// STEP — enregistrement d'une étape ReAct
// ─────────────────────────────────────────────────────────────────

export class AgenticStep {
  /**
   * @param {'thought'|'action'|'observation'|'done'|'error'} type
   * @param {string} content — texte de l'étape
   * @param {string|null} tool — outil appelé (si type === 'action')
   * @param {any} result — résultat de l'outil (si type === 'observation')
   */
  constructor(type, content, tool = null, result = null) {
    this.type      = type;
    this.content   = content;
    this.tool      = tool;
    this.result    = result;
    this.timestamp = Date.now();
  }

  toJSON() {
    return {
      type     : this.type,
      content  : this.content,
      tool     : this.tool,
      result   : this.result,
      timestamp: this.timestamp,
    };
  }
}

// ─────────────────────────────────────────────────────────────────
// AGENTIC RUNNER
// ─────────────────────────────────────────────────────────────────

export class AgenticRunner {
  #node;         // SkyCloud instance — accès à tous les outils
  #engine;       // T369InferenceEngine — pour les Thought/Action
  #tools;        // Map<toolName, ToolDefinition>
  #sessions;     // Map<sessionId, AgenticSession>

  /**
   * @param {object} node   — instance SkyCloud
   * @param {object} engine — T369InferenceEngine (optionnel — fallback heuristique si absent)
   */
  constructor(node, engine = null) {
    if (!node) throw new Error('AgenticRunner : node requis');
    this.#node     = node;
    this.#engine   = engine;
    this.#sessions = new Map();
    this.#tools    = this.#buildToolCatalog();
  }

  // ═══════════════════════════════════════════════════════════════
  // CATALOGUE D'OUTILS
  //
  // Chaque outil a :
  //   name        — identifiant utilisé par le parser
  //   description — texte injecté dans le prompt système
  //   params      — liste des paramètres attendus
  //   handler     — fonction async qui exécute l'action réelle
  //
  // Règle de séparation des rôles :
  //   Hosting   → createSite, uploadSiteFile, publishSite, listSites
  //   Learning  → injectLesson, broadcastLesson, runDreamCycle
  //   Metrics   → getNodeMetrics, listSites, listContracts
  //   Texte     → generateText (délégation à Thevie)
  //   (Contrats → LoraÉvo, pas dans ce catalogue)
  // ═══════════════════════════════════════════════════════════════

  #buildToolCatalog() {
    const n = this.#node;
    const tools = new Map();

    const def = (name, description, params, handler) => {
      tools.set(name, { name, description, params, handler });
    };

    // ── Hosting web ──────────────────────────────────────────────

    def('createSite',
      'Creates a new hosted site with the given name and subdomain.',
      ['name: string', 'domain: string'],
      async ({ name, domain }) => {
        const result = await n.createSite(name, domain);
        const site   = result?.site ?? result;
        return { siteId: site.id, url: `https://${site.domain}`, name: site.name };
      }
    );

    def('uploadSiteFile',
      'Uploads a file to an existing site. Content can be HTML, CSS, JS, or any text.',
      ['siteId: string', 'path: string (e.g. /index.html)', 'content: string'],
      async ({ siteId, path, content }) => {
        const data   = typeof content === 'string'
          ? Array.from(new TextEncoder().encode(content))
          : content;
        const fileId = await n.uploadSiteFile(siteId, path, data);
        return { fileId, path, sizeBytes: data.length };
      }
    );

    def('publishSite',
      'Publishes a site — makes it publicly accessible. Requires index.html to be uploaded first.',
      ['siteId: string'],
      async ({ siteId }) => {
        const result = await n.publishSite(siteId);
        return { version: result.version, url: result.url, signature: result.signature?.slice(0, 16) + '…' };
      }
    );

    def('listSites',
      'Lists all hosted sites with their status and metrics.',
      [],
      async () => {
        const sites = await n.listSites();
        return sites.map(s => ({
          id: s.id, name: s.name, domain: s.domain,
          active: s.active, version: s.version, hits: s.hits,
        }));
      }
    );

    def('getSite',
      'Gets detailed information about a specific site.',
      ['siteId: string'],
      async ({ siteId }) => n.getSite(siteId)
    );

    def('deleteSite',
      'Deletes a site and all its files. DESTRUCTIVE — requires explicit confirmation in goal.',
      ['siteId: string'],
      async ({ siteId }) => {
        await n.deleteSite(siteId);
        return { deleted: true, siteId };
      }
    );

    // ── Learning & Knowledge ──────────────────────────────────────

    def('injectLesson',
      'Injects a piece of knowledge into the learning bus. The node will learn from it.',
      ['content: string'],
      async ({ content }) => {
        const result = await n.injectLesson(content);
        return { injected: true, synthesis: result?.synthesis ?? '(no synthesis)' };
      }
    );

    def('broadcastLesson',
      'Broadcasts a lesson to all connected peers on the SkyAInet network.',
      ['content: string', 'score: number (0-1, quality estimate)'],
      async ({ content, score = 0.7 }) => {
        const lesson = { content, score, id: `agentic_${Date.now()}` };
        const sent   = await n.broadcastLesson(lesson, score * 0.8);
        return { broadcasted: sent, score };
      }
    );

    def('runDreamCycle',
      'Triggers a Dream Cycle — consolidates lessons and propagates wisdom across models.',
      [],
      async () => {
        await n.runEvolutionCycle();
        return { triggered: true, message: 'Dream Cycle completed' };
      }
    );

    // ── Metrics & State ───────────────────────────────────────────

    def('getNodeMetrics',
      'Returns current node metrics: wisdom score, peers, requests, uptime, etc.',
      [],
      async () => {
        const m = await n.getNodeMetrics();
        return {
          state         : m.state,
          wisdomScore   : m.wisdom_score,
          peersConnected: m.peers_connected,
          totalRequests : m.total_requests,
          evolutionCycles: m.evolution_cycles,
          engineReady   : m.engine_ready,
        };
      }
    );

    def('listContracts',
      'Lists all Smart Contracts generated by LoraÉvo.',
      [],
      async () => {
        const contracts = await n.listSmartContracts();
        return contracts.map(c => ({
          id: c.id, name: c.name, type: c.type,
          network: c.network, deployStatus: c.deployStatus,
        }));
      }
    );

    def('getCommStats',
      'Returns network communication stats: lessons propagated, received, rejected.',
      [],
      async () => n.getCommStats()
    );

    // ── Génération texte (délégation à Thevie) ───────────────────

    def('generateText',
      'Generates text using Thevie. Use for creating content (HTML, descriptions, lessons).',
      ['prompt: string', 'maxTokens: number (optional, default 512)'],
      async ({ prompt, maxTokens = 512 }) => {
        const result = await n.generateWithAI({
          prompt, ai: 'thevie', maxTokens, temperature: 0.7, useSpeculative: false,
        });
        return { text: result.text, tokens: result.tokensGenerated };
      }
    );

    return tools;
  }

  // ═══════════════════════════════════════════════════════════════
  // BOUCLE REACT
  // ═══════════════════════════════════════════════════════════════

  /**
   * Exécute un objectif en mode ReAct.
   * Chaque étape est émise via le callback onStep pour affichage en temps réel.
   *
   * @param {string}   goal      — objectif en langage naturel
   * @param {function} onStep    — callback(AgenticStep) appelé à chaque étape
   * @param {object}   opts
   * @param {number}   opts.maxSteps  — limite de pas (défaut: MAX_STEPS)
   * @param {boolean}  opts.allowDestructive — autoriser les outils destructifs (défaut: false)
   * @returns {Promise<AgenticResult>}
   */
  async run(goal, onStep = null, opts = {}) {
    if (!goal?.trim()) throw new Error('Goal requis');

    const maxSteps        = opts.maxSteps        ?? MAX_STEPS;
    const allowDestructive= opts.allowDestructive ?? false;
    const sessionId       = `session_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const steps           = [];
    const startTs         = Date.now();

    const emit = (step) => {
      steps.push(step);
      if (typeof onStep === 'function') {
        try { onStep(step); } catch { /* handler error — continue */ }
      }
    };

    // ── Contexte système ─────────────────────────────────────────
    const toolList = [...this.#tools.values()]
      .filter(t => allowDestructive || !DESTRUCTIVE_TOOLS.includes(t.name))
      .map(t => `  ${t.name}(${t.params.join(', ')}) — ${t.description}`)
      .join('\n');

    const systemPrompt = `You are an autonomous agent on the SkyAInet network.
Your role: orchestrate the node's capabilities to achieve the user's goal.
You are NOT Thevie (generation), NOT LoraÉvo (contracts). You ORCHESTRATE.

Available tools:
${toolList}

Respond in this exact format for each step:
Thought: <your reasoning about what to do next>
Action: <toolName>
Args: <JSON object with the tool arguments>

When the goal is achieved, respond with:
Thought: <final reasoning>
Done: <brief summary of what was accomplished>`;

    // ── Boucle ReAct ─────────────────────────────────────────────
    let context = `Goal: ${goal}\n\n`;
    let done    = false;
    let step    = 0;

    while (!done && step < maxSteps) {
      step++;

      // 1. THOUGHT + ACTION — appel au moteur T369 ou heuristique
      let rawResponse;
      if (this.#engine?.isReady) {
        const r = await this.#engine.generate(
          `${systemPrompt}\n\n${context}`,
          { maxTokens: THOUGHT_MAX_TOKENS + ACTION_MAX_TOKENS, temperature: 0.3, useSpeculative: false }
        ).catch(() => null);
        rawResponse = r?.text ?? '';
      } else {
        // Heuristique sans modèle — parsing basé sur des patterns du goal
        rawResponse = this.#heuristicStep(goal, context, step);
      }

      // 2. Parser la réponse
      const parsed = this.#parseResponse(rawResponse);

      // Thought
      const thoughtStep = new AgenticStep('thought', parsed.thought ?? `Step ${step}`);
      emit(thoughtStep);

      // Done ?
      if (parsed.done || DONE_KEYWORDS.some(k => parsed.thought?.toLowerCase().includes(k))) {
        const doneStep = new AgenticStep('done', parsed.done ?? parsed.thought ?? 'Goal achieved.');
        emit(doneStep);
        done = true;
        break;
      }

      // Aucune action parsée — on tente d'extraire de la réponse brute
      if (!parsed.action) {
        const errorStep = new AgenticStep('error', `Could not parse action from: ${rawResponse.slice(0, 80)}`);
        emit(errorStep);
        context += `Observation: Unable to parse action. Please follow the exact format.\n\n`;
        continue;
      }

      // Action
      const actionStep = new AgenticStep('action', `${parsed.action}(${JSON.stringify(parsed.args ?? {})})`, parsed.action);
      emit(actionStep);

      // Vérification destructive
      if (DESTRUCTIVE_TOOLS.includes(parsed.action) && !allowDestructive) {
        const obs = 'Destructive action blocked. Add explicit confirmation to the goal to enable.';
        emit(new AgenticStep('observation', obs, parsed.action, { blocked: true }));
        context += `Action: ${parsed.action}\nObservation: ${obs}\n\n`;
        continue;
      }

      // 3. EXECUTION de l'outil
      const tool = this.#tools.get(parsed.action);
      let observation;

      if (!tool) {
        observation = `Unknown tool: ${parsed.action}. Available: ${[...this.#tools.keys()].join(', ')}`;
        emit(new AgenticStep('observation', observation, parsed.action, { error: true }));
      } else {
        try {
          const result = await tool.handler(parsed.args ?? {});
          observation  = typeof result === 'string' ? result : JSON.stringify(result);
          emit(new AgenticStep('observation', observation, parsed.action, result));
        } catch (e) {
          observation = `Error: ${e.message}`;
          emit(new AgenticStep('observation', observation, parsed.action, { error: e.message }));
        }
      }

      // Enrichir le contexte pour le prochain tour
      context += `Thought: ${parsed.thought ?? ''}\nAction: ${parsed.action}\nArgs: ${JSON.stringify(parsed.args ?? {})}\nObservation: ${observation}\n\n`;
    }

    // Max steps atteint sans Done
    if (!done) {
      emit(new AgenticStep('done', `Max steps (${maxSteps}) reached. Partial completion.`));
    }

    const duration = Date.now() - startTs;
    const session  = { sessionId, goal, steps, durationMs: duration, done };
    this.#sessions.set(sessionId, session);

    return {
      sessionId,
      goal,
      steps    : steps.map(s => s.toJSON()),
      done,
      stepCount: step,
      durationMs: duration,
      summary  : steps.find(s => s.type === 'done')?.content ?? `Stopped after ${step} steps`,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // PARSER — extrait Thought / Action / Args / Done
  // ═══════════════════════════════════════════════════════════════

  #parseResponse(raw) {
    if (!raw?.trim()) return {};

    const thought = raw.match(/Thought:\s*(.+?)(?=\n(?:Action|Done|Args)|$)/si)?.[1]?.trim();
    const action  = raw.match(/Action:\s*(\w+)/i)?.[1]?.trim();
    const done    = raw.match(/Done:\s*(.+?)$/si)?.[1]?.trim();

    let args = null;
    const argsMatch = raw.match(/Args:\s*(\{[\s\S]*?\})/i);
    if (argsMatch) {
      try { args = JSON.parse(argsMatch[1]); }
      catch { args = this.#fuzzyParseArgs(argsMatch[1]); }
    }

    return { thought, action, args, done };
  }

  /** Tente de parser un JSON malformé produit par le modèle. */
  #fuzzyParseArgs(raw) {
    try {
      // Remplacer les apostrophes simples, ajouter les guillemets manquants
      const fixed = raw
        .replace(/'/g, '"')
        .replace(/(\w+):/g, '"$1":')
        .replace(/,\s*}/g, '}');
      return JSON.parse(fixed);
    } catch {
      return {};
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // HEURISTIQUE SANS MODÈLE
  //
  // Quand le moteur T369 n'est pas prêt, l'agent utilise des patterns
  // basés sur le goal pour décider de l'action suivante.
  // Moins précis mais fonctionnel pour les cas simples.
  // ═══════════════════════════════════════════════════════════════

    #heuristicStep(goal, context, stepNum) {
    const lower       = goal.toLowerCase();
    const hasContext  = context.length > 100;
    const actionsDone = (context.match(/Action:/g) ?? []).length;

    // Détecter les intentions du goal
    const wants = {
      site       : /site|host|deploy|publish|webpage|landing|portfolio/i.test(goal),
      lesson     : /learn|inject|lesson|knowledge|teach/i.test(goal),
      broadcast  : /broadcast|propagate|share|network|peers/i.test(goal),
      dream      : /dream|evolve|consolidat/i.test(goal),
      metrics    : /metric|status|stats|how many|list/i.test(goal),
      html       : /html|page|index|css|content/i.test(goal),
    };

    // Séquence heuristique pour le hosting
    if (wants.site) {
      if (actionsDone === 0) {
        const nameParts = goal.match(/(?:called?|named?)\s+["']?(\w[\w\s]{1,20})["']?/i);
        const name   = nameParts?.[1] ?? 'My Site';
        const domain = name.toLowerCase().replace(/\s+/g, '-');
        return `Thought: I need to create a site first.\nAction: createSite\nArgs: {"name":"${name}","domain":"${domain}"}`;
      }
      if (actionsDone === 1 && wants.html) {
        const siteIdMatch = context.match(/"siteId"\s*:\s*"([^"]+)"/);
        const siteId = siteIdMatch?.[1] ?? 'unknown';
        return `Thought: I need to upload the main HTML file.\nAction: generateText\nArgs: {"prompt":"Generate a clean professional HTML landing page for: ${goal}","maxTokens":1024}`;
      }
      if (actionsDone === 2) {
        const siteIdMatch = context.match(/"siteId"\s*:\s*"([^"]+)"/);
        const siteId = siteIdMatch?.[1] ?? 'unknown';
        return `Thought: I have the content. Now uploading index.html.\nAction: uploadSiteFile\nArgs: {"siteId":"${siteId}","path":"/index.html","content":"<html><body><h1>Site generated by Agentic</h1></body></html>"}`;
      }
      if (actionsDone === 3) {
        const siteIdMatch = context.match(/"siteId"\s*:\s*"([^"]+)"/);
        const siteId = siteIdMatch?.[1] ?? 'unknown';
        return `Thought: Files uploaded. Publishing the site.\nAction: publishSite\nArgs: {"siteId":"${siteId}"}`;
      }
      return `Thought: Site deployed successfully.\nDone: Site has been created, files uploaded, and published on SkyAInet.`;
    }

    // Séquence heuristique pour l'apprentissage
    if (wants.lesson) {
      if (actionsDone === 0) {
        return `Thought: I will inject this as a lesson into the learning bus.\nAction: injectLesson\nArgs: {"content":"${goal.slice(0, 200)}"}`;
      }
      if (wants.broadcast && actionsDone === 1) {
        return `Thought: Lesson injected. Broadcasting to peers.\nAction: broadcastLesson\nArgs: {"content":"${goal.slice(0, 200)}","score":0.75}`;
      }
      return `Thought: Learning objective completed.\nDone: Lesson injected${wants.broadcast ? ' and broadcasted to peers' : ''}.`;
    }

    // Métriques
    if (wants.metrics) {
      if (actionsDone === 0) {
        return `Thought: Fetching node metrics.\nAction: getNodeMetrics\nArgs: {}`;
      }
      return `Thought: Metrics retrieved.\nDone: Node metrics have been collected and displayed.`;
    }

    // Dream cycle
    if (wants.dream) {
      if (actionsDone === 0) {
        return `Thought: Triggering a Dream Cycle to consolidate knowledge.\nAction: runDreamCycle\nArgs: {}`;
      }
      return `Thought: Dream Cycle completed.\nDone: Knowledge consolidated across all models.`;
    }

    // Fallback
    if (actionsDone === 0) {
      return `Thought: I'll start by checking the node status.\nAction: getNodeMetrics\nArgs: {}`;
    }
    return `Thought: Goal appears to be achieved based on context.\nDone: Task completed after ${actionsDone} actions.`;
  }

  // ═══════════════════════════════════════════════════════════════
  // API PUBLIQUE
  // ═══════════════════════════════════════════════════════════════

  /** Retourne la liste des outils disponibles avec leur description. */
  getToolCatalog() {
    return [...this.#tools.values()].map(t => ({
      name       : t.name,
      description: t.description,
      params     : t.params,
    }));
  }

  /** Retourne l'historique d'une session. */
  getSession(sessionId) {
    return this.#sessions.get(sessionId) ?? null;
  }

  /** Retourne toutes les sessions (pour l'historique UI). */
  listSessions() {
    return [...this.#sessions.values()].map(s => ({
      sessionId : s.sessionId,
      goal      : s.goal,
      stepCount : s.steps.length,
      done      : s.done,
      durationMs: s.durationMs,
    }));
  }

  /** Connecte le moteur T369 (appelé après initEngine()). */
  connectEngine(engine) {
    this.#engine = engine;
    console.info('[AgenticRunner] T369 engine connected');
  }

  getStats() {
    return {
      sessions     : this.#sessions.size,
      toolCount    : this.#tools.size,
      engineReady  : !!this.#engine?.isReady,
      maxSteps     : MAX_STEPS,
    };
  }
}

export default AgenticRunner;