// packages/model/src/thevie/pii_redaction.js
//
// COUCHE PII / RÉDACTION — souveraineté des données.
// Avant qu'un prompt ne quitte le périmètre vers une IA externe, on remplace les
// données sensibles par des marqueurs ([EMAIL], [PHONE], [CARD]…). Irréversible
// par défaut (le plus sûr) ; mode réversible disponible (map de restauration)
// pour ré-injecter les valeurs dans la réponse si nécessaire.
//
// Ordre des règles IMPORTANT : on masque les secrets/cartes (riches en chiffres)
// AVANT les téléphones, pour éviter qu'un numéro de carte soit pris pour un tél.

// Luhn : valide un numéro de carte (réduit les faux positifs).
function luhnValid(digits) {
  let sum = 0, alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (alt) { d *= 2; if (d > 9) d -= 9; }
    sum += d; alt = !alt;
  }
  return digits.length >= 13 && sum % 10 === 0;
}

// Règles, appliquées dans l'ordre. `validate` (optionnel) filtre les faux positifs.
const DEFAULT_RULES = [
  { type: 'SECRET', re: /\b(?:sk-|pk-|rk-|ghp_|gho_|xox[baprs]-|AKIA|ASIA)[A-Za-z0-9_\-]{12,}\b/g },
  { type: 'JWT',    re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { type: 'EMAIL',  re: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g },
  { type: 'IBAN',   re: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g },
  { type: 'CARD',   re: /\b(?:\d[ \-]?){13,19}\b/g, validate: (m) => luhnValid(m.replace(/[ \-]/g, '')) },
  { type: 'SSN',    re: /\b\d{3}-\d{2}-\d{4}\b/g },
  { type: 'IPV4',   re: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g },
  { type: 'PHONE',  re: /(?:\+?\d[\d\s().\-]{8,}\d)/g, validate: (m) => (m.replace(/\D/g, '').length >= 9) },
  { type: 'HEX',    re: /\b[0-9a-fA-F]{32,}\b/g },
];

export class Redactor {
  /**
   * @param {object}   [opts]
   * @param {boolean}  [opts.reversible=false] — conserver une map pour restaurer
   * @param {RegExp[]} [opts.allowList=[]]     — motifs à NE PAS masquer (faux positifs connus)
   * @param {Array}    [opts.rules]            — règles personnalisées (sinon DEFAULT_RULES)
   */
  constructor(opts = {}) {
    this.reversible = opts.reversible ?? false;
    this.allowList  = opts.allowList ?? [];
    this.rules      = opts.rules ?? DEFAULT_RULES;
  }

  _allowed(value) { return this.allowList.some(re => { re.lastIndex = 0; return re.test(value); }); }

  /**
   * Masque les données sensibles d'un texte.
   * @returns {{ text:string, found:Record<string,number>, map:Map<string,string>|null, count:number }}
   */
  redact(text) {
    if (typeof text !== 'string' || !text) return { text: text ?? '', found: {}, map: null, count: 0 };
    const found = {};
    const map = this.reversible ? new Map() : null;
    const counters = {};
    let out = text;

    for (const rule of this.rules) {
      rule.re.lastIndex = 0;
      out = out.replace(rule.re, (m) => {
        if (rule.validate && !rule.validate(m)) return m;   // faux positif → on garde
        if (this._allowed(m)) return m;                     // allow-list → on garde
        found[rule.type] = (found[rule.type] ?? 0) + 1;
        const n = (counters[rule.type] = (counters[rule.type] ?? 0) + 1);
        const token = `[${rule.type}${n > 1 || map ? '_' + n : ''}]`;
        if (map) map.set(token, m);
        return token;
      });
    }
    const count = Object.values(found).reduce((s, n) => s + n, 0);
    return { text: out, found, map, count };
  }

  /** Restaure les valeurs originales (mode réversible). */
  restore(text, map) {
    if (!map) return text;
    let out = text;
    for (const [token, value] of map) out = out.split(token).join(value);
    return out;
  }

  /**
   * Masque le contenu de chaque message (rôle préservé). Agrège ce qui a été
   * masqué sur l'ensemble.
   * @returns {{ messages:object[], found:Record<string,number>, count:number, maps:(Map|null)[] }}
   */
  redactMessages(messages) {
    const found = {}; let count = 0; const maps = [];
    const redacted = messages.map(m => {
      const r = this.redact(typeof m.content === 'string' ? m.content : '');
      maps.push(r.map);
      for (const [k, v] of Object.entries(r.found)) found[k] = (found[k] ?? 0) + v;
      count += r.count;
      return { ...m, content: r.text };
    });
    return { messages: redacted, found, count, maps };
  }
}

export const DEFAULT_REDACTOR = new Redactor();
