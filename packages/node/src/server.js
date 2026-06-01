// packages/node/src/server.js
// SkyNode HTTP Server — Production Grade
// Conversion complète du serveur Rust + JWT réel + sliding window + métriques avancées
// Compatible 100% avec SkyNode (skynode.js) + toutes les routes originales

import express from 'express';
import cors from 'cors';
import compression from 'compression';
import morgan from 'morgan';
import jwt from 'jsonwebtoken';
import { WebSocketServer } from 'ws';
import crypto from 'crypto';
import { SkyNode } from './skynode.js';
import { createManager, Channel } from '../../secure/src/roots/epoch_rekey.js';

// =====================================================
// RATE LIMITER — Sliding Window (anti-burst optimal)
// =====================================================
class RateLimiter {
  constructor(maxRequests = 60, windowSecs = 60) {
    this.max = maxRequests;
    this.window = windowSecs * 1000;
    this.buckets = new Map();
    setInterval(() => this._purge(), this.window * 2).unref();
  }

  check(ip) {
    const now = Date.now();
    const cutoff = now - this.window;
    let ts = this.buckets.get(ip) || [];

    let i = 0;
    while (i < ts.length && ts[i] <= cutoff) i++;
    if (i > 0) ts.splice(0, i);

    if (ts.length >= this.max) return false;

    ts.push(now);
    this.buckets.set(ip, ts);
    return true;
  }

  _purge() {
    const cutoff = Date.now() - this.window;
    for (const [ip, ts] of this.buckets) {
      if (!ts.length || ts[ts.length - 1] <= cutoff) this.buckets.delete(ip);
    }
  }
}

// =====================================================
// MÉTRIQUES SERVEUR — Fenêtre glissante + req/min
// =====================================================
class ServerMetrics {
  constructor() {
    this.totalRequests = 0;
    this.successfulRequests = 0;
    this.failedRequests = 0;
    this.websocketConnections = 0;
    this.avgResponseMs = 0;
    this._reqTimestamps = [];
  }

  record(success, durationMs) {
    this.totalRequests++;
    success ? this.successfulRequests++ : this.failedRequests++;
    this.avgResponseMs = (this.avgResponseMs * 0.9) + (durationMs * 0.1);

    const now = Date.now();
    this._reqTimestamps.push(now);
    const cutoff = now - 60000;
    let i = 0;
    while (i < this._reqTimestamps.length && this._reqTimestamps[i] < cutoff) i++;
    if (i > 0) this._reqTimestamps.splice(0, i);
  }

  get requestsPerMinute() {
    return this._reqTimestamps.length;
  }

  toJSON() {
    return {
      total_requests: this.totalRequests,
      successful_requests: this.successfulRequests,
      failed_requests: this.failedRequests,
      websocket_connections: this.websocketConnections,
      avg_response_ms: +this.avgResponseMs.toFixed(2),
      requests_per_minute: this.requestsPerMinute
    };
  }
}

// =====================================================
// PAGINATION — Identique au Rust (max 100 items/page)
// =====================================================
class PaginationParams {
  constructor(page = 1, perPage = 20) {
    this.page = Math.max(1, parseInt(page) || 1);
    this.perPage = Math.min(100, Math.max(1, parseInt(perPage) || 20));
  }

  offset() {
    return (this.page - 1) * this.perPage;
  }

  paginate(items) {
    const total = items.length;
    const start = this.offset();
    return {
      items: items.slice(start, start + this.perPage),
      pagination: {
        page: this.page,
        per_page: this.perPage,
        total,
        total_pages: Math.ceil(total / this.perPage) || 1
      }
    };
  }
}

// =====================================================
// ERREUR STANDARD
// =====================================================
function apiError(res, status, error, message) {
  res.status(status).json({
    code: status,
    error,
    message,
    request_id: crypto.randomUUID()
  });
}

// =====================================================
// ÉTAT GLOBAL + VRAIE LOGIQUE SKYNODE
// =====================================================
const state = {
  node: (() => {
    const n = new SkyNode();           // ← Vrai SkyNode avec toute la logique réelle

    // Shims de compatibilité (champs attendus par les routes)
    n.id = n.id;
    n.is_running = n.isRunning;
    n.wisdom_score = n.wisdomScore;
    n.total_requests = n.totalRequests;
    n.peers = n.peers || [];
    n.registered_ais = n.registeredAIs;
    n.message_bus = n.messageBus;
    n.evolution_cycles = n.evolutionCycles;
    n.last_dream_cycle = n.lastDreamCycle;

    // =====================================================
    // VRAIES LOGIQUES (plus de stubs)
    // =====================================================
    n.run_real_dream_cycle = n.runDreamCycle.bind(n);
    n.generate_with_ai = n.generateWithAI.bind(n);
    n.send_message = n.sendMessage.bind(n);
    n.enable_external_ai = n.enableExternalAI.bind(n);

    // Stockage (vrai)
    n.upload_file = n.uploadFile.bind(n);
    n.list_files = n.listFiles.bind(n);
    n.download_file = n.downloadFile.bind(n);
    n.delete_file = n.deleteFile.bind(n);

    return n;
  })(),

  rate_limiter: new RateLimiter(60, 60),
  metrics: new ServerMetrics(),
  api_keys: [process.env.SKYNODE_API_KEY || 'dev-key-unsafe'],
  jwt_secret: process.env.SKYNODE_JWT_SECRET || 'change-me-in-prod'
};

// =====================================================
// MIDDLEWARES
// =====================================================
function rateLimitMiddleware(req, res, next) {
  if (req.path === '/health') return next();
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || 'unknown';
  if (!state.rate_limiter.check(ip)) {
    console.warn(`[RateLimit] Bloqué: ${ip}`);
    return apiError(res, 429, 'RATE_LIMITED', 'Trop de requêtes, réessaie dans un moment.');
  }
  next();
}

function authMiddleware(req, res, next) {
  const path = req.path;
  if (['/health', '/api/status'].includes(path)) return next();

  const apiKey = req.headers['x-api-key'];
  if (state.api_keys.includes(apiKey)) return next();

  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) {
    return apiError(res, 401, 'UNAUTHORIZED', 'API key ou token JWT requis.');
  }

  const token = auth.slice(7);
  try {
    jwt.verify(token, state.jwt_secret, { algorithms: ['HS256'] });
    next();
  } catch (err) {
    const msg = err.name === 'TokenExpiredError' ? 'Token JWT expiré' : 'Token JWT invalide';
    return apiError(res, 401, 'UNAUTHORIZED', msg);
  }
}

function metricsMiddleware(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    state.metrics.record(res.statusCode < 400, Date.now() - start);
  });
  next();
}

// =====================================================
// EXPRESS APP
// =====================================================
const app = express();
app.use(morgan('dev'));
app.use(compression());
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['*'],
  maxAge: 3600
}));
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
  const n = state.node;
  res.json({
    status: n.is_running ? 'active' : 'stopped',
    node_id: n.id,
    wisdom_score: n.wisdom_score,
    total_requests: n.total_requests,
    peers: n.peers.length,
    registered_ais: n.registered_ais.size,
    message_bus: n.message_bus.length
  });
});

app.get('/api/node', (req, res) => {
  const n = state.node;
  res.json({
    id: n.id,
    state: n.state,
    is_running: n.is_running,
    wisdom_score: n.wisdom_score,
    total_requests: n.total_requests,
    evolution_cycles: n.evolution_cycles,
    peers_connected: n.peers.length,
    registered_ais: n.registered_ais.size,
    message_bus_size: n.message_bus.length
  });
});

app.get('/api/neural-mesh', (req, res) => {
  const n = state.node;
  res.json({
    wisdom_level: n.wisdom_score,
    evolution_cycles: n.evolution_cycles,
    last_dream_cycle: n.last_dream_cycle
  });
});

app.get('/api/stats', (req, res) => {
  const n = state.node;
  res.json({
    wisdom_score: n.wisdom_score,
    total_requests: n.total_requests,
    active_model: 'T369Inference + LoraÉvo + Gematria Flash Core'
  });
});

app.get('/api/dream-cycle', async (req, res) => {
  try {
    const msg = await state.node.run_real_dream_cycle();
    res.json({ success: true, message: msg, wisdom: state.node.wisdom_score });
  } catch (e) {
    apiError(res, 500, 'INTERNAL_ERROR', e.message);
  }
});

// =====================================================
// ROUTES — IA
// =====================================================
app.post('/api/ai/generate', async (req, res) => {
  try {
    const response = await state.node.generate_with_ai(req.body);
    res.json({ success: true, response });
  } catch (e) {
    apiError(res, 500, 'INTERNAL_ERROR', e.message);
  }
});

app.post('/api/ai/message', async (req, res) => {
  const { from, to, content } = req.body;
  if (!from || !to) return apiError(res, 400, 'BAD_REQUEST', "Champs 'from' et 'to' requis");
  try {
    const msg = state.node.send_message(from, to, content || '');
    res.json({ success: true, message: msg });
  } catch (e) {
    apiError(res, 500, 'INTERNAL_ERROR', e.message);
  }
});

app.get('/api/ai/list', (req, res) => {
  const ais = Array.from(state.node.registered_ais.keys());
  res.json({ ais, total: ais.length });
});

app.post('/api/ai/external', (req, res) => {
  const enabled = !!req.body.enabled;
  state.node.enable_external_ai(enabled);
  res.json({ success: true, external_ai_enabled: enabled });
});

// =====================================================
// ROUTES — STOCKAGE (avec pagination)
// =====================================================
app.post('/api/storage/upload', async (req, res) => {
  const { name, data } = req.body;
  if (!name || !Array.isArray(data)) {
    return apiError(res, 400, 'BAD_REQUEST', "Champs 'name' et 'data' requis");
  }
  try {
    const id = await state.node.upload_file(name, data);
    const file = (await state.node.list_files()).find(f => f.id === id);
    res.status(201).json({ success: true, file_id: id, name, size_bytes: file?.size_bytes || 0 });
  } catch (e) {
    apiError(res, 500, 'INTERNAL_ERROR', e.message);
  }
});

app.get('/api/storage/list', (req, res) => {
  try {
    const params = new PaginationParams(req.query.page, req.query.per_page);
    const all = state.node.list_files();
    const { items, pagination } = params.paginate(all);
    res.json({ success: true, files: items, pagination });
  } catch (e) {
    apiError(res, 500, 'INTERNAL_ERROR', e.message);
  }
});

app.post('/api/storage/download', (req, res) => {
  const { file_id } = req.body;
  if (!file_id) return apiError(res, 400, 'BAD_REQUEST', "Champ 'file_id' requis");
  try {
    const result = state.node.download_file(file_id);
    res.json({ success: true, ...result });
  } catch (e) {
    apiError(res, 404, 'NOT_FOUND', e.message);
  }
});

app.post('/api/storage/delete', (req, res) => {
  const { file_id } = req.body;
  if (!file_id) return apiError(res, 400, 'BAD_REQUEST', "Champ 'file_id' requis");
  try {
    state.node.delete_file(file_id);
    res.json({ success: true, deleted: file_id });
  } catch (e) {
    apiError(res, 404, 'NOT_FOUND', e.message);
  }
});

// =====================================================
// WEBSOCKET — TEMPS RÉEL
// =====================================================
function handle_ws(ws) {
  state.metrics.websocketConnections++;
  console.log('🔌 Nouvelle connexion WebSocket');

  ws.send(JSON.stringify({
    type: 'connected',
    message: 'SkyNode WebSocket connecté',
    timestamp: new Date().toISOString()
  }));

  ws.on('message', async (raw) => {
    try {
      const cmd = JSON.parse(raw.toString());
      let response;

      if (cmd.type === 'status') {
        const n = state.node;
        response = {
          type: 'status_response',
          node_id: n.id,
          wisdom_score: n.wisdom_score,
          is_running: n.is_running,
          reputation: n.wisdom_score,
          tier: 'PRO'
        };
      } else if (cmd.type === 'ping') {
        response = { type: 'pong', ts: new Date().toISOString() };
      } else if (cmd.type === 'dream') {
        const msg = await state.node.run_real_dream_cycle();
        response = { type: 'dream_response', message: msg };
      } else if (cmd.type === 'metrics') {
        response = { type: 'metrics_response', metrics: state.metrics.toJSON() };
      } else {
        response = { type: 'error', message: 'Commande inconnue (status, ping, dream, metrics)' };
      }
      ws.send(JSON.stringify(response));
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', message: e.message }));
    }
  });

  ws.on('close', () => {
    state.metrics.websocketConnections = Math.max(0, state.metrics.websocketConnections - 1);
    console.log('🔌 WebSocket déconnecté');
  });
}

// =====================================================
// DÉMARRAGE
// =====================================================
const keyManager = createManager('high');
state.keyManager = keyManager;

const PORT = process.env.PORT || 8080;
const server = app.listen(PORT, () => {
  console.log(`✅ SkyNode Server démarré sur http://0.0.0.0:${PORT}`);
  console.log(`   JWT réel | Sliding Window Rate Limit | Metrics avancés | Pagination | WebSocket complet | EpochRekeyManager (high)`);
});

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws) => handle_ws(ws));

console.log('🚀 Migration Rust → JavaScript terminée — VRAIE LOGIQUE SkyNode activée.');