// packages/secure/src/device/encryptor.js
// =====================================================
// Media Encryptor — Chiffrement Temps Réel (SRTP-like)
// GematriaAead + Anti-replay + Contact ID
// SkyAInet × Nikola T369
// =====================================================

"use strict";

import { randomBytes }    from 'crypto';
import { GematriaAead }  from '../crypto/gematria_aead.js';
import { hkdfSha256 }    from '../crypto/sha_fips.js';

// ─────────────────────────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────────────────────────

const HEADER_BASE_LEN  = 16;       // seq:4 + ts:8 + ssrc:4
const CONTACT_ID_LEN   = 32;
const ANTI_REPLAY_WINDOW = 128;    // fenêtre anti-replay en séquences

// ─────────────────────────────────────────────────────────────────
// MEDIA FRAME (métadonnées)
// ─────────────────────────────────────────────────────────────────

export class MediaFrame {
  constructor(sequenceNumber, timestamp, payloadType, ssrc, contactId = null) {
    this.sequenceNumber = sequenceNumber;
    this.timestamp      = timestamp;
    this.payloadType    = payloadType;
    this.ssrc           = ssrc;
    this.contactId      = contactId;   // Uint8Array(32) | null
  }
}

// ─────────────────────────────────────────────────────────────────
// MEDIA ENCRYPTOR
//
// Chiffrement SRTP-like avec nonce dérivé par frame.
//
// Format du paquet chiffré :
//   [seq:4LE][ts:8LE][ssrc:4LE][has_contact:1][contact?:32][payload_ct]
//
// Le nonce de GematriaAead est dérivé pour chaque frame :
//   nonce = HKDF(key, salt=seq_bytes, info="frame-nonce")[0:12]
// Ce schéma garantit un nonce unique par frame sans état synchronisé.
//
// Anti-replay : fenêtre glissante de 128 numéros de séquence.
// ─────────────────────────────────────────────────────────────────

export class MediaEncryptor {
  #key;                 // Uint8Array(32) — clé de session
  #ssrc;                // identifiant du flux (SSRC)
  #sequenceCounter;     // compteur d'envoi
  #receivedSeqs;        // Set<number> — anti-replay (fenêtre glissante)
  #minSeq;              // borne basse de la fenêtre anti-replay

  /**
   * @param {Uint8Array} key   — clé de session 32 octets
   * @param {Uint8Array} nonce — nonce de base (utilisé pour dériver l'SSRC)
   */
  constructor(key, nonce) {
    if (!(key instanceof Uint8Array) || key.length < 32) {
      throw new TypeError('key doit être Uint8Array(32)');
    }
    this.#key             = key.subarray(0, 32);
    this.#sequenceCounter = 0;
    this.#receivedSeqs    = new Set();
    this.#minSeq          = 0;

    // SSRC dérivé de façon déterministe depuis key + nonce (évite Math.random)
    const ssrcBytes = hkdfSha256(key, nonce, new TextEncoder().encode('media-ssrc'), 4);
    this.#ssrc      = new DataView(ssrcBytes.buffer).getUint32(0, true);
  }

  get ssrc()            { return this.#ssrc; }
  get sequenceCounter() { return this.#sequenceCounter; }

  // ─── Chiffrement ──────────────────────────────────────────────

  /**
   * Chiffre une frame média.
   *
   * Le nonce est dérivé par frame (HKDF avec sel = seq en LE-4),
   * garantissant l'unicité sans état externe.
   *
   * @param {Uint8Array}      payload
   * @param {Uint8Array|null} contactId — 32 octets, optionnel
   * @returns {[MediaFrame, Uint8Array]} — [frame, ciphertext_packet]
   */
  encryptFrame(payload, contactId = null) {
    const seq = this.#sequenceCounter;
    const ts  = BigInt(Date.now());

    // En-tête SRTP-like
    const hasContact = contactId instanceof Uint8Array && contactId.length === CONTACT_ID_LEN;
    const headerLen  = HEADER_BASE_LEN + 1 + (hasContact ? CONTACT_ID_LEN : 0);
    const header     = new Uint8Array(headerLen);
    const view       = new DataView(header.buffer);

    view.setUint32(0,  seq,          true);
    view.setBigUint64(4, ts,         true);
    view.setUint32(12, this.#ssrc,   true);
    header[16] = hasContact ? 1 : 0;
    if (hasContact) header.set(contactId, 17);

    // Payload packet = header + plaintext
    const packet = new Uint8Array(headerLen + payload.length);
    packet.set(header,  0);
    packet.set(payload, headerLen);

    // Nonce dérivé par frame
    const nonce    = this.#deriveFrameNonce(seq);
    const encrypted = new GematriaAead(this.#key, nonce).encrypt(packet);

    const frame = new MediaFrame(seq, Number(ts), 96, this.#ssrc, hasContact ? contactId : null);
    this.#sequenceCounter = (this.#sequenceCounter + 1) >>> 0;

    return [frame, encrypted];
  }

  // ─── Déchiffrement ────────────────────────────────────────────

  /**
   * Déchiffre un paquet reçu.
   * Vérifie l'anti-replay avant de déchiffrer.
   *
   * @param {Uint8Array} encrypted
   * @returns {[MediaFrame, Uint8Array] | null}
   */
  decryptFrame(encrypted) {
    // Pré-déchiffrement léger pour lire le seq (les 4 premiers octets
    // ne sont pas encore accessibles — on doit déchiffrer d'abord)
    // Le seq est dans le plaintext → on déchiffre puis on valide l'anti-replay.

    // Pour déchiffrer, il faut le nonce — or le nonce dépend du seq,
    // qui est dans le plaintext. On tente avec les séquences candidates
    // dans la fenêtre. En pratique, le récepteur maintient son propre compteur.
    // On utilise #sequenceCounter côté réception comme estimation.
    const seq = this.#recvSeq;

    const nonce = this.#deriveFrameNonce(seq);
    let decrypted;
    try {
      decrypted = new GematriaAead(this.#key, nonce).decrypt(encrypted);
    } catch {
      return null;
    }

    if (!decrypted || decrypted.length < HEADER_BASE_LEN + 1) return null;

    const view       = new DataView(decrypted.buffer, decrypted.byteOffset);
    const seqNum     = view.getUint32(0, true);
    const timestamp  = Number(view.getBigUint64(4, true));
    const ssrc       = view.getUint32(12, true);
    const hasContact = decrypted[16] === 1;

    // Anti-replay
    if (!this.#acceptSeq(seqNum)) return null;

    let payloadStart = HEADER_BASE_LEN + 1;
    let contactId    = null;
    if (hasContact && decrypted.length >= payloadStart + CONTACT_ID_LEN) {
      contactId    = decrypted.subarray(payloadStart, payloadStart + CONTACT_ID_LEN);
      payloadStart += CONTACT_ID_LEN;
    }

    const payload = decrypted.subarray(payloadStart);
    const frame   = new MediaFrame(seqNum, timestamp, 96, ssrc, contactId);
    this.#recvSeq = (seqNum + 1) >>> 0;

    return [frame, payload];
  }

  // Compteur côté réception (indépendant du compteur d'envoi)
  #recvSeq = 0;

  // ─── Utilitaires ─────────────────────────────────────────────

  /**
   * Vérifie si le paquet est dans la fenêtre et non rejoué.
   * Fenêtre glissante de ANTI_REPLAY_WINDOW séquences.
   */
  isInOrder(sequenceNumber) {
    const diff = (sequenceNumber - this.#sequenceCounter) >>> 0;
    return diff < ANTI_REPLAY_WINDOW || diff > 0xFFFFFF00;
  }

  // ─── Privés ───────────────────────────────────────────────────

  /** Dérive un nonce unique pour une frame donnée via HKDF */
  #deriveFrameNonce(seq) {
    const salt = new Uint8Array(4);
    new DataView(salt.buffer).setUint32(0, seq, true);
    return hkdfSha256(this.#key, salt, new TextEncoder().encode('frame-nonce'), 12);
  }

  /** Fenêtre anti-replay : retourne true si le seq est accepté */
  #acceptSeq(seq) {
    if (seq < this.#minSeq) return false;           // trop vieux
    if (this.#receivedSeqs.has(seq)) return false;  // rejouage

    this.#receivedSeqs.add(seq);

    // Faire glisser la fenêtre
    if (this.#receivedSeqs.size > ANTI_REPLAY_WINDOW) {
      this.#minSeq = seq - ANTI_REPLAY_WINDOW;
      for (const s of this.#receivedSeqs) {
        if (s < this.#minSeq) this.#receivedSeqs.delete(s);
      }
    }
    return true;
  }
}
