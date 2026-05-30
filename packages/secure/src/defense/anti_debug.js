// packages/secure/src/defense/anti_debug.js
// =====================================================
// Anti-Debug & Anti-Reverse Engineering — Fully Hardened v5.2
// SkyAInet × Nikola T369 — Physical Attacks Protection (PA)
// =====================================================

// Node.js only (fs + crypto + process) — anti-debug protection
import fs from 'fs';
import { createHash } from 'crypto';
import process from 'process';

export class AntiDebug {
  constructor() {
    this.tamperDetected = false;
    this.debuggerDetected = false;
    this.binaryHash = null;
    this.#computeBinaryHash();
  }

  #computeBinaryHash() {
    try {
      const exePath = process.execPath;
      const data = fs.readFileSync(exePath);
      const hash = createHash('sha256').update(data).digest();
      this.binaryHash = new Uint8Array(hash);
    } catch (e) {
      // Browser / restricted environment → tamper detection disabled
      this.binaryHash = null;
    }
  }

  /**
   * Détection multi-couche très robuste (Node.js + timing)
   */
  detectDebugger() {
    let detected = false;

    // === Variables d'environnement suspectes ===
    const suspiciousVars = [
      'GDB', 'LLDB', 'DEBUG', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES',
      'MallocStackLogging', 'MallocStackLoggingNoCompact', 'RUST_BACKTRACE',
      'NODE_DEBUG', 'NODE_OPTIONS', 'INSPECT', 'DEBUGGER'
    ];

    for (const v of suspiciousVars) {
      if (process.env[v]) {
        console.warn(`[AntiDebug] Variable d'environnement suspecte: ${v}`);
        detected = true;
      }
    }

    // === Node.js inspect mode ===
    if (process.execArgv.some(arg => arg.includes('inspect') || arg.includes('debug'))) {
      console.warn('[AntiDebug] Node.js --inspect / debug mode détecté');
      detected = true;
    }

    // === Test de timing anti-VM / anti-debugger ===
    const start = Date.now();
    let sum = 0;
    for (let i = 0; i < 2_500_000; i++) {
      sum += i;
    }
    if (Date.now() - start > 1300) {
      console.warn('[AntiDebug] Exécution anormalement lente (possible VM/debugger)');
      detected = true;
    }

    // === Plateformes spécifiques (notes) ===
    const platform = process.platform;
    if (platform === 'linux' || platform === 'darwin') {
      // ptrace / DYLD déjà couvert par les variables d'env + timing
    }

    this.debuggerDetected = detected;
    return detected;
  }

  selfTerminateIfDebugged() {
    if (this.detectDebugger()) {
      console.error('[AntiDebug] === DEBUGGER DÉTECTÉ === Auto-destruction');
      process.exit(1);
    }
  }

  /**
   * Détection de tamper avec SHA-256 (Node.js seulement)
   */
  detectTamper() {
    if (!this.binaryHash) return false;

    try {
      const exePath = process.execPath;
      const data = fs.readFileSync(exePath);
      const hash = createHash('sha256').update(data).digest();
      const currentHash = new Uint8Array(hash);

      if (!this.#arraysEqual(currentHash, this.binaryHash)) {
        this.tamperDetected = true;
        console.error('[AntiDebug] TAMPER DÉTECTÉ ! Le binaire a été modifié.');
        return true;
      }
    } catch (e) {
      // ignore
    }
    return false;
  }

  /**
   * Active la protection maximale (hardened mode)
   */
  enableHardenedMode() {
    console.info('[AntiDebug] Mode ULTRA DURCI v5.2 activé');

    this.detectTamper();
    this.selfTerminateIfDebugged();

    if (this.tamperDetected || this.debuggerDetected) {
      console.error('[AntiDebug] Protection déclenchée → Arrêt immédiat du processus');
      process.exit(1);
    }
  }

  #arraysEqual(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }
}

export default AntiDebug;