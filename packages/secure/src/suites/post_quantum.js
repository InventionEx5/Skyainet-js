// packages/secure/src/suites/post_quantum.js
// =====================================================
// Post-Quantum Suite — ML-KEM-768/1024 + RomanT369 Hyper256
// SkyAInet × Nikola T369
// =====================================================

"use strict";

import { randomBytes }                from 'crypto';
import { KemT369 }                   from '../crypto/kem_t369.js';
import { RomanT369, GematriaMode }   from '../crypto/roman_t369.js';

// ─────────────────────────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────────────────────────

// ML-KEM-768 : secretKey = 2400 B, ML-KEM-1024 : secretKey = 3168 B
const MIN_SECRET_KEY_LEN = 2400;
const NONCE_LEN          = 12;

// ─────────────────────────────────────────────────────────────────
// ERREUR TYPÉE
// ─────────────────────────────────────────────────────────────────

export class PostQuantumError extends Error {
  constructor(message, code = 'PQ_ERROR') {
    super(message);
    this.name = 'PostQuantumError';
    this.code = code;
  }
}

// ─────────────────────────────────────────────────────────────────
// POST-QUANTUM SUITE
//
// Chiffrement hybride en deux couches :
//   1. ML-KEM (KemT369) — échange de clé post-quantique
//      → produit un sharedSecret dérivé via RomanT369 interne
//   2. RomanT369 Hyper256 — chiffrement symétrique du payload
//      avec nonce aléatoire frais à chaque message
//
// Format ciphertext : [nonce:12][roman_ct]
// Le kemCiphertext est retourné séparément (à transmettre au pair).
//
// Bug original corrigé :
//   - `secretKey.length !== 32` → ML-KEM-768 produit 2400 octets
//   - nonce nul fixe → nonce aléatoire frais, sérialisé dans le ct
// ─────────────────────────────────────────────────────────────────

export class PostQuantumSuite {
  #kem;
  #is1024;

  /**
   * @param {boolean} is1024 — ML-KEM-1024 (plus sûr, plus lent) ou ML-KEM-768 (défaut)
   */
  constructor(is1024 = false) {
    this.name    = 'PostQuantum';
    this.#kem    = new KemT369(!!is1024);
    this.#is1024 = !!is1024;
  }

  // ─── Gestion des clés ─────────────────────────────────────────

  /**
   * Génère une paire de clés ML-KEM.
   * @returns {[publicKey, secretKey]} — publicKey = { ml_kem_public, is_1024 }
   */
  generateKeypair() {
    return this.#kem.generateKeypair();
  }

  // ─── Chiffrement ──────────────────────────────────────────────

  /**
   * Chiffre un message avec ML-KEM + RomanT369 Hyper256.
   *
   * Étapes :
   *   1. Encapsulation ML-KEM → [kemCiphertext, sharedSecret]
   *   2. Nonce aléatoire frais (12 octets)
   *   3. RomanT369(sharedSecret, nonce, Hyper256).encrypt(plaintext)
   *   4. Enveloppe = [nonce:12][roman_ct]
   *
   * @param {{ ml_kem_public: Uint8Array, is_1024: boolean }} publicKey
   * @param {Uint8Array}   plaintext
   * @param {object|null}  contact    — Contact optionnel (log)
   * @returns {[kemCt, Uint8Array]}   — [kemCiphertext, enveloppe chiffrée]
   */
  encrypt(publicKey, plaintext, contact = null) {
    if (!publicKey?.ml_kem_public) {
      throw new PostQuantumError('Clé publique ML-KEM invalide (ml_kem_public manquant)', 'E_PUBKEY');
    }

    const pt = plaintext instanceof Uint8Array ? plaintext : new Uint8Array(plaintext);

    // — KEM : échange de clé post-quantique
    const [kemCt, shared] = this.#kem.encapsulate(publicKey);

    // — Nonce frais à chaque message (évite la réutilisation nonce+clé)
    const nonce = randomBytes(NONCE_LEN);

    // — Chiffrement RomanT369 Hyper256 avec le secret partagé dérivé
    const roman      = new RomanT369(shared.secret, nonce, GematriaMode.Hyper256);
    const romanCt    = roman.encrypt(pt);

    // — Enveloppe : [nonce:12][roman_ct]
    const envelope   = new Uint8Array(NONCE_LEN + romanCt.length);
    envelope.set(nonce, 0);
    envelope.set(romanCt, NONCE_LEN);

    console.debug(
      `[PostQuantumSuite] Chiffré ${pt.length} → ${envelope.length} B` +
      ` (ML-KEM-${this.#is1024 ? '1024' : '768'} + RomanT369)` +
      (contact?.alias ? ` — Contact: ${contact.alias}` : '')
    );

    return [kemCt, envelope];
  }

  // ─── Déchiffrement ────────────────────────────────────────────

  /**
   * Déchiffre un message.
   *
   * @param {Uint8Array}  secretKey  — clé secrète ML-KEM (≥ 2400 octets)
   * @param {object}      kemCt      — { ml_kem_ciphertext: Uint8Array }
   * @param {Uint8Array}  envelope   — [nonce:12][roman_ct]
   * @returns {Uint8Array}           — plaintext
   */
  decrypt(secretKey, kemCt, envelope) {
    if (!secretKey || secretKey.length < MIN_SECRET_KEY_LEN) {
      throw new PostQuantumError(
        `Clé secrète ML-KEM invalide (${secretKey?.length ?? 0} < ${MIN_SECRET_KEY_LEN} octets)`,
        'E_SECKEY'
      );
    }
    if (!kemCt?.ml_kem_ciphertext) {
      throw new PostQuantumError('kemCt invalide (ml_kem_ciphertext manquant)', 'E_KEMCT');
    }
    if (!(envelope instanceof Uint8Array) || envelope.length <= NONCE_LEN) {
      throw new PostQuantumError('Enveloppe trop courte pour déchiffrer', 'E_ENVELOPE');
    }

    // — KEM : reconstituer le secret partagé
    const shared = this.#kem.decapsulate(secretKey, kemCt);

    // — Extraire nonce + roman_ct de l'enveloppe
    const nonce   = envelope.subarray(0, NONCE_LEN);
    const romanCt = envelope.subarray(NONCE_LEN);

    // — Déchiffrement RomanT369
    const roman     = new RomanT369(shared.secret, nonce, GematriaMode.Hyper256);
    const plaintext = roman.decrypt(romanCt);

    if (!plaintext) {
      throw new PostQuantumError('Déchiffrement RomanT369 échoué', 'E_DECRYPT');
    }

    console.debug(`[PostQuantumSuite] Déchiffré ${envelope.length} → ${plaintext.length} B`);
    return plaintext;
  }

  // ─── Accesseurs ───────────────────────────────────────────────

  get is1024()   { return this.#is1024; }
  get kemVariant() { return this.#is1024 ? 'ML-KEM-1024' : 'ML-KEM-768'; }
}
