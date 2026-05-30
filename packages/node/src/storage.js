// packages/node/src/storage.js
// =====================================================
// StorageNode — Gestionnaire de Stockage Souverain
// SkyAInet – ZipMemory + Chiffrement Hybride Post‑Quantique + Facturation + Réplication
// =====================================================

import { NodeCapabilities, NodeState, SubscriptionLevel } from '../../core/src/node_types.js';
import { UserRewards, RewardReason } from '../../core/src/rewards.js';
import { HybridTransport } from '../../secure/src/crypto/hybrid.js';
import { GematriaAead } from '../../secure/src/crypto/gematria_aead.js';
import { RomanT369, GematriaMode } from '../../secure/src/crypto/roman_t369.js';
import { ZipMemory } from '../../memory/src/zip_memory.js';

export class StorageNode {
  /**
   * @param {string} sovereignAlias
   * @param {string} subscription - clé de SubscriptionLevel (Free, Pro, Validator, etc.)
   */
  constructor(sovereignAlias, subscription) {
    this.nodeId = `storage-${sovereignAlias.toLowerCase()}`;
    this.sovereignAlias = sovereignAlias;
    this.capabilities = new NodeCapabilities(subscription);
    this.currentState = NodeState.Active;

    // Définition du stockage maximal selon l'abonnement
    const maxMap = {
      [SubscriptionLevel.Free]: 5,
      [SubscriptionLevel.Pro]: 50,
      [SubscriptionLevel.Validator]: 200,
    };
    this.maxStorageGb = maxMap[subscription] ?? 20;

    this.usedStorageGb = 0;
    this.reservedGb = 0;
    this.totalFiles = 0;

    // Compression & cache
    this.zipMemory = new ZipMemory(`./data/storage/${sovereignAlias}_zip`);
    this.hotCache = new Map(); // Map<string, Uint8Array>

    // Chiffrement hybride post‑quantique
    this.hybrid = new HybridTransport(true); // mode full post‑quantum
    this.encryptedFiles = new Map(); // Map<filename, cid>

    this.lastBillingUpdate = Date.now();
    this.monthlyCostSky = 0.0;
    this.storageShieldEnabled = false;
  }

  // ---------- Dérivation de clés ponctuelles ----------
  #deriveEncryptionKeys() {
    // HybridTransport expose une méthode pour obtenir key/nonce
    // Dans l'implémentation actuelle, on peut directement appeler cette méthode.
    return this.hybrid.deriveKeys();
  }

  // ---------- Upload optimisé ----------
  /**
   * @param {string} filename
   * @param {Uint8Array} data
   * @param {UserRewards} rewards
   * @returns {Promise<string>} CID
   */
  async uploadFile(filename, data, rewards) {
    const rawSizeGb = data.byteLength / (1024 ** 3);

    if (this.usedStorageGb + rawSizeGb > this.maxStorageGb) {
      throw new Error('Quota de stockage dépassé');
    }

    // Compression
    const compressed = await this.zipMemory.compress(data);
    const compressedSizeGb = compressed.byteLength / (1024 ** 3);

    // Chiffrement hybride
    const [key, nonce] = this.#deriveEncryptionKeys();
    const aead = new GematriaAead(key, nonce);
    const encrypted = aead.encrypt(compressed);

    // Génération CID
    const cid = `skn:${globalThis.crypto?.randomUUID?.() ?? Date.now()}`;

    this.usedStorageGb += compressedSizeGb;
    this.totalFiles += 1;
    this.encryptedFiles.set(filename, cid);

    this.#updateMonthlyCost();

    rewards.addReward(RewardReason.StorageContribution, 3);

    console.debug(`[Storage] Fichier uploadé : ${filename} → ${compressedSizeGb.toFixed(3)} GB (compressé)`);
    return cid;
  }

  // ---------- Téléchargement ----------
  /**
   * @param {string} filename
   * @returns {Promise<Uint8Array|null>}
   */
  async downloadFile(filename) {
    const cid = this.encryptedFiles.get(filename);
    if (!cid) return null;

    // Simulation de récupération (à remplacer par un accès réel au réseau)
    const encrypted = new Uint8Array(1024); // placeholder

    const [key, nonce] = this.#deriveEncryptionKeys();
    const aead = new GematriaAead(key, nonce);

    try {
      const decrypted = aead.decrypt(encrypted);
      return await this.zipMemory.decompress(decrypted);
    } catch {
      return null;
    }
  }

  // ---------- Suppression ----------
  /**
   * @param {string} filename
   * @returns {boolean}
   */
  deleteFile(filename) {
    if (!this.encryptedFiles.has(filename)) return false;
    this.encryptedFiles.delete(filename);
    this.totalFiles = Math.max(0, this.totalFiles - 1);
    // Libération de l'espace : la logique réelle doit être implémentée dans ZipMemory
    return true;
  }

  // ---------- Facturation ----------
  #updateMonthlyCost() {
    const baseRate = this.storageShieldEnabled ? 0.7 : 0.5; // SKY/GB/mois
    this.monthlyCostSky = Math.max(0.5, this.usedStorageGb * baseRate);
    this.lastBillingUpdate = Date.now();
  }

  toggleStorageShield() {
    this.storageShieldEnabled = !this.storageShieldEnabled;
    this.#updateMonthlyCost();
    console.info(`[Storage] Storage Shield ${this.storageShieldEnabled ? 'activé' : 'désactivé'}`);
  }

  // ---------- Statistiques ----------
  getStorageStats() {
    const usagePercent = (this.usedStorageGb / this.maxStorageGb) * 100;
    return {
      usedGb: this.usedStorageGb,
      maxGb: this.maxStorageGb,
      usagePercent,
      monthlyCostSky: this.monthlyCostSky,
    };
  }

  // ---------- Mode veille ----------
  enterSleepMode() {
    this.currentState = NodeState.Sleeping;
    console.info('[Storage] Nœud passé en mode veille');
  }

  // ---------- Rapport ----------
  healthReport() {
    return (
      `StorageNode ${this.sovereignAlias} | ` +
      `Used: ${this.usedStorageGb.toFixed(2)}GB / ${this.maxStorageGb}GB | ` +
      `Shield: ${this.storageShieldEnabled ? 'ON' : 'OFF'} | ` +
      `Files: ${this.totalFiles} | ` +
      `Cost: ${this.monthlyCostSky.toFixed(2)} SKY/mois`
    );
  }
}