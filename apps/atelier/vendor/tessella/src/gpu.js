// GPU device setup. One device per engine. Fails closed: a software/fallback adapter is reported,
// so accuracy checks can mark their verdict indeterminate instead of green.

export class EngineError extends Error {
  constructor(code, message, remedy) {
    super(message);
    this.code = code;     // closed vocabulary: no_webgpu | no_adapter | decode_failed | device_lost
    this.remedy = remedy; // what the caller does next
  }
}

export async function createGpu() {
  if (typeof navigator === 'undefined' || !navigator.gpu) {
    throw new EngineError('no_webgpu', 'WebGPU is not available in this browser.',
      'Use Chrome or Edge 120+, Safari 26+, or Firefox 141+ on Windows.');
  }
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new EngineError('no_adapter', 'No GPU adapter.', 'Check that hardware acceleration is on.');
  const L = adapter.limits;
  const device = await adapter.requestDevice({
    requiredLimits: {
      maxTextureDimension2D: Math.min(16384, L.maxTextureDimension2D),
      maxTextureArrayLayers: Math.min(2048, L.maxTextureArrayLayers),
      maxBufferSize: L.maxBufferSize,
      maxStorageBufferBindingSize: L.maxStorageBufferBindingSize,
    },
  });
  const info = adapter.info || {};
  return {
    adapter, device,
    info: { vendor: info.vendor || '', architecture: info.architecture || '', description: info.description || '' },
    isFallback: !!(info.isFallbackAdapter || adapter.isFallbackAdapter),
  };
}

export function computePipeline(device, code, label) {
  const module = device.createShaderModule({ code, label });
  return device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' }, label });
}
