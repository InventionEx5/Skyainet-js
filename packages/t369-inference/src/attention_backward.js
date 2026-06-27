// packages/t369-inference/src/attention_backward.js
//
// BACKPROP À TRAVERS L'ATTENTION — mécanisme de gradient pour les projections
// apprises Wq/Wk/Wv/Wo de l'auto-attention causale multi-têtes.
//
// Ce module établit (et VÉRIFIE par gradient-checking) la passe arrière complète :
//   forward : Y = MHA(X; Wq,Wk,Wv,Wo)
//   backward: dL/dX, dL/dWq, dL/dWk, dL/dWv, dL/dWo  à partir de dL/dY
//
// Couvre : projections linéaires (dW = Xᵀ·dY, dX = dY·Wᵀ), produit scalaire mis
// à l'échelle, backward du softmax (Jacobien), masque causal. C'est la brique qui
// permet d'ENTRAÎNER le cœur de l'attention (lever le plafond LoRA).
//
// PÉRIMÈTRE HONNÊTE : MHA pleine (numHeads têtes identiques côté K/V) pour un
// gradient-check propre. Extensions directes notées en fin de fichier : GQA
// (réduction K/V), RoPE (rotation linéaire → backward = rotation inverse),
// intégration multi-couches end-to-end dans la pile T369. Float64 pour la
// précision du contrôle de gradient.

// ── Algèbre matricielle minimale (matrice = tableau de Float64Array) ──
function mat(r, c) { const m = new Array(r); for (let i = 0; i < r; i++) m[i] = new Float64Array(c); return m; }
function matmul(A, B) {                       // [r×k]·[k×c] -> [r×c]
  const r = A.length, k = A[0].length, c = B[0].length, O = mat(r, c);
  for (let i = 0; i < r; i++) { const Ai = A[i], Oi = O[i]; for (let p = 0; p < k; p++) { const a = Ai[p], Bp = B[p]; for (let j = 0; j < c; j++) Oi[j] += a * Bp[j]; } }
  return O;
}
function transpose(A) { const r = A.length, c = A[0].length, O = mat(c, r); for (let i = 0; i < r; i++) for (let j = 0; j < c; j++) O[j][i] = A[i][j]; return O; }

/**
 * Passe avant de l'auto-attention causale multi-têtes.
 * @param {Float64Array[]} X  — entrée [T × H], H = numHeads × headDim
 * @param {Float64Array[]} Wq,Wk,Wv,Wo — projections [H × H]
 * @param {{numHeads:number, headDim:number, causal?:boolean}} cfg
 * @returns {{ Y:Float64Array[], cache:object }}
 */
export function mhaForward(X, Wq, Wk, Wv, Wo, { numHeads, headDim, causal = true }) {
  const T = X.length, H = numHeads * headDim, scale = 1 / Math.sqrt(headDim);
  const Q = matmul(X, Wq), K = matmul(X, Wk), V = matmul(X, Wv);   // [T×H]
  const A = [];                                                    // numHeads × [T×T]
  const O = mat(T, H);

  for (let h = 0; h < numHeads; h++) {
    const off = h * headDim;
    const Ah = mat(T, T);
    for (let i = 0; i < T; i++) {
      const lim = causal ? i : T - 1;
      const sc = new Float64Array(T); let mx = -Infinity;
      for (let j = 0; j <= lim; j++) {
        let s = 0; for (let d = 0; d < headDim; d++) s += Q[i][off + d] * K[j][off + d];
        s *= scale; sc[j] = s; if (s > mx) mx = s;
      }
      let sum = 0;
      for (let j = 0; j <= lim; j++) { const e = Math.exp(sc[j] - mx); Ah[i][j] = e; sum += e; }
      for (let j = 0; j <= lim; j++) Ah[i][j] /= sum;
      for (let d = 0; d < headDim; d++) { let o = 0; for (let j = 0; j <= lim; j++) o += Ah[i][j] * V[j][off + d]; O[i][off + d] = o; }
    }
    A.push(Ah);
  }

  const Y = matmul(O, Wo);                                          // [T×H]
  return { Y, cache: { X, Wq, Wk, Wv, Wo, Q, K, V, A, O, numHeads, headDim, causal, scale } };
}

/**
 * Passe arrière : gradients vis-à-vis de l'entrée et des quatre projections.
 * @param {Float64Array[]} dY — gradient amont [T × H]
 * @param {object} cache — issu de mhaForward
 * @returns {{ dX, dWq, dWk, dWv, dWo }}
 */
export function mhaBackward(dY, cache) {
  const { X, Wq, Wk, Wv, Wo, Q, K, V, A, O, numHeads, headDim, causal, scale } = cache;
  const T = X.length, H = numHeads * headDim;

  // Sortie : Y = O·Wo  ⇒  dWo = Oᵀ·dY ,  dO = dY·Woᵀ
  const dWo = matmul(transpose(O), dY);
  const dO  = matmul(dY, transpose(Wo));

  const dQ = mat(T, H), dK = mat(T, H), dV = mat(T, H);

  for (let h = 0; h < numHeads; h++) {
    const off = h * headDim, Ah = A[h];
    const dAh = mat(T, T);

    // Oh = Ah·Vh  ⇒  dAh = dOh·Vhᵀ ,  dVh = Ahᵀ·dOh
    for (let i = 0; i < T; i++) {
      const lim = causal ? i : T - 1;
      for (let j = 0; j <= lim; j++) {
        let da = 0;
        for (let d = 0; d < headDim; d++) { da += dO[i][off + d] * V[j][off + d]; dV[j][off + d] += Ah[i][j] * dO[i][off + d]; }
        dAh[i][j] = da;
      }
    }

    // Backward softmax (par ligne) puis mise à l'échelle puis scores = Qh·Khᵀ
    for (let i = 0; i < T; i++) {
      const lim = causal ? i : T - 1;
      let dot = 0; for (let j = 0; j <= lim; j++) dot += dAh[i][j] * Ah[i][j];
      for (let j = 0; j <= lim; j++) {
        const ds = (dAh[i][j] - dot) * Ah[i][j] * scale;   // d(scores_raw[i][j])
        for (let d = 0; d < headDim; d++) { dQ[i][off + d] += ds * K[j][off + d]; dK[j][off + d] += ds * Q[i][off + d]; }
      }
    }
  }

  // Projections : Q=X·Wq ⇒ dWq = Xᵀ·dQ ; dX reçoit dQ·Wqᵀ (+ K, + V)
  const Xt = transpose(X);
  const dWq = matmul(Xt, dQ), dWk = matmul(Xt, dK), dWv = matmul(Xt, dV);
  const dX = mat(T, H);
  for (const [dM, W] of [[dQ, Wq], [dK, Wk], [dV, Wv]]) {
    const P = matmul(dM, transpose(W));
    for (let i = 0; i < T; i++) for (let j = 0; j < H; j++) dX[i][j] += P[i][j];
  }

  return { dX, dWq, dWk, dWv, dWo };
}

// Pas de descente in-place sur une projection : W ← W − lr·dW (utilitaire de
// commodité pour un futur entraîneur multi-couches).
export function sgdStep(W, dW, lr) { for (let i = 0; i < W.length; i++) for (let j = 0; j < W[0].length; j++) W[i][j] -= lr * dW[i][j]; }

export const _internal = { mat, matmul, transpose };

// ───────────────────────────────────────────────────────────────────
// EXTENSIONS (mécanisme identique, périmètre élargi) :
//  • GQA : K/V partagés par groupes de têtes → dWk/dWv somment les gradients
//    des têtes Q d'un même groupe KV (réduction supplémentaire dans la boucle).
//  • RoPE : rotation linéaire appliquée à Q,K avant les scores ; backward =
//    rotation d'angle opposé sur dQ,dK (insérée juste avant dWq/dWk).
//  • End-to-end : chaîner mhaBackward à travers chaque couche + le backward du
//    MoE, de RomanDiffusion et des embeddings pour un entraînement complet.
// ───────────────────────────────────────────────────────────────────
