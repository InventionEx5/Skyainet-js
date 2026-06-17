// packages/node/src/lora_trainer.js
// =====================================================
// LoRA Trainer — Adaptateur Rang-Faible + Optimiseur Adam
// Cœur mathématique de l'ENTRAÎNEMENT LOURD T369
// Utilisé par : evolution_manager.js, lora_evolution.js
// SkyAInet × Nikola T369
// =====================================================

"use strict";

// ─────────────────────────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────────────────────────

const ADAM_BETA1    = 0.9;
const ADAM_BETA2    = 0.999;
const ADAM_EPSILON  = 1e-8;
const GRAD_CLIP_MAX = 1.0;    // norme maximale du gradient (gradient clipping)

// ─────────────────────────────────────────────────────────────────
// LORA ADAPTER
//
// Implémentation LoRA (Low-Rank Adaptation) pour le modèle T369.
//
// Architecture :
//   W_full = W_frozen + (B × A) × (alpha / rank)
//
//   A : Float32Array[rank × H]  — matrice de projection descendante
//   B : Float32Array[V × rank]  — matrice de projection montante
//
// Forward :
//   h      ∈ R^H                — vecteur caché du dernier token
//   lora_h = A × h             ∈ R^rank    (projection rang-faible)
//   delta  = B × lora_h × scale ∈ R^V     (correction sur les logits)
//
// Backward (Adam) :
//   dLogits ∈ R^V              — gradient cross-entropie sur les logits
//   dB = dLogits ⊗ lora_h^T   (gradient de B)
//   dA = B^T × dLogits ⊗ h^T  (gradient de A)
//   Mise à jour Adam sur A et B avec weight decay
//
// Initialisation :
//   A ~ N(0, σ²) avec σ = 1/√H  (He initialization)
//   B = 0                         (delta nul au démarrage)
// ─────────────────────────────────────────────────────────────────

export class LoraAdapter {
  // Matrices LoRA
  #A;         // Float32Array[rank × H]
  #B;         // Float32Array[V × rank]
  #scale;     // alpha / rank

  // Moments Adam pour A
  #mA;        // Float32Array[rank × H]
  #vA;        // Float32Array[rank × H]

  // Moments Adam pour B
  #mB;        // Float32Array[V × rank]
  #vB;        // Float32Array[V × rank]

  // Hyperparamètres
  #rank;
  #lr;
  #weightDecay;
  #step;      // compteur de steps (pour Adam bias correction)

  /**
   * @param {number} H           — dimension cachée du modèle
   * @param {number} V           — taille du vocabulaire
   * @param {object} [opts]
   * @param {number} opts.rank        — rang LoRA (défaut 8)
   * @param {number} opts.alpha       — scaling (défaut 16)
   * @param {number} opts.lr          — learning rate Adam (défaut 2e-4)
   * @param {number} opts.weightDecay — L2 regularization (défaut 1e-5)
   */
  constructor(H, V, opts = {}) {
    if (!Number.isInteger(H) || H <= 0) throw new RangeError(`H invalide : ${H}`);
    if (!Number.isInteger(V) || V <= 0) throw new RangeError(`V invalide : ${V}`);

    this.H    = H;
    this.V    = V;

    this.#rank        = opts.rank        ?? 8;
    this.#lr          = opts.lr          ?? 2e-4;
    this.#weightDecay = opts.weightDecay ?? 1e-5;
    this.#scale       = (opts.alpha ?? 16) / this.#rank;
    this.#step        = 0;

    const r = this.#rank;

    // Initialisation He pour A : σ = 1/√H
    this.#A = _randnF32(r * H, 1 / Math.sqrt(H));
    this.#B = new Float32Array(V * r);   // zéro → delta nul au départ

    // Moments Adam (initialisés à zéro)
    this.#mA = new Float32Array(r * H);
    this.#vA = new Float32Array(r * H);
    this.#mB = new Float32Array(V * r);
    this.#vB = new Float32Array(V * r);
  }

  // ─── Forward pass ─────────────────────────────────────────────

  /**
   * Calcule la correction LoRA sur les logits.
   *
   * delta = B × (A × h) × scale   ∈ R^V
   *
   * @param {Float32Array} h — vecteur caché [H]
   * @returns {Float32Array} delta [V]
   */
  forward(h) {
    const r     = this.#rank;
    const H     = this.H;
    const V     = this.V;
    const scale = this.#scale;

    // lora_h = A × h  [rank]
    const loraH = new Float32Array(r);
    for (let i = 0; i < r; i++) {
      let sum = 0;
      const row = i * H;
      for (let j = 0; j < H; j++) sum += this.#A[row + j] * h[j];
      loraH[i] = sum;
    }

    // delta = B × loraH × scale  [V]
    const delta = new Float32Array(V);
    for (let i = 0; i < V; i++) {
      let sum = 0;
      const row = i * r;
      for (let k = 0; k < r; k++) sum += this.#B[row + k] * loraH[k];
      delta[i] = sum * scale;
    }

    // Stocker loraH pour le backward
    this._lastLoraH = loraH;
    this._lastH     = h;

    return delta;
  }

  // ─── Backward + Adam ──────────────────────────────────────────

  /**
   * Rétropropagation + mise à jour Adam sur A et B.
   *
   * @param {Float32Array} h       — vecteur caché [H] (identique au forward)
   * @param {Float32Array} dLogits — gradient sur les logits [V]
   */
  step(h, dLogits) {
    const r     = this.#rank;
    const H     = this.H;
    const V     = this.V;
    const scale = this.#scale;

    this.#step++;
    const lr  = this.#lr;
    const wd  = this.#weightDecay;
    const b1  = ADAM_BETA1;
    const b2  = ADAM_BETA2;
    const eps = ADAM_EPSILON;

    // Bias correction Adam
    const bc1 = 1 - Math.pow(b1, this.#step);
    const bc2 = 1 - Math.pow(b2, this.#step);
    const lrCorr = lr * Math.sqrt(bc2) / bc1;

    const loraH = this._lastLoraH ?? new Float32Array(r);

    // ── Gradient de B : dB[i,k] = dLogits[i] × loraH[k] × scale
    // Gradient clipping L2 sur dLogits
    const dLogitsClipped = _clipGrad(dLogits, GRAD_CLIP_MAX);

    for (let i = 0; i < V; i++) {
      const dLi   = dLogitsClipped[i] * scale;
      const rowB  = i * r;
      for (let k = 0; k < r; k++) {
        const g = dLi * loraH[k] + wd * this.#B[rowB + k];
        const idx = rowB + k;
        this.#mB[idx] = b1 * this.#mB[idx] + (1 - b1) * g;
        this.#vB[idx] = b2 * this.#vB[idx] + (1 - b2) * g * g;
        this.#B[idx] -= lrCorr * this.#mB[idx] / (Math.sqrt(this.#vB[idx]) + eps);
      }
    }

    // ── Gradient de A : dA[k,j] = (Σ_i dLogits[i] × B[i,k]) × h[j] × scale
    const dLoraH = new Float32Array(r);
    for (let k = 0; k < r; k++) {
      let sum = 0;
      for (let i = 0; i < V; i++) sum += dLogitsClipped[i] * this.#B[i * r + k];
      dLoraH[k] = sum * scale;
    }

    for (let k = 0; k < r; k++) {
      const rowA = k * H;
      for (let j = 0; j < H; j++) {
        const g = dLoraH[k] * h[j] + wd * this.#A[rowA + j];
        const idx = rowA + j;
        this.#mA[idx] = b1 * this.#mA[idx] + (1 - b1) * g;
        this.#vA[idx] = b2 * this.#vA[idx] + (1 - b2) * g * g;
        this.#A[idx] -= lrCorr * this.#mA[idx] / (Math.sqrt(this.#vA[idx]) + eps);
      }
    }
  }

  // ─── Test-Time Training (Fusion L2) ──────────────────────────

  /**
   * Un pas d'apprentissage complet sur un exemple : forward + grad + Adam.
   * Le cœur des "poids vivants" — l'adapter apprend au moment de l'inférence.
   * @param {Float32Array} h          — caché du dernier token [H]
   * @param {Float32Array} baseLogits — logits du modèle gelé [V]
   * @param {number}       target     — token cible
   * @returns {number} loss
   */
  trainStep(h, baseLogits, target) {
    const delta    = this.forward(h);
    const V        = this.V;
    const combined = new Float32Array(V);
    for (let i = 0; i < V; i++) combined[i] = baseLogits[i] + delta[i];
    const { loss, dLogits } = crossEntropyGrad(combined, target);
    this.step(h, dLogits);
    return loss;
  }

  // ─── Consolidation / fusion d'adapters (Fusion L2 / fédéré L6) ──

  /** Moyenne pondérée des poids d'un autre adapter compatible (in-place). */
  merge(other, weight = 0.5) {
    if (other.H !== this.H || other.V !== this.V || other.rank !== this.#rank)
      throw new Error('[LoraAdapter] merge: dimensions incompatibles');
    const oa = other._exportA(), ob = other._exportB(), w = weight, iw = 1 - weight;
    for (let i = 0; i < this.#A.length; i++) this.#A[i] = this.#A[i] * iw + oa[i] * w;
    for (let i = 0; i < this.#B.length; i++) this.#B[i] = this.#B[i] * iw + ob[i] * w;
    return this;
  }
  _exportA() { return this.#A; }
  _exportB() { return this.#B; }

  /** Réinitialise poids + moments Adam (A~He, B=0). */
  reset() {
    this.#A = _randnF32(this.#rank * this.H, 1 / Math.sqrt(this.H));
    this.#B.fill(0);
    this.#mA.fill(0); this.#vA.fill(0); this.#mB.fill(0); this.#vB.fill(0);
    this.#step = 0;
    return this;
  }

  /** Copie indépendante de l'adapter (poids dupliqués, moments à zéro). */
  clone() {
    const c = new LoraAdapter(this.H, this.V, {
      rank: this.#rank, alpha: this.#scale * this.#rank, lr: this.#lr, weightDecay: this.#weightDecay,
    });
    c._restoreWeights(this.#A, this.#B);
    return c;
  }

  // ─── Sérialisation ────────────────────────────────────────────

  /**
   * Sérialise A et B en Uint8Array pour checkpoint.
   * Format : [4B rank][4B H][4B V][A bytes][B bytes]
   */
  serialize() {
    const r      = this.#rank;
    const header = 12;                           // 3 × uint32
    const aBytes = this.#A.byteLength;
    const bBytes = this.#B.byteLength;
    const buf    = new ArrayBuffer(header + aBytes + bBytes);
    const view   = new DataView(buf);

    view.setUint32(0, r,      true);
    view.setUint32(4, this.H, true);
    view.setUint32(8, this.V, true);

    new Uint8Array(buf, header,          aBytes).set(new Uint8Array(this.#A.buffer));
    new Uint8Array(buf, header + aBytes, bBytes).set(new Uint8Array(this.#B.buffer));

    return new Uint8Array(buf);
  }

  /**
   * Restaure un LoraAdapter depuis un Uint8Array sérialisé.
   * @param {Uint8Array} data
   * @param {object}     opts — hyperparamètres (lr, weightDecay, alpha)
   * @returns {LoraAdapter}
   */
  static deserialize(data, opts = {}) {
    const view  = new DataView(data.buffer, data.byteOffset);
    const rank  = view.getUint32(0, true);
    const H     = view.getUint32(4, true);
    const V     = view.getUint32(8, true);

    const adapter = new LoraAdapter(H, V, { ...opts, rank });
    const aBytes  = rank * H * 4;
    const bBytes  = V * rank * 4;

    adapter._restoreWeights(
      new Float32Array(data.buffer, data.byteOffset + 12,          rank * H),
      new Float32Array(data.buffer, data.byteOffset + 12 + aBytes, V * rank)
    );

    return adapter;
  }

  /** @internal — restauration des poids après désérialisation */
  _restoreWeights(A, B) {
    this.#A.set(A);
    this.#B.set(B);
  }

  // ─── Métriques ────────────────────────────────────────────────

  /** Nombre total de paramètres entraînables (A + B). */
  numParams() { return this.#rank * this.H + this.V * this.#rank; }

  /** Norme L2 des poids A et B — indicateur de santé de l'adapter. */
  weightNorm() {
    return {
      A: +_l2norm(this.#A).toFixed(6),
      B: +_l2norm(this.#B).toFixed(6),
    };
  }

  get stepCount() { return this.#step; }
  get rank()      { return this.#rank; }
  get scale()     { return this.#scale; }
}

// ─────────────────────────────────────────────────────────────────
// CROSS-ENTROPY GRAD
//
// Calcule simultanément la loss cross-entropie et le gradient
// sur les logits (softmax + log + gradient en une seule passe).
//
// Formule :
//   p = softmax(logits)
//   loss = -log(p[target])
//   dLogits[i] = p[i] - 1{i == target}
//
// Optimisation numérique :
//   Soustraction du max avant softmax (log-sum-exp stable)
//
// @param {Float32Array} logits  [V]
// @param {number}       target  — indice du token cible
// @returns {{ loss: number, dLogits: Float32Array }}
// ─────────────────────────────────────────────────────────────────

export function crossEntropyGrad(logits, target) {
  const V = logits.length;

  // 1. Max pour stabilité numérique
  let maxVal = -Infinity;
  for (let i = 0; i < V; i++) if (logits[i] > maxVal) maxVal = logits[i];

  // 2. Softmax
  const probs = new Float32Array(V);
  let   sumExp = 0;
  for (let i = 0; i < V; i++) {
    probs[i] = Math.exp(logits[i] - maxVal);
    sumExp  += probs[i];
  }
  for (let i = 0; i < V; i++) probs[i] /= sumExp;

  // 3. Loss cross-entropie
  const loss = -Math.log(Math.max(probs[target], 1e-12));

  // 4. Gradient : dLogits = probs - one_hot(target)
  const dLogits = new Float32Array(probs);
  dLogits[target] -= 1;

  return { loss, dLogits };
}

// ─────────────────────────────────────────────────────────────────
// HELPERS INTERNES
// ─────────────────────────────────────────────────────────────────

/** Génère un Float32Array de taille n avec valeurs N(0, σ). */
function _randnF32(n, sigma = 1) {
  const arr = new Float32Array(n);
  for (let i = 0; i < n; i += 2) {
    // Box-Muller transform
    const u1 = Math.random() || 1e-12;
    const u2 = Math.random();
    const mag = sigma * Math.sqrt(-2 * Math.log(u1));
    arr[i]     = mag * Math.cos(2 * Math.PI * u2);
    if (i + 1 < n) arr[i + 1] = mag * Math.sin(2 * Math.PI * u2);
  }
  return arr;
}

/** Norme L2 d'un Float32Array. */
function _l2norm(arr) {
  let sum = 0;
  for (const v of arr) sum += v * v;
  return Math.sqrt(sum);
}

/**
 * Gradient clipping par norme L2 globale.
 * Si ||g|| > maxNorm : g ← g × (maxNorm / ||g||)
 */
function _clipGrad(grad, maxNorm) {
  const norm = _l2norm(grad);
  if (norm <= maxNorm) return grad;
  const scale = maxNorm / norm;
  const clipped = new Float32Array(grad.length);
  for (let i = 0; i < grad.length; i++) clipped[i] = grad[i] * scale;
  return clipped;
}
