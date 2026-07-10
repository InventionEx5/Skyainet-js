// packages/memory/src/tiered_memory.js
// ─────────────────────────────────────────────────────────────────────────────
// MÉMOIRE À ÉTAGES + RÉTENTION LONG TERME DES LEÇONS
//
// Hiérarchie mémoire :
//   • HOT  (RAM)       — index de TOUTES les leçons + cache LRU du contenu chaud
//   • WARM (disque)    — contenu complet de toutes les leçons persistées
//
// Objectif : les leçons apprises SURVIVENT au redémarrage (rechargées au boot),
  // sont rappelables (RAG) et organisées par qualité/accès.
// ─────────────────────────────────────────────────────────────────────────────

import fs   from 'fs';
import path from 'path';

export const Tier = Object.freeze({ HOT: 'hot', WARM: 'warm' });

// ── Détection du meilleur point de montage (le plus d'espace libre = SSD) ────
//    Utilise statfs (Node 18.15+). Renvoie le chemin le plus spacieux et inscriptible.
export async function detectBestMount(candidates = []) {
  const roots = [...new Set([...candidates, process.cwd(), '/data', '/mnt/ssd', '/mnt/data', '/home', '/'])];
  let best = null, bestFree = -1;
  for (const root of roots) {
    try {
      await fs.promises.access(root, fs.constants.W_OK);
      const st = await fs.promises.statfs(root);
      const freeB = Number(st.bavail) * Number(st.bsize);
      if (freeB > bestFree) { bestFree = freeB; best = root; }
    } catch { /* montage absent, non inscriptible, ou statfs indispo */ }
  }
  return best ? { path: best, freeGb: bestFree / 1_073_741_824 } : null;
}

// ═══════════════════════════════════════════════════════════════
// LESSON VAULT — rétention long terme
// ═══════════════════════════════════════════════════════════════
export class LessonVault {
  #dir;                    // répertoire WARM (SSD)
  #index = new Map();      // id → { id, quality, source, ts, hits, tier }
  #hotCache = new Map();   // id → { query, response } (cache LRU du contenu)
  #hotCacheMax;            // taille max du cache chaud
  #autoSsd = false;        // détecter le SSD réel au boot
  #ssdSubdir = '';         // sous-répertoire à créer sur le SSD détecté
  #ssdPath = null;         // montage SSD détecté
  #ssdFreeGb = null;       // espace libre du SSD détecté
  #ready;

  constructor({ dir = './data/lessons', hotCacheMax = 200, autoSsd = false, ssdSubdir = 'skyainet/lessons' } = {}) {
    this.#dir         = dir;
    this.#hotCacheMax = hotCacheMax;
    this.#autoSsd     = autoSsd;
    this.#ssdSubdir   = ssdSubdir;
    this.#ready       = this.#init();
  }

  async #init() {
    // Détection automatique du SSD réel (le montage le plus spacieux et inscriptible).
    if (this.#autoSsd) {
      try {
        const m = await detectBestMount([process.cwd()]);
        if (m && m.freeGb > 1) {                    // au moins 1 Go libre
          this.#dir = path.join(m.path, this.#ssdSubdir);
          this.#ssdPath = m.path;
          this.#ssdFreeGb = m.freeGb;
        }
      } catch { /* fallback sur le dir par défaut */ }
    }
    await fs.promises.mkdir(this.#dir, { recursive: true }).catch(() => {});
    await this.#loadIndex();
  }
  ready() { return this.#ready; }
  baseDir() { return this.#dir; }
  ssdInfo() { return { path: this.#ssdPath, freeGb: this.#ssdFreeGb, dir: this.#dir }; }

  // ── Index persistant (rechargé au boot) ──────────────────────
  async #loadIndex() {
    try {
      const raw = await fs.promises.readFile(path.join(this.#dir, '_index.json'), 'utf8');
      const arr = JSON.parse(raw);
      for (const e of arr) if (e && e.id) this.#index.set(e.id, e);
    } catch { /* premier démarrage : index vide */ }
  }
  async #persistIndex() {
    try {
      await fs.promises.writeFile(path.join(this.#dir, '_index.json'), JSON.stringify([...this.#index.values()]));
    } catch { /* best-effort */ }
  }

  // ── Identifiant déterministe (dédup par contenu) ─────────────
  #mkId(query, resp) {
    const s = String(query) + '|' + String(resp).slice(0, 240);
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return 'L' + (h >>> 0).toString(36);
  }

  // ── Persistance d'une leçon retenue ──────────────────────────
  async save({ query = '', response = '', quality = 0.8, source = 'lesson' } = {}) {
    await this.#ready;
    const answer = String(response ?? '').trim();
    if (!answer) return { ok: false, reason: 'empty' };
    const id = this.#mkId(query, answer);

    if (this.#index.has(id)) {                        // déjà connue → renforcement
      const e = this.#index.get(id);
      e.quality = Math.max(e.quality, Number(quality) || 0.8);
      e.hits    = (e.hits || 0) + 1;
      e.ts      = Date.now();
      return { ok: true, id, deduped: true };
    }

    const entry = { id, quality: Number(quality) || 0.8, source, ts: Date.now(), hits: 0, tier: Tier.WARM };
    try {
      await fs.promises.writeFile(
        path.join(this.#dir, id + '.json'),
        JSON.stringify({ query: String(query ?? ''), response: answer }),
      );
    } catch { return { ok: false, reason: 'write failed' }; }

    this.#index.set(id, entry);
    this.#cachePut(id, { query: String(query ?? ''), response: answer });
    await this.#persistIndex();
    return { ok: true, id };
  }

  // ── Cache chaud LRU (performance : évite de relire le SSD) ────
  #cachePut(id, content) {
    this.#hotCache.delete(id);
    this.#hotCache.set(id, content);
    while (this.#hotCache.size > this.#hotCacheMax) {
      const oldest = this.#hotCache.keys().next().value;
      this.#hotCache.delete(oldest);
    }
  }
  async #loadContent(entry) {
    if (this.#hotCache.has(entry.id)) { const c = this.#hotCache.get(entry.id); this.#cachePut(entry.id, c); return c; }
    try {
      const raw = await fs.promises.readFile(path.join(this.#dir, entry.id + '.json'), 'utf8');
      const content = JSON.parse(raw);
      this.#cachePut(entry.id, content);
      return content;
    } catch { return null; }
  }

  // ── Rappel (RAG) : leçons les plus pertinentes pour une requête ──
  async recall(query, topK = 5) {
    await this.#ready;
    const words = String(query).toLowerCase().split(/\s+/).filter(w => w.length > 3);
    // 1er tri léger : qualité + accès (sans lire le disque)
    const prelim = [...this.#index.values()]
      .map(e => ({ e, base: e.quality + (e.hits || 0) * 0.05 }))
      .sort((a, b) => b.base - a.base)
      .slice(0, Math.max(topK * 4, 20));
    // 2e tri : recouvrement de mots-clés sur le contenu chargé
    const out = [];
    for (const { e, base } of prelim) {
      const c = await this.#loadContent(e);
      if (!c) continue;
      const hay = (String(c.query) + ' ' + String(c.response)).toLowerCase();
      const overlap = words.reduce((n, w) => n + (hay.includes(w) ? 1 : 0), 0);
      out.push({ id: e.id, query: c.query, response: c.response, quality: e.quality, source: e.source, score: base + overlap });
    }
    out.sort((a, b) => b.score - a.score);
    const top = out.slice(0, topK);
    for (const r of top) { const e = this.#index.get(r.id); if (e) e.hits = (e.hits || 0) + 1; }
    return top.map(({ score, ...r }) => r);
  }

  /**
   * Les n meilleures leçons par qualité (contenu chargé) — pour l'export du
   * corpus d'entraînement et la construction du Modelfile. Tri qualité + accès.
   */
  async top(n = 50) {
    await this.#ready;
    const ranked = [...this.#index.values()]
      .sort((a, b) => (b.quality + (b.hits || 0) * 0.05) - (a.quality + (a.hits || 0) * 0.05))
      .slice(0, Math.max(1, n));
    const out = [];
    for (const e of ranked) {
      const c = await this.#loadContent(e);
      if (c && String(c.response).trim()) out.push({ id: e.id, query: c.query, response: c.response, quality: e.quality, source: e.source });
    }
    return out;
  }

    stats() {
    const bySource = {}, byTier = { hot: 0, warm: 0 };
    for (const e of this.#index.values()) {
      bySource[e.source] = (bySource[e.source] || 0) + 1;
      byTier[e.tier]     = (byTier[e.tier] || 0) + 1;
    }
    return {
      total: this.#index.size,
      bySource, byTier,
      hotCache: this.#hotCache.size,
    };
  }
  count() { return this.#index.size; }
}

// ═══════════════════════════════════════════════════════════════
// STORAGE TIERS — hiérarchie de capacité RAM / SSD
// ═══════════════════════════════════════════════════════════════
export class StorageTiers {
  #tiers = new Map();  // name → { name, path, role }

  constructor({ ram = 32, ssd = 2048 } = {}) {
    // Capacités nominales déclarées (Go) — la RAM héberge les 3 cerveaux.
    this.#tiers.set(Tier.HOT,  { name: Tier.HOT,  role: 'RAM · 3 brains + hot index', capacityGb: ram,  path: null });
    this.#tiers.set(Tier.WARM, { name: Tier.WARM, role: 'SSD · lesson vault + snapshots', capacityGb: ssd, path: './data' });
  }

  /** Pointe le tier WARM vers le vrai montage SSD détecté. */
  setWarmPath(dir) { const w = this.#tiers.get(Tier.WARM); if (w && dir) w.path = dir; }

  /** Détecte le meilleur SSD (le plus d'espace libre, inscriptible). */
  async detectBestSsd(candidates = []) { return detectBestMount(candidates); }

  /** Taille réelle utilisée sur disque d'un répertoire. */
  async #dirSizeGb(dir) {
    if (!dir) return 0;
    let sizeB = 0;
    const walk = async (d) => {
      const entries = await fs.promises.readdir(d, { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) await walk(full);
        else { const st = await fs.promises.stat(full).catch(() => null); if (st) sizeB += st.size; }
      }
    };
    await walk(dir);
    return sizeB / 1_073_741_824;
  }

  async report() {
    const out = [];
    for (const t of this.#tiers.values()) {
      const usedGb = t.path ? await this.#dirSizeGb(t.path) : null;
      out.push({
        tier: t.name, role: t.role,
        capacityGb: t.capacityGb,
        usedGb: usedGb == null ? null : Number(usedGb.toFixed(4)),
        path: t.path,
      });
    }
    return { tiers: out };
  }
}

// ═══════════════════════════════════════════════════════════════
// ADAPTER VAULT — bibliothèque d'adaptateurs LoRA sur SSD
//   Persiste manifestes + poids des adaptateurs ; rechargée au boot.
  //   HOT (RAM) : adaptateurs actifs/repli · WARM : archive des retirés.
//   C'est la "croissance des poids cerveaux" : le modèle de base ne grossit
//   pas, mais la bibliothèque d'adaptateurs spécialisés grandit sur le SSD.
// ═══════════════════════════════════════════════════════════════
export class AdapterVault {
  #dir;
  #index = new Map();       // id → { id, domain, base, owner, state, score, sizeBytes, ts, tier }
  #autoSsd = false; #ssdSubdir = ''; #ssdPath = null;
  #ready;

  constructor({ dir = './data/adapters', autoSsd = false, ssdSubdir = 'skyainet/adapters' } = {}) {
    this.#dir = dir; this.#autoSsd = autoSsd; this.#ssdSubdir = ssdSubdir;
    this.#ready = this.#init();
  }
  async #init() {
    if (this.#autoSsd) {
      try {
        const m = await detectBestMount([process.cwd()]);
        if (m && m.freeGb > 1) { this.#dir = path.join(m.path, this.#ssdSubdir); this.#ssdPath = m.path; }
      } catch { /* fallback */ }
    }
    await fs.promises.mkdir(this.#dir, { recursive: true }).catch(() => {});
    await this.#loadIndex();
  }
  ready() { return this.#ready; }
  baseDir() { return this.#dir; }

  async #loadIndex() {
    try {
      const raw = await fs.promises.readFile(path.join(this.#dir, '_catalog.json'), 'utf8');
      for (const e of JSON.parse(raw)) if (e && e.id) this.#index.set(e.id, e);
    } catch { /* premier démarrage */ }
  }
  async #persistIndex() {
    try { await fs.promises.writeFile(path.join(this.#dir, '_catalog.json'), JSON.stringify([...this.#index.values()])); }
    catch { /* best-effort */ }
  }

  /** Persiste un adaptateur (manifeste + blob de poids optionnel). */
  async save(manifest = {}, weights = null) {
    await this.#ready;
    const id = manifest.id || ('ad_' + Date.now().toString(36));
    const entry = {
      id,
      domain:    manifest.domain    ?? 'general',
      base:      manifest.base      ?? 'Qwen3-8B',
      owner:     manifest.owner     ?? 't369',
      state:     manifest.state     ?? 'candidate',
      score:     Number(manifest.score) || 0,
      sizeBytes: Number(manifest.sizeBytes) || (weights ? weights.length : 0),
      lossEnd:   manifest.lossEnd   ?? null,
      steps:     manifest.steps     ?? null,
      ts:        Date.now(),
      tier:      Tier.WARM,
    };
    try {
      if (weights) await fs.promises.writeFile(path.join(this.#dir, id + '.bin'), weights);
      await fs.promises.writeFile(path.join(this.#dir, id + '.json'), JSON.stringify(entry));
    } catch { return { ok: false, reason: 'write failed' }; }
    this.#index.set(id, entry);
    await this.#persistIndex();
    return { ok: true, id, dir: this.#dir };
  }

  /** Charge les poids d'un adaptateur depuis le SSD (chargement à la volée). */
  async loadWeights(id) {
    await this.#ready;
    try { return await fs.promises.readFile(path.join(this.#dir, id + '.bin')); }
    catch { return null; }
  }

  /** Synchronise l'état d'un adaptateur avec le cycle de vie LivingReserve. */
  async updateState(id, state, score = null) {
    await this.#ready;
    const e = this.#index.get(id);
    if (!e) return { ok: false, reason: 'unknown' };
    e.state = state;
    if (score != null) e.score = Number(score);
    if (state === 'retired' || state === 'reabsorbed') e.tier = Tier.WARM;   // conservé en WARM (plus de tier COLD)
    await this.#persistIndex();
    return { ok: true, id, state };
  }

  list() { return [...this.#index.values()]; }
  get(id) { return this.#index.get(id) ?? null; }
  count() { return this.#index.size; }
  stats() {
    const byState = {}, byDomain = {}, byTier = { hot: 0, warm: 0, cold: 0 };
    let totalBytes = 0;
    for (const e of this.#index.values()) {
      byState[e.state]   = (byState[e.state] || 0) + 1;
      byDomain[e.domain] = (byDomain[e.domain] || 0) + 1;
      byTier[e.tier]     = (byTier[e.tier] || 0) + 1;
      totalBytes += e.sizeBytes || 0;
    }
    return { total: this.#index.size, byState, byDomain, byTier, sizeMb: Number((totalBytes / 1_048_576).toFixed(3)), dir: this.#dir };
  }
}

// ═══════════════════════════════════════════════════════════════
// MoE EXPERT POOL — experts à étages pour un modèle MoE (T369)
//   Routeur : topK experts actifs par token. HOT (RAM) = experts
//   récemment utilisés (cap) · COLD (SSD) = le reste, chargé à la volée.
//   « Petits cerveaux chauds en RAM, plus large sur SSD », proprement.
// ═══════════════════════════════════════════════════════════════
export class MoEExpertPool {
  #numExperts; #topK; #hotMax;
  #hot = new Map();      // expertId → lastUsedTs (LRU)
  #loads = 0; #evictions = 0; #routes = 0;

  constructor({ numExperts = 8, topK = 2, hotMax = 4 } = {}) {
    this.#numExperts = numExperts;
    this.#topK       = Math.min(topK, numExperts);
    this.#hotMax     = Math.max(topK, Math.min(hotMax, numExperts));
  }

  /**
   * Route un token : sélectionne topK experts selon les scores de gating.
   * Charge depuis le SSD ceux qui sont froids, évince en LRU si HOT déborde.
   * @param {number[]} [gating] scores par expert (défaut : aléatoire déterministe)
   * @returns {{ active:number[], loadedFromSsd:number[], evicted:number[] }}
   */
  route(gating = null) {
    this.#routes++;
    const scores = Array.isArray(gating) && gating.length === this.#numExperts
      ? gating
      : Array.from({ length: this.#numExperts }, (_, i) => Math.sin(this.#routes * 1.7 + i) + 1);
    // topK experts par score
    const active = scores
      .map((s, i) => ({ i, s }))
      .sort((a, b) => b.s - a.s)
      .slice(0, this.#topK)
      .map(x => x.i);

    const loadedFromSsd = [], evicted = [];
    const now = Date.now();
    for (const id of active) {
      if (!this.#hot.has(id)) {                         // froid → charger depuis SSD
        this.#loads++; loadedFromSsd.push(id);
        while (this.#hot.size >= this.#hotMax) {        // évincer le moins récemment utilisé
          let lru = null, lruTs = Infinity;
          for (const [eid, ts] of this.#hot) if (!active.includes(eid) && ts < lruTs) { lru = eid; lruTs = ts; }
          if (lru == null) break;
          this.#hot.delete(lru); this.#evictions++; evicted.push(lru);
        }
      }
      this.#hot.set(id, now);                           // marquer utilisé (chaud)
    }
    return { active, loadedFromSsd, evicted };
  }

  hotExperts() { return [...this.#hot.keys()]; }
  stats() {
    return {
      numExperts: this.#numExperts, topK: this.#topK, hotMax: this.#hotMax,
      hot: this.#hot.size, cold: this.#numExperts - this.#hot.size,
      routes: this.#routes, ssdLoads: this.#loads, evictions: this.#evictions,
      hitRate: this.#routes ? Number((1 - this.#loads / (this.#routes * this.#topK)).toFixed(3)) : 1,
    };
  }
}