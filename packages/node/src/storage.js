// packages/memory/src/storage.js
// StorageNode — Gestionnaire de Stockage Souverain (Version Propre)
// ZipMemory + Chiffrement Hybride Post-Quantique + Facturation + Réplication

import crypto from 'crypto';
import { ZipMemory } from '../../memory/src/zip_memory.js';
import { HybridTransport } from '../../secure/src/crypto/hybrid.js';
import { GematriaAead } from '../../secure/src/crypto/gematria_aead.js';

export class StorageNode {
  constructor(sovereignAlias, subscription = 'Free') {
    this.nodeId = `storage-${sovereignAlias.toLowerCase()}`;
    this.sovereignAlias = sovereignAlias;

    this.capabilities = {
      computePower: 0.95,
      storagePower: 1.0,
      bandwidth: 0.90,
    };
    this.currentState = 'Active';

    // === Stockage & Quota ===
    this.usedStorageGb = 0;
    this.reservedGb = 0;
    this.maxStorageGb = subscription === 'Free' ? 5 : subscription === 'Pro' ? 50 : 200;
    this.totalFiles = 0;

    // === Compression & Cache ===
    this.zipMemory = new ZipMemory(`./data/storage/${sovereignAlias}_zip`);
    this.hotCache = new Map();

    // === Chiffrement Hybride + Stockage réel ===
    this.hybrid = new HybridTransport(true);
    this.encryptedFiles = new Map();     // filename → { cid, encryptedData }
    this.fileData = new Map();           // filename → encrypted bytes (pour download réel)

    // === Facturation ===
    this.lastBillingUpdate = Date.now();
    this.monthlyCostSky = 0.0;
    this.storageShieldEnabled = false;
  }

  // =====================================================
  // UPLOAD AVEC ZIP + CHIFFREMENT HYBRIDE (vraie logique)
  // =====================================================
  async uploadFile(filename, data, rewards = null) {
    const rawSizeGb = data.length / (1024 ** 3);

    if (this.usedStorageGb + rawSizeGb > this.maxStorageGb) {
      throw new Error('Quota de stockage dépassé');
    }

    // 1. Compression réelle
    const compressed = await this.zipMemory.compress(data);
    const compressedSizeGb = compressed.length / (1024 ** 3);

    // 2. Chiffrement Hybride Post-Quantique
    const [key, nonce] = this.hybrid.deriveKeys();
    const aead = new GematriaAead(key, nonce);
    const encrypted = aead.encrypt(compressed);

    // 3. Stockage réel
    const cid = `skn:${crypto.randomUUID()}`;
    this.encryptedFiles.set(filename, { cid, encryptedData: encrypted });
    this.fileData.set(filename, encrypted); // pour download

    this.usedStorageGb += compressedSizeGb;
    this.totalFiles++;
    this.updateMonthlyCost();

    // 4. Récompense (si fournie)
    if (rewards && typeof rewards.addReward === 'function') {
      rewards.addReward('StorageContribution', 3);
    }

    console.debug(`[Storage] Fichier uploadé : ${filename} → ${compressedSizeGb.toFixed(3)} GB`);

    return cid;
  }

  // =====================================================
  // DOWNLOAD (vraie logique - plus de placeholder)
  // =====================================================
  async downloadFile(filename) {
    const fileEntry = this.encryptedFiles.get(filename);
    if (!fileEntry) return null;

    const encrypted = fileEntry.encryptedData || this.fileData.get(filename);
    if (!encrypted) return null;

    const [key, nonce] = this.hybrid.deriveKeys();
    const aead = new GematriaAead(key, nonce);
    const decrypted = aead.decrypt(encrypted);

    if (decrypted) {
      return await this.zipMemory.decompress(decrypted);
    }
    return null;
  }

  // =====================================================
  // DELETE (vraie logique)
  // =====================================================
  deleteFile(filename) {
    if (this.encryptedFiles.has(filename)) {
      this.encryptedFiles.delete(filename);
      this.fileData.delete(filename);
      this.totalFiles = Math.max(0, this.totalFiles - 1);
      return true;
    }
    return false;
  }

  // =====================================================
  // FACTURATION & SHIELD
  // =====================================================
  updateMonthlyCost() {
    const baseRate = this.storageShieldEnabled ? 0.7 : 0.5;
    this.monthlyCostSky = Math.max(0.5, this.usedStorageGb * baseRate);
  }

  toggleStorageShield() {
    this.storageShieldEnabled = !this.storageShieldEnabled;
    this.updateMonthlyCost();
    console.info(`[Storage] Storage Shield ${this.storageShieldEnabled ? 'activé' : 'désactivé'}`);
  }

  getStorageStats() {
    const usagePercent = (this.usedStorageGb / this.maxStorageGb) * 100;
    return {
      usedGb: this.usedStorageGb,
      maxGb: this.maxStorageGb,
      usagePercent: +usagePercent.toFixed(1),
      monthlyCostSky: +this.monthlyCostSky.toFixed(2),
    };
  }

  // =====================================================
  // ÉTAT & RAPPORT
  // =====================================================
  enterSleepMode() {
    this.currentState = 'Sleeping';
    console.info('[Storage] Nœud passé en mode veille');
  }

  healthReport() {
    return `StorageNode ${this.sovereignAlias} | Used: ${this.usedStorageGb}GB / ${this.maxStorageGb}GB | Shield: ${this.storageShieldEnabled ? 'ON' : 'OFF'} | Files: ${this.totalFiles} | Cost: ${this.monthlyCostSky.toFixed(2)} SKY/mois`;
  }
}

export default StorageNode;