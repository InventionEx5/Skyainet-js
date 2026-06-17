// packages/t369-inference/src/gpu_kernels.js
// =====================================================
// Kernels tri-backend (Fusion L1)
//
// Couche de primitives de calcul partagée par l'Inference Core :
//   • GpuKernels — WebGPU, shaders WGSL compilés au runtime par le navigateur
//     (zéro binaire, zéro build). matmul + dequant 4-bit sur GPU.
//   • CpuKernels — référence pure-JS (Node + navigateur). Sert de fallback au
//     backend WASM tant que les kernels AssemblyScript->WASM ne sont pas compilés,
//     et d'oracle de validation pour les kernels GPU.
//
// Contrat commun : matmul(A, B, M, K, N) -> Float32Array(M*N) (row-major).
// SkyAInet × Nikola T369
// =====================================================

"use strict";

// ─────────────────────────────────────────────────────────────────
// WGSL — sources de shaders (chaînes compilées par WebGPU au runtime)
// ─────────────────────────────────────────────────────────────────

export const WGSL_MATMUL = /* wgsl */`
struct Dims { m: u32, k: u32, n: u32, _pad: u32 };
@group(0) @binding(0) var<storage, read>        a: array<f32>;
@group(0) @binding(1) var<storage, read>        b: array<f32>;
@group(0) @binding(2) var<storage, read_write>  c: array<f32>;
@group(0) @binding(3) var<uniform>              dims: Dims;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let row = gid.x;
  let col = gid.y;
  if (row >= dims.m || col >= dims.n) { return; }
  var sum: f32 = 0.0;
  for (var k: u32 = 0u; k < dims.k; k = k + 1u) {
    sum = sum + a[row * dims.k + k] * b[k * dims.n + col];
  }
  c[row * dims.n + col] = sum;
}
`;

// Dequant bloc 4-bit -> f32 (2 nibbles par octet ; scale/zeroPoint par bloc).
export const WGSL_DEQUANT4 = /* wgsl */`
struct QInfo { numel: u32, blockSize: u32, _p0: u32, _p1: u32 };
@group(0) @binding(0) var<storage, read>       packed: array<u32>;  // nibbles empaquetés
@group(0) @binding(1) var<storage, read>       scales: array<f32>;
@group(0) @binding(2) var<storage, read>       zeros:  array<f32>;
@group(0) @binding(3) var<storage, read_write> out:    array<f32>;
@group(0) @binding(4) var<uniform>             info:   QInfo;

@compute @workgroup_size(64, 1, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= info.numel) { return; }
  let byteIndex = i / 2u;
  let word = packed[byteIndex / 4u];
  let byteInWord = byteIndex % 4u;
  let theByte = (word >> (byteInWord * 8u)) & 0xFFu;
  var nib: u32;
  if ((i & 1u) == 0u) { nib = theByte & 0x0Fu; } else { nib = (theByte >> 4u) & 0x0Fu; }
  let blk = i / info.blockSize;
  out[i] = (f32(nib) - zeros[blk]) * scales[blk];
}
`;

// ─────────────────────────────────────────────────────────────────
// GPU KERNELS (WebGPU) — pilotés 100% depuis JS, sans binaire
// Disponible navigateur (navigator.gpu). En Node sans WebGPU : available()=false.
// ─────────────────────────────────────────────────────────────────

export class GpuKernels {
  constructor() {
    this.device   = null;
    this.ready    = false;
    this._pipes   = new Map();   // nom -> GPUComputePipeline (cache)
  }

  static available() {
    return typeof navigator !== 'undefined' && !!navigator.gpu;
  }

  async init() {
    if (this.ready) return this;
    if (!GpuKernels.available()) throw new Error('[GpuKernels] WebGPU indisponible');
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('[GpuKernels] Aucun adaptateur GPU');
    this.device = await adapter.requestDevice();
    this.ready  = true;
    return this;
  }

  _pipeline(name, code) {
    let p = this._pipes.get(name);
    if (p) return p;
    const module = this.device.createShaderModule({ code });
    p = this.device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
    this._pipes.set(name, p);
    return p;
  }

  _storage(data, usageExtra = 0) {
    const buf = this.device.createBuffer({
      size: Math.max(4, data.byteLength),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC | usageExtra,
      mappedAtCreation: true,
    });
    new Float32Array(buf.getMappedRange()).set(data);
    buf.unmap();
    return buf;
  }

  _uniform(u32arr) {
    const buf = this.device.createBuffer({
      size: Math.max(16, u32arr.byteLength),
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    });
    new Uint32Array(buf.getMappedRange()).set(u32arr);
    buf.unmap();
    return buf;
  }

  // C = A·B  (A: M×K, B: K×N) -> Float32Array(M*N)
  async matmul(A, B, M, K, N) {
    if (!this.ready) await this.init();
    const dev = this.device;
    const pipe = this._pipeline('matmul', WGSL_MATMUL);

    const aBuf = this._storage(A);
    const bBuf = this._storage(B);
    const cBuf = dev.createBuffer({ size: Math.max(4, M * N * 4),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const dBuf = this._uniform(new Uint32Array([M, K, N, 0]));

    const bind = dev.createBindGroup({
      layout: pipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: aBuf } },
        { binding: 1, resource: { buffer: bBuf } },
        { binding: 2, resource: { buffer: cBuf } },
        { binding: 3, resource: { buffer: dBuf } },
      ],
    });

    const enc = dev.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pipe);
    pass.setBindGroup(0, bind);
    pass.dispatchWorkgroups(Math.ceil(M / 8), Math.ceil(N / 8), 1);
    pass.end();

    const readBuf = dev.createBuffer({ size: Math.max(4, M * N * 4),
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    enc.copyBufferToBuffer(cBuf, 0, readBuf, 0, M * N * 4);
    dev.queue.submit([enc.finish()]);

    await readBuf.mapAsync(GPUMapMode.READ);
    const out = new Float32Array(readBuf.getMappedRange().slice(0));
    readBuf.unmap();
    aBuf.destroy(); bBuf.destroy(); cBuf.destroy(); dBuf.destroy(); readBuf.destroy();
    return out;
  }

  dispose() {
    this._pipes.clear();
    this.device = null; this.ready = false;
  }

  capabilities() { return { backend: 'webgpu', gpu: true, sovereign: true, browser: true, ready: this.ready }; }
}

// ─────────────────────────────────────────────────────────────────
// CPU KERNELS — référence pure-JS (Node + navigateur)
// Fallback du backend WASM + oracle de validation des kernels GPU.
// ─────────────────────────────────────────────────────────────────

export class CpuKernels {
  constructor() { this.ready = true; }
  async init() { this.ready = true; return this; }

  // C = A·B  (A: M×K, B: K×N) -> Float32Array(M*N)
  matmul(A, B, M, K, N) {
    const C = new Float32Array(M * N);
    for (let i = 0; i < M; i++) {
      const aRow = i * K;
      for (let k = 0; k < K; k++) {
        const aik = A[aRow + k];
        if (aik === 0) continue;
        const bRow = k * N;
        for (let j = 0; j < N; j++) C[i * N + j] += aik * B[bRow + j];
      }
    }
    return C;
  }

  // Dequant bloc 4-bit -> f32 (mêmes conventions que quant.js)
  dequantize4bit(packed, scales, zeros, numel, blockSize = 32) {
    const out = new Float32Array(numel);
    for (let i = 0; i < numel; i++) {
      const byte = packed[i >> 1];
      const nib  = (i & 1) ? ((byte >> 4) & 0x0F) : (byte & 0x0F);
      const blk  = (i / blockSize) | 0;
      out[i] = (nib - zeros[blk]) * scales[blk];
    }
    return out;
  }

  // SiLU(x) = x * sigmoid(x), in-place
  silu(x) {
    for (let i = 0; i < x.length; i++) x[i] = x[i] / (1 + Math.exp(-x[i]));
    return x;
  }

  dispose() {}
  capabilities() { return { backend: 'cpu-js', gpu: false, sovereign: true, portable: true, ready: true }; }
}

// Sélection : GPU si disponible, sinon CPU. (Le backend WASM réel, une fois
// l'AssemblyScript compilé, s'enregistrera ici à la place de CpuKernels.)
export async function selectKernels(prefer = 'auto') {
  if (prefer !== 'cpu' && GpuKernels.available()) {
    try { const g = new GpuKernels(); await g.init(); return g; } catch (_) { /* fallback */ }
  }
  return new CpuKernels();
}
