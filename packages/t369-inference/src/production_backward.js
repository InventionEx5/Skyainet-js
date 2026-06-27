// packages/t369-inference/src/production_backward.js
//
// ADAPTATEURS DE PRODUCTION — backward qui matche EXACTEMENT le forward T369 réel.
//
//  (1) MoE routé top-k (moe.js) avec STRAIGHT-THROUGH sur la sélection :
//      scores = hidden·routerRow ; softmax(N) ; top-K ; w_k = p[id_k]/Σ p[id_j] ;
//      output = Σ_k w_k · expert_k(hidden).  La SÉLECTION top-k est non
//      différentiable → on la fige (straight-through). Restent différentiables et
//      entraînés : les poids des experts choisis, les poids de gate (via la
//      renormalisation + softmax) et le routeur.
//
//  (2) Attention GQA + RoPE (roman_attention.js) :
//      Q=X·wQ [H], K=X·wK [kvW], V=X·wV [kvW] ; RoPE sur Q (par tête) et K (par
//      tête KV), PAS sur V ; tête de requête qh → tête KV kh=⌊qh/rep⌋ (K/V
//      partagés) ; softmax causal ; out=attnOut·wO. RoPE = rotation linéaire →
//      backward = rotation inverse. GQA → les gradients des têtes Q d'un même
//      groupe s'accumulent sur la tête KV partagée.
//
// Les experts réutilisent le FFN SwiGLU déjà vérifié (transformer_backward).
// Tout est gradient-checké contre différences finies (Float64).

import { ffnForward, ffnBackward } from '#transformer_backward';
import { _internal } from '#attention_backward';
const { mat, matmul, transpose } = _internal;

function copyMat(A) { const O = mat(A.length, A[0].length); for (let i = 0; i < A.length; i++) O[i].set(A[i]); return O; }
function dot(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }
function softmax(s) { let mx = -Infinity; for (const v of s) if (v > mx) mx = v; let sum = 0; const p = new Float64Array(s.length); for (let i = 0; i < s.length; i++) { p[i] = Math.exp(s[i] - mx); sum += p[i]; } if (sum < 1e-12) sum = 1; for (let i = 0; i < p.length; i++) p[i] /= sum; return p; }

// ════════════════ (1) MoE ROUTÉ — straight-through top-k ════════════════
function routerScores(hidden, routerRows) { const N = routerRows.length, s = new Float64Array(N); for (let e = 0; e < N; e++) s[e] = dot(hidden, routerRows[e]); return s; }
function topK(p, k) {
  const N = p.length, ids = [], used = new Uint8Array(N);
  for (let i = 0; i < k; i++) { let bi = -1, bv = -Infinity; for (let e = 0; e < N; e++) { if (used[e]) continue; if (p[e] > bv) { bv = p[e]; bi = e; } } if (bi < 0) break; ids.push(bi); used[bi] = 1; }
  return ids;
}

/** Forward MoE complet (sélectionne les experts top-k). */
export function moeForward(hidden, routerRows, experts, { topK: K = 2 } = {}) {
  const H = hidden.length;
  const s = routerScores(hidden, routerRows);
  const p = softmax(s);
  const ids = topK(p, Math.min(K, experts.length));
  const wts = ids.map(i => p[i]); let wSum = wts.reduce((a, b) => a + b, 0); if (wSum < 1e-12) wSum = 1;
  const w = wts.map(x => x / wSum);
  const output = new Float64Array(H), eout = [], caches = [];
  for (let k = 0; k < ids.length; k++) {
    const r = ffnForward([hidden], experts[ids[k]].Wup, experts[ids[k]].Wgate, experts[ids[k]].Wdown);
    const ek = r.Y[0]; eout.push(ek); caches.push(r.cache);
    for (let i = 0; i < H; i++) output[i] += w[k] * ek[i];
  }
  return { output, cache: { hidden, routerRows, experts, p, ids, wts, wSum, w, eout, caches } };
}

/** Forward MoE à SÉLECTION FIGÉE (pour gradient-check du chemin straight-through). */
export function moeForwardFixed(hidden, routerRows, experts, ids) {
  const H = hidden.length;
  const p = softmax(routerScores(hidden, routerRows));
  const wts = ids.map(i => p[i]); let wSum = wts.reduce((a, b) => a + b, 0); if (wSum < 1e-12) wSum = 1;
  const w = wts.map(x => x / wSum);
  const output = new Float64Array(H);
  for (let k = 0; k < ids.length; k++) {
    const ek = ffnForward([hidden], experts[ids[k]].Wup, experts[ids[k]].Wgate, experts[ids[k]].Wdown).Y[0];
    for (let i = 0; i < H; i++) output[i] += w[k] * ek[i];
  }
  return output;
}

/** Backward MoE : gradients hidden, routeur (toutes les lignes), experts choisis. */
export function moeBackward(dOutput, cache) {
  const { hidden, routerRows, p, ids, wts, wSum, w, eout, caches } = cache;
  const N = routerRows.length, H = hidden.length, K = ids.length;
  const dHidden = new Float64Array(H);
  const dRouterRows = Array.from({ length: N }, () => new Float64Array(H));
  const dExperts = {};
  const dw = new Float64Array(K);

  // (A) experts (reçoivent w_k·dOutput) + (B) gradient sur les poids de combinaison
  for (let k = 0; k < K; k++) {
    const dYk = [new Float64Array(H)]; for (let i = 0; i < H; i++) dYk[0][i] = w[k] * dOutput[i];
    const eb = ffnBackward(dYk, caches[k]);
    for (let i = 0; i < H; i++) dHidden[i] += eb.dX[0][i];
    dExperts[ids[k]] = { dWup: eb.dWup, dWgate: eb.dWgate, dWdown: eb.dWdown };
    dw[k] = dot(dOutput, eout[k]);
  }

  // (C) renormalisation w_k = wts_k / wSum
  let dotw = 0; for (let k = 0; k < K; k++) dotw += dw[k] * w[k];
  const dwts = new Float64Array(K); for (let k = 0; k < K; k++) dwts[k] = (dw[k] - dotw) / wSum;

  // (D) softmax (couple TOUS les experts) : dp non nul seulement aux sélectionnés
  let sumdp = 0; for (let k = 0; k < K; k++) sumdp += dwts[k] * wts[k];
  const dpFull = new Float64Array(N); for (let k = 0; k < K; k++) dpFull[ids[k]] = dwts[k];
  const ds = new Float64Array(N); for (let e = 0; e < N; e++) ds[e] = p[e] * (dpFull[e] - sumdp);

  // (E) routeur + hidden : s_e = hidden·routerRow_e
  for (let e = 0; e < N; e++) { const d = ds[e]; if (d === 0) continue; for (let i = 0; i < H; i++) { dRouterRows[e][i] += d * hidden[i]; dHidden[i] += d * routerRows[e][i]; } }

  return { dHidden, dRouterRows, dExperts };
}

// ════════════════ (2) ATTENTION GQA + RoPE ════════════════
export function buildRope(maxPos, headDim, ropeBase = 10000) {
  const cos = new Float64Array(maxPos * headDim), sin = new Float64Array(maxPos * headDim);
  for (let pos = 0; pos < maxPos; pos++) {
    const base = pos * headDim;
    for (let d = 0; d < headDim; d += 2) { const freq = pos / Math.pow(ropeBase, d / headDim); const c = Math.cos(freq), s = Math.sin(freq); cos[base + d] = c; cos[base + d + 1] = c; sin[base + d] = s; sin[base + d + 1] = s; }
  }
  return { cos, sin };
}
function ropeFwd(v, off, pos, headDim, rope) { const base = pos * headDim; for (let d = 0; d < headDim; d += 2) { const c = rope.cos[base + d], s = rope.sin[base + d], a = v[off + d], b = v[off + d + 1]; v[off + d] = a * c - b * s; v[off + d + 1] = a * s + b * c; } }
function ropeBwd(v, off, pos, headDim, rope) { const base = pos * headDim; for (let d = 0; d < headDim; d += 2) { const c = rope.cos[base + d], s = rope.sin[base + d], da = v[off + d], db = v[off + d + 1]; v[off + d] = da * c + db * s; v[off + d + 1] = -da * s + db * c; } }

export function gqaRopeForward(X, wQ, wK, wV, wO, cfg, rope) {
  const { qH, kvH, headDim } = cfg, rep = qH / kvH, H = qH * headDim, scale = 1 / Math.sqrt(headDim);
  const T = X.length;
  const Q = matmul(X, wQ), Kc = matmul(X, wK), Vc = matmul(X, wV);   // [T×H],[T×kvW],[T×kvW]
  const Qr = copyMat(Q), Kr = copyMat(Kc);
  for (let t = 0; t < T; t++) { for (let qh = 0; qh < qH; qh++) ropeFwd(Qr[t], qh * headDim, t, headDim, rope); for (let kh = 0; kh < kvH; kh++) ropeFwd(Kr[t], kh * headDim, t, headDim, rope); }

  const A = [], attnOut = mat(T, H);
  for (let t = 0; t < T; t++) {
    const arow = [];
    for (let qh = 0; qh < qH; qh++) {
      const kh = (qh / rep) | 0, qoff = qh * headDim, koff = kh * headDim;
      const sc = new Float64Array(t + 1); let mx = -Infinity;
      for (let ki = 0; ki <= t; ki++) { let d0 = 0; for (let d = 0; d < headDim; d++) d0 += Qr[t][qoff + d] * Kr[ki][koff + d]; d0 *= scale; sc[ki] = d0; if (d0 > mx) mx = d0; }
      let sum = 0; for (let ki = 0; ki <= t; ki++) { const e = Math.exp(sc[ki] - mx); sc[ki] = e; sum += e; } const inv = sum > 0 ? 1 / sum : 0;
      for (let ki = 0; ki <= t; ki++) { sc[ki] *= inv; for (let d = 0; d < headDim; d++) attnOut[t][qoff + d] += sc[ki] * Vc[ki][koff + d]; }
      arow.push(sc);
    }
    A.push(arow);
  }
  const Y = matmul(attnOut, wO);
  return { Y, cache: { X, wQ, wK, wV, wO, Qr, Kr, Vc, A, attnOut, cfg, rope, scale, H, kvW: kvH * headDim, rep } };
}

export function gqaRopeBackward(dY, cache) {
  const { X, wQ, wK, wV, wO, Qr, Kr, Vc, A, attnOut, cfg, rope, scale, H, kvW, rep } = cache;
  const { qH, kvH, headDim } = cfg, T = X.length;
  const dWo = matmul(transpose(attnOut), dY);
  const dAttn = matmul(dY, transpose(wO));                 // [T×H]
  const dQr = mat(T, H), dKr = mat(T, kvW), dVc = mat(T, kvW);

  for (let t = 0; t < T; t++) {
    for (let qh = 0; qh < qH; qh++) {
      const kh = (qh / rep) | 0, qoff = qh * headDim, koff = kh * headDim, a = A[t][qh];
      const dAh = new Float64Array(t + 1);
      for (let ki = 0; ki <= t; ki++) { let da = 0; for (let d = 0; d < headDim; d++) { da += dAttn[t][qoff + d] * Vc[ki][koff + d]; dVc[ki][koff + d] += a[ki] * dAttn[t][qoff + d]; } dAh[ki] = da; }
      let dotv = 0; for (let ki = 0; ki <= t; ki++) dotv += dAh[ki] * a[ki];
      for (let ki = 0; ki <= t; ki++) { const ds = (dAh[ki] - dotv) * a[ki] * scale; for (let d = 0; d < headDim; d++) { dQr[t][qoff + d] += ds * Kr[ki][koff + d]; dKr[ki][koff + d] += ds * Qr[t][qoff + d]; } }
    }
  }

  // RoPE backward (rotation inverse) → dQ, dKc ; GQA : dKr a déjà sommé les têtes Q du groupe
  const dQ = copyMat(dQr), dKc = copyMat(dKr);
  for (let t = 0; t < T; t++) { for (let qh = 0; qh < qH; qh++) ropeBwd(dQ[t], qh * headDim, t, headDim, rope); for (let kh = 0; kh < kvH; kh++) ropeBwd(dKc[t], kh * headDim, t, headDim, rope); }

  const Xt = transpose(X);
  const dWq = matmul(Xt, dQ), dWk = matmul(Xt, dKc), dWv = matmul(Xt, dVc);
  const dX = mat(T, H);
  for (const [dM, W] of [[dQ, wQ], [dKc, wK], [dVc, wV]]) { const P = matmul(dM, transpose(W)); for (let i = 0; i < T; i++) for (let j = 0; j < H; j++) dX[i][j] += P[i][j]; }
  return { dX, dWq, dWk, dWv, dWo };
}

export const _pb = { copyMat, dot, softmax, ropeFwd, ropeBwd };
