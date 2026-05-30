// packages/secure/src/protocol/session.js
// =====================================================
// Session — Gestion Avancée avec Stratégie Hybride
// KemT369 + RomanT369 (SkyAInet × Nikola T369)
// =====================================================

import { HybridTransport, HybridMode } from '../crypto/hybrid.js';

export class SessionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SessionError';
  }
}

export class Session {
  constructor(sessionId, rootKey, isEdgeNode = false) {
    this.sessionId = new Uint8Array(sessionId);
    this.hybridMode = isEdgeNode ? HybridMode.FullGematria : HybridMode.KemT369Core;
    this.sendMessageNumber = 0;
    this.recvMessageNumber = 0;
    this.createdAt = Math.floor(Date.now() / 1000);
    this.lastActivity = this.createdAt;
    this.rootKey = new Uint8Array(rootKey);
    this.isEdgeNode = isEdgeNode;

    // Moteur hybride
    this.hybridEngine = new HybridTransport(false);
    this.hybridEngine.setMode(this.hybridMode);
  }

  /**
   * Change dynamiquement le mode hybride de la session
   */
  setMode(mode) {
    this.hybridMode = mode;
    if (this.hybridEngine) {
      this.hybridEngine.setMode(mode);
    }
    console.debug(`[Session] Mode changé vers ${mode}`);
  }

  /**
   * Chiffre un message selon le mode hybride courant
   */
  encrypt(plaintext) {
    this.lastActivity = Math.floor(Date.now() / 1000);

    if (!this.hybridEngine) {
      throw new SessionError('EncryptionFailed');
    }

    const dummyPublicKey = { ml_kem_public: new Uint8Array(32), is_1024: false };
    const [_, ciphertext] = this.hybridEngine.encrypt(dummyPublicKey, plaintext);

    this.sendMessageNumber++;
    return ciphertext;
  }

  /**
   * Déchiffre un message
   */
  decrypt(ciphertext) {
    this.lastActivity = Math.floor(Date.now() / 1000);

    if (!this.hybridEngine) {
      throw new SessionError('DecryptionFailed');
    }

    const plaintext = this.hybridEngine.decrypt(this.rootKey, { ml_kem_ciphertext: ciphertext }, ciphertext, this.hybridMode);

    this.recvMessageNumber++;
    return plaintext;
  }

  /**
   * Déclenche manuellement un Flash Gematria
   */
  triggerFlash() {
    if (this.isEdgeNode) {
      console.warn('[Session] Flash Gematria ignoré sur un nœud edge');
      return;
    }

    this.setMode(HybridMode.FlashGematria);
    console.debug('[Session] Flash Gematria déclenché manuellement');
  }

  /**
   * Vérifie si la session doit être renouvelée
   */
  shouldRotate() {
    const now = Math.floor(Date.now() / 1000);
    return (now - this.createdAt > 86400) || this.sendMessageNumber > 1_000_000;
  }

  /**
   * Retourne le mode hybride actuel
   */
  currentMode() {
    return this.hybridMode;
  }
}