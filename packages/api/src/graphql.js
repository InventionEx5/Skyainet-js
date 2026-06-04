// packages/api/src/graphql.js
// =====================================================
// GraphQL API — Queries + Mutations + Types
// Port de graphql.rs — SkyAInet × Nikola T369
// =====================================================

"use strict";

// ─────────────────────────────────────────────────────────────────
// Note : GraphQL en Node.js nécessite une bibliothèque externe.
// Ce fichier utilise graphql-js (graphql) + express-graphql.
//
// Dépendances : npm install graphql express-graphql
//
// Les types SimpleObject de async-graphql (Rust) sont portés en
// types GraphQL manuels via buildSchema + résolveurs.
// ─────────────────────────────────────────────────────────────────

import { buildSchema }  from 'graphql';
import { createHandler } from 'graphql-http/lib/use/express';

// ─────────────────────────────────────────────────────────────────
// SCHEMA SDL — port de tous les SimpleObject + Query + Mutation
// ─────────────────────────────────────────────────────────────────

const typeDefs = /* GraphQL */ `
  """Statistiques globales du système Thevie"""
  type SystemStats {
    wisdomScore      : Float!
    evolutionCycles  : Int!
    totalRequests    : Int!
    engineReady      : Boolean!
    peers            : Int!
    dreamCycles      : Int!
    metaConsciousness: Float!
  }

  """Dashboard complet du nœud"""
  type NodeDashboard {
    wisdomScore           : Float!
    totalRequests         : Int!
    evolutionCycles       : Int!
    engineReady           : Boolean!
    pendingRewards        : Float!
    totalEarnedSky        : Float!
    qualityScore          : Float!
    learnContributions    : Int!
    dreamCycles           : Int!
    thevieEvolution       : Float!
    isRentedOut           : Boolean!
    monthlyCostEur        : Int!
  }

  """Réponse de Thevie à un message"""
  type ThevieResponse {
    response : String!
    aiUsed   : String!
    timestamp: Float!
  }

  """Informations détaillées sur les rewards"""
  type RewardsInfo {
    pendingRewards    : Float!
    totalEarned       : Float!
    qualityScore      : Float!
    learnContributions: Int!
    dreamCycles       : Int!
    thevieEvolution   : Float!
  }

  """Résultat d'un claim de rewards"""
  type ClaimResult {
    claimed : Float!
    newTotal: Float!
  }

  """Pair du réseau"""
  type Peer {
    id        : String!
    address   : String!
    reputation: Float!
    alive     : Boolean!
  }

  # ── Queries ──────────────────────────────────────────────────

  type Query {
    """Santé du système"""
    health: String!

    """Statistiques globales (port de system_stats dans graphql.rs)"""
    systemStats: SystemStats!

    """Dashboard nœud + rewards (port de my_node)"""
    myNode: NodeDashboard!

    """Informations rewards détaillées (port de rewards)"""
    rewards: RewardsInfo!

    """Liste des pairs"""
    peers: [Peer!]!
  }

  # ── Mutations ────────────────────────────────────────────────

  type Mutation {
    """Envoie un message à Thevie (port de send_message_to_thevie)"""
    sendMessageToThevie(message: String!, ai: String): ThevieResponse!

    """Déclenche un Dream Cycle (port de trigger_dream_cycle)"""
    triggerDreamCycle: String!

    """Réclame les rewards mensuels (port de claim_rewards)"""
    claimRewards: ClaimResult!

    """Injecte une leçon dans SkyCloud"""
    injectLesson(lesson: String!): String!
  }
`;

// ─────────────────────────────────────────────────────────────────
// RESOLVERS — port de Query et Mutation dans graphql.rs
// ─────────────────────────────────────────────────────────────────

function createResolvers({ skycloud, chatManager }) {
  return {
    // ── Queries ────────────────────────────────────────────────

    health: () => 'OK',

    systemStats: async () => {
      const status = await skycloud.fullStatusReport?.() ?? {};
      return {
        wisdomScore      : status.wisdomScore       ?? 0,
        evolutionCycles  : status.evolutionCycles   ?? 0,
        totalRequests    : status.totalRequests     ?? 0,
        engineReady      : status.engineReady       ?? false,
        peers            : skycloud.getPeers?.()?.length ?? 0,
        dreamCycles      : status.dreamCyclesRun    ?? 0,
        metaConsciousness: skycloud.metaConsciousness ?? 0,
      };
    },

    myNode: async () => {
      const status  = await skycloud.fullStatusReport?.() ?? {};
      const rewards = skycloud.getRewardsStats?.() ?? {};
      return {
        wisdomScore        : status.wisdomScore                ?? 0,
        totalRequests      : status.totalRequests              ?? 0,
        evolutionCycles    : status.evolutionCycles            ?? 0,
        engineReady        : status.engineReady                ?? false,
        pendingRewards     : rewards.pendingRewards            ?? 0,
        totalEarnedSky     : rewards.totalSkyEarned            ?? 0,
        qualityScore       : rewards.conversationQualityScore  ?? 0,
        learnContributions : rewards.totalLearnContributions   ?? 0,
        dreamCycles        : rewards.totalDreamCycles          ?? 0,
        thevieEvolution    : rewards.thevieEvolutionContribution ?? 0,
        isRentedOut        : false,
        monthlyCostEur     : 0,
      };
    },

    rewards: () => {
      const r = skycloud.getRewardsStats?.() ?? {};
      return {
        pendingRewards    : r.pendingRewards             ?? 0,
        totalEarned       : r.totalSkyEarned             ?? 0,
        qualityScore      : r.conversationQualityScore   ?? 0,
        learnContributions: r.totalLearnContributions    ?? 0,
        dreamCycles       : r.totalDreamCycles           ?? 0,
        thevieEvolution   : r.thevieEvolutionContribution ?? 0,
      };
    },

    peers: () => skycloud.getPeers?.() ?? [],

    // ── Mutations ──────────────────────────────────────────────

    sendMessageToThevie: async ({ message, ai = 'thevie' }) => {
      const { aiMessage } = await chatManager.handleUserChat({ prompt: message, ai });
      return {
        response : aiMessage.content,
        aiUsed   : aiMessage.aiUsed ?? ai,
        timestamp: Date.now(),
      };
    },

    triggerDreamCycle: async () => {
      await skycloud.runEvolutionCycle?.();
      return 'Dream Cycle déclenché avec succès';
    },

    claimRewards: async () => {
      const result = await skycloud.claimDailyReward?.();
      return {
        claimed : result?.claimed      ?? 0,
        newTotal: result?.totalSkyEarned ?? 0,
      };
    },

    injectLesson: async ({ lesson }) => {
      const result = await skycloud.injectLesson?.(lesson);
      return result?.synthesis ?? 'Leçon injectée';
    },
  };
}

// ─────────────────────────────────────────────────────────────────
// SCHEMA FACTORY
//
// Port de create_schema() dans graphql.rs.
// ─────────────────────────────────────────────────────────────────

export function createGraphQLSchema({ skycloud, chatManager }) {
  const schema    = buildSchema(typeDefs);
  const resolvers = createResolvers({ skycloud, chatManager });

  // Attacher les resolvers aux types racines
  const queryType    = schema.getType('Query');
  const mutationType = schema.getType('Mutation');

  for (const [name, fn] of Object.entries(resolvers)) {
    const field = queryType.getFields()[name] ?? mutationType?.getFields()[name];
    if (field) field.resolve = (_src, args) => fn(args);
  }

  return schema;
}

// ─────────────────────────────────────────────────────────────────
// EXPRESS HANDLER FACTORY
//
// Port de create_graphql_router() dans graphql.rs.
// Retourne un handler Express montable sur /graphql.
// ─────────────────────────────────────────────────────────────────

export function createGraphQLHandler({ skycloud, chatManager }) {
  const schema = createGraphQLSchema({ skycloud, chatManager });
  return createHandler({ schema });
}

export { typeDefs };