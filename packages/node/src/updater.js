// packages/node/updater.js
// =====================================================
// Vérifie si une nouvelle version existe sur le réseau,
// télécharge le nouveau binaire en arrière-plan,
// notifie l'utilisateur via tray et toast browser.
//
// Endpoint de version :
//   https://skyainet.net/version.json
//   { "version": "0.2.0", "url": { "win32": "...", "darwin": "...", "linux": "..." } }
//
// Auto-update silencieux du binaire SkyAInet + SkyAInet × Nikola T369
// =====================================================

"use strict";

import { createWriteStream, renameSync, unlinkSync, chmodSync, existsSync } from 'fs';
import { tmpdir }          from 'os';
import { join, basename }  from 'path';
import { pipeline }        from 'stream/promises';

const VERSION_URL    = 'https://skyainet.net/version.json';
const CHECK_INTERVAL = 6 * 60 * 60 * 1000;   // vérifier toutes les 6h
const CURRENT_VERSION = process.env.SKYAINET_VERSION ?? '0.1.0';

// ─────────────────────────────────────────────────────────────────
// COMPARAISON SEMVER
// ─────────────────────────────────────────────────────────────────

function semverGt(a, b) {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        if ((pa[i] ?? 0) > (pb[i] ?? 0)) return true;
        if ((pa[i] ?? 0) < (pb[i] ?? 0)) return false;
    }
    return false;
}

// ─────────────────────────────────────────────────────────────────
// UPDATER
// ─────────────────────────────────────────────────────────────────

export class SkyUpdater {
    #tray          = null;   // SkyTray — pour la notification
    #wss           = null;   // WebSocketServer — pour notifier les browsers
    #checking      = false;
    #latestVersion = null;
    #downloadUrl   = null;
    #timer         = null;

    /**
     * @param {object} opts
     * @param {object} [opts.tray]  — instance SkyTray
     * @param {object} [opts.wss]   — WebSocketServer pour notifier les browsers
     */
    constructor(opts = {}) {
        this.#tray = opts.tray ?? null;
        this.#wss  = opts.wss  ?? null;
    }

    // ─── Démarrage ────────────────────────────────────────────

    /**
     * Lance la vérification périodique des mises à jour.
     * Vérification immédiate au démarrage, puis toutes les 6h.
     */
    start() {
        // Vérification initiale après 30s (laisser le nœud démarrer)
        setTimeout(() => this.check(), 30_000);
        // Vérifications périodiques
        this.#timer = setInterval(() => this.check(), CHECK_INTERVAL);
        console.info(`[Updater] Vérification automatique toutes les ${CHECK_INTERVAL / 3_600_000}h`);
    }

    stop() {
        if (this.#timer) { clearInterval(this.#timer); this.#timer = null; }
    }

    // ─── Vérification ─────────────────────────────────────────

    /**
     * Vérifie si une nouvelle version est disponible.
     * @returns {Promise<{ available: boolean, version?: string }>}
     */
    async check() {
        if (this.#checking) return { available: false };
        this.#checking = true;

        try {
            const res  = await fetch(VERSION_URL, { signal: AbortSignal.timeout(10_000) });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();

            if (!semverGt(data.version, CURRENT_VERSION)) {
                console.info(`[Updater] Version à jour (${CURRENT_VERSION})`);
                return { available: false };
            }

            this.#latestVersion = data.version;
            this.#downloadUrl   = data.url?.[process.platform] ?? data.url?.linux;

            console.info(`[Updater] Nouvelle version disponible : ${CURRENT_VERSION} → ${data.version}`);

            // Notifier le tray
            this.#tray?.setStatus(`↻ Update available: v${data.version}`);

            // Notifier tous les browsers connectés via WebSocket
            this.#broadcastTobrowsers({
                type   : 'UPDATE_AVAILABLE',
                version: data.version,
                current: CURRENT_VERSION,
            });

            return { available: true, version: data.version };

        } catch (e) {
            console.debug(`[Updater] Vérification impossible : ${e.message}`);
            return { available: false };
        } finally {
            this.#checking = false;
        }
    }

    // ─── Téléchargement ───────────────────────────────────────

    /**
     * Télécharge et installe la mise à jour en arrière-plan.
     * L'utilisateur est notifié quand le téléchargement est terminé.
     */
    async download() {
        if (!this.#downloadUrl) {
            await this.check();
            if (!this.#downloadUrl) return { success: false, reason: 'no_update' };
        }

        console.info(`[Updater] Téléchargement de v${this.#latestVersion}…`);

        const tmpPath = join(tmpdir(), `skyainet-update-${Date.now()}`);
        const binary  = process.execPath;

        try {
            // Télécharger dans un fichier temporaire
            const res = await fetch(this.#downloadUrl, { signal: AbortSignal.timeout(120_000) });
            if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);

            const writer = createWriteStream(tmpPath);
            await pipeline(res.body, writer);

            // Rendre exécutable (Linux/macOS)
            if (process.platform !== 'win32') {
                chmodSync(tmpPath, 0o755);
            }

            console.info(`[Updater] Téléchargement terminé → ${tmpPath}`);

            // Notifier : prêt à installer
            this.#broadcastTobrowsers({
                type   : 'UPDATE_READY',
                version: this.#latestVersion,
            });
            this.#tray?.setStatus(`✓ Update v${this.#latestVersion} ready — restart to apply`);

            // Stocker le chemin pour l'application au redémarrage
            process.env.SKYAINET_PENDING_UPDATE = tmpPath;

            return { success: true, tmpPath, version: this.#latestVersion };

        } catch (e) {
            if (existsSync(tmpPath)) { try { unlinkSync(tmpPath); } catch { /* ok */ } }
            console.error(`[Updater] Téléchargement échoué : ${e.message}`);
            return { success: false, reason: e.message };
        }
    }

    /**
     * Applique la mise à jour en remplaçant le binaire courant.
     * Doit être appelé juste avant de quitter le processus.
     */
    applyPendingUpdate() {
        const pending = process.env.SKYAINET_PENDING_UPDATE;
        if (!pending || !existsSync(pending)) return false;

        const binary = process.execPath;
        try {
            // Sur Windows : renommer l'ancien, copier le nouveau
            if (process.platform === 'win32') {
                renameSync(binary, binary + '.old');
            }
            renameSync(pending, binary);
            if (process.platform !== 'win32') chmodSync(binary, 0o755);
            console.info(`[Updater] Mise à jour appliquée → ${binary}`);
            return true;
        } catch (e) {
            console.error(`[Updater] Application de la mise à jour échouée : ${e.message}`);
            return false;
        }
    }

    // ─── Notification browsers ────────────────────────────────

    #broadcastTobrowsers(data) {
        if (!this.#wss) return;
        const msg = JSON.stringify({ event: 'updater', ...data });
        this.#wss.clients.forEach(client => {
            if (client.readyState === 1) {
                try { client.send(msg); } catch { /* ok */ }
            }
        });
    }

    get latestVersion() { return this.#latestVersion; }
    get currentVersion() { return CURRENT_VERSION; }
    get hasPendingUpdate() { return !!process.env.SKYAINET_PENDING_UPDATE; }
}

export default SkyUpdater;
