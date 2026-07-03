// packages/financial/src/uniswap_v4.js
/**
 * uniswap_v4.js — Bridge d'exécution ON-CHAIN Uniswap V4 pour SkyAInet × Nikola T369.
 *
 * Encodeur de calldata RÉEL pour swaps Uniswap V4 via l'Universal Router,
 * avec approbations Permit2 et quotes V4Quoter. AGNOSTIQUE DU SIGNEUR : ce
 * module ne signe ni n'envoie jamais de transaction ; il produit uniquement
 * des `{to, data, value}` exacts, prêts pour n'importe quel signeur — wallet
 * navigateur (window.ethereum) aujourd'hui, signeur serveur demain.
 *
 * Architecture V4 (rappel) :
 *   • PoolManager SINGLETON : tous les pools vivent dans un seul contrat ;
 *     un pool = PoolKey {currency0, currency1, fee, tickSpacing, hooks}
 *     (devises triées par adresse ; address(0) = ETH natif, pas de WETH).
 *   • Le PoolManager n'est pas appelable directement (flash accounting /
 *     unlock) : on passe par l'UNIVERSAL ROUTER — execute(commands, inputs,
 *     deadline) ; un swap = commande V4_SWAP (0x10) dont l'input encode une
 *     séquence d'actions : SWAP_EXACT_IN_SINGLE → SETTLE_ALL → TAKE_ALL.
 *     La sortie du swap arrive au wallet APPELANT (pas de recipient à fournir).
 *   • PERMIT2 : le routeur tire les fonds via Permit2 → approbation à deux
 *     étages : ERC20.approve(Permit2, ∞) une fois par jeton, puis
 *     Permit2.approve(jeton, router, montant uint160, expiration uint48).
 *     Entrée en ETH natif : aucune approbation, value = montant.
 *   • QUOTE : V4Quoter.quoteExactInputSingle en eth_call (simulation par
 *     revert interne, l'appel externe RETOURNE (amountOut, gasEstimate)).
 *
 * Sélecteurs 4-octets DÉRIVÉS par keccak-256 (implémentation vérifiée sur
 * vecteurs connus + contre-vérifiée sur les sélecteurs ERC-20 du repo) :
 *   execute(bytes,bytes[],uint256)                          = 0x3593564c
 *   approve(address,address,uint160,uint48)   [Permit2]     = 0x87517c45
 *   allowance(address,address,address)        [Permit2]     = 0x927da105
 *   quoteExactInputSingle(((address,address,uint24,int24,
 *     address),bool,uint128,bytes))           [V4Quoter]    = 0xaa9d21cb
 *
 * Ce que ce module NE fait PAS (par conception / sécurité) :
 *   • aucune clé, aucune signature, aucune connexion réseau ;
 *   • AUCUNE adresse par défaut (router, Permit2, quoter, jetons) : l'opérateur
 *     DOIT tout configurer, et valider sur TESTNET d'abord ;
 *   • les octets de commande/action (V4_SWAP=0x10, 0x06/0x0c/0x0f) proviennent
 *     d'universal-router / v4-periphery : à confirmer contre la version
 *     déployée lors de la preuve testnet ;
 *   • pools avec hooks ≠ 0x0 : comportement altérable par le hook — cibler
 *     d'abord des pools vanilla (hooks = adresse zéro).
 *
 * N'importe rien. Utilise BigInt (entiers 256 bits exacts).
 */

export const SELECTOR = Object.freeze({
  // Universal Router
  execute:               '0x3593564c', // execute(bytes,bytes[],uint256)                                   [payable]
  // Permit2 (AllowanceTransfer)
  permit2Approve:        '0x87517c45', // approve(address token, address spender, uint160 amount, uint48 expiration)
  permit2Allowance:      '0x927da105', // allowance(address user, address token, address spender)
  // V4Quoter
  quoteExactInputSingle: '0xaa9d21cb', // quoteExactInputSingle(QuoteExactSingleParams) → (uint256,uint256)
  // ERC-20
  approve:               '0x095ea7b3',
  allowance:             '0xdd62ed3e',
  balanceOf:             '0x70a08231',
  decimals:              '0x313ce567',
});

export const COMMANDS = Object.freeze({ V4_SWAP: 0x10 });
export const ACTIONS  = Object.freeze({ SWAP_EXACT_IN_SINGLE: 0x06, SETTLE_ALL: 0x0c, TAKE_ALL: 0x0f });

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const MAX_UINT256  = (1n << 256n) - 1n;
const MAX_UINT160  = (1n << 160n) - 1n;
const MAX_UINT128  = (1n << 128n) - 1n;
const MAX_UINT48   = (1n << 48n) - 1n;

export class V4Error extends Error {
  constructor(message, code = 'E_V4') { super(message); this.name = 'V4Error'; this.code = code; }
}

// ─── Primitives ABI ──────────────────────────────────────────────────────────
function strip0x(h) { return typeof h === 'string' && h.startsWith('0x') ? h.slice(2) : (h || ''); }
function isAddress(a) { return typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a); }
function clampInt(x, lo, hi) { x = Math.trunc(Number(x)); if (!Number.isFinite(x)) x = lo; return Math.max(lo, Math.min(hi, x)); }
const hx = (s) => '0x' + s;

function wordAddr(a) {
  if (!isAddress(a)) throw new V4Error('Adresse invalide : ' + a, 'E_ADDR');
  return strip0x(a).toLowerCase().padStart(64, '0');
}
function wordUint(v, max = MAX_UINT256, label = 'uint') {
  let b; try { b = BigInt(v); } catch (_) { throw new V4Error(`${label} invalide : ${v}`, 'E_UINT'); }
  if (b < 0n) throw new V4Error(`${label} négatif`, 'E_UINT');
  if (b > max) throw new V4Error(`overflow ${label}`, 'E_UINT');
  return b.toString(16).padStart(64, '0');
}
// int24 en complément à deux sur 256 bits (tickSpacing peut en théorie être signé).
function wordInt24(v) {
  let b; try { b = BigInt(v); } catch (_) { throw new V4Error('int24 invalide : ' + v, 'E_INT'); }
  const lim = 1n << 23n;
  if (b >= lim || b < -lim) throw new V4Error('overflow int24', 'E_INT');
  if (b < 0n) b = (1n << 256n) + b;
  return b.toString(16).padStart(64, '0');
}
function padRight(hexNo0x) { const rem = hexNo0x.length % 64; return rem ? hexNo0x + '0'.repeat(64 - rem) : hexNo0x; }
// bytes ABI : mot de longueur + données alignées 32.
function encBytes(dataHexNo0x) { return wordUint(dataHexNo0x.length / 2) + padRight(dataHexNo0x); }
// bytes[] ABI : longueur, offsets relatifs (après le mot de longueur), éléments.
function encBytesArray(itemsHexNo0x) {
  const enc = itemsHexNo0x.map(encBytes);
  let heads = '', off = itemsHexNo0x.length * 32;
  for (const e of enc) { heads += wordUint(off); off += e.length / 2; }
  return wordUint(itemsHexNo0x.length) + heads + enc.join('');
}

// ─── Décodeurs (retours d'eth_call) ──────────────────────────────────────────
function words(retHex) { const h = strip0x(retHex); const out = []; for (let i = 0; i + 64 <= h.length; i += 64) out.push(BigInt('0x' + h.slice(i, i + 64))); return out; }
function decUint(retHex) { const w = words(retHex); return w.length ? w[w.length - 1] : 0n; }

// ─── Unités (décimales par jeton) ────────────────────────────────────────────
export function parseUnits(amount, decimals) {
  const s = String(amount).trim();
  if (s === '' || s === '.' || !/^\d*\.?\d*$/.test(s)) throw new V4Error('Montant invalide : ' + amount, 'E_AMOUNT');
  const d = clampInt(decimals, 0, 36);
  let [whole, frac = ''] = s.split('.');
  whole = whole || '0';
  frac = (frac + '0'.repeat(d)).slice(0, d);
  return BigInt(whole) * (10n ** BigInt(d)) + BigInt(frac || '0');
}
export function formatUnits(value, decimals) {
  let b = BigInt(value); const neg = b < 0n; if (neg) b = -b;
  const d = clampInt(decimals, 0, 36);
  const base = 10n ** BigInt(d);
  const whole = b / base, frac = b % base;
  const fs = frac.toString().padStart(d, '0').replace(/0+$/, '');
  return (neg ? '-' : '') + whole.toString() + (fs ? '.' + fs : '');
}

// ─── Bridge V4 ───────────────────────────────────────────────────────────────
export class UniswapV4Bridge {
  #cfg;
  constructor(cfg = null) { this.#cfg = this.#normalize(cfg || {}); }

  #normalize(c) {
    const tokens = {};
    if (c.tokens && typeof c.tokens === 'object') {
      for (const [sym, v] of Object.entries(c.tokens)) {
        if (!v) continue;
        tokens[sym] = {
          address : isAddress(v.address) ? v.address.toLowerCase() : null,
          decimals: Number.isInteger(v.decimals) ? clampInt(v.decimals, 0, 36) : 18,
        };
      }
    }
    const pools = {};
    if (c.pools && typeof c.pools === 'object') {
      for (const [pair, v] of Object.entries(c.pools)) {
        if (!v) continue;
        pools[pair] = {
          fee        : Number.isFinite(Number(v.fee)) ? clampInt(v.fee, 0, 16777215) : null,           // uint24
          tickSpacing: Number.isFinite(Number(v.tickSpacing)) ? clampInt(v.tickSpacing, -8388608, 8388607) : null, // int24
          hooks      : isAddress(v.hooks) ? v.hooks.toLowerCase() : ZERO_ADDRESS,
        };
      }
    }
    return {
      chainId        : c.chainId != null && Number.isFinite(Number(c.chainId)) ? Number(c.chainId) : null,
      universalRouter: isAddress(c.universalRouter) ? c.universalRouter.toLowerCase() : null,
      permit2        : isAddress(c.permit2) ? c.permit2.toLowerCase() : null,
      quoter         : isAddress(c.quoter) ? c.quoter.toLowerCase() : null,
      tokens, pools,
      slippageBps    : Number.isFinite(Number(c.slippageBps)) ? clampInt(c.slippageBps, 1, 5000) : 50,
      deadlineSec    : Number.isFinite(Number(c.deadlineSec)) ? clampInt(c.deadlineSec, 30, 86400) : 1200,
      permit2ExpSec  : Number.isFinite(Number(c.permit2ExpSec)) ? clampInt(c.permit2ExpSec, 300, 31536000) : 2592000, // 30 j
    };
  }

  configure(cfg = {}) {
    this.#cfg = this.#normalize({
      ...this.#cfg, ...cfg,
      tokens: { ...this.#cfg.tokens, ...(cfg.tokens || {}) },
      pools : { ...this.#cfg.pools,  ...(cfg.pools  || {}) },
    });
    return this.getConfig();
  }
  getConfig() { return JSON.parse(JSON.stringify(this.#cfg)); }
  isReady() { return !!(this.#cfg.chainId != null && this.#cfg.universalRouter && this.#cfg.permit2 && this.#cfg.quoter); }
  /** Aide à la configuration : ce qui manque pour opérer une paire donnée. */
  missingFor(pair) {
    const parts = String(pair || '').split('/');
    const tokensMissing = [];
    for (const sym of parts) { const t = this.#cfg.tokens[sym]; if (!t || !t.address) tokensMissing.push(sym); }
    return {
      chainId: this.#cfg.chainId == null, universalRouter: !this.#cfg.universalRouter,
      permit2: !this.#cfg.permit2, quoter: !this.#cfg.quoter,
      tokens: tokensMissing, pool: !this.#cfg.pools[pair],
    };
  }

  #token(sym) { const t = this.#cfg.tokens[sym]; if (!t || !t.address) throw new V4Error('Jeton non configuré : ' + sym, 'E_TOKEN'); return t; }
  #pool(pair) {
    const p = this.#cfg.pools[pair];
    if (!p || p.fee == null || p.tickSpacing == null) throw new V4Error('Pool non configuré (fee/tickSpacing) : ' + pair, 'E_POOL');
    return p;
  }
  /** Résout paire+côté → devises, PoolKey (triée) et sens zeroForOne. */
  #resolve(pair, side) {
    const [base, quote] = String(pair || '').split('/');
    if (!base || !quote) throw new V4Error('Paire invalide : ' + pair, 'E_PAIR');
    if (side !== 'buy' && side !== 'sell') throw new V4Error('Côté invalide (buy|sell) : ' + side, 'E_SIDE');
    const tin  = this.#token(side === 'buy' ? quote : base);
    const tout = this.#token(side === 'buy' ? base : quote);
    const pool = this.#pool(pair);
    const [c0, c1] = BigInt(tin.address) < BigInt(tout.address) ? [tin.address, tout.address] : [tout.address, tin.address];
    const zeroForOne = tin.address === c0;
    const poolKey = { currency0: c0, currency1: c1, fee: pool.fee, tickSpacing: pool.tickSpacing, hooks: pool.hooks };
    return { base, quote, tin, tout, poolKey, zeroForOne, nativeIn: tin.address === ZERO_ADDRESS, nativeOut: tout.address === ZERO_ADDRESS };
  }
  #poolKeyWords(k) { return wordAddr(k.currency0) + wordAddr(k.currency1) + wordUint(k.fee, 16777215n, 'fee(uint24)') + wordInt24(k.tickSpacing) + wordAddr(k.hooks); }

  // ── Quote (V4Quoter.quoteExactInputSingle, via eth_call) ──
  quoteCalldata(pair, side, amountInHuman) {
    if (!this.isReady()) throw new V4Error('Bridge non configuré (chainId/router/permit2/quoter)', 'E_CONFIG');
    const r = this.#resolve(pair, side);
    const amtIn = parseUnits(amountInHuman, r.tin.decimals);
    if (amtIn > MAX_UINT128) throw new V4Error('amountIn dépasse uint128', 'E_UINT');
    // abi.encode(QuoteExactSingleParams{poolKey, zeroForOne, exactAmount, hookData:0x})
    const body = wordUint(0x20)
      + this.#poolKeyWords(r.poolKey)
      + wordUint(r.zeroForOne ? 1 : 0)
      + wordUint(amtIn, MAX_UINT128, 'exactAmount(uint128)')
      + wordUint(0x100)      // offset hookData (8 mots × 32) relatif au début du tuple
      + wordUint(0);         // hookData vide
    return {
      to: this.#cfg.quoter, data: hx(strip0x(SELECTOR.quoteExactInputSingle) + body),
      poolKey: r.poolKey, zeroForOne: r.zeroForOne,
      amountInWei: amtIn.toString(), inDecimals: r.tin.decimals, outDecimals: r.tout.decimals,
    };
  }
  /** Décode le retour du quoter : (uint256 amountOut, uint256 gasEstimate). */
  decodeQuote(retHex, outDecimals = null) {
    const w = words(retHex);
    const amountOut = w[0] ?? 0n, gasEstimate = w[1] ?? 0n;
    return {
      amountOutWei: amountOut.toString(), gasEstimate: gasEstimate.toString(),
      amountOutHuman: outDecimals != null ? formatUnits(amountOut, outDecimals) : null,
    };
  }

  // ── ERC-20 & Permit2 (approbation à deux étages) ──
  /** allowance(owner → Permit2) sur le jeton. */
  erc20AllowanceCalldata(sym, owner) {
    const t = this.#token(sym);
    if (!this.#cfg.permit2) throw new V4Error('Permit2 non configuré', 'E_CONFIG');
    if (t.address === ZERO_ADDRESS) return null;
    return { to: t.address, data: hx(strip0x(SELECTOR.allowance) + wordAddr(owner) + wordAddr(this.#cfg.permit2)) };
  }
  /** approve(Permit2, ∞) sur le jeton — une fois par jeton. */
  erc20ApprovePermit2Calldata(sym) {
    const t = this.#token(sym);
    if (!this.#cfg.permit2) throw new V4Error('Permit2 non configuré', 'E_CONFIG');
    if (t.address === ZERO_ADDRESS) return null;
    return { to: t.address, data: hx(strip0x(SELECTOR.approve) + wordAddr(this.#cfg.permit2) + wordUint(MAX_UINT256)) };
  }
  /** Permit2.allowance(user, token, router) → (uint160 amount, uint48 expiration, uint48 nonce). */
  permit2AllowanceCalldata(sym, owner) {
    const t = this.#token(sym);
    if (!this.#cfg.permit2 || !this.#cfg.universalRouter) throw new V4Error('Permit2/router non configuré', 'E_CONFIG');
    if (t.address === ZERO_ADDRESS) return null;
    return { to: this.#cfg.permit2, data: hx(strip0x(SELECTOR.permit2Allowance) + wordAddr(owner) + wordAddr(t.address) + wordAddr(this.#cfg.universalRouter)) };
  }
  decodePermit2Allowance(retHex) {
    const w = words(retHex);
    return { amount: (w[0] ?? 0n).toString(), expiration: Number(w[1] ?? 0n), nonce: Number(w[2] ?? 0n) };
  }
  /** Permit2.approve(token, router, amount uint160, expiration uint48). */
  permit2ApproveCalldata(sym, amount = 'max', expirationSec = null) {
    const t = this.#token(sym);
    if (!this.#cfg.permit2 || !this.#cfg.universalRouter) throw new V4Error('Permit2/router non configuré', 'E_CONFIG');
    if (t.address === ZERO_ADDRESS) return null;
    const amt = amount === 'max' ? MAX_UINT160 : BigInt(amount);
    const exp = BigInt(Math.floor(Date.now() / 1000) + clampInt(expirationSec ?? this.#cfg.permit2ExpSec, 300, 31536000));
    return {
      to: this.#cfg.permit2,
      data: hx(strip0x(SELECTOR.permit2Approve) + wordAddr(t.address) + wordAddr(this.#cfg.universalRouter)
        + wordUint(amt, MAX_UINT160, 'amount(uint160)') + wordUint(exp, MAX_UINT48, 'expiration(uint48)')),
      expiration: Number(exp),
    };
  }

  balanceOfCalldata(sym, owner) { const t = this.#token(sym); if (t.address === ZERO_ADDRESS) return null; return { to: t.address, data: hx(strip0x(SELECTOR.balanceOf) + wordAddr(owner)) }; }
  decodeUint(retHex, decimals = null) { const v = decUint(retHex); return { value: v.toString(), human: decimals != null ? formatUnits(v, decimals) : null }; }

  // ── Plan de swap complet (Universal Router : V4_SWAP → SWAP/SETTLE/TAKE) ──
  swapPlan(spec = {}) {
    if (!this.isReady()) throw new V4Error('Bridge non configuré (chainId/router/permit2/quoter)', 'E_CONFIG');
    const { pair, side, amountInHuman, quotedOutWei = null, slippageBps = null, deadlineSec = null } = spec;
    const r = this.#resolve(pair, side);
    const amtIn = parseUnits(amountInHuman, r.tin.decimals);
    if (!(amtIn > 0n)) throw new V4Error('Montant nul', 'E_AMOUNT');
    if (amtIn > MAX_UINT128) throw new V4Error('amountIn dépasse uint128', 'E_UINT');
    const bps = BigInt(clampInt(slippageBps ?? this.#cfg.slippageBps, 1, 5000));
    const outMin = quotedOutWei != null ? (BigInt(quotedOutWei) * (10000n - bps)) / 10000n : 0n;
    if (outMin > MAX_UINT128) throw new V4Error('amountOutMinimum dépasse uint128', 'E_UINT');
    const deadline = Math.floor(Date.now() / 1000) + clampInt(deadlineSec ?? this.#cfg.deadlineSec, 30, 86400);

    // params[0] = abi.encode(ExactInputSingleParams{poolKey, zeroForOne, amountIn, amountOutMinimum, hookData:0x})
    const p0 = wordUint(0x20)
      + this.#poolKeyWords(r.poolKey)
      + wordUint(r.zeroForOne ? 1 : 0)
      + wordUint(amtIn, MAX_UINT128, 'amountIn(uint128)')
      + wordUint(outMin, MAX_UINT128, 'amountOutMinimum(uint128)')
      + wordUint(0x120)      // offset hookData (9 mots × 32) relatif au début du tuple
      + wordUint(0);         // hookData vide
    // params[1] = SETTLE_ALL(devise d'entrée, montant max = amountIn exact)
    const p1 = wordAddr(r.tin.address) + wordUint(amtIn);
    // params[2] = TAKE_ALL(devise de sortie, minimum = amountOutMinimum)
    const p2 = wordAddr(r.tout.address) + wordUint(outMin);
    const actionsHex = [ACTIONS.SWAP_EXACT_IN_SINGLE, ACTIONS.SETTLE_ALL, ACTIONS.TAKE_ALL]
      .map(a => a.toString(16).padStart(2, '0')).join('');
    // input V4_SWAP = abi.encode(bytes actions, bytes[] params)
    const encActions = encBytes(actionsHex);
    const v4Input = wordUint(0x40) + wordUint(0x40 + encActions.length / 2) + encActions + encBytesArray([p0, p1, p2]);
    // execute(bytes commands, bytes[] inputs, uint256 deadline)
    const commandsHex = COMMANDS.V4_SWAP.toString(16).padStart(2, '0');
    const encCommands = encBytes(commandsHex);
    const body = wordUint(0x60) + wordUint(0x60 + encCommands.length / 2) + wordUint(deadline)
      + encCommands + encBytesArray([v4Input]);

    return {
      chainId: this.#cfg.chainId, universalRouter: this.#cfg.universalRouter,
      poolKey: r.poolKey, zeroForOne: r.zeroForOne,
      tokenInSym: side === 'buy' ? r.quote : r.base, tokenInDecimals: r.tin.decimals, tokenOutDecimals: r.tout.decimals,
      amountInWei: amtIn.toString(), amountOutMinWei: outMin.toString(),
      amountOutMinHuman: outMin > 0n ? formatUnits(outMin, r.tout.decimals) : '0',
      slippageBps: Number(bps), deadline, nativeIn: r.nativeIn, nativeOut: r.nativeOut,
      swap: { to: this.#cfg.universalRouter, data: hx(strip0x(SELECTOR.execute) + body), value: r.nativeIn ? '0x' + amtIn.toString(16) : '0x0' },
      // Vérifications à faire par le signeur (eth_call) — null si entrée native.
      checks: r.nativeIn ? null : {
        erc20Allowance : this.erc20AllowanceCalldata(side === 'buy' ? r.quote : r.base, ZERO_ADDRESS /* owner à substituer */),
        permit2Allowance: null, // fourni par ownerChecks(owner) pour éviter une adresse fictive ici
      },
      note: 'La sortie du swap arrive au wallet appelant ; utiliser ownerChecks(pair, side, owner) pour les calldatas d\u2019allowance.',
    };
  }
  /** Calldatas de vérification/approbation pour un owner donné (entrée non-native). */
  ownerChecks(pair, side, owner) {
    const r = this.#resolve(pair, side);
    if (r.nativeIn) return { nativeIn: true };
    const sym = side === 'buy' ? r.quote : r.base;
    return {
      nativeIn: false, tokenInSym: sym,
      erc20Allowance  : this.erc20AllowanceCalldata(sym, owner),
      erc20Approve    : this.erc20ApprovePermit2Calldata(sym),
      permit2Allowance: this.permit2AllowanceCalldata(sym, owner),
      permit2Approve  : this.permit2ApproveCalldata(sym),
    };
  }
}

export default UniswapV4Bridge;
