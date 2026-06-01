// packages/secure/src/transport/libp2p.js
// =====================================================
// Libp2p Transport — Cœur du Réseau (Mode Hybride)
// SkyAInet × Nikola T369
// =====================================================

"use strict";

import { EventEmitter }                     from 'events';
import { randomBytes }                      from 'crypto';
import { HybridTransport, HybridMode }      from '../crypto/hybrid.js';
import { KemT369 }                          from '../crypto/kem_t369.js';
import {
  HybridTransportTrait,
  TransportLayer,
  CryptoSuite,
  TransportMessage,
  TransportError,
}                                           from './trait.js';
import { Contact }                          from '../../secure/src/roots/pool.js';

// ─────────────────────────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────────────────────────

const FLASH_INTERVAL_MS   = 45_000;   // fenêtre entre deux Flash Gematria
const FLASH_CHECK_MS      = 15_000;   // fréquence de vérification du scheduler
const FLASH_PROBABILITY   = 0.05;     // 5 % de chance par fenêtre
const QUEUE_MAX           = 1024;     // messages en attente max (backpressure)
const DEFAULT_TOPIC       = 'skyainet/lessons/v1';

// ─────────────────────────────────────────────────────────────────
// LIBP2P TRANSPORT
//
// Implémente HybridTransportTrait avec chiffrement ML-KEM + Gematria.
//
// Chiffrement :
//   1. Génère une paire KEM éphémère locale
//   2. Encapsule → obtient [kemCiphertext, sharedSecret]
//   3. Chiffre le payload avec HybridTransport.encrypt()
//   4. Publie { kemCiphertext, ciphertext } dans la file de messages
//
// Le déchiffrement reconstitue le secret depuis kemCiphertext
// via HybridTransport.decrypt(secretKey, kemCt, ciphertext).
//
// Flash Gematria Scheduler :
//   Toutes les 15 s, si la fenêtre de 45 s est écoulée et
//   avec 5 % de probabilité, bascule en mode FlashGematria
//   pour le prochain envoi. Rétablit KemT369Core après.
// ─────────────────────────────────────────────────────────────────

export class Libp2pTransportReal extends HybridTransportTrait {
  #hybrid;            // HybridTransport — chiffrement hybride KEM + Gematria
  #kem;               // KemT369 — génération de paires éphémères
  #currentMode;       // HybridMode courant
  #localKeypair;      // { publicKey, secretKey } éphémère courant
  #messageQueue;      // TransportMessage[] — FIFO bornée
  #flashTimer;        // handle setInterval
  #lastFlash;         // timestamp ms du dernier flash
  #peerId;
  #running;

  constructor() {
    super();
    this.#hybrid       = new HybridTransport(false);   // ML-KEM-768
    this.#kem          = new KemT369(false);
    this.#currentMode  = HybridMode.KemT369Core;
    this.#localKeypair = null;
    this.#messageQueue = [];
    this.#flashTimer   = null;
    this.#lastFlash    = Date.now();
    this.#running      = false;

    // PeerID local déterministe (hex des 8 premiers octets d'un nonce aléatoire)
    const nonce  = randomBytes(8);
    this.#peerId = `peer_${Array.from(nonce).map(b => b.toString(16).padStart(2,'0')).join('')}`;
  }

  // ─── Cycle de vie ────────────────────────────────────────────

  async start() {
    if (this.#running) return;

    // Génère la paire KEM locale initiale
    this.#rotateKeypair();

    this.#running = true;
    this.#startFlashScheduler();

    console.info(`[Libp2p] Transport démarré — PeerID: ${this.#peerId}`);
    this.emit('started', this.#peerId);
  }

  async stop() {
    if (!this.#running) return;
    this.#running = false;

    if (this.#flashTimer) {
      clearInterval(this.#flashTimer);
      this.#flashTimer = null;
    }

    // Écraser la clé secrète locale avant abandon
    if (this.#localKeypair?.secretKey) {
      this.#localKeypair.secretKey.fill(0);
    }
    this.#localKeypair = null;
    this.#messageQueue = [];

    console.info('[Libp2p] Transport arrêté');
    this.emit('stopped');
  }

  // ─── Envoi ────────────────────────────────────────────────────

  /**
   * Envoi standard (mode courant).
   */
  async send(addr, data) {
    return this.sendWithMode(addr, data, this.#currentMode);
  }

  /**
   * Envoi avec un mode hybride explicite.
   *
   * Pipeline :
   *   plaintext → HybridTransport.encrypt(localPublicKey, plaintext, mode)
   *   → [kemCiphertext, encryptedPayload]
   *   → TransportMessage { from, payload: { kemCt, ct }, topic, mode }
   *
   * La clé publique locale (ML-KEM) est utilisée comme destinataire
   * dans un schéma auto-encapsulé : le secret dérivé est déterministe
   * pour l'instance, permettant le déchiffrement via le secret KEM mis
   * en cache par HybridTransport.deriveKeys().
   *
   * @param {string}         addr
   * @param {Uint8Array}     data
   * @param {string}         mode    — HybridMode.*
   * @param {Contact|null}   contact — Contact optionnel (log + filtrage futur)
   */
  async sendWithMode(addr, data, mode = HybridMode.KemT369Core, contact = null) {
    if (!this.#running) throw new TransportError('Transport non démarré', 'NOT_STARTED');
    if (!(data instanceof Uint8Array)) throw new TransportError("'data' doit être Uint8Array", 'E_INPUT');

    // Basculer le mode si nécessaire
    if (mode !== this.#currentMode) {
      this.#hybrid.setMode(mode);
      this.#currentMode = mode;
    }

    // Chiffrement avec la clé publique locale — auto-encapsulation
    const [kemCt, ciphertext] = this.#hybrid.encrypt(
      this.#localKeypair.publicKey,
      data,
      mode
    );

    // Construire le payload sérialisé { kemCt, ciphertext }
    const payload = this.#serializeEnvelope(kemCt, ciphertext);
    const msg     = new TransportMessage(this.#peerId, payload, DEFAULT_TOPIC, mode);

    // Backpressure : rejeter les messages les plus vieux si la file est pleine
    if (this.#messageQueue.length >= QUEUE_MAX) {
      this.#messageQueue.shift();
    }
    this.#messageQueue.push(msg);
    this.emit('message', msg);

    const alias = contact?.alias ?? addr;
    console.debug(`[Libp2p] Envoi (mode: ${mode}) → ${alias} | ${data.length} B`);
  }

  // ─── Réception ───────────────────────────────────────────────

  /**
   * Reçoit et déchiffre le prochain message de la file.
   * Retourne un TransportMessage avec payload déchiffré.
   * Si la file est vide, retourne null.
   */
  async recv() {
    if (this.#messageQueue.length === 0) return null;

    const msg = this.#messageQueue.shift();

    // Déchiffrement
    try {
      const { kemCt, ciphertext } = this.#deserializeEnvelope(msg.payload);
      const plaintext = this.#hybrid.decrypt(
        this.#localKeypair.secretKey,
        kemCt,
        ciphertext,
        msg.mode ?? this.#currentMode
      );
      return new TransportMessage(msg.from, plaintext, msg.topic, msg.mode);
    } catch (e) {
      console.warn(`[Libp2p] Déchiffrement échoué pour msg ${msg.id}: ${e.message}`);
      return null;
    }
  }

  // ─── Mode hybride ─────────────────────────────────────────────

  async setHybridMode(mode) {
    if (!Object.values(HybridMode).includes(mode)) {
      throw new TransportError(`Mode inconnu: ${mode}`, 'INVALID_MODE');
    }
    this.#hybrid.setMode(mode);
    this.#currentMode = mode;
    console.debug(`[Libp2p] Mode → ${mode}`);
  }

  async forceFlashGematria() {
    await this.setHybridMode(HybridMode.FlashGematria);
    this.#lastFlash = Date.now();
    console.info('[Libp2p] ⚡ Flash Gematria forcé');
  }

  currentHybridMode() { return this.#currentMode; }

  // ─── Accesseurs ───────────────────────────────────────────────

  localAddr()           { return null; }   // à implémenter avec vrai libp2p
  layer()               { return TransportLayer.Core; }
  cryptoMode()          { return CryptoSuite.HybridFlash; }
  supportsFlashGematria() { return true; }
  get peerId()          { return this.#peerId; }
  get isRunning()       { return this.#running; }
  get queueSize()       { return this.#messageQueue.length; }

  // ─── Privés ───────────────────────────────────────────────────

  /**
   * Génère une nouvelle paire KEM éphémère et écrase l'ancienne clé secrète.
   * Appelé au démarrage et peut être rappelé pour la rotation de clés.
   */
  #rotateKeypair() {
    if (this.#localKeypair?.secretKey) {
      this.#localKeypair.secretKey.fill(0);
    }
    const [publicKey, secretKey] = this.#kem.generateKeypair();
    this.#localKeypair = { publicKey, secretKey };
  }

  /**
   * Scheduler Flash Gematria :
   * Toutes les 15 s, si la fenêtre de 45 s est passée et avec
   * 5 % de probabilité, bascule temporairement en FlashGematria.
   */
  #startFlashScheduler() {
    this.#flashTimer = setInterval(() => {
      if (!this.#running) return;
      const now = Date.now();
      if (now - this.#lastFlash > FLASH_INTERVAL_MS && Math.random() < FLASH_PROBABILITY) {
        this.#hybrid.setMode(HybridMode.FlashGematria);
        this.#currentMode = HybridMode.FlashGematria;
        this.#lastFlash   = now;
        console.debug('[Libp2p] ⚡ Flash Gematria schedulé');

        // Rétablir KemT369Core après 5 s
        setTimeout(() => {
          if (!this.#running) return;
          this.#hybrid.setMode(HybridMode.KemT369Core);
          this.#currentMode = HybridMode.KemT369Core;
        }, 5_000);
      }
    }, FLASH_CHECK_MS).unref();
  }

  /**
   * Sérialise [kemCiphertext, ciphertext] en une enveloppe binaire.
   * Format : [kemLen:4LE][kemCt][ct]
   */
  #serializeEnvelope(kemCt, ciphertext) {
    const kemBytes = kemCt?.ml_kem_ciphertext ?? new Uint8Array(0);
    const ctBytes  = ciphertext instanceof Uint8Array ? ciphertext : new Uint8Array(ciphertext);
    const out      = new Uint8Array(4 + kemBytes.length + ctBytes.length);
    const view     = new DataView(out.buffer);
    view.setUint32(0, kemBytes.length, true);   // LE
    out.set(kemBytes, 4);
    out.set(ctBytes, 4 + kemBytes.length);
    return out;
  }

  /** Désérialise une enveloppe binaire → { kemCt, ciphertext } */
  #deserializeEnvelope(data) {
    if (!(data instanceof Uint8Array) || data.length < 4) {
      throw new TransportError('Enveloppe invalide', 'E_ENVELOPE');
    }
    const view   = new DataView(data.buffer, data.byteOffset);
    const kemLen = view.getUint32(0, true);
    if (4 + kemLen > data.length) {
      throw new TransportError('kemLen dépasse la taille de l\'enveloppe', 'E_ENVELOPE');
    }
    const kemCt      = { ml_kem_ciphertext: data.subarray(4, 4 + kemLen) };
    const ciphertext = data.subarray(4 + kemLen);
    return { kemCt, ciphertext };
  }
}
