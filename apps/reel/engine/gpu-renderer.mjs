/* Reel GPU renderer: WebGPU drawing of decoded VideoFrames (spec rows V4, V5, V6, V7).
 *
 * Part of the vendorable engine: no imports, no DOM beyond the canvas it is given.
 *
 *   const renderer = await createGpuRenderer(canvas)  // null when WebGPU is missing or fails
 *   renderer.draw(videoFrame, view)                     // true when drawn, false when the device is lost
 *   renderer.size(width, height)                        // backing size chosen by the engine
 *   await renderer.snapshot()                           // PNG Blob of the last drawn frame (SDR)
 *   renderer.state()                                    // what the renderer is doing, for state().view
 *   renderer.clear()                                    // forget the last frame and paint black
 *   renderer.destroy()
 *
 * view: { rotation, crop, aspect, zoom: { scale, x, y }, adjust: { brightness, contrast, saturation,
 * gamma }, deinterlace: 'off' | 'blend' | 'bob', tonemap: 'auto' | 'off' }.
 *   rotation     clockwise degrees (0, 90, 180, 270), applied to the frame
 *   crop         'none' or { top, right, bottom, left } fractions of the displayed (rotated) picture
 *   aspect       not used here: the engine picks the backing size from it and calls size()
 *   zoom         scale >= 1; x, y = the centre of the view in the cropped picture, 0 to 1
 *   adjust       brightness -1..1 (0), contrast 0..2 (1), saturation 0..2 (1), gamma 0.2..5 (1)
 *   deinterlace  blend: vertical [1 2 1] filter over the two fields; bob: keep one field, rebuild the other
 *   tonemap      auto: HDR (PQ, HLG) maps to SDR, or passes through when the canvas and display are HDR;
 *                off: HDR values are clipped at SDR white
 *
 * Input paths:
 *   external  importExternalTexture (SDR frames, and HDR frames whose pixels cannot be copied)
 *   planar    HDR frames in a 10- or 12-bit planar format are copied (VideoFrame.copyTo) into r16uint
 *             plane textures, because Chrome's external texture conversion hard-clips PQ highlights
 *             (observed 2026-11-16: a PQ ramp clips at 0.786 with no tone curve). The shader then does
 *             YUV to RGB, the PQ or HLG EOTF, BT.2020 to BT.709 and the tone map itself.
 * The renderer never closes the engine's VideoFrame. It keeps its own clone of the last frame for
 * snapshot(), and closes that clone on the next draw, clear() or destroy().
 */

const SDR_WHITE_NITS = 203; // BT.2408 reference white: 1.0 in the shader's linear light
// Tone-map peaks. HDR10 metadata (MaxCLL, mastering peak) is not exposed by WebCodecs, so PQ assumes
// 4000 nits, a common mastering peak; HLG is display-referred to a 1000-nit display here.
const PQ_PEAK_NITS = 4000;
const HLG_PEAK_NITS = 1000;
const HDR_FORMATS = {
  I420P10: { bits: 10, cx: 2, cy: 2 }, I420P12: { bits: 12, cx: 2, cy: 2 },
  I422P10: { bits: 10, cx: 2, cy: 1 }, I422P12: { bits: 12, cx: 2, cy: 1 },
  I444P10: { bits: 10, cx: 1, cy: 1 }, I444P12: { bits: 12, cx: 1, cy: 1 },
};
const MATRIX_K = { // Kr, Kb
  'bt2020-ncl': [0.2627, 0.0593], bt709: [0.2126, 0.0722], bt470bg: [0.299, 0.114], smpte170m: [0.299, 0.114],
};

/* WGSL shared by both input paths. SOURCE_FUNCTIONS is replaced per path. */
const SHADER = /* wgsl */`
struct Uniforms {
  crop: vec4f,    // left, top, width, height of the cropped picture, in displayed space
  zoom: vec4f,    // scale, centre x, centre y, quarter turns clockwise
  adjust: vec4f,  // brightness, contrast, saturation, gamma
  src: vec4f,     // source width, source height, deinterlace (0 off, 1 blend, 2 bob), bob field (0 top, 1 bottom)
  color: vec4f,   // transfer (0 SDR, 1 PQ, 2 HLG), output (0 SDR tone map, 1 clip, 2 extended), Kr, Kb
  range: vec4f,   // luma offset, luma scale, chroma offset, chroma scale (in 0..1 code units)
  misc: vec4f,    // max code value, BT.2020 primaries (1 or 0), tone-map peak (1.0 = SDR white), unused
};
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var samp: sampler;

struct VsOut { @builtin(position) position: vec4f, @location(0) uv: vec2f };

@vertex fn vs(@builtin(vertex_index) i: u32) -> VsOut {
  var corners = array(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var out: VsOut;
  out.position = vec4f(corners[i], 0.0, 1.0);
  out.uv = vec2f((corners[i].x + 1.0) * 0.5, (1.0 - corners[i].y) * 0.5);
  return out;
}

// Output position (0..1) to frame position (0..1): zoom, then crop, then undo the rotation.
fn frameUv(uv: vec2f) -> vec2f {
  let scale = max(u.zoom.x, 1.0);
  let span = 0.5 / scale;
  let centre = clamp(u.zoom.yz, vec2f(span), vec2f(1.0 - span));
  let picture = centre + (uv - vec2f(0.5)) / scale;
  let d = u.crop.xy + picture * u.crop.zw;
  let turns = i32(u.zoom.w + 0.5);
  if (turns == 1) { return vec2f(d.y, 1.0 - d.x); }
  if (turns == 2) { return vec2f(1.0 - d.x, 1.0 - d.y); }
  if (turns == 3) { return vec2f(1.0 - d.y, d.x); }
  return d;
}

SOURCE_FUNCTIONS

fn rowSample(uv: vec2f, row: f32) -> vec3f {
  let h = u.src.y;
  let r = clamp(row, 0.0, h - 1.0);
  return source(vec2f(uv.x, (r + 0.5) / h));
}

fn deinterlaced(uv: vec2f) -> vec3f {
  let mode = i32(u.src.z + 0.5);
  if (mode == 0) { return source(uv); }
  let row = floor(uv.y * u.src.y);
  if (mode == 1) {
    return 0.5 * rowSample(uv, row) + 0.25 * rowSample(uv, row - 1.0) + 0.25 * rowSample(uv, row + 1.0);
  }
  let parity = row - 2.0 * floor(row / 2.0);
  if (abs(parity - u.src.w) < 0.5) { return rowSample(uv, row); }
  return 0.5 * (rowSample(uv, row - 1.0) + rowSample(uv, row + 1.0));
}

fn srgbEncode(c: vec3f) -> vec3f {
  let a = abs(c);
  let lo = a * 12.92;
  let hi = 1.055 * pow(a, vec3f(1.0 / 2.4)) - 0.055;
  return sign(c) * select(hi, lo, a <= vec3f(0.0031308));
}

fn pqEotf(e: vec3f) -> vec3f { // nits / SDR white
  let m1 = 0.1593017578125; let m2 = 78.84375;
  let c1 = 0.8359375; let c2 = 18.8515625; let c3 = 18.6875;
  let p = pow(clamp(e, vec3f(0.0), vec3f(1.0)), vec3f(1.0 / m2));
  let l = pow(max(p - c1, vec3f(0.0)) / (c2 - c3 * p), vec3f(1.0 / m1));
  return l * (10000.0 / ${SDR_WHITE_NITS}.0);
}

fn hlgEotf(e: vec3f) -> vec3f { // nits / SDR white, 1000-nit display, system gamma 1.2
  let a = 0.17883277; let b = 0.28466892; let c = 0.55991073;
  let ec = clamp(e, vec3f(0.0), vec3f(1.0));
  let scene = select((exp((ec - c) / a) + b) / 12.0, ec * ec / 3.0, ec <= vec3f(0.5));
  let ys = dot(scene, vec3f(0.2627, 0.6780, 0.0593));
  return 1000.0 * pow(max(ys, 1e-6), 0.2) * scene / ${SDR_WHITE_NITS}.0;
}

// Linear light (1.0 = SDR white) to the output: tone-mapped SDR, clipped SDR, or extended range.
fn hdrToOutput(linearIn: vec3f) -> vec3f {
  var lin = linearIn;
  if (u.misc.y > 0.5) { // BT.2020 to BT.709 primaries
    lin = vec3f(
      dot(lin, vec3f(1.6605, -0.5876, -0.0728)),
      dot(lin, vec3f(-0.1246, 1.1329, -0.0083)),
      dot(lin, vec3f(-0.0182, -0.1006, 1.1187)));
  }
  let mode = i32(u.color.y + 0.5);
  if (mode == 2) { return srgbEncode(lin); }
  if (mode == 1) { return srgbEncode(clamp(lin, vec3f(0.0), vec3f(1.0))); }
  // Extended Reinhard on the largest channel, so hue holds: the assumed peak maps to 1.0,
  // SDR white to about 0.5, and everything between keeps a gradient. Above the peak clips.
  let positive = max(lin, vec3f(0.0));
  let m = max(max(positive.r, positive.g), positive.b);
  let peak = max(u.misc.z, 1.0);
  let mapped = min(m * (1.0 + m / (peak * peak)) / (1.0 + m), 1.0);
  let scaled = select(positive, positive * (mapped / m), m > 1e-6);
  return srgbEncode(clamp(scaled, vec3f(0.0), vec3f(1.0)));
}

fn adjusted(c0: vec3f) -> vec3f {
  var c = (c0 - vec3f(0.5)) * u.adjust.y + vec3f(0.5) + vec3f(u.adjust.x);
  let luma = dot(c, vec3f(0.2126, 0.7152, 0.0722));
  c = mix(vec3f(luma), c, u.adjust.z);
  c = pow(max(c, vec3f(0.0)), vec3f(1.0 / max(u.adjust.w, 0.01)));
  if (i32(u.color.y + 0.5) == 2) { return c; }
  return clamp(c, vec3f(0.0), vec3f(1.0));
}

@fragment fn fs(input: VsOut) -> @location(0) vec4f {
  let rgb = deinterlaced(frameUv(input.uv));
  return vec4f(adjusted(rgb), 1.0);
}
`;

const EXTERNAL_SOURCE = /* wgsl */`
@group(0) @binding(2) var tex: texture_external;
fn source(uv: vec2f) -> vec3f {
  let c = textureSampleBaseClampToEdge(tex, samp, uv).rgb;
  // The browser has already converted to sRGB. Only the clip-or-pass decision applies.
  return c;
}
`;

const PLANAR_SOURCE = /* wgsl */`
@group(0) @binding(2) var planeY: texture_2d<u32>;
@group(0) @binding(3) var planeU: texture_2d<u32>;
@group(0) @binding(4) var planeV: texture_2d<u32>;
fn loadBilinear(t: texture_2d<u32>, uv: vec2f) -> f32 {
  let dims = vec2f(textureDimensions(t));
  let p = uv * dims - vec2f(0.5);
  let base = floor(p);
  let f = p - base;
  let maxI = vec2i(dims) - vec2i(1);
  let i0 = clamp(vec2i(base), vec2i(0), maxI);
  let i1 = clamp(vec2i(base) + vec2i(1), vec2i(0), maxI);
  let a = f32(textureLoad(t, i0, 0).r);
  let b = f32(textureLoad(t, vec2i(i1.x, i0.y), 0).r);
  let c = f32(textureLoad(t, vec2i(i0.x, i1.y), 0).r);
  let d = f32(textureLoad(t, i1, 0).r);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y) / u.misc.x;
}
fn source(uv: vec2f) -> vec3f {
  let y = (loadBilinear(planeY, uv) - u.range.x) / u.range.y;
  let cb = (loadBilinear(planeU, uv) - u.range.z) / u.range.w;
  let cr = (loadBilinear(planeV, uv) - u.range.z) / u.range.w;
  let kr = u.color.z; let kb = u.color.w;
  let r = y + 2.0 * (1.0 - kr) * cr;
  let b = y + 2.0 * (1.0 - kb) * cb;
  let g = (y - kr * r - kb * b) / (1.0 - kr - kb);
  let e = vec3f(r, g, b);
  let transfer = i32(u.color.x + 0.5);
  if (transfer == 1) { return hdrToOutput(pqEotf(e)); }
  if (transfer == 2) { return hdrToOutput(hlgEotf(e)); }
  return clamp(e, vec3f(0.0), vec3f(1.0));
}
`;

/* Pure helpers, exported for tests. */
export function normalizeView(view = {}) {
  const rotation = [90, 180, 270].includes(view.rotation) ? view.rotation : 0;
  const crop = !view.crop || view.crop === 'none' ? { top: 0, right: 0, bottom: 0, left: 0 } : view.crop;
  const zoom = view.zoom || {};
  const adjust = view.adjust || {};
  const num = (value, fallback, min, max) => (Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback);
  return {
    rotation,
    crop: {
      top: num(crop.top, 0, 0, 0.45), right: num(crop.right, 0, 0, 0.45),
      bottom: num(crop.bottom, 0, 0, 0.45), left: num(crop.left, 0, 0, 0.45),
    },
    zoom: { scale: num(zoom.scale, 1, 1, 16), x: num(zoom.x, 0.5, 0, 1), y: num(zoom.y, 0.5, 0, 1) },
    adjust: {
      brightness: num(adjust.brightness, 0, -1, 1), contrast: num(adjust.contrast, 1, 0, 2),
      saturation: num(adjust.saturation, 1, 0, 2), gamma: num(adjust.gamma, 1, 0.2, 5),
    },
    deinterlace: ['blend', 'bob'].includes(view.deinterlace) ? view.deinterlace : 'off',
    field: view.field === 'bottom' ? 'bottom' : 'top',
    tonemap: view.tonemap === 'off' ? 'off' : 'auto',
  };
}

export function hdrTransfer(frame) {
  const transfer = frame?.colorSpace?.transfer;
  if (transfer === 'pq') return 'pq';
  if (transfer === 'hlg') return 'hlg';
  return null;
}

export async function createGpuRenderer(canvas, { hdrDisplay } = {}) {
  try {
    const gpu = globalThis.navigator?.gpu;
    if (!gpu || !canvas || typeof canvas.getContext !== 'function') return null;
    const adapter = await gpu.requestAdapter();
    if (!adapter) return null;
    const device = await adapter.requestDevice();
    const context = canvas.getContext('webgpu');
    if (!context) { device.destroy(); return null; }
    return buildRenderer(canvas, device, context, gpu.getPreferredCanvasFormat(), hdrDisplay);
  } catch {
    return null;
  }
}

function buildRenderer(canvas, device, context, sdrFormat, hdrDisplayOverride) {
  let lost = false;
  device.lost.then(() => { lost = true; });

  const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
  const uniformBuffer = device.createBuffer({ size: 7 * 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const modules = {
    external: device.createShaderModule({ code: SHADER.replace('SOURCE_FUNCTIONS', EXTERNAL_SOURCE) }),
    planar: device.createShaderModule({ code: SHADER.replace('SOURCE_FUNCTIONS', PLANAR_SOURCE) }),
  };
  // One shader; one pipeline per input path and target format, built on first use.
  const pipelines = new Map();
  function pipeline(path, format) {
    const key = `${path}:${format}`;
    if (!pipelines.has(key)) {
      const module = modules[path];
      pipelines.set(key, device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format }] },
        primitive: { topology: 'triangle-list' },
      }));
    }
    return pipelines.get(key);
  }

  let output = null; // 'sdr' | 'extended'
  let extendedSupported = null;
  function configure(mode) {
    if (output === mode) return;
    if (mode === 'extended') {
      context.configure({ device, format: 'rgba16float', colorSpace: 'srgb', toneMapping: { mode: 'extended' }, alphaMode: 'opaque', usage: GPUTextureUsage.RENDER_ATTACHMENT });
      extendedSupported = context.getConfiguration?.()?.toneMapping?.mode === 'extended';
      if (!extendedSupported) { output = null; configure('sdr'); return; }
    } else {
      context.configure({ device, format: sdrFormat, alphaMode: 'opaque', usage: GPUTextureUsage.RENDER_ATTACHMENT });
    }
    output = mode;
  }
  configure('sdr');

  function hdrDisplay() {
    if (typeof hdrDisplayOverride === 'boolean') return hdrDisplayOverride;
    try { return !!globalThis.matchMedia?.('(dynamic-range: high)').matches; } catch { return false; }
  }

  let planes = null; // { key, y, u, v }
  let lastFrame = null;
  let lastView = normalizeView();
  let info = { input: null, hdr: null, output: 'sdr', tonemap: 'none', format: null };

  function uploadPlanes(frame, layout, spec, data) {
    const w = frame.visibleRect?.width ?? frame.displayWidth;
    const h = frame.visibleRect?.height ?? frame.displayHeight;
    const cw = Math.ceil(w / spec.cx);
    const ch = Math.ceil(h / spec.cy);
    const key = `${w}x${h}:${cw}x${ch}`;
    if (!planes || planes.key !== key) {
      planes?.y.destroy(); planes?.u.destroy(); planes?.v.destroy();
      const make = (width, height) => device.createTexture({
        size: [width, height], format: 'r16uint', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      planes = { key, y: make(w, h), u: make(cw, ch), v: make(cw, ch), w, h };
    }
    const sizes = [[w, h], [cw, ch], [cw, ch]];
    [planes.y, planes.u, planes.v].forEach((texture, i) => {
      device.queue.writeTexture({ texture }, data,
        { offset: layout[i].offset, bytesPerRow: layout[i].stride, rowsPerImage: sizes[i][1] }, sizes[i]);
    });
  }

  /* Choose the input path for a frame; returns the bind group entries and colour settings. */
  async function prepareInput(frame) {
    const hdr = hdrTransfer(frame);
    const spec = hdr ? HDR_FORMATS[frame.format] : null;
    if (hdr && spec) {
      const data = new Uint8Array(frame.allocationSize());
      const layout = await frame.copyTo(data);
      uploadPlanes(frame, layout, spec, data);
      return { path: 'planar', hdr, spec };
    }
    return { path: 'external', hdr, spec: null };
  }

  function writeUniforms(view, input, mode, frame) {
    const v = normalizeView(view);
    const c = v.crop;
    const width = 1 - c.left - c.right;
    const height = 1 - c.top - c.bottom;
    const srcW = input.path === 'planar' ? planes.w : frame.displayWidth;
    const srcH = input.path === 'planar' ? planes.h : frame.displayHeight;
    const deinterlace = { off: 0, blend: 1, bob: 2 }[v.deinterlace];
    const transfer = input.path === 'planar' ? { pq: 1, hlg: 2 }[input.hdr] : 0;
    const outputMode = { tonemap: 0, clip: 1, extended: 2 }[mode];
    const [kr, kb] = MATRIX_K[frame.colorSpace?.matrix] || MATRIX_K['bt2020-ncl'];
    const bits = input.spec?.bits ?? 8;
    const maxCode = 2 ** bits - 1;
    const step = 2 ** (bits - 8);
    const full = !!frame.colorSpace?.fullRange;
    const range = full
      ? [0, 1, (128 * step) / maxCode, 1]
      : [(16 * step) / maxCode, (219 * step) / maxCode, (128 * step) / maxCode, (224 * step) / maxCode];
    const bt2020 = frame.colorSpace?.primaries === 'bt2020' ? 1 : 0;
    const data = new Float32Array([
      c.left, c.top, width, height,
      v.zoom.scale, v.zoom.x, v.zoom.y, v.rotation / 90,
      v.adjust.brightness, v.adjust.contrast, v.adjust.saturation, v.adjust.gamma,
      srcW, srcH, deinterlace, v.field === 'bottom' ? 1 : 0,
      transfer, outputMode, kr, kb,
      ...range,
      maxCode, bt2020, (input.hdr === 'hlg' ? HLG_PEAK_NITS : PQ_PEAK_NITS) / SDR_WHITE_NITS, 0,
    ]);
    device.queue.writeBuffer(uniformBuffer, 0, data);
    return v;
  }

  function encode(target, format, input, frame) {
    const pipe = pipeline(input.path, format);
    // The planar shader never samples (it loads texels), so its automatic layout has no binding 1.
    const entries = [{ binding: 0, resource: { buffer: uniformBuffer } }];
    if (input.path === 'external') {
      entries.push({ binding: 1, resource: sampler }, { binding: 2, resource: device.importExternalTexture({ source: frame }) });
    } else {
      entries.push({ binding: 2, resource: planes.y.createView() },
        { binding: 3, resource: planes.u.createView() }, { binding: 4, resource: planes.v.createView() });
    }
    const bindGroup = device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
    });
    pass.setPipeline(pipe);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
    return encoder;
  }

  /* Output mode for the canvas: extended keeps HDR above white; tonemap maps it into SDR. */
  function canvasMode(view, input) {
    if (!input.hdr) return 'tonemap';
    if (view.tonemap === 'off') return 'clip';
    if (input.path === 'planar' && hdrDisplay() && extendedSupported !== false) return 'extended';
    return 'tonemap';
  }

  let drawing = Promise.resolve();
  let generation = 0;

  /* draw() is synchronous for SDR frames. HDR frames need an asynchronous copyTo; the draw finishes
   * on a later microtask with a clone, so the engine may close its frame as soon as draw() returns. */
  function draw(frame, view) {
    if (lost || !frame) return false;
    const hdr = hdrTransfer(frame);
    const mine = frame.clone();
    lastFrame?.close();
    lastFrame = mine;
    lastView = normalizeView(view);
    generation += 1;
    const ticket = generation;
    if (hdr && HDR_FORMATS[frame.format]) {
      drawing = drawing.then(() => (ticket === generation ? drawNow(mine, lastView) : null)).catch(() => {});
      return true;
    }
    drawNowSync(mine, lastView, { path: 'external', hdr, spec: null });
    return true;
  }

  function drawNowSync(frame, view, input) {
    const mode = canvasMode(view, input);
    configure(mode === 'extended' ? 'extended' : 'sdr');
    const finalMode = mode === 'extended' && output !== 'extended' ? 'tonemap' : mode;
    writeUniforms(view, input, finalMode, frame);
    const format = output === 'extended' ? 'rgba16float' : sdrFormat;
    const encoder = encode(context.getCurrentTexture(), format, input, frame);
    device.queue.submit([encoder.finish()]);
    info = {
      input: input.path, hdr: input.hdr, output, format: frame.format,
      tonemap: !input.hdr ? 'none'
        : finalMode === 'extended' ? 'extended'
          : finalMode === 'clip' ? 'off'
            : input.path === 'planar' ? 'shader' : 'browser',
      deinterlace: view.deinterlace,
    };
  }

  async function drawNow(frame, view) {
    if (lost || frame !== lastFrame) return;
    const input = await prepareInput(frame);
    if (frame !== lastFrame) return;
    drawNowSync(frame, view, input);
  }

  function size(width, height) {
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
  }

  /* PNG of the last frame, drawn again off screen in SDR (tone-mapped when HDR). */
  async function snapshot() {
    await drawing;
    if (!lastFrame) throw new Error('No frame has been drawn yet.');
    const frame = lastFrame;
    const width = canvas.width;
    const height = canvas.height;
    const input = await prepareInput(frame);
    const mode = input.hdr && lastView.tonemap === 'off' ? 'clip' : 'tonemap';
    writeUniforms(lastView, input, mode, frame);
    const target = device.createTexture({
      size: [width, height], format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const encoder = encode(target, 'rgba8unorm', input, frame);
    const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
    const buffer = device.createBuffer({ size: bytesPerRow * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    encoder.copyTextureToBuffer({ texture: target }, { buffer, bytesPerRow }, [width, height]);
    device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const padded = new Uint8Array(buffer.getMappedRange());
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let row = 0; row < height; row += 1) {
      pixels.set(padded.subarray(row * bytesPerRow, row * bytesPerRow + width * 4), row * width * 4);
    }
    buffer.unmap();
    buffer.destroy();
    target.destroy();
    const out = new OffscreenCanvas(width, height);
    out.getContext('2d').putImageData(new ImageData(pixels, width, height), 0, 0);
    return out.convertToBlob({ type: 'image/png' });
  }

  function clear() {
    generation += 1;
    lastFrame?.close();
    lastFrame = null;
    if (lost) return;
    configure('sdr');
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
    });
    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  function state() {
    return { backend: 'webgpu', lost, extendedSupported, hdrDisplay: hdrDisplay(), ...info };
  }

  function destroy() {
    generation += 1;
    lastFrame?.close();
    lastFrame = null;
    planes?.y.destroy(); planes?.u.destroy(); planes?.v.destroy();
    planes = null;
    uniformBuffer.destroy();
    try { context.unconfigure(); } catch { /* already gone */ }
    device.destroy();
  }

  return Object.freeze({ draw, size, snapshot, state, clear, destroy });
}
