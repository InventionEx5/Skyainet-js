// packages/t369-inference/src/index.js
// =====================================================
// T369Inference — Point d'entrée (16 fichiers)
// SkyAInet × Nikola T369
// =====================================================

export { T369Inference, ParallelMode }                        from './inference.js';
export { T369Model, ModelConfig }                             from './model.js';
export { TransformerBlock }                                   from './transformer_block.js';
export { BpeTokenizer }                                       from './tokenizer.js';
export { KVCache }                                            from './kv_cache.js';
export { RomanAttention, RomanAttentionConfig }               from './roman_attention.js';
export { MoELayer, MoEConfig, ExpertFFN }                     from './moe.js';
export { RomanDiffusion }                                     from './roman_diffusion.js';
export { QuantizedTensor, bufferPool }                        from './quant.js';
export { SpeculativeDecoder, SpeculativeConfig }              from './speculative.js';
export { ParallelExecutor, ParallelConfig, ParallelStrategy } from './parallel.js';
export { InSelf, ImprovedResponse }                           from './inself.js';
export { InAware, AwareResponse }                             from './inaware.js';
export { InDream }                                            from './indream.js';
export { CollectivIn, Personality }                           from './collectivin.js';
export { MeshIn, Neuron }                                     from './meshin.js';

export const VERSION = '11.0.0';
