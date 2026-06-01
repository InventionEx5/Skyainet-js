// packages/secure/src/protocol/handshake.js
// =====================================================
// Handshake Hybride — Négociation Intelligente
// ML-KEM + RomanT369 + SHA-256 + Dilithium5
// SkyAInet × Nikola T369
// =====================================================

"use strict";

import { createHash, randomBytes }         from 'crypto';
import { HybridTransport, HybridMode }    from '../crypto/hybrid.js';
import { KemT369 }                        from '../crypto/kem_t369.js';
import { RomanT369, GematriaMode }        from '../crypto/roman_t369.js';
import { Dilithium5Signer }               from '../crypto/dilithium.js';
import { hkdfSha256 }                     from '../crypto/sha_fips.js';
import { Contact }                        from '../roots/pool.js';

// ─────────────────────────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────────────────────────

const PROTOCOL_VERSION   = 0x07;
const TIMESTAMP_SKEW_S   = 30;    // tolérance de désync horloge

// ─────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────

export const NodeRole = Object.freeze({
  Core     : 'Core',
  Edge     : 'Edge',
  Validator: 'Validator',
});

export const CryptoSuite = Object.freeze({
  KemT369          : 'KemT369',
  RomanT369        : 'RomanT369',
  HybridFlash      : 'HybridFlash',
  PostQuantumHybrid: 'PostQuantumHybrid',
});

// ─────────────────────────────────────────────────────────────────
// HANDSHAKE MESSAGE
// ─────────────────────────────────────────────────────────────────

export class HandshakeMessage {
  constructor(data = {}) {
    this.version           = data.version           ?? PROTOCOL_VERSION;
    this.ephemeralPublic   = data.ephemeralPublic   ?? new Uint8Array(32); // nonce éphémère local
    this.mlKemPublic       = data.mlKemPublic       ?? new Uint8Array(0);  // clé publique ML-KEM
    this.is1024            = data.is1024            ?? false;
    this.nodeId            = data.nodeId            ?? new Uint8Array(32);
    this.nodeRole          = data.nodeRole          ?? NodeRole.Core;
    this.supportedSuites   = data.supportedSuites   ?? [];
    this.preferredMode     = data.preferredMode     ?? HybridMode.KemT369Core;
    this.timestamp         = data.timestamp         ?? Math.floor(Date.now() / 1000);
    this.signature         = data.signature         ?? new Uint8Array(0);
    this.contactAlias      = data.contactAlias      ?? null;   // alias du contact si DID actif
  }

  /**
   * Sérialise le message en bytes pour la signature et le transcript.
   * Tous les champs sauf signature sont inclus pour éviter la malléabilité.
   */
  toSignBytes() {
    const parts = [
      new Uint8Array([this.version]),
      this.ephemeralPublic,
      this.mlKemPublic,
      new Uint8Array([this.is1024 ? 1 : 0]),
      this.nodeId,
      new TextEncoder().encode(this.nodeRole),
      new TextEncoder().encode(this.preferredMode),
      new Uint8Array(new DataView(new ArrayBuffer(8)).buffer).fill(0),  // timestamp LE-64
    ];
    // Encode timestamp en LE-64
    const tsView = new DataView(parts[7].buffer);
    tsView.setBigUint64(0, BigInt(this.timestamp), true);

    const total = parts.reduce((s, p) => s + p.length, 0);
    const out   = new Uint8Array(total);
    let   off   = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    return out;
  }
}

// ─────────────────────────────────────────────────────────────────
// HANDSHAKE
//
// Négociation en deux temps :
//   Initiateur → createInitialMessage() → envoie HandshakeMessage
//   Répondeur  → processResponse(msg)   → retourne [mode, sessionKey]
//
// Clé de session dérivée :
//   1. Transcrit SHA-256 des deux messages (replay protection)
//   2. Secret partagé ML-KEM (encapsulé dans la réponse)
//   3. HKDF-SHA256(kemSecret ‖ transcript, info="handshake-v7")
//   4. Renforcement RomanT369 Hyper256 (post-quantique additionnel)
//
// La signature Dilithium5 est optionnelle — activée si un signer est injecté.
// ─────────────────────────────────────────────────────────────────

export class Handshake {
  #kem;               // KemT369
  #kemKeypair;        // { publicKey, secretKey } — paire éphémère locale
  #ephemeral;         // Uint8Array(32) — nonce éphémère (proxy X25519)
  #transcript;        // createHash('sha256') — transcrit du handshake
  #hybridEngine;      // HybridTransport
  #signer;            // Dilithium5Signer | null
  #roman;             // RomanT369 — renforcement final

  constructor(localRole = NodeRole.Core, signer = null) {
    this.localRole    = localRole;
    this.chosenMode   = localRole === NodeRole.Edge
      ? HybridMode.FullGematria
      : HybridMode.KemT369Core;

    this.#kem         = new KemT369(false);
    this.#kemKeypair  = this.#kem.generateKeypair();
    this.#ephemeral   = randomBytes(32);
    this.#transcript  = createHash('sha256');
    this.#signer      = signer instanceof Dilithium5Signer ? signer : null;

    this.#hybridEngine = new HybridTransport(false);
    this.#hybridEngine.setMode(this.chosenMode);

    // Clé RomanT369 éphémère dérivée de l'éphémère local
    const romanKey   = hkdfSha256(this.#ephemeral, null, new TextEncoder().encode('handshake-roman'), 32);
    const romanNonce = this.#ephemeral.subarray(0, 12);
    this.#roman      = new RomanT369(romanKey, romanNonce, GematriaMode.Hyper256);
  }

  // ─── Création du message initial ─────────────────────────────

  /**
   * Crée le message de handshake initial.
   * Si un signer Dilithium5 est fourni, le message est signé.
   *
   * @param {Uint8Array}   nodeId
   * @param {Contact|null} contact — Contact optionnel pour l'alias DID
   * @returns {HandshakeMessage}
   */
  createInitialMessage(nodeId, contact = null) {
    const [kemPublic] = this.#kemKeypair;

    const msg = new HandshakeMessage({
      version        : PROTOCOL_VERSION,
      ephemeralPublic: new Uint8Array(this.#ephemeral),
      mlKemPublic    : kemPublic.ml_kem_public,
      is1024         : kemPublic.is_1024,
      nodeId         : nodeId instanceof Uint8Array ? nodeId : new Uint8Array(nodeId),
      nodeRole       : this.localRole,
      supportedSuites: Object.values(CryptoSuite),
      preferredMode  : this.chosenMode,
      timestamp      : Math.floor(Date.now() / 1000),
      contactAlias   : contact?.alias ?? null,
    });

    // Signature Dilithium5 (optionnelle)
    if (this.#signer) {
      msg.signature = this.#signer.sign(msg.toSignBytes());
    }

    // Mise à jour du transcrit
    this.#transcript.update(msg.toSignBytes());

    return msg;
  }

  // ─── Traitement de la réponse ─────────────────────────────────

  /**
   * Traite la réponse du pair et dérive la clé de session finale.
   *
   * @param {HandshakeMessage} msg — message reçu du pair
   * @returns {[string, Uint8Array]} — [chosenMode, sessionKey(32)]
   */
  processResponse(msg) {
    // — Validation du timestamp (anti-replay)
    const now  = Math.floor(Date.now() / 1000);
    const skew = Math.abs(now - msg.timestamp);
    if (skew > TIMESTAMP_SKEW_S) {
      throw new HandshakeError(
        `Timestamp trop décalé (${skew}s > ${TIMESTAMP_SKEW_S}s)`,
        'E_TIMESTAMP'
      );
    }

    // — Négociation du mode
    this.chosenMode = this.#negotiateMode(msg.preferredMode);
    this.#hybridEngine.setMode(this.chosenMode);

    // — Mise à jour du transcrit avec le message du pair
    this.#transcript.update(msg.toSignBytes());
    const transcriptHash = this.#transcript.copy().digest();

    // — Secret partagé ML-KEM : encapsuler avec la clé publique du pair
    const peerKemPub = {
      ml_kem_public: msg.mlKemPublic,
      is_1024      : msg.is1024,
    };

    let kemSecret;
    try {
      const [, shared] = this.#kem.encapsulate(peerKemPub);
      kemSecret = shared.secret;
    } catch (e) {
      throw new HandshakeError(`Encapsulation ML-KEM échouée: ${e.message}`, 'E_KEM');
    }

    // — Dérivation HKDF : kemSecret ‖ transcript → sessionKey
    const ikm        = new Uint8Array(kemSecret.length + transcriptHash.length);
    ikm.set(kemSecret,      0);
    ikm.set(transcriptHash, kemSecret.length);

    const derived    = hkdfSha256(ikm, null, new TextEncoder().encode('handshake-v7'), 32);

    // — Renforcement RomanT369 (post-quantique additionnel)
    const sessionKey = this.#roman.encrypt(derived).subarray(0, 32);

    console.info(`[Handshake] ✅ Mode négocié: ${this.chosenMode} | sessionKey: ${sessionKey.length}B`);

    return [this.chosenMode, sessionKey];
  }

  // ─── Privés ───────────────────────────────────────────────────

  #negotiateMode(remotePreferred) {
    if (this.localRole === NodeRole.Edge) return HybridMode.FullGematria;

    if (this.localRole === NodeRole.Core) {
      // Core accepte FullGematria d'un Edge en dégradant vers FlashGematria
      if (remotePreferred === HybridMode.FullGematria) return HybridMode.FlashGematria;
      return remotePreferred ?? HybridMode.KemT369Core;
    }

    // Validator : toujours KemT369Core (sécurité maximale, pas de gematria seule)
    return HybridMode.KemT369Core;
  }
}

// ─────────────────────────────────────────────────────────────────
// ERREUR TYPÉE
// ─────────────────────────────────────────────────────────────────

export class HandshakeError extends Error {
  constructor(message, code = 'HANDSHAKE_ERROR') {
    super(message);
    this.name = 'HandshakeError';
    this.code = code;
  }
}
