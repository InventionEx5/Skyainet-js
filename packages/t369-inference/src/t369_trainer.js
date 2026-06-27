// packages/t369-inference/src/t369_trainer.js
//
// ASSEMBLAGE — moteur d'entraînement bout-en-bout qui COMPOSE toutes les briques
// backward déjà vérifiées en un entraînement réel des poids du T369, avec le
// CYCLE DES POIDS QUANTIFIÉS.
//
//   embedding (gather) → L couches [ RMSNorm → GQA/RoPE → résidu →
//                                    RMSNorm → MoE routé → résidu → applyUltra(STE) ]
//                      → RMSNorm finale → tête LM linéaire → entropie croisée
//
// Backward complet en sens inverse, jusqu'au scatter-add des embeddings. Poids
// f32 (normes, projections d'attention, routeur, tête) mis à jour par SGD ;
// poids quantifiés (experts, embeddings) via dé-quantifier → pas f32 →
// re-quantifier. applyUltra reste straight-through (non différentiable).
//
// Tout repose sur des modules gradient-checkés ; ce fichier les CÂBLE.

import { rmsNormForward, rmsNormBackward } from '#transformer_backward';
import {
  gqaRopeForward, gqaRopeBackward, moeForward, moeBackward,
  embeddingForward, embeddingBackward, ultraSteForward, ultraSteBackward, buildRope,
} from '#production_backward';
import { _internal } from '#attention_backward';
import { QuantizedTensor } from '#quant';
const { mat, matmul, transpose } = _internal;

const copyMat = (A) => { const O = mat(A.length, A[0].length); for (let i = 0; i < A.length; i++) O[i].set(A[i]); return O; };
const addInto = (A, B) => { for (let i = 0; i < A.length; i++) for (let j = 0; j < A[0].length; j++) A[i][j] += B[i][j]; return A; };

// ── Conversions plat (row-major) ↔ 2D, pour se lier aux tenseurs du modèle ──
export function to2D(flat, rows, cols) { const M = mat(rows, cols); for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) M[r][c] = flat[r * cols + c]; return M; }
export function toFlat(M) { const r = M.length, c = M[0].length, f = new Float32Array(r * c); for (let i = 0; i < r; i++) for (let j = 0; j < c; j++) f[i * c + j] = M[i][j]; return f; }

// ── Cycle quantifié : dé-quantifier (charge) / re-quantifier (commit) ──
export function dequantToMatrix(qt, rows, cols) { const buf = new Float32Array(rows * cols); qt.dequantizeInto(buf); return to2D(buf, rows, cols); }
export function quantizeMatrix(M, bits = 8) { return QuantizedTensor.fromF32(toFlat(M), bits); }

// ════════════════ Couche de production (composition vérifiée) ════════════════
export function prodLayerForward(hidden, LW, cfg, rope, transformFn = null) {
  const n1 = rmsNormForward(hidden, LW.w1);
  const att = gqaRopeForward(n1.Y, LW.wQ, LW.wK, LW.wV, LW.wO, cfg, rope);
  const h1 = addInto(copyMat(hidden), att.Y);

  const n2 = rmsNormForward(h1, LW.w2);
  const T = hidden.length, H = hidden[0].length;
  const moeOut = mat(T, H), moeCaches = [];
  for (let t = 0; t < T; t++) { const r = moeForward(n2.Y[t], LW.router, LW.experts, { topK: cfg.topK }); moeOut[t].set(r.output); moeCaches.push(r.cache); }
  const h2 = addInto(copyMat(h1), moeOut);

  // applyUltra : straight-through (forward = vrai transform si fourni)
  let Y = h2;
  if (transformFn) { Y = copyMat(h2); ultraSteForward(Y, transformFn); }
  return { Y, cache: { n1: n1.cache, att: att.cache, n2: n2.cache, moeCaches, T, H, N: LW.router.length } };
}

export function prodLayerBackward(dY, cache, LW) {
  const { n1, att, n2, moeCaches, T, H, N } = cache;
  const dH2 = ultraSteBackward(dY);                 // STE : identité

  // bloc MoE (par token) + résidu
  const dN2 = mat(T, H);
  const dRouter = Array.from({ length: N }, () => new Float64Array(H));
  const I = LW.experts[0].Wup[0].length;
  const dExperts = LW.experts.map(() => ({ dWup: mat(H, I), dWgate: mat(H, I), dWdown: mat(I, H) }));
  const dH1 = copyMat(dH2);
  for (let t = 0; t < T; t++) {
    const mb = moeBackward(dH2[t], moeCaches[t]);
    dN2[t].set(mb.dHidden);
    for (let e = 0; e < N; e++) addInto([dRouter[e]], [mb.dRouterRows[e]]);
    for (const id in mb.dExperts) { const s = dExperts[id], g = mb.dExperts[id]; addInto(s.dWup, g.dWup); addInto(s.dWgate, g.dWgate); addInto(s.dWdown, g.dWdown); }
  }
  const n2B = rmsNormBackward(dN2, n2);
  addInto(dH1, n2B.dX);

  // bloc attention + résidu
  const dHidden = copyMat(dH1);
  const atB = gqaRopeBackward(dH1, att);
  const n1B = rmsNormBackward(atB.dX, n1);
  addInto(dHidden, n1B.dX);

  return { dHidden, grads: { dw1: n1B.dw, dw2: n2B.dw, dWq: atB.dWq, dWk: atB.dWk, dWv: atB.dWv, dWo: atB.dWo, dRouter, dExperts } };
}

export function prodStackForward(hidden, layers, cfg, rope, transformFn = null) {
  let h = hidden; const caches = [];
  for (const LW of layers) { const r = prodLayerForward(h, LW, cfg, rope, transformFn); h = r.Y; caches.push(r.cache); }
  return { Y: h, caches };
}
export function prodStackBackward(dY, caches, layers) {
  let d = dY; const grads = new Array(caches.length);
  for (let l = caches.length - 1; l >= 0; l--) { const r = prodLayerBackward(d, caches[l], layers[l]); d = r.dHidden; grads[l] = r.grads; }
  return { dX: d, grads };
}

// ── Tête LM linéaire + entropie croisée (next-token) ──
export function headForward(hidden, Whead) { return matmul(hidden, Whead); }   // [T×V]
export function crossEntropy(logits, targets) {
  const T = logits.length, V = logits[0].length; let loss = 0; const dLogits = mat(T, V);
  for (let t = 0; t < T; t++) {
    let mx = -Infinity; for (let v = 0; v < V; v++) if (logits[t][v] > mx) mx = logits[t][v];
    let sum = 0; const p = new Float64Array(V);
    for (let v = 0; v < V; v++) { p[v] = Math.exp(logits[t][v] - mx); sum += p[v]; }
    for (let v = 0; v < V; v++) p[v] /= sum;
    loss += -Math.log(Math.max(p[targets[t]], 1e-12));
    for (let v = 0; v < V; v++) dLogits[t][v] = (p[v] - (v === targets[t] ? 1 : 0)) / T;
  }
  return { loss: loss / T, dLogits };
}

// ════════════════ Un pas d'entraînement complet ════════════════
// W : { embedding[V×H], layers[], finalNorm[H], head[H×V] }  (tout en f32/2D)
// Met à jour TOUS les poids en place (SGD). Renvoie la perte.
export function trainStep(W, tokens, targets, cfg, rope, lr, transformFn = null) {
  const V = W.embedding.length;
  // forward
  const emb = embeddingForward(W.embedding, tokens);
  const st = prodStackForward(emb, W.layers, cfg, rope, transformFn);
  const fn = rmsNormForward(st.Y, W.finalNorm);
  const logits = headForward(fn.Y, W.head);
  const { loss, dLogits } = crossEntropy(logits, targets);

  // backward
  const dHead = matmul(transpose(fn.Y), dLogits);
  const dFn = matmul(dLogits, transpose(W.head));
  const fnB = rmsNormBackward(dFn, fn.cache);
  const sb = prodStackBackward(fnB.dX, st.caches, W.layers);
  const dEmb = embeddingBackward(sb.dX, tokens, V);

  // updates (SGD) — f32 in-place
  const updV = (v, dv) => { for (let i = 0; i < v.length; i++) v[i] -= lr * dv[i]; };
  const updM = (M, dM) => { for (let i = 0; i < M.length; i++) for (let j = 0; j < M[0].length; j++) M[i][j] -= lr * dM[i][j]; };
  updM(W.head, dHead); updV(W.finalNorm, fnB.dw);
  for (let l = 0; l < W.layers.length; l++) {
    const L = W.layers[l], g = sb.grads[l];
    updV(L.w1, g.dw1); updV(L.w2, g.dw2);
    updM(L.wQ, g.dWq); updM(L.wK, g.dWk); updM(L.wV, g.dWv); updM(L.wO, g.dWo);
    for (let e = 0; e < L.router.length; e++) updV(L.router[e], g.dRouter[e]);
    for (let e = 0; e < L.experts.length; e++) { updM(L.experts[e].Wup, g.dExperts[e].dWup); updM(L.experts[e].Wgate, g.dExperts[e].dWgate); updM(L.experts[e].Wdown, g.dExperts[e].dWdown); }
  }
  updM(W.embedding, dEmb);
  return loss;
}

// ── Commit du cycle quantifié : re-quantifie experts + embeddings entraînés ──
// (les projections d'attention et normes restent f32 dans le modèle.)
export function commitQuantized(W, bits = 8) {
  const embQT = quantizeMatrix(W.embedding, bits);
  const layersQT = W.layers.map(L => L.experts.map(e => ({ up: quantizeMatrix(e.Wup, bits), gate: quantizeMatrix(e.Wgate, bits), down: quantizeMatrix(e.Wdown, bits) })));
  return { embQT, layersQT };
}
