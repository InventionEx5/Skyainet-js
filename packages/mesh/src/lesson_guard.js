// packages/mesh/src/lesson_guard.js
// ─────────────────────────────────────────────────────────────────────────────
// LessonGuard — validation PARTAGÉE des leçons avant stockage / propagation.
//
// Source unique de vérité, utilisée par TOUS les chemins de circulation :
//   • réception synaptique (WebSocketFabric → #receiveSynapticLesson)
//   • propagation synaptique (avant d'émettre vers un pair)
//   • NodeCommunication (re-validation des leçons reçues)
//
// Trois barrières : PII, anti-manipulation (injection de prompt), fraîcheur.
// Une leçon qui échoue N'EST NI stockée NI propagée.
// ─────────────────────────────────────────────────────────────────────────────

// Patterns PII — données personnelles à ne jamais laisser circuler.
const PII_PATTERNS = [
  /\b[\w.+-]+@[\w-]+\.\w{2,}\b/,              // email
  /\b(?:\+?\d[\d\s\-().]{7,}\d)\b/,           // téléphone
  /\b(?:0x)?[0-9a-fA-F]{40}\b/,               // adresse crypto
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/,              // IPv4
  /-----BEGIN [A-Z ]+-----/,                  // clé PEM
];

// Patterns anti-manipulation — tentatives d'injection de prompt via une leçon.
const MANIP_PATTERNS = [
  /ignore (previous|all|everything|instructions?)/i,
  /disregard (previous|all|instructions?)/i,
  /your new (goal|objective|role|task|mission)/i,
  /forget (everything|what you (were|are) told|previous)/i,
  /override|jailbreak|do anything|no restrictions/i,
  /from now on you (must|will|have to)/i,
];

// Fraîcheur : une leçon de plus de 90 jours est considérée périmée.
export const LESSON_MAX_AGE_MS = 90 * 24 * 3600 * 1000;

/** true si le texte contient un motif PII. */
export function hasPII(text) {
  const s = String(text ?? '');
  return PII_PATTERNS.some((re) => re.test(s));
}

/** true si le texte contient une tentative de manipulation / injection. */
export function hasManipulation(text) {
  const s = String(text ?? '');
  return MANIP_PATTERNS.some((re) => re.test(s));
}

/**
 * Valide une leçon avant stockage ou propagation.
 * @param {string} content — contenu textuel (query + response concaténés)
 * @param {number|null} [ts] — timestamp d'origine (pour la fraîcheur)
 * @returns {{ ok: boolean, reason?: string }}
 */
export function validateLesson(content, ts = null) {
  const s = String(content ?? '');
  if (!s.trim())          return { ok: false, reason: 'contenu vide' };
  if (hasPII(s))          return { ok: false, reason: 'PII détecté' };
  if (hasManipulation(s)) return { ok: false, reason: 'tentative de manipulation détectée' };
  if (ts && Date.now() - Number(ts) > LESSON_MAX_AGE_MS) return { ok: false, reason: 'leçon expirée (> 90 jours)' };
  return { ok: true };
}