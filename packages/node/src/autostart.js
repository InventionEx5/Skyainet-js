// packages/node/autostart.js
// =====================================================
// Enregistre SkyAInet pour démarrer automatiquement
// au lancement du système d'exploitation.
//
// Windows : HKCU\Software\Microsoft\Windows\
//           CurrentVersion\Run (registry)
// macOS   : ~/Library/LaunchAgents/*.plist
// Linux   : ~/.config/systemd/user/*.service
//
// Zéro dépendance externe — APIs système natives.
// Démarrage automatique au boot + SkyAInet × Nikola T369
// =====================================================

"use strict";

import { writeFileSync, mkdirSync, existsSync, unlinkSync } from 'fs';
import { homedir }   from 'os';
import { join }      from 'path';
import { execSync }  from 'child_process';
import { fileURLToPath } from 'url';
import { dirname }   from 'path';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const BINARY     = process.execPath;  // chemin du binaire en cours d'exécution
const APP_NAME   = 'SkyAInet';
const APP_ID     = 'net.skyainet.sovereign';

// ─────────────────────────────────────────────────────────────────
// WINDOWS — Registre
// ─────────────────────────────────────────────────────────────────

function enableWindows() {
    const key  = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run`;
    const cmd  = `reg add "${key}" /v "${APP_NAME}" /t REG_SZ /d "${BINARY}" /f`;
    execSync(cmd);
    console.info(`[Autostart] Windows — clé registre ajoutée : ${key}`);
}

function disableWindows() {
    const key = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run`;
    const cmd = `reg delete "${key}" /v "${APP_NAME}" /f`;
    try { execSync(cmd); } catch { /* déjà absent */ }
    console.info(`[Autostart] Windows — clé registre supprimée`);
}

function isEnabledWindows() {
    try {
        const key = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run`;
        execSync(`reg query "${key}" /v "${APP_NAME}"`, { stdio: 'pipe' });
        return true;
    } catch { return false; }
}

// ─────────────────────────────────────────────────────────────────
// MACOS — LaunchAgent plist
// ─────────────────────────────────────────────────────────────────

function plistPath() {
    return join(homedir(), 'Library', 'LaunchAgents', `${APP_ID}.plist`);
}

function enableMacOS() {
    const path = plistPath();
    mkdirSync(dirname(path), { recursive: true });

    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${APP_ID}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${BINARY}</string>
        <string>--daemon</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${join(homedir(), '.skyainet', 'node.log')}</string>
    <key>StandardErrorPath</key>
    <string>${join(homedir(), '.skyainet', 'node-error.log')}</string>
</dict>
</plist>`;

    writeFileSync(path, plist, 'utf8');
    try { execSync(`launchctl load "${path}"`); } catch { /* ok si déjà chargé */ }
    console.info(`[Autostart] macOS — LaunchAgent créé : ${path}`);
}

function disableMacOS() {
    const path = plistPath();
    try { execSync(`launchctl unload "${path}"`); } catch { /* ok */ }
    if (existsSync(path)) unlinkSync(path);
    console.info(`[Autostart] macOS — LaunchAgent supprimé`);
}

function isEnabledMacOS() {
    return existsSync(plistPath());
}

// ─────────────────────────────────────────────────────────────────
// LINUX — systemd user service
// ─────────────────────────────────────────────────────────────────

function servicePath() {
    return join(homedir(), '.config', 'systemd', 'user', `${APP_ID}.service`);
}

function enableLinux() {
    const path = servicePath();
    mkdirSync(dirname(path), { recursive: true });

    const logDir = join(homedir(), '.skyainet');
    mkdirSync(logDir, { recursive: true });

    const service = `[Unit]
Description=SkyAInet — Sovereign AI Network Node
After=network.target

[Service]
Type=simple
ExecStart=${BINARY} --daemon
Restart=on-failure
RestartSec=3
Environment=SKYAINET_NO_BROWSER=1
StandardOutput=append:${join(logDir, 'node.log')}
StandardError=append:${join(logDir, 'node-error.log')}

[Install]
WantedBy=default.target
`;

    writeFileSync(path, service, 'utf8');
    try {
        execSync('systemctl --user daemon-reload');
        execSync(`systemctl --user enable ${APP_ID}`);
        execSync(`systemctl --user start ${APP_ID}`);
        console.info(`[Autostart] Linux — service systemd activé : ${APP_ID}`);
    } catch (e) {
        console.warn(`[Autostart] Linux — systemd non disponible (${e.message}) — service créé manuellement`);
    }
}

function disableLinux() {
    const path = servicePath();
    try {
        execSync(`systemctl --user stop ${APP_ID}`);
        execSync(`systemctl --user disable ${APP_ID}`);
        execSync('systemctl --user daemon-reload');
    } catch { /* ok */ }
    if (existsSync(path)) unlinkSync(path);
    console.info(`[Autostart] Linux — service systemd supprimé`);
}

function isEnabledLinux() {
    return existsSync(servicePath());
}

// ─────────────────────────────────────────────────────────────────
// API PUBLIQUE
// ─────────────────────────────────────────────────────────────────

export const Autostart = {
    /**
     * Active le démarrage automatique au boot.
     * @returns {boolean} true si succès
     */
    enable() {
        try {
            switch (process.platform) {
                case 'win32'  : enableWindows(); break;
                case 'darwin' : enableMacOS();   break;
                default       : enableLinux();   break;
            }
            return true;
        } catch (e) {
            console.error(`[Autostart] Erreur enable : ${e.message}`);
            return false;
        }
    },

    /**
     * Désactive le démarrage automatique.
     * @returns {boolean} true si succès
     */
    disable() {
        try {
            switch (process.platform) {
                case 'win32'  : disableWindows(); break;
                case 'darwin' : disableMacOS();   break;
                default       : disableLinux();   break;
            }
            return true;
        } catch (e) {
            console.error(`[Autostart] Erreur disable : ${e.message}`);
            return false;
        }
    },

    /**
     * Vérifie si le démarrage automatique est activé.
     * @returns {boolean}
     */
    isEnabled() {
        try {
            switch (process.platform) {
                case 'win32'  : return isEnabledWindows();
                case 'darwin' : return isEnabledMacOS();
                default       : return isEnabledLinux();
            }
        } catch { return false; }
    },

    /** Plateforme courante. */
    get platform() { return process.platform; }
};

export default Autostart;
