// packages/secure/src/utils/time.js
// =====================================================
// Time Utilities — Fonctions Temporelles Simples
// Compatible avec tout le projet (Contact, DID, Groupes)
// SkyAInet × Nikola T369
// =====================================================

export function nowTimestamp() {
  return Math.floor(Date.now() / 1000);
}

export function formatTimestamp(ts) {
  return ts.toString();
}

export function elapsedSince(timestamp) {
  return Math.max(0, nowTimestamp() - timestamp);
}

export function logTimestamp(ts) {
  const elapsed = elapsedSince(ts);
  console.debug(`[Time] Timestamp: \( {ts} ( \){elapsed} secondes)`);
}