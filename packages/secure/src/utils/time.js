// packages/secure/src/utils/time.js
// =====================================================
// Time Utilities — Fonctions Temporelles
// SkyAInet × Nikola T369
// =====================================================

"use strict";

// ─────────────────────────────────────────────────────────────────
// CORE
// ─────────────────────────────────────────────────────────────────

/** Timestamp Unix courant en secondes (entier). */
export function nowTimestamp() {
  return Math.floor(Date.now() / 1000);
}

/** Timestamp Unix courant en millisecondes. */
export function nowMs() {
  return Date.now();
}

/** Secondes écoulées depuis un timestamp Unix. Toujours ≥ 0. */
export function elapsedSince(timestamp) {
  return Math.max(0, nowTimestamp() - timestamp);
}

/** Millisecondes écoulées depuis un timestamp en ms. Toujours ≥ 0. */
export function elapsedMsSince(timestampMs) {
  return Math.max(0, Date.now() - timestampMs);
}

// ─────────────────────────────────────────────────────────────────
// FORMATAGE
// ─────────────────────────────────────────────────────────────────

/**
 * Formate un timestamp Unix en ISO 8601 lisible.
 * @param {number} ts — secondes Unix
 * @returns {string}   ex. "2025-06-01T14:23:05.000Z"
 */
export function formatTimestamp(ts) {
  return new Date(ts * 1000).toISOString();
}

/**
 * Formate une durée en secondes en chaîne lisible.
 * @param {number} secs
 * @returns {string}  ex. "2j 3h 15m 42s"
 */
export function formatDuration(secs) {
  if (secs < 0) return '0s';
  const d = Math.floor(secs / 86_400);
  const h = Math.floor((secs % 86_400) / 3_600);
  const m = Math.floor((secs % 3_600) / 60);
  const s = Math.floor(secs % 60);
  const parts = [];
  if (d > 0) parts.push(`${d}j`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (s > 0 || parts.length === 0) parts.push(`${s}s`);
  return parts.join(' ');
}

// ─────────────────────────────────────────────────────────────────
// VALIDATION
// ─────────────────────────────────────────────────────────────────

/**
 * Retourne true si le timestamp Unix est plus récent que maxAgeSecs.
 * Utile pour vérifier la fraîcheur d'une attestation ou d'un message.
 */
export function isFresh(timestamp, maxAgeSecs) {
  return elapsedSince(timestamp) <= maxAgeSecs;
}

/**
 * Retourne true si le timestamp Unix est expiré (plus vieux que ttlSecs).
 */
export function isExpired(timestamp, ttlSecs) {
  return elapsedSince(timestamp) > ttlSecs;
}

/**
 * Retourne le timestamp d'expiration d'un élément créé à `createdAt`
 * avec une durée de vie `ttlSecs`.
 */
export function expiresAt(createdAt, ttlSecs) {
  return createdAt + ttlSecs;
}

// ─────────────────────────────────────────────────────────────────
// LOG
// ─────────────────────────────────────────────────────────────────

export function logTimestamp(ts) {
  const elapsed = elapsedSince(ts);
  console.debug(`[Time] ts=${ts} (${formatTimestamp(ts)}) — écoulé: ${formatDuration(elapsed)}`);
}
