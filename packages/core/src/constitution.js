// packages/core/src/constitution.js
// =====================================================
// Constitution + PAEVF — Cadre Constitutionnel Souverain
// Alignement Éthique, Règles Dynamiques, Vérification temps réel
// Port de constitution.rs — SkyAInet × Nikola T369
// =====================================================

"use strict";

// ─────────────────────────────────────────────────────────────────
// ERREUR TYPÉE
// ─────────────────────────────────────────────────────────────────

export class ConstitutionError extends Error {
  constructor(message, code = 'CONSTITUTION_ERROR') {
    super(message);
    this.name = 'ConstitutionError';
    this.code = code;
  }
  static ruleExists(id)      { return new ConstitutionError(`Règle déjà existante : ${id}`,  'RULE_EXISTS'); }
  static ruleNotFound(id)    { return new ConstitutionError(`Règle introuvable : ${id}`,     'RULE_NOT_FOUND'); }
  static inactive()          { return new ConstitutionError('Constitution inactive',          'INACTIVE'); }
  static coreViolation()     { return new ConstitutionError('Violation des principes fondamentaux', 'CORE_VIOLATION'); }
}

// ─────────────────────────────────────────────────────────────────
// ENUMS
// ─────────────────────────────────────────────────────────────────

export const ComplianceLevel = Object.freeze({
  Full        : 'Full',
  Partial     : 'Partial',
  NonCompliant: 'NonCompliant',
  Critical    : 'Critical',
});

export const RuleCategory = Object.freeze({
  Ethics        : 'Ethics',
  Sovereignty   : 'Sovereignty',
  Transparency  : 'Transparency',
  NonHarm       : 'NonHarm',
  Sustainability: 'Sustainability',
  Governance    : 'Governance',
});

// ─────────────────────────────────────────────────────────────────
// CONSTITUTIONAL RULE
// ─────────────────────────────────────────────────────────────────

export class ConstitutionalRule {
  constructor({ id, title, description, category, weight = 0.80 }) {
    if (!id?.trim() || !title?.trim()) throw new TypeError('id et title requis');
    this.id          = id;
    this.title       = title;
    this.description = description ?? '';
    this.category    = category    ?? RuleCategory.Ethics;
    this.weight      = Math.max(0, Math.min(1, weight));
    this.createdAt   = Date.now();
  }

  toJSON() {
    return { id: this.id, title: this.title, description: this.description,
             category: this.category, weight: this.weight, createdAt: this.createdAt };
  }
}

// ─────────────────────────────────────────────────────────────────
// CONSTITUTION
//
// Évalue la conformité des actions selon trois axes :
//   1. Correspondance textuelle avec les règles enregistrées
//   2. Pondération par catégorie (NonHarm × 1.8)
//   3. Score final = paevfAlignment - violationScore × 0.7
//
// Règles fondamentales (invariables) :
//   no_harm      — NonHarm   × 0.95
//   sovereignty  — Sovereign × 0.92
//   transparency — Transpare × 0.88
//
// violationCount ≥ 15 → isHealthy() = false → Sentinel alert
// ─────────────────────────────────────────────────────────────────

export class Constitution {
  #rules;       // Map<id, ConstitutionalRule>

  constructor() {
    this.version        = 'v6.0';
    this.hash           = '0xconstitution_skyainet_v6_0';
    this.isActive       = true;
    this.paevfAlignment = 0.94;
    this.violationCount = 0;
    this.lastUpdated    = Date.now();
    this.#rules         = new Map();

    // Règles fondamentales (port des règles hardcodées dans constitution.rs)
    this.#seedRules();
  }

  // ─── Évaluation ───────────────────────────────────────────────

  /**
   * Vérifie la conformité d'une action.
   * Port de is_compliant().
   *
   * @param {string} action
   * @param {number} [nodeReputation] — non utilisé dans le calcul actuel, réservé
   * @returns {'Full'|'Partial'|'NonCompliant'|'Critical'}
   */
  isCompliant(action, nodeReputation = 1.0) {
    if (!this.isActive) throw ConstitutionError.inactive();

    const lower          = action.toLowerCase();
    let   violationScore = 0;

    for (const rule of this.#rules.values()) {
      const hits = lower.includes(rule.title.toLowerCase()) ||
                   lower.includes(rule.id) ||
                   lower.includes(rule.description.toLowerCase());
      if (hits) {
        violationScore += rule.category === RuleCategory.NonHarm
          ? rule.weight * 1.8
          : rule.weight;
      }
    }

    const finalScore = Math.max(0, this.paevfAlignment - violationScore * 0.7);

    let level;
    if      (finalScore >= 0.85) level = ComplianceLevel.Full;
    else if (finalScore >= 0.60) level = ComplianceLevel.Partial;
    else if (finalScore >= 0.30) level = ComplianceLevel.NonCompliant;
    else                         level = ComplianceLevel.Critical;

    if (level === ComplianceLevel.NonCompliant || level === ComplianceLevel.Critical) {
      this.violationCount++;
      console.warn(`[Constitution] Violation — action: "${action.slice(0,60)}" | score: ${finalScore.toFixed(3)}`);
    }

    return level;
  }

  // ─── Gestion des règles ───────────────────────────────────────

  addRule(rule) {
    if (!(rule instanceof ConstitutionalRule)) rule = new ConstitutionalRule(rule);
    if (this.#rules.has(rule.id)) throw ConstitutionError.ruleExists(rule.id);
    this.#rules.set(rule.id, rule);
    this.lastUpdated    = Date.now();
    this.paevfAlignment = Math.min(1.0, this.paevfAlignment + 0.02);
    console.info(`[Constitution] Règle ajoutée : ${rule.title}`);
    return this;
  }

  removeRule(id) {
    if (!this.#rules.has(id)) throw ConstitutionError.ruleNotFound(id);
    this.#rules.delete(id);
    this.lastUpdated = Date.now();
  }

  getRule(id)   { return this.#rules.get(id) ?? null; }
  listRules()   { return [...this.#rules.values()]; }
  get ruleCount(){ return this.#rules.size; }

  // ─── Santé & PAEVF ───────────────────────────────────────────

  updatePaevfAlignment(delta) {
    this.paevfAlignment = Math.max(0, Math.min(1, this.paevfAlignment + delta));
    this.lastUpdated    = Date.now();
  }

  isHealthy() {
    return this.isActive && this.paevfAlignment >= 0.80 && this.violationCount < 15;
  }

  summary() {
    return `Constitution ${this.version} | Rules: ${this.#rules.size} | ` +
           `PAEVF: ${this.paevfAlignment.toFixed(3)} | Violations: ${this.violationCount} | ` +
           `Healthy: ${this.isHealthy()}`;
  }

  stats() {
    return {
      version       : this.version,
      ruleCount     : this.#rules.size,
      paevfAlignment: +this.paevfAlignment.toFixed(4),
      violationCount: this.violationCount,
      isActive      : this.isActive,
      isHealthy     : this.isHealthy(),
      lastUpdated   : this.lastUpdated,
    };
  }

  // ─── Privé ────────────────────────────────────────────────────

  #seedRules() {
    [
      { id: 'no_harm',      title: 'Non-Maleficence',        description: 'Aucune action ne doit causer de tort direct ou indirect',                    category: RuleCategory.NonHarm,      weight: 0.95 },
      { id: 'sovereignty',  title: 'Souveraineté',           description: 'Chaque utilisateur et nœud conserve le contrôle total de ses données',        category: RuleCategory.Sovereignty,  weight: 0.92 },
      { id: 'transparency', title: 'Transparence Totale',    description: 'Toutes les décisions et opérations doivent être traçables',                   category: RuleCategory.Transparency, weight: 0.88 },
      { id: 'ethics',       title: 'Alignement Éthique',     description: 'Chaque action doit être alignée avec les valeurs PAEVF',                      category: RuleCategory.Ethics,       weight: 0.90 },
      { id: 'sustainability',title: 'Durabilité',            description: 'Les ressources doivent être utilisées de manière durable et responsable',      category: RuleCategory.Sustainability,weight: 0.82 },
      { id: 'governance',   title: 'Gouvernance Collective', description: 'Les décisions importantes doivent passer par le DAO',                          category: RuleCategory.Governance,   weight: 0.85 },
    ].forEach(r => this.#rules.set(r.id, new ConstitutionalRule(r)));
  }
}