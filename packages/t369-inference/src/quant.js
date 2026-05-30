// packages/t369-inference/src/quant.js
// =====================================================
// Quant — 4-bit & 8-bit Quantization (GGUF-style)
// Ultra-optimisé + Compatible avec QuantizedTensor
// SkyAInet × Nikola T369
// =====================================================

export class QuantizedTensor {
  constructor(rows = 0, cols = 0, bits = 8) {
    const size = bits === 4 ? Math.ceil((rows * cols) / 2) : rows * cols;

    this.data = new Int8Array(size);
    this.scale = 1.0;
    this.zeroPoint = 0;
    this.bits = bits;
    this.originalShape = [rows, cols];
  }

  // === Quantization depuis Float32Array ===
  static quantizeFromF32(data, bits = 8) {
    if (!data || data.length === 0) {
      return new QuantizedTensor(0, 0, bits);
    }

    let minVal = Infinity;
    let maxVal = -Infinity;

    for (let i = 0; i < data.length; i++) {
      if (data[i] < minVal) minVal = data[i];
      if (data[i] > maxVal) maxVal = data[i];
    }

    const scale = maxVal !== minVal ? (maxVal - minVal) / ((1 << bits) - 1) : 1.0;
    const zeroPoint = Math.round(-minVal / scale) | 0;

    const qt = new QuantizedTensor(data.length, 1, bits);
    qt.scale = scale;
    qt.zeroPoint = zeroPoint;

    if (bits === 8) {
      for (let i = 0; i < data.length; i++) {
        const q = Math.round((data[i] / scale) + zeroPoint);
        qt.data[i] = Math.max(-128, Math.min(127, q));
      }
    } else if (bits === 4) {
      for (let i = 0; i < data.length; i += 2) {
        const q1 = Math.round((data[i] / scale) + zeroPoint);
        const q2 = i + 1 < data.length ? Math.round((data[i + 1] / scale) + zeroPoint) : 0;

        const packed = ((q1 & 0x0F) | ((q2 & 0x0F) << 4));
        qt.data[i >> 1] = packed;
      }
    }

    return qt;
  }

  // === Déquantization (nouvelle allocation) ===
  dequantize() {
    const [rows, cols] = this.originalShape;
    const len = rows * cols;
    const result = new Float32Array(len);

    if (this.bits === 8) {
      for (let i = 0; i < len; i++) {
        result[i] = (this.data[i] - this.zeroPoint) * this.scale;
      }
    } else if (this.bits === 4) {
      let outIdx = 0;
      for (let i = 0; i < this.data.length && outIdx < len; i++) {
        const packed = this.data[i];
        result[outIdx++] = ((packed & 0x0F) - this.zeroPoint) * this.scale;

        if (outIdx < len) {
          result[outIdx++] = (((packed >> 4) & 0x0F) - this.zeroPoint) * this.scale;
        }
      }
    }

    return result;
  }

  // === Déquantization in-place (ultra-rapide) ===
  dequantizeInplace(output) {
    const len = Math.min(output.length, this.originalShape[0] * this.originalShape[1]);

    if (this.bits === 8) {
      for (let i = 0; i < len; i++) {
        output[i] = (this.data[i] - this.zeroPoint) * this.scale;
      }
    } else if (this.bits === 4) {
      let outIdx = 0;
      for (let i = 0; i < this.data.length && outIdx < len; i++) {
        const packed = this.data[i];
        output[outIdx++] = ((packed & 0x0F) - this.zeroPoint) * this.scale;

        if (outIdx < len) {
          output[outIdx++] = (((packed >> 4) & 0x0F) - this.zeroPoint) * this.scale;
        }
      }
    }
  }
}