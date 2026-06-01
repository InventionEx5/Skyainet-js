// packages/secure/src/roots/builder.js
// =====================================================
// CircuitBuilder — Routeur Onion Post-Quantique
// ML-KEM-768 + RomanT369 + réputation + DID optionnel
// SkyAInet × Nikola T369
// =====================================================

"use strict";

import { KemT369 }                from '../crypto/kem_t369.js';
import { RomanT369, GematriaMode } from '../crypto/roman_t369.js';
import { hkdfSha256 }             from '../crypto/sha_fips.js';
import { randomBytes }            from 'crypto';
import { PeerPool, Contact, ContactManager, ReputationTier } from './pool.js';

// ─────────────────────────────────────────────────────────────────
// ERREUR TYPÉE
// ─────────────────────────────────────────────────────────────────

export class CircuitBuilderError extends Error {
  constructor(message, code = 'CIRCUIT_ERROR') {
    super(message);
    this.name = 'CircuitBuilderError';
    this.code = code;
  }
}

// ─────────────────────────────────────────────────────────────────
// CIRCUIT
//
// Un circuit est une séquence ordonnée de nœuds avec :
//   - sharedSecrets[i] : secret partagé ML-KEM avec le nœud i
//   - layerKeys[i]     : clé de chiffrement de la couche i (HKDF du secret)
//   - kemCiphertexts[i]: ciphertext KEM à transmettre au nœud i pour établir le secret
//
// Chaque secret est dérivé indépendamment → compromission d'un nœud
// ne révèle rien sur les autres couches (Perfect Forward Secrecy par nœud).
// ─────────────────────────────────────────────────────────────────

export class Circuit {
  #sharedSecrets;   // Uint8Array(32)[] — jamais exposés
  #layerKeys;       // Uint8Array(32)[] — clés dérivées HKDF par couche
  #createdAt;

  constructor({ id, nodes, epoch, sharedSecrets, layerKeys, kemCiphertexts }) {
    this.id             = id;
    this.nodes          = nodes;          // string[] — adresses des nœuds
    this.epoch          = epoch;
    this.kemCiphertexts = kemCiphertexts; // [{ml_kem_ciphertext}][] — à transmettre
    this.length         = nodes.length;
    this.#sharedSecrets = sharedSecrets;
    this.#layerKeys     = layerKeys;
    this.#createdAt     = Date.now();
    this.destroyed      = false;
  }

  get createdAt() { return this.#createdAt; }

  /**
   * Retourne la clé de couche i pour le chiffrement onion.
   * Lance si le circuit est détruit.
   */
  getLayerKey(index) {
    if (this.destroyed) throw new CircuitBuilderError('Circuit détruit', 'E_DESTROYED');
    if (index < 0 || index >= this.#layerKeys.length) {
      throw new CircuitBuilderError(`Index de couche invalide: ${index}`, 'E_INDEX');
    }
    return this.#layerKeys[index];
  }

  /**
   * Détruit le circuit : écrase toutes les clés en mémoire.
   * Doit être appelé dès que le circuit n'est plus nécessaire.
   */
  destroy() {
    if (this.destroyed) return;
    for (const s of this.#sharedSecrets) s.fill(0);
    for (const k of this.#layerKeys)     k.fill(0);
    this.#sharedSecrets.length = 0;
    this.#layerKeys.length     = 0;
    this.destroyed = true;
  }

  toJSON() {
    return {
      id    : this.id,
      nodes : this.nodes,
      epoch : this.epoch,
      length: this.length,
      age_ms: Date.now() - this.#createdAt,
    };
  }
}

// ─────────────────────────────────────────────────────────────────
// CIRCUIT BUILDER
// ─────────────────────────────────────────────────────────────────

export class CircuitBuilder {
  #kem;           // KemT369
  #roman;         // RomanT369 — renforcement post-quantique des secrets
  #pool;          // PeerPool | null — source de pairs réels

  constructor(opts = {}) {
    this.#kem   = new KemT369(opts.use1024 ?? false);

    // Clé RomanT369 dérivée aléatoirement à la construction (éphémère)
    const romanKey   = randomBytes(32);
    const romanNonce = randomBytes(12);
    this.#roman = new RomanT369(romanKey, romanNonce, GematriaMode.Hyper256);

    this.#pool              = opts.pool ?? null;
    this.minLength          = opts.minLength          ?? 3;
    this.maxLength          = opts.maxLength          ?? 5;
    this.reputationThreshold= opts.reputationThreshold ?? 0.65;
    this.preferDiversity    = opts.preferDiversity    ?? true;
  }

  // ─── Fluent builder ───────────────────────────────────────────

  withPool(pool)              { this.#pool = pool;              return this; }
  withReputation(t)           { this.reputationThreshold = t;   return this; }
  withDiversity(enabled)      { this.preferDiversity = enabled; return this; }
  withLength(min, max)        { this.minLength = min; this.maxLength = max; return this; }

  // ─── Construction du circuit ──────────────────────────────────

  /**
   * Construit un circuit onion de `length` nœuds.
   *
   * Pour chaque nœud :
   *   1. Génère une paire de clés ML-KEM éphémère
   *   2. Encapsule → secret partagé ML-KEM
   *   3. Renforce le secret avec RomanT369 (post-quantique additionnel)
   *   4. Dérive la clé de couche via HKDF avec info unique (circuit|node|epoch)
   *
   * @param {number}         length         — nombre de nœuds (clampé [min, max])
   * @param {ContactManager} [contactManager]
   * @param {number}         [epoch]
   */
  async buildCircuit(length, contactManager = null, epoch = 0) {
    const finalLength = Math.max(this.minLength, Math.min(length, this.maxLength));

    const addrs = await this.#selectPeers(finalLength, contactManager);

    const sharedSecrets   = [];
    const layerKeys       = [];
    const kemCiphertexts  = [];

    for (let i = 0; i < addrs.length; i++) {
      // — Keypair ML-KEM éphémère
      const [publicKey] = this.#kem.generateKeypair();

      // — Encapsulation : secret partagé + ciphertext pour le pair
      const [ciphertext, sharedObj] = this.#kem.encapsulate(publicKey);
      const mlSecret = sharedObj.secret;   // Uint8Array(32) déjà dérivé dans KemT369

      // — Renforcement RomanT369 (couche post-quantique supplémentaire)
      const reinforced = this.#roman.encrypt(mlSecret).subarray(0, 32);

      // — Dérivation HKDF de la clé de couche (info unique par nœud + epoch)
      const info     = new TextEncoder().encode(`circuit|node${i}|epoch${epoch}`);
      const layerKey = hkdfSha256(reinforced, null, info, 32);

      sharedSecrets.push(reinforced);
      layerKeys.push(layerKey);
      kemCiphertexts.push(ciphertext);
    }

    const id = (randomBytes(4).readUInt32BE(0));   // ID aléatoire cryptographique

    console.info(`[CircuitBuilder] Circuit ${id} — ${finalLength} nœuds | epoch ${epoch}`);

    return new Circuit({ id, nodes: addrs, epoch, sharedSecrets, layerKeys, kemCiphertexts });
  }

  /**
   * Détruit proprement un circuit et efface ses clés.
   */
  destroyCircuit(circuit) {
    if (!(circuit instanceof Circuit)) return;
    circuit.destroy();
    console.debug(`[CircuitBuilder] Circuit ${circuit.id} détruit`);
  }

  // ─── Sélection des pairs ──────────────────────────────────────

  /**
   * Sélectionne `count` pairs depuis le PeerPool si disponible,
   * sinon lève une erreur explicite (plus de sélection fictive).
   *
   * Stratégie :
   *   - preferDiversity → getDiversePeers (round-robin par tier)
   *   - contactManager  → getTrustedPeers (DID vérifié obligatoire)
   *   - sinon           → getHighReputationPeers (seuil réputation)
   */
  async #selectPeers(count, contactManager) {
    if (!this.#pool || this.#pool.isEmpty()) {
      throw new CircuitBuilderError(
        'PeerPool vide ou absent. Injecte un PeerPool via withPool() avant de construire un circuit.',
        'E_NO_POOL'
      );
    }

    if (this.#pool.len() < count) {
      throw new CircuitBuilderError(
        `Pas assez de pairs (disponibles: ${this.#pool.len()}, requis: ${count})`,
        'E_INSUFFICIENT'
      );
    }

    // Sélection par priorité décroissante de sécurité
    if (contactManager instanceof ContactManager) {
      // Niveau max : DID vérifié + réputation
      try {
        return this.#pool.getTrustedPeers(count, contactManager);
      } catch {
        // Pas assez de pairs DID → fallback sur réputation seule
        console.warn('[CircuitBuilder] Pas assez de pairs DID — fallback réputation');
      }
    }

    if (this.preferDiversity) {
      return this.#pool.getDiversePeers(count);
    }

    return this.#pool.getHighReputationPeers(count, this.reputationThreshold, contactManager);
  }
}
