// packages/api/src/api.js
// =====================================================
// API Package — Point d'entrée central
// REST + WebSocket + GraphQL
// SkyAInet × Nikola T369
// =====================================================

"use strict";

// ─────────────────────────────────────────────────────────────────
// REST — Routes HTTP
// ─────────────────────────────────────────────────────────────────

export { createRestRouter }                     from '#rest';

// ─────────────────────────────────────────────────────────────────
// WEBSOCKET — Communication Temps Réel
// ─────────────────────────────────────────────────────────────────

export { SkyWebSocketServer }                   from '#websocket';

// ─────────────────────────────────────────────────────────────────
// GRAPHQL — Queries + Mutations
// ─────────────────────────────────────────────────────────────────

export {
  createGraphQLHandler,
  createGraphQLSchema,
  typeDefs,
}                                               from '#graphql';

// ─────────────────────────────────────────────────────────────────
// USAGE RAPIDE — monte REST + WS + GraphQL sur un serveur Express
//
// import { mountApi } from '#api';
// mountApi(app, server, { skycloud, chatManager });
// ─────────────────────────────────────────────────────────────────

export async function mountApi(app, httpServer, { skycloud, chatManager, prefix = '/api' } = {}) {
  const { createRestRouter }    = await import('#rest').then(m => m);
  const { SkyWebSocketServer }  = await import('#websocket').then(m => m);
  const { createGraphQLHandler }= await import('#graphql').then(m => m);

  // REST
  app.use(prefix, createRestRouter({ skycloud, chatManager }));

  // GraphQL
  app.use('/graphql', createGraphQLHandler({ skycloud, chatManager }));

  // WebSocket
  const wss = new SkyWebSocketServer(httpServer, { skycloud, chatManager });

  console.info(`[API] REST: ${prefix} | GraphQL: /graphql | WS: /ws`);
  return { wss };
}

// ─────────────────────────────────────────────────────────────────
// VERSION
// ─────────────────────────────────────────────────────────────────

export const VERSION = '1.0.0';

export const PACKAGE_INFO = Object.freeze({
  name       : 'skyainet-api',
  version    : VERSION,
  description: 'SkyAInet API — REST + WebSocket + GraphQL',
  modules    : ['createRestRouter', 'SkyWebSocketServer', 'createGraphQLHandler'],
});
