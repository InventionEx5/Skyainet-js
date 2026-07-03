// packages/financial/src/trading_desk.js
/**
 * trading_desk.js — Pupitre de trading par paires pour SkyAInet × Nikola T369.
 *
 * Deux modes :
 *   • Solo (Oracle)  — une IA (locale ou externe) prédit le marché et propose
 *                      TROIS signaux distincts ; l'utilisateur en choisit un et
 *                      le transforme en ordre.
 *   • Auto (Délégué) — une IA locale décide et place l'ordre ; les IA externes
 *                      servent de conseillers/consultants consultés AVANT toute
 *                      action.
 *
 * Le moteur de signaux/ordres est 100 % déterministe et autonome (aucune
 * dépendance réseau ni cryptographique) : il fonctionne hors-ligne avec un
 * repli technique robuste. L'accès IA est INJECTÉ via `generate` afin de rester
 * découplé du moteur d'inférence et testable.
 *
 *   const desk = new TradingDesk({ generate: ({prompt, ai, maxTokens}) => '...' });
 *
 * `generate` doit renvoyer (ou résoudre) une chaîne de texte. S'il est absent
 * ou échoue, le pupitre retombe sur son modèle technique.
 */

import { EventEmitter } from 'node:events';

// ─── Modèle de marché (synthétique, déterministe) ──────────────────────────
// Paires amorcées par défaut. markPrice = prix de référence ; l'opérateur (ou
// le frontend via setMarkPrice) peut pousser un prix réel issu d'un oracle.
const DEFAULT_PAIRS = [
  { symbol: 'SKY/USDC', base: 'SKY', quote: 'USDC', markPrice: 0.0500,  vol: 0.045 },
  { symbol: 'BTC/USDC', base: 'BTC', quote: 'USDC', markPrice: 64000,   vol: 0.022 },
  { symbol: 'ETH/USDC', base: 'ETH', quote: 'USDC', markPrice: 3200,    vol: 0.028 },
  { symbol: 'SKY/ETH',  base: 'SKY', quote: 'ETH',  markPrice: 0.0000156, vol: 0.050 },
];

const ORDER_STATUS = Object.freeze({
  OPEN     : 'open',      // ordre limite au repos (non exécuté)
  FILLED   : 'filled',    // position ouverte (market exécuté)
  CLOSED   : 'closed',    // position clôturée (PnL réalisé)
  CANCELLED: 'cancelled', // ordre limite annulé
});

// PRNG déterministe (mulberry32) — pour des données synthétiques reproductibles.
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
// Arrondi adaptatif selon l'ordre de grandeur du prix.
function roundPx(p) {
  if (!isFinite(p) || p <= 0) return 0;
  if (p >= 1000) return Math.round(p * 100) / 100;
  if (p >= 1)    return Math.round(p * 10000) / 10000;
  if (p >= 0.01) return Math.round(p * 1e6) / 1e6;
  return Math.round(p * 1e9) / 1e9;
}
function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

export class TradingError extends Error {
  constructor(message, code = 'E_TRADING') { super(message); this.name = 'TradingError'; this.code = code; }
}

export class TradingDesk extends EventEmitter {
  #pairs;        // Map<symbol, pair>
  #orders;       // Map<id, order>
  #history;      // Array<order>  (clos/annulés, plus récent en tête)
  #generate;     // async ({prompt, ai, maxTokens}) => string
  #seq;          // compteur d'ordres
  #rng;          // PRNG

  constructor({ generate = null, pairs = null, seed = 0x7369 } = {}) {
    super();
    this.#generate = typeof generate === 'function' ? generate : null;
    this.#orders   = new Map();
    this.#history  = [];
    this.#seq      = 0;
    this.#rng      = mulberry32(0x5147 ^ (seed >>> 0));
    this.#pairs    = new Map();
    for (const p of (pairs || DEFAULT_PAIRS)) {
      this.#pairs.set(p.symbol, {
        symbol: p.symbol, base: p.base, quote: p.quote,
        markPrice: p.markPrice, vol: p.vol ?? 0.03,
        dayOpen: p.markPrice,            // pour le % 24 h
      });
    }
  }

  // ─── Paires & prix ───────────────────────────────────────────────────────
  getPairs() {
    return [...this.#pairs.values()].map(p => ({
      symbol     : p.symbol,
      base       : p.base,
      quote      : p.quote,
      markPrice  : roundPx(p.markPrice),
      dayChangePct: p.dayOpen ? +(((p.markPrice - p.dayOpen) / p.dayOpen) * 100).toFixed(2) : 0,
      vol        : p.vol,
    }));
  }

  #pair(symbol) {
    const p = this.#pairs.get(symbol);
    if (!p) throw new TradingError(`Paire inconnue : ${symbol}`, 'E_PAIR');
    return p;
  }

  /** Pousse un prix de référence réel (ex. depuis un price feed on-chain). */
  setMarkPrice(symbol, price) {
    const p = this.#pair(symbol);
    const px = Number(price);
    if (!isFinite(px) || px <= 0) throw new TradingError('Prix invalide', 'E_PRICE');
    p.markPrice = px;
    this.emit('price', { symbol, markPrice: px });
    return { symbol, markPrice: roundPx(px) };
  }

  /** Bougies OHLC synthétiques (déterministes) pour le graphique. */
  getCandles(symbol, n = 48) {
    const p = this.#pair(symbol);
    n = clamp(n | 0, 8, 200);
    const rng = mulberry32(hashStr(symbol) ^ 0x9E3779B1);
    const out = [];
    let price = p.markPrice * (1 - p.vol * 0.5);   // départ légèrement sous le mark
    for (let i = 0; i < n; i++) {
      const drift = (rng() - 0.48) * p.vol * price;
      const o = price;
      const c = Math.max(1e-12, price + drift);
      const hi = Math.max(o, c) * (1 + rng() * p.vol * 0.4);
      const lo = Math.min(o, c) * (1 - rng() * p.vol * 0.4);
      out.push({ t: i, o: roundPx(o), h: roundPx(hi), l: roundPx(lo), c: roundPx(c) });
      price = c;
    }
    // Recale la dernière clôture sur le markPrice courant.
    if (out.length) out[out.length - 1].c = roundPx(p.markPrice);
    return out;
  }

  // ─── Lecture du marché (indicateurs synthétiques déterministes) ──────────
  #snapshot(p) {
    const rng = mulberry32(hashStr(p.symbol) ^ (Math.round(p.markPrice * 1e6) >>> 0));
    const trend = (rng() * 2 - 1);                 // [-1,1] biais directionnel
    const rsi   = Math.round(clamp(50 + trend * 28 + (rng() - 0.5) * 10, 4, 96));
    const momPct = +(trend * p.vol * 100).toFixed(2);
    return { markPrice: p.markPrice, vol: p.vol, trend, rsi, momPct };
  }

  // ─── Appel IA tolérant (renvoie texte ou null) ───────────────────────────
  async #ask(prompt, ai, maxTokens = 220) {
    if (!this.#generate) return null;
    try {
      const r = await this.#generate({ prompt, ai, maxTokens });
      const text = (typeof r === 'string') ? r : (r && r.text) ? r.text : '';
      return text && text.trim() ? text.trim() : null;
    } catch (_) { return null; }
  }
  // Déduit un penchant directionnel + confiance d'un texte libre d'IA.
  #lean(text) {
    if (!text) return null;
    const t = text.toLowerCase();
    const bull = (t.match(/\b(buy|long|bull|haussier|achat|accumuler|up)\b/g) || []).length;
    const bear = (t.match(/\b(sell|short|bear|baissier|vente|distribuer|down)\b/g) || []).length;
    let side = null;
    if (bull > bear) side = 'buy';
    else if (bear > bull) side = 'sell';
    const m = t.match(/(\d{1,3})\s*%/);
    const conf = m ? clamp(parseInt(m[1], 10) / 100, 0.1, 0.99) : null;
    if (!side && conf == null) return null;
    return { side, conf };
  }

  // ─── ORACLE : 3 signaux ──────────────────────────────────────────────────
  /**
   * Génère TROIS signaux distincts (momentum / retour-à-la-moyenne / cassure).
   * Une IA (locale ou externe) est consultée pour pondérer la confiance et
   * fournir une note ; à défaut, modèle technique pur.
   */
  async oracleSignals(symbol, ai = 't369') {
    const p   = this.#pair(symbol);
    const s   = this.#snapshot(p);
    const P   = p.markPrice, V = p.vol, up = s.trend >= 0;
    const dir = up ? 1 : -1;

    const mk = (archetype, side, entry, target, stop, baseConf, rationale) => ({
      id        : 'sig_' + Math.floor(this.#rng() * 1e9).toString(36),
      pair      : symbol,
      archetype, side,
      entry     : roundPx(entry),
      target    : roundPx(target),
      stop      : roundPx(stop),
      rewardRisk: +(Math.abs(target - entry) / Math.max(1e-12, Math.abs(entry - stop))).toFixed(2),
      confidence: clamp(baseConf, 0.2, 0.95),
      horizon   : archetype === 'Breakout' ? 'court' : (archetype === 'Mean-reversion' ? 'intraday' : 'swing'),
      rationale,
      oracle    : ai,
    });

    const signals = [
      // 1) Momentum — suit la tendance.
      mk('Momentum', up ? 'buy' : 'sell',
         P,
         up ? P * (1 + 1.6 * V) : P * (1 - 1.6 * V),
         up ? P * (1 - 0.8 * V) : P * (1 + 0.8 * V),
         0.50 + 0.30 * Math.abs(s.trend),
         `Tendance ${up ? 'haussière' : 'baissière'} (RSI ${s.rsi}, momentum ${s.momPct}%). On suit le flux dominant.`),
      // 2) Mean-reversion — fade le mouvement.
      mk('Mean-reversion', up ? 'sell' : 'buy',
         P,
         up ? P * (1 - 1.2 * V) : P * (1 + 1.2 * V),
         up ? P * (1 + 0.9 * V) : P * (1 - 0.9 * V),
         0.42 + 0.28 * Math.abs(s.trend),
         `Extension ${up ? 'haute' : 'basse'} (RSI ${s.rsi}). Pari de retour vers la moyenne.`),
      // 3) Breakout — cassure du niveau.
      mk('Breakout', up ? 'buy' : 'sell',
         P * (1 + dir * 0.30 * V),
         P * (1 + dir * 2.2 * V),
         P * (1 - dir * 0.5 * V),
         0.40 + 0.30 * Math.abs(s.trend),
         `Compression près d'un niveau ; déclenche sur cassure ${up ? 'haussière' : 'baissière'} confirmée.`),
    ];

    // Enrichissement IA (best-effort) : penchant + confiance + note.
    const prompt =
      `Tu es un oracle de trading. Paire ${symbol}, prix ${roundPx(P)}, RSI ${s.rsi}, ` +
      `momentum ${s.momPct}%. Donne en UNE phrase ton biais (buy/sell/neutre), un % de confiance, ` +
      `et un risque clé. Sois bref.`;
    const text = await this.#ask(prompt, ai, 160);
    const lean = this.#lean(text);
    if (lean) {
      for (const sig of signals) {
        if (lean.side && sig.side === lean.side) sig.confidence = clamp(sig.confidence + 0.10, 0.2, 0.96);
        else if (lean.side)                      sig.confidence = clamp(sig.confidence - 0.08, 0.15, 0.96);
        sig.confidence = +sig.confidence.toFixed(2);
      }
    } else {
      for (const sig of signals) sig.confidence = +sig.confidence.toFixed(2);
    }
    return {
      pair      : symbol,
      markPrice : roundPx(P),
      oracle    : ai,
      aiNote    : text || null,
      aiUsed    : !!text,
      rsi       : s.rsi,
      momentumPct: s.momPct,
      signals,
    };
  }

  // ─── Consultation des conseillers externes ───────────────────────────────
  /** Chaque IA conseillère rend une note brève + un penchant. */
  async consultAdvisors(symbol, advisors = []) {
    const p = this.#pair(symbol), s = this.#snapshot(p);
    const list = Array.isArray(advisors) ? advisors.filter(Boolean) : [];
    const notes = [];
    for (const advisor of list) {
      const prompt =
        `En tant que conseiller ${advisor}, analyse ${symbol} (prix ${roundPx(p.markPrice)}, ` +
        `RSI ${s.rsi}, momentum ${s.momPct}%). Donne un avis bref (1 phrase) et un biais buy/sell/neutre.`;
      const text = await this.#ask(prompt, advisor, 140);
      const lean = this.#lean(text);
      notes.push({
        advisor,
        lean : lean?.side ?? (s.trend >= 0 ? 'buy' : 'sell'),
        note : text || `Lecture technique : RSI ${s.rsi}, momentum ${s.momPct}% → biais ${s.trend >= 0 ? 'haussier' : 'baissier'} modéré.`,
        aiUsed: !!text,
      });
    }
    return { pair: symbol, advisors: notes };
  }

  // ─── AUTO : une IA locale décide (après consultation externe) ─────────────
  /**
   * @param {string} symbol
   * @param {string} traderAi               — IA locale décisionnaire
   * @param {object} opts
   *   @param {string[]} opts.advisors       — IA externes consultées d'abord
   *   @param {number}   opts.sizeBase        — taille en token de base
   *   @param {number}   [opts.riskPct=1.5]   — distance du stop en %
   */
  async autoTrade(symbol, traderAi = 'thevie', opts = {}) {
    const p = this.#pair(symbol), s = this.#snapshot(p);
    const sizeBase = Number(opts.sizeBase);
    if (!isFinite(sizeBase) || sizeBase <= 0) throw new TradingError('Taille invalide', 'E_SIZE');
    const riskPct = clamp(Number(opts.riskPct ?? 1.5), 0.2, 20) / 100;

    // 1) Consultation des conseillers externes.
    const consult = await this.consultAdvisors(symbol, opts.advisors || []);
    const advBias = consult.advisors.reduce((a, n) => a + (n.lean === 'buy' ? 1 : n.lean === 'sell' ? -1 : 0), 0);

    // 2) Décision de l'IA locale (best-effort) puis repli technique.
    const adviceTxt = consult.advisors.map(n => `${n.advisor}: ${n.note}`).join(' | ') || '(aucun conseiller)';
    const prompt =
      `Tu es le trader IA ${traderAi}. Paire ${symbol}, prix ${roundPx(p.markPrice)}, RSI ${s.rsi}, ` +
      `momentum ${s.momPct}%. Avis des conseillers: ${adviceTxt}. ` +
      `Décide: BUY ou SELL, et un niveau de confiance %. Réponds en une phrase.`;
    const text = await this.#ask(prompt, traderAi, 180);
    const lean = this.#lean(text);

    // Fusion : décision IA si dispo, sinon tendance + biais conseillers.
    let side = lean?.side
      ?? ((s.trend + advBias * 0.15) >= 0 ? 'buy' : 'sell');
    const confidence = +clamp(lean?.conf ?? (0.5 + 0.3 * Math.abs(s.trend)), 0.2, 0.95).toFixed(2);

    const P = p.markPrice, buy = side === 'buy';
    const tp = roundPx(buy ? P * (1 + 2 * riskPct) : P * (1 - 2 * riskPct));
    const sl = roundPx(buy ? P * (1 - riskPct)     : P * (1 + riskPct));

    // 3) Placement de l'ordre (market exécuté au mark).
    const order = this.placeOrder({
      pair: symbol, side, type: 'market', size: sizeBase,
      tp, sl, source: `auto:${traderAi}`,
      note: `Auto ${traderAi}${(opts.advisors || []).length ? ' · conseillé par ' + (opts.advisors || []).join(', ') : ''}`,
    });

    return {
      pair      : symbol,
      decision  : { side, confidence, tp, sl, sizeBase, trader: traderAi, aiUsed: !!text, rationale: text || `Décision technique (RSI ${s.rsi}, momentum ${s.momPct}%, biais conseillers ${advBias})` },
      advisors  : consult.advisors,
      order,
    };
  }

  // ─── Ordres ──────────────────────────────────────────────────────────────
  #mk(order) { return { ...order }; }   // copie défensive

  placeOrder({ pair, side, type = 'market', size, price = null, tp = null, sl = null, source = 'manual', note = '' } = {}) {
    const p = this.#pair(pair);
    if (side !== 'buy' && side !== 'sell') throw new TradingError('Côté invalide (buy/sell)', 'E_SIDE');
    const sz = Number(size);
    if (!isFinite(sz) || sz <= 0) throw new TradingError('Taille invalide', 'E_SIZE');
    if (type !== 'market' && type !== 'limit') throw new TradingError('Type invalide (market/limit)', 'E_TYPE');

    const isMarket = type === 'market';
    const fillPrice = isMarket ? p.markPrice : null;
    const limitPrice = isMarket ? null : Number(price);
    if (!isMarket && (!isFinite(limitPrice) || limitPrice <= 0)) throw new TradingError('Prix limite invalide', 'E_PRICE');

    const order = {
      id        : 'ord_' + (++this.#seq).toString(36) + Math.floor(this.#rng() * 1e4).toString(36),
      pair, side, type,
      size      : sz,
      price     : isMarket ? roundPx(fillPrice) : roundPx(limitPrice),
      fillPrice : isMarket ? roundPx(fillPrice) : null,
      tp        : tp != null ? roundPx(Number(tp)) : null,
      sl        : sl != null ? roundPx(Number(sl)) : null,
      status    : isMarket ? ORDER_STATUS.FILLED : ORDER_STATUS.OPEN,
      source,
      note      : note || '',
      pnl       : null,
      openedAt  : Date.now(),
      closedAt  : null,
    };
    this.#orders.set(order.id, order);
    this.emit('order', { type: isMarket ? 'fill' : 'open', order: this.#mk(order) });
    console.info(`[Trading] ${isMarket ? 'Position' : 'Ordre limite'} ${order.id} | ${side.toUpperCase()} ${sz} ${pair} @ ${order.price}`);
    return this.#mk(order);
  }

  getOpenOrders() {
    return [...this.#orders.values()]
      .filter(o => o.status === ORDER_STATUS.OPEN || o.status === ORDER_STATUS.FILLED)
      .sort((a, b) => b.openedAt - a.openedAt)
      .map(o => this.#mk(o));
  }

  #get(id) {
    const o = this.#orders.get(id);
    if (!o) throw new TradingError(`Ordre inconnu : ${id}`, 'E_ORDER');
    return o;
  }

  /** Annule un ordre limite au repos. */
  cancelOrder(id) {
    const o = this.#get(id);
    if (o.status !== ORDER_STATUS.OPEN) throw new TradingError('Seuls les ordres limites au repos sont annulables', 'E_STATE');
    o.status = ORDER_STATUS.CANCELLED;
    o.closedAt = Date.now();
    this.#orders.delete(id);
    this.#history.unshift(o);
    this.emit('order', { type: 'cancel', order: this.#mk(o) });
    return this.#mk(o);
  }

  /** Clôture une position (market exécuté) → PnL réalisé au mark courant. */
  closeOrder(id) {
    const o = this.#get(id);
    if (o.status !== ORDER_STATUS.FILLED) throw new TradingError('Seules les positions ouvertes sont clôturables', 'E_STATE');
    const p = this.#pair(o.pair);
    const exit = p.markPrice;
    const pnl = (exit - o.fillPrice) * o.size * (o.side === 'buy' ? 1 : -1);
    o.status = ORDER_STATUS.CLOSED;
    o.closedAt = Date.now();
    o.exitPrice = roundPx(exit);
    o.pnl = +pnl.toFixed(o.fillPrice >= 1000 ? 2 : 8);
    o.pnlPct = +(((exit - o.fillPrice) / o.fillPrice) * 100 * (o.side === 'buy' ? 1 : -1)).toFixed(2);
    this.#orders.delete(id);
    this.#history.unshift(o);
    this.emit('order', { type: 'close', order: this.#mk(o) });
    console.info(`[Trading] Clôture ${id} | PnL ${o.pnl} ${p.quote} (${o.pnlPct}%)`);
    return this.#mk(o);
  }

  /** Ajuste TP/SL (positions) ou prix limite (ordres au repos). */
  modifyOrder(id, patch = {}) {
    const o = this.#get(id);
    if (patch.tp != null) o.tp = roundPx(Number(patch.tp));
    if (patch.sl != null) o.sl = roundPx(Number(patch.sl));
    if (patch.price != null && o.status === ORDER_STATUS.OPEN) o.price = roundPx(Number(patch.price));
    this.emit('order', { type: 'modify', order: this.#mk(o) });
    return this.#mk(o);
  }

  getHistory(limit = 100) {
    return this.#history.slice(0, clamp(limit | 0, 1, 500)).map(o => this.#mk(o));
  }

  // ─── Statistiques ────────────────────────────────────────────────────────
  stats() {
    const open = this.getOpenOrders();
    const positions = open.filter(o => o.status === ORDER_STATUS.FILLED).length;
    const resting   = open.filter(o => o.status === ORDER_STATUS.OPEN).length;
    const closed    = this.#history.filter(o => o.status === ORDER_STATUS.CLOSED);
    const realized  = closed.reduce((a, o) => a + (o.pnl || 0), 0);
    const wins      = closed.filter(o => (o.pnl || 0) > 0).length;
    return {
      pairs       : this.#pairs.size,
      openPositions: positions,
      restingOrders: resting,
      closedTrades : closed.length,
      realizedPnl  : +realized.toFixed(4),
      winRate      : closed.length ? +((wins / closed.length) * 100).toFixed(1) : 0,
    };
  }
}

export default TradingDesk;
