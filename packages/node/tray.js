// packages/node/tray.js — Icône système tray SkyAInet
// =====================================================
// Tray icon JS pur via node-systray (~500 Ko).
// Zéro Electron, zéro Rust, zéro Tauri.
// Fonctionne sur Windows, macOS, Linux.
//
// npm install node-systray
//
// SkyAInet × Nikola T369
// =====================================================

"use strict";

import { fileURLToPath } from 'url';
import { dirname, join }  from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const _trayRoot  = dirname(fileURLToPath(import.meta.url));
const ICON_PATH  = join(_trayRoot, '..', '..', 'public-ui', 'icons', 'icon-tray.png');

// Éléments du menu tray
const MENU_OPEN    = 'Open SkyAInet';
const MENU_CLOUD   = 'Skycloud Dashboard';
const MENU_SEP     = '<SEP>';
const MENU_STATUS  = '● Node Active';
const MENU_UPDATE  = '↻ Check for Updates';
const MENU_RESTART = '↺ Restart Node';
const MENU_QUIT    = '✕ Quit';

export class SkyTray {
    #tray    = null;
    #port    = 8080;
    #onQuit  = null;
    #onRestart = null;
    #onUpdate  = null;
    #active  = false;

    /**
     * @param {object} opts
     * @param {number}   opts.port      — port du serveur local
     * @param {Function} opts.onQuit    — callback quitter
     * @param {Function} opts.onRestart — callback redémarrer
     * @param {Function} opts.onUpdate  — callback vérifier mise à jour
     */
    constructor(opts = {}) {
        this.#port      = opts.port      ?? 8080;
        this.#onQuit    = opts.onQuit    ?? (() => process.exit(0));
        this.#onRestart = opts.onRestart ?? (() => {});
        this.#onUpdate  = opts.onUpdate  ?? (() => {});
    }

    async start() {
        try {
            // Import dynamique — pas de crash si node-systray absent
            const { default: SysTray } = await import('node-systray');

            const items = [
                { title: MENU_OPEN,    tooltip: 'Open in browser',    checked: false, enabled: true },
                { title: MENU_CLOUD,   tooltip: 'Skycloud dashboard',  checked: false, enabled: true },
                { title: MENU_SEP,     tooltip: '',                    checked: false, enabled: true },
                { title: MENU_STATUS,  tooltip: 'Node running',        checked: false, enabled: false },
                { title: MENU_UPDATE,  tooltip: 'Check for updates',   checked: false, enabled: true },
                { title: MENU_RESTART, tooltip: 'Restart the node',    checked: false, enabled: true },
                { title: MENU_SEP,     tooltip: '',                    checked: false, enabled: true },
                { title: MENU_QUIT,    tooltip: 'Quit SkyAInet',       checked: false, enabled: true },
            ];

            this.#tray = new SysTray({
                menu: {
                    icon   : ICON_PATH,
                    title  : '',
                    tooltip: 'SkyAInet — Sovereign AI Network',
                    items,
                },
                debug     : false,
                copyDir   : true,
            });

            this.#tray.onClick(action => this.#handleClick(action));
            this.#active = true;
            console.info('[Tray] Icône système activée');

        } catch (e) {
            // node-systray non installé ou plateforme non supportée — silencieux
            console.info(`[Tray] Tray non disponible (${e.message}) — mode headless`);
        }
    }

    #handleClick(action) {
        const item = action.item?.title;
        if (!item) return;

        const url = `http://localhost:${this.#port}`;

        switch (item) {
            case MENU_OPEN:
                this.#openBrowser(`${url}/skyainet.html`);
                break;
            case MENU_CLOUD:
                this.#openBrowser(`${url}/skycloud.html`);
                break;
            case MENU_UPDATE:
                this.#onUpdate();
                break;
            case MENU_RESTART:
                this.#onRestart();
                break;
            case MENU_QUIT:
                this.#onQuit();
                break;
        }
    }

    async #openBrowser(url) {
        const { exec } = await import('child_process').catch(() => ({ exec: null }));
        if (!exec) return;
        const cmd = process.platform === 'win32'  ? `start "" "${url}"`
                  : process.platform === 'darwin' ? `open "${url}"`
                  :                                  `xdg-open "${url}"`;
        exec(cmd, err => { if (err) console.warn('[Tray] Browser non ouvert :', err.message); });
    }

    /** Met à jour le statut dans le menu tray. */
    setStatus(text) {
        if (!this.#tray || !this.#active) return;
        try {
            this.#tray.sendAction({
                type  : 'update-item',
                item  : { title: text, tooltip: text, checked: false, enabled: false },
                seq_id: 3,   // index du MENU_STATUS
            });
        } catch { /* ok */ }
    }

    destroy() {
        if (this.#tray) {
            try { this.#tray.kill(); } catch { /* ok */ }
            this.#tray  = null;
            this.#active = false;
        }
    }

    get isActive() { return this.#active; }
}

export default SkyTray;
