// packages/financial/src/trading_mandate.js
/**
 * trading_mandate.js — Mandats de trading autonomes pour SkyAInet × Nikola T369.
 *
 * Un « mandat » est une session de trading autonome confiée à une IA locale,
 * bornée par des OBJECTIFS fixés par l'utilisateur :
 *   • gain cible (take-profit global, %)      → clôture tout & TARGET_MET
 *   • perte max à ne pas dépasser (%)          → clôture tout & STOPPED_OUT
 *   • drawdown max depuis le pic (%)           → clôture tout & STOPPED_OUT
 *   • horizon (nombre de ticks)                → EXPIRED
 *
 * À chaque tick : funding + liquidations vérifiés, puis l'IA (via `generate`)
 * décide BUY / SELL / HOLD sur une paire (round-robin) ; les IA externes
 * conseillères sont consultées d'abord si demandé ; garde-fous vérifiés après.
 *
 * PHASE 2 — comptabilité de marge INTERNE (le desk sert d'oracle de prix) :
 *   • maxLeverage  : effet de levier (1 = spot ; >1 = margin/futures).
 *   • allowShort   : ventes à découvert (positions short).
 *   • funding      : coût de portage par tick sur le notionnel à levier.
 *   • liquidation  : fermeture forcée si le prix atteint le prix de liquidation.
 *   Pour un LONG à levier 1, l'equity est identique au spot (aucune régression).
 *
 * DAEMON SERVEUR : startDaemon() lance un setInterval (dans le process Node) qui
 * tick automatiquement tous les mandats RUNNING — les mandats tournent alors
 * SANS navigateur. stopDaemon()/daemonStatus() pilotent l'état.
 *
 * L'utilisateur garde la main : pause / resume / stop (interruption flatten|hold)
 * / clôture manuelle des positions / remove.
 *
 * Découplé & testable : reçoit un TradingDesk (`desk`, oracle de prix + conseil)
 * et un `generate` injecté. N'importe que node:events.
 */

import { EventEmitter } from 'node:events';

export const MANDATE_STATUS = Object.freeze({
  RUNNING     : 'running',
  PAUSED      : 'paused',
  STOPPED     : 'stopped',
  TARGET_MET  : 'target-met',
  STOPPED_OUT : 'stopped-out',
  EXPIRED     : 'expired',
});

const MAINT_MARGIN_RATIO    = 0.005;   // marge de maintenance (0.5 %)
const FUNDING_RATE_PER_TICK = 0.0002;  // coût de portage par tick (2 bps) sur notionnel à levier
const MAX_LEVERAGE_CAP      = 25;      // plafond dur de levier

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
function roundPx(p) {
  if (!isFinite(p)) return 0;
  const a = Math.abs(p);
  if (a >= 1000) return Math.round(p * 100) / 100;
  if (a >= 1)    return Math.round(p * 10000) / 10000;
  if (a >= 0.01) return Math.round(p * 1e6) / 1e6;
  return Math.round(p * 1e9) / 1e9;
}

export class MandateError extends Error {
  constructor(message, code = 'E_MANDATE') { super(message); this.name = 'MandateError'; this.code = code; }
}

export class MandateEngine extends EventEmitter {
  #desk;        // TradingDesk — oracle de prix (getPairs) + conseil (consultAdvisors)
  #generate;    // async ({prompt, ai, maxTokens}) => string
  #mandates;    // Map<id, mandate>
  #seq;
  #posSeq;
  #rng;
  #daemon;      // { timer, intervalMs, startedAt, ticks } | null
  #daemonBusy;

  constructor({ desk = null, generate = null } = {}) {
    super();
    if (!desk || typeof desk.getPairs !== 'function') {
      throw new MandateError('Un TradingDesk valide est requis (desk)', 'E_DESK');
    }
    this.#desk        = desk;
    this.#generate    = typeof generate === 'function' ? generate : null;
    this.#mandates    = new Map();
    this.#seq         = 0;
    this.#posSeq      = 0;
    this.#rng         = mulberry32(0x4D44 ^ (Date.now() >>> 0));
    this.#daemon      = null;
    this.#daemonBusy  = false;
  }

  // ─── Marché (via le desk) ────────────────────────────────────────────────
  #pairInfo(symbol) { return this.#desk.getPairs().find(p => p.symbol === symbol) || null; }
  #mark(symbol)     { const p = this.#pairInfo(symbol); return p ? p.markPrice : null; }

  #snap(p) {
    const rng = mulberry32(hashStr(p.symbol) ^ (Math.round(p.markPrice * 1e6) >>> 0));
    const trend = (rng() * 2 - 1);
    const vol = p.vol ?? 0.03;
    const rsi = Math.round(clamp(50 + trend * 28 + (rng() - 0.5) * 10, 4, 96));
    return { trend, vol, rsi, momPct: +(trend * vol * 100).toFixed(2) };
  }
  #lean(text) {
    if (!text) return null;
    const t = text.toLowerCase();
    const bull = (t.match(/\b(buy|long|bull|haussier|achat|accumuler|up|acheter)\b/g) || []).length;
    const bear = (t.match(/\b(sell|short|bear|baissier|vente|distribuer|down|vendre|clôture|cloture|exit|sortir)\b/g) || []).length;
    const hold = (t.match(/\b(hold|attend|conserver|neutre|patience|wait)\b/g) || []).length;
    let side = null;
    if (bull > bear && bull >= hold) side = 'buy';
    else if (bear > bull && bear >= hold) side = 'sell';
    else if (hold > 0) side = 'hold';
    const m = t.match(/(\d{1,3})\s*%/);
    const conf = m ? clamp(parseInt(m[1], 10) / 100, 0.1, 0.99) : null;
    if (!side && conf == null) return null;
    return { side, conf };
  }

  // ─── Comptabilité de marge ───────────────────────────────────────────────
  #uPnl(pos, mark) { return (pos.side === 'long' ? (mark - pos.entry) : (pos.entry - mark)) * pos.size; }
  #liqPrice(pos) {
    const inv = 1 / pos.leverage;
    return pos.side === 'long'
      ? pos.entry * (1 - inv + MAINT_MARGIN_RATIO)
      : pos.entry * (1 + inv - MAINT_MARGIN_RATIO);
  }
  #equity(m) {
    let e = m.cash;
    for (const pos of m.positions) { const mk = this.#mark(pos.pair); if (mk != null) e += pos.margin + this.#uPnl(pos, mk); }
    return e;
  }
  #open(m, pair, side, mark) {
    const margin = Math.min(m.capital * (m.perTradePct / 100), m.cash);
    if (!(margin > 1e-9) || !(mark > 0)) return { ok: false, reason: 'Cash insuffisant pour ouvrir' };
    const notional = margin * m.maxLeverage;
    const pos = {
      id: 'pos_' + (++this.#posSeq).toString(36), pair, side,
      size: notional / mark, entry: mark, leverage: m.maxLeverage, margin, openedAt: Date.now(),
    };
    m.cash -= margin;
    m.positions.push(pos);
    return { ok: true, pos };
  }
  #closePos(m, pos, mark) {
    const uPnl = this.#uPnl(pos, mark);
    m.cash += pos.margin + uPnl;
    m.realized += uPnl;
    m.positions = m.positions.filter(x => x !== pos);
    return uPnl;
  }
  // Ajoute une tranche à une position existante (entrée moyennée) — pour DCA/grid.
  #addToPosition(m, pos, addMargin, mark) {
    const addSize = (addMargin * pos.leverage) / mark;
    const newSize = pos.size + addSize;
    pos.entry = (pos.entry * pos.size + mark * addSize) / newSize;
    pos.size = newSize;
    pos.margin += addMargin;
    m.cash -= addMargin;
    return addSize;
  }
  // Ouvre une position, ou ajoute à une position de même paire/côté (moyenne).
  #openOrAdd(m, pair, side, mark) {
    const margin = Math.min(m.capital * (m.perTradePct / 100), m.cash);
    if (!(margin > 1e-9) || !(mark > 0)) return { ok: false, reason: 'Cash insuffisant' };
    const existing = m.positions.find(x => x.pair === pair && x.side === side);
    if (existing) { const addSize = this.#addToPosition(m, existing, margin, mark); return { ok: true, pos: existing, addSize, added: true }; }
    const r = this.#open(m, pair, side, mark);
    return r.ok ? { ok: true, pos: r.pos, addSize: r.pos.size, added: false } : r;
  }
  // Clôture PARTIELLE d'une position (réalise le PnL proportionnel, rend la marge au prorata).
  #reducePosition(m, pos, closeSize, mark) {
    closeSize = Math.min(closeSize, pos.size);
    if (!(closeSize > 0)) return 0;
    const frac = closeSize / pos.size;
    const marginBack = pos.margin * frac;
    const uPnl = (pos.side === 'long' ? (mark - pos.entry) : (pos.entry - mark)) * closeSize;
    m.cash += marginBack + uPnl;
    m.realized += uPnl;
    pos.size -= closeSize;
    pos.margin -= marginBack;
    if (pos.size <= 1e-12) m.positions = m.positions.filter(x => x !== pos);
    return uPnl;
  }
  #flatten(m) {
    for (const pos of [...m.positions]) { const mk = this.#mark(pos.pair); if (mk != null) this.#closePos(m, pos, mk); }
    m.positions = [];
  }
  #applyFunding(m) {
    let total = 0;
    for (const pos of m.positions) {
      if (pos.leverage > 1) { const mk = this.#mark(pos.pair); if (mk != null) { const c = FUNDING_RATE_PER_TICK * pos.size * mk; m.cash -= c; m.realized -= c; total += c; } }
    }
    if (total > 1e-9) this.#logAct(m, '*', 'funding', `Coût de portage ${roundPx(total)} (levier)`, this.#equity(m));
  }
  #checkLiquidations(m) {
    for (const pos of [...m.positions]) {
      const mk = this.#mark(pos.pair); if (mk == null) continue;
      const liq = this.#liqPrice(pos);
      const hit = pos.side === 'long' ? mk <= liq : mk >= liq;
      if (hit) {
        const uPnl = this.#closePos(m, pos, liq);
        this.#logAct(m, pos.pair, 'liquidation', `${pos.side === 'long' ? 'LONG' : 'SHORT'} liquidé @ ${roundPx(liq)} (perte ${roundPx(uPnl)})`, this.#equity(m));
      }
    }
  }

  // ─── Création ────────────────────────────────────────────────────────────
  createMandate(cfg = {}) {
    const capital = Number(cfg.capital);
    if (!isFinite(capital) || capital <= 0) throw new MandateError('Capital invalide', 'E_CAPITAL');
    const pairs = (Array.isArray(cfg.pairs) ? cfg.pairs : []).filter(s => this.#pairInfo(s));
    if (!pairs.length) throw new MandateError('Au moins une paire valide est requise', 'E_PAIRS');

    const o = cfg.objectives || {};
    const objectives = {
      takeProfitPct : clamp(Number(o.takeProfitPct ?? 10), 0.5, 100000),
      maxLossPct    : clamp(Number(o.maxLossPct ?? 15), 0.5, 100),
      maxDrawdownPct: clamp(Number(o.maxDrawdownPct ?? 20), 0.5, 100),
      horizonTicks  : clamp(parseInt(o.horizonTicks ?? 50, 10), 1, 100000),
    };

    // ── Sous-stratégie (ai | dca | grid) ──
    const strategy = ['ai', 'dca', 'grid'].includes(cfg.strategy) ? cfg.strategy : 'ai';
    let usePairs = pairs;
    let strategyParams = {};
    const stratState = { lots: 0, rungs: 0, lastLevel: null };
    if (strategy === 'dca') {
      const sp = cfg.strategyParams || {};
      usePairs = [pairs[0]];                              // DCA opère sur une seule paire
      strategyParams = {
        everyTicks: clamp(parseInt(sp.everyTicks ?? 5, 10), 1, 100000),
        side      : sp.side === 'short' ? 'short' : 'long',
        maxLots   : clamp(parseInt(sp.maxLots ?? 0, 10), 0, 100000),      // 0 = illimité
      };
    } else if (strategy === 'grid') {
      const sp = cfg.strategyParams || {};
      usePairs = [pairs[0]];                              // la grille est propre à une paire
      const lower = Number(sp.lower), upper = Number(sp.upper);
      if (!(lower > 0) || !(upper > lower)) throw new MandateError('Grille : bornes invalides (0 < lower < upper)', 'E_GRID');
      const grids = clamp(parseInt(sp.grids ?? 10, 10), 2, 200);
      strategyParams = { lower, upper, grids, step: (upper - lower) / grids };
    }

    const m = {
      id          : 'mdt_' + (++this.#seq).toString(36) + Math.floor(this.#rng() * 1e4).toString(36),
      capital,
      pairs       : usePairs,
      ai          : cfg.ai || 'thevie',
      advisors    : Array.isArray(cfg.advisors) ? cfg.advisors.filter(Boolean) : [],
      objectives,
      strategy,
      strategyParams,
      stratState,
      maxLeverage : clamp(Number(cfg.maxLeverage ?? 1), 1, MAX_LEVERAGE_CAP),
      allowShort  : !!cfg.allowShort,
      perTradePct : clamp(Number(cfg.perTradePct ?? 25), 1, 100),
      onInterrupt : cfg.onInterrupt === 'hold' ? 'hold' : 'flatten',
      status      : MANDATE_STATUS.RUNNING,
      cash        : capital,
      realized    : 0,
      positions   : [],           // {id, pair, side, size, entry, leverage, margin, openedAt}
      startEquity : capital,
      peakEquity  : capital,
      ticks       : 0,
      createdAt   : Date.now(),
      stoppedAt   : null,
      stopReason  : null,
      log         : [],
    };
    this.#mandates.set(m.id, m);
    const mode = m.maxLeverage > 1 ? `margin ×${m.maxLeverage}` : 'spot';
    const stratLabel = strategy === 'grid' ? `grid [${strategyParams.lower}-${strategyParams.upper}]×${strategyParams.grids}`
                    : strategy === 'dca' ? `DCA/${strategyParams.everyTicks}t` : `IA ${m.ai}`;
    this.#logAct(m, '*', 'create', `Mandat créé — capital ${capital}, ${m.pairs.length} paire(s), ${stratLabel}, ${mode}${m.allowShort ? ' + shorts' : ''}`, capital);
    this.emit('mandate', { type: 'create', id: m.id });
    return this.#view(m);
  }

  #get(id) {
    const m = this.#mandates.get(id);
    if (!m) throw new MandateError(`Mandat inconnu : ${id}`, 'E_NOTFOUND');
    return m;
  }
  #logAct(m, pair, action, detail, equity) {
    m.log.push({ tick: m.ticks, ts: Date.now(), pair, action, detail, equity: +Number(equity ?? this.#equity(m)).toFixed(6) });
    if (m.log.length > 600) m.log.splice(0, m.log.length - 600);
  }

  // ─── Décision IA (best-effort + repli technique) ─────────────────────────
  async #decide(m, symbol) {
    const p = this.#pairInfo(symbol);
    const s = this.#snap(p);

    let advisors = [], advBias = 0;
    if (m.advisors.length && typeof this.#desk.consultAdvisors === 'function') {
      try {
        const c = await this.#desk.consultAdvisors(symbol, m.advisors);
        advisors = c.advisors || [];
        advBias = advisors.reduce((a, n) => a + (n.lean === 'buy' ? 1 : n.lean === 'sell' ? -1 : 0), 0);
      } catch (_) { /* repli silencieux */ }
    }

    let side = null, conf = 0.5, text = null;
    if (this.#generate) {
      const held = m.positions.find(x => x.pair === symbol);
      const eq = this.#equity(m);
      const gain = ((eq - m.startEquity) / m.startEquity) * 100;
      const prompt =
        `Tu es le trader IA ${m.ai} opérant sous mandat autonome (levier ×${m.maxLeverage}${m.allowShort ? ', shorts autorisés' : ', long uniquement'}). ` +
        `Paire ${symbol}, prix ${roundPx(p.markPrice)}, RSI ${s.rsi}, momentum ${s.momPct}%. ` +
        `${held ? `Tu détiens une position ${held.side} de ${held.size} @ ${held.entry}. ` : `Aucune position sur cette paire. `}` +
        `Performance du mandat : ${gain.toFixed(2)}% (objectif +${m.objectives.takeProfitPct}%, perte max ${m.objectives.maxLossPct}%). ` +
        `${advisors.length ? `Biais des conseillers : ${advBias}. ` : ''}` +
        `Décide UNE action — BUY (ouvrir long / clôturer short), SELL (ouvrir short / clôturer long), ou HOLD — avec un % de confiance. Réponds en une phrase.`;
      try {
        const r = await this.#generate({ prompt, ai: m.ai, maxTokens: 120 });
        text = (typeof r === 'string') ? r : (r && r.text) ? r.text : '';
        text = text && text.trim() ? text.trim() : null;
      } catch (_) { text = null; }
      const lean = this.#lean(text);
      if (lean) { if (lean.side) side = lean.side; if (lean.conf != null) conf = lean.conf; }
    }

    if (!side) {
      side = (s.trend + advBias * 0.15) >= 0 ? 'buy' : 'sell';
      conf = clamp(0.5 + 0.3 * Math.abs(s.trend), 0.2, 0.95);
    }
    return { side, conf: +Number(conf).toFixed(2), advisors, advBias, aiUsed: !!text, rationale: text || null };
  }

  // ─── Tick ────────────────────────────────────────────────────────────────
  async runTick(id) {
    const m = this.#get(id);
    if (m.status !== MANDATE_STATUS.RUNNING) return this.#view(m);
    m.ticks++;

    // Portage + liquidations (sur toutes les positions, les prix ayant bougé).
    this.#applyFunding(m);
    this.#checkLiquidations(m);

    try {
      if (m.strategy === 'grid') this.#tickGrid(m);
      else if (m.strategy === 'dca') this.#tickDCA(m);
      else await this.#tickAI(m);
    } catch (e) { this.#logAct(m, '*', 'error', 'tick: ' + e.message); }

    const eq = this.#equity(m);
    if (eq > m.peakEquity) m.peakEquity = eq;
    this.#checkGuardrails(m, eq);
    return this.#view(m);
  }

  // ── Sous-stratégie : IA (comportement historique) ──
  async #tickAI(m) {
    const symbol = m.pairs[(m.ticks - 1) % m.pairs.length];
    const p = this.#pairInfo(symbol);
    if (!p) { this.#logAct(m, symbol, 'skip', 'Paire indisponible'); return; }
    const mark = p.markPrice;

    const dec = await this.#decide(m, symbol);
    const held = m.positions.find(x => x.pair === symbol);
    let action = 'hold', detail = dec.rationale || `Biais ${dec.side} (${Math.round(dec.conf * 100)}%)`;

    if (dec.side === 'buy') {
      if (!held) {
        const r = this.#open(m, symbol, 'long', mark);
        if (r.ok) { action = 'long'; detail = `Ouvre LONG ${roundPx(r.pos.size)} @ ${roundPx(mark)} ×${m.maxLeverage}` + (dec.rationale ? ` — ${dec.rationale}` : ''); }
        else { action = 'hold'; detail = r.reason; }
      } else if (held.side === 'short') {
        const pnl = this.#closePos(m, held, mark); action = 'close'; detail = `Clôture SHORT @ ${roundPx(mark)} (PnL ${roundPx(pnl)})`;
      } else { action = 'hold'; detail = 'Déjà long — maintien'; }
    } else if (dec.side === 'sell') {
      if (held && held.side === 'long') {
        const pnl = this.#closePos(m, held, mark); action = 'close'; detail = `Clôture LONG @ ${roundPx(mark)} (PnL ${roundPx(pnl)})`;
      } else if (!held && m.allowShort) {
        const r = this.#open(m, symbol, 'short', mark);
        if (r.ok) { action = 'short'; detail = `Ouvre SHORT ${roundPx(r.pos.size)} @ ${roundPx(mark)} ×${m.maxLeverage}` + (dec.rationale ? ` — ${dec.rationale}` : ''); }
        else { action = 'hold'; detail = r.reason; }
      } else if (!held && !m.allowShort) { action = 'hold'; detail = 'Short désactivé — rien à ouvrir'; }
      else { action = 'hold'; detail = 'Déjà short — maintien'; }
    }
    this.#logAct(m, symbol, action, detail, this.#equity(m));
  }

  // ── Sous-stratégie : DCA (accumulation programmée, sans IA) ──
  #tickDCA(m) {
    const symbol = m.pairs[0];
    const p = this.#pairInfo(symbol);
    if (!p) { this.#logAct(m, symbol, 'skip', 'Paire indisponible'); return; }
    const mark = p.markPrice;
    const sp = m.strategyParams, st = m.stratState;
    const side = sp.side === 'short' ? 'short' : 'long';
    const due = ((m.ticks - 1) % sp.everyTicks) === 0;
    if (!due) { this.#logAct(m, symbol, 'hold', 'DCA — en attente du prochain lot', this.#equity(m)); return; }
    if (sp.maxLots > 0 && st.lots >= sp.maxLots) { this.#logAct(m, symbol, 'hold', `DCA — ${st.lots}/${sp.maxLots} lots atteints`, this.#equity(m)); return; }
    const r = this.#openOrAdd(m, symbol, side, mark);
    if (r.ok) { st.lots++; this.#logAct(m, symbol, side, `DCA lot #${st.lots} ${r.added ? 'ajouté' : 'ouvert'} ${roundPx(r.addSize)} @ ${roundPx(mark)}`, this.#equity(m)); }
    else this.#logAct(m, symbol, 'hold', r.reason, this.#equity(m));
  }

  // ── Sous-stratégie : Grid (achat sous le prix / vente au-dessus, dans une plage) ──
  #tickGrid(m) {
    const symbol = m.pairs[0];
    const p = this.#pairInfo(symbol);
    if (!p) { this.#logAct(m, symbol, 'skip', 'Paire indisponible'); return; }
    const mark = p.markPrice;
    const g = m.strategyParams, st = m.stratState;
    if (mark < g.lower || mark > g.upper) { this.#logAct(m, symbol, 'hold', `Hors grille (${roundPx(mark)} hors [${g.lower}, ${g.upper}])`, this.#equity(m)); return; }
    const level = Math.max(0, Math.min(g.grids - 1, Math.floor((mark - g.lower) / g.step)));
    if (st.lastLevel === null) { st.lastLevel = level; this.#logAct(m, symbol, 'hold', `Grille armée au niveau ${level}/${g.grids}`, this.#equity(m)); return; }

    if (level < st.lastLevel) {                        // prix en baisse → acheter les paliers franchis
      const steps = st.lastLevel - level;
      let bought = 0;
      for (let i = 0; i < steps; i++) { const r = this.#openOrAdd(m, symbol, 'long', mark); if (r.ok) bought++; else break; }
      st.rungs = (st.rungs || 0) + bought;
      st.lastLevel = level;
      this.#logAct(m, symbol, 'long', `Grille : achat ${bought} palier(s) @ ${roundPx(mark)} (niveau ${level})`, this.#equity(m));
    } else if (level > st.lastLevel) {                 // prix en hausse → vendre (clôture partielle)
      const steps = level - st.lastLevel;
      const pos = m.positions.find(x => x.pair === symbol && x.side === 'long');
      let sold = 0, pnl = 0;
      if (pos && (st.rungs || 0) > 0) {
        const sellRungs = Math.min(steps, st.rungs);
        for (let i = 0; i < sellRungs; i++) {
          if (!m.positions.includes(pos) || pos.size <= 1e-12) break;
          const rungsLeft = st.rungs - i;
          pnl += this.#reducePosition(m, pos, pos.size / rungsLeft, mark);
          sold++;
        }
        st.rungs -= sold;
      }
      st.lastLevel = level;
      this.#logAct(m, symbol, sold ? 'close' : 'hold', sold ? `Grille : vente ${sold} palier(s) @ ${roundPx(mark)} (PnL ${roundPx(pnl)}, niveau ${level})` : `Grille : niveau ${level}`, this.#equity(m));
    } else {
      this.#logAct(m, symbol, 'hold', `Grille stable (niveau ${level})`, this.#equity(m));
    }
  }

  #checkGuardrails(m, equity) {
    const o = m.objectives;
    const gain = ((equity - m.startEquity) / m.startEquity) * 100;
    const dd = m.peakEquity > 0 ? ((m.peakEquity - equity) / m.peakEquity) * 100 : 0;
    if (gain >= o.takeProfitPct)        this.#finish(m, MANDATE_STATUS.TARGET_MET,  `Objectif de gain atteint (+${gain.toFixed(2)}%)`);
    else if (gain <= -o.maxLossPct)     this.#finish(m, MANDATE_STATUS.STOPPED_OUT, `Perte maximale atteinte (${gain.toFixed(2)}%)`);
    else if (dd >= o.maxDrawdownPct)    this.#finish(m, MANDATE_STATUS.STOPPED_OUT, `Drawdown maximal atteint (${dd.toFixed(2)}%)`);
    else if (m.ticks >= o.horizonTicks) this.#finish(m, MANDATE_STATUS.EXPIRED,     `Horizon atteint (${m.ticks} ticks)`);
  }
  #finish(m, status, reason) {
    this.#flatten(m);
    m.status = status; m.stoppedAt = Date.now(); m.stopReason = reason;
    this.#logAct(m, '*', status, reason, this.#equity(m));
    this.emit('mandate', { type: 'finish', id: m.id, status });
  }

  // ─── Contrôles utilisateur ───────────────────────────────────────────────
  pauseMandate(id) {
    const m = this.#get(id);
    if (m.status === MANDATE_STATUS.RUNNING) { m.status = MANDATE_STATUS.PAUSED; this.#logAct(m, '*', 'pause', 'Mandat mis en pause'); this.emit('mandate', { type: 'pause', id }); }
    return this.#view(m);
  }
  resumeMandate(id) {
    const m = this.#get(id);
    if (m.status === MANDATE_STATUS.PAUSED) { m.status = MANDATE_STATUS.RUNNING; this.#logAct(m, '*', 'resume', 'Mandat repris'); this.emit('mandate', { type: 'resume', id }); }
    return this.#view(m);
  }
  /** Interruption utilisateur : applique la politique onInterrupt (flatten|hold). */
  stopMandate(id) {
    const m = this.#get(id);
    if (m.status === MANDATE_STATUS.RUNNING || m.status === MANDATE_STATUS.PAUSED) {
      if (m.onInterrupt === 'flatten') this.#flatten(m);
      m.status = MANDATE_STATUS.STOPPED; m.stoppedAt = Date.now();
      m.stopReason = `Interrompu par l'utilisateur (${m.onInterrupt === 'flatten' ? 'positions soldées' : 'positions conservées'})`;
      this.#logAct(m, '*', 'stop', m.stopReason, this.#equity(m));
      this.emit('mandate', { type: 'stop', id });
    }
    return this.#view(m);
  }
  /** Clôture manuelle de toutes les positions (utile pour un mandat 'hold' arrêté). */
  flattenMandate(id) {
    const m = this.#get(id);
    if (m.positions.length) { this.#flatten(m); this.#logAct(m, '*', 'close-all', 'Positions soldées manuellement', this.#equity(m)); }
    return this.#view(m);
  }
  removeMandate(id) {
    const m = this.#get(id);
    if (m.status === MANDATE_STATUS.RUNNING || m.status === MANDATE_STATUS.PAUSED) {
      throw new MandateError('Interrompez le mandat avant de le supprimer', 'E_ACTIVE');
    }
    this.#mandates.delete(id);
    this.emit('mandate', { type: 'remove', id });
    return { removed: true, id };
  }

  // ─── Daemon serveur ──────────────────────────────────────────────────────
  async #daemonTick() {
    if (this.#daemonBusy) return;
    this.#daemonBusy = true;
    try {
      const running = [...this.#mandates.values()].filter(m => m.status === MANDATE_STATUS.RUNNING);
      for (const m of running) { try { await this.runTick(m.id); } catch (_) { /* isolé */ } }
      if (this.#daemon) this.#daemon.ticks++;
    } finally { this.#daemonBusy = false; }
  }
  startDaemon(opts = {}) {
    const intervalMs = clamp(parseInt((opts && opts.intervalMs) ?? 3000, 10) || 3000, 250, 3600000);
    if (this.#daemon && this.#daemon.timer) return this.daemonStatus();
    const timer = setInterval(() => { this.#daemonTick(); }, intervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref();   // ne maintient pas le process en vie à lui seul
    this.#daemon = { timer, intervalMs, startedAt: Date.now(), ticks: 0 };
    this.emit('daemon', { type: 'start', intervalMs });
    return this.daemonStatus();
  }
  stopDaemon() {
    const was = !!this.#daemon;
    if (this.#daemon && this.#daemon.timer) clearInterval(this.#daemon.timer);
    this.#daemon = null;
    if (was) this.emit('daemon', { type: 'stop' });
    return this.daemonStatus();
  }
  daemonStatus() {
    const all = [...this.#mandates.values()];
    return {
      running        : !!this.#daemon,
      intervalMs     : this.#daemon ? this.#daemon.intervalMs : null,
      startedAt      : this.#daemon ? this.#daemon.startedAt : null,
      ticks          : this.#daemon ? this.#daemon.ticks : 0,
      activeMandates : all.filter(m => m.status === MANDATE_STATUS.RUNNING || m.status === MANDATE_STATUS.PAUSED).length,
      tickingMandates: all.filter(m => m.status === MANDATE_STATUS.RUNNING).length,
    };
  }

  // ─── Vues ────────────────────────────────────────────────────────────────
  #view(m) {
    const equity = this.#equity(m);
    const gainPct = +(((equity - m.startEquity) / m.startEquity) * 100).toFixed(2);
    const ddRaw = m.peakEquity > 0 ? ((m.peakEquity - equity) / m.peakEquity) * 100 : 0;
    return {
      id: m.id, status: m.status, ai: m.ai, advisors: m.advisors, pairs: m.pairs,
      capital: m.capital,
      cash: +m.cash.toFixed(6), realized: +m.realized.toFixed(6),
      equity: +equity.toFixed(6), gainPct, drawdownPct: +(ddRaw < 0 ? 0 : ddRaw).toFixed(2),
      objectives: m.objectives, onInterrupt: m.onInterrupt, perTradePct: m.perTradePct,
      maxLeverage: m.maxLeverage, allowShort: m.allowShort,
      strategy: m.strategy, strategyParams: m.strategyParams,
      stratState: { lots: m.stratState.lots, rungs: m.stratState.rungs, level: m.stratState.lastLevel },
      ticks: m.ticks,
      positions: m.positions.map(p => {
        const mk = this.#mark(p.pair) || 0;
        const uPnl = this.#uPnl(p, mk);
        return {
          pair: p.pair, side: p.side, size: +Number(p.size).toFixed(8), entry: p.entry,
          leverage: p.leverage, margin: +p.margin.toFixed(6),
          uPnl: +uPnl.toFixed(6), liq: +this.#liqPrice(p).toFixed(8), value: +(p.margin + uPnl).toFixed(6),
        };
      }),
      openCount: m.positions.length,
      createdAt: m.createdAt, stoppedAt: m.stoppedAt, stopReason: m.stopReason,
    };
  }
  getMandate(id) { return this.#view(this.#get(id)); }
  listMandates() { return [...this.#mandates.values()].map(m => this.#view(m)).sort((a, b) => b.createdAt - a.createdAt); }
  getMandateLog(id, limit = 60) { const m = this.#get(id); return m.log.slice(-clamp(limit | 0, 1, 600)).reverse(); }
  stats() {
    const all = [...this.#mandates.values()];
    const active = all.filter(m => m.status === MANDATE_STATUS.RUNNING || m.status === MANDATE_STATUS.PAUSED).length;
    return { total: all.length, active, realizedPnl: +all.reduce((a, m) => a + m.realized, 0).toFixed(6), daemon: !!this.#daemon };
  }
}

export default MandateEngine;