// packages/node/src/rest.js
// =====================================================
// REST API — Routes HTTP complètes
// Health + Stats + Chat + Dream + Rewards + Node
// Port de rest.rs — SkyAInet × Nikola T369
// =====================================================

"use strict";

import express from 'express';

// ─────────────────────────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────────────────────────

const API_VERSION = '6.7';

// ─────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────

function ok(res, data, status = 200) {
  return res.status(status).json({ status: 'success', ...data });
}

function err(res, message, status = 400) {
  return res.status(status).json({ status: 'error', message });
}

// ─────────────────────────────────────────────────────────────────
// CREATE REST ROUTER
//
// Port de create_rest_router() dans rest.rs.
// Retourne un Express Router monté sur un préfixe (ex: /api).
//
// Routes :
//   GET  /health              — santé du système
//   GET  /version             — version + build info
//   GET  /stats               — statistiques globales Thevie
//   GET  /node                — dashboard nœud + rewards
//   POST /thevie/message      — envoie un message à Thevie
//   POST /dream/trigger       — déclenche un Dream Cycle
//   GET  /rewards             — statistiques rewards
//   POST /rewards/claim       — réclame les rewards mensuels
//   POST /learn               — injecte une leçon
//   GET  /peers               — liste des pairs
// ─────────────────────────────────────────────────────────────────

export function createRestRouter({ skycloud, chatManager } = {}) {
  const router = express.Router();

  // ── GET /health ──────────────────────────────────────────────
  router.get('/health', (_req, res) => {
    ok(res, {
      status   : 'healthy',
      version  : API_VERSION,
      timestamp: new Date().toISOString(),
    });
  });

  // ── GET /version ─────────────────────────────────────────────
  router.get('/version', (_req, res) => {
    ok(res, { version: API_VERSION, build: 'production' });
  });

  // ── GET /stats — statistiques globales (port de get_system_stats) ─
  router.get('/stats', async (_req, res) => {
    try {
      const status = await skycloud.fullStatusReport?.() ?? {};
      ok(res, {
        wisdomScore    : status.wisdomScore       ?? 0,
        evolutionCycles: status.evolutionCycles   ?? 0,
        totalRequests  : status.totalRequests     ?? 0,
        engineReady    : status.engineReady       ?? false,
        peers          : skycloud.getPeers?.()?.length ?? 0,
        dreamCycles    : status.dreamCyclesRun    ?? 0,
        metaConsciousness: skycloud.metaConsciousness ?? 0,
      });
    } catch (e) { err(res, e.message, 500); }
  });

  // ── GET /node — dashboard nœud + rewards (port de get_node_dashboard) ─
  router.get('/node', async (_req, res) => {
    try {
      const status  = await skycloud.fullStatusReport?.() ?? {};
      const rewards = skycloud.getRewardsStats?.() ?? {};
      ok(res, {
        wisdomScore           : status.wisdomScore   ?? 0,
        totalRequests         : status.totalRequests ?? 0,
        evolutionCycles       : status.evolutionCycles ?? 0,
        engineReady           : status.engineReady   ?? false,
        pendingRewards        : rewards.pendingRewards             ?? 0,
        totalEarnedSky        : rewards.totalSkyEarned             ?? 0,
        qualityScore          : rewards.conversationQualityScore   ?? 0,
        learnContributions    : rewards.totalLearnContributions     ?? 0,
        dreamCycles           : rewards.totalDreamCycles           ?? 0,
        thevieEvolution       : rewards.thevieEvolutionContribution ?? 0,
        isRentedOut           : false,
        monthlyCostEur        : 0,  // sera lié à NodeEconomics
      });
    } catch (e) { err(res, e.message, 500); }
  });

  // ── POST /thevie/message (port de send_message) ───────────────
  router.post('/thevie/message', async (req, res) => {
    const { message, ai = 'thevie' } = req.body ?? {};
    if (!message?.trim()) return err(res, 'Champ "message" requis');
    try {
      const { aiMessage } = await chatManager.handleUserChat({ prompt: message, ai });
      ok(res, {
        response  : aiMessage.content,
        aiUsed    : aiMessage.aiUsed,
        timestamp : Date.now(),
      });
    } catch (e) { err(res, e.message, 500); }
  });

  // ── POST /dream/trigger (port de trigger_dream_cycle) ─────────
  router.post('/dream/trigger', async (_req, res) => {
    try {
      await skycloud.runEvolutionCycle?.();
      ok(res, { message: 'Dream Cycle déclenché avec succès' });
    } catch (e) { err(res, e.message, 500); }
  });

  // ── GET /rewards (port de get_rewards_stats) ──────────────────
  router.get('/rewards', (_req, res) => {
    const r = skycloud.getRewardsStats?.() ?? {};
    ok(res, {
      pendingRewards      : r.pendingRewards             ?? 0,
      totalEarned         : r.totalSkyEarned             ?? 0,
      qualityScore        : r.conversationQualityScore   ?? 0,
      learnContributions  : r.totalLearnContributions     ?? 0,
      dreamCycles         : r.totalDreamCycles           ?? 0,
      thevieEvolution     : r.thevieEvolutionContribution ?? 0,
    });
  });

  // ── POST /rewards/claim (port de claim_rewards) ───────────────
  router.post('/rewards/claim', async (_req, res) => {
    try {
      const result = await skycloud.claimDailyReward?.();
      ok(res, {
        claimed : result?.claimed  ?? 0,
        newTotal: result?.totalSkyEarned ?? 0,
      });
    } catch (e) { err(res, e.message, 500); }
  });

  // ── POST /learn — injection de leçon ──────────────────────────
  router.post('/learn', async (req, res) => {
    const { lesson } = req.body ?? {};
    if (!lesson?.trim()) return err(res, 'Champ "lesson" requis');
    try {
      const result = await skycloud.injectLesson?.(lesson);
      ok(res, { message: 'Leçon injectée', synthesis: result?.synthesis ?? null });
    } catch (e) { err(res, e.message, 500); }
  });

  // ── GET /peers ────────────────────────────────────────────────
  router.get('/peers', (_req, res) => {
    ok(res, { peers: skycloud.getPeers?.() ?? [] });
  });

  return router;
}