// packages/model/src/thevie/synapse.js
// =====================================================
// Synapse — Connexion Neurone à Neurone
// Port de synapse.rs — Hebbian, Anti-Hebbian, Décroissance, Sérialisation
// SkyAInet × Nikola T369
// =====================================================

"use strict";

// ─────────────────────────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────────────────────────

const STRENGTH_MIN   = 0.08;
const STRENGTH_MAX   = 1.00;
const STRENGTH_INIT  = 0.50;
const DECAY_RATE_DEF = 0.008;

// ─────────────────────────────────────────────────────────────────
// SYNAPSE
//
// Connexion dirigée entre deux neurones.
// Propriétés :
//   - strength    : poids de la connexion [STRENGTH_MIN, 1.0]
//   - usageCount  : nombre total d'activations
//   - lastUsed    : timestamp ms de la dernière activation
//   - decayRate   : vitesse de dégradation naturelle par tick
//   - createdAt   : timestamp ms de création
//
// Loi de Hebb : "neurons that fire together, wire together"
// Anti-Hebb : affaiblissement si corrélation négative
// ─────────────────────────────────────────────────────────────────

export class Synapse {
  /**
   * @param {number} from         — NeuronId source
   * @param {number} to           — NeuronId cible
   * @param {number} [strength]   — force initiale [STRENGTH_MIN, 1.0]
   * @param {number} [decayRate]  — taux de décroissance par tick
   */
  constructor(from, to, strength = STRENGTH_INIT, decayRate = DECAY_RATE_DEF) {
    const now         = _now();
    this.from         = from;
    this.to           = to;
    this.strength     = _clamp(strength);
    this.usageCount   = 0;
    this.lastUsed     = now;
    this.decayRate    = Math.max(0, Math.min(0.1, decayRate));
    this.createdAt    = now;
  }

  // ─── Renforcement Hebbian ─────────────────────────────────────

  /**
   * Renforce la connexion après co-activation (port de strengthen).
   * @param {number} amount — [0, 1]
   */
  strengthen(amount = 0.12) {
    this.strength   = _clamp(this.strength + amount);
    this.usageCount++;
    this.lastUsed   = _now();
    return this;
  }

  /**
   * Affaiblit la connexion (Anti-Hebbian / erreur de prédiction).
   * @param {number} amount — [0, 1]
   */
  weaken(amount = 0.18) {
    this.strength   = _clamp(this.strength - amount);
    this.lastUsed   = _now();
    return this;
  }

  // ─── Décroissance ─────────────────────────────────────────────

  /**
   * Dégradation naturelle (port de decay).
   * Appelée périodiquement pour simuler l'oubli biologique.
   */
  decay() {
    this.strength = _clamp(this.strength - this.decayRate);
    return this;
  }

  /**
   * Décroissance proportionnelle à l'âge d'inactivité.
   * @param {number} maxDecay — plafond de décroissance par appel
   */
  timeBasedDecay(maxDecay = 0.28) {
    const ageH    = (_now() - this.lastUsed) / 3_600_000;
    if (ageH > 8) {
      const decay = Math.min(ageH / 60, maxDecay);
      this.strength = _clamp(this.strength - decay);
    }
    return this;
  }

  // ─── Métriques ───────────────────────────────────────────────

  /** true si la synapse est suffisamment forte pour transmettre un signal. */
  isActive() {
    return this.strength > 0.12 && this.usageCount > 0;
  }

  /** Âge de la synapse en secondes (port de age_seconds). */
  ageSeconds() {
    return Math.floor((_now() - this.createdAt) / 1000);
  }

  /** Efficacité = strength × log1p(usageCount) — neurones fréquents sont favorisés. */
  get efficiency() {
    return this.strength * Math.log1p(this.usageCount);
  }

  // ─── Transmission & apprentissage (Fusion L0) ────────────────

  /**
   * Transmet un signal à travers la synapse : sortie pondérée par la force.
   * La synapse agit comme une porte de routage du « consciousness bus ».
   * @param {number} signal
   * @returns {number} signal transmis (0 si synapse inactive)
   */
  transmit(signal) {
    if (this.strength <= 0.12) return 0;
    this.usageCount++;
    this.lastUsed = _now();
    return signal * this.strength;
  }

  /**
   * Mise à jour hebbienne unifiée depuis une corrélation pré/post-activation :
   * corrélation positive → renforcement, négative → affaiblissement (anti-Hebb).
   * @param {number} correlation — [-1, 1]
   * @param {number} rate
   */
  hebbianUpdate(correlation, rate = 0.1) {
    if (correlation >= 0) this.strengthen(rate * correlation);
    else                  this.weaken(rate * -correlation);
    return this;
  }

  // ─── Sérialisation ───────────────────────────────────────────

  toJSON() {
    return {
      from      : this.from,
      to        : this.to,
      strength  : +this.strength.toFixed(4),
      usageCount: this.usageCount,
      lastUsed  : this.lastUsed,
      decayRate : this.decayRate,
      createdAt : this.createdAt,
    };
  }

  static fromJSON(obj) {
    const s = new Synapse(obj.from, obj.to, obj.strength, obj.decayRate);
    s.usageCount = obj.usageCount ?? 0;
    s.lastUsed   = obj.lastUsed   ?? _now();
    s.createdAt  = obj.createdAt  ?? _now();
    return s;
  }
}

// ─────────────────────────────────────────────────────────────────
// HELPERS INTERNES
// ─────────────────────────────────────────────────────────────────

function _clamp(v) {
  return v < STRENGTH_MIN ? STRENGTH_MIN : v > STRENGTH_MAX ? STRENGTH_MAX : v;
}

function _now() { return Date.now(); }

// ═════════════════════════════════════════════════════════════════════════════
// FABRIC SYNAPTIQUE — propagation de leçons au niveau RÉSEAU (nœud à nœud / IA à IA)
// ═════════════════════════════════════════════════════════════════════════════
// Réutilise la classe Synapse ci-dessus (même primitive Hebbienne : strength,
// strengthen/weaken, decay, transmit) mais appliquée aux LIENS ENTRE NŒUDS, pas
// entre neurones. Une leçon ne se propage à un voisin que si son POTENTIEL
// (qualité × force du lien) dépasse un seuil → routage intelligent, pas d'inondation.
// Le lien se renforce (Hebb) quand la leçon transmise s'avère utile chez le pair.

const POTENTIAL_THRESHOLD = 0.35;   // seuil d'activation (qualité × force du lien)

// ── La mesh synaptique : routage + porte d'activation + feedback de Hebb ─────
export class SynapticMesh {
  #synapses = new Map();   // peerId → Synapse (from = ce nœud, to = pair)
  #selfId; #threshold;
  #send = null;            // (peerId, lesson) => Promise|void — injecté par le transport
  #seen = new Set();       // anti-boucle : lessonId déjà propagés
  #stats = { propagations: 0, gated: 0, delivered: 0, reinforcements: 0, punishments: 0 };

  constructor({ selfId = 'self', threshold = POTENTIAL_THRESHOLD, send = null } = {}) {
    this.#selfId    = selfId;
    this.#threshold = threshold;
    this.#send      = send;
  }

  /** Injecte la fonction de transport (WebSocket, bus en-processus, mock…). */
  setSend(fn) { this.#send = fn; return this; }

  connect(peerId, strength) {
    if (!peerId) return null;
    if (!this.#synapses.has(peerId)) this.#synapses.set(peerId, new Synapse(this.#selfId, peerId, strength ?? STRENGTH_INIT));
    return this.#synapses.get(peerId);
  }
  disconnect(peerId) { return this.#synapses.delete(peerId); }
  synapse(peerId)    { return this.#synapses.get(peerId) || null; }
  peers()            { return [...this.#synapses.keys()]; }

  /**
   * Propage une leçon avec PORTE D'ACTIVATION : potentiel = qualité × force du
   * lien ; ne part vers un voisin que si potentiel ≥ seuil. Anti-inondation.
   * @returns {{ propagated:boolean, fired:object[], gated:object[], quality:number }}
   */
  async propagate(lesson = {}) {
    const quality  = lesson.quality ?? lesson.score ?? lesson._score ?? 0;
    const lessonId = lesson.id ?? lesson.lessonId ?? null;
    if (lessonId && this.#seen.has(lessonId)) return { propagated: false, reason: 'déjà propagé', fired: [], gated: [] };
    if (lessonId) { this.#seen.add(lessonId); this.#pruneSeen(); }
    this.#stats.propagations++;

    const fired = [], gated = [];
    for (const syn of this.#synapses.values()) {
      const potential = quality * syn.strength;
      if (potential >= this.#threshold) {
        syn.transmit(quality);   // marque l'usage (usageCount++, lastUsed) via la primitive existante
        fired.push({ peerId: syn.to, potential: +potential.toFixed(3), strength: +syn.strength.toFixed(3) });
        try { await this.#send?.(syn.to, { ...lesson, _synPotential: potential }); this.#stats.delivered++; }
        catch (_) { /* transport best-effort */ }
      } else {
        gated.push({ peerId: syn.to, potential: +potential.toFixed(3) });
        this.#stats.gated++;
      }
    }
    return { propagated: fired.length > 0, fired, gated, quality };
  }

  /**
   * Feedback de Hebb : le pair signale que la leçon transmise a (ou non) servi.
   * Utile → strengthen (le chemin devient prioritaire). Inutile → weaken.
   */
  reinforce(peerId, useful = true, amount) {
    const syn = this.#synapses.get(peerId);
    if (!syn) return null;
    if (useful) { this.#stats.reinforcements++; syn.strengthen(amount ?? 0.12); }
    else        { this.#stats.punishments++;   syn.weaken(amount ?? 0.18); }
    return syn.strength;
  }

  /** Routage intelligent : les meilleurs chemins pour une qualité donnée. */
  route(quality = 0.8, topN = 3) {
    return [...this.#synapses.values()]
      .map(s => ({ peerId: s.to, strength: +s.strength.toFixed(4), potential: +(quality * s.strength).toFixed(3) }))
      .sort((a, b) => b.potential - a.potential)
      .slice(0, topN);
  }

  /** Décroissance de toutes les synapses (appelée périodiquement en arrière-plan). */
  decayAll() { for (const s of this.#synapses.values()) s.decay(); return this.#synapses.size; }

  stats() {
    const syn = [...this.#synapses.values()];
    return {
      peers: syn.length, threshold: this.#threshold,
      avgStrength: syn.length ? +(syn.reduce((a, s) => a + s.strength, 0) / syn.length).toFixed(4) : 0,
      strongest: syn.length ? syn.reduce((a, s) => (s.strength > a.strength ? s : a)).toJSON() : null,
      ...this.#stats,
      synapses: syn.map(s => s.toJSON()),
    };
  }

  #pruneSeen(max = 5000) {
    if (this.#seen.size <= max) return;
    const arr = [...this.#seen];
    this.#seen = new Set(arr.slice(arr.length - Math.floor(max / 2)));
  }
}

// ── Transport bidirectionnel PERSISTANT entre nœuds (WebSocket, ws paresseux) ─
export class WebSocketFabric {
  #mesh; #peerId; #port; #onLesson;
  #server = null;
  #inbound  = new Map();   // peerId → socket (entrantes)
  #outbound = new Map();   // url    → { sock, peerId, retry, timer }
  #enabled = false;

  constructor({ mesh, peerId, port = 8848, onLesson = null } = {}) {
    if (!mesh) throw new Error('[Synaptic] mesh requis');
    this.#mesh = mesh; this.#peerId = peerId ?? ('node-' + Math.random().toString(36).slice(2, 8));
    this.#port = port; this.#onLesson = onLesson;
  }

  get enabled() { return this.#enabled; }
  get peerId()  { return this.#peerId; }

  /** Démarre le serveur WebSocket + branche le transport dans la mesh. */
  async start() {
    let WS;
    try { WS = (await import('ws')).default ?? (await import('ws')); }
    catch {
      console.info('[Synaptic] paquet « ws » absent — fabric temps réel désactivé, mesh en-processus conservé (npm i ws pour l\'activer).');
      return { ok: false, reason: 'ws non installé' };
    }
    const WebSocketServer = WS.WebSocketServer ?? WS.Server;
    try { this.#server = new WebSocketServer({ port: this.#port }); }
    catch (e) {
      console.info(`[Synaptic] serveur WebSocket impossible sur :${this.#port} (${e.message}) — repli en-processus.`);
      return { ok: false, reason: e.message };
    }
    this.#server.on('connection', (sock) => this.#onConnection(sock));
    this.#server.on('error', (e) => console.debug?.(`[Synaptic] serveur: ${e.message}`));
    this.#mesh.setSend((peerId, lesson) => this.#sendTo(peerId, lesson));
    this.#enabled = true;
    console.info(`[Synaptic] fabric WebSocket à l'écoute sur :${this.#port} (peer ${this.#peerId})`);
    return { ok: true, port: this.#port, peerId: this.#peerId };
  }

  /** Ouvre une synapse sortante persistante vers un pair (reconnexion auto). */
  async connect(url) {
    if (this.#outbound.has(url)) return { ok: true, already: true };
    let WS;
    try { WS = (await import('ws')).default ?? (await import('ws')); }
    catch { return { ok: false, reason: 'ws non installé' }; }
    const WebSocket = WS.WebSocket ?? WS;
    const entry = { sock: null, peerId: null, retry: 0, timer: null };
    this.#outbound.set(url, entry);

    const dial = () => {
      let sock;
      try { sock = new WebSocket(url); } catch { return schedule(); }
      entry.sock = sock;
      sock.on('open', () => { entry.retry = 0; sock.send(JSON.stringify({ t: 'hello', peerId: this.#peerId })); });
      sock.on('message', (data) => this.#onMessage(data, entry));
      sock.on('close', () => schedule());
      sock.on('error', () => { try { sock.close(); } catch (_) {} });
    };
    const schedule = () => {
      if (!this.#outbound.has(url)) return;
      entry.retry = Math.min(entry.retry + 1, 6);
      entry.timer = setTimeout(dial, Math.min(30000, 1000 * 2 ** entry.retry));   // 2s → 30s
      if (entry.timer.unref) entry.timer.unref();
    };
    dial();
    return { ok: true, url };
  }

  disconnect(url) {
    const e = this.#outbound.get(url);
    if (e) { if (e.timer) clearTimeout(e.timer); try { e.sock?.close(); } catch (_) {} this.#outbound.delete(url); }
    return { ok: true };
  }

  #onConnection(sock) {
    let peerId = null;
    sock.on('message', (data) => {
      const msg = this.#parse(data);
      if (!msg) return;
      if (msg.t === 'hello') { peerId = msg.peerId; if (peerId) { this.#inbound.set(peerId, sock); this.#mesh.connect(peerId); } return; }
      this.#handle(msg, peerId, sock);
    });
    sock.on('close', () => { if (peerId) this.#inbound.delete(peerId); });
    sock.on('error', () => {});
  }

  #onMessage(data, entry) {
    const msg = this.#parse(data);
    if (!msg) return;
    if (msg.t === 'hello') { entry.peerId = msg.peerId; if (msg.peerId) this.#mesh.connect(msg.peerId); return; }
    this.#handle(msg, entry.peerId, entry.sock);
  }

  #handle(msg, fromPeer, sock) {
    if (msg.t === 'lesson') {
      Promise.resolve(this.#onLesson?.(msg.lesson, fromPeer))
        .then((useful) => { try { sock?.send(JSON.stringify({ t: 'ack', lessonId: msg.lesson?.id ?? msg.lesson?.lessonId ?? null, useful: !!useful })); } catch (_) {} })
        .catch(() => {});
    } else if (msg.t === 'ack') {
      if (fromPeer) this.#mesh.reinforce(fromPeer, !!msg.useful);   // Hebb sur le fil
    }
  }

  #sendTo(peerId, lesson) {
    const sock = this.#inbound.get(peerId) ?? this.#outByPeer(peerId);
    if (!sock || sock.readyState !== 1) return false;   // 1 = OPEN
    try { sock.send(JSON.stringify({ t: 'lesson', lesson })); return true; } catch (_) { return false; }
  }
  #outByPeer(peerId) { for (const e of this.#outbound.values()) if (e.peerId === peerId) return e.sock; return null; }
  #parse(data) { try { return JSON.parse(typeof data === 'string' ? data : data.toString()); } catch { return null; } }

  status() {
    return {
      enabled: this.#enabled, peerId: this.#peerId, port: this.#port,
      inbound: [...this.#inbound.keys()], outbound: [...this.#outbound.keys()],
      connections: this.#inbound.size + [...this.#outbound.values()].filter(e => e.sock?.readyState === 1).length,
    };
  }

  stop() {
    for (const url of [...this.#outbound.keys()]) this.disconnect(url);
    try { this.#server?.close(); } catch (_) {}
    this.#server = null; this.#enabled = false;
    return { ok: true };
  }
}