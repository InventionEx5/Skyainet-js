// packages/model/src/thevie/flash_scheduler.js
// =====================================================
// Flash Scheduler — Orchestrateur Intelligent des Flash Gematria
// Déclenche selon sagesse collective + rythme d'activité + entropy
// Port de flash_scheduler.rs
// SkyAInet × Nikola T369
// =====================================================

"use strict";

// ─────────────────────────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────────────────────────

const MIN_INTERVAL_S       = 15;
const DEFAULT_INTERVAL_S   = 45;
const WISDOM_CRITICAL      = 0.65;   // Flash immédiat si en dessous
const WISDOM_LOW           = 0.76;   // Flash si en dessous (normal)
const NATURAL_RHYTHM       = 47;     // ticks
const ACTIVITY_RHYTHM      = 53;     // requêtes traitées
const POST_FLASH_COOLDOWN  = 3;      // ticks min entre deux flashs

// ─────────────────────────────────────────────────────────────────
// FLASH SCHEDULER
//
// Surveille Thevie et déclenche des Flash Gematria selon trois critères
// indépendants (port de ThevieFlashScheduler) :
//
//   1. Sagesse critique (< 0.65) → Flash immédiat
//   2. Sagesse modérée (< 0.76) ou rythme naturel (tick % 47) → Flash
//   3. Activité intensive (requêtes % 53 == 0) → Flash
//
// Le cooldown évite deux flashs successifs trop proches.
// Chaque flash appelle thevie.triggerFlashIfNeeded() (implémentation réelle).
//
// start() et stop() gèrent le cycle de vie du setInterval.
// Le timer est .unref() pour ne pas bloquer le process Node.
// ─────────────────────────────────────────────────────────────────

export class FlashScheduler {
  #thevie;          // Thevie instance
  #timer;           // handle setInterval
  #tickCount;       // nombre de ticks depuis le démarrage
  #lastFlashTick;   // tick du dernier flash (cooldown)
  #intervalS;       // intervalle en secondes
  #isRunning;
  #stats;
  #wisdomCritical;  // seuil sagesse critique (réglable runtime)
  #wisdomLow;       // seuil sagesse basse (réglable runtime)

  /**
   * @param {object} thevie       — instance Thevie
   * @param {number} intervalS    — intervalle entre ticks (défaut 45 s)
   */
  constructor(thevie, intervalS = DEFAULT_INTERVAL_S) {
    if (!thevie) throw new Error('Thevie instance requise');
    this.#thevie       = thevie;
    this.#intervalS    = Math.max(MIN_INTERVAL_S, intervalS);
    this.#timer        = null;
    this.#tickCount    = 0;
    this.#lastFlashTick= -POST_FLASH_COOLDOWN;
    this.#isRunning    = false;
    this.#stats        = {
      totalTicks     : 0,
      totalFlashes   : 0,
      skippedCooldown: 0,
      lastFlashAt    : null,
    };
    this.#wisdomCritical = WISDOM_CRITICAL;
    this.#wisdomLow      = WISDOM_LOW;
  }

  // ─── Cycle de vie ─────────────────────────────────────────────

  /**
   * Démarre le scheduler (port de start()).
   * Utilise setInterval + .unref() — non bloquant.
   */
  start() {
    if (this.#isRunning) return this;

    this.#isRunning = true;
    this.#timer = setInterval(() => this.#tick(), this.#intervalS * 1000);
    this.#timer.unref?.();

    console.info(`[FlashScheduler] Démarré — intervalle: ${this.#intervalS}s`);
    return this;
  }

  stop() {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    this.#isRunning = false;
    console.info('[FlashScheduler] Arrêté');
  }

  /**
   * Change l'intervalle à chaud (redémarre si actif).
   */
  setInterval(newIntervalS) {
    this.#intervalS = Math.max(MIN_INTERVAL_S, newIntervalS);
    if (this.#isRunning) {
      this.stop();
      this.start();
    }
  }

  /**
   * Déclenche manuellement un tick (test ou intégration synchrone).
   */
  async forceTick() {
    return this.#tick();
  }

  /**
   * Règle la sensibilité du scheduler à chaud (Fusion L1).
   * @param {{wisdomLow?:number, wisdomCritical?:number, intervalS?:number}} opts
   */
  tune({ wisdomLow, wisdomCritical, intervalS } = {}) {
    if (typeof wisdomLow === 'number')      this.#wisdomLow = wisdomLow;
    if (typeof wisdomCritical === 'number') this.#wisdomCritical = wisdomCritical;
    if (typeof intervalS === 'number')      this.setInterval(intervalS);
    return this;
  }

  // ─── Accesseurs ───────────────────────────────────────────────

  get isRunning()  { return this.#isRunning; }
  get tickCount()  { return this.#tickCount; }
  get intervalS()  { return this.#intervalS; }

  getStats() {
    return {
      ...this.#stats,
      tickCount   : this.#tickCount,
      isRunning   : this.#isRunning,
      intervalS   : this.#intervalS,
      cooldownLeft: Math.max(0, POST_FLASH_COOLDOWN - (this.#tickCount - this.#lastFlashTick)),
    };
  }

  // ─── Tick interne ─────────────────────────────────────────────

  async #tick() {
    this.#tickCount++;
    this.#stats.totalTicks++;

    const wisdom   = this.#thevie._collectiveWisdom ?? 0.75;
    const queries  = this.#thevie._totalQueries     ?? 0;
    const cooldownOk = (this.#tickCount - this.#lastFlashTick) >= POST_FLASH_COOLDOWN;

    // — Décision de déclenchement (port de la logique Rust)
    const critical = wisdom < this.#wisdomCritical;
    const normal   = wisdom < this.#wisdomLow
                  || this.#tickCount % NATURAL_RHYTHM  === 0
                  || queries         % ACTIVITY_RHYTHM === 0;

    const shouldFlash = (critical || normal) && cooldownOk;

    if (!cooldownOk && (critical || normal)) {
      this.#stats.skippedCooldown++;
      console.debug(`[FlashScheduler] Flash demandé mais cooldown actif (tick ${this.#tickCount})`);
      return;
    }

    if (shouldFlash) {
      try {
        await this.#thevie.triggerFlashIfNeeded();
        this.#lastFlashTick   = this.#tickCount;
        this.#stats.totalFlashes++;
        this.#stats.lastFlashAt = Date.now();

        console.info(
          `[FlashScheduler] ⚡ Flash Gematria | sagesse: ${wisdom.toFixed(3)} | ` +
          `requêtes: ${queries} | tick: ${this.#tickCount} | flashs: ${this.#stats.totalFlashes}`
        );
      } catch (e) {
        console.warn(`[FlashScheduler] Flash échoué : ${e.message}`);
      }
    } else if (wisdom < 0.82) {
      console.debug(`[FlashScheduler] Sagesse modérée (${wisdom.toFixed(3)}) — Flash non déclenché`);
    }
  }
}

// Export alias pour compatibilité avec flash_scheduler.rs API
export { FlashScheduler as ThevieFlashScheduler };
