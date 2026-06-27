// packages/t369-inference/src/transformer_backward.js
//
// BACKWARD MULTICOUCHE — chaîne le gradient à travers une PILE de couches
// transformeur en miroir EXACT de la structure pré-norm T369 :
//
//   h1 = hidden + Attention( RMSNorm(hidden, w1) )      // bloc attention + résidu
//   h2 = h1     + SwiGLU_FFN( RMSNorm(h1, w2) )         // bloc expert + résidu
//
// répété sur L couches. Fournit forward + backward gradient-vérifiés pour :
//   • RMSNorm (formule exacte du modèle : x·inv·w, inv=1/√(mean(x²)+1e-6))
//   • SwiGLU FFN (= calcul d'UN expert MoE : down(silu(gate·x)·(up·x)))
//   • résidus (backward = somme des deux branches)
//   • attention multi-têtes (réutilise attention_backward, déjà vérifié)
//
// C'est le maillon « multicouche » : le gradient traverse correctement les
// résidus, les normes et N blocs attention+FFN empilés — la partie réellement
// difficile. Les poids différentiables (w1,w2,Wq/Wk/Wv/Wo,Wup/Wgate/Wdown) sont
// entraînables exactement.
//
// ─── CE QUI RESTE POUR BRANCHER LA PILE T369 DE PRODUCTION ───
//   1. MoE routé top-k : remplacer le FFN dense par la sélection top-k +
//      pondération par le gate. Sélection NON différentiable → straight-through
//      (gradient pondéré sur les experts choisis ; les poids up/gate/down de ces
//      experts reçoivent le gradient via ffnBackward ci-dessous).
//   2. RoPE + GQA dans l'attention : RoPE = rotation linéaire (backward = rotation
//      inverse sur dQ,dK) ; GQA = sommer dWk/dWv sur les têtes Q d'un même groupe.
//   3. applyUltra (S-box gematria) : NON différentiable → straight-through
//      (dHidden traverse inchangé), comme la quantification.
//   4. Poids quantifiés (experts) : dé-quantifier → pas f32 → re-quantifier
//      (boucle déjà maîtrisée par la sérialisation v3).
//   5. Embeddings : backward = scatter-add des gradients sur les lignes des tokens.

import { mhaForward, mhaBackward, _internal } from '#attention_backward';
const { mat, matmul, transpose } = _internal;

const sigmoid = (x) => 1 / (1 + Math.exp(-x));
function hadamard(A, B) { const r = A.length, c = A[0].length, O = mat(r, c); for (let i = 0; i < r; i++) for (let j = 0; j < c; j++) O[i][j] = A[i][j] * B[i][j]; return O; }
function addInto(A, B) { for (let i = 0; i < A.length; i++) for (let j = 0; j < A[0].length; j++) A[i][j] += B[i][j]; return A; }
function copyMat(A) { const O = mat(A.length, A[0].length); for (let i = 0; i < A.length; i++) O[i].set(A[i]); return O; }

// ── RMSNorm par token (formule exacte du modèle) ──────────────────
export function rmsNormForward(X, w, eps = 1e-6) {
  const T = X.length, H = X[0].length, Y = mat(T, H), inv = new Float64Array(T);
  for (let t = 0; t < T; t++) {
    let ss = 0; for (let j = 0; j < H; j++) ss += X[t][j] * X[t][j];
    const iv = 1 / Math.sqrt(ss / H + eps); inv[t] = iv;
    for (let j = 0; j < H; j++) Y[t][j] = X[t][j] * iv * w[j];
  }
  return { Y, cache: { X, w, inv, H, eps } };
}
export function rmsNormBackward(dY, cache) {
  const { X, w, inv, H } = cache, T = X.length;
  const dX = mat(T, H), dw = new Float64Array(H);
  for (let t = 0; t < T; t++) {
    const iv = inv[t];
    let dotxn = 0;
    const dn = new Float64Array(H);
    for (let j = 0; j < H; j++) { dn[j] = dY[t][j] * w[j]; dotxn += dn[j] * X[t][j]; dw[j] += dY[t][j] * X[t][j] * iv; }
    const k = iv * iv * dotxn / H;
    for (let j = 0; j < H; j++) dX[t][j] = iv * (dn[j] - X[t][j] * k);
  }
  return { dX, dw };
}

// ── SwiGLU FFN = calcul d'un expert : down( silu(gate·x) ⊙ (up·x) ) ──
export function ffnForward(X, Wup, Wgate, Wdown) {
  const U = matmul(X, Wup), Gp = matmul(X, Wgate);                 // [T×I]
  const T = U.length, I = U[0].length, S = mat(T, I);
  for (let t = 0; t < T; t++) for (let j = 0; j < I; j++) { const g = Gp[t][j]; S[t][j] = g * sigmoid(g); }
  const Inter = hadamard(S, U);
  const Y = matmul(Inter, Wdown);                                  // [T×H]
  return { Y, cache: { X, Wup, Wgate, Wdown, U, Gp, S, Inter } };
}
export function ffnBackward(dY, cache) {
  const { X, Wup, Wgate, Wdown, U, Gp, S } = cache;
  const dInter = matmul(dY, transpose(Wdown));                     // [T×I]
  const dWdown = matmul(transpose(cache.Inter), dY);              // [I×H]
  const T = U.length, I = U[0].length;
  const dU = hadamard(dInter, S);
  const dGp = mat(T, I);
  for (let t = 0; t < T; t++) for (let j = 0; j < I; j++) {
    const sg = sigmoid(Gp[t][j]);
    const dsilu = sg + Gp[t][j] * sg * (1 - sg);                   // silu'(g)
    dGp[t][j] = dInter[t][j] * U[t][j] * dsilu;
  }
  const Xt = transpose(X);
  const dWup = matmul(Xt, dU), dWgate = matmul(Xt, dGp);          // [H×I]
  const dX = addInto(matmul(dU, transpose(Wup)), matmul(dGp, transpose(Wgate)));
  return { dX, dWup, dWgate, dWdown };
}

// ── Une couche pré-norm : attention + résidu, puis FFN + résidu ──
export function layerForward(hidden, L, cfg) {
  const n1 = rmsNormForward(hidden, L.w1);
  const att = mhaForward(n1.Y, L.Wq, L.Wk, L.Wv, L.Wo, cfg);
  const h1 = addInto(copyMat(hidden), att.Y);
  const n2 = rmsNormForward(h1, L.w2);
  const ff = ffnForward(n2.Y, L.Wup, L.Wgate, L.Wdown);
  const h2 = addInto(copyMat(h1), ff.Y);
  return { Y: h2, cache: { n1: n1.cache, att: att.cache, n2: n2.cache, ff: ff.cache } };
}
export function layerBackward(dH2, cache) {
  // h2 = h1 + ffn(norm2(h1))
  const ffB = ffnBackward(dH2, cache.ff);
  const n2B = rmsNormBackward(ffB.dX, cache.n2);
  const dH1 = addInto(copyMat(dH2), n2B.dX);          // résidu + branche FFN
  // h1 = hidden + attn(norm1(hidden))
  const atB = mhaBackward(dH1, cache.att);
  const n1B = rmsNormBackward(atB.dX, cache.n1);
  const dHidden = addInto(copyMat(dH1), n1B.dX);       // résidu + branche attention
  return {
    dHidden,
    grads: { dw1: n1B.dw, dw2: n2B.dw, dWq: atB.dWq, dWk: atB.dWk, dWv: atB.dWv, dWo: atB.dWo,
             dWup: ffB.dWup, dWgate: ffB.dWgate, dWdown: ffB.dWdown },
  };
}

// ── Pile de L couches ─────────────────────────────────────────────
export function stackForward(X, layers, cfg) {
  let hidden = X; const caches = [];
  for (const L of layers) { const r = layerForward(hidden, L, cfg); hidden = r.Y; caches.push(r.cache); }
  return { Y: hidden, caches };
}
export function stackBackward(dY, caches) {
  let dHidden = dY; const grads = new Array(caches.length);
  for (let l = caches.length - 1; l >= 0; l--) { const r = layerBackward(dHidden, caches[l]); dHidden = r.dHidden; grads[l] = r.grads; }
  return { dX: dHidden, grads };
}

export const _tb = { sigmoid, hadamard, addInto, copyMat };
