// packages/financial/src/fee_engine.js
// ─────────────────────────────────────────────────────────────────────────────
// FeeEngine — Gestion centralisée de tous les frais du protocole SkyAInet.
//
// PRINCIPES :
//   • Chaque frais est nommé, documenté, tracé.
//   • Destination unique : ThevieOps (wallet IA) ou Escrow (caution remboursable).
//   • La trésorerie (burn/users/DAO/dev) redistribue ensuite depuis ThevieOps
//     automatiquement via Thevie (Dream Cycle).
//   • Tous les montants en SKY (entiers, Math.floor).
// ─────────────────────────────────────────────────────────────────────────────

// ── Barème des frais fixes (SKY) ────────────────────────────────────────────
export const FEE = Object.freeze({
  // ── Smart contracts (génération + déploiement via LoraÉvo) ──────────────
  CONTRACT_GENERATE     :  50,   // Génération du code Solidity par l'IA
  CONTRACT_DEPLOY       : 100,   // Déploiement on-chain (inclut la réserve gas)

  // ── Sites web souverains (LoraÉvo Sovereign Web Hosting) ────────────────
  SITE_CREATE           :  30,   // Création + scaffolding IA
  SITE_PUBLISH          :  20,   // Publication + CDN (par publication)
  SITE_UPLOAD_MB        :   2,   // Par Mo uploadé (arrondi au Mo supérieur)

  // ── LoraÉvo auto-training (compute GPU par session) ─────────────────────
  LORA_TRAINING_SESSION :   5,   // Par session d'entraînement automatique

  // ── Nœuds (déploiement via Thevie) ─ barème dans node_manager.js ────────
  // Les frais de nœud sont déterminés par NODE_PRICE_SKY (type-dépendant).
  // On ne les redéfinit pas ici pour éviter la duplication.
  // Rappel : Mini = 0, Light = 24, Full = 72, Compute = 96, etc. (4 SKY/EUR)

  // ── Migration de nœud ────────────────────────────────────────────────────
  NODE_MIGRATION        :  10,   // Migration d'un nœud (TravelPackage)

  // ── Staking (verrouillage et retrait) ────────────────────────────────────
  STAKE_RATE            : 0.005, // 0.5% du montant mis/retiré

  // ── Gouvernance (proposals) ──────────────────────────────────────────────
  PROPOSAL_DEPOSIT      :  25,   // Caution anti-spam (→ Escrow, remboursée si accepted)
  VOTE_FLAT             :   1,   // Frais symbolique par vote (décourage le spam)

  // ── GPU / CPU rental (en sus du 7% propriétaire déjà dans marketplace.js) ─
  GPU_RENTAL_RATE       : 0.02,  // 2% du prix de location → ThevieOps (infra réseau)
  NODE_RENTAL_RATE      : 0.03,  // 3% du prix de location nœud → ThevieOps

  // ── Transfert SKY (sendSKY) ──────────────────────────────────────────────
  TRANSFER_RATE         : 0.005, // 0.5% du montant envoyé

  // ── Trading (exécution de mandat) ────────────────────────────────────────
  TRADE_RATE            : 0.01,  // 1% par exécution de mandat (broker fee)

  // ── Achat en SKY (swap/purchase on-chain) ────────────────────────────────
  PURCHASE_RATE         : 0.02,  // 2% du montant de l'achat (protocole swap)

  // ── Renouvellement mensuel de nœud ───────────────────────────────────────
  // Identique au prix de déploiement (barème node_manager.js → NODE_PRICE_SKY)

  // ── Frais manquants non oubliés (à activer selon roadmap) ────────────────
  // STORAGE_GB_MONTH     :   1,  // Stockage au-delà du quota du nœud
  // API_KEY_PRO_MONTH    :  50,  // Clé API scoped (usage professionnel)
});

// ── Destinations des frais ───────────────────────────────────────────────────
// Toutes les constantes ci-dessous correspondent aux noms dans WalletRegistry.
export const FEE_DEST = Object.freeze({
  // Compte opérationnel IA → ThevieOps → trésorerie → burn/users/DAO/dev
  AI_OPS  : 'thevie-ops',
  // Caution remboursable (proposal deposit, gas futur)
  ESCROW  : 'escrow',
});

// ── Calculs (montants finaux) ────────────────────────────────────────────────
export class FeeEngine {
  #wallets; // WalletRegistry

  constructor(wallets) {
    this.#wallets = wallets;
  }

  /**
   * Débite le fee depuis le wallet utilisateur vers ThevieOps.
   * @param {string}     feeKey   — clé de FEE (ex. 'CONTRACT_GENERATE')
   * @param {SkyWallet}  userWallet
   * @param {number}     [baseAmount] — montant de base pour les taux (RATE)
   * @returns {{ ok:boolean, fee:number, reason?:string }}
   */
  async charge(feeKey, userWallet, baseAmount = 0) {
    const raw = FEE[feeKey] ?? 0;
    const fee = raw < 1
      ? Math.floor(baseAmount * raw)   // taux (0.005 etc.)
      : Math.floor(raw);               // montant fixe
    if (fee <= 0) return { ok: true, fee: 0 };

    const bal = await userWallet.getBalance().catch(() => 0);
    if (bal < fee) return { ok: false, fee, reason: `Insufficient balance (${bal} SKY < ${fee} SKY required)` };

    try {
      userWallet.debitLocal(fee, `Fee: ${feeKey}`);
      this.#wallets?.system(FEE_DEST.AI_OPS)?.creditLocal(fee);
      return { ok: true, fee };
    } catch (e) {
      return { ok: false, fee, reason: e?.message ?? 'debit error' };
    }
  }

  /**
   * Caution Escrow (proposal, gas).
   * @returns {{ ok:boolean, fee:number, depositId:string, reason?:string }}
   */
  async deposit(feeKey, userWallet, depositId) {
    const fee = Math.floor(FEE[feeKey] ?? 0);
    if (fee <= 0) return { ok: true, fee: 0, depositId };

    const bal = await userWallet.getBalance().catch(() => 0);
    if (bal < fee) return { ok: false, fee, depositId, reason: `Insufficient balance (${bal} SKY < ${fee} SKY required)` };

    try {
      userWallet.debitLocal(fee, `Deposit: ${feeKey} [${depositId}]`);
      this.#wallets?.system(FEE_DEST.ESCROW)?.creditLocal(fee);
      return { ok: true, fee, depositId };
    } catch (e) {
      return { ok: false, fee, depositId, reason: e?.message ?? 'deposit error' };
    }
  }

  /**
   * Remboursement de caution Escrow.
   */
  refund(feeKey, userWallet, depositId) {
    const fee = Math.floor(FEE[feeKey] ?? 0);
    if (fee <= 0) return { ok: true, fee: 0, depositId };
    try {
      this.#wallets?.system(FEE_DEST.ESCROW)?.debitLocal(fee, `Refund: ${feeKey} [${depositId}]`);
      userWallet.creditLocal(fee);
      return { ok: true, fee, depositId };
    } catch (e) {
      return { ok: false, fee, depositId, reason: e?.message ?? 'refund error' };
    }
  }

  /** Résumé du barème (pour l'UI). */
  schedule() { return { ...FEE }; }

  /** Estimation non-débitée (pour affichage avant confirmation). */
  estimate(feeKey, baseAmount = 0) {
    const raw = FEE[feeKey] ?? 0;
    return raw < 1 ? Math.floor(baseAmount * raw) : Math.floor(raw);
  }
}
