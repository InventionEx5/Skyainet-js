// packages/model/src/thevie/external_providers.js
//
// SOCLE REST — connexion unifiée aux IA frontier externes (professeurs).
// Une seule interface `complete(provider, messages, opts)` au-dessus de DEUX
// schémas : OpenAI-compatible (xAI/Grok + DeepSeek) et Anthropic (Claude).
//
// Quatre garde-fous intégrés :
//   1. Limiteur de débit (token bucket par fournisseur)
//   2. Retry + fallback (si un maître tombe, on bascule sur le suivant)
//   3. Compteur de coût par appel (clé de l'objectif « moins cher »)
//   4. Cache sémantique (via VectorStore) — ne jamais payer deux fois une
//      question similaire
//
// TRANSPORT INJECTÉ : `complete`/`ExternalGateway` reçoivent un `transport`
// (défaut : fetch). En test, on injecte un transport simulé → tout le socle
// est validable HORS-LIGNE ; le vrai `fetch` + les vraies clés se branchent
// au déploiement. Aucune donnée ne sort tant qu'un transport réseau n'est pas
// fourni explicitement.

import { VectorStore, VectorMetadata } from '#vector_store';

// ─────────────────────────────────────────────────────────────────
// Configuration des fournisseurs (endpoints réels — ajustables).
// Le coût provient du registre (costPer1kTokens) ; `costPer1k` ici n'est
// qu'un repli si aucun registre n'est fourni.
// ─────────────────────────────────────────────────────────────────
export const PROVIDER_CONFIG = Object.freeze({
  xai: {
    schema: 'openai', baseUrl: 'https://api.x.ai/v1', path: '/chat/completions',
    envKey: 'XAI_API_KEY', registryName: 'grok-4', defaultModel: 'grok-4', costPer1k: 0.005,
  },
  deepseek: {
    schema: 'openai', baseUrl: 'https://api.deepseek.com/v1', path: '/chat/completions',
    envKey: 'DEEPSEEK_API_KEY', registryName: 'deepseek-v4', defaultModel: 'deepseek-v4', costPer1k: 0.0014,
  },
  anthropic: {
    schema: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', path: '/messages',
    envKey: 'ANTHROPIC_API_KEY', registryName: 'claude-sonnet-4-6', defaultModel: 'claude-sonnet-4-6',
    costPer1k: 0.003, anthropicVersion: '2023-06-01',
  },
});

// ─────────────────────────────────────────────────────────────────
// Adaptateurs de schéma : construction du corps, en-têtes, parsing.
// C'est ICI que les deux dialectes divergent ; tout le reste est commun.
// ─────────────────────────────────────────────────────────────────
export const SCHEMAS = Object.freeze({
  openai: {
    headers: (key) => ({ 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` }),
    body: (model, messages, opts) => JSON.stringify({
      model, messages,                                   // system = message role:'system'
      temperature: opts.temperature ?? 0.7,
      max_tokens: opts.maxTokens ?? 1024,
      stream: false,
    }),
    parse: (j) => ({
      text: j?.choices?.[0]?.message?.content ?? '',
      inputTokens: j?.usage?.prompt_tokens ?? 0,
      outputTokens: j?.usage?.completion_tokens ?? 0,
      finishReason: j?.choices?.[0]?.finish_reason ?? null,
    }),
  },
  anthropic: {
    headers: (key, cfg) => ({
      'Content-Type': 'application/json', 'x-api-key': key,
      'anthropic-version': cfg.anthropicVersion ?? '2023-06-01',
    }),
    body: (model, messages, opts) => {
      // Anthropic : `system` est un champ de haut niveau ; `messages` ne contient
      // que user/assistant.
      const sys = messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
      const msgs = messages.filter(m => m.role !== 'system');
      const payload = { model, max_tokens: opts.maxTokens ?? 1024, temperature: opts.temperature ?? 0.7, messages: msgs };
      if (sys) payload.system = sys;
      return JSON.stringify(payload);
    },
    parse: (j) => ({
      text: Array.isArray(j?.content) ? j.content.filter(b => b.type === 'text').map(b => b.text).join('') : '',
      inputTokens: j?.usage?.input_tokens ?? 0,
      outputTokens: j?.usage?.output_tokens ?? 0,
      finishReason: j?.stop_reason ?? null,
    }),
  },
});

// Transport réseau par défaut (fetch). Renvoie une forme stable {status, ok, json}
// pour que le reste du code soit indépendant de l'implémentation HTTP.
export async function defaultTransport(url, { method, headers, body }) {
  const res = await fetch(url, { method, headers, body });
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, ok: res.ok, json };
}

// ── Token bucket : limiteur de débit par fournisseur ──────────────
class TokenBucket {
  constructor(ratePerSec = 5, burst = 10) { this.rate = ratePerSec; this.capacity = burst; this.tokens = burst; this.last = Date.now(); }
  _refill() { const now = Date.now(); this.tokens = Math.min(this.capacity, this.tokens + (now - this.last) / 1000 * this.rate); this.last = now; }
  tryTake(n = 1) { this._refill(); if (this.tokens >= n) { this.tokens -= n; return true; } return false; }
  msUntil(n = 1) { this._refill(); return this.tokens >= n ? 0 : Math.ceil((n - this.tokens) / this.rate * 1000); }
}

// ── Registre de coût : cumul par fournisseur + total ──────────────
class CostLedger {
  constructor() { this.byProvider = {}; this.totalUSD = 0; this.calls = 0; }
  record(provider, inTok, outTok, costPer1k) {
    const usd = ((inTok + outTok) / 1000) * costPer1k;
    const e = this.byProvider[provider] ??= { inputTokens: 0, outputTokens: 0, usd: 0, calls: 0 };
    e.inputTokens += inTok; e.outputTokens += outTok; e.usd += usd; e.calls++;
    this.totalUSD += usd; this.calls++;
    return usd;
  }
  report() {
    return { totalUSD: +this.totalUSD.toFixed(6), calls: this.calls, byProvider: structuredClone(this.byProvider) };
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export class ExternalApiError extends Error {
  constructor(provider, status, detail) { super(`[${provider}] HTTP ${status}`); this.name = 'ExternalApiError'; this.provider = provider; this.status = status; this.detail = detail; }
}

// ═══════════════════════════════════════════════════════════════════
//  PASSERELLE EXTERNE — orchestration des professeurs frontier.
// ═══════════════════════════════════════════════════════════════════
export class ExternalGateway {
  /**
   * @param {object}   o
   * @param {object}   [o.registry]    — ModelRegistry (pour coût/modelId réels)
   * @param {Function} [o.embed]       — (text)=>Float32Array : active le cache sémantique
   * @param {Function} [o.transport]   — transport HTTP injecté (défaut : fetch)
   * @param {object}   [o.keys]        — { xai, anthropic, deepseek } : clés API
   * @param {number}   [o.cacheThreshold=0.92] — cosinus mini pour un hit de cache
   * @param {number}   [o.cacheDim=128]
   * @param {object}   [o.rateLimits]  — { xai:{rate,burst}, ... } req/s
   * @param {object}   [o.providers]   — override PROVIDER_CONFIG
   */
  constructor({ registry = null, embed = null, transport = defaultTransport, keys = {},
                cacheThreshold = 0.92, cacheDim = 128, rateLimits = {}, providers = PROVIDER_CONFIG,
                redactor = null } = {}) {
    this.registry = registry;
    this.embed = embed;
    this.transport = transport;
    this.keys = keys;
    this.providers = providers;
    this.cacheThreshold = cacheThreshold;
    this.redactor = redactor;   // souveraineté : masque la PII avant tout départ
    this.ledger = new CostLedger();

    this.buckets = {};
    for (const name of Object.keys(providers)) {
      const rl = rateLimits[name] ?? {};
      this.buckets[name] = new TokenBucket(rl.rate ?? 5, rl.burst ?? 10);
    }

    // Cache sémantique : VectorStore trouve le prompt le plus proche ; une Map
    // associe l'id du vecteur à la réponse mémorisée.
    this._cacheEnabled = typeof embed === 'function';
    this._cacheStore = this._cacheEnabled ? new VectorStore(cacheDim) : null;
    this._cachePayload = new Map();
    this._cacheSeq = 0;
    this.cacheHits = 0; this.cacheMisses = 0;
  }

  _key(provider) {
    const cfg = this.providers[provider];
    return this.keys[provider] ?? (cfg?.envKey ? (globalThis.process?.env?.[cfg.envKey] ?? null) : null);
  }
  _model(provider, opts) {
    const cfg = this.providers[provider];
    return opts.model ?? this.registry?.getModel(cfg.registryName)?.modelId ?? cfg.defaultModel;
  }
  _cost1k(provider) {
    const cfg = this.providers[provider];
    return this.registry?.getModel(cfg.registryName)?.costPer1kTokens ?? cfg.costPer1k ?? 0;
  }

  // ── Cache sémantique ──
  _cacheGet(emb) {
    if (!this._cacheEnabled || this._cachePayload.size === 0) return null;
    const hits = this._cacheStore.search(emb, 1, { minQuality: 0 });
    if (hits.length && hits[0].score >= this.cacheThreshold) {
      const id = hits[0].entry.id;
      return this._cachePayload.get(id) ?? null;
    }
    return null;
  }
  _cachePut(emb, payload) {
    if (!this._cacheEnabled) return;
    const id = `c${this._cacheSeq++}`;
    // qualité 1.0 : une entrée de cache est une correspondance exacte autoritaire,
    // le score de recherche ne doit pas être sous-pondéré (search applique
    // cosine × (0.6 + 0.4 × quality)).
    this._cacheStore.insert(id, emb, new VectorMetadata({ quality: 1.0, source: 'cache' }), (payload.text ?? '').slice(0, 120));
    this._cachePayload.set(id, payload);
  }
  _promptText(messages) { return messages.map(m => `${m.role}:${m.content}`).join('\n'); }

  /**
   * Appel unitaire à UN fournisseur (avec cache + limiteur + coût).
   * @returns {Promise<{text,usage,costUSD,provider,model,cached,latencyMs,finishReason}>}
   */
  async complete(provider, messages, opts = {}) {
    const cfg = this.providers[provider];
    if (!cfg) throw new Error(`Fournisseur inconnu : ${provider}`);
    const schema = SCHEMAS[cfg.schema];

    // 0) Rédaction PII : on masque AVANT le cache et le transport, donc rien de
    //    sensible ne quitte le périmètre ni n'est mémorisé en cache.
    const red = (this.redactor && !opts.noRedact) ? this.redactor.redactMessages(messages) : null;
    const msgs = red ? red.messages : messages;
    const redactions = red ? red.found : null;

    // 1) Cache sémantique (sur le texte déjà masqué)
    let emb = null;
    if (this._cacheEnabled && !opts.noCache) {
      emb = this.embed(this._promptText(msgs));
      const hit = this._cacheGet(emb);
      if (hit) {
        this.cacheHits++;
        return { ...hit, cached: true, costUSD: 0, provider, latencyMs: 0, redactions };
      }
      this.cacheMisses++;
    }

    // 2) Limiteur de débit
    const bucket = this.buckets[provider];
    if (bucket) {
      const waitCap = opts.maxRateWaitMs ?? 2000;
      let waited = 0;
      while (!bucket.tryTake(1)) {
        const w = Math.min(bucket.msUntil(1), 250);
        if (waited + w > waitCap) throw new Error(`[${provider}] rate limit (attente > ${waitCap}ms)`);
        await sleep(w); waited += w;
      }
    }

    // 3) Requête HTTP via le schéma
    const key = this._key(provider);
    if (!key && !opts.allowNoKey) throw new Error(`[${provider}] clé API absente (keys.${provider} ou env ${cfg.envKey})`);
    const model = this._model(provider, opts);
    const url = cfg.baseUrl + cfg.path;
    const headers = schema.headers(key ?? 'MISSING', cfg);
    const body = schema.body(model, msgs, opts);

    const t0 = Date.now();
    const res = await this.transport(url, { method: 'POST', headers, body });
    const latencyMs = Date.now() - t0;
    if (!res.ok) throw new ExternalApiError(provider, res.status, res.json);

    const parsed = schema.parse(res.json);

    // 4) Coût
    const costUSD = this.ledger.record(provider, parsed.inputTokens, parsed.outputTokens, this._cost1k(provider));

    const out = {
      text: parsed.text,
      usage: { inputTokens: parsed.inputTokens, outputTokens: parsed.outputTokens },
      finishReason: parsed.finishReason,
      provider, model, cached: false, costUSD, latencyMs, redactions,
    };
    if (emb) this._cachePut(emb, { text: out.text, usage: out.usage, finishReason: out.finishReason, model });
    return out;
  }

  /**
   * Retry + fallback : essaie chaque fournisseur de `chain` dans l'ordre ;
   * passe au suivant en cas d'erreur. Renvoie la 1re réussite.
   */
  async completeWithFallback(chain, messages, opts = {}) {
    const errors = [];
    for (const provider of chain) {
      try { return await this.complete(provider, messages, opts); }
      catch (e) { errors.push({ provider, error: e.message }); }
    }
    const err = new Error(`Tous les fournisseurs ont échoué : ${errors.map(e => e.provider).join(', ')}`);
    err.attempts = errors;
    throw err;
  }

  /**
   * CONSULTATION multi-maîtres (trilogue) : interroge plusieurs fournisseurs en
   * parallèle, agrège les réponses et calcule un SCORE DE DÉSACCORD (signal
   * d'active-learning : fort désaccord = exemple à forte valeur pour la
   * distillation). Les échecs individuels n'interrompent pas les autres.
   */
  async consult(messages, opts = {}, providersList = ['xai', 'anthropic', 'deepseek']) {
    const settled = await Promise.allSettled(providersList.map(p => this.complete(p, messages, opts)));
    const responses = [];
    for (let i = 0; i < settled.length; i++) {
      if (settled[i].status === 'fulfilled') responses.push(settled[i].value);
      else responses.push({ provider: providersList[i], error: settled[i].reason?.message ?? 'échec', text: null });
    }
    const ok = responses.filter(r => r.text);
    const disagreement = ExternalGateway.disagreement(ok.map(r => r.text));
    const costUSD = +ok.reduce((s, r) => s + (r.costUSD ?? 0), 0).toFixed(6);
    return { responses, disagreement, agreed: ok.length, costUSD };
  }

  // Désaccord lexical = 1 − moyenne des similarités de Jaccard par paire (sur
  // ensembles de tokens). 0 = consensus parfait ; →1 = forte divergence.
  static disagreement(texts) {
    const sets = texts.map(t => new Set((t ?? '').toLowerCase().match(/\w+/g) ?? []));
    if (sets.length < 2) return 0;
    let sum = 0, pairs = 0;
    for (let i = 0; i < sets.length; i++) for (let j = i + 1; j < sets.length; j++) {
      let inter = 0; for (const w of sets[i]) if (sets[j].has(w)) inter++;
      const uni = sets[i].size + sets[j].size - inter;
      sum += uni > 0 ? inter / uni : 1; pairs++;
    }
    return pairs ? +(1 - sum / pairs).toFixed(4) : 0;
  }

  costReport() {
    return {
      ...this.ledger.report(),
      cache: this._cacheEnabled ? { hits: this.cacheHits, misses: this.cacheMisses, stored: this._cachePayload.size } : { enabled: false },
    };
  }
}

// ═══════════════════════════════════════════════════════════════════
//  SHADOW ROUTER — local-par-défaut + consultation fantôme asynchrone.
//
//  Principe (corrige le défaut du flux naïf) : on NE fait JAMAIS attendre
//  l'utilisateur sur les externes. Le local répond immédiatement ; si la tâche
//  est incertaine/complexe, une consultation des maîtres part EN ARRIÈRE-PLAN
//  (fire-and-forget) et produit une leçon de haute valeur déversée via `ingest`
//  (typiquement vers le replay_buffer → distillToWeights / Dream Cycle).
//
//  ACTIVE LEARNING : la qualité de la leçon n'est pas constante. On privilégie
//  les exemples où (a) le local DIVERGE des maîtres (le student a quelque chose
//  à apprendre) ET (b) les maîtres SONT D'ACCORD (cible fiable) :
//      quality = écart_student × (0.5 + 0.5 × consensus_maîtres)
//  Fort consensus + fort écart local = correction fiable et utile → priorité.
//  Découplé : aucune dépendance au replay_buffer ici (callback `ingest`).
// ═══════════════════════════════════════════════════════════════════
export class ShadowRouter {
  /**
   * @param {object}   o
   * @param {ExternalGateway} o.gateway
   * @param {Function} [o.ingest]      — (lesson)=>void : où déverser la leçon
   *                                     (ex: exp => replayBuffer.push(exp))
   * @param {object}   [o.registry]    — pour choisir le maître primaire (qualité)
   * @param {number}   [o.threshold=0.25] — complexité mini pour déclencher (0..1)
   * @param {string[]} [o.providers]   — maîtres à consulter
   * @param {string}   [o.primaryTeacher] — fournisseur cible (sinon : meilleur du registre)
   * @param {Function} [o.complexityFn]   — (prompt, localResult)=>score 0..1
   *                                     (défaut : 1 − confiance du local)
   */
  constructor({ gateway, ingest = null, registry = null, threshold = 0.25,
                providers = ['xai', 'anthropic', 'deepseek'], primaryTeacher = null,
                complexityFn = null } = {}) {
    this.gateway = gateway;
    this.ingest = ingest;
    this.registry = registry;
    this.threshold = threshold;
    this.providers = providers;
    this.primaryTeacher = primaryTeacher;
    this.complexityFn = complexityFn;
    this.stats = { evaluated: 0, triggered: 0, skipped: 0, lessons: 0, failures: 0, spendUSD: 0 };
  }

  complexity(prompt, localResult) {
    if (this.complexityFn) return this.complexityFn(prompt, localResult);
    return 1 - (localResult?.confidence ?? 1);   // faible confiance ⇒ forte complexité
  }
  shouldShadow(prompt, localResult) {
    return !!this.gateway && this.complexity(prompt, localResult) >= this.threshold;
  }

  // Fire-and-forget : NE BLOQUE PAS l'utilisateur. Lance la shadow en tâche de
  // fond et avale toute erreur (un échec de consultation ne doit JAMAIS impacter
  // la réponse déjà rendue). Renvoie true si déclenchée.
  maybeShadow(prompt, localResult, opts = {}) {
    this.stats.evaluated++;
    if (!this.shouldShadow(prompt, localResult)) { this.stats.skipped++; return false; }
    this.stats.triggered++;
    queueMicrotask(() => {
      this.shadowOnce(prompt, localResult, opts).catch(e => {
        this.stats.failures++; console.debug?.(`[Shadow] échec : ${e.message}`);
      });
    });
    return true;
  }

  // Version awaitable : consultation + construction de leçon + déversement.
  async shadowOnce(prompt, localResult, opts = {}) {
    const messages = [{ role: 'user', content: prompt }];
    const consultation = await this.gateway.consult(messages, { noCache: true, ...opts }, this.providers);
    const answered = consultation.responses.filter(r => r.text);
    if (!answered.length) throw new Error('aucun maître n\'a répondu');

    const teacher = this._pickTeacher(answered);
    const localText = localResult?.text ?? '';
    const studentGap = ExternalGateway.disagreement([localText, teacher.text]);  // 0..1
    const masterConsensus = 1 - consultation.disagreement;                        // 0..1

    // Deux signaux DISTINCTS (le replay_buffer dérive importance = 1 − quality,
    // donc on les sépare pour ne pas inverser la priorité) :
    //   quality    = fiabilité de la CIBLE (consensus des maîtres) → 0.6..1.0
    //   importance = VALEUR D'APPRENTISSAGE (écart local × consensus) → priorité
    //                de rejeu : fort écart + fort consensus = correction utile.
    const quality    = +(0.6 + 0.4 * masterConsensus).toFixed(4);
    const importance = +(studentGap * (0.5 + 0.5 * masterConsensus)).toFixed(4);

    const lesson = {
      query: prompt, response: teacher.text, quality, importance,
      teacher: teacher.provider,
      studentGap, masterConsensus, disagreement: consultation.disagreement,
      localText, masters: answered.map(r => ({ provider: r.provider, text: r.text })),
      costUSD: consultation.costUSD, ts: Date.now(),
    };

    this.stats.lessons++;
    this.stats.spendUSD = +(this.stats.spendUSD + (consultation.costUSD ?? 0)).toFixed(6);
    if (this.ingest) this.ingest(lesson);
    return lesson;
  }

  // Maître cible : explicite, sinon meilleur avgQuality du registre, sinon 1er.
  _pickTeacher(answered) {
    if (this.primaryTeacher) {
      const t = answered.find(r => r.provider === this.primaryTeacher);
      if (t) return t;
    }
    if (this.registry) {
      let best = answered[0], bestQ = -1;
      for (const r of answered) {
        const name = PROVIDER_CONFIG[r.provider]?.registryName;
        const q = name ? (this.registry.getModel(name)?.avgQuality ?? 0) : 0;
        if (q > bestQ) { bestQ = q; best = r; }
      }
      return best;
    }
    return answered[0];
  }
}