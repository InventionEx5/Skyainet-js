// packages/node/src/node_manager.js
// =====================================================
// NodeManager — Gestionnaire de flotte de nœuds
//
// Responsabilités :
//   • Créer, configurer, payer des nœuds (multi-nœuds)
//   • Gérer le cycle de vie : sleep/wake/lowPower/upgrade
//   • Santé : nodeHealth(), fullStatusReport()
//   • Attestation : générer + vérifier
//   • Mise en location : setForRent(), removeFromRent()
//   • Compatibilité totale avec skycloud.js (pas skynode.js)
//
// Architecture :
//   NodeManager instancie et gère N instances SkyCloud
//   (une par nœud de l'utilisateur). Chaque instance a
//   son propre ID, type, état, wallet et SkyWallet associé.
//
// SkyAInet × Nikola T369
// =====================================================

"use strict";

import { randomUUID }    from 'crypto';
import {
    NodeType, NodeState, NodeRole,
    NodeCapabilities, ReputationTier,
    monthlyPriceEur, computeMultiplier,
    defaultCapabilitiesForType,
    reputationTierFromScore,
    isPaidNodeType,
    Attestation, NodeIdentity,
} from './node_types.js';
import { SkyCloud }      from './skycloud.js';
import { SkyWallet }     from '../../financial/src/wallet.js';
import { NodeEconomics } from '../../core/src/economics.js';
import { AccountType }   from '../../core/src/rewards.js';

// ─────────────────────────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────────────────────────

/** Prix mensuel en SKY (1 EUR ≈ 4 SKY au lancement) */
const SKY_PER_EUR = 4;

const NODE_PRICE_SKY = Object.freeze({
    [NodeType.Mini]       : 0,
    [NodeType.Light]      : Math.round(monthlyPriceEur(NodeType.Light)       * SKY_PER_EUR),
    [NodeType.Full]       : Math.round(monthlyPriceEur(NodeType.Full)        * SKY_PER_EUR),
    [NodeType.Validator]  : Math.round(monthlyPriceEur(NodeType.Validator)   * SKY_PER_EUR),
    [NodeType.DreamWeaver]: Math.round(monthlyPriceEur(NodeType.DreamWeaver) * SKY_PER_EUR),
});

/** Descriptions affichées dans node.html */
const NODE_DESCRIPTIONS = Object.freeze({
    [NodeType.Mini]       : 'Free starter node — basic inference, 8 GB storage, 10 Mbps.',
    [NodeType.Light]      : 'Essential node — GPU support, 128 GB storage, 100 Mbps.',
    [NodeType.Full]       : 'Full-featured node — API Gateway, dynamic sites, 512 GB.',
    [NodeType.Validator]  : 'Consensus node — governance voting, 512 GB, 1 Gbps.',
    [NodeType.DreamWeaver]: 'Dream & evolution node — high compute ×8.5, 512 GB.',
});

const MAX_NODES_PER_USER = 10;

// ─────────────────────────────────────────────────────────────────
// ERREURS
// ─────────────────────────────────────────────────────────────────

export class NodeManagerError extends Error {
    constructor(message, code = 'NODE_ERROR') {
        super(message);
        this.name = 'NodeManagerError';
        this.code = code;
    }
    static notFound(id)      { return new NodeManagerError(`Node not found: ${id}`,             'NOT_FOUND'); }
    static maxReached()      { return new NodeManagerError(`Max ${MAX_NODES_PER_USER} nodes reached`, 'MAX_NODES'); }
    static insufficientFunds(need, have) {
        return new NodeManagerError(`Insufficient SKY — need ${need}, have ${have}`, 'INSUFFICIENT_FUNDS');
    }
    static invalidType(t)    { return new NodeManagerError(`Invalid node type: ${t}`,           'INVALID_TYPE'); }
    static alreadyRented(id) { return new NodeManagerError(`Node ${id} is already for rent`,   'ALREADY_RENTED'); }
}

// ─────────────────────────────────────────────────────────────────
// ENREGISTREMENT D'UN NŒUD
// ─────────────────────────────────────────────────────────────────

export class ManagedNode {
    constructor({
        id, type, alias, state, capabilities,
        reputationScore, createdAt, walletAddress,
        port, isRentedOut, rentalOfferId,
        economics, attestation,
    }) {
        this.id             = id;
        this.type           = type;
        this.alias          = alias ?? `${type}-${id.slice(-6)}`;
        this.state          = state ?? NodeState.Active;
        this.capabilities   = capabilities ?? defaultCapabilitiesForType(type);
        this.reputationScore= reputationScore ?? 0.50;
        this.createdAt      = createdAt ?? Date.now();
        this.walletAddress  = walletAddress ?? null;
        this.port           = port ?? 8080;
        this.isRentedOut    = isRentedOut ?? false;
        this.rentalOfferId  = rentalOfferId ?? null;
        this.economics      = economics ?? new NodeEconomics(AccountType.Free);
        this.attestation    = attestation ?? null;
        // Instance SkyCloud — instanciée lazily
        this._skycloud      = null;
    }

    get reputationTier()    { return reputationTierFromScore(this.reputationScore); }
    get computeMultiplier() { return computeMultiplier(this.type); }
    get priceSky()          { return NODE_PRICE_SKY[this.type] ?? 0; }
    get description()       { return NODE_DESCRIPTIONS[this.type] ?? ''; }
    get isActive()          { return this.state === NodeState.Active; }
    get isSleeping()        { return this.state === NodeState.Sleeping; }
    get isInDream()         { return this.state === NodeState.DreamMode; }

    toJSON() {
        return {
            id             : this.id,
            type           : this.type,
            alias          : this.alias,
            state          : this.state,
            reputationScore: +this.reputationScore.toFixed(4),
            reputationTier : this.reputationTier,
            createdAt      : this.createdAt,
            walletAddress  : this.walletAddress,
            port           : this.port,
            isRentedOut    : this.isRentedOut,
            rentalOfferId  : this.rentalOfferId,
            priceSky       : this.priceSky,
            computeMultiplier: this.computeMultiplier,
            description    : this.description,
            capabilities   : this.capabilities.toJSON?.() ?? this.capabilities,
        };
    }
}

// ─────────────────────────────────────────────────────────────────
// NODE MANAGER
// ─────────────────────────────────────────────────────────────────

export class NodeManager {
    #nodes;        // Map<nodeId, ManagedNode>
    #wallet;       // SkyWallet | null — wallet de l'utilisateur
    #ownerAddress; // string | null

    constructor(opts = {}) {
        this.#nodes        = new Map();
        this.#wallet       = opts.wallet       ?? null;
        this.#ownerAddress = opts.ownerAddress ?? null;
    }

    // ─── Connexion wallet ─────────────────────────────────────

    connectWallet(wallet) {
        if (!(wallet instanceof SkyWallet)) throw new TypeError('Expected SkyWallet');
        this.#wallet       = wallet;
        this.#ownerAddress = wallet.address;
        return { address: wallet.address };
    }

    // ─── Catalogue des types de nœuds ────────────────────────

    /**
     * Retourne le catalogue complet des types de nœuds disponibles
     * avec leurs prix, capacités et multiplicateurs.
     * Utilisé par l'Étape 1 de node.html.
     */
    getNodeCatalog() {
        return Object.values(NodeType)
            .filter(t => ![NodeType.Storage, NodeType.Compute,
                           NodeType.Mixed, NodeType.Sentinel].includes(t))
            .map(type => ({
                type,
                priceSky         : NODE_PRICE_SKY[type] ?? 0,
                priceEur         : monthlyPriceEur(type),
                computeMultiplier: computeMultiplier(type),
                description      : NODE_DESCRIPTIONS[type] ?? '',
                capabilities     : defaultCapabilitiesForType(type).toJSON?.()
                                   ?? defaultCapabilitiesForType(type),
                requiresPayment  : isPaidNodeType(type),
            }));
    }

    // ─── Création d'un nœud ───────────────────────────────────

    /**
     * Crée et configure un nouveau nœud.
     * Étape 3 de node.html : confirmation + paiement SKY.
     *
     * @param {object} opts
     * @param {string}       opts.type         — NodeType.*
     * @param {string}       [opts.alias]      — nom personnalisé
     * @param {number}       [opts.port]       — port d'écoute
     * @param {string}       [opts.storagePlan]— 'starter'|'pro'|'sovereign'
     * @param {string}       [opts.gatewayPlan]— idem
     * @param {string}       [opts.apiKeysPlan]— idem
     * @returns {Promise<ManagedNode>}
     */
    async createNode(opts = {}) {
        const { type, alias, port = 8080 } = opts;

        if (!Object.values(NodeType).includes(type)) {
            throw NodeManagerError.invalidType(type);
        }
        if (this.#nodes.size >= MAX_NODES_PER_USER) {
            throw NodeManagerError.maxReached();
        }

        // Vérifier et débiter le wallet
        const priceSky = NODE_PRICE_SKY[type] ?? 0;
        if (priceSky > 0) {
            const wallet = this.#wallet;
            if (!wallet) throw new NodeManagerError('No wallet connected — connect a wallet first', 'NO_WALLET');
            const balance = await wallet.getBalance();
            if (balance < priceSky) throw NodeManagerError.insufficientFunds(priceSky, balance);
            wallet.debitLocal(priceSky, `Node ${type} — first month`);
        }

        // Créer l'instance ManagedNode
        const id       = `node-${randomUUID().replace(/-/g,'').slice(0,16)}`;
        const caps     = defaultCapabilitiesForType(type);
        const node     = new ManagedNode({
            id, type,
            alias: alias ?? `${type}-${id.slice(-6)}`,
            state: NodeState.Active,
            capabilities: caps,
            reputationScore: 0.50,
            walletAddress: this.#ownerAddress,
            port,
        });

        this.#nodes.set(id, node);

        console.info(`[NodeManager] Nœud créé : ${id} (${type}) — port ${port}`);
        return node;
    }

    // ─── Gestion du cycle de vie ──────────────────────────────

    /**
     * Met un nœud en veille (réduction à 20% de puissance).
     * @param {string} nodeId
     */
    sleepNode(nodeId) {
        const node = this.#get(nodeId);
        node.state = NodeState.Sleeping;
        node.capabilities.adjustForState?.(NodeState.Sleeping);
        console.info(`[NodeManager] ${nodeId} → Sleeping`);
        return node.toJSON();
    }

    /**
     * Réveille un nœud en veille.
     * @param {string} nodeId
     */
    wakeNode(nodeId) {
        const node = this.#get(nodeId);
        if (node.state !== NodeState.Sleeping) {
            throw new NodeManagerError(`Node ${nodeId} is not sleeping`, 'INVALID_STATE');
        }
        node.state = NodeState.Active;
        node.capabilities = defaultCapabilitiesForType(node.type);
        console.info(`[NodeManager] ${nodeId} → Active`);
        return node.toJSON();
    }

    /**
     * Active le mode basse consommation (60% de puissance).
     * @param {string} nodeId
     */
    enableLowPowerMode(nodeId) {
        const node = this.#get(nodeId);
        node.state = NodeState.DreamMode;
        node.capabilities.adjustForState?.(NodeState.DreamMode);
        console.info(`[NodeManager] ${nodeId} → LowPower (DreamMode)`);
        return node.toJSON();
    }

    /**
     * Monte en gamme un nœud existant.
     * Facture la différence de prix pour le mois en cours.
     *
     * @param {string} nodeId
     * @param {string} newType — NodeType.*
     */
    async upgradeNode(nodeId, newType) {
        const node      = this.#get(nodeId);
        const oldPrice  = NODE_PRICE_SKY[node.type] ?? 0;
        const newPrice  = NODE_PRICE_SKY[newType]   ?? 0;
        const diff      = Math.max(0, newPrice - oldPrice);

        if (!Object.values(NodeType).includes(newType)) {
            throw NodeManagerError.invalidType(newType);
        }

        if (diff > 0 && this.#wallet) {
            const balance = await this.#wallet.getBalance();
            if (balance < diff) throw NodeManagerError.insufficientFunds(diff, balance);
            this.#wallet.debitLocal(diff, `Upgrade ${node.type} → ${newType}`);
        }

        const oldType   = node.type;
        node.type        = newType;
        node.capabilities= defaultCapabilitiesForType(newType);

        console.info(`[NodeManager] ${nodeId} upgradé : ${oldType} → ${newType}`);
        return node.toJSON();
    }

    // ─── Santé ────────────────────────────────────────────────

    /**
     * Retourne un rapport de santé condensé du nœud.
     * @param {string} nodeId
     */
    nodeHealth(nodeId) {
        const node  = this.#get(nodeId);
        const score = node.reputationScore;
        const tier  = node.reputationTier;

        return {
            id           : nodeId,
            state        : node.state,
            isOperational: node.isActive,
            reputationScore: score,
            reputationTier : tier,
            uptime       : node.createdAt ? Math.floor((Date.now() - node.createdAt) / 1000) : 0,
            isRentedOut  : node.isRentedOut,
            health       : score >= 0.70 ? 'healthy' : score >= 0.50 ? 'degraded' : 'critical',
        };
    }

    /**
     * Rapport complet du nœud.
     * @param {string} nodeId
     */
    fullStatusReport(nodeId) {
        const node = this.#get(nodeId);
        return {
            ...node.toJSON(),
            health       : this.nodeHealth(nodeId),
            economics    : node.economics?.stats?.() ?? {},
            uptime       : Math.floor((Date.now() - node.createdAt) / 1000),
            attestation  : node.attestation ? {
                valid    : node.attestation.isValid?.() ?? false,
                timestamp: node.attestation.timestamp,
            } : null,
        };
    }

    // ─── Attestation ──────────────────────────────────────────

    /**
     * Génère une attestation cryptographique pour un nœud.
     * Prouve que le nœud était actif à cet instant.
     * @param {string} nodeId
     */
    generateAttestation(nodeId) {
        const node  = this.#get(nodeId);
        const attest = new Attestation(node.alias ?? nodeId);
        node.attestation = attest;
        console.info(`[NodeManager] Attestation générée : ${nodeId}`);
        return {
            nodeId,
            alias    : node.alias,
            timestamp: attest.timestamp,
            nonce    : attest.nonce,
            message  : attest.message,
            valid    : attest.isValid(),
        };
    }

    /**
     * Vérifie une attestation existante.
     * @param {string} nodeId
     */
    verifyAttestation(nodeId) {
        const node = this.#get(nodeId);
        if (!node.attestation) {
            return { valid: false, reason: 'No attestation generated' };
        }
        const valid = node.attestation.isValid();
        return {
            nodeId,
            valid,
            timestamp : node.attestation.timestamp,
            age_seconds: Math.floor((Date.now() - node.attestation.timestamp) / 1000),
            reason    : valid ? 'OK' : 'Attestation expired (> 5 min)',
        };
    }

    // ─── Location Marketplace ─────────────────────────────────

    /**
     * Met un nœud en location sur le Marketplace.
     * Retourne les paramètres de l'offre — à passer à ComputeMarketplace.publishOffer().
     *
     * @param {string} nodeId
     * @param {object} offerOpts
     * @param {number} offerOpts.pricePerHour   — SKY/heure
     * @param {number} offerOpts.availableHours — durée de disponibilité
     * @param {string} [offerOpts.description]
     */
    setForRent(nodeId, offerOpts = {}) {
        const node = this.#get(nodeId);
        if (node.isRentedOut) throw NodeManagerError.alreadyRented(nodeId);
        if (!node.isActive)   throw new NodeManagerError(`Node ${nodeId} must be Active to rent`, 'INVALID_STATE');

        node.isRentedOut   = true;
        const offer = {
            nodeId,
            owner         : this.#ownerAddress ?? 'unknown',
            pricePerHour  : offerOpts.pricePerHour   ?? 1,
            availableHours: offerOpts.availableHours ?? 24,
            tflops        : node.capabilities.compute_power ?? 1,
            description   : offerOpts.description ?? node.description,
            reputationRequired: 0.50,
        };

        console.info(`[NodeManager] ${nodeId} mis en location : ${offer.pricePerHour} SKY/h`);
        return offer;
    }

    /**
     * Retire un nœud de la location.
     * @param {string} nodeId
     */
    removeFromRent(nodeId) {
        const node = this.#get(nodeId);
        node.isRentedOut  = false;
        node.rentalOfferId = null;
        console.info(`[NodeManager] ${nodeId} retiré de la location`);
        return node.toJSON();
    }

    // ─── Liste ────────────────────────────────────────────────

    /** Retourne tous les nœuds de l'utilisateur. */
    listMyNodes() {
        return [...this.#nodes.values()].map(n => n.toJSON());
    }

    /** Retourne un nœud par ID. */
    getNode(nodeId) {
        return this.#get(nodeId).toJSON();
    }

    /** Retourne le ticker des nœuds actifs pour la nav de node.html. */
    getNodeTicker() {
        return [...this.#nodes.values()].map(n => ({
            id    : n.id,
            alias : n.alias,
            type  : n.type,
            state : n.state,
            tier  : n.reputationTier,
            score : +n.reputationScore.toFixed(2),
        }));
    }

    // ─── Stats globales ───────────────────────────────────────

    getStats() {
        const nodes = [...this.#nodes.values()];
        return {
            total   : nodes.length,
            active  : nodes.filter(n => n.isActive).length,
            sleeping: nodes.filter(n => n.isSleeping).length,
            rented  : nodes.filter(n => n.isRentedOut).length,
            maxNodes: MAX_NODES_PER_USER,
        };
    }

    // ─── Privé ────────────────────────────────────────────────

    #get(nodeId) {
        const node = this.#nodes.get(nodeId);
        if (!node) throw NodeManagerError.notFound(nodeId);
        return node;
    }

    // ─── API pour apiHandlers() dans skycloud.js ──────────────

    /**
     * Retourne les handlers REST pour server.js.
     * Branché dans skycloud.js apiHandlers().
     */
    apiHandlers() {
        const m = this;
        return {
            // Catalogue
            'get_node_catalog'    : ()                       => m.getNodeCatalog(),
            // CRUD
            'create_node'         : (type, alias, port)      => m.createNode({ type, alias, port }),
            'list_my_nodes'       : ()                       => m.listMyNodes(),
            'get_node'            : nodeId                   => m.getNode(nodeId),
            'get_node_ticker'     : ()                       => m.getNodeTicker(),
            'get_node_stats'      : ()                       => m.getStats(),
            // Cycle de vie
            'sleep_node'          : nodeId                   => m.sleepNode(nodeId),
            'wake_node'           : nodeId                   => m.wakeNode(nodeId),
            'enable_low_power'    : nodeId                   => m.enableLowPowerMode(nodeId),
            'upgrade_node'        : (nodeId, newType)        => m.upgradeNode(nodeId, newType),
            // Santé
            'node_health'         : nodeId                   => m.nodeHealth(nodeId),
            'full_status_report'  : nodeId                   => m.fullStatusReport(nodeId),
            // Attestation
            'generate_attestation': nodeId                   => m.generateAttestation(nodeId),
            'verify_attestation'  : nodeId                   => m.verifyAttestation(nodeId),
            // Location
            'set_for_rent'        : (nodeId, opts)           => m.setForRent(nodeId, opts),
            'remove_from_rent'    : nodeId                   => m.removeFromRent(nodeId),
        };
    }
}

export { NODE_PRICE_SKY, NODE_DESCRIPTIONS, NodeType, NodeState };
export default NodeManager;
