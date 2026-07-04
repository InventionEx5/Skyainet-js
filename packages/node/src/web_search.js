// packages/node/src/web_search.js
// =====================================================
// WebSearch — Recherche Web pour Thevie (Learn + Web) + source de seeds Vitality Surf.
// CHAÎNE DE PROVIDERS via APIs OFFICIELLES (aucun scraping des pages de résultats) :
//   Google Custom Search → Brave Search API → DuckDuckGo Instant Answer,
// avec repli local hors-ligne. Le premier provider qui répond gagne.
// Clés via l'environnement : GOOGLE_API_KEY + GOOGLE_CSE_ID, BRAVE_API_KEY,
// SEARXNG_URL (optionnel). DuckDuckGo ne nécessite pas de clé (mais est LIMITÉ
// aux réponses instantanées / sujets connexes — dernier recours).
// SkyAInet × Thevie × Nikola T369
// =====================================================

"use strict";

const DEFAULT_TIMEOUT_MS = 6000;
const MAX_RESULTS_CAP    = 10;

// Base de connaissances locale — secours pertinent hors-ligne pour l'écosystème SkyAInet.
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

/**
 * Service de recherche web pour Thevie — chaîne de providers officiels.
 * @example
 *   const ws = new WebSearch();                               // auto depuis l'env
 *   const ws2 = new WebSearch({ providers: [{ name:'brave', apiKey:'…' }] });
 *   const results = await ws.search('SkyAInet validator', 3); // → [{title,snippet,url}]
 */
export class WebSearch {
  #providers;      // chaîne ordonnée : [{ name, endpoint?, apiKey?, cx? }]
  #timeout;
  #useLocalFallback;
  #totalSearches = 0;
  #lastError = null;
  #lastProvider = null;

  constructor(opts = {}) {
    this.#timeout          = opts.timeout ?? DEFAULT_TIMEOUT_MS;
    this.#useLocalFallback = opts.useLocalFallback !== false;
    this.#providers        = WebSearch.#buildChain(opts);
  }

  // Chaîne : opts.providers explicite, sinon rétro-compat opts.provider unique,
  // sinon chaîne auto depuis l'environnement.
  static #buildChain(opts) {
    if (Array.isArray(opts.providers) && opts.providers.length) {
      return opts.providers.map(p => (typeof p === 'string' ? { name: p } : { ...p }));
    }
    if (opts.provider) return [{ name: opts.provider, endpoint: opts.endpoint ?? null, apiKey: opts.apiKey ?? null, cx: opts.cx ?? null }];
    return WebSearch.envChain();
  }

  // Chaîne par défaut depuis l'environnement (préférence Google → Brave → DDG ;
  // SearxNG si fourni ; DuckDuckGo toujours présent en dernier recours).
  static envChain() {
    const env = (typeof process !== 'undefined' && process.env) ? process.env : {};
    const chain = [];
    if (env.GOOGLE_API_KEY && env.GOOGLE_CSE_ID) chain.push({ name: 'google', apiKey: env.GOOGLE_API_KEY, cx: env.GOOGLE_CSE_ID });
    if (env.BRAVE_API_KEY)                       chain.push({ name: 'brave',  apiKey: env.BRAVE_API_KEY });
    if (env.SEARXNG_URL)                         chain.push({ name: 'searxng', endpoint: env.SEARXNG_URL });
    chain.push({ name: 'duckduckgo' });
    return chain;
  }

  /**
   * Recherche principale — contrat consommé par thevie.html et Vitality Surf.
   * @returns {Promise<Array<{title:string, snippet:string, url:string}>>}
   */
  async search(query, maxResults = 3) {
    const q = String(query ?? '').trim();
    if (!q) return [];
    const limit = Math.max(1, Math.min(Number(maxResults) || 3, MAX_RESULTS_CAP));
    this.#totalSearches++;

    // Chaîne : le premier provider qui renvoie des résultats gagne.
    for (const p of this.#providers) {
      try {
        const live = await this.#searchOne(p, q, limit);
        if (live.length) { this.#lastProvider = p.name; return live.slice(0, limit); }
      } catch (e) { this.#lastError = `${p.name}: ${e.message}`; /* provider suivant */ }
    }

    // Repli local (écosystème SkyAInet), sinon vide (le frontend simule).
    if (this.#useLocalFallback) { const local = this.#searchLocal(q, limit); if (local.length) return local; }
    return [];
  }

  #searchOne(p, query, limit) {
    switch (p.name) {
      case 'google':     return this.#searchGoogle(p, query, limit);
      case 'brave':      return this.#searchBrave(p, query, limit);
      case 'searxng':    return this.#searchSearxng(p, query, limit);
      case 'duckduckgo':
      case 'ddg':        return this.#searchDuckDuckGo(p, query, limit);
      default:           return Promise.resolve([]);
    }
  }

  // Google Custom Search JSON API — clé + cx (moteur de recherche personnalisé). Web complet.
  async #searchGoogle(p, query, limit) {
    if (!p.apiKey || !p.cx) throw new Error('clé + cx requis');
    const url = `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(p.apiKey)}` +
                `&cx=${encodeURIComponent(p.cx)}&q=${encodeURIComponent(query)}&num=${Math.min(limit, 10)}`;
    const data = await this.#fetchJson(url);
    const items = Array.isArray(data?.items) ? data.items : [];
    return items.map(r => ({ title: r.title ?? '(sans titre)', snippet: r.snippet ?? '', url: r.link ?? '' }));
  }

  // Brave Search API — header X-Subscription-Token. Web complet.
  async #searchBrave(p, query, limit) {
    if (!p.apiKey) throw new Error('clé requise');
    const base = (p.endpoint || 'https://api.search.brave.com/res/v1/web/search').replace(/\/$/, '');
    const url  = `${base}?q=${encodeURIComponent(query)}&count=${limit}`;
    const data = await this.#fetchJson(url, { headers: { 'X-Subscription-Token': p.apiKey } });
    const items = data?.web?.results ?? [];
    return items.map(r => ({ title: r.title ?? '(sans titre)', snippet: r.description ?? '', url: r.url ?? '' }));
  }

  // SearxNG — métamoteur auto-hébergé, GET /search?q=...&format=json.
  async #searchSearxng(p, query, limit) {
    if (!p.endpoint) throw new Error('endpoint requis');
    const url = `${p.endpoint.replace(/\/$/, '')}/search?q=${encodeURIComponent(query)}&format=json`;
    const data = await this.#fetchJson(url);
    const items = Array.isArray(data?.results) ? data.results : [];
    return items.map(r => ({ title: r.title ?? '(sans titre)', snippet: r.content ?? r.snippet ?? '', url: r.url ?? '' }));
  }

  // DuckDuckGo Instant Answer API (sans clé) — LIMITÉ : réponses instantanées /
  // sujets connexes, PAS de résultats web généraux. Dernier recours honnête.
  async #searchDuckDuckGo(p, query, limit) {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const data = await this.#fetchJson(url);
    const out = [];
    if (data?.AbstractText) out.push({ title: data.Heading || query, snippet: data.AbstractText, url: data.AbstractURL || '' });
    for (const t of (Array.isArray(data?.RelatedTopics) ? data.RelatedTopics : [])) {
      if (out.length >= limit) break;
      if (t && t.Text && t.FirstURL) out.push({ title: (t.Text.split(' - ')[0] || t.Text).slice(0, 80), snippet: t.Text, url: t.FirstURL });
    }
    return out;
  }

  async #fetchJson(url, opts = {}) {
    if (typeof fetch !== 'function') throw new Error('fetch indisponible dans cet environnement');
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.#timeout);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { 'Accept': 'application/json', ...(opts.headers ?? {}) } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally { clearTimeout(timer); }
  }

  #searchLocal(query, limit) {
    const lower = query.toLowerCase();
    const scored = [];
    for (const entry of LOCAL_KNOWLEDGE) {
      let score = 0;
      for (const k of entry.keys) if (lower.includes(k)) score++;
      if (score > 0) scored.push({ score, entry });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map(({ entry }) => ({ title: entry.title, snippet: entry.snippet, url: 'local://skyainet-knowledge' }));
  }

  getStats() {
    return {
      providers     : this.#providers.map(p => p.name),
      lastProvider  : this.#lastProvider,
      totalSearches : this.#totalSearches,
      localFallback : this.#useLocalFallback,
      lastError     : this.#lastError,
    };
  }

  /** Reconfigure la chaîne à chaud. */
  configure({ providers, provider, endpoint, apiKey, cx, timeout } = {}) {
    if (timeout !== undefined) this.#timeout = timeout;
    if (providers !== undefined || provider !== undefined) this.#providers = WebSearch.#buildChain({ providers, provider, endpoint, apiKey, cx });
    return this;
  }
}

export default WebSearch;
