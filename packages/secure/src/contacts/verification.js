// packages/secure/src/contacts/verification.js
// =====================================================
// Contact & Group Verification v7.0 — Multi-Level + Intelligent Scoring
// SkyAInet × Nikola T369 — Dilithium5 + T369Inference + RomanT369 Encryption
// Version Ultra Améliorée (Production Ready)
// =====================================================

import { Dilithium5Signer } from '../crypto/dilithium.js';
import { RomanT369, GematriaMode } from '../crypto/roman_t369.js';
import { Contact } from './contact.js'; // Assure-toi que contact.js existe
import { createHash } from 'crypto';

// =====================================================
// ERREURS
// =====================================================
export class VerificationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'VerificationError';
  }
}

// =====================================================
// NIVEAUX DE VÉRIFICATION
// =====================================================
export const VerificationLevel = Object.freeze({
  None: 0,
  SignatureOnly: 1,
  SignaturePlusQr: 2,
  FullTrust: 3,
});

// =====================================================
// STRUCTURES GROUPE
// =====================================================
export class Group {
  constructor(id, name) {
    this.id = id;
    this.name = name;
    this.members = [];                    // Contact[]
    this.verificationLevel = 0;
    this.trustScore = 50.0;
    this.createdAt = new Date();
    this.lastActivity = null;
  }
}

// =====================================================
// CONTACT VERIFICATION
// =====================================================
export class ContactVerification {
  /**
   * Vérifie un contact selon le niveau demandé
   */
  static verifyContact(contact, signer, level) {
    if (contact.revoked) {
      throw new VerificationError('Contact/Group is revoked or inactive');
    }

    switch (level) {
      case 1:
        if (ContactVerification.#verifySignature(contact, signer)) {
          contact.verificationLevel = 1;
          contact.updateReputation(8);
          console.info(`[Verification] Niveau 1 validé pour ${contact.name}`);
          return true;
        } else {
          throw new VerificationError('Invalid Dilithium signature');
        }

      case 2:
        if (ContactVerification.#verifySignature(contact, signer) && ContactVerification.#verifyQrHash(contact)) {
          contact.verificationLevel = 2;
          contact.updateReputation(15);
          console.info(`[Verification] Niveau 2 validé pour ${contact.name}`);
          return true;
        } else {
          throw new VerificationError('QR verification failed');
        }

      case 3:
        if (
          ContactVerification.#verifySignature(contact, signer) &&
          ContactVerification.#verifyQrHash(contact) &&
          ContactVerification.#verifyRecentInteraction(contact)
        ) {
          contact.verificationLevel = 3;
          contact.updateReputation(30);
          console.info(`[Verification] Niveau 3 validé pour ${contact.name}`);
          return true;
        } else {
          throw new VerificationError('Verification level too low');
        }

      default:
        return false;
    }
  }

  static #verifySignature(contact, signer) {
    if (!contact.publicKey || contact.publicKey.length === 0 || !contact.signature || contact.signature.length === 0) {
      return false;
    }
    return signer.verify(contact.publicKey, contact.signature);
  }

  static #verifyQrHash(contact) {
    if (!contact.qrCodeHash) return false;
    const expected = ContactVerification.#calculateExpectedQrHash(contact);
    return contact.qrCodeHash === expected;
  }

  static #calculateExpectedQrHash(contact) {
    const hasher = createHash('sha256');
    hasher.update(contact.publicKey);
    return hasher.digest('hex');
  }

  static #verifyRecentInteraction(contact) {
    if (contact.interactionCount < 3) return false;
    if (!contact.lastInteraction) return false;

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    return contact.lastInteraction > thirtyDaysAgo;
  }
}

// =====================================================
// GROUP VERIFICATION + INTELLIGENT SCORING (T369Inference)
// =====================================================
export class GroupVerification {
  /**
   * Vérifie un groupe entier avec scoring intelligent via T369Inference
   */
  static verifyGroup(group, signer, inference) {
    if (!group.members || group.members.length === 0) {
      throw new VerificationError('Verification level too low');
    }

    // 1. Vérifier chaque membre (niveau 2)
    let validMembers = 0;
    for (const member of group.members) {
      try {
        ContactVerification.verifyContact(member, signer, 2);
        validMembers++;
      } catch (_) {
        // membre invalide
      }
    }

    // 2. Calcul intelligent du trust score via T369Inference
    const trustScore = GroupVerification.#calculateIntelligentTrustScore(group, inference);
    group.trustScore = trustScore;

    // 3. Déterminer le niveau de vérification du groupe
    const ratio = validMembers / group.members.length;

    if (ratio >= 0.8 && trustScore > 75.0) {
      group.verificationLevel = 3;
      console.info(`[GroupVerification] Groupe '${group.name}' validé au niveau 3 (Trust: ${trustScore.toFixed(1)})`);
    } else if (ratio >= 0.6) {
      group.verificationLevel = 2;
    } else {
      group.verificationLevel = 1;
    }

    // 4. Chiffrement de la preuve de vérification (RomanT369)
    const proof = `group:\( {group.id}:trust: \){trustScore.toFixed(2)}:level:${group.verificationLevel}`;
    const encryptedProof = GroupVerification.#encryptVerificationProof(proof);

    console.debug(`[GroupVerification] Preuve chiffrée générée pour groupe ${group.id}`);
    return true;
  }

  /**
   * Score de confiance intelligent via T369Inference
   */
  static #calculateIntelligentTrustScore(group, inference) {
    const avgReputation = group.members.reduce((sum, m) => sum + (m.reputation || 0), 0) / group.members.length;

    const prompt = `Analyse de confiance de groupe: ${group.members.length} membres, réputation moyenne ${avgReputation.toFixed(1)}, dernière activité récente. Score de fiabilité ?`;

    try {
      // Appel réel au moteur T369Inference (doit être injecté)
      const result = inference.generate(prompt, 128);

      if (result.toLowerCase().includes('high')) return 92.0;
      if (result.toLowerCase().includes('medium')) return 68.0;
      return 45.0;
    } catch (e) {
      console.warn('[GroupVerification] Erreur T369Inference, score par défaut utilisé');
      return 50.0;
    }
  }

  /**
   * Chiffrement de la preuve de vérification
   */
  static #encryptVerificationProof(proof) {
    const roman = new RomanT369(
      new Uint8Array(32).fill(0xAA),
      new Uint8Array(12),
      GematriaMode.Hyper256
    );
    return roman.encrypt(new TextEncoder().encode(proof));
  }

  /**
   * Ajoute un membre au groupe avec vérification automatique
   */
  static addMemberToGroup(group, contact, signer) {
    ContactVerification.verifyContact(contact, signer, 2);
    group.members.push(contact);
    group.lastActivity = new Date();
    console.info(`[GroupVerification] Membre ajouté au groupe '${group.name}'`);
  }
}

// Export par défaut pour commodité
export default {
  ContactVerification,
  GroupVerification,
  Group,
  VerificationError,
  VerificationLevel,
};