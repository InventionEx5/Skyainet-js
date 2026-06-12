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
import { SkyCloud }           from './skycloud.js';
import { SkyWallet }          from '../../financial/src/wallet.js';
import { NodeEconomics }      from '../../core/src/economics.js';
import { AccountType }        from '../../core/src/rewards.js';
import { ValidatorNode }      from './validator.js';
import { Sentinel }           from './auto_healing.js';
import { MigrationManager }   from './migration_manager.js';

// ─────────────────────────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────────────────────────

/** Prix mensuel en SKY (1 EUR ≈ 4 SKY au lancement) */
const SKY_PER_EUR = 4;

const NODE_PRICE_SKY = Object.freeze({
    [NodeType.Mini]       : 0,
    [NodeType.Light]      : Math.round(monthlyPriceEur(NodeType.Light)       * SKY_PER_EUR),
    [NodeType.Full]       : Math.round(monthlyPriceEur(NodeType.Full)        * SKY_PER_EUR),
    [NodeType.Storage]    : Math.round(monthlyPriceEur(NodeType.Storage)     * SKY_PER_EUR),
    [NodeType.Compute]    : Math.round(monthlyPriceEur(NodeType.Compute)     * SKY_PER_EUR),
    [NodeType.Mixed]      : Math.round(monthlyPriceEur(NodeType.Mixed)       * SKY_PER_EUR),
    [NodeType.Sentinel]   : Math.round(monthlyPriceEur(NodeType.Sentinel)    * SKY_PER_EUR),
    [NodeType.Validator]  : Math.round(monthlyPriceEur(NodeType.Validator)   * SKY_PER_EUR),
    [NodeType.DreamWeaver]: Math.round(monthlyPriceEur(NodeType.DreamWeaver) * SKY_PER_EUR),
});

/** Descriptions affichées dans node.html */
const NODE_DESCRIPTIONS = Object.freeze({
    [NodeType.Mini]       : 'Free starter node — basic inference, 8 GB storage, 10 Mbps.',
    [NodeType.Light]      : 'Essential node — GPU support, 128 GB storage, 100 Mbps.',
    [NodeType.Full]       : 'Full-featured node — API Gateway, dynamic sites, 512 GB.',
    [NodeType.Storage]    : 'Dedicated storage node — 512 GB, 3-node replication, ZipMemory.',
    [NodeType.Compute]    : 'Pure compute node — ×10 multiplier, ideal for LoRA training.',
    [NodeType.Mixed]      : 'Versatile node — balanced compute + storage + gateway.',
    [NodeType.Sentinel]   : 'Auto-healing & self-defense node — monitors and repairs.',
    [NodeType.DreamWeaver]: 'Dream & evolution node — high compute ×8.5, 512 GB.',
    [NodeType.Validator]  : 'Consensus node — governance voting, 1 Gbps. Min 8 000 SKY stake.',
});

/** Rôle réseau par défaut pour chaque type */
const NODE_DEFAULT_ROLE = Object.freeze({
    [NodeType.Mini]       : NodeRole.Edge,
    [NodeType.Light]      : NodeRole.Core,
    [NodeType.Full]       : NodeRole.Full,
    [NodeType.Storage]    : NodeRole.Storage,
    [NodeType.Compute]    : NodeRole.Compute,
    [NodeType.Mixed]      : NodeRole.Full,
    [NodeType.Sentinel]   : NodeRole.Sentinel,
    [NodeType.DreamWeaver]: NodeRole.DreamWeaver,
    [NodeType.Validator]  : NodeRole.Validator,
});

/** Stake minimum en SKY pour les types qui l'exigent */
const MIN_STAKE_SKY = Object.freeze({
    [NodeType.Validator]: 8_000,
    [NodeType.Sentinel] : 1_000,
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
        economics, attestation, role,
        stakeAmount,
    }) {
        this.id             = id;
        this.type           = type;
        this.alias          = alias ?? `${type}-${id.slice(-6)}`;
        this.state          = state ?? NodeState.Active;
        this.role           = role  ?? NODE_DEFAULT_ROLE[type] ?? NodeRole.Core;
        this.capabilities   = capabilities ?? defaultCapabilitiesForType(type);
        this.reputationScore= reputationScore ?? 0.50;
        this.createdAt      = createdAt ?? Date.now();
        this.walletAddress  = walletAddress ?? null;
        this.port           = port ?? 8080;
        this.isRentedOut    = isRentedOut ?? false;
        this.rentalOfferId  = rentalOfferId ?? null;
        this.economics      = economics ?? new NodeEconomics(AccountType.Free);
        this.attestation    = attestation ?? null;
        this.stakeAmount    = stakeAmount ?? 0;
        // Instances spécialisées — instanciées lazily selon le type
        this._validatorNode = null;   // ValidatorNode (si type === Validator)
        this._sentinel      = null;   // Sentinel (si type === Sentinel)
    }

    get reputationTier()    { return reputationTierFromScore(this.reputationScore); }
    get computeMultiplier() { return computeMultiplier(this.type); }
    get priceSky()          { return NODE_PRICE_SKY[this.type] ?? 0; }
    get description()       { return NODE_DESCRIPTIONS[this.type] ?? ''; }
    get isActive()          { return this.state === NodeState.Active; }
    get isSleeping()        { return this.state === NodeState.Sleeping; }
    get isInDream()         { return this.state === NodeState.DreamMode; }
    get minStakeSky()       { return MIN_STAKE_SKY[this.type] ?? 0; }
    get isStakeValid()      { return this.stakeAmount >= this.minStakeSky; }

    toJSON() {
        return {
            id              : this.id,
            type            : this.type,
            role            : this.role,
            alias           : this.alias,
            state           : this.state,
            reputationScore : +this.reputationScore.toFixed(4),
            reputationTier  : this.reputationTier,
            createdAt       : this.createdAt,
            walletAddress   : this.walletAddress,
            port            : this.port,
            isRentedOut     : this.isRentedOut,
            rentalOfferId   : this.rentalOfferId,
            priceSky        : this.priceSky,
            computeMultiplier: this.computeMultiplier,
            description     : this.description,
            stakeAmount     : this.stakeAmount,
            minStakeSky     : this.minStakeSky,
            isStakeValid    : this.isStakeValid,
            capabilities    : this.capabilities.toJSON?.() ?? this.capabilities,
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
     * Retourne le catalogue complet des 9 types de nœuds disponibles
     * avec leurs prix, capacités, rôle par défaut et stake minimum.
     * Utilisé par l'Étape 1 de node.html.
     */
    getNodeCatalog() {
        return Object.values(NodeType).map(type => ({
            type,
            priceSky         : NODE_PRICE_SKY[type]    ?? 0,
            priceEur         : monthlyPriceEur(type),
            computeMultiplier: computeMultiplier(type),
            description      : NODE_DESCRIPTIONS[type] ?? '',
            defaultRole      : NODE_DEFAULT_ROLE[type]  ?? NodeRole.Core,
            minStakeSky      : MIN_STAKE_SKY[type]      ?? 0,
            capabilities     : defaultCapabilitiesForType(type).toJSON?.()
                               ?? defaultCapabilitiesForType(type),
            requiresPayment  : isPaidNodeType(type),
            requiresStake    : (MIN_STAKE_SKY[type] ?? 0) > 0,
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
        const { type, alias, port = 8080, role } = opts;

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

        // Vérifier stake minimum pour Validator/Sentinel
        const minStake = MIN_STAKE_SKY[type] ?? 0;
        if (minStake > 0 && this.#wallet) {
            const balance = await this.#wallet.getBalance();
            if (balance < minStake) {
                throw new NodeManagerError(
                    `${type} requires a minimum stake of ${minStake} SKY — current balance: ${balance} SKY`,
                    'INSUFFICIENT_STAKE'
                );
            }
        }

        const id       = `node-${randomUUID().replace(/-/g,'').slice(0,16)}`;
        const caps     = defaultCapabilitiesForType(type);
        const nodeRole = role ?? NODE_DEFAULT_ROLE[type] ?? NodeRole.Core;
        const node     = new ManagedNode({
            id, type,
            alias      : alias ?? `${type}-${id.slice(-6)}`,
            state      : NodeState.Active,
            role       : nodeRole,
            capabilities: caps,
            reputationScore: 0.50,
            walletAddress  : this.#ownerAddress,
            port,
            stakeAmount    : 0,
        });

        // Initialiser le ValidatorNode si type Validator
        if (type === NodeType.Validator) {
            node._validatorNode = new ValidatorNode(node.alias, 0);
        }

        // Initialiser le Sentinel si type Sentinel
        if (type === NodeType.Sentinel) {
            node._sentinel = new Sentinel();
        }

        this.#nodes.set(id, node);
        console.info(`[NodeManager] Nœud créé : ${id} (${type}/${nodeRole}) — port ${port}`);
        return node;
    }

    // ─── Validator Stake ──────────────────────────────────────

    /**
     * Ajoute du stake SKY à un nœud Validator.
     * Débite le wallet de l'utilisateur.
     * @param {string} nodeId
     * @param {number} amount — SKY à staker
     */
    async addValidatorStake(nodeId, amount) {
        const node = this.#get(nodeId);
        if (node.type !== NodeType.Validator && node.type !== NodeType.Sentinel) {
            throw new NodeManagerError(`addStake is only for Validator/Sentinel nodes`, 'INVALID_TYPE');
        }
        if (amount <= 0) throw new NodeManagerError('Amount must be positive', 'INVALID_AMOUNT');

        if (this.#wallet) {
            const balance = await this.#wallet.getBalance();
            if (balance < amount) throw NodeManagerError.insufficientFunds(amount, balance);
            this.#wallet.debitLocal(amount, `Stake — ${node.alias}`);
        }

        node.stakeAmount += amount;

        // Synchroniser avec le ValidatorNode si existant
        if (node._validatorNode) {
            node._validatorNode.addStake(amount);
        }

        console.info(`[NodeManager] Stake +${amount} SKY → ${nodeId} (total: ${node.stakeAmount})`);
        return { nodeId, stakeAmount: node.stakeAmount, minStakeSky: node.minStakeSky, isValid: node.isStakeValid };
    }

    /**
     * Retire du stake SKY d'un nœud Validator.
     * Crédite le wallet de l'utilisateur.
     * @param {string} nodeId
     * @param {number} amount
     */
    async removeValidatorStake(nodeId, amount) {
        const node = this.#get(nodeId);
        const remaining = node.stakeAmount - amount;
        const minStake  = node.minStakeSky;

        if (remaining > 0 && remaining < minStake) {
            throw new NodeManagerError(
                `Removing ${amount} SKY would leave ${remaining} SKY — minimum is ${minStake} SKY`,
                'INSUFFICIENT_STAKE'
            );
        }

        node.stakeAmount = Math.max(0, remaining);

        if (this.#wallet && amount > 0) {
            this.#wallet.creditLocal(amount);
        }

        if (node._validatorNode) {
            try { node._validatorNode.removeStake(amount); } catch { /* ok */ }
        }

        console.info(`[NodeManager] Stake -${amount} SKY → ${nodeId} (total: ${node.stakeAmount})`);
        return { nodeId, stakeAmount: node.stakeAmount, isValid: node.isStakeValid };
    }

    /**
     * Retourne les infos de stake d'un nœud.
     * @param {string} nodeId
     */
    getStakeInfo(nodeId) {
        const node = this.#get(nodeId);
        return {
            nodeId     : nodeId,
            type       : node.type,
            stakeAmount: node.stakeAmount,
            minStakeSky: node.minStakeSky,
            isValid    : node.isStakeValid,
            canVote    : node.stakeAmount >= 15_000,
            canValidate: node.stakeAmount >= 8_000,
        };
    }

    // ─── Sentinel — Auto-healing ──────────────────────────────

    /**
     * Lance une analyse de santé via Sentinel sur un nœud.
     * Retourne les problèmes détectés.
     * @param {string} nodeId
     */
    detectSentinelIssues(nodeId) {
        const node = this.#get(nodeId);
        if (!node._sentinel) {
            // Créer un Sentinel temporaire pour n'importe quel nœud
            const s = new Sentinel();
            // Construire un objet status minimal pour Sentinel.detectIssues()
            const fakeStatus = {
                id         : nodeId,
                wisdomScore: node.reputationScore,
                state      : node.state,
                engineReady: node.isActive,
                peers      : 0,
            };
            const issues = s.detectIssues({ getStatus: () => fakeStatus });
            return { nodeId, issues: issues.map(i => ({ message: i.message, severity: i.severity })) };
        }

        const fakeStatus = {
            id         : nodeId,
            wisdomScore: node.reputationScore,
            state      : node.state,
            engineReady: node.isActive,
            peers      : 0,
        };
        const issues = node._sentinel.detectIssues({ getStatus: () => fakeStatus });
        return {
            nodeId,
            issues : issues.map(i => ({ message: i.message, severity: i.severity })),
            stats  : {
                issuesDetected: node._sentinel.issuesDetected,
                healsPerformed: node._sentinel.healsPerformed,
                lastHealing   : node._sentinel.lastHealing,
            },
        };
    }

    /**
     * Lance l'auto-heal Sentinel sur un nœud.
     * Tente de réparer automatiquement les problèmes détectés.
     * @param {string} nodeId
     */
    async runSentinelHeal(nodeId) {
        const node = this.#get(nodeId);
        if (!node._sentinel) node._sentinel = new Sentinel();

        // Pour chaque problème — appliquer les actions de réparation possibles
        const fakeStatus = {
            id         : nodeId,
            wisdomScore: node.reputationScore,
            state      : node.state,
            engineReady: node.isActive,
            peers      : 0,
        };
        const issues = node._sentinel.detectIssues({ getStatus: () => fakeStatus });

        // Actions de réparation simplifiées
        const healed = [];
        for (const issue of issues) {
            if (issue.severity === 'Medium' && node.state === NodeState.Sleeping) {
                node.state = NodeState.Active;
                healed.push(`Woke up sleeping node`);
            }
            if (issue.severity === 'High' && node.reputationScore < 0.5) {
                // Boost léger de réputation
                node.reputationScore = Math.min(0.55, node.reputationScore + 0.05);
                healed.push(`Reputation stabilized`);
            }
        }

        node._sentinel.healsPerformed += healed.length;
        node._sentinel.lastHealing     = Date.now();

        console.info(`[NodeManager] Sentinel heal ${nodeId} — ${healed.length} action(s)`);
        return {
            nodeId,
            issuesFound : issues.length,
            healed      : healed.length,
            actions     : healed,
            newState    : node.state,
        };
    }

    // ─── Migration ────────────────────────────────────────────

    /**
     * Prépare un plan de migration d'un nœud vers un autre.
     * Utilise MigrationManager pour chiffrer le TravelPackage.
     * @param {string} fromNodeId
     * @param {string} toNodeId
     */
    planMigration(fromNodeId, toNodeId) {
        const from = this.#get(fromNodeId);
        const to   = this.#get(toNodeId);

        // MigrationManager prépare le package (sans Personality ici — stub)
        const mm = new MigrationManager({ enabled: true });

        const plan = {
            planId    : `mig-${randomUUID().slice(-8)}`,
            fromNodeId,
            toNodeId,
            fromType  : from.type,
            toType    : to.type,
            fromAlias : from.alias,
            toAlias   : to.alias,
            stakeAmount: from.stakeAmount,
            createdAt : Date.now(),
            status    : 'planned',
        };

        console.info(`[NodeManager] Migration planifiée : ${fromNodeId} → ${toNodeId}`);
        return plan;
    }

    /**
     * Exécute une migration : transfère les données d'un nœud à l'autre.
     * @param {string} fromNodeId
     * @param {string} toNodeId
     */
    async executeMigration(fromNodeId, toNodeId) {
        const from = this.#get(fromNodeId);
        const to   = this.#get(toNodeId);

        // Transférer les attributs clés
        to.stakeAmount    = from.stakeAmount;
        to.reputationScore= from.reputationScore;
        to.walletAddress  = from.walletAddress;

        // Mettre l'ancien nœud en Stopped
        from.state     = NodeState.Stopped;
        from.stakeAmount = 0;

        console.info(`[NodeManager] Migration exécutée : ${fromNodeId} → ${toNodeId}`);
        return {
            success    : true,
            fromNodeId,
            toNodeId,
            fromState  : from.state,
            toState    : to.state,
            transferred: { stakeAmount: to.stakeAmount, reputation: to.reputationScore },
        };
    }

    // ─── États étendus ────────────────────────────────────────

    /**
     * Passe un nœud en mode Maintenance.
     */
    setMaintenance(nodeId) {
        const node = this.#get(nodeId);
        node.state = NodeState.Maintenance;
        return node.toJSON();
    }

    /**
     * Passe un nœud en mode Syncing.
     */
    setSyncing(nodeId) {
        const node = this.#get(nodeId);
        node.state = NodeState.Syncing;
        return node.toJSON();
    }

    /**
     * Arrête complètement un nœud.
     */
    stopNode(nodeId) {
        const node = this.#get(nodeId);
        node.state = NodeState.Stopped;
        return node.toJSON();
    }

    /**
     * Passe un nœud en mode Gateway (expose toutes ses API).
     */
    setGatewayMode(nodeId) {
        const node = this.#get(nodeId);
        node.state = NodeState.Gateway;
        node.role  = NodeRole.Gateway;
        return node.toJSON();
    }

    /**
     * Passe un nœud en mode Evolving (LoRA actif).
     */
    setEvolving(nodeId) {
        const node = this.#get(nodeId);
        node.state = NodeState.Evolving;
        return node.toJSON();
    }
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
            'get_node_catalog'      : ()                         => m.getNodeCatalog(),
            // CRUD
            'create_node'           : (type, alias, port, role)  => m.createNode({ type, alias, port, role }),
            'list_my_nodes'         : ()                         => m.listMyNodes(),
            'get_node'              : nodeId                     => m.getNode(nodeId),
            'get_node_ticker'       : ()                         => m.getNodeTicker(),
            'get_node_stats'        : ()                         => m.getStats(),
            // Cycle de vie de base
            'sleep_node'            : nodeId                     => m.sleepNode(nodeId),
            'wake_node'             : nodeId                     => m.wakeNode(nodeId),
            'enable_low_power'      : nodeId                     => m.enableLowPowerMode(nodeId),
            'upgrade_node'          : (nodeId, newType)          => m.upgradeNode(nodeId, newType),
            // États étendus
            'set_maintenance'       : nodeId                     => m.setMaintenance(nodeId),
            'set_syncing'           : nodeId                     => m.setSyncing(nodeId),
            'stop_node'             : nodeId                     => m.stopNode(nodeId),
            'set_gateway_mode'      : nodeId                     => m.setGatewayMode(nodeId),
            'set_evolving'          : nodeId                     => m.setEvolving(nodeId),
            // Santé
            'node_health'           : nodeId                     => m.nodeHealth(nodeId),
            'full_status_report'    : nodeId                     => m.fullStatusReport(nodeId),
            // Attestation
            'generate_attestation'  : nodeId                     => m.generateAttestation(nodeId),
            'verify_attestation'    : nodeId                     => m.verifyAttestation(nodeId),
            // Validator Stake
            'add_validator_stake'   : (nodeId, amount)           => m.addValidatorStake(nodeId, amount),
            'remove_validator_stake': (nodeId, amount)           => m.removeValidatorStake(nodeId, amount),
            'get_stake_info'        : nodeId                     => m.getStakeInfo(nodeId),
            // Sentinel
            'detect_sentinel_issues': nodeId                     => m.detectSentinelIssues(nodeId),
            'run_sentinel_heal'     : nodeId                     => m.runSentinelHeal(nodeId),
            // Migration
            'plan_migration'        : (fromId, toId)             => m.planMigration(fromId, toId),
            'execute_migration'     : (fromId, toId)             => m.executeMigration(fromId, toId),
            // Location
            'set_for_rent'          : (nodeId, opts)             => m.setForRent(nodeId, opts),
            'remove_from_rent'      : nodeId                     => m.removeFromRent(nodeId),
        };
    }
}

export { NODE_PRICE_SKY, NODE_DESCRIPTIONS, NodeType, NodeState };
export default NodeManager;