// start.js — Point d'entrée SkyAInet PWA
// =====================================================
// Lance le serveur Node.js, ouvre le browser,
// démarre le tray icon, active l'autostart et
// vérifie les mises à jour silencieusement.
//
// Usage :
//   bun start.js              ← mode normal (browser auto)
//   bun start.js --daemon     ← mode daemon (pas de browser)
//   bun start.js --port 9090  ← port personnalisé
//   bun start.js --no-tray    ← sans icône tray
//   bun start.js --no-update  ← sans vérification mise à jour
//
// SkyAInet × Nikola T369
// =====================================================

"use strict";

import { fork }          from 'child_process';
import { exec }          from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { SkyTray }    from '../tray.js';       // packages/node/tray.js
import { Autostart }  from '../autostart.js';  // packages/node/autostart.js
import { SkyUpdater } from '../updater.js';    // packages/node/updater.js

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Args ──────────────────────────────────────────────────────
const args      = process.argv.slice(2);
const isDaemon  = args.includes('--daemon');
const noTray    = args.includes('--no-tray');
const noUpdate  = args.includes('--no-update');
const portIdx   = args.indexOf('--port');
const port      = portIdx !== -1 ? args[portIdx + 1] : (process.env.PORT ?? '8080');

// ── Bannière ──────────────────────────────────────────────────
console.info(`
╔══════════════════════════════════════╗
║   ★ SkyAInet × Nikola T369          ║
║   Sovereign AI Network               ║
╠══════════════════════════════════════╣
║   Version : ${(process.env.SKYAINET_VERSION ?? '0.1.0').padEnd(24)}║
║   Port    : ${String(port).padEnd(24)}║
║   Mode    : ${(isDaemon ? 'Daemon' : 'PWA').padEnd(24)}║
╚══════════════════════════════════════╝
`);

// ── Vérifier si une mise à jour est en attente ───────────────
// Appliquée avant de démarrer le serveur
const updater = new SkyUpdater();
if (updater.hasPendingUpdate) {
    console.info('[Start] Application de la mise à jour en attente…');
    updater.applyPendingUpdate();
}

// ── Démarrer server.js ────────────────────────────────────────
const serverPath = join(__dirname, 'server.js');  // packages/node/src/server.js

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

let restarting = false;
child.on('exit', code => {
    if (restarting || code === 0) return;
    console.warn(`[Start] Serveur arrêté (code ${code}) — redémarrage dans 3s…`);
    setTimeout(() => {
        restarting = false;
        const newChild = fork(serverPath, [], {
            env     : { ...process.env, PORT, SKYAINET_NO_BROWSER: '1' },
            stdio   : 'inherit',
            execArgv: ['--experimental-vm-modules'],
        });
        console.info('[Start] Nœud redémarré');
    }, 3000);
});

// ── Tray icon ─────────────────────────────────────────────────
let tray = null;
if (!noTray) {
    tray = new SkyTray({
        port,
        onQuit: () => shutdown('USER'),
        onRestart: () => {
            restarting = true;
            child.kill('SIGTERM');
            setTimeout(() => {
                const nc = fork(serverPath, [], {
                    env     : { ...process.env, PORT, SKYAINET_NO_BROWSER: '1' },
                    stdio   : 'inherit',
                    execArgv: ['--experimental-vm-modules'],
                });
                restarting = false;
                console.info('[Start] Nœud redémarré via tray');
            }, 2000);
        },
        onUpdate: async () => {
            tray?.setStatus('↻ Checking for updates…');
            const { available, version } = await updater.check();
            if (available) {
                tray?.setStatus(`↓ Downloading v${version}…`);
                await updater.download();
            } else {
                tray?.setStatus('✓ Already up to date');
                setTimeout(() => tray?.setStatus('● Node Active'), 3000);
            }
        },
    });
    await tray.start();
}

// ── Autostart au boot ─────────────────────────────────────────
// Activer si ce n'est pas déjà fait (premier lancement)
if (!Autostart.isEnabled()) {
    const ok = Autostart.enable();
    if (ok) console.info('[Start] Démarrage automatique au boot activé');
}

// ── Updater silencieux ────────────────────────────────────────
if (!noUpdate) {
    const skyUpdater = new SkyUpdater({ tray });
    skyUpdater.start();
}

// ── Notification de démarrage ─────────────────────────────────
const url = `http://localhost:${port}/skyainet.html`;
console.info(`\n✅ SkyAInet Node actif — ${url}`);
console.info(`   Fermer cette fenêtre ne coupe pas le nœud.`);
console.info(`   Utiliser le menu tray pour arrêter.\n`);

// ── Arrêt propre ──────────────────────────────────────────────
function shutdown(reason = 'SIGNAL') {
    console.info(`\n[Start] Arrêt du nœud SkyAInet (${reason})`);
    tray?.destroy();
    child.kill('SIGTERM');
    setTimeout(() => process.exit(0), 1500);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
