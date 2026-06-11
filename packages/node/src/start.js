#!/usr/bin/env node
// packages/node/src/start.js
// =====================================================
// Lance le serveur Node.js et ouvre automatiquement
// l'interface dans le browser de l'utilisateur.
//
// Usage :
//   node start.js              ← mode normal
//   node start.js --daemon     ← mode daemon (no browser)
//   node start.js --port 9090  ← port personnalisé
//
// Point d'entrée SkyAInet PWA + SkyAInet × Nikola T369
// =====================================================

"use strict";

import { fork }   from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join }  from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Args ──────────────────────────────────────────────────────
const args    = process.argv.slice(2);
const isDaemon = args.includes('--daemon');
const portIdx  = args.indexOf('--port');
const port     = portIdx !== -1 ? args[portIdx + 1] : '8080';

// ── Bannière ──────────────────────────────────────────────────
console.info(`
  ★ SkyAInet × Nikola T369
  ─────────────────────────────────
  Mode    : ${isDaemon ? 'Daemon (background)' : 'PWA (browser)'}
  Port    : ${port}
  Node.js : ${process.version}
  ─────────────────────────────────
`);

// ── Démarrer server.js ────────────────────────────────────────
const serverPath = join(__dirname, 'packages', 'node', 'src', 'server.js');

const child = fork(serverPath, [], {
    env: {
        ...process.env,
        PORT               : port,
        SKYAINET_NO_BROWSER: isDaemon ? '1' : '0',
    },
    stdio    : 'inherit',
    execArgv : ['--experimental-vm-modules'],
});

child.on('error', err => {
    console.error(`[Start] Erreur démarrage server.js : ${err.message}`);
    process.exit(1);
});

child.on('exit', code => {
    if (code !== 0) {
        console.warn(`[Start] Serveur arrêté (code ${code}) — redémarrage dans 3s…`);
        setTimeout(() => child.send?.('restart'), 3000);
    }
});

// ── Arrêt propre ──────────────────────────────────────────────
const shutdown = (signal) => {
    console.info(`\n[Start] ${signal} — arrêt du nœud SkyAInet`);
    child.kill(signal);
    process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
