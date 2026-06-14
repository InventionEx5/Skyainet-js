// packages/node/src/web_search.js
// =====================================================
// WebSearch — Recherche Web pour Thevie (Learn + Web)
// Backend de la commande `web_search` consommée par thevie.html.
// Pluggable : connecteur HTTP (SearxNG / Brave / DuckDuckGo) avec
// dégradation gracieuse hors-ligne.
// SkyAInet × Thevie × Nikola T369
// =====================================================

"use strict";

// ─────────────────────────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 6000;
const MAX_RESULTS_CAP     = 10;

// Base de connaissances locale — sert de secours pertinent hors-ligne
// pour les requêtes liées à l'écosystème SkyAInet. Chaque entrée associe
// des mots-clés à un résultat structuré {title, snippet}.
const LOCAL_KNOWLEDGE = [
  {
    keys: ['node', 'validator', 'validateur', 'nœud', 'noeud', 'pouw', 'consensus', 'stake'],
    title: 'SkyAInet — Nœuds & Consensus PoUW',
    snippet: 'Les nœuds SkyAInet utilisent le consensus Proof-of-Useful-Work (PoUW). ' +
             'Un nœud Validator exige un stake minimum de 8 000 SKY. Thevie orchestre ' +
             'le déploiement et la gestion de la flotte de nœuds automatiquement.',
  },
  {
    keys: ['thevie', 'learn', 'apprentissage', 'dream', 'rêve', 'lora', 'zipmemory', 'wisdom', 'sagesse'],
    title: 'Thevie — IA Souveraine Auto-Évolutive',
    snippet: 'Thevie est une IA souveraine de SkyAInet combinant Dream Cycles, ' +
             'fine-tuning LoRA et ZipMemory pour une mémoire compressée. Son score ' +
             'de sagesse augmente via l\'injection de leçons et les cycles de rêve.',
  },
  {
    keys: ['sky', 'token', 'jeton', 'stake', 'staking', 'governance', 'gouvernance', 'reward', 'récompense'],
    title: 'SKY — Jeton Natif de SkyAInet',
    snippet: 'SKY est le jeton natif de SkyAInet. Le staking permet de participer au ' +
             'consensus et au vote de gouvernance. Les nœuds gagnent des SKY en ' +
             'fournissant du calcul utile au réseau.',
  },
  {
    keys: ['encrypt', 'chiffrement', 'quantum', 'quantique', 'dilithium', 'romant369', 'hyper256', 'security', 'sécurité'],
    title: 'SkyAInet — Sécurité Post-Quantique',
    snippet: 'SkyAInet emploie le chiffrement RomanT369 Hyper256 et les signatures ' +
             'post-quantiques Dilithium5. Les communications inter-nœuds et le stockage ' +
             'décentralisé sont protégés de bout en bout.',
  },
  {
    keys: ['gpu', 'compute', 'calcul', 'marketplace', 'marché', 'rent', 'location'],
    title: 'SkyAInet — Marketplace de Calcul',
    snippet: 'Le marketplace SkyAInet permet de louer et proposer du calcul GPU/CPU ' +
             'entre pairs. Les offres sont réglées en SKY, avec réputation et ' +
             'attestation des nœuds participants.',
  },
];

// ─────────────────────────────────────────────────────────────────
// WEBSEARCH
// ─────────────────────────────────────────────────────────────────

/**
 * Service de recherche web pour Thevie.
 *
 * Stratégie en cascade :
 *   1. Si un provider HTTP est configuré ET joignable → résultats réels.
 *   2. Sinon → base de connaissances locale SkyAInet (si la requête matche).
 *   3. Sinon → tableau vide (le frontend bascule sur simulatedWebContext()).
 *
 * @example
 *   const ws = new WebSearch({ provider: 'searxng', endpoint: 'http://localhost:8888' });
 *   const results = await ws.search('SkyAInet validator', 3);
 *   // → [{ title, snippet, url }]
 */
export class WebSearch {
  #provider;
  #endpoint;
  #apiKey;
  #timeout;
  #useLocalFallback;
  #totalSearches = 0;
  #lastError = null;

  /**
   * @param {object} [opts]
   * @param {string|null} [opts.provider]  'searxng' | 'brave' | null (désactivé)
   * @param {string|null} [opts.endpoint]  URL de base du provider
   * @param {string|null} [opts.apiKey]    Clé API si requise (Brave, etc.)
   * @param {number}      [opts.timeout]   Timeout réseau en ms
   * @param {boolean}     [opts.useLocalFallback] Activer la base locale (def: true)
   */
  constructor(opts = {}) {
    this.#provider         = opts.provider ?? null;
    this.#endpoint         = opts.endpoint ?? null;
    this.#apiKey           = opts.apiKey   ?? null;
    this.#timeout          = opts.timeout  ?? DEFAULT_TIMEOUT_MS;
    this.#useLocalFallback = opts.useLocalFallback !== false;
  }

  /**
   * Recherche principale — contrat consommé par thevie.html.
   * @param {string} query
   * @param {number} [maxResults=3]
   * @returns {Promise<Array<{title:string, snippet:string, url?:string}>>}
   */
  async search(query, maxResults = 3) {
    const q = String(query ?? '').trim();
    if (!q) return [];

    const limit = Math.max(1, Math.min(Number(maxResults) || 3, MAX_RESULTS_CAP));
    this.#totalSearches++;

    // 1. Provider HTTP réel
    if (this.#provider && this.#endpoint) {
      try {
        const live = await this.#searchProvider(q, limit);
        if (live.length) return live.slice(0, limit);
      } catch (e) {
        this.#lastError = e.message;
        // On poursuit vers le fallback local
      }
    }

    // 2. Base de connaissances locale
    if (this.#useLocalFallback) {
      const local = this.#searchLocal(q, limit);
      if (local.length) return local;
    }

    // 3. Aucun résultat → le frontend utilisera simulatedWebContext()
    return [];
  }

  // ─── Provider HTTP ──────────────────────────────────────────────

  async #searchProvider(query, limit) {
    switch (this.#provider) {
      case 'searxng': return this.#searchSearxng(query, limit);
      case 'brave':   return this.#searchBrave(query, limit);
      default:        return [];
    }
  }

  /**
   * SearxNG — métamoteur auto-hébergeable, format JSON.
   * GET {endpoint}/search?q=...&format=json
   */
  async #searchSearxng(query, limit) {
    const url = `${this.#endpoint.replace(/\/$/, '')}/search` +
                `?q=${encodeURIComponent(query)}&format=json`;
    const data = await this.#fetchJson(url);
    const items = Array.isArray(data?.results) ? data.results : [];
    return items.slice(0, limit).map(r => ({
      title  : r.title   ?? '(sans titre)',
      snippet: r.content ?? r.snippet ?? '',
      url    : r.url     ?? '',
    }));
  }

  /**
   * Brave Search API — nécessite une clé (header X-Subscription-Token).
   * GET https://api.search.brave.com/res/v1/web/search?q=...
   */
  async #searchBrave(query, limit) {
    const base = this.#endpoint?.replace(/\/$/, '') ||
                 'https://api.search.brave.com/res/v1/web/search';
    const url  = `${base}?q=${encodeURIComponent(query)}&count=${limit}`;
    const data = await this.#fetchJson(url, {
      headers: this.#apiKey ? { 'X-Subscription-Token': this.#apiKey } : {},
    });
    const items = data?.web?.results ?? [];
    return items.slice(0, limit).map(r => ({
      title  : r.title       ?? '(sans titre)',
      snippet: r.description  ?? '',
      url    : r.url          ?? '',
    }));
  }

  // ─── Fetch avec timeout ─────────────────────────────────────────

  async #fetchJson(url, opts = {}) {
    if (typeof fetch !== 'function') {
      throw new Error('fetch indisponible dans cet environnement');
    }
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.#timeout);
    try {
      const res = await fetch(url, {
        signal : ctrl.signal,
        headers: { 'Accept': 'application/json', ...(opts.headers ?? {}) },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  // ─── Base de connaissances locale ───────────────────────────────

  #searchLocal(query, limit) {
    const lower = query.toLowerCase();
    const scored = [];
    for (const entry of LOCAL_KNOWLEDGE) {
      let score = 0;
      for (const k of entry.keys) {
        if (lower.includes(k)) score++;
      }
      if (score > 0) scored.push({ score, entry });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map(({ entry }) => ({
      title  : entry.title,
      snippet: entry.snippet,
      url    : 'local://skyainet-knowledge',
    }));
  }

  // ─── Diagnostics ────────────────────────────────────────────────

  getStats() {
    return {
      provider      : this.#provider ?? 'none',
      endpoint      : this.#endpoint ?? null,
      totalSearches : this.#totalSearches,
      localFallback : this.#useLocalFallback,
      lastError     : this.#lastError,
    };
  }

  /** Active/reconfigure un provider à chaud. */
  configure({ provider, endpoint, apiKey, timeout } = {}) {
    if (provider !== undefined) this.#provider = provider;
    if (endpoint !== undefined) this.#endpoint = endpoint;
    if (apiKey   !== undefined) this.#apiKey   = apiKey;
    if (timeout  !== undefined) this.#timeout  = timeout;
    return this;
  }
}

export default WebSearch;
