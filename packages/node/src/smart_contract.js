// packages/node/src/smart_contract.js
// ─────────────────────────────────────────────────────────────────────────────
// Smart Contracts — rattaché à la page Skycloud (modal « Learn »).
//
// La génération, le déploiement et le stockage des contrats sont assurés par
// LoraÉvo (lora_evolution.js) : « comme Thevie crée des nœuds, LoraÉvo crée des
// Smart Contracts ». Ce manager n'est qu'une FAÇADE + les handlers API, qui
// délèguent à `node.loraEvo`. Migré depuis skycloud.js.
// ─────────────────────────────────────────────────────────────────────────────

export class SmartContractManager {
  #node;

  constructor(node) {
    if (!node) throw new Error('[SmartContractManager] instance node requise');
    this.#node = node;
  }

  /** Accès à LoraÉvo (lève si non initialisée), pour les opérations mutantes. */
  #evo() {
    const evo = this.#node.loraEvo;
    if (!evo) throw new Error('LoraÉvo non initialisée');
    return evo;
  }

  /**
   * Génère un Smart Contract Solidity via LoraÉvo.
   * @param {string} description
   * @param {object} options
   */
  async generateSmartContract(description, options = {}) {
    return this.#evo().generateSmartContract(description, options);
  }

  /**
   * Déploie un contrat généré sur le réseau configuré.
   * @param {string} contractId
   * @returns {Promise<{ contractAddress, txHash, deployedAt }>}
   */
  async deploySmartContract(contractId) {
    return this.#evo().deployContract(contractId);
  }

  /**
   * Retourne la liste de tous les contrats générés.
   * @returns {ContractSummary[]}
   */
  listSmartContracts() {
    return this.#node.loraEvo?.listContracts() ?? [];
  }

  /**
   * Retourne un contrat complet avec son code Solidity.
   * @param {string} contractId
   * @returns {GeneratedContract | null}
   */
  getSmartContract(contractId) {
    return this.#node.loraEvo?.getContract(contractId) ?? null;
  }

  /**
   * Supprime un contrat de la liste locale.
   * @param {string} contractId
   */
  deleteSmartContract(contractId) {
    this.#evo().deleteContract(contractId);
  }

  /**
   * Stats Smart Contracts (calculées depuis la liste LoraÉvo).
   * @returns {{ contractsGenerated, contractsDeployed, skySpent, byType }}
   */
  getSmartContractStats() {
    const contracts = this.listSmartContracts();
    const byType    = contracts.reduce((acc, c) => {
      acc[c.type] = (acc[c.type] ?? 0) + 1;
      return acc;
    }, {});
    return {
      contractsGenerated: contracts.length,
      contractsDeployed : contracts.filter(c => c.deployStatus === 'deployed').length,
      skySpent          : contracts.reduce((s, c) => s + (c.skyFee ?? 0), 0),
      byType,
    };
  }

  // ── Handlers API (page Skycloud · modal Learn) — migrés depuis skycloud.js ──
  apiHandlers(node) {
    return {
      generateSmartContract : (desc, opts) => this.generateSmartContract(desc, opts),
      deploySmartContract   : (contractId) => this.deploySmartContract(contractId),
      listSmartContracts    : ()           => this.listSmartContracts(),
      getSmartContract      : (contractId) => this.getSmartContract(contractId),
      deleteSmartContract   : (contractId) => this.deleteSmartContract(contractId),
      getSmartContractStats : ()           => this.getSmartContractStats(),
    };
  }
}

export default SmartContractManager;
