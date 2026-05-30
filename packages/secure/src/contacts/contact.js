// packages/secure/src/contacts/contact.js
// =====================================================
// Contact v6.1 — Structure de Contact Intelligente + DID
// SkyAInet × Nikola T369 — Réputation + Vérification Multi-Niveaux + QR + DID
// Compatible avec Messaging, Groupes et ContactManager
// =====================================================

import { Did } from './did.js'; // Optionnel : crée did.js si besoin (classe minimale fournie dans manager.js)

export class Contact {
  constructor(nodeId, name, publicKey) {
    this.nodeId = new Uint8Array(nodeId);           // [u8; 32]
    this.name = name;
    this.publicKey = new Uint8Array(publicKey);
    this.signature = new Uint8Array();
    this.did = null;                                // Did | null
    this.reputationScore = 50;
    this.verificationLevel = 0;
    this.qrCodeHash = null;
    this.interactionCount = 0;
    this.lastInteraction = new Date();
    this.notes = null;
    this.isFavorite = false;
    this.revoked = false;
    this.createdAt = new Date();
  }

  // ==================== DID ====================

  setDid(did) {
    this.did = did;
    if (this.verificationLevel < 2) {
      this.verificationLevel = 2;
    }
    console.debug(`[Contact] DID associé à ${this.name}`);
  }

  getDidString() {
    return this.did ? this.did.toShortString() : null;
  }

  hasDecentralizedIdentity() {
    return !!this.did && this.verificationLevel >= 2;
  }

  // ==================== RÉPUTATION & INTERACTIONS ====================

  updateReputation(delta) {
    this.reputationScore = Math.max(0, Math.min(100, this.reputationScore + delta));
    console.debug(`[Contact] Réputation mise à jour pour ${this.name} → ${this.reputationScore}`);
  }

  touch() {
    this.lastInteraction = new Date();
    this.interactionCount++;
  }

  incrementInteraction() {
    this.interactionCount++;
    this.lastInteraction = new Date();
  }

  setSignature(signature) {
    this.signature = new Uint8Array(signature);
  }

  setQrHash(hash) {
    this.qrCodeHash = hash;
    if (this.verificationLevel < 2) {
      this.verificationLevel = 2;
    }
  }

  revoke(reason = null) {
    this.revoked = true;
    if (reason) {
      this.notes = `Révoqué: ${reason}`;
    }
    console.debug(`[Contact] Contact révoqué : ${this.name}`);
  }

  // ==================== VÉRIFICATION & SÉCURITÉ ====================

  isTrusted() {
    return this.verificationLevel >= 2 && !this.revoked && this.reputationScore >= 60;
  }

  canUseForSensitiveOperations() {
    return this.verificationLevel >= 2 && !this.revoked;
  }

  verificationBadge() {
    switch (this.verificationLevel) {
      case 0: return '⚠️ Non vérifié';
      case 1: return '🔐 Signature valide';
      case 2: return '📱 Vérifié (QR Air-Gap)';
      case 3: return '✅ Confiance élevée';
      default: return '❓ Inconnu';
    }
  }

  // ==================== TEMPS & STATUT ====================

  ageDays() {
    const diff = Date.now() - this.createdAt.getTime();
    return Math.floor(diff / (1000 * 60 * 60 * 24));
  }

  daysSinceLastInteraction() {
    if (!this.lastInteraction) return null;
    const diff = Date.now() - this.lastInteraction.getTime();
    return Math.floor(diff / (1000 * 60 * 60 * 24));
  }

  isRecentlyActive() {
    if (!this.lastInteraction) return false;
    const diff = Date.now() - this.lastInteraction.getTime();
    return diff / (1000 * 60 * 60 * 24) < 7;
  }

  // ==================== RÉSUMÉ ====================

  summary() {
    return `${this.name} | ${this.verificationBadge()} | Rep: ${this.reputationScore}/100 | ${this.isFavorite ? '★' : ''}`;
  }
}

// ==================== DEFAULT ====================

export function createDefaultContact() {
  return new Contact(
    new Uint8Array(32),
    'Unknown Contact',
    new Uint8Array()
  );
}

export default Contact;