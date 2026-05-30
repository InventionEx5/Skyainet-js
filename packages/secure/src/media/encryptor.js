// packages/secure/src/media/encryptor.js
// =====================================================
// Media Encryptor — Chiffrement Temps Réel (SRTP-like)
// Compatible Contact + GroupManager + DID
// SkyAInet × Nikola T369
// =====================================================

import { GematriaAead } from '../crypto/gematria_aead.js';
import { RomanT369, GematriaMode } from '../crypto/roman_t369.js';

export class MediaFrame {
  constructor(sequenceNumber, timestamp, payloadType, ssrc, contactId = null) {
    this.sequenceNumber = sequenceNumber;
    this.timestamp = timestamp;
    this.payloadType = payloadType;
    this.ssrc = ssrc;
    this.contactId = contactId; // Uint8Array(32) | null
  }
}

export class MediaEncryptor {
  constructor(key, nonce) {
    this.gematria = new GematriaAead(key, nonce);
    this.sequenceCounter = 0;
    this.ssrc = Math.floor(Math.random() * 0xFFFFFFFF);
    this.lastTimestamp = this.#currentTimestamp();
    this.roman = new RomanT369(key, nonce, GematriaMode.Hyper256);
  }

  /**
   * Chiffre une frame média (version contact ou groupe)
   */
  encryptFrame(payload, contactId = null) {
    const now = this.#currentTimestamp();

    const frame = new MediaFrame(
      this.sequenceCounter,
      now,
      96,
      this.ssrc,
      contactId
    );

    // En-tête SRTP-like + payload
    const header = new Uint8Array(16 + (contactId ? 32 : 0));
    const view = new DataView(header.buffer);

    view.setUint32(0, this.sequenceCounter, true);
    view.setBigUint64(4, BigInt(now), true);
    view.setUint32(12, this.ssrc, true);

    if (contactId) {
      header.set(contactId, 16);
    }

    const packet = new Uint8Array(header.length + payload.length);
    packet.set(header, 0);
    packet.set(payload, header.length);

    const encrypted = this.gematria.encrypt(packet);

    this.sequenceCounter = (this.sequenceCounter + 1) >>> 0;
    this.lastTimestamp = now;

    console.debug(
      `[MediaEncryptor] Frame chiffrée | Seq: ${frame.sequenceNumber} | Contact: ${contactId ? 'yes' : 'no'}`
    );

    return [frame, encrypted];
  }

  /**
   * Déchiffre une frame média
   */
  decryptFrame(encrypted) {
    const decrypted = this.gematria.decrypt(encrypted);
    if (!decrypted || decrypted.length < 16) {
      console.warn('[MediaEncryptor] Frame trop courte');
      return null;
    }

    const view = new DataView(decrypted.buffer, decrypted.byteOffset);

    const sequenceNumber = view.getUint32(0, true);
    const timestamp = Number(view.getBigUint64(4, true));
    const ssrc = view.getUint32(12, true);

    let contactId = null;
    let payloadStart = 16;

    if (decrypted.length >= 48) {
      contactId = decrypted.subarray(16, 48);
      payloadStart = 48;
    }

    const payload = decrypted.subarray(payloadStart);

    const frame = new MediaFrame(sequenceNumber, timestamp, 96, ssrc, contactId);

    console.debug(`[MediaEncryptor] Frame déchiffrée | Seq: ${sequenceNumber}`);
    return [frame, payload];
  }

  /**
   * Vérifie l'ordre (anti-replay)
   */
  isInOrder(sequenceNumber) {
    const diff = (sequenceNumber - this.sequenceCounter) >>> 0;
    return diff < 100 || diff > 0xFFFFFF00;
  }

  #currentTimestamp() {
    return BigInt(Date.now());
  }
}