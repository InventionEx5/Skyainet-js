// packages/api/src/websocket.js
// =====================================================
// WebSocket API — Communication Temps Réel
// Chat Thevie + Rewards + Node + Stats + Dream
// Port de websocket.rs — SkyAInet × Nikola T369
// =====================================================

"use strict";

import { WebSocketServer } from 'ws';

// ─────────────────────────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────────────────────────

const PING_INTERVAL_MS  = 30_000;
const MAX_MESSAGE_SIZE  = 64 * 1024;   // 64 KB
const WS_VERSION        = '6.7';

// ─────────────────────────────────────────────────────────────────
// TYPES DE MESSAGES ENTRANTS
// ─────────────────────────────────────────────────────────────────

const MessageType = Object.freeze({
  CHAT          : 'chat',
  STATS         : 'stats',
  CLAIM_REWARDS : 'claim_rewards',
  NODE          : 'node',
  DREAM         : 'dream',
  LEARN         : 'learn',
  PING          : 'ping',
});

// ─────────────────────────────────────────────────────────────────
// WS HANDLER
//
// Gère une connexion WebSocket individuelle.
// Port de handle_socket() dans websocket.rs.
//
// Messages entrants supportés :
//   chat          — envoie un message à Thevie via AIChatManager
//   stats         — statistiques rewards + sagesse
//   claim_rewards — réclame les rewards mensuels
//   node          — informations du nœud
//   dream         — déclenche un Dream Cycle
//   learn         — injecte une leçon dans SkyCloud
//   ping          — keepalive
// ─────────────────────────────────────────────────────────────────

class WsHandler {
  #ws;
  #skycloud;
  #chatManager;
  #pingTimer;
  #clientId;

  constructor(ws, { skycloud, chatManager }) {
    this.#ws          = ws;
    this.#skycloud    = skycloud;
    this.#chatManager = chatManager;
    this.#clientId    = `ws_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
    this.#pingTimer   = null;

    this.#setup();
  }

  #setup() {
    this.#ws.on('message', async (raw) => {
      if (raw.length > MAX_MESSAGE_SIZE) {
        return this.#send({ type: 'error', message: 'Message trop volumineux' });
      }
      try {
        const msg = JSON.parse(raw.toString());
        await this.#dispatch(msg);
      } catch (e) {
        this.#send({ type: 'error', message: `JSON invalide : ${e.message}` });
      }
    });

    this.#ws.on('close', () => {
      clearInterval(this.#pingTimer);
      console.info(`[WebSocket] Connexion fermée — ${this.#clientId}`);
    });

    this.#ws.on('error', (e) => {
      console.warn(`[WebSocket] Erreur — ${this.#clientId} : ${e.message}`);
    });

    // Keepalive
    this.#pingTimer = setInterval(() => {
      if (this.#ws.readyState === 1) this.#ws.ping();
    }, PING_INTERVAL_MS);

    // Message de bienvenue (port du message initial dans websocket.rs)
    this.#send({
      type   : 'welcome',
      message: `Connecté à SkyAInet WebSocket v${WS_VERSION}`,
      clientId: this.#clientId,
    });

    console.info(`[WebSocket] Nouvelle connexion — ${this.#clientId}`);
  }

  async #dispatch(msg) {
    const type = msg?.type ?? '';
    console.debug(`[WebSocket] ${this.#clientId} → ${type}`);

    switch (type) {
      // ── Chat Thevie (port de "chat" dans websocket.rs) ─────────
      case MessageType.CHAT: {
        if (!msg.content?.trim()) {
          return this.#send({ type: 'error', message: 'Contenu vide' });
        }
        try {
          const { aiMessage } = await this.#chatManager.handleUserChat({
            prompt: msg.content,
            ai    : msg.ai ?? 'thevie',
          });
          this.#send({
            type     : 'thevie_response',
            content  : aiMessage.content,
            aiUsed   : aiMessage.aiUsed,
            timestamp: Date.now(),
          });
        } catch (e) {
          this.#send({ type: 'error', message: e.message });
        }
        break;
      }

      // ── Stats rewards (port de "stats" dans websocket.rs) ───────
      case MessageType.STATS: {
        const rewards = this.#skycloud.getRewardsStats?.() ?? {};
        const wisdom  = this.#skycloud._collectiveWisdom   ?? 0;
        this.#send({
          type                : 'stats',
          pendingRewards      : rewards.pendingRewards      ?? 0,
          totalEarned         : rewards.totalSkyEarned      ?? 0,
          qualityScore        : rewards.conversationQualityScore ?? 0,
          learnContributions  : rewards.totalLearnContributions  ?? 0,
          dreamCycles         : rewards.totalDreamCycles         ?? 0,
          wisdomScore         : +wisdom.toFixed(4),
          timestamp           : Date.now(),
        });
        break;
      }

      // ── Claim rewards (port de "claim_rewards") ─────────────────
      case MessageType.CLAIM_REWARDS: {
        try {
          const result = await this.#skycloud.claimDailyReward?.();
          this.#send({
            type    : 'claim_result',
            claimed : result?.claimed ?? 0,
            newTotal: result?.totalSkyEarned ?? 0,
          });
        } catch (e) {
          this.#send({ type: 'error', message: e.message });
        }
        break;
      }

      // ── Infos nœud (port de "node") ──────────────────────────────
      case MessageType.NODE: {
        const status = await this.#skycloud.fullStatusReport?.() ?? {};
        this.#send({
          type        : 'node',
          wisdomScore : status.wisdomScore  ?? 0,
          totalRequests: status.totalRequests ?? 0,
          evolutionCycles: status.evolutionCycles ?? 0,
          engineReady : status.engineReady  ?? false,
          peers       : this.#skycloud.getPeers?.()?.length ?? 0,
          state       : status.state        ?? 'Active',
          timestamp   : Date.now(),
        });
        break;
      }

      // ── Dream Cycle ──────────────────────────────────────────────
      case MessageType.DREAM: {
        try {
          await this.#skycloud.runEvolutionCycle?.();
          this.#send({ type: 'dream_response', message: 'Dream Cycle déclenché avec succès', timestamp: Date.now() });
        } catch (e) {
          this.#send({ type: 'error', message: e.message });
        }
        break;
      }

      // ── Injection de leçon ───────────────────────────────────────
      case MessageType.LEARN: {
        if (!msg.content?.trim()) {
          return this.#send({ type: 'error', message: 'Leçon vide' });
        }
        try {
          const result = await this.#skycloud.injectLesson?.(msg.content);
          this.#send({ type: 'learn_response', message: 'Leçon injectée', synthesis: result?.synthesis ?? null });
        } catch (e) {
          this.#send({ type: 'error', message: e.message });
        }
        break;
      }

      // ── Ping ─────────────────────────────────────────────────────
      case MessageType.PING:
        this.#send({ type: 'pong', timestamp: Date.now() });
        break;

      default:
        console.warn(`[WebSocket] Type inconnu : ${type}`);
        this.#send({ type: 'error', message: `Type de message inconnu : ${type}` });
    }
  }

  #send(data) {
    if (this.#ws.readyState !== 1) return;
    try { this.#ws.send(JSON.stringify(data)); }
    catch (e) { console.warn(`[WebSocket] Envoi échoué : ${e.message}`); }
  }
}

// ─────────────────────────────────────────────────────────────────
// WEBSOCKET SERVER FACTORY
//
// Port de create_websocket_router() — attache le WS à un serveur HTTP.
// ─────────────────────────────────────────────────────────────────

export class SkyWebSocketServer {
  #wss;
  #clients;   // Set<WsHandler>

  /**
   * @param {object} httpServer  — serveur HTTP (Node http.Server)
   * @param {object} skycloud    — SkyCloud instance
   * @param {object} chatManager — AIChatManager instance
   * @param {string} [path]      — chemin WS (défaut: '/ws')
   */
  constructor(httpServer, { skycloud, chatManager, path = '/ws' } = {}) {
    this.#clients = new Set();
    this.#wss     = new WebSocketServer({ server: httpServer, path });

    this.#wss.on('connection', (ws) => {
      const handler = new WsHandler(ws, { skycloud, chatManager });
      this.#clients.add(handler);
      ws.on('close', () => this.#clients.delete(handler));
    });

    console.info(`[WebSocket] Serveur démarré sur ${path}`);
  }

  /** Diffuse un message à tous les clients connectés. */
  broadcast(data) {
    const payload = JSON.stringify(data);
    for (const client of this.#wss.clients) {
      if (client.readyState === 1) client.send(payload);
    }
  }

  get clientCount() { return this.#wss.clients.size; }

  close() { this.#wss.close(); }
}