// packages/secure/src/defense/anti_debug.js
// =====================================================
// Anti-Debug & Anti-Tamper — Hardened Edition
// SkyAInet × Nikola T369
// =====================================================

"use strict";

import fs               from 'fs';
import { createHash, timingSafeEqual } from 'crypto';
import process          from 'process';

// ─────────────────────────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────────────────────────

// Variables d'environnement indiquant un debugger ou un hooking
const SUSPICIOUS_ENV_VARS = [
  'GDB', 'LLDB', 'DEBUG', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES',
  'MallocStackLogging', 'MallocStackLoggingNoCompact', 'RUST_BACKTRACE',
  'NODE_DEBUG', 'NODE_OPTIONS', 'INSPECT', 'DEBUGGER',
];

// Arguments Node.js indiquant le mode inspect
const INSPECT_ARGS = ['--inspect', '--inspect-brk', '--debug', '--debug-brk'];

// Seuil de timing : au-delà → environnement VM / debugger suspect
const TIMING_THRESHOLD_MS = 1_300;
const TIMING_ITERATIONS   = 2_500_000;

// ─────────────────────────────────────────────────────────────────
// ANTI-DEBUG
//
// Détection multi-couche :
//   1. Variables d'environnement suspectes (GDB, LD_PRELOAD, etc.)
//   2. Arguments Node.js --inspect / --debug
//   3. Timing anti-VM : boucle 2.5M itérations — trop lente sous debugger
//   4. Tamper detection SHA-256 du binaire Node.js (hash comparé
//      en constant-time via crypto.timingSafeEqual)
//
// La clé du tamper : le hash est calculé au constructeur (référence)
// puis recomparé à chaque appel detectTamper(). Si le binaire change
// entre les deux → tamper confirmé.
// ─────────────────────────────────────────────────────────────────

export class AntiDebug {
  #binaryHash;      // Uint8Array(32) | null — hash de référence du binaire
  #detected;        // { debugger: boolean, tamper: boolean }

  constructor() {
    this.#detected = { debugger: false, tamper: false };
    this.#binaryHash = this.#computeBinaryHash();
  }

  // ─── Détection debugger ───────────────────────────────────────

  /**
   * Détection multi-couche. Retourne true si un debugger est suspecté.
   * Non destructif — n'arrête pas le processus.
   */
  detectDebugger() {
    let detected = false;

    // 1. Variables d'environnement
    for (const v of SUSPICIOUS_ENV_VARS) {
      if (process.env[v]) {
        console.warn(`[AntiDebug] Variable suspecte: ${v}`);
        detected = true;
      }
    }

    // 2. Arguments Node.js
    const execArgv = process.execArgv ?? [];
    if (execArgv.some(arg => INSPECT_ARGS.some(ia => arg.startsWith(ia)))) {
      console.warn('[AntiDebug] Mode --inspect / --debug détecté');
      detected = true;
    }

    // 3. Timing anti-VM / anti-debugger
    // Un debugger ralentit drastiquement la JIT — le seuil de 1.3 s
    // est calibré pour une boucle 2.5M sur CPU moderne.
    const t0 = Date.now();
    let sum = 0;
    for (let i = 0; i < TIMING_ITERATIONS; i++) sum += i;
    void sum;   // éviter l'optimisation dead-code par le moteur JS

    const elapsed = Date.now() - t0;
    if (elapsed > TIMING_THRESHOLD_MS) {
      console.warn(`[AntiDebug] Timing anormal : ${elapsed} ms (seuil: ${TIMING_THRESHOLD_MS} ms)`);
      detected = true;
    }

    this.#detected.debugger = this.#detected.debugger || detected;
    return detected;
  }

  /** Arrête le processus si un debugger est détecté. */
  selfTerminateIfDebugged() {
    if (this.detectDebugger()) {
      console.error('[AntiDebug] Debugger détecté → arrêt immédiat');
      process.exit(1);
    }
  }

  // ─── Détection tamper ─────────────────────────────────────────

  /**
   * Compare le hash SHA-256 actuel du binaire Node.js avec
   * le hash de référence calculé au constructeur.
   * Utilise timingSafeEqual (constant-time) pour éviter les
   * timing attacks sur la comparaison.
   *
   * @returns {boolean} true si tamper détecté
   */
  detectTamper() {
    if (!this.#binaryHash) return false;  // Environnement sans accès FS

    const current = this.#computeBinaryHash();
    if (!current) return false;

    const tampered = !timingSafeEqual(
      Buffer.from(this.#binaryHash),
      Buffer.from(current)
    );

    if (tampered) {
      this.#detected.tamper = true;
      console.error('[AntiDebug] TAMPER DÉTECTÉ — binaire modifié');
    }

    return tampered;
  }

  // ─── Mode durci ───────────────────────────────────────────────

  /**
   * Active la protection maximale.
   * Arrête le processus si debugger OU tamper est détecté.
   */
  enableHardenedMode() {
    console.info('[AntiDebug] Mode durci activé');

    const tampered  = this.detectTamper();
    const debugged  = this.detectDebugger();

    if (tampered || debugged) {
      console.error('[AntiDebug] Protection déclenchée → arrêt du processus');
      process.exit(1);
    }
  }

  // ─── Accesseurs ───────────────────────────────────────────────

  get tamperDetected()   { return this.#detected.tamper; }
  get debuggerDetected() { return this.#detected.debugger; }

  isCompromised() {
    return this.#detected.tamper || this.#detected.debugger;
  }

  stats() {
    return {
      tamperDetected  : this.#detected.tamper,
      debuggerDetected: this.#detected.debugger,
      binaryHashKnown : this.#binaryHash !== null,
      platform        : process.platform,
    };
  }

  // ─── Privés ───────────────────────────────────────────────────

  /**
   * Calcule le SHA-256 du binaire Node.js en cours.
   * Retourne null si l'accès au système de fichiers est restreint.
   */
  #computeBinaryHash() {
    try {
      const data = fs.readFileSync(process.execPath);
      const hash = createHash('sha256').update(data).digest();
      return new Uint8Array(hash);
    } catch {
      return null;
    }
  }
}

export default AntiDebug;
