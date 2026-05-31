// packages/node/src/skyainet_node.js
// SkyAInetNode — Nœud Intelligent & Souverain
// Gematria Flash Core + Zip Memory + Modèle Économique Avancé
// Intégré avec PeerPool + PeerReputation + NodeAttestation

import { randomBytes } from 'crypto';
import { PeerPool } from '../../secure/src/roots/pool.js';
import { PeerReputation } from '../../secure/src/roots/reputation.js';
import { NodeAttestation } from '../../secure/src/roots/attestation.js';

// =====================================================
// ENUMS
// =====================================================
export const NodeTier = { Mini: 0, Light: 1, Full: 2, DreamWeaver: 3 };
export const NodeType = { Validator: 'Validator', Storage: 'Storage', Compute: 'Compute', Mixed: 'Mixed', Edge: 'Edge' };
export const NodeRole = { Validator: 'Validator', Storage: 'Storage', Compute: 'Compute', Full: 'Full', Edge: 'Edge' };
export const NodeState = { Initializing: 'Initializing', Active: 'Active', Sleeping: 'Sleeping', Stopped: 'Stopped' };
export const SubscriptionLevel = { Free: 'Free', Pro: 'Pro', Validator: 'Validator', DreamWeaver: 'DreamWeaver' };

// =====================================================
// SUPPORTING CLASSES (stubs optimisés)
// =====================================================
class PoUWEngine {
  constructor() { this.totalScore = 0; }
  get_total_score() { return this.totalScore; }
  record_contribution(score) { this.totalScore = Math.min(100, this.totalScore + score); }
}

class DreamScoring {
  constructor() { this.totalScore = 0; }
  get_total_score() { return this.totalScore; }
  record_dream(quality) { this.totalScore = Math.min(100, this.totalScore + quality * 12); }
}

class ZipMemory {
  constructor(path) {
    this.path = path;
    this.items = new Map();
    this.compressionRatio = 2.85;
  }
  async compress_inactive_data() { return true; }
  async decompress_on_demand() { return true; }
  get_stats() { return { compression_ratio: this.compressionRatio, items_stored: this.items.size }; }
  get_saved_space_mb() { return 128.4; }
}

class NodeCommunication {
  constructor(peerId, peerPool = null) {
    this.peerId = peerId;
    this.messages = [];
    this.peerPool = peerPool;
  }
  async broadcast_lesson(lesson, quality) {
    this.messages.push({ lesson, quality, ts: new Date() });
    if (this.peerPool) {
      this.peerPool.updateReputation(this.peerId, 0.01);
    }
  }
  async receive_remote_lesson(data) {
    if (this.peerPool && data?.nodeId) {
      const rep = new PeerReputation();
      rep.recordSuccess(0.03);
      this.peerPool.updateReputation(data.nodeId, rep.score);
    }
    return { proof: data };
  }
}

// =====================================================
// NODE ECONOMICS
// =====================================================
class NodeEconomics {
  constructor(tier) {
    this.tier = tier;
    this.is_renting_out = false;
    this.monthly_earnings = 0;
    this.last_rent_update = new Date();
  }
  rent_out() { this.is_renting_out = true; this.last_rent_update = new Date(); }
  estimated_monthly_earnings() {
    return [120, 850, 2450, 6200][this.tier] || 0;
  }
}

// =====================================================
// NODE METADATA
// =====================================================
class NodeMetadata {
  constructor(id, nodeType, role, subscription, capabilities) {
    this.id = id;
    this.node_type = nodeType;
    this.node_role = role;
    this.subscription_level = subscription;
    this.peer_id = `peer-${id.slice(0, 16)}`;
    this.capabilities = capabilities;
    this.reputation_score = subscription !== SubscriptionLevel.Free ? 0.78 : 0.62;
    this.last_active = new Date();
    this.dream_contributions = 0;
    this.total_pouw_score = 0.0;
    this.zip_memory_enabled = true;
    this.created_at = new Date();
    this.is_paid = subscription !== SubscriptionLevel.Free;
  }
}

// =====================================================
// ETHICAL SCORE
// =====================================================
class EthicalScore {
  constructor() {
    this.benevolence = 0.98;
    this.truthfulness = 0.97;
    this.non_malice = 0.99;
    this.sovereignty = 0.96;
    this.overall = 0.975;
  }
}

// =====================================================
// SKYAINETNODE — CLASSE PRINCIPALE (optimisée)
// =====================================================
export class SkyAInetNode {
  #peerPool;

  constructor(nodeType, role, subscription, capabilities) {
    const id = randomBytes(32).toString('hex');
    const isPaid = subscription !== SubscriptionLevel.Free;
    const tier = isPaid ? NodeTier.Full : NodeTier.Mini;

    this.metadata = new NodeMetadata(id, nodeType, role, subscription, capabilities);
    this.ethical_score = new EthicalScore();
    this.state = NodeState.Initializing;
    this.pouw_engine = new PoUWEngine();
    this.dream_scoring = new DreamScoring();
    this.economics = new NodeEconomics(tier);
    this.zip_memory = null;
    this.#peerPool = new PeerPool().withMinReputation(0.65);
    this.communication = new NodeCommunication(this.metadata.peer_id, this.#peerPool);

    this.total_messages_processed = 0;
    this.total_bytes_stored = 0;
    this.last_flash_gematria = null;
    this.external_ai_enabled = false;

    // === SHIMS DE COMPATIBILITÉ SERVEUR ===
    this.id = this.metadata.peer_id;
    this.is_running = false;
    this.wisdom_score = this.metadata.reputation_score;
    this.peers = [];
    this.registered_ais = new Map([['ai-t369', { model: 'T369Inference' }], ['ai-lora', {}]]);
    this.message_bus = [];
    this.evolution_cycles = 12;
    this.last_dream_cycle = new Date().toISOString();

    const origUpdate = this.update_overall_score.bind(this);
    this.update_overall_score = () => {
      origUpdate();
      this.wisdom_score = this.metadata.reputation_score;
      this.total_requests = this.total_messages_processed;
    };

    this.run_real_dream_cycle = async () => {
      this.dream_scoring.record_dream(0.96);
      this.update_overall_score();
      this.last_dream_cycle = new Date().toISOString();
      this.evolution_cycles++;
      return `Cycle de rêve terminé. Sagesse: ${this.wisdom_score.toFixed(3)}`;
    };

    this.generate_with_ai = async (payload) => {
      this.total_messages_processed++;
      const prompt = payload.prompt || payload.message || 'Requête';
      return `🤖 T369 + Gematria Flash → Réponse pour "${prompt}"`;
    };

    this.send_message = (from, to, content) => {
      if (!from || !to) throw new Error("Champs 'from' et 'to' requis");
      const msg = { from, to, content, timestamp: new Date().toISOString() };
      this.message_bus.push(msg);
      if (this.message_bus.length > 100) this.message_bus.shift();
      return `Message envoyé de ${from} à ${to}`;
    };

    this.enable_external_ai = (enabled) => { this.external_ai_enabled = !!enabled; };

    this.storage = new Map();
    this.upload_file = (name, data) => {
      const id = `file-\( {Date.now()}- \){Math.random().toString(36).slice(2, 9)}`;
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      this.storage.set(id, { id, name, data: buf, size: buf.length, uploaded_at: new Date().toISOString() });
      return id;
    };
    this.list_files = () => Array.from(this.storage.values()).map(f => ({
      id: f.id, name: f.name, size_bytes: f.size, uploaded_at: f.uploaded_at
    }));
    this.download_file = (file_id) => {
      const f = this.storage.get(file_id);
      if (!f) throw new Error('Fichier non trouvé');
      return { file_id, name: f.name, size_bytes: f.size, data: f.data.toString('base64') };
    };
    this.delete_file = (file_id) => {
      if (!this.storage.has(file_id)) throw new Error('Fichier non trouvé');
      this.storage.delete(file_id);
      return true;
    };
  }

  // === GETTERS ===
  get peerPool() { return this.#peerPool; }

  // === CYCLE DE VIE ===
  async start() {
    if (this.state === NodeState.Active) return;
    if (this.metadata.zip_memory_enabled) {
      this.zip_memory = new ZipMemory(`./data/node_${this.metadata.id.slice(0, 16)}`);
    }
    this.state = NodeState.Active;
    this.metadata.last_active = new Date();
    this.is_running = true;
    console.log(`🟢 SkyAInetNode démarré | Tier: ${this.metadata.is_paid ? 'PRO' : 'FREE'} | Zip Memory: ON`);
  }

  async sleep() {
    if (this.state === NodeState.Sleeping) return;
    if (this.zip_memory) await this.zip_memory.compress_inactive_data();
    this.state = NodeState.Sleeping;
    this.is_running = false;
  }

  async wake() {
    if (this.state !== NodeState.Sleeping) return;
    if (this.zip_memory) await this.zip_memory.decompress_on_demand();
    this.state = NodeState.Active;
    this.metadata.last_active = new Date();
    this.is_running = true;
  }

  // === MODÈLE ÉCONOMIQUE ===
  can_upgrade() { return !this.metadata.is_paid && this.metadata.reputation_score > 0.80; }
  monthly_cost() { return this.metadata.subscription_level === SubscriptionLevel.Pro ? 29 : null; }
  storage_limit_gb() { return this.metadata.subscription_level === SubscriptionLevel.Pro ? 500 : 50; }

  async upgrade_to_paid(newLevel) {
    if (this.metadata.is_paid) throw new Error("Déjà payant");
    if (!this.can_upgrade()) throw new Error("Réputation insuffisante (minimum 0.80 requis)");
    this.metadata.subscription_level = newLevel;
    this.metadata.is_paid = true;
    this.metadata.capabilities = { bandwidth_mbps: 200, compute_power: 1.5, storage_gb: 500 };
  }

  calculate_paid_bonus() { return this.metadata.is_paid ? (this.metadata.subscription_level === SubscriptionLevel.Validator ? 1.5 : 1.25) : 1.0; }
  upgrade(newTier) { if (newTier > this.economics.tier) this.economics.tier = newTier; }
  rent_out_compute() { this.economics.rent_out(); }
  get_estimated_earnings() { return this.economics.estimated_monthly_earnings(); }

  // === ZIP MEMORY + LOW POWER ===
  set_zip_memory(enabled) { this.metadata.zip_memory_enabled = enabled; }
  async enter_low_power_mode() {
    if (this.metadata.node_type === NodeType.Mini) {
      await this.sleep();
      this.set_zip_memory(true);
      if (this.metadata.capabilities) this.metadata.capabilities.bandwidth_mbps = 25;
    }
  }
  async exit_low_power_mode() { await this.wake(); }
  async compress_inactive_data() { if (this.zip_memory) await this.zip_memory.compress_inactive_data(); }
  async get_compression_stats() {
    if (!this.zip_memory) return null;
    const s = this.zip_memory.get_stats();
    return `Compression: ${s.compression_ratio}x | Économie: ${this.zip_memory.get_saved_space_mb()} MB | Items: ${s.items_stored}`;
  }

  // === COMMUNICATION & GEMATRIA (avec PeerPool) ===
  async broadcast_lesson(lesson) {
    if (!this.communication) return;
    await this.communication.broadcast_lesson(lesson, 0.85);
    if (this.#peerPool) {
      this.#peerPool.updateReputation(this.metadata.peer_id, 0.015);
    }
  }

  async receive_remote_lesson(data) {
    if (!this.communication) return null;
    const result = await this.communication.receive_remote_lesson(data);
    return result;
  }

  async trigger_flash_gematria() { this.last_flash_gematria = new Date(); }

  // === ATTESTATION D'IDENTITÉ (NodeAttestation) ===
  createAttestation(signer) {
    if (!signer) throw new Error('Dilithium5Signer requis');
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = signer.sign(Buffer.from(this.metadata.peer_id));
    return NodeAttestation.create(
      Buffer.from(this.metadata.id, 'hex'),
      signer.publicKeyBytes(),
      signature,
      0,
      null
    );
  }

  verifyAttestation(attestation, signer, contactManager = null) {
    if (!attestation || !signer) return false;
    try {
      return attestation.verify(signer, contactManager);
    } catch {
      return false;
    }
  }

  // === MISE À JOUR & SANTÉ ===
  update_overall_score() {
    const pouw = this.pouw_engine.get_total_score();
    const dream = this.dream_scoring.get_total_score();
    this.metadata.total_pouw_score = (pouw * 0.65) + (dream * 0.35);
    const decay = this.metadata.is_paid ? 0.998 : 0.992;
    this.metadata.reputation_score = Math.max(0.1, Math.min(1.0,
      (this.metadata.reputation_score * decay) + (this.metadata.total_pouw_score * 0.22) + (this.metadata.dream_contributions * 0.0015)
    ));
    this.wisdom_score = this.metadata.reputation_score;
  }

  record_activity(bytes) {
    this.metadata.last_active = new Date();
    this.total_messages_processed++;
    this.total_bytes_stored += bytes;
    this.ethical_score.overall = (this.ethical_score.overall * 0.985) + 0.015;
  }

  health_report() {
    const tier = this.metadata.is_paid ? 'PRO' : 'FREE';
    return `Node ${this.metadata.peer_id} | Tier: ${tier} | État: ${this.state} | Réputation: ${this.metadata.reputation_score.toFixed(2)} | Messages: ${this.total_messages_processed}`;
  }
}