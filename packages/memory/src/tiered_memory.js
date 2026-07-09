// packages/memory/src/tiered_memory.js
// ─────────────────────────────────────────────────────────────────────────────
// MÉMOIRE À ÉTAGES + RÉTENTION LONG TERME DES LEÇONS
//
// Hiérarchie mémoire :
//   • HOT  (RAM)       — index de TOUTES les leçons + cache LRU du contenu chaud
//   • WARM (SSD 2 To)  — contenu complet de toutes les leçons persistées
//   • COLD (carte SD)  — leçons rarement consultées, migrées à l'insertion d'une SD
//
// Objectif : les leçons apprises SURVIVENT au redémarrage (rechargées au boot),
// sont rappelables (RAG), organisées par qualité/accès, et le stockage s'étend
// automatiquement quand une carte SD est montée.
// ─────────────────────────────────────────────────────────────────────────────

import fs   from 'fs';
import path from 'path';

export const Tier = Object.freeze({ HOT: 'hot', WARM: 'warm', COLD: 'cold' });

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
  #coldDir = null;         // répertoire COLD (carte SD), si montée
  #index = new Map();      // id → { id, quality, source, ts, hits, tier }
  #hotCache = new Map();   // id → { query, response } (cache LRU du contenu)
  #hotCacheMax;            // taille max du cache chaud
  #warmMax;                // nb max de leçons gardées en WARM avant migration COLD
  #autoSsd = false;        // détecter le SSD réel au boot
  #ssdSubdir = '';         // sous-répertoire à créer sur le SSD détecté
  #ssdPath = null;         // montage SSD détecté
  #ssdFreeGb = null;       // espace libre du SSD détecté
  #ready;

  constructor({ dir = './data/lessons', warmMax = 5000, hotCacheMax = 200, autoSsd = false, ssdSubdir = 'skyainet/lessons' } = {}) {
    this.#dir         = dir;
    this.#warmMax     = warmMax;
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
  #dirFor(tier) { return (tier === Tier.COLD && this.#coldDir) ? this.#coldDir : this.#dir; }

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
        path.join(this.#dirFor(entry.tier), id + '.json'),
        JSON.stringify({ query: String(query ?? ''), response: answer }),
      );
    } catch { return { ok: false, reason: 'write failed' }; }

    this.#index.set(id, entry);
    this.#cachePut(id, { query: String(query ?? ''), response: answer });
    await this.#evictIfNeeded();
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
      const raw = await fs.promises.readFile(path.join(this.#dirFor(entry.tier), entry.id + '.json'), 'utf8');
      const content = JSON.parse(raw);
      this.#cachePut(entry.id, content);
      return content;
    } catch { return null; }
  }

  // ── Migration WARM → COLD (organisation avancée) ─────────────
  //    Score = qualité + accès + fraîcheur ; les plus bas partent sur la SD.
  async #evictIfNeeded() {
    if (!this.#coldDir) return;                       // pas de SD → tout reste WARM
    const warm = [...this.#index.values()].filter(e => e.tier === Tier.WARM);
    if (warm.length <= this.#warmMax) return;
    const scored = warm.map(e => ({
      e,
      s: e.quality + (e.hits || 0) * 0.1 + Math.max(0, 1 - (Date.now() - e.ts) / 2.592e9),
    }));
    scored.sort((a, b) => a.s - b.s);
    for (const { e } of scored.slice(0, warm.length - this.#warmMax)) {
      try {
        await fs.promises.rename(path.join(this.#dir, e.id + '.json'), path.join(this.#coldDir, e.id + '.json'));
        e.tier = Tier.COLD;
      } catch { /* best-effort */ }
    }
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

  // ── Carte SD : activation / désactivation du tier COLD ───────
  async attachColdTier(dir) {
    if (!dir) return { attached: false, reason: 'no path' };
    await fs.promises.mkdir(dir, { recursive: true }).catch(() => {});
    this.#coldDir = dir;
    await this.#evictIfNeeded();
    await this.#persistIndex();
    return { attached: true, dir, migrated: [...this.#index.values()].filter(e => e.tier === Tier.COLD).length };
  }
  detachColdTier() { this.#coldDir = null; return { attached: false }; }

  stats() {
    const bySource = {}, byTier = { hot: 0, warm: 0, cold: 0 };
    for (const e of this.#index.values()) {
      bySource[e.source] = (bySource[e.source] || 0) + 1;
      byTier[e.tier]     = (byTier[e.tier] || 0) + 1;
    }
    return {
      total: this.#index.size,
      bySource, byTier,
      hotCache: this.#hotCache.size,
      coldAttached: !!this.#coldDir,
      warmMax: this.#warmMax,
    };
  }
  count() { return this.#index.size; }
}

// ═══════════════════════════════════════════════════════════════
// STORAGE TIERS — hiérarchie de capacité RAM / SSD / SD
// ═══════════════════════════════════════════════════════════════
export class StorageTiers {
  #tiers = new Map();  // name → { name, path, role }
  #scanTimer = null;   // scanner carte SD en tâche de fond
  #attached = new Set(); // montages déjà attachés (évite les doublons)

  constructor({ ram = 32, ssd = 2048 } = {}) {
    // Capacités nominales déclarées (Go) — la RAM héberge les 3 cerveaux.
    this.#tiers.set(Tier.HOT,  { name: Tier.HOT,  role: 'RAM · 3 brains + hot index', capacityGb: ram,  path: null });
    this.#tiers.set(Tier.WARM, { name: Tier.WARM, role: 'SSD · lesson vault + snapshots', capacityGb: ssd, path: './data' });
    // COLD ajouté dynamiquement à l'insertion d'une carte SD.
  }

  /** Pointe le tier WARM vers le vrai montage SSD détecté. */
  setWarmPath(dir) { const w = this.#tiers.get(Tier.WARM); if (w && dir) w.path = dir; }

  /** Détecte le meilleur SSD (le plus d'espace libre, inscriptible). */
  async detectBestSsd(candidates = []) { return detectBestMount(candidates); }

  /** Détecte des points de montage amovibles (carte SD) sur les chemins usuels. */
  async detectRemovable() {
    const roots = ['/media', '/Volumes', '/mnt', '/run/media'];
    const found = [];
    for (const root of roots) {
      try {
        const entries = await fs.promises.readdir(root, { withFileTypes: true });
        for (const e of entries) if (e.isDirectory()) found.push(path.join(root, e.name));
      } catch { /* montage absent */ }
    }
    return found;
  }

  /** Active un tier COLD (carte SD) — capacité auto-mesurée si possible. */
  async attachCold(dir, capacityGb = null) {
    if (!dir) return { ok: false, reason: 'no path' };
    await fs.promises.mkdir(dir, { recursive: true }).catch(() => {});
    this.#tiers.set(Tier.COLD, { name: Tier.COLD, role: 'SD card · cold archive', capacityGb: capacityGb ?? 0, path: dir });
    return { ok: true, dir };
  }
  detachCold() { this.#tiers.delete(Tier.COLD); return { ok: true }; }

  // ── Scan carte SD en tâche de fond (activation auto à l'insertion) ────────
  /** Démarre un scan périodique ; onAttach(dir) est appelé pour chaque NOUVEAU montage détecté. */
  startAutoScan(intervalMs = 30000, onAttach = () => {}) {
    if (this.#scanTimer) return { running: true, alreadyActive: true };
    const scan = async () => {
      try {
        const found = await this.detectRemovable();
        for (const dir of found) {
          if (this.#attached.has(dir)) continue;
          this.#attached.add(dir);
          try {
            let capGb = 0;
            try { const st = await fs.promises.statfs(dir); capGb = Number(st.blocks) * Number(st.bsize) / 1_073_741_824; } catch { /* statfs indispo */ }
            await this.attachCold(dir, capGb);
            await onAttach(dir);
          } catch { /* best-effort */ }
        }
      } catch { /* best-effort */ }
    };
    scan();                                           // scan immédiat
    this.#scanTimer = setInterval(scan, Math.max(5000, intervalMs));
    if (this.#scanTimer.unref) this.#scanTimer.unref();
    return { running: true, intervalMs };
  }
  stopAutoScan() { if (this.#scanTimer) { clearInterval(this.#scanTimer); this.#scanTimer = null; } return { running: false }; }
  get isAutoScanRunning() { return this.#scanTimer !== null; }

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
    return { tiers: out, coldAttached: this.#tiers.has(Tier.COLD) };
  }
}

// ═══════════════════════════════════════════════════════════════
// ADAPTER VAULT — bibliothèque d'adaptateurs LoRA sur SSD
//   Persiste manifestes + poids des adaptateurs ; rechargée au boot.
//   HOT (RAM) : adaptateurs actifs/repli · COLD (SSD) : archive retirés.
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
    if (state === 'retired' || state === 'reabsorbed') e.tier = Tier.COLD;   // archive froide (SSD/SD)
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