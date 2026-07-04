// packages/model/src/thevie/mesh_fabric.js
// =====================================================
// T369 — Fabric hétérogène : (a) routage par capacité au-dessus d'autoSelect,
// (b) poignée de main mesh : annonce de capacité + adaptateurs chauds, SIGNÉE.
// « Quel que soit l'appareil, l'IA fait quelque chose » — mais le quelque chose
// change avec le matériel : inférence partout, entraînement sur GPU uniquement.
// Signature : Dilithium5 (post-quantique) en production ; Ed25519 natif en repli
// pour tester sans la lib PQ. Aucun import au chargement (crypto/os/Dilithium en
// import dynamique) → module toujours chargeable.
// SkyAInet × Nikola T369
// =====================================================

"use strict";

export const TaskKind = Object.freeze({ Inference: 'inference', Training: 'training', Data: 'data' });
export const SigScheme = Object.freeze({ Dilithium5: 'dilithium5', Ed25519: 'ed25519' });

// Seuils matériels (Mo) : QLoRA-8B ~12 Go VRAM ; inférence 8B-Q4 ~5-6 Go RAM.
const TRAIN_VRAM_MB = 12000;
const INFER_RAM_MB  = 6000;

function normalizeProfile(p = {}) {
  return {
    gpu: !!p.gpu, npu: !!p.npu,
    vramMB: p.vramMB | 0, ramMB: p.ramMB | 0, cores: (p.cores | 0) || 1,
    adapters: Array.isArray(p.adapters) ? p.adapters.slice() : [],
  };
}
const decide = (task, where, target, reason) => ({ task, where, target, reason });

// ─── (a) Routeur par capacité ────────────────────────────────────────────────
// Décide OÙ exécuter une tâche selon la capacité locale et les nœuds mesh connus.
// Se pose AU-DESSUS d'InferenceCore.autoSelect (qui, lui, choisit le backend
// LOCAL) : ici on choisit local / mesh / dispatch-GPU / indisponible.
export class CapabilityRouter {
  constructor(profile = {}, opts = {}) {
    this.profile     = normalizeProfile(profile);
    this.trainVramMB = opts.trainVramMB ?? TRAIN_VRAM_MB;
    this.inferRamMB  = opts.inferRamMB  ?? INFER_RAM_MB;
  }
  // Profil grossier de l'appareil courant (Node) : CPU/RAM auto ; GPU/NPU/VRAM
  // non détectables de façon fiable sans bindings natifs → à fournir en overrides.
  static async detectLocal(overrides = {}) {
    let cores = 1, ramMB = 0;
    try { const os = await import('os'); cores = os.cpus?.().length || 1; ramMB = Math.round((os.totalmem?.() || 0) / 1e6); } catch (_) { /* best-effort */ }
    return normalizeProfile({ cores, ramMB, gpu: false, npu: false, vramMB: 0, ...overrides });
  }
  setProfile(p) { this.profile = normalizeProfile(p); return this; }

  route(task, { adapter = null, meshNodes = [], profile = this.profile } = {}) {
    const p = profile;
    if (task === TaskKind.Data) return decide(task, 'local', null, 'collecte partout (Data Factory)');

    if (task === TaskKind.Training) {
      if (p.gpu && p.vramMB >= this.trainVramMB) return decide(task, 'local-gpu', null, `VRAM ${p.vramMB} Mo ≥ ${this.trainVramMB}`);
      const g = meshNodes.find(n => n.gpu && (n.vramMB || 0) >= this.trainVramMB);
      if (g) return decide(task, 'dispatch', g.nodeId, 'nœud GPU distant');
      return decide(task, 'unavailable', null, 'aucun GPU (VRAM) suffisant — GPU loué requis');
    }

    // Inférence
    const holds = !adapter || (p.adapters || []).includes(adapter);
    if (p.ramMB >= this.inferRamMB && holds) return decide(task, 'local', null, `RAM ${p.ramMB} Mo, adaptateur ${adapter ? 'chaud' : '—'}`);
    const host = meshNodes.find(n => (n.ramMB || 0) >= this.inferRamMB && (!adapter || (n.adapters || []).includes(adapter)));
    if (host) return decide(task, 'mesh', host.nodeId, 'nœud tenant l\u2019adaptateur chaud');
    if (p.ramMB >= this.inferRamMB) return decide(task, 'local-degraded', null, 'adaptateur absent localement — module de base / plus petit');
    return decide(task, 'unavailable', null, 'RAM insuffisante et aucun nœud disponible');
  }
}

// ─── (b) Poignée de main mesh : annonce de capacité SIGNÉE ───────────────────
const b64   = (u8) => Buffer.from(u8).toString('base64');
const unb64 = (s)  => new Uint8Array(Buffer.from(s, 'base64'));
// Sérialisation déterministe (clés triées) : évite la fragilité de l'ordre JSON.
function sortedJson(v) {
  if (Array.isArray(v)) return '[' + v.map(sortedJson).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + sortedJson(v[k])).join(',') + '}';
  return JSON.stringify(v);
}
const canonicalBytes = (obj) => Buffer.from(sortedJson(obj));

// Signeur post-quantique (PRODUCTION) : enveloppe une Dilithium5KeyPair.
export function dilithiumSigner(keypair) {
  return { scheme: SigScheme.Dilithium5, sign: (b) => keypair.sign(b), publicKey: keypair.publicKey };
}
// Signeur Ed25519 natif (repli/test — aucune dépendance externe).
export async function ed25519Signer() {
  const crypto = await import('crypto');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = new Uint8Array(publicKey.export({ type: 'spki', format: 'der' }));
  return { scheme: SigScheme.Ed25519, sign: (b) => new Uint8Array(crypto.sign(null, Buffer.from(b), privateKey)), publicKey: pub };
}

export class CapabilityBeacon {
  #signer;
  constructor(signer) {
    if (!signer || typeof signer.sign !== 'function' || !signer.publicKey) throw new Error('[MeshFabric] signeur requis { scheme, sign, publicKey }');
    this.#signer = signer;
  }
  // Annonce signée : {nodeId, profile(capacité + adaptateurs chauds), ts, scheme, pubkey, sig}.
  announce({ nodeId, profile, adapters = [] }) {
    const body = { nodeId, profile: normalizeProfile({ ...profile, adapters: adapters.length ? adapters : (profile && profile.adapters) }), ts: Date.now() };
    const sig  = this.#signer.sign(canonicalBytes(body));
    return { ...body, scheme: this.#signer.scheme, pubkey: b64(this.#signer.publicKey), sig: b64(sig) };
  }
}

async function verifyForScheme(scheme, pubkey, bytes, sig) {
  if (scheme === SigScheme.Ed25519) {
    const crypto = await import('crypto');
    const key = crypto.createPublicKey({ key: Buffer.from(pubkey), format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from(bytes), key, Buffer.from(sig));
  }
  if (scheme === SigScheme.Dilithium5) {
    const { Dilithium5KeyPair } = await import('#dilithium');   // lib PQ requise en production
    return Dilithium5KeyPair.verify(pubkey, bytes, sig);
  }
  return false;
}

// Vérifie une annonce : signature (selon le schéma) + fraîcheur.
export async function verifyAnnounce(ann, { maxAgeMs = 300000 } = {}) {
  if (!ann || !ann.nodeId || !ann.sig || !ann.pubkey || !ann.scheme) return { ok: false, reason: 'annonce incomplète' };
  if (Date.now() - (ann.ts || 0) > maxAgeMs) return { ok: false, reason: 'annonce périmée' };
  const { sig, pubkey, scheme, ...body } = ann;
  const okSig = await verifyForScheme(scheme, unb64(pubkey), canonicalBytes(body), unb64(sig));
  return okSig ? { ok: true, nodeId: body.nodeId, profile: body.profile } : { ok: false, reason: 'signature invalide' };
}

// Annuaire des pairs : ingère les annonces VÉRIFIÉES, expose la liste au routeur.
export class MeshDirectory {
  #peers = new Map();   // nodeId → { ...profile, nodeId, ts }
  async ingest(ann, opts) {
    const v = await verifyAnnounce(ann, opts);
    if (!v.ok) return v;
    this.#peers.set(v.nodeId, { ...v.profile, nodeId: v.nodeId, ts: ann.ts });
    return v;
  }
  nodes({ maxAgeMs = 300000 } = {}) {
    const now = Date.now();
    return [...this.#peers.values()].filter(p => now - (p.ts || 0) <= maxAgeMs);
  }
  prune({ maxAgeMs = 300000 } = {}) {
    const now = Date.now(); let n = 0;
    for (const [id, p] of this.#peers) if (now - (p.ts || 0) > maxAgeMs) { this.#peers.delete(id); n++; }
    return n;
  }
  stats() { return { peers: this.#peers.size }; }
}

// Démo/validation autonome : `node mesh_fabric.js`  (Ed25519 ici ; Dilithium en prod)
if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    const A = (c, l) => { console.log((c ? '✓' : '✗ ÉCHEC'), l); if (!c) process.exit(1); };

    // ── (a) Routeur par capacité — trois profils ──
    const phone     = { npu: true, gpu: true, vramMB: 0, ramMB: 8000,  cores: 8,  adapters: ['t369-pilot'] };   // NPU/GPU mais pas de VRAM d'entraînement
    const pc        = { gpu: false, vramMB: 0, ramMB: 16000, cores: 16, adapters: [] };                          // i9 : CPU/RAM, pas de GPU
    const rentedGpu = { nodeId: 'gpu-cloud', gpu: true, vramMB: 24000, ramMB: 64000, adapters: [] };             // nœud GPU loué

    const rPhone = new CapabilityRouter(phone);
    A(rPhone.route(TaskKind.Inference, { adapter: 't369-pilot' }).where === 'local', 'routeur : inférence sur téléphone (adaptateur chaud) → local');
    A(rPhone.route(TaskKind.Training, { meshNodes: [rentedGpu] }).where === 'dispatch', 'routeur : entraînement sur téléphone → dispatch vers nœud GPU');
    A(rPhone.route(TaskKind.Training, { meshNodes: [] }).where === 'unavailable', 'routeur : entraînement sans GPU → indisponible (GPU loué requis)');

    const rPc = new CapabilityRouter(pc);
    A(rPc.route(TaskKind.Inference, { adapter: 'x', meshNodes: [{ nodeId: 'peer', ramMB: 16000, adapters: ['x'] }] }).where === 'mesh', 'routeur : adaptateur absent localement → mesh (nœud le tenant)');
    A(rPc.route(TaskKind.Data).where === 'local', 'routeur : données → local (collecte partout)');

    // ── (b) Poignée de main mesh signée ──
    const signer = await ed25519Signer();
    const beacon = new CapabilityBeacon(signer);
    const ann = beacon.announce({ nodeId: 'node-A', profile: { gpu: true, vramMB: 24000, ramMB: 64000 }, adapters: ['t369-pilot', 'dca'] });
    A(ann.scheme === 'ed25519' && ann.sig && ann.pubkey, 'mesh : annonce produite (schéma + signature + clé publique)');
    A((await verifyAnnounce(ann)).ok === true, 'mesh : annonce signée VÉRIFIÉE');
    const tampered = { ...ann, profile: { ...ann.profile, vramMB: 999999 } };
    A((await verifyAnnounce(tampered)).ok === false, 'mesh : annonce altérée → REJET (signature invalide)');

    // ── Bout en bout : l'annuaire alimente le routeur ──
    const dir = new MeshDirectory();
    await dir.ingest(ann);
    A(dir.nodes().length === 1, 'mesh : annuaire ingère le pair vérifié');
    const routed = new CapabilityRouter(pc).route(TaskKind.Training, { meshNodes: dir.nodes() });
    A(routed.where === 'dispatch' && routed.target === 'node-A', 'bout en bout : le PC route l\u2019entraînement vers le nœud GPU annoncé');

    console.log('✓ Fabric hétérogène (routeur par capacité + poignée de main mesh) — toutes les vérifs passent');
  })();
}
