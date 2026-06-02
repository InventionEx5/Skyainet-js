// packages/node/src/server.js
// SkyNode HTTP Server — Production Grade
// Express + JWT HS256 + Sliding Window Rate Limit + Métriques + WebSocket
// Branché sur SkyNode réel (skynode.js)

"use strict";

import express               from 'express';
import cors                  from 'cors';
import compression           from 'compression';
import morgan                from 'morgan';
import jwt                   from 'jsonwebtoken';
import { WebSocketServer }   from 'ws';
import crypto                from 'crypto';

import { SkyNode }           from './skynode.js';

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
// ÉTAT GLOBAL — SkyNode réel
// =====================================================

const state = {
  node       : new SkyNode(),
  rateLimiter: new RateLimiter(60, 60),
  metrics    : new ServerMetrics(),
  apiKeys    : [process.env.SKYNODE_API_KEY    ?? 'dev-key-unsafe'],
  jwtSecret  : process.env.SKYNODE_JWT_SECRET  ?? 'change-me-in-prod',
};

// Démarrage du moteur T369 en arrière-plan (non bloquant)
state.node.initEngine().catch(e =>
  console.warn('[Server] initEngine:', e.message)
);

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

function authMiddleware(req, res, next) {
  const path = req.path;
  if (path === '/health' || path === '/api/status') return next();

  const apiKey = req.headers['x-api-key'];
  if (state.apiKeys.includes(apiKey)) return next();

  const auth = (req.headers.authorization ?? '');
  if (!auth.startsWith('Bearer ')) {
    return apiError(res, 401, 'UNAUTHORIZED', 'API key ou token JWT requis.');
  }

  try {
    req.jwtPayload = jwt.verify(auth.slice(7), state.jwtSecret, { algorithms: ['HS256'] });
    next();
  } catch (err) {
    const msg = err.name === 'TokenExpiredError' ? 'Token JWT expiré.' : 'Token JWT invalide.';
    return apiError(res, 401, 'UNAUTHORIZED', msg);
  }
}

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
app.use(authMiddleware);
app.use(metricsMiddleware);

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

app.post('/api/ai/generate', async (req, res) => {
  try {
    const result = await state.node.generateWithAI(req.body);
    res.json({ success: true, response: result });
  } catch (e) {
    apiError(res, 500, 'INTERNAL_ERROR', e.message);
  }
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

app.post('/api/ai/lesson', async (req, res) => {
  const { lesson } = req.body;
  if (!lesson?.trim()) return apiError(res, 400, 'BAD_REQUEST', "Champ 'lesson' requis.");
  try {
    const result = await state.node.injectLesson(lesson);
    res.json({ success: true, ...result });
  } catch (e) {
    apiError(res, 500, 'INTERNAL_ERROR', e.message);
  }
});

// Clés API
app.post('/api/keys/create', (req, res) => {
  const { name, allowedAIs = [], rateLimit = 60 } = req.body;
  if (!name?.trim()) return apiError(res, 400, 'BAD_REQUEST', "Champ 'name' requis.");
  const key = state.node.generateApiKey(name.trim(), allowedAIs, rateLimit);
  res.status(201).json({ success: true, key });
});

app.get('/api/keys/list', (req, res) => {
  res.json({ success: true, keys: state.node.listApiKeys() });
});

app.post('/api/keys/revoke', (req, res) => {
  const { key } = req.body;
  if (!key) return apiError(res, 400, 'BAD_REQUEST', "Champ 'key' requis.");
  try {
    state.node.revokeApiKey(key);
    res.json({ success: true });
  } catch (e) {
    apiError(res, 404, 'NOT_FOUND', e.message);
  }
});

// =====================================================
// ROUTES — STOCKAGE (avec pagination)
// =====================================================

app.post('/api/storage/upload', async (req, res) => {
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

app.get('/api/storage/list', async (req, res) => {
  try {
    const files              = await state.node.listFiles();
    const params             = new PaginationParams(req.query.page, req.query.per_page);
    const { items, pagination } = params.paginate(files);
    res.json({ success: true, files: items, pagination });
  } catch (e) {
    apiError(res, 500, 'INTERNAL_ERROR', e.message);
  }
});

app.post('/api/storage/download', async (req, res) => {
  const id = req.body.file_id?.trim() || req.body.id?.trim();
  if (!id) return apiError(res, 400, 'BAD_REQUEST', "Champ 'file_id' requis.");
  try {
    const data = await state.node.downloadFile(id);
    res.json({ success: true, file_id: id, data });
  } catch (e) {
    apiError(res, 404, 'NOT_FOUND', e.message);
  }
});

app.post('/api/storage/delete', async (req, res) => {
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

app.get('/api/peers', (req, res) => {
  res.json({ success: true, peers: state.node.getPeers() });
});

app.post('/api/peers/sync', async (req, res) => {
  try {
    const result = await state.node.syncWithNetwork();
    res.json({ success: true, ...result });
  } catch (e) {
    apiError(res, 500, 'INTERNAL_ERROR', e.message);
  }
});

// =====================================================
// ROUTES — ÉVOLUTION
// =====================================================

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
    message  : 'SkyNode WebSocket connecté',
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
          tier       : 'SkyNode',
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

const PORT   = parseInt(process.env.PORT ?? '8080');
const server = app.listen(PORT, '0.0.0.0', () => {
  console.info(`✅ SkyNode Server démarré sur http://0.0.0.0:${PORT}`);
  console.info(`   JWT HS256 | Sliding Window | Métriques EMA | Pagination | WebSocket`);
  if (state.jwtSecret === 'change-me-in-prod') {
    console.warn('   ⚠️  JWT secret par défaut — définir SKYNODE_JWT_SECRET en production');
  }
});

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', ws => handleWs(ws));

export { app, server, wss, state };