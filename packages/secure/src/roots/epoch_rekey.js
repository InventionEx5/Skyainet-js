// packages/secure/src/roots/epoch_rekey.js
// =====================================================
// EpochRekeyManager — Rotation Sécurisée des Clés
// SkyAInet × Nikola T369
//
// Architecture :
//   BROADCAST  (1 couche) — GematriaAead          — diffusion, heartbeat, découverte
//   HEARTBEAT  (2 couches) — +RomanT369            — keepalive authentifié
//   DISCOVERY  (3 couches) — +Double dérivation    — handshake, échange clés
//   PRIVATE    (4 couches) — +HKDF additionnel     — messages, paiements
//   CRITICAL   (5 couches) — +GematriaAead chaîné  — données ultra-sensibles
//
// Propriétés : Forward Secrecy · Post-quantique RomanT369 + Gematria
// Résistance trafic : padding uniforme 512 · jitter temporel
// Fiabilité : tolérance skew ±30 s · décryptage multi-epoch
// =====================================================

"use strict";

import { randomBytes }                              from 'crypto';
import { RomanT369, GematriaMode }                  from '../crypto/roman_t369.js';
import { GematriaAead }                             from '../crypto/gematria_aead.js';
import { hkdfSha256, hmacSha256, constantTimeEq }   from '../crypto/sha_fips.js';

// ─────────────────────────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────────────────────────

const PAD_TO          = 512;      // blocs uniformes → résistance trafic analysis
const KEY_HISTORY_MAX = 3;        // forward secrecy : N epochs archivés
const EPOCH_SKEW_S    = 30;       // tolérance synchro réseau (secondes)
const RETRY_BASE_MS   = 200;      // backoff exponentiel en cas d'échec
const TE              = new TextEncoder();

// ─────────────────────────────────────────────────────────────────
// CANAUX — 5 niveaux, 5 cas d'usage
// ─────────────────────────────────────────────────────────────────

export const Channel = Object.freeze({
  BROADCAST : 'broadcast',   // 1 couche
  HEARTBEAT : 'heartbeat',   // 2 couches
  DISCOVERY : 'discovery',   // 3 couches
  PRIVATE   : 'private',     // 4 couches
  CRITICAL  : 'critical',    // 5 couches
});

const CHANNEL_LAYERS = {
  [Channel.BROADCAST] : 1,
  [Channel.HEARTBEAT] : 2,
  [Channel.DISCOVERY] : 3,
  [Channel.PRIVATE]   : 4,
  [Channel.CRITICAL]  : 5,
};

// ─────────────────────────────────────────────────────────────────
// ERREURS TYPÉES
// ─────────────────────────────────────────────────────────────────

export class RekeyError extends Error {
  constructor(code, message, cause = null) {
    super(message);
    this.name  = 'RekeyError';
    this.code  = code;
    if (cause) this.cause = cause;
  }
}

// ─────────────────────────────────────────────────────────────────
// PADDING UNIFORME — résistance à l'analyse de trafic
// Format : [payload][0x80][0x00…][len_lo][len_hi]
// ─────────────────────────────────────────────────────────────────

function padToBlock(data) {
  const d      = data instanceof Uint8Array ? data : new Uint8Array(data);
  const rawLen = d.length & 0xFFFF;
  const target = Math.ceil((d.length + 3) / PAD_TO) * PAD_TO;
  const out    = new Uint8Array(target);
  out.set(d);
  out[d.length]    = 0x80;
  out[target - 2]  = rawLen & 0xff;
  out[target - 1]  = (rawLen >> 8) & 0xff;
  return out;
}

function unpad(data) {
  if (data.length < 3 || data.length % PAD_TO !== 0) {
    throw new RekeyError('E_PAD', 'Bloc padded invalide');
  }
  const len = data[data.length - 2] | (data[data.length - 1] << 8);
  if (len > data.length - 3) throw new RekeyError('E_PAD', 'Longueur padding invalide');
  return data.subarray(0, len);
}

// ─────────────────────────────────────────────────────────────────
// DÉRIVATION DE CLÉS PAR COUCHE
//
// Chaque couche i d'un canal a une clé indépendante :
//   K_i = HKDF(K_epoch, salt=∅, info="skynet|<channel>|layer<i>|epoch<n>")
//
// Propriété : compromission d'une couche ne révèle rien des autres.
// ─────────────────────────────────────────────────────────────────

function deriveLayerKey(epochKey, channel, layerIndex, epochNum) {
  return hkdfSha256(
    epochKey, null,
    TE.encode(`skynet|${channel}|layer${layerIndex}|epoch${epochNum}`),
    32
  );
}

function deriveHmacKey(epochKey, epochNum) {
  return hkdfSha256(epochKey, null, TE.encode(`skynet|hmac|epoch${epochNum}`), 32);
}

// ─────────────────────────────────────────────────────────────────
// CHIFFREMENT ONION — N couches empilées
//
// Couche 0 (toutes)    : GematriaAead.encryptWithTag  — post-quantique
// Couche 1 (+)         : RomanT369 Hyper256            — gematria
// Couche 2 (+)         : HKDF-renforcé + GematriaAead — double dérivation
// Couche 3 (+)         : RomanT369 secondaire          — couche supplémentaire
// Couche 4 (+)         : GematriaAead chaîné           — saturation PQ
//
// Format par couche : [nonce:12][ciphertext]
// Le padding uniforme est appliqué avant la couche 0 → tailles indiscernables.
// ─────────────────────────────────────────────────────────────────

function onionEncrypt(payload, epochKey, channel, epochNum) {
  const layers = CHANNEL_LAYERS[channel] ?? 1;
  let   data   = padToBlock(payload);

  for (let i = 0; i < layers; i++) {
    const k     = deriveLayerKey(epochKey, channel, i, epochNum);
    const nonce = randomBytes(12);

    let ct;
    switch (i) {
      case 0: {
        // GematriaAead — authenticité + post-quantique
        ct = GematriaAead.fromRootKey(k).encryptWithTag(data);
        break;
      }
      case 1: {
        // RomanT369 Hyper256 — gematria T369
        ct = new RomanT369(k, nonce, GematriaMode.Hyper256).encrypt(data);
        break;
      }
      case 2: {
        // HKDF additionnel → GematriaAead (double dérivation)
        const k2 = hkdfSha256(k, nonce, TE.encode(`discovery-inner|${epochNum}`), 32);
        ct = GematriaAead.fromRootKey(k2).encryptWithTag(data);
        break;
      }
      case 3: {
        // RomanT369 secondaire — couche gematria supplémentaire
        const k3 = hkdfSha256(k, null, TE.encode(`private-roman|${epochNum}`), 32);
        ct = new RomanT369(k3, nonce, GematriaMode.Hyper256).encrypt(data);
        break;
      }
      case 4: {
        // GematriaAead chaîné — saturation post-quantique finale
        const k4 = hkdfSha256(k, nonce, TE.encode(`critical-final|${epochNum}`), 32);
        ct = GematriaAead.fromRootKey(k4).encryptWithTag(data);
        break;
      }
    }

    // Préfixe nonce : [nonce:12][ct]
    const wrapped = new Uint8Array(12 + ct.length);
    wrapped.set(nonce, 0);
    wrapped.set(ct, 12);
    data = wrapped;
  }

  return data;
}

function onionDecrypt(ciphertext, epochKey, channel, epochNum) {
  const layers = CHANNEL_LAYERS[channel] ?? 1;
  let   data   = ciphertext instanceof Uint8Array ? ciphertext : new Uint8Array(ciphertext);

  for (let i = layers - 1; i >= 0; i--) {
    if (data.length < 12) throw new RekeyError('E_DECRYPT', `Couche ${i} trop courte`);
    const nonce = data.subarray(0, 12);
    const ct    = data.subarray(12);
    const k     = deriveLayerKey(epochKey, channel, i, epochNum);

    switch (i) {
      case 0:  data = GematriaAead.fromRootKey(k).decrypt(ct); break;
      case 1:  data = new RomanT369(k, nonce, GematriaMode.Hyper256).decrypt(ct); break;
      case 2: {
        const k2 = hkdfSha256(k, nonce, TE.encode(`discovery-inner|${epochNum}`), 32);
        data = GematriaAead.fromRootKey(k2).decrypt(ct);
        break;
      }
      case 3: {
        const k3 = hkdfSha256(k, null, TE.encode(`private-roman|${epochNum}`), 32);
        data = new RomanT369(k3, nonce, GematriaMode.Hyper256).decrypt(ct);
        break;
      }
      case 4: {
        const k4 = hkdfSha256(k, nonce, TE.encode(`critical-final|${epochNum}`), 32);
        data = GematriaAead.fromRootKey(k4).decrypt(ct);
        break;
      }
    }
  }

  return unpad(data);
}

// ─────────────────────────────────────────────────────────────────
// EPOCH REKEY MANAGER
// ─────────────────────────────────────────────────────────────────

export class EpochRekeyManager {
  // Clés privées — jamais exposées
  #currentKey;     // Uint8Array(32)
  #keyHistory;     // [{epoch, key}]
  #epoch;
  #lastRekeySec;
  #intervalSecs;
  #forceNext;
  #failureCount;
  #domain;

  /**
   * @param {object}  [opts]
   * @param {number}       opts.intervalSecs  — durée d'epoch (défaut 3600 s)
   * @param {Uint8Array}   opts.initialKey    — clé racine initiale (32 octets)
   * @param {number}       opts.jitterRatio   — jitter ±% du intervalle (défaut 0.10)
   * @param {string}       opts.domain        — domaine HKDF (défaut 'skynet/epoch/v1')
   */
  constructor(opts = {}) {
    this.#intervalSecs = Math.max(1, opts.intervalSecs ?? 3600);
    this.#epoch        = 0;
    this.#lastRekeySec = this.#nowSec();
    this.#forceNext    = false;
    this.#failureCount = 0;
    this.#keyHistory   = [];
    this.#domain       = opts.domain ?? 'skynet/epoch/v1';

    this.jitterRatio   = Math.max(0, Math.min(0.5, opts.jitterRatio ?? 0.10));

    this.#currentKey   = opts.initialKey instanceof Uint8Array && opts.initialKey.length >= 32
      ? new Uint8Array(opts.initialKey.subarray(0, 32))
      : randomBytes(32);
  }

  // ─── Accesseurs (lecture seule) ───────────────────────────────

  get epoch()        { return this.#epoch; }
  get intervalSecs() { return this.#intervalSecs; }
  get lastRekeySec() { return this.#lastRekeySec; }

  // ─── Politique de rekey ───────────────────────────────────────

  shouldRekey() {
    if (this.#forceNext) return true;
    const jitteredInterval = Math.max(1, Math.floor(
      this.#intervalSecs * (1 + (Math.random() * 2 - 1) * this.jitterRatio)
    ));
    return (this.#nowSec() - this.#lastRekeySec) >= jitteredInterval;
  }

  timeUntilNextRekey() {
    const elapsed = Math.max(0, this.#nowSec() - this.#lastRekeySec);
    return Math.max(0, this.#intervalSecs - elapsed);
  }

  forceRekey() {
    this.#forceNext = true;
  }

  // ─── Rekey principal ──────────────────────────────────────────

  /**
   * Effectue la rotation de clé :
   *   1. Archive la clé courante (forward secrecy)
   *   2. Dérive la nouvelle via HKDF + sel aléatoire
   *   3. Renforce avec RomanT369 Hyper256 (post-quantique)
   *   4. Authentifie la rotation avec HMAC-SHA256
   *   5. Commit atomique
   *
   * @param {object} [opts]
   * @param {string}     opts.channel   — canal déclencheur (log)
   * @param {Uint8Array} opts.peerSalt  — sel pair pour consensus bilatéral
   * @returns {RekeyResult}
   */
  async performRekey(opts = {}) {
    const { channel = Channel.PRIVATE, peerSalt = null } = opts;

    try {
      // — Archive (forward secrecy)
      this.#archiveCurrentKey();

      // — Sel combiné local ⊕ pair (si fourni)
      const localSalt    = randomBytes(32);
      const combinedSalt = peerSalt instanceof Uint8Array && peerSalt.length >= 32
        ? _xor(localSalt, peerSalt.subarray(0, 32))
        : localSalt;

      // — HKDF : derive la nouvelle clé
      const info    = TE.encode(`${this.#domain}|rekey|epoch${this.#epoch + 1}|${channel}`);
      const derived = hkdfSha256(this.#currentKey, combinedSalt, info, 32);

      // — Renforcement RomanT369 post-quantique
      const roman      = new RomanT369(derived, combinedSalt.subarray(0, 12), GematriaMode.Hyper256);
      const reinforced = roman.encrypt(derived).subarray(0, 32);

      // — Tag HMAC d'authentification de la rotation
      const hmacKey = deriveHmacKey(this.#currentKey, this.#epoch);
      const tag     = hmacSha256(hmacKey, reinforced);

      // — Commit atomique
      this.#currentKey   = reinforced;
      this.#epoch       += 1;
      this.#lastRekeySec = this.#nowSec();
      this.#forceNext    = false;
      this.#failureCount = 0;

      // — Jitter anti-timing (0–80 ms)
      await _sleep(Math.floor(Math.random() * 80));

      return { epoch: this.#epoch, channel, hmacTag: tag, localSalt, timestamp: this.#lastRekeySec };

    } catch (err) {
      this.#failureCount++;
      const backoff = RETRY_BASE_MS * (2 ** Math.min(this.#failureCount, 6));
      throw new RekeyError('E_REKEY', `Rekey échoué: ${err.message}`, err);
    }
  }

  // ─── Chiffrement / Déchiffrement ─────────────────────────────

  /**
   * Chiffre un payload avec N couches onion selon le canal.
   * @param {Uint8Array|string} payload
   * @param {string}            channel — Channel.*
   */
  encrypt(payload, channel = Channel.PRIVATE) {
    if (!CHANNEL_LAYERS[channel]) throw new RekeyError('E_CHANNEL', `Canal inconnu: ${channel}`);
    const pt = typeof payload === 'string' ? TE.encode(payload) : payload;
    return onionEncrypt(pt, this.#currentKey, channel, this.#epoch);
  }

  /**
   * Déchiffre un ciphertext.
   * Essaie l'epoch courant puis les epochs historiques (tolérance désync).
   * @param {Uint8Array} ciphertext
   * @param {string}     channel
   * @param {number}     [epochHint] — epoch du pair si connu
   */
  decrypt(ciphertext, channel = Channel.PRIVATE, epochHint = null) {
    const ct       = ciphertext instanceof Uint8Array ? ciphertext : new Uint8Array(ciphertext);
    const epochs   = this.#decryptCandidates(epochHint);

    for (const ep of epochs) {
      const key = this.#keyForEpoch(ep);
      if (!key) continue;
      try { return onionDecrypt(ct, key, channel, ep); }
      catch { /* essayer l'epoch suivant */ }
    }

    throw new RekeyError('E_DECRYPT', `Déchiffrement échoué (canal: ${channel}, epochs: ${epochs.join(',')})`);
  }

  // ─── Vérification epoch pair ─────────────────────────────────

  verifyPeerEpoch(remoteEpoch, remoteTs) {
    if (Math.abs(this.#epoch - remoteEpoch) > 1) {
      throw new RekeyError('E_EPOCH', `Epoch mismatch: local=${this.#epoch} remote=${remoteEpoch}`);
    }
    const now    = this.#nowSec();
    const tsDiff = Math.abs(remoteTs - (now - (now % this.#intervalSecs)));
    if (tsDiff > this.#intervalSecs + EPOCH_SKEW_S) {
      throw new RekeyError('E_SKEW', `Timestamp drift: ${tsDiff}s`);
    }
  }

  // ─── Export / Import sel ──────────────────────────────────────

  exportRekeySalt() {
    const salt = randomBytes(32);
    const tag  = hmacSha256(deriveHmacKey(this.#currentKey, this.#epoch), salt);
    return { epoch: this.#epoch, salt, tag };
  }

  importPeerSalt({ epoch, salt, tag }) {
    if (Math.abs(epoch - this.#epoch) > 1) {
      throw new RekeyError('E_EPOCH', 'Epoch pair trop éloigné');
    }
    if (!(tag instanceof Uint8Array) || tag.length !== 32) {
      throw new RekeyError('E_TAG', 'Tag HMAC invalide');
    }
    return salt instanceof Uint8Array ? salt : new Uint8Array(salt);
  }

  // ─── Santé ───────────────────────────────────────────────────

  healthReport() {
    return {
      epoch          : this.#epoch,
      lastRekeySec   : this.#lastRekeySec,
      intervalSecs   : this.#intervalSecs,
      timeUntilRekey : this.timeUntilNextRekey(),
      forceNext      : this.#forceNext,
      failureCount   : this.#failureCount,
      historyDepth   : this.#keyHistory.length,
      channels       : CHANNEL_LAYERS,
      jitterRatio    : this.jitterRatio,
    };
  }

  // ─── Privé ───────────────────────────────────────────────────

  #nowSec() { return Math.floor(Date.now() / 1000); }

  #archiveCurrentKey() {
    this.#keyHistory.unshift({ epoch: this.#epoch, key: new Uint8Array(this.#currentKey) });
    if (this.#keyHistory.length > KEY_HISTORY_MAX) {
      const removed = this.#keyHistory.splice(KEY_HISTORY_MAX);
      for (const r of removed) r.key.fill(0);  // écraser avant GC
    }
  }

  #keyForEpoch(ep) {
    if (ep === this.#epoch) return this.#currentKey;
    return this.#keyHistory.find(h => h.epoch === ep)?.key ?? null;
  }

  #decryptCandidates(hint) {
    const base = hint != null ? [hint, this.#epoch] : [this.#epoch];
    const hist = this.#keyHistory.map(h => h.epoch).filter(e => !base.includes(e));
    return [...new Set([...base, ...hist])];
  }
}

// ─────────────────────────────────────────────────────────────────
// HELPERS INTERNES
// ─────────────────────────────────────────────────────────────────

function _xor(a, b) {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i];
  return out;
}

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─────────────────────────────────────────────────────────────────
// FACTORY — intégration en 5 lignes
//
//   const mgr = createManager('high');
//   const ct  = mgr.encrypt(payload, Channel.PRIVATE);
//   if (mgr.shouldRekey()) await mgr.performRekey();
//   const pt  = mgr.decrypt(ct, Channel.PRIVATE);
//   console.log(mgr.healthReport());
// ─────────────────────────────────────────────────────────────────

export function createManager(profile = 'high', initialKey = null) {
  const intervals = { low: 7200, medium: 3600, high: 1800, paranoid: 300 };
  return new EpochRekeyManager({
    intervalSecs: intervals[profile] ?? 3600,
    initialKey  : initialKey ?? undefined,
  });
}
