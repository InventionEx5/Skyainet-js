// packages/node/src/engine_supervisor.js
// =====================================================
// EngineSupervisor — Lifecycle du moteur d'inférence embarqué
//
// Gère un moteur natif (llama.cpp / vLLM / MLX) en SOUS-PROCESSUS supervisé
// par Node : spawn, health-check, redémarrage auto sur crash (backoff), arrêt
// propre. SkyCloud expose ensuite sa PROPRE API HTTP locale par-dessus —
// souverain : tout sur localhost, zéro dépendance à un service tiers.
//
// Backend-agnostique : chaque nœud choisit son moteur sans changer l'API
// SkyCloud. Le binaire natif est un ASSET bundlé (comme ffmpeg/sqlite),
// pas du Rust/Tauri dans le code.
//
// `child_process` est natif Node (pas de dépendance npm). spawn + fetch sont
// injectables → testable en isolation sans binaire réel.
//
// SkyAInet × Thevie × Nikola T369
// =====================================================

"use strict";

import { spawn as nodeSpawn } from 'child_process';

// ─────────────────────────────────────────────────────────────────
// MOTEURS SUPPORTÉS
// ─────────────────────────────────────────────────────────────────

export const EngineKind = Object.freeze({
  LlamaCpp: 'llamacpp',   // llama-server — universel CPU/GPU (défaut)
  VLLM    : 'vllm',       // nœud GPU haute perf (S-LoRA multi-adapters)
  MLX     : 'mlx',        // Apple Silicon
});

const DEFAULTS = {
  kind            : EngineKind.LlamaCpp,
  host            : '127.0.0.1',
  port            : 8799,
  model           : 'model.gguf',
  ctx             : 4096,
  extraArgs       : [],
  maxRestarts     : 5,
  restartBackoffMs: 1000,
  healthTimeoutMs : 30_000,
  healthIntervalMs: 500,
};

// Construit la commande de lancement selon le moteur.
function buildCommand(kind, { model, port, host, ctx, extraArgs = [] }) {
  switch (kind) {
    case EngineKind.VLLM:
      return { cmd: 'vllm', args: ['serve', model, '--host', host, '--port', String(port), ...extraArgs] };
    case EngineKind.MLX:
      return { cmd: 'mlx_lm.server', args: ['--model', model, '--host', host, '--port', String(port), ...extraArgs] };
    case EngineKind.LlamaCpp:
    default:
      return { cmd: 'llama-server', args: ['-m', model, '--host', host, '--port', String(port), '-c', String(ctx), ...extraArgs] };
  }
}

// ─────────────────────────────────────────────────────────────────
// ENGINE SUPERVISOR
// ─────────────────────────────────────────────────────────────────

export class EngineSupervisor {
  #cfg;
  #spawn;
  #fetch;
  #proc;
  #state;        // stopped | starting | ready | crashed | stopping
  #restarts;
  #starting;     // Promise en cours de démarrage

  constructor(opts = {}) {
    this.#cfg      = { ...DEFAULTS, ...opts };
    this.#spawn    = opts.spawn ?? nodeSpawn;          // injectable (tests)
    this.#fetch    = opts.fetch ?? globalThis.fetch;   // injectable (tests)
    this.#proc     = null;
    this.#state    = 'stopped';
    this.#restarts = 0;
    this.#starting = null;
  }

  get isReady()  { return this.#state === 'ready'; }
  get endpoint() { return `http://${this.#cfg.host}:${this.#cfg.port}`; }
  get pid()      { return this.#proc?.pid ?? null; }
  get kind()     { return this.#cfg.kind; }

  // ─── Lifecycle ────────────────────────────────────────────────

  /** Démarre le sous-processus moteur et attend qu'il soit healthy. */
  async start() {
    if (this.#state === 'ready') return this;
    if (this.#state === 'starting') return this.#starting ?? this;

    this.#state = 'starting';
    const { cmd, args } = buildCommand(this.#cfg.kind, this.#cfg);
    console.info(`[Engine] Démarrage ${this.#cfg.kind} : ${cmd} ${args.join(' ')}`);

    this.#proc = this.#spawn(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'] });
    this.#proc?.on?.('exit',  (code) => this.#onExit(code));
    this.#proc?.on?.('error', (e)    => { console.error(`[Engine] spawn échec : ${e.message}`); this.#state = 'crashed'; });

    this.#starting = this.#awaitHealthy().then(() => this);
    return this.#starting;
  }

  /** Arrêt propre du sous-processus. */
  async stop() {
    this.#state = 'stopping';
    try { this.#proc?.kill?.('SIGTERM'); } catch { /* déjà mort */ }
    this.#proc  = null;
    this.#state = 'stopped';
    console.info('[Engine] arrêté');
    return this;
  }

  /** Redémarrage manuel (réinitialise le compteur). */
  async restart() {
    await this.stop();
    this.#restarts = 0;
    return this.start();
  }

  // ─── Proxy souverain (SkyCloud → sous-processus) ─────────────

  /**
   * Génération via le moteur embarqué. SkyCloud appelle ça ; le superviseur
   * parle au sous-processus sur localhost. Réponses parsées de façon
   * agnostique (llama.cpp `content` ou OpenAI-compat `choices[].text`).
   */
  async generate(prompt, opts = {}) {
    if (!this.isReady) throw new Error('[Engine] moteur non prêt');
    const r = await this.#fetch(`${this.endpoint}${this.#completionPath()}`, {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({
        prompt,
        n_predict  : opts.maxTokens   ?? 256,   // llama.cpp
        max_tokens : opts.maxTokens   ?? 256,   // OpenAI-compat
        temperature: opts.temperature ?? 0.7,
        ...(opts.extra ?? {}),
      }),
    });
    const data = await r.json();
    const text = data.content ?? data.choices?.[0]?.text ?? data.choices?.[0]?.message?.content ?? data.text ?? '';
    return { text, tokens: data.tokens_predicted ?? data.usage?.completion_tokens ?? null };
  }

  /** Embeddings via le moteur embarqué. */
  async embed(text) {
    if (!this.isReady) throw new Error('[Engine] moteur non prêt');
    const r = await this.#fetch(`${this.endpoint}/embedding`, {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({ content: text, input: text }),
    });
    const data = await r.json();
    return data.embedding ?? data.data?.[0]?.embedding ?? [];
  }

  status() {
    return {
      kind    : this.#cfg.kind,
      state   : this.#state,
      ready   : this.isReady,
      endpoint: this.endpoint,
      pid     : this.pid,
      restarts: this.#restarts,
    };
  }

  // ─── Privé ────────────────────────────────────────────────────

  #completionPath() {
    return this.#cfg.kind === EngineKind.LlamaCpp ? '/completion' : '/v1/completions';
  }

  /** Poll /health jusqu'à readiness ou timeout. */
  async #awaitHealthy() {
    const deadline = Date.now() + this.#cfg.healthTimeoutMs;
    while (Date.now() < deadline) {
      if (this.#state === 'crashed') throw new Error('[Engine] crash pendant le démarrage');
      if (await this.#pingHealth()) {
        this.#state    = 'ready';
        this.#restarts = 0;
        console.info(`[Engine] prêt sur ${this.endpoint} (pid ${this.pid})`);
        return;
      }
      await _sleep(this.#cfg.healthIntervalMs);
    }
    throw new Error(`[Engine] health timeout après ${this.#cfg.healthTimeoutMs}ms`);
  }

  async #pingHealth() {
    if (!this.#fetch) return false;
    try {
      const r = await this.#fetch(`${this.endpoint}/health`);
      return !!(r && (r.ok ?? r.status === 200));
    } catch { return false; }
  }

  /** Redémarrage automatique sur crash (backoff exponentiel + plafond). */
  #onExit(code) {
    if (this.#state === 'stopping' || this.#state === 'stopped') return;  // arrêt voulu
    console.warn(`[Engine] sous-processus terminé (code ${code})`);
    this.#state = 'crashed';
    this.#proc  = null;

    if (this.#restarts >= this.#cfg.maxRestarts) {
      console.error(`[Engine] ${this.#cfg.maxRestarts} redémarrages atteints — abandon`);
      return;
    }
    const delay = this.#cfg.restartBackoffMs * Math.pow(2, this.#restarts);
    this.#restarts++;
    console.info(`[Engine] redémarrage ${this.#restarts}/${this.#cfg.maxRestarts} dans ${delay}ms`);
    setTimeout(() => {
      if (this.#state === 'crashed') this.start().catch(e => console.error('[Engine]', e.message));
    }, delay);
  }
}

export default EngineSupervisor;

// ─────────────────────────────────────────────────────────────────
function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
