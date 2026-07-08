// packages/node/src/server.js
// SkyCloud HTTP Server — Production Grade
// Express + ApiKeyStore (scopes) + JWT fallback + Traffic Logs + Gateway Endpoints
// Branché sur SkyCloud réel (skycloud.js)

"use strict";

import express               from 'express';
import cors                  from 'cors';
import compression           from 'compression';
import morgan                from 'morgan';
import jwt                   from 'jsonwebtoken';
import { WebSocketServer }   from 'ws';
import crypto                from 'crypto';
import { exec }              from 'child_process';
import { existsSync }        from 'fs';

import { SkyCloud as SkyCloud }    from '#skycloud';
import { ALL_SCOPES, SCOPE_LABELS } from '#skycloud';
import { SecureMessagingService }   from '#secure_messaging';
import { EngineSupervisor, EngineKind } from '#engine_supervisor';

// =====================================================
// RATE LIMITER — Sliding Window (anti-burst optimal)
// =====================================================

class RateLimiter {
  #buckets = new Map();
  #max; #window;

  constructor(maxRequests = 60, windowSecs = 60) {
    this.#max    = maxRequests;
    this.#window = windowSecs * 1000;
    setInterval(() => this.#purge(), this.#window * 2).unref();
  }

  check(ip) {
    const now    = Date.now();
    const cutoff = now - this.#window;
    let   ts     = this.#buckets.get(ip);

    if (!ts) { ts = []; this.#buckets.set(ip, ts); }

    let i = 0;
    while (i < ts.length && ts[i] <= cutoff) i++;
    if (i > 0) ts.splice(0, i);

    if (ts.length >= this.#max) return false;
    ts.push(now);
    return true;
  }

  #purge() {
    const cutoff = Date.now() - this.#window;
    for (const [ip, ts] of this.#buckets) {
      if (!ts.length || ts[ts.length - 1] <= cutoff) this.#buckets.delete(ip);
    }
  }
}

// =====================================================
// MÉTRIQUES SERVEUR — EMA + fenêtre glissante req/min
// =====================================================

class ServerMetrics {
  constructor() {
    this.totalRequests       = 0;
    this.successfulRequests  = 0;
    this.failedRequests      = 0;
    this.websocketConnections= 0;
    this.avgResponseMs       = 0;
    this._reqTimestamps      = [];
  }

  record(success, durationMs) {
    this.totalRequests++;
    success ? this.successfulRequests++ : this.failedRequests++;
    this.avgResponseMs = (this.avgResponseMs * 0.9) + (durationMs * 0.1);

    const now    = Date.now();
    const cutoff = now - 60_000;
    this._reqTimestamps.push(now);
    let i = 0;
    while (i < this._reqTimestamps.length && this._reqTimestamps[i] < cutoff) i++;
    if (i > 0) this._reqTimestamps.splice(0, i);
  }

  get requestsPerMinute() { return this._reqTimestamps.length; }

  toJSON() {
    return {
      total_requests       : this.totalRequests,
      successful_requests  : this.successfulRequests,
      failed_requests      : this.failedRequests,
      websocket_connections: this.websocketConnections,
      avg_response_ms      : +this.avgResponseMs.toFixed(2),
      requests_per_minute  : this.requestsPerMinute,
    };
  }
}

// =====================================================
// PAGINATION — max 100 items/page
// =====================================================

class PaginationParams {
  constructor(page = 1, perPage = 20) {
    this.page    = Math.max(1, parseInt(page)    || 1);
    this.perPage = Math.min(100, Math.max(1, parseInt(perPage) || 20));
  }

  paginate(items) {
    const total = items.length;
    const start = (this.page - 1) * this.perPage;
    return {
      items     : items.slice(start, start + this.perPage),
      pagination: {
        page       : this.page,
        per_page   : this.perPage,
        total,
        total_pages: Math.ceil(total / this.perPage) || 1,
      },
    };
  }
}

// =====================================================
// HELPER — ERREUR STANDARD
// =====================================================

function apiError(res, status, error, message) {
  res.status(status).json({ code: status, error, message, request_id: crypto.randomUUID() });
}

// =====================================================
// ÉTAT GLOBAL — SkyCloud réel
// =====================================================

const state = {
  node       : new SkyCloud(),
  secure     : new SecureMessagingService(),   // SkyChat — messagerie sécurisée
  rateLimiter: new RateLimiter(60, 60),
  metrics    : new ServerMetrics(),
  engine     : null,                            // moteur natif embarqué (opt-in)
  apiKeys    : [process.env.SKYNODE_API_KEY    ?? 'dev-key-unsafe'],
  jwtSecret  : process.env.SKYNODE_JWT_SECRET  ?? 'change-me-in-prod',
};

// Démarrage du moteur T369 en arrière-plan (non bloquant)
state.node.initEngine().catch(e =>
  console.warn('[Server] initEngine:', e.message)
);

// Moteur d'inférence natif embarqué (llama.cpp / vLLM / MLX) — OPT-IN via env.
// SKYAINET_ENGINE_MODEL = chemin du modèle ; sans lui, on reste sur le moteur JS.
// SkyCloud expose alors sa PROPRE API HTTP souveraine par-dessus le sous-processus.
if (process.env.SKYAINET_ENGINE_MODEL) {
  state.engine = new EngineSupervisor({
    kind : process.env.SKYAINET_ENGINE_KIND ?? EngineKind.LlamaCpp,
    model: process.env.SKYAINET_ENGINE_MODEL,
    host : process.env.SKYAINET_ENGINE_HOST ?? '127.0.0.1',
    port : Number(process.env.SKYAINET_ENGINE_PORT ?? 8799),
  });
  state.engine.start()
    .then(()  => console.info(`[Server] Moteur embarqué prêt : ${state.engine.endpoint}`))
    .catch(e => console.warn('[Server] Moteur embarqué indisponible :', e.message));
}

// =====================================================
// MIDDLEWARES
// =====================================================

function rateLimitMiddleware(req, res, next) {
  if (req.path === '/health') return next();
  const ip = (req.headers['x-forwarded-for'] ?? '').split(',')[0].trim()
           || req.ip || 'unknown';
  if (!state.rateLimiter.check(ip)) {
    return apiError(res, 429, 'RATE_LIMITED', 'Trop de requêtes, réessaie dans un moment.');
  }
  next();
}

// =====================================================
// SCOPE REQUIRED — helper pour protéger les routes par scope
// =====================================================

/**
 * Retourne un middleware qui vérifie le scope requis.
 * Priorité : clé skn_… (ApiKeyStore) > JWT Bearer > clé dev.
 * @param {string} [scope] — ex: 'inference:read'. Absent = auth seule.
 */
function requireScope(scope = '') {
  return function scopeMiddleware(req, res, next) {
    const path = req.path;
    if (path === '/health' || path === '/api/status') return next();

    const rawKey = req.headers['x-api-key'] ?? '';
    const auth   = req.headers.authorization ?? '';

    // 1. Clé SKY (ApiKeyStore) — prioritaire
    if (rawKey.startsWith('skn_')) {
      const targetAI = req.body?.ai ?? req.query?.ai ?? '';
      const result   = state.node.validateApiKey(rawKey, targetAI, scope);

      if (!result.valid) {
        return apiError(res, 401, 'UNAUTHORIZED', result.reason);
      }

      // Enregistrer l'identité de la clé sur la requête
      req.apiKeyName  = result.entry?.name ?? 'unknown';
      req.apiKeyScope = scope;
      return next();
    }

    // 2. Clé de développement (variable d'env)
    if (state.apiKeys.includes(rawKey)) {
      req.apiKeyName  = 'dev-key';
      req.apiKeyScope = 'admin';
      return next();
    }

    // 3. JWT Bearer — fallback
    if (auth.startsWith('Bearer ')) {
      try {
        req.jwtPayload  = jwt.verify(auth.slice(7), state.jwtSecret, { algorithms: ['HS256'] });
        req.apiKeyName  = req.jwtPayload.sub ?? 'jwt';
        req.apiKeyScope = req.jwtPayload.scope ?? 'admin';

        // Vérifier que le JWT a bien le scope requis
        if (scope && req.apiKeyScope !== 'admin' && req.apiKeyScope !== scope) {
          return apiError(res, 403, 'FORBIDDEN', `Scope '${scope}' requis.`);
        }
        return next();
      } catch (err) {
        const msg = err.name === 'TokenExpiredError' ? 'Token JWT expiré.' : 'Token JWT invalide.';
        return apiError(res, 401, 'UNAUTHORIZED', msg);
      }
    }

    return apiError(res, 401, 'UNAUTHORIZED', 'API key (x-api-key) ou Bearer JWT requis.');
  };
}

// Alias rétrocompatible utilisé dans les routes existantes
const auth = requireScope('admin');

function metricsMiddleware(req, res, next) {
  const start = Date.now();
  res.on('finish', () => state.metrics.record(res.statusCode < 400, Date.now() - start));
  next();
}

// =====================================================
// EXPRESS APP
// =====================================================

const app = express();
app.use(morgan('dev'));
app.use(compression());
app.use(cors({ origin: '*', methods: ['GET','POST','PUT','DELETE'], allowedHeaders: ['*'], maxAge: 3600 }));
app.use(express.json({ limit: '50mb' }));
app.use(rateLimitMiddleware);
// NOTE : authMiddleware retiré du global — chaque route déclare son scope via requireScope()
app.use(metricsMiddleware);

// ─── Traffic Log Middleware ────────────────────────────────────────────────
// Appelle skyCloud.logTraffic() à chaque requête — alimente getTrafficLogs()
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    state.node.logTraffic({
      method    : req.method,
      path      : req.path,
      statusCode: res.statusCode,
      latencyMs : Date.now() - start,
      keyName   : req.apiKeyName ?? 'anonymous',
      ip        : (req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.ip || 'unknown',
    });
  });
  next();
});

// =====================================================
// ROUTES — SANTÉ & MONITORING
// =====================================================

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/metrics', (req, res) => {
  res.json(state.metrics.toJSON());
});

// =====================================================
// ROUTES — NŒUD & STATUS
// =====================================================

app.get('/api/status', (req, res) => {
  res.json(state.node.getStatus());
});

app.get('/api/node', (req, res) => {
  res.json(state.node.getNodeMetrics());
});

app.get('/api/neural-mesh', (req, res) => {
  const n = state.node;
  res.json({
    wisdom_level    : n.wisdomScore,
    evolution_cycles: n.evolutionCycles,
    last_dream_cycle: n.lastDreamCycle,
  });
});

app.get('/api/stats', (req, res) => {
  const n = state.node;
  res.json({
    wisdom_score  : n.wisdomScore,
    total_requests: n.totalRequests,
    active_model  : 'T369Inference + LoraÉvo + Gematria Flash Core',
  });
});

app.get('/api/dream-cycle', async (req, res) => {
  try {
    await state.node.runEvolutionCycle();
    res.json({
      success: true,
      message: `Cycle de rêve terminé. Sagesse: ${state.node.wisdomScore.toFixed(4)}`,
      wisdom : state.node.wisdomScore,
    });
  } catch (e) {
    apiError(res, 500, 'INTERNAL_ERROR', e.message);
  }
});

// =====================================================
// ROUTES — IA
// =====================================================

app.post('/api/ai/generate', requireScope('inference:read'), async (req, res) => {
  try {
    const result = await state.node.generateWithAI(req.body);
    res.json({ success: true, response: result });
  } catch (e) {
    apiError(res, 500, 'INTERNAL_ERROR', e.message);
  }
});

// ── Moteur embarqué — cœur d'inférence souverain ──────────────
app.get('/api/engine/status', (_req, res) => {
  res.json({ success: true, engine: state.engine?.status() ?? { state: 'disabled', ready: false } });
});

app.post('/api/engine/generate', requireScope('inference:read'), async (req, res) => {
  if (!state.engine?.isReady) return apiError(res, 503, 'ENGINE_UNAVAILABLE', 'Moteur embarqué non prêt.');
  try {
    const { prompt, maxTokens, temperature } = req.body ?? {};
    const result = await state.engine.generate(prompt ?? '', { maxTokens, temperature });
    res.json({ success: true, ...result });
  } catch (e) { apiError(res, 500, 'INTERNAL_ERROR', e.message); }
});

app.post('/api/engine/restart', requireScope('inference:read'), async (_req, res) => {
  if (!state.engine) return apiError(res, 503, 'ENGINE_DISABLED', 'Aucun moteur embarqué configuré.');
  try {
    await state.engine.restart();
    res.json({ success: true, engine: state.engine.status() });
  } catch (e) { apiError(res, 500, 'INTERNAL_ERROR', e.message); }
});

app.post('/api/ai/message', async (req, res) => {
  const { from, to, content, apiKey } = req.body;
  if (!from?.trim()) return apiError(res, 400, 'BAD_REQUEST', "Champ 'from' requis.");
  if (!to?.trim())   return apiError(res, 400, 'BAD_REQUEST', "Champ 'to' requis.");
  try {
    const msg = state.node.sendMessage(from, to, content ?? '', apiKey ?? null);
    res.json({ success: true, message: msg });
  } catch (e) {
    apiError(res, 500, 'INTERNAL_ERROR', e.message);
  }
});

app.get('/api/ai/list', (req, res) => {
  const ais = [...state.node.registeredAIs.keys()];
  res.json({ ais, total: ais.length });
});

app.post('/api/ai/external', (req, res) => {
  state.node.enableExternalAI(!!req.body.enabled);
  res.json({ success: true, external_ai_enabled: !!req.body.enabled });
});

app.post('/api/ai/lesson', requireScope('inference:write'), async (req, res) => {
  const { lesson } = req.body;
  if (!lesson?.trim()) return apiError(res, 400, 'BAD_REQUEST', "Champ 'lesson' requis.");
  try {
    const result = await state.node.injectLesson(lesson);
    res.json({ success: true, ...result });
  } catch (e) {
    apiError(res, 500, 'INTERNAL_ERROR', e.message);
  }
});

// =====================================================
// ROUTES — API KEYS (scopes, TTL, rotation, logs)
// =====================================================

// POST /api/keys/create — génère une clé avec scopes + TTL
app.post('/api/keys/create', requireScope('gateway:admin'), (req, res) => {
  const { name, scopes, allowedAIs = [], rateLimit = 60, ttlDays = 0 } = req.body;
  if (!name?.trim()) return apiError(res, 400, 'BAD_REQUEST', "Champ 'name' requis.");
  // Valider les scopes
  const validScopes  = (Array.isArray(scopes) ? scopes : [scopes ?? 'inference:read'])
    .filter(s => ALL_SCOPES.includes(s));
  if (!validScopes.length) return apiError(res, 400, 'BAD_REQUEST', 'Aucun scope valide fourni.');
  try {
    const key = state.node.generateApiKey(name.trim(), { scopes: validScopes, allowedAIs, rateLimit, ttlDays });
    res.status(201).json({
      success: true, key,
      scopes : validScopes,
      ttlDays,
      expiresAt: ttlDays > 0 ? Date.now() + ttlDays * 86_400_000 : null,
    });
  } catch (e) {
    apiError(res, 500, 'INTERNAL_ERROR', e.message);
  }
});

// GET /api/keys/list — liste toutes les clés (sans valeur brute)
app.get('/api/keys/list', requireScope('gateway:admin'), (req, res) => {
  res.json({ success: true, keys: state.node.listApiKeys() });
});

// POST /api/keys/validate — vérifie une clé + scope
app.post('/api/keys/validate', requireScope('gateway:read'), (req, res) => {
  const { key, targetAI = '', scope = '' } = req.body;
  if (!key) return apiError(res, 400, 'BAD_REQUEST', "Champ 'key' requis.");
  const result = state.node.validateApiKey(key, targetAI, scope);
  res.json({ success: true, valid: result.valid, reason: result.reason ?? null });
});

// POST /api/keys/revoke — révoque une clé
app.post('/api/keys/revoke', requireScope('gateway:admin'), (req, res) => {
  const { key } = req.body;
  if (!key) return apiError(res, 400, 'BAD_REQUEST', "Champ 'key' requis.");
  try {
    state.node.revokeApiKey(key);
    res.json({ success: true });
  } catch (e) {
    apiError(res, 404, 'NOT_FOUND', e.message);
  }
});

// POST /api/keys/rotate — révoque l'ancienne clé, retourne la nouvelle
app.post('/api/keys/rotate', requireScope('gateway:admin'), (req, res) => {
  const { key } = req.body;
  if (!key) return apiError(res, 400, 'BAD_REQUEST', "Champ 'key' requis.");
  try {
    const newKey = state.node.rotateApiKey(key);
    res.json({ success: true, newKey });
  } catch (e) {
    apiError(res, 404, 'NOT_FOUND', e.message);
  }
});

// GET /api/keys/scopes — liste tous les scopes disponibles
app.get('/api/keys/scopes', requireScope('gateway:read'), (req, res) => {
  res.json({
    success: true,
    scopes : ALL_SCOPES.map(s => ({ scope: s, label: SCOPE_LABELS[s] })),
  });
});

// =====================================================
// ROUTES — STOCKAGE (avec pagination)
// =====================================================

app.post('/api/storage/upload', requireScope('storage:write'), async (req, res) => {
  const { name, data } = req.body;
  if (!name?.trim())             return apiError(res, 400, 'BAD_REQUEST', "Champ 'name' requis.");
  if (!Array.isArray(data) || !data.length)
                                 return apiError(res, 400, 'BAD_REQUEST', 'Données vides.');
  try {
    const bytes = Buffer.from(data.map(v => Math.max(0, Math.min(255, Number(v) || 0))));
    const id    = await state.node.uploadFile(name.trim(), bytes);
    res.status(201).json({ success: true, file_id: id, name, size_bytes: bytes.length });
  } catch (e) {
    apiError(res, 500, 'INTERNAL_ERROR', e.message);
  }
});

app.get('/api/storage/list', requireScope('storage:read'), async (req, res) => {
  try {
    const files              = await state.node.listFiles();
    const params             = new PaginationParams(req.query.page, req.query.per_page);
    const { items, pagination } = params.paginate(files);
    res.json({ success: true, files: items, pagination });
  } catch (e) {
    apiError(res, 500, 'INTERNAL_ERROR', e.message);
  }
});

app.post('/api/storage/download', requireScope('storage:read'), async (req, res) => {
  const id = req.body.file_id?.trim() || req.body.id?.trim();
  if (!id) return apiError(res, 400, 'BAD_REQUEST', "Champ 'file_id' requis.");
  try {
    const data = await state.node.downloadFile(id);
    res.json({ success: true, file_id: id, data });
  } catch (e) {
    apiError(res, 404, 'NOT_FOUND', e.message);
  }
});

app.post('/api/storage/delete', requireScope('storage:write'), async (req, res) => {
  const id = req.body.file_id?.trim() || req.body.id?.trim();
  if (!id) return apiError(res, 400, 'BAD_REQUEST', "Champ 'file_id' requis.");
  try {
    await state.node.deleteFile(id);
    res.json({ success: true, deleted: id });
  } catch (e) {
    apiError(res, 404, 'NOT_FOUND', e.message);
  }
});

// =====================================================
// ROUTES — RÉSEAU
// =====================================================

app.get('/api/peers', requireScope('peers:read'), (req, res) => {
  res.json({ success: true, peers: state.node.getPeers() });
});

app.post('/api/peers/sync', requireScope('peers:write'), async (req, res) => {
  try {
    const result = await state.node.syncWithNetwork();
    res.json({ success: true, ...result });
  } catch (e) {
    apiError(res, 500, 'INTERNAL_ERROR', e.message);
  }
});

// =====================================================
// ROUTES — GATEWAY (endpoints exposés + logs de trafic)
// =====================================================

// POST /api/gateway/expose — expose un endpoint d'inférence public
app.post('/api/gateway/expose', requireScope('gateway:admin'), (req, res) => {
  const { name, ai = 'thevie', persona, maxTokens = 512, temperature = 0.8, rateLimit = 30, ttlDays = 0 } = req.body;
  if (!name?.trim()) return apiError(res, 400, 'BAD_REQUEST', "Champ 'name' requis.");
  try {
    const result = state.node.exposeInferenceEndpoint(name.trim(), { ai, persona, maxTokens, temperature, rateLimit, ttlDays });
    // Monter dynamiquement l'endpoint Express
    mountInferenceEndpoint(result.endpointName);
    res.status(201).json({ success: true, ...result });
  } catch (e) {
    apiError(res, 500, 'INTERNAL_ERROR', e.message);
  }
});

// GET /api/gateway/endpoints — liste les endpoints exposés
app.get('/api/gateway/endpoints', requireScope('gateway:read'), (req, res) => {
  res.json({ success: true, endpoints: state.node.listExposedEndpoints() });
});

// DELETE /api/gateway/endpoints/:name — supprime un endpoint
app.delete('/api/gateway/endpoints/:name', requireScope('gateway:admin'), (req, res) => {
  try {
    state.node.removeEndpoint(req.params.name);
    res.json({ success: true, removed: req.params.name });
  } catch (e) {
    apiError(res, 404, 'NOT_FOUND', e.message);
  }
});

// GET /api/gateway/logs — logs de trafic (50 derniers par défaut)
app.get('/api/gateway/logs', requireScope('gateway:read'), (req, res) => {
  const limit = Math.min(500, parseInt(req.query.limit) || 50);
  res.json({ success: true, logs: state.node.getTrafficLogs(limit) });
});

// GET /api/gateway/status — statut Gateway complet
app.get('/api/gateway/status', requireScope('gateway:read'), (req, res) => {
  const s = state.node.getStatus();
  res.json({
    success          : true,
    gatewayEnabled   : s.gatewayEnabled,
    gatewayPort      : s.gatewayPort,
    exposedEndpoints : state.node.listExposedEndpoints(),
    externalAIEnabled: s.externalAIEnabled,
    nodeState        : s.state,
  });
});

// ─── Mount inference endpoints dynamiquement ──────────────────────────────
/**
 * Monte l'endpoint /api/inference/:name sur Express.
 * Appelé au démarrage (pour les endpoints déjà enregistrés)
 * et à chaque POST /api/gateway/expose.
 */
function mountInferenceEndpoint(name) {
  const path = `/api/inference/${name}`;
  if (app._router?.stack?.some(l => l.route?.path === path)) return;

  app.post(path, requireScope('inference:read'), async (req, res) => {
    const endpoints = state.node.listExposedEndpoints();
    const ep        = endpoints.find(e => e.name === name);
    if (!ep || !ep.active) return apiError(res, 404, 'NOT_FOUND', `Endpoint '${name}' introuvable ou désactivé.`);

    const { prompt, maxTokens, temperature } = req.body;
    if (!prompt?.trim()) return apiError(res, 400, 'BAD_REQUEST', "Champ 'prompt' requis.");

    try {
      const fullPrompt = ep.persona
        ? `[SYSTEM] ${ep.persona}\n\n[USER] ${prompt}\n\n[ASSISTANT]`
        : prompt;

      const result = await state.node.generateWithAI({
        prompt     : fullPrompt,
        ai         : ep.ai,
        maxTokens  : maxTokens  ?? ep.maxTokens,
        temperature: temperature ?? ep.temperature,
      });

      ep.requestCount++;
      res.json({
        success  : true,
        endpoint : name,
        ai       : ep.ai,
        response : result.text,
        tokens   : result.tokensGenerated,
        wisdom   : result.wisdomScore,
      });
    } catch (e) {
      apiError(res, 500, 'INFERENCE_ERROR', e.message);
    }
  });

  console.info(`[Gateway] Route montée : POST ${path}`);
}

// =====================================================
// ROUTES — WEB HOSTING
//
// REST API complète pour la gestion des sites hébergés.
// Toutes les opérations transitent par SkyCloud.#sites
// et DecentralizedStorage (chiffrement RomanT369 auto).
//
// Avantages exposés dans les réponses :
//   • chiffrement RomanT369 Hyper256 automatique
//   • signature Dilithium5 à chaque publication
//   • versioning natif (20 versions max par site)
//   • réplication décentralisée ZipMemory
//   • monitoring hits + bande passante en temps réel
// =====================================================

// POST /api/hosting/sites — créer un nouveau site
app.post('/api/hosting/sites', requireScope('storage:write'), (req, res) => {
  const { name, domain } = req.body;
  if (!name?.trim() || !domain?.trim())
    return apiError(res, 400, 'BAD_REQUEST', "Champs 'name' et 'domain' requis.");
  try {
    const site = state.node.hosting.createSite(name, domain);
    res.status(201).json({
      success : true,
      site    : site.toJSON(),
      message : `Site créé — URL publique : https://${site.domain}`,
      benefits: [
        'Chiffrement automatique RomanT369 Hyper256',
        'Signature Dilithium5 à chaque publication',
        'Versioning natif — jusqu\'à 20 versions',
        'Réplication décentralisée sur 3 nœuds',
        'Monitoring hits + bande passante en temps réel',
        'Zéro censure — données souveraines',
      ],
    });
  } catch (e) {
    apiError(res, 409, 'CONFLICT', e.message);
  }
});

// GET /api/hosting/sites — liste tous les sites
app.get('/api/hosting/sites', requireScope('storage:read'), (req, res) => {
  res.json({ success: true, sites: state.node.hosting.listSites() });
});

// GET /api/hosting/sites/:siteId — détails d'un site
app.get('/api/hosting/sites/:siteId', requireScope('storage:read'), (req, res) => {
  const site = state.node.hosting.getSite(req.params.siteId);
  if (!site) return apiError(res, 404, 'NOT_FOUND', 'Site introuvable.');
  res.json({ success: true, site });
});

// POST /api/hosting/sites/:siteId/files — uploader un fichier
app.post('/api/hosting/sites/:siteId/files', requireScope('storage:write'), async (req, res) => {
  const { path, data, encoding = 'utf8' } = req.body;
  if (!path?.trim()) return apiError(res, 400, 'BAD_REQUEST', "Champ 'path' requis.");
  if (!data)         return apiError(res, 400, 'BAD_REQUEST', "Champ 'data' requis.");
  try {
    let raw;
    if (Array.isArray(data)) {
      raw = Buffer.from(data.map(v => Math.max(0, Math.min(255, Number(v) || 0))));
    } else if (encoding === 'base64') {
      raw = Buffer.from(data, 'base64');
    } else {
      raw = Buffer.from(String(data), 'utf8');
    }
    const fileId = await state.node.hosting.uploadSiteFile(req.params.siteId, path, raw);
    res.status(201).json({ success: true, fileId, path, sizeBytes: raw.length });
  } catch (e) {
    apiError(res, 500, 'UPLOAD_ERROR', e.message);
  }
});

// POST /api/hosting/sites/:siteId/publish — publier un site
app.post('/api/hosting/sites/:siteId/publish', requireScope('storage:write'), async (req, res) => {
  try {
    const result = await state.node.hosting.publishSite(req.params.siteId);
    res.json({ success: true, ...result });
  } catch (e) {
    apiError(res, 400, 'PUBLISH_ERROR', e.message);
  }
});

// POST /api/hosting/sites/:siteId/rollback — rollback à une version
app.post('/api/hosting/sites/:siteId/rollback', requireScope('storage:write'), async (req, res) => {
  const { version } = req.body;
  try {
    const result = await state.node.hosting.rollbackSite(req.params.siteId, version ?? null);
    res.json({ success: true, ...result });
  } catch (e) {
    apiError(res, 400, 'ROLLBACK_ERROR', e.message);
  }
});

// PUT /api/hosting/sites/:siteId/domain — configurer un domaine custom
app.put('/api/hosting/sites/:siteId/domain', requireScope('storage:write'), (req, res) => {
  const { customDomain } = req.body;
  if (!customDomain?.trim())
    return apiError(res, 400, 'BAD_REQUEST', "Champ 'customDomain' requis.");
  try {
    state.node.hosting.setCustomDomain(req.params.siteId, customDomain.trim());
    res.json({ success: true, customDomain: customDomain.trim(),
               message: `Domaine custom configuré — pointez votre DNS vers ce nœud.` });
  } catch (e) {
    apiError(res, 409, 'CONFLICT', e.message);
  }
});

// DELETE /api/hosting/sites/:siteId — supprimer un site
app.delete('/api/hosting/sites/:siteId', requireScope('storage:write'), async (req, res) => {
  try {
    await state.node.hosting.deleteSite(req.params.siteId);
    res.json({ success: true, message: 'Site supprimé avec tous ses fichiers.' });
  } catch (e) {
    apiError(res, 404, 'NOT_FOUND', e.message);
  }
});

// =====================================================
// SERVING — Sites web hébergés
//
// Routes publiques — pas d'authentification requise.
// Elles doivent être déclarées APRÈS les routes /api/*
// pour éviter les conflits.
//
// Pattern :
//   GET /sites/:domain       → index.html
//   GET /sites/:domain/*     → fichier demandé (fallback SPA → index.html)
//   GET /:domain/*           → (optionnel) domaine custom à la racine
// =====================================================
// Middleware de serving — commun aux deux routes /sites/*
async function serveSiteMiddleware(req, res) {
  const { domain } = req.params;
  // req.params[0] = le reste du chemin (ex: '/css/style.css')
  const filePath = '/' + (req.params[0] ?? '');
  const start    = Date.now();

  try {
    const result = await state.node.hosting.getSiteFile(domain, filePath);

    if (!result) {
      return res.status(404).send(`
        <html><body style="font-family:monospace;padding:2rem;background:#0a0a0f;color:#fff">
          <h2>404 — Site introuvable</h2>
          <p>Le site <strong>${domain}</strong> n'est pas hébergé sur ce nœud SkyCloud.</p>
          <p style="color:#00f3ff">Powered by SkyAInet × RomanT369 Hyper256</p>
        </body></html>`);
    }

    // Enregistrer le hit de monitoring
    state.node.hosting.recordSiteHit(req.params.siteId ?? domain, result.sizeBytes);

    // Log de trafic
    state.node.logTraffic({
      method    : 'GET',
      path      : `/sites/${domain}${filePath}`,
      statusCode: 200,
      latencyMs : Date.now() - start,
      keyName   : 'public',
      ip        : (req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.ip || 'unknown',
    });

    res.setHeader('Content-Type', result.contentType);
    res.setHeader('X-SkyCloud-Domain', domain);
    res.setHeader('X-SkyCloud-Encrypted', 'RomanT369-Hyper256');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(Buffer.from(result.data));

  } catch (e) {
    console.error(`[Hosting] Erreur serving ${domain}${filePath} :`, e.message);
    res.status(500).send('Internal error');
  }
}

// GET /sites/:domain        → index.html
app.get('/sites/:domain', serveSiteMiddleware);
// GET /sites/:domain/*      → fichier demandé
app.get('/sites/:domain/*', serveSiteMiddleware);

app.post('/api/evolution/train', async (req, res) => {
  try {
    await state.node.triggerTraditionalTraining();
    res.json({ success: true, message: 'Entraînement déclenché.' });
  } catch (e) {
    apiError(res, 500, 'INTERNAL_ERROR', e.message);
  }
});

// =====================================================
// WEBSOCKET — TEMPS RÉEL
// =====================================================

function handleWs(ws) {
  state.metrics.websocketConnections++;
  console.info('🔌 WebSocket connecté');

  ws.send(JSON.stringify({
    type     : 'connected',
    message  : 'SkyCloud WebSocket connecté',
    timestamp: new Date().toISOString(),
  }));

  ws.on('message', async (raw) => {
    let cmd;
    try { cmd = JSON.parse(raw.toString()); }
    catch { return ws.send(JSON.stringify({ type: 'error', message: 'JSON invalide' })); }

    let response;
    switch (cmd.type) {

      case 'status': {
        const s = state.node.getStatus();
        response = {
          type       : 'status_response',
          node_id    : s.id,
          wisdom_score: s.wisdomScore,
          is_running : s.isRunning,
          engine_ready: s.engineReady,
          tier       : 'SkyCloud',
        };
        break;
      }

      case 'ping':
        response = { type: 'pong', ts: new Date().toISOString() };
        break;

      case 'dream':
        try {
          await state.node.runEvolutionCycle();
          response = {
            type   : 'dream_response',
            message: `Cycle terminé. Sagesse: ${state.node.wisdomScore.toFixed(4)}`,
            wisdom : state.node.wisdomScore,
          };
        } catch (e) {
          response = { type: 'error', message: e.message };
        }
        break;

      case 'generate':
        if (!cmd.prompt) {
          response = { type: 'error', message: "Champ 'prompt' requis." };
        } else {
          try {
            const r = await state.node.generateWithAI({
              prompt        : cmd.prompt,
              ai            : cmd.ai ?? 't369',
              maxTokens     : cmd.maxTokens ?? 256,
              useSpeculative: false,
            });
            response = { type: 'generate_response', result: r };
          } catch (e) {
            response = { type: 'error', message: e.message };
          }
        }
        break;

      case 'lesson':
        if (!cmd.lesson) {
          response = { type: 'error', message: "Champ 'lesson' requis." };
        } else {
          try {
            const r = await state.node.injectLesson(cmd.lesson);
            response = { type: 'lesson_response', ...r };
          } catch (e) {
            response = { type: 'error', message: e.message };
          }
        }
        break;

      case 'metrics':
        response = { type: 'metrics_response', metrics: state.metrics.toJSON() };
        break;

      case 'gateway_status':
        response = {
          type             : 'gateway_status_response',
          gatewayEnabled   : state.node.getStatus().gatewayEnabled,
          exposedEndpoints : state.node.listExposedEndpoints(),
          trafficLogs      : state.node.getTrafficLogs(20),
        };
        break;

      case 'keys_list':
        response = {
          type: 'keys_list_response',
          keys: state.node.listApiKeys(),
        };
        break;

      case 'hosting_list':
        response = { type: 'hosting_list_response', sites: state.node.hosting.listSites() };
        break;

      case 'hosting_create':
        if (!cmd.name || !cmd.domain) {
          response = { type: 'error', message: "Champs 'name' et 'domain' requis." };
        } else {
          try {
            const site = state.node.hosting.createSite(cmd.name, cmd.domain);
            response = { type: 'hosting_create_response', site: site.toJSON() };
          } catch (e) {
            response = { type: 'error', message: e.message };
          }
        }
        break;

      case 'hosting_publish':
        if (!cmd.siteId) {
          response = { type: 'error', message: "Champ 'siteId' requis." };
        } else {
          try {
            const result = await state.node.hosting.publishSite(cmd.siteId);
            response = { type: 'hosting_publish_response', ...result };
          } catch (e) {
            response = { type: 'error', message: e.message };
          }
        }
        break;

      case 'hosting_stats':
        response = {
          type  : 'hosting_stats_response',
          sites : state.node.hosting.listSites(),
          total : state.node.hosting.listSites().length,
        };
        break;

      case 'rotate_key':
        if (!cmd.key) {
          response = { type: 'error', message: "Champ 'key' requis." };
        } else {
          try {
            const newKey = state.node.rotateApiKey(cmd.key);
            response = { type: 'rotate_key_response', newKey };
          } catch (e) {
            response = { type: 'error', message: e.message };
          }
        }
        break;

      // ── SkyChat — relais temps réel des messages ──────────────
      // Diffuse un message (DM ou groupe) à tous les clients connectés
      // pour une livraison instantanée multi-onglets / multi-appareils.
      case 'sc_relay': {
        if (cmd.payload) {
          broadcastWs('sc_message', cmd.payload);
        }
        response = { type: 'sc_relay_ack', ts: Date.now() };
        break;
      }

      default:
        response = { type: 'error', message: `Commande inconnue: ${cmd.type}` };
    }

    ws.send(JSON.stringify(response));
  });

  ws.on('close', () => {
    state.metrics.websocketConnections = Math.max(0, state.metrics.websocketConnections - 1);
    console.info('🔌 WebSocket déconnecté');
  });

  ws.on('error', err => console.error('[WS]', err.message));
}

// =====================================================
// ROUTES THEVIE — Node Dashboard, Rewards, Rating
// =====================================================

// GET /api/node/dashboard — tableau de bord complet du nœud
app.get('/api/node/dashboard', auth, async (req, res) => {
  try {
const metrics = state.node.getNodeMetrics();
    const status  = state.node.getStatus();
    const rewards = state.node.getRewardsStats();
    res.json({
      nodeId         : metrics.node_id,
      state          : metrics.state,
      engineReady    : metrics.engine_ready,
      wisdomScore    : metrics.wisdom_score,
      totalRequests  : metrics.total_requests,
      evolutionCycles: metrics.evolution_cycles,
      peersConnected : metrics.peers_connected,
      registeredAIs  : metrics.registered_ais,
      uptime         : metrics.uptime_formatted,
      apiKeysCount   : metrics.api_keys_count,
      totalSkyEarned : rewards.totalEarned,
    });
  } catch (e) {
    apiError(res, 500, 'DASHBOARD_ERROR', e.message);
  }
});

// GET /api/node/full-status — rapport d'état complet
app.get('/api/node/full-status', auth, async (req, res) => {
  try {
    res.json({
      status       : state.node.getStatus(),
      metrics      : state.node.getNodeMetrics(),
      rewards      : state.node.getRewardsStats(),
      peers        : state.node.getPeers(),
      timestamp    : Date.now(),
    });
  } catch (e) {
    apiError(res, 500, 'STATUS_ERROR', e.message);
  }
});

// POST /api/node/create — crée un nœud utilisateur
app.post('/api/node/create', auth, async (req, res) => {
  try {
    const { desiredType = 'Mini', simulatePayment = false } = req.body ?? {};
    const validTypes = ['Mini', 'Light', 'Full', 'Validator'];
    if (!validTypes.includes(desiredType)) {
      return apiError(res, 400, 'INVALID_TYPE', `Type invalide : ${desiredType}`);
    }
    const paidTypes = ['Light', 'Full', 'Validator'];
    const isPaid    = paidTypes.includes(desiredType);
    if (isPaid && !simulatePayment) {
      return apiError(res, 402, 'PAYMENT_REQUIRED', `${desiredType} nécessite un abonnement payant`);
    }
    const prices  = { Mini: 0, Light: 6, Full: 18, Validator: 55 };
    const storage = { Mini: 5, Light: 50, Full: 200, Validator: 512 };
    res.status(201).json({
      success         : true,
      nodeType        : desiredType,
      storageLimitGb  : storage[desiredType],
      monthlyPriceEur : prices[desiredType],
      message         : `✅ Nœud ${desiredType} créé`,
    });
  } catch (e) {
    apiError(res, 500, 'CREATE_NODE_ERROR', e.message);
  }
});

// POST /api/rewards/claim — réclame les récompenses quotidiennes
app.post('/api/rewards/claim', auth, async (req, res) => {
  try {
    const result  = state.node.claimRewards();
    const stats   = state.node.getRewardsStats();
    res.json({
      claimed    : result.claimed    ?? 0,
      totalEarned: stats.totalEarned ?? 0,
      message    : `✅ ${result.claimed ?? 0} SKY réclamés`,
    });
  } catch (e) {
    apiError(res, 500, 'CLAIM_ERROR', e.message);
  }
});

// POST /api/ai/rate — note la dernière réponse IA
app.post('/api/ai/rate', auth, async (req, res) => {
  try {
    const { rating } = req.body ?? {};
    const r = parseFloat(rating);
    if (isNaN(r) || r < 0 || r > 1) {
      return apiError(res, 400, 'INVALID_RATING', 'rating doit être un float [0, 1]');
    }
    // Applique le rating via la sagesse du nœud
    if (r >= 0.8) {
      state.node.wisdomScore; // lecture — l'action réelle est dans Thevie
    }
    res.json({ success: true, rating: r, message: `Rating ${r.toFixed(2)} enregistré` });
  } catch (e) {
    apiError(res, 500, 'RATE_ERROR', e.message);
  }
});

// =====================================================
// DÉMARRAGE
// =====================================================

// ─── Route générique apiHandlers ──────────────────────────────
// Expose toutes les commandes de skycloud.js via POST /api/cmd/:name
// Complète les routes spécifiques ci-dessus.
// Les routes spécifiques ont la priorité (Express les matche en premier).
{
  const handlers = { ...state.node.apiHandlers(), ...state.secure.apiHandlers() };

  // Mapping commandes → méthode HTTP pour GET sémantique
  const GET_CMDS = new Set([
'get_status', 'get_node_metrics', 'get_rewards_stats',
    'get_wallet_balance', 'get_user_profile', 'get_profile_nav_badge',
    'get_current_language', 'list_available_models',
    'get_active_subscriptions', 'get_subscription_plans',
    'list_sites', 'list_files', 'list_api_keys',
    'list_exposed_endpoints', 'get_traffic_logs',
    'list_smart_contracts', 'get_smart_contract_stats',
    'get_comm_stats', 'get_thevie_stats', 'list_thevie_sessions',
    'is_auto_training_enabled', 'is_auto_dream_enabled',
    'get_wisdom',
    // SkyChat — lectures
    'sc_get_identity', 'sc_did_history', 'sc_list_contacts', 'sc_contact_stats',
    'sc_get_conversation', 'sc_conversations', 'sc_list_groups', 'sc_get_group_messages',
    'sc_security_status', 'sc_storage_stats', 'sc_list_devices', 'sc_red_team_report',
  ]);

  // Commandes publiques du frontend Thevie (thevie.html) — lecture/chat
  // accessibles sans clé API pour que l'interface fonctionne en local.
  // Toutes les autres commandes /api/cmd/* restent protégées par `auth`.
  const PUBLIC_CMDS = new Set([
    'generate_with_ai', 'get_wisdom', 'inject_lesson', 'web_search',
  ]);

  // Middleware : laisse passer les commandes publiques + toutes les commandes
  // SkyChat (préfixe sc_), exige l'auth sinon.
  const cmdAuth = (req, res, next) =>
    (PUBLIC_CMDS.has(req.params.name) || req.params.name.startsWith('sc_'))
      ? next() : auth(req, res, next);

  // ─── Routes REST dédiées manquantes ─── parité avec la map d'API de skycloud.html.
  // Chacune dispatche vers le handler /api/cmd/ correspondant ; réponse { ok, result }
  // (skyCall en extrait .result). Auth alignée sur les commandes /api/cmd/ (clé API admin).
  const cmdRoute = async (res, name, ...args) => {
    const fn = handlers[name];
    if (!fn) return apiError(res, 404, 'UNKNOWN_CMD', `Unknown command: ${name}`);
    try {
      const result = await fn(...args);
      res.json({ ok: true, result: result ?? null });
    } catch (e) { apiError(res, 500, 'CMD_ERROR', e.message); }
  };

  // Smart Contracts (page Skycloud — modal Learn)
  app.post  ('/api/smart-contracts/generate', auth, (req, res) => cmdRoute(res, 'generateSmartContract', req.body?.description, req.body?.options ?? {}));
  app.post  ('/api/smart-contracts/deploy',   auth, (req, res) => cmdRoute(res, 'deploySmartContract',   req.body?.contractId));
  app.get   ('/api/smart-contracts',          auth, (req, res) => cmdRoute(res, 'listSmartContracts'));
  app.get   ('/api/smart-contracts/:id',      auth, (req, res) => cmdRoute(res, 'getSmartContract',      req.params.id));
  app.delete('/api/smart-contracts/:id',      auth, (req, res) => cmdRoute(res, 'deleteSmartContract',   req.params.id));

  // Évolution — entraînement LoRA automatique (page Skycloud)
  app.post  ('/api/evolution/auto-train/enable',  auth, (req, res) => cmdRoute(res, 'enableAutoTraining', req.body ?? {}));
  app.post  ('/api/evolution/auto-train/disable', auth, (req, res) => cmdRoute(res, 'disableAutoTraining'));

  // Stockage — réplication décentralisée
  app.post  ('/api/storage/replicate', auth, (req, res) => cmdRoute(res, 'replicateFiles'));

  // Cycle d'évolution (run_evolution_cycle) — POST ; le GET /api/dream-cycle existe déjà.
  app.post  ('/api/dream-cycle', auth, (req, res) => cmdRoute(res, 'runEvolutionCycle'));

  // Gateway — le frontend pilote enable/disable via un port : >0 active, 0 désactive.
  app.post  ('/api/gateway/enable', auth, async (req, res) => {
    try {
      const port   = Number(req.body?.port);
      const result = port > 0 ? await handlers.enableGateway(port) : await handlers.disableGateway();
      res.json({ ok: true, result: result ?? null });
    } catch (e) { apiError(res, 500, 'CMD_ERROR', e.message); }
  });
  app.post  ('/api/gateway/disable', auth, (req, res) => cmdRoute(res, 'disableGateway'));

  app.all('/api/cmd/:name', cmdAuth, async (req, res) => {
    const name = req.params.name;
    let   fn   = handlers[name];
    if (!fn) {                                          // dispatch tolérant : snake_case → camelCase
      const camel = name.replace(/_([a-z])/g, function (_m, c) { return c.toUpperCase(); });
      fn = handlers[camel];
    }

    if (!fn) {
      return apiError(res, 404, 'UNKNOWN_CMD', `Unknown command: ${name}`);
    }

    // Arguments : query params pour GET, body pour POST/PUT
    const args = GET_CMDS.has(name)
      ? Object.values(req.query)
      : Object.values(req.body ?? {});

    try {
      const result = await fn(...args);
      res.json({ ok: true, result: result ?? null });
    } catch (e) {
      apiError(res, 500, 'CMD_ERROR', e.message);
    }
  });

  console.info(`[Server] apiHandlers exposés — ${Object.keys(handlers).length} commandes sur /api/cmd/:name`);
}

// ── Routes PWA — assets en mémoire ou depuis le disque ────────
// En mode binaire Bun compilé : readFileSync depuis le bundle
// En mode dev : sendFile depuis le disque
import { join as _join, dirname as _dirname } from 'path';
import { fileURLToPath as _ftu } from 'url';
import { readFileSync as _rfs, existsSync as _ex } from 'fs';

const _projectRoot = _dirname(_dirname(_dirname(_ftu(import.meta.url))));
const _root        = _join(_projectRoot, 'public-ui');  // assets PWA dans public-ui/

// Charger les assets — depuis le bundle (binaire) ou le disque (dev)
function _asset(relPath, encoding = 'utf8') {
    const full = _join(_root, relPath);
    if (_ex(full)) return _rfs(full, encoding);
    // En mode binaire, les assets sont embarqués — chemin relatif direct
    try { return _rfs(relPath, encoding); } catch { return null; }
}

const _sw       = _asset('sw.js');
const _manifest = _asset('manifest.json');
const _offline  = _asset('offline.html');

// Servir les assets PWA (en mémoire si disponible, sinon disque)
app.get('/sw.js', (req, res) => {
    res.setHeader('Content-Type', 'application/javascript');
    res.setHeader('Service-Worker-Allowed', '/');
    res.setHeader('Cache-Control', 'no-cache');
    if (_sw) return res.send(_sw);
    res.sendFile(_join(_root, 'sw.js'));
});

app.get('/manifest.json', (req, res) => {
    res.setHeader('Content-Type', 'application/manifest+json');
    res.setHeader('Cache-Control', 'no-cache');
    if (_manifest) return res.send(_manifest);
    res.sendFile(_join(_root, 'manifest.json'));
});

app.get('/offline.html', (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    if (_offline) return res.send(_offline);
    res.sendFile(_join(_root, 'offline.html'));
});

// Icônes et autres assets statiques
app.use('/icons', express.static(_join(_root, 'icons')));

// Pages HTML — servis depuis la racine (dev) ou le bundle (binaire)
const _HTML_PAGES = ['skyainet.html', 'skycloud.html', 'thevie.html',
                     'messaging.html', 'node.html', 'marketplace.html',
                     'governance.html', 'settings.html'];

for (const page of _HTML_PAGES) {
    app.get(`/${page}`, (req, res) => {
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Service-Worker-Allowed', '/');
        const content = _asset(page);
        if (content) return res.type('html').send(content);
        res.sendFile(_join(_root, page));
    });
}

// Fallback → skyainet.html pour toutes les routes inconnues
app.get('/', (req, res) => res.redirect('/skyainet.html'));

// Assets statiques restants (JS, CSS, fonts)
app.use(express.static(_root, {
    index   : false,
    dotfiles: 'ignore',
    setHeaders(res, filePath) {
        if (filePath.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-cache');
        } else {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
        res.setHeader('Service-Worker-Allowed', '/');
    },
}));

// ── Génération des icônes PWA ─────────────────────────────────
// Génère tous les PNG depuis icon-source.svg au premier démarrage.
// Aucun PNG à committer sur Github — juste le SVG source.
// Si le design change → supprimer les PNG → ils se régénèrent.

const _ICON_SIZES = [
    { size: 72,  name: 'icon-72.png'   },
    { size: 96,  name: 'icon-96.png'   },
    { size: 128, name: 'icon-128.png'  },
    { size: 192, name: 'icon-192.png'  },
    { size: 512, name: 'icon-512.png'  },
    { size: 32,  name: 'icon-tray.png' },
    { size: 72,  name: 'badge-72.png'  },
];

async function generateIcons() {
    const svgPath  = _join(_root, 'icons', 'icon-source.svg');
    const iconsDir = _join(_root, 'icons');

    if (!_ex(svgPath)) {
        console.warn('[Icons] icon-source.svg introuvable — icônes PWA non générées');
        return;
    }

    // Vérifier si sharp est disponible
    let sharp;
    try {
        const mod = await import('sharp');
        sharp = mod.default;
    } catch {
        console.warn('[Icons] sharp non installé — exécuter : npm install sharp');
        console.warn('[Icons] Les icônes PWA ne seront pas générées automatiquement.');
        return;
    }

    const { mkdirSync, writeFileSync } = await import('fs');
    mkdirSync(iconsDir, { recursive: true });

    const svg       = _rfs(svgPath);
    let   generated = 0;
    let   skipped   = 0;

    for (const { size, name } of _ICON_SIZES) {
        const outPath = _join(iconsDir, name);
        // Ne pas écraser un fichier existant (permet de mettre une icône custom)
        if (_ex(outPath)) { skipped++; continue; }

        try {
            await sharp(svg)
                .resize(size, size, { fit: 'contain', background: { r: 10, g: 10, b: 15, alpha: 1 } })
                .png({ compressionLevel: 9, adaptiveFiltering: true })
                .toFile(outPath);
            generated++;
        } catch (e) {
            console.warn(`[Icons] Erreur génération ${name} : ${e.message}`);
        }
    }

    // Générer icon.ico (Windows) depuis icon-32.png si sharp le supporte
    const ico32 = _join(iconsDir, 'icon-tray.png');
    const icoOut = _join(iconsDir, 'icon.ico');
    if (_ex(ico32) && !_ex(icoOut)) {
        try {
            // ICO = PNG embarqué dans enveloppe ICO minimale
            const pngBuf = _rfs(ico32);
            const { writeFileSync: _wfs } = await import('fs');
            // Header ICO : reserved(2) + type=1(2) + count=1(2) + dir_entry(16) + png_data
            const header = Buffer.alloc(6);
            header.writeUInt16LE(0, 0);   // reserved
            header.writeUInt16LE(1, 2);   // type ICO
            header.writeUInt16LE(1, 4);   // 1 image
            const dir = Buffer.alloc(16);
            dir.writeUInt8(32, 0);        // width
            dir.writeUInt8(32, 1);        // height
            dir.writeUInt8(0,  2);        // color count
            dir.writeUInt8(0,  3);        // reserved
            dir.writeUInt16LE(1, 4);      // planes
            dir.writeUInt16LE(32, 6);     // bit count
            dir.writeUInt32LE(pngBuf.length, 8);  // size
            dir.writeUInt32LE(22, 12);    // offset (6 + 16)
            _wfs(icoOut, Buffer.concat([header, dir, pngBuf]));
            generated++;
        } catch { /* ok — ico optionnel */ }
    }

    if (generated > 0) console.info(`[Icons] ${generated} icône(s) PWA générée(s) dans public-ui/icons/`);
    if (skipped   > 0) console.info(`[Icons] ${skipped} icône(s) déjà présente(s) — conservées`);
}

const PORT   = parseInt(process.env.PORT ?? '8080');
const server = app.listen(PORT, '0.0.0.0', () => {
  const url = `http://localhost:${PORT}/skyainet.html`;
  console.info(`\n✅ SkyAInet Node démarré`);
  console.info(`   PWA  → ${url}`);
  console.info(`   API  → http://localhost:${PORT}/api/status`);
  console.info(`   WS   → ws://localhost:${PORT}/ws`);
  if (state.jwtSecret === 'change-me-in-prod') {
    console.warn('   ⚠️  JWT secret par défaut — définir SKYNODE_JWT_SECRET en production');
  }
  for (const ep of state.node.listExposedEndpoints()) {
    mountInferenceEndpoint(ep.name);
  }

  // Générer les icônes PWA depuis icon-source.svg (si non encore générées)
  generateIcons().catch(e => console.warn('[Icons]', e.message));

  // Auto-ouvrir le browser (désactiver avec SKYAINET_NO_BROWSER=1)
  if (process.env.SKYAINET_NO_BROWSER !== '1') {
    const _exec = exec;
    const cmd = process.platform === 'win32'  ? `start "" "${url}"`
              : process.platform === 'darwin' ? `open "${url}"`
              :                                  `xdg-open "${url}"`;
    _exec(cmd, err => {
      if (err) console.info(`   Ouvrir manuellement : ${url}`);
    });
  }
});

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', ws => handleWs(ws));

// ── Relay des events marketplace → tous les clients WebSocket ──
// GpuCpuMarketplaceService est un EventEmitter —
// on connecte ses events pour les broadcaster en temps réel.
function broadcastWs(event, data) {
  const msg = JSON.stringify({ event, ...data, ts: Date.now() });
  wss.clients.forEach(ws => {
    if (ws.readyState === 1) {
      try { ws.send(msg); } catch { /* client déconnecté */ }
    }
  });
}

// Brancher les events du gpuMarket
const _gpuMarket = state.node.gpuMarket;
if (_gpuMarket) {
  _gpuMarket.on('offer:published',   d => broadcastWs('gpu:offer_published',  d));
  _gpuMarket.on('offer:withdrawn',   d => broadcastWs('gpu:offer_withdrawn',  d));
  _gpuMarket.on('rental:created',    d => broadcastWs('gpu:rental_created',   d));
  _gpuMarket.on('rental:completed',  d => broadcastWs('gpu:rental_completed', d));
  _gpuMarket.on('rental:cancelled',  d => broadcastWs('gpu:rental_cancelled', d));
  _gpuMarket.on('rentals:expired',   n => broadcastWs('gpu:rentals_expired',  { count: n }));
  console.info('[Server] GPU Marketplace events → WebSocket connectés');
}

// Routes ticker temps réel
app.get('/api/marketplace/ticker', async (req, res) => {
  try {
    const gpuTicker  = _gpuMarket?.getTickerData?.()     ?? {};
    const nodeTicker = state.node.marketplace?.getNodeTickerData?.() ?? {};
    res.json({ ok: true, result: { gpu: gpuTicker, nodes: nodeTicker } });
  } catch (e) {
    apiError(res, 500, 'TICKER_ERROR', e.message);
  }
});

// ── Thevie — déploiement orchestré via Server-Sent Events ──────
// Le client (node.html) se connecte à cette route et reçoit
// les étapes de déploiement en temps réel.
app.get('/api/node/deploy-thevie', async (req, res) => {
  const { type, alias, port, role } = req.query;

  res.setHeader('Content-Type',                'text/event-stream');
  res.setHeader('Cache-Control',               'no-cache');
  res.setHeader('Connection',                  'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  const send = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const result = await state.node.nodeManager.deployWithThevie({
      type,
      alias : alias || undefined,
      port  : port  ? parseInt(port) : undefined,
      role  : role  || undefined,
      onStep: (step) => send({ event: 'step', ...step }),
    });
    send({ event: 'done', report: result.report, node: result.node.toJSON() });
  } catch (err) {
    send({ event: 'error', message: err.message, code: err.code ?? 'DEPLOY_ERROR' });
  } finally {
    res.end();
  }
});

// ── Thevie — surveillance périodique (Gateway + Keys) ──────────
if (state.node) {
  // Monitoring Gateway toutes les 30 secondes
  setInterval(() => {
    try {
      const result = state.node.thevieMonitorGateway?.();
      if (result?.actions?.length > 0) {
        broadcastWs('thevie:gateway_action', { actions: result.actions, anomalies: result.anomalies });
        console.info('[Thevie] Gateway:', result.actions.join(' | '));
      }
    } catch { /* silencieux */ }
  }, 30_000).unref();

  // Monitoring Keys toutes les 5 minutes
  setInterval(() => {
    try {
      const result = state.node.thevieMonitorKeys?.();
      if (result?.renewed?.length > 0 || result?.revoked?.length > 0) {
        broadcastWs('thevie:keys_action', result);
        console.info(`[Thevie] Keys — renewed: ${result.renewed.length} · revoked: ${result.revoked.length}`);
      }
    } catch { /* silencieux */ }
  }, 300_000).unref();

  // Thevie Genesis au démarrage
  try {
    state.node.thevieValidatorGenesis?.();
  } catch { /* silencieux si pas encore disponible */ }
}

// Route catalogue GPU pour marketplace.html
app.get('/api/gpu/catalog', (req, res) => {
  const catalog = _gpuMarket?.getGpuCatalog?.() ?? [];
  res.json({ ok: true, result: catalog });
});

// Route stats GPU avg price
app.get('/api/gpu/avg-price', (req, res) => {
  const data = _gpuMarket?.getAvgPriceByType?.() ?? [];
  res.json({ ok: true, result: data });
});

// Route stats nœuds avg price
app.get('/api/marketplace/avg-price', (req, res) => {
  const data = state.node.marketplace?.getAvgPriceByNodeType?.() ?? [];
  res.json({ ok: true, result: data });
});

export { app, server, wss, state };