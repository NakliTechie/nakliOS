// Visualiser modes.
//
// Each mode is a pure draw function over a frame: it gets a 2D context, the
// current spectrum and waveform, and a palette, and paints one frame. No mode
// keeps state outside the `memory` object handed to it, so switching modes is
// free and a mode cannot leak a timer, a listener, or a canvas.
//
// Headless by contract in the sense that matters here: no DOM lookups, no
// network, no engine import. A mode only ever touches the context it is given.

/** Sum a slice of the spectrum, normalised to 0..1. */
function band(freq, from, to) {
  let sum = 0;
  const start = Math.max(0, Math.floor(from));
  const end = Math.min(freq.length, Math.ceil(to));
  for (let index = start; index < end; index += 1) sum += freq[index];
  return end > start ? sum / ((end - start) * 255) : 0;
}

/**
 * Group the spectrum into `count` bars on a roughly logarithmic scale, which is
 * how hearing works: a linear split puts almost everything in the first bar.
 */
function bars(freq, count) {
  return barsInto(new Float32Array(count), freq);
}

/** `bars` into an existing array, so a mode can reuse one buffer per frame. */
function barsInto(out, freq) {
  const count = out.length;
  const usable = Math.floor(freq.length * 0.7); // the top octave is mostly noise
  for (let index = 0; index < count; index += 1) {
    const from = Math.floor(usable ** (index / count));
    const to = Math.max(from + 1, Math.floor(usable ** ((index + 1) / count)));
    out[index] = band(freq, from, to);
  }
  return out;
}

function clear(context, width, height, palette) {
  context.clearRect(0, 0, width, height);
  if (palette.background) {
    context.fillStyle = palette.background;
    context.fillRect(0, 0, width, height);
  }
}

/** Peak-hold state, shared by the modes that show a falling cap. */
function peaks(memory, values, fall = 0.012) {
  if (!memory.peaks || memory.peaks.length !== values.length) memory.peaks = new Float32Array(values.length);
  for (let index = 0; index < values.length; index += 1) {
    memory.peaks[index] = Math.max(values[index], memory.peaks[index] - fall);
  }
  return memory.peaks;
}

const BAR_COUNT = 48;
const TAU = Math.PI * 2;
const DEFAULT_SEED = 0x5eed1e55;

// ----------------------------------------------- motion and randomness ----
//
// Modes never call Math.random: the driver hands each frame a `seed`, and the
// random stream lives in `memory`, so the same seed and the same audio give the
// same pictures. That is what lets the tests compare two runs call by call.

function seedOf(frame) {
  return (frame.seed ?? DEFAULT_SEED) | 0;
}

/** Seeded random in [0, 1) (mulberry32); its state is the mode's memory. */
function random(frame) {
  const { memory } = frame;
  memory.rngState ??= seedOf(frame) >>> 0;
  memory.rngState = (memory.rngState + 0x6d2b79f5) >>> 0;
  let value = memory.rngState;
  value = Math.imul(value ^ (value >>> 15), value | 1);
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
  return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
}

/** A stable value in [0, 1) for a position, so per-item traits never jitter. */
function hash(a, b = 0, c = 0) {
  let value = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul((b | 0) + 0x165667b1, 0x85ebca77) ^ Math.imul((c | 0) + 0x9e3779b1, 0xc2b2ae3d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x85ebca6b);
  value ^= value >>> 13;
  value = Math.imul(value, 0xc2b2ae35);
  value ^= value >>> 16;
  return (value >>> 0) / 4294967296;
}

/**
 * How far one frame moves things. Under reduced motion the driver already
 * draws only twice a second; halving the step as well keeps the motion slow
 * and small, never stopped.
 */
function stepOf(frame) {
  return frame.reduced ? 0.5 : 1;
}

/** Advance and return the mode's own clock, in steps. */
function tick(frame) {
  frame.memory.clock = (frame.memory.clock ?? 0) + stepOf(frame);
  return frame.memory.clock;
}

/** Spectrum bars into a buffer the mode keeps, allocated once per size. */
function levels(frame, count) {
  const { memory } = frame;
  if (memory.levels?.length !== count) memory.levels = new Float32Array(count);
  return barsInto(memory.levels, frame.freq);
}

/** Ease a value toward its target, kept under `key` in memory. */
function smooth(frame, key, target, rate) {
  const { memory } = frame;
  const current = memory[key] ?? target;
  memory[key] = current + (target - current) * Math.min(1, rate * stepOf(frame));
  return memory[key];
}

/** A bass hit: the low band jumps clear of its own running average. */
function kick(frame, bass) {
  const { memory } = frame;
  const average = memory.bassAverage ?? bass;
  memory.bassAverage = average + (bass - average) * 0.08 * stepOf(frame);
  const cooling = memory.kickCooldown ?? 0;
  const hit = cooling <= 0 && bass > 0.2 && bass - average > 0.08;
  memory.kickCooldown = hit ? 8 : cooling - stepOf(frame);
  return hit;
}

// ------------------------------------------------------------- modes ----

function drawBars({ context, width, height, freq, palette }) {
  const values = bars(freq, BAR_COUNT);
  const slot = width / values.length;
  const gap = Math.max(1, slot * 0.18);
  context.fillStyle = palette.accent;
  for (let index = 0; index < values.length; index += 1) {
    const barHeight = values[index] * height;
    context.fillRect(index * slot, height - barHeight, slot - gap, barHeight);
  }
}

function drawBarsDot({ context, width, height, freq, palette, memory }) {
  const values = bars(freq, BAR_COUNT);
  const held = peaks(memory, values);
  const slot = width / values.length;
  const dot = Math.max(2, slot * 0.5);
  context.fillStyle = palette.accent;
  for (let index = 0; index < values.length; index += 1) {
    const steps = Math.floor(values[index] * (height / (dot * 1.6)));
    for (let step = 0; step < steps; step += 1) {
      context.fillRect(index * slot, height - step * dot * 1.6 - dot, slot - dot * 0.5, dot * 0.8);
    }
    context.fillStyle = palette.muted;
    context.fillRect(index * slot, height - held[index] * height - 2, slot - dot * 0.5, 2);
    context.fillStyle = palette.accent;
  }
}

function drawBarsOutline({ context, width, height, freq, palette }) {
  const values = bars(freq, BAR_COUNT);
  const slot = width / values.length;
  context.strokeStyle = palette.accent;
  context.lineWidth = 1;
  for (let index = 0; index < values.length; index += 1) {
    const barHeight = Math.max(1, values[index] * height);
    context.strokeRect(index * slot + 0.5, height - barHeight + 0.5, slot - 2, barHeight - 1);
  }
}

function drawClassicPeak({ context, width, height, freq, palette, memory }) {
  const values = bars(freq, BAR_COUNT);
  const held = peaks(memory, values, 0.008);
  const slot = width / values.length;
  for (let index = 0; index < values.length; index += 1) {
    const barHeight = values[index] * height;
    const gradient = context.createLinearGradient(0, height, 0, height - barHeight);
    gradient.addColorStop(0, palette.accent);
    gradient.addColorStop(1, palette.hot);
    context.fillStyle = gradient;
    context.fillRect(index * slot, height - barHeight, slot - 2, barHeight);
    context.fillStyle = palette.text;
    context.fillRect(index * slot, height - held[index] * height - 2, slot - 2, 2);
  }
}

function drawClassicLed({ context, width, height, freq, palette, memory }) {
  const values = bars(freq, 32);
  const held = peaks(memory, values, 0.01);
  const slot = width / values.length;
  const cell = Math.max(3, height / 22);
  for (let index = 0; index < values.length; index += 1) {
    const lit = Math.floor(values[index] * (height / cell));
    for (let step = 0; step < height / cell; step += 1) {
      const ratio = step / (height / cell);
      context.fillStyle = step < lit
        ? (ratio > 0.8 ? palette.hot : ratio > 0.55 ? palette.warm : palette.accent)
        : palette.dim;
      context.fillRect(index * slot, height - (step + 1) * cell + 1, slot - 2, cell - 2);
    }
    const peakStep = Math.floor(held[index] * (height / cell));
    context.fillStyle = palette.text;
    context.fillRect(index * slot, height - (peakStep + 1) * cell + 1, slot - 2, 2);
  }
}

function drawWave({ context, width, height, wave, palette }) {
  context.strokeStyle = palette.accent;
  context.lineWidth = 2;
  context.beginPath();
  for (let index = 0; index < wave.length; index += 1) {
    const x = (index / (wave.length - 1)) * width;
    const y = height / 2 + ((wave[index] - 128) / 128) * (height / 2) * 0.9;
    if (index === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  }
  context.stroke();
}

function drawScope({ context, width, height, wave, palette }) {
  context.strokeStyle = palette.dim;
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(0, height / 2);
  context.lineTo(width, height / 2);
  context.stroke();
  context.strokeStyle = palette.good;
  context.lineWidth = 1.5;
  context.beginPath();
  // Trigger on the first upward zero crossing so the trace stops sliding.
  let start = 0;
  for (let index = 1; index < wave.length / 2; index += 1) {
    if (wave[index - 1] < 128 && wave[index] >= 128) { start = index; break; }
  }
  const span = Math.floor(wave.length / 2);
  for (let index = 0; index < span; index += 1) {
    const x = (index / span) * width;
    const y = height / 2 + ((wave[start + index] - 128) / 128) * (height / 2) * 0.9;
    if (index === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  }
  context.stroke();
}

function drawPulse({ context, width, height, freq, palette }) {
  const low = band(freq, 0, freq.length * 0.08);
  const mid = band(freq, freq.length * 0.08, freq.length * 0.35);
  const radius = Math.min(width, height) * (0.14 + low * 0.34);
  context.beginPath();
  context.arc(width / 2, height / 2, radius, 0, Math.PI * 2);
  context.fillStyle = palette.accent;
  context.globalAlpha = 0.22 + low * 0.4;
  context.fill();
  context.globalAlpha = 1;
  context.strokeStyle = palette.hot;
  context.lineWidth = 1 + mid * 5;
  context.stroke();
}

function drawBricks({ context, width, height, freq, palette }) {
  const values = bars(freq, 24);
  const slot = width / values.length;
  const brick = Math.max(4, height / 16);
  for (let index = 0; index < values.length; index += 1) {
    const rows = Math.ceil(values[index] * (height / brick));
    for (let row = 0; row < rows; row += 1) {
      context.fillStyle = row % 2 ? palette.accent : palette.warm;
      context.fillRect(index * slot + 1, height - (row + 1) * brick + 1, slot - 3, brick - 3);
    }
  }
}

function drawColumns({ context, width, height, freq, palette }) {
  const values = bars(freq, 16);
  const slot = width / values.length;
  for (let index = 0; index < values.length; index += 1) {
    const barHeight = values[index] * height;
    context.fillStyle = palette.accent;
    context.globalAlpha = 0.35;
    context.fillRect(index * slot, 0, slot - 3, height);
    context.globalAlpha = 1;
    context.fillRect(index * slot, height - barHeight, slot - 3, barHeight);
  }
}

function drawScatter(frame) {
  const { context, width, height, freq, palette, memory } = frame;
  memory.points ??= [];
  const level = band(freq, 0, freq.length * 0.5);
  memory.points.push({ x: random(frame) * width, y: height, life: 1, size: 1 + level * 5 });
  if (memory.points.length > 220) memory.points.splice(0, memory.points.length - 220);
  context.fillStyle = palette.accent;
  for (const point of memory.points) {
    point.y -= 1 + level * 6;
    point.life -= 0.012;
    if (point.life <= 0) continue;
    context.globalAlpha = Math.max(0, point.life);
    context.fillRect(point.x, point.y, point.size, point.size);
  }
  context.globalAlpha = 1;
  memory.points = memory.points.filter(point => point.life > 0 && point.y > -10);
}

function drawFlame({ context, width, height, freq, palette }) {
  const values = bars(freq, 64);
  const slot = width / values.length;
  for (let index = 0; index < values.length; index += 1) {
    const barHeight = values[index] * height;
    const gradient = context.createLinearGradient(0, height, 0, height - barHeight);
    gradient.addColorStop(0, palette.hot);
    gradient.addColorStop(0.5, palette.warm);
    gradient.addColorStop(1, 'transparent');
    context.fillStyle = gradient;
    context.beginPath();
    context.moveTo(index * slot, height);
    context.quadraticCurveTo(index * slot + slot / 2, height - barHeight * 1.25, index * slot + slot, height);
    context.fill();
  }
}

function drawMatrix(frame) {
  const { context, width, height, freq, palette, memory } = frame;
  const columns = Math.floor(width / 12) || 1;
  if (memory.drops?.length !== columns) memory.drops = new Float32Array(columns).map(() => random(frame) * height);
  const level = band(freq, 0, freq.length * 0.4);
  context.fillStyle = palette.good;
  context.font = '11px monospace';
  for (let index = 0; index < columns; index += 1) {
    const glyph = String.fromCharCode(0x30a0 + Math.floor(random(frame) * 96));
    context.globalAlpha = 0.35 + level * 0.65;
    context.fillText(glyph, index * 12, memory.drops[index]);
    memory.drops[index] += 4 + level * 22;
    if (memory.drops[index] > height) memory.drops[index] = 0;
  }
  context.globalAlpha = 1;
}

/**
 * Left and right, from two real taps.
 *
 * This used to take the single summed spectrum and draw its lower half on one
 * side and its upper half on the other — so the left "channel" was the bass of
 * both channels and the right was the treble of both. There is no channel
 * information in a mono analyser to recover, so the fix was upstream: the
 * engine splits the rung and hands this two.
 */
function drawStereo({ context, width, height, freq, freqLeft, freqRight, palette }) {
  const left = bars(freqLeft ?? freq, 24);
  const right = bars(freqRight ?? freq, 24);
  const slot = (width / 2) / left.length;
  context.fillStyle = palette.accent;
  for (let index = 0; index < left.length; index += 1) {
    const h = left[index] * height;
    context.fillRect(width / 2 - (index + 1) * slot, height - h, slot - 2, h);
  }
  context.fillStyle = palette.warm;
  for (let index = 0; index < right.length; index += 1) {
    const h = right[index] * height;
    context.fillRect(width / 2 + index * slot, height - h, slot - 2, h);
  }
}

// ------------------------------------------------- the cliamp set ----
//
// Each of these follows the idea of the cliamp mode of the same name
// (github.com/bjarneo/cliamp, MIT), drawn for a canvas: shapes and pixels where
// cliamp has Braille dots and block glyphs, text only where the characters are
// the point (Binary, Ascii).

/** Rain: bars whose bodies are falling streaks, bright head and dim tail. */
function drawRain(frame) {
  const { context, width, height, palette } = frame;
  if (width < 4 || height < 4) return;
  const t = tick(frame);
  const seed = seedOf(frame);
  const values = levels(frame, 32);
  const slot = width / values.length;
  const cell = Math.max(3, height / 40);
  context.fillStyle = palette.dim;
  for (let index = 0; index < values.length; index += 1) {
    const barHeight = values[index] * height;
    context.fillRect(index * slot, height - barHeight, slot - 2, barHeight);
  }
  for (let index = 0; index < values.length; index += 1) {
    const barHeight = values[index] * height;
    if (barHeight < cell) continue;
    // Louder bars carry a second lane of rain.
    const lanes = values[index] > 0.5 ? 2 : 1;
    const laneWidth = Math.max(1, (slot - 2) / (lanes * 2));
    for (let lane = 0; lane < lanes; lane += 1) {
      const key = index * 2 + lane;
      drawRainLane(frame, {
        x: index * slot + laneWidth * (lane * 2 + 0.5), top: height - barHeight, laneWidth, cell,
        speed: 0.25 + hash(seed, key, 1) * 0.5, // cells per step
        length: 2 + Math.floor(hash(seed, key, 3) * 3),
        gap: 2 + Math.floor(hash(seed, key, 5) * 4),
        start: hash(seed, key, 7),
        t,
      });
    }
  }
}

/** One lane of falling streaks inside a Rain bar. */
function drawRainLane({ context, height, palette }, { x, top, laneWidth, cell, speed, length, gap, start, t }) {
  const period = length + gap;
  const offset = (t * speed + start * period) % period;
  const cells = Math.ceil((height - top) / cell) + length;
  for (let head = offset; head < cells; head += period) {
    for (let segment = 0; segment < length; segment += 1) {
      const y = top + (Math.floor(head) - segment) * cell;
      if (y < top || y >= height) continue;
      context.fillStyle = segment === 0 ? palette.text : segment < length - 1 ? palette.accent : palette.muted;
      context.fillRect(x, y, laneWidth, cell - 1);
    }
  }
}

/** Retro: a striped sun on the horizon, the spectrum as a wave, a moving grid floor. */
function drawRetro(frame) {
  const { context, width, height, freq, palette, memory } = frame;
  if (width < 4 || height < 4) return;
  const horizon = height * 0.45;
  const bass = smooth(frame, 'bass', band(freq, 0, freq.length * 0.06), 0.3);
  const level = smooth(frame, 'level', band(freq, 0, freq.length * 0.5), 0.2);

  // Sun: horizontal strips of a circle; the lower half loses every third strip.
  const radius = Math.min(width * 0.18, horizon * 0.85) * (0.85 + bass * 0.25);
  const centreX = width / 2;
  const strip = Math.max(2, radius / 14);
  for (let y = horizon - radius; y < horizon; y += strip) {
    const rise = horizon - y;
    const halfWidth = Math.sqrt(Math.max(0, radius * radius - rise * rise));
    if (rise < radius * 0.5 && Math.floor(rise / strip) % 3 === 0) continue;
    context.fillStyle = rise > radius * 0.5 ? palette.hot : palette.warm;
    context.fillRect(centreX - halfWidth, y, halfWidth * 2, strip - 0.5);
  }

  // Wave: cosine-interpolated across the spectrum, riding the horizon.
  const values = levels(frame, 16);
  context.strokeStyle = palette.accent;
  context.lineWidth = Math.max(1.5, height / 120);
  context.beginPath();
  const stepX = Math.max(2, width / 160);
  for (let x = 0; x <= width; x += stepX) {
    const position = (x / width) * (values.length - 1);
    const left = Math.floor(position);
    const right = Math.min(values.length - 1, left + 1);
    const blend = (1 - Math.cos((position - left) * Math.PI)) / 2;
    const value = values[left] * (1 - blend) + values[right] * blend;
    const y = horizon - value * horizon * 0.6;
    if (x === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  }
  context.stroke();

  // Floor: lines to a vanishing point, and cross lines that scroll toward you.
  context.strokeStyle = palette.muted;
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(0, horizon);
  context.lineTo(width, horizon);
  const spokes = 10;
  for (let spoke = -spokes; spoke <= spokes; spoke += 1) {
    context.moveTo(centreX + spoke * width * 0.02, horizon);
    context.lineTo(centreX + spoke * width * 0.12, height);
  }
  memory.scroll = ((memory.scroll ?? 0) + (0.01 + level * 0.03) * stepOf(frame)) % 1;
  const rungs = 10;
  for (let rung = 0; rung < rungs; rung += 1) {
    const depth = (rung + memory.scroll) / rungs;
    const y = horizon + (height - horizon) * depth * depth;
    context.moveTo(0, y);
    context.lineTo(width, y);
  }
  context.stroke();
}

/** Binary: columns of 0s and 1s that scroll faster and run hotter with their band. */
function drawBinary(frame) {
  const { context, width, height, palette, memory } = frame;
  if (width < 4 || height < 4) return;
  const seed = seedOf(frame);
  const cell = Math.max(10, height / 16);
  const cellWidth = cell * 0.75;
  const columns = Math.max(1, Math.floor(width / cellWidth));
  const rows = Math.ceil(height / cell);
  if (memory.offsets?.length !== columns) memory.offsets = new Float32Array(columns);
  const values = levels(frame, Math.min(columns, 64));
  context.font = `${Math.floor(cell * 0.9)}px monospace`;
  for (let column = 0; column < columns; column += 1) {
    const level = values[Math.floor((column * values.length) / columns)];
    memory.offsets[column] += (0.08 + level * 0.6) * stepOf(frame);
    const shift = Math.floor(memory.offsets[column]);
    for (let row = 0; row < rows; row += 1) {
      // The bit belongs to its place in the stream, so scrolling is the motion.
      const one = hash(seed + column, row - shift, 11) < 0.2 + level * 0.65;
      context.fillStyle = one ? (level > 0.45 ? palette.good : palette.accent) : palette.dim;
      context.globalAlpha = one ? 0.45 + level * 0.55 : 1;
      context.fillText(one ? '1' : '0', column * cellWidth, (row + 1) * cell);
    }
  }
  context.globalAlpha = 1;
}

/** Point `(x, y)` turned by `angle` about `(cx, cy)`, written into `out`. */
function turn(out, cx, cy, x, y, angle) {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  out[0] = cx + x * cos - y * sin;
  out[1] = cy + x * sin + y * cos;
  return out;
}

const POINT = [0, 0];
const CONTROL = [0, 0];

/** Sakura: petals drifting down with a sway; louder music fills the air. */
function drawSakura(frame) {
  const { context, width, height, freq, palette } = frame;
  if (width < 4 || height < 4) return;
  const t = tick(frame);
  const seed = seedOf(frame);
  const level = smooth(frame, 'level', band(freq, 0, freq.length * 0.5), 0.05);
  const count = Math.round(12 + Math.min(1, level * 1.6) * 16);
  const unit = Math.max(3, Math.min(width, height) / 40);
  context.fillStyle = palette.petal ?? '#e9a6b4';
  for (let index = 0; index < count; index += 1) {
    // Near petals are big and slow, far ones small, quick and faint.
    const tier = Math.floor(hash(seed, index, 1) * 3);
    const size = unit * [1.6, 1.1, 0.7][tier];
    const fall = unit * [0.06, 0.09, 0.13][tier];
    const span = height + size * 4;
    const y = ((t * fall + hash(seed, index, 2) * span) % span) - size * 2;
    const sway = Math.sin(t * 0.02 * (0.6 + hash(seed, index, 3)) + hash(seed, index, 4) * TAU) * unit * (2 + level * 4);
    const x = (((hash(seed, index, 5) * width + sway) % width) + width) % width;
    const angle = t * 0.012 * (hash(seed, index, 6) - 0.5) * 4 + hash(seed, index, 7) * TAU;
    context.globalAlpha = [0.9, 0.7, 0.5][tier];
    context.beginPath();
    turn(POINT, x, y, 0, -size, angle);
    context.moveTo(POINT[0], POINT[1]);
    turn(CONTROL, x, y, size * 0.9, 0, angle);
    turn(POINT, x, y, 0, size, angle);
    context.quadraticCurveTo(CONTROL[0], CONTROL[1], POINT[0], POINT[1]);
    turn(CONTROL, x, y, -size * 0.9, 0, angle);
    turn(POINT, x, y, 0, -size, angle);
    context.quadraticCurveTo(CONTROL[0], CONTROL[1], POINT[0], POINT[1]);
    context.fill();
  }
  context.globalAlpha = 1;
}

/** Firework: rockets rise and burst; loudness sets how many and how big. */
function drawFirework(frame) {
  const { context, width, height, freq, palette } = frame;
  if (width < 4 || height < 4) return;
  const t = tick(frame);
  const seed = seedOf(frame);
  const level = smooth(frame, 'level', band(freq, 0, freq.length * 0.6), 0.1);
  const count = Math.round(5 + Math.min(1, level * 1.4) * 9);
  const unit = Math.max(1.5, Math.min(width, height) / 120);
  const colours = [palette.hot, palette.warm, palette.accent, palette.good];
  const sparks = 18;
  for (let index = 0; index < count; index += 1) {
    const period = 90 + hash(seed, index, 1) * 70;
    const local = t + hash(seed, index, 2) * period;
    const cycle = Math.floor(local / period);
    const phase = (local % period) / period;
    // Each cycle of a burst lands somewhere new.
    const centreX = (0.1 + 0.8 * hash(seed + cycle, index, 3)) * width;
    const centreY = (0.15 + 0.4 * hash(seed + cycle, index, 4)) * height;
    context.fillStyle = colours[Math.floor(hash(seed + cycle, index, 5) * colours.length)];
    if (phase < 0.3) {
      const rise = phase / 0.3;
      const y = height - (height - centreY) * rise * (2 - rise);
      for (let trail = 0; trail < 3; trail += 1) {
        context.globalAlpha = 1 - trail * 0.3;
        context.fillRect(centreX, y + trail * unit * 2.5, unit, unit * 1.5);
      }
      continue;
    }
    const burst = (phase - 0.3) / 0.7;
    const reach = Math.min(width, height) * (0.08 + level * 0.18) * (0.7 + hash(seed + cycle, index, 6) * 0.6);
    const radius = reach * (1 - (1 - burst) ** 3);
    const drop = burst * burst * reach * 0.6;
    const twist = hash(seed + cycle, index, 7) * TAU;
    context.globalAlpha = Math.max(0, 1 - burst);
    for (let spark = 0; spark < sparks; spark += 1) {
      const angle = (spark / sparks) * TAU + twist;
      context.fillRect(centreX + Math.cos(angle) * radius, centreY + Math.sin(angle) * radius + drop, unit, unit);
    }
  }
  context.globalAlpha = 1;
}

/** Bubbles: a fixed shoal of rings rising and swaying; they fade at the surface. */
function drawBubbles(frame) {
  const { context, width, height, freq, palette } = frame;
  if (width < 4 || height < 4) return;
  const t = tick(frame);
  const seed = seedOf(frame);
  const level = smooth(frame, 'level', band(freq, 0, freq.length * 0.5), 0.15);
  const treble = smooth(frame, 'treble', band(freq, freq.length * 0.3, freq.length * 0.7), 0.2);
  const unit = Math.max(2, Math.min(width, height) / 60);
  context.lineWidth = Math.max(1, unit * 0.4);
  for (let index = 0; index < 26; index += 1) {
    // Size is fixed per bubble: tying it to audio would make the path jump.
    const size = 1.5 + hash(seed, index, 1) * 2.5;
    const radius = size * unit;
    const rise = (unit * 0.9) / size;
    const span = height + radius * 4;
    const y = height + radius * 2 - ((t * rise + hash(seed, index, 2) * span) % span);
    const x = hash(seed, index, 3) * width
      + Math.sin(t * 0.03 * (0.5 + hash(seed, index, 4)) + hash(seed, index, 5) * TAU) * unit * (2 + level * 6);
    const fade = Math.max(0, Math.min(1, y / (height * 0.25)));
    context.globalAlpha = fade;
    context.strokeStyle = palette.accent;
    context.beginPath();
    context.arc(x, y, radius, 0, TAU);
    context.stroke();
    context.globalAlpha = fade * (0.35 + treble * 0.65);
    context.fillStyle = palette.text;
    context.beginPath();
    context.arc(x - radius * 0.35, y - radius * 0.35, radius * 0.22, 0, TAU);
    context.fill();
  }
  context.globalAlpha = 1;
}

// 5 x 7 pixel letters; bit 4 (0x10) is the leftmost pixel.
const GLYPHS = Object.freeze({
  N: [0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11],
  A: [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  K: [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
  L: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
  I: [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e],
  M: [0x11, 0x1b, 0x15, 0x15, 0x11, 0x11, 0x11],
  P: [0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10],
});
const WORDMARK = 'NAKLIAMP';

/** Logo: the NakliAmp wordmark in pixels; loud fills it, silence scatters it. */
function drawLogo(frame) {
  const { context, width, height, palette } = frame;
  if (width < 4 || height < 4) return;
  const t = tick(frame);
  const seed = seedOf(frame);
  const values = levels(frame, WORDMARK.length);
  const pixel = Math.max(1, Math.min(width / (WORDMARK.length * 6 + 1), (height * 0.75) / 7));
  const left = (width - (WORDMARK.length * 6 - 1) * pixel) / 2;
  const top = (height - 7 * pixel) / 2;
  const shuffle = Math.floor(t / 20);
  for (let letter = 0; letter < WORDMARK.length; letter += 1) {
    const rows = GLYPHS[WORDMARK[letter]];
    const level = values[letter];
    const bounce = Math.sin(t * 0.06 + letter * 0.7) * pixel * (0.4 + level);
    for (let row = 0; row < 7; row += 1) {
      for (let column = 0; column < 5; column += 1) {
        if (!(rows[row] & (0x10 >> column))) continue;
        const lit = hash(seed + letter * 64 + row * 8 + column, shuffle, 13) < 0.12 + level * 1.1;
        context.fillStyle = lit ? (level > 0.6 ? palette.hot : palette.accent) : palette.dim;
        context.fillRect(left + (letter * 6 + column) * pixel, top + row * pixel + bounce, pixel * 0.86, pixel * 0.86);
      }
    }
  }
}

/** Terrain: loudness becomes a mountain range that scrolls in from the right. */
function drawTerrain(frame) {
  const { context, width, height, freq, palette, memory } = frame;
  if (width < 4 || height < 4) return;
  const columnWidth = Math.max(2, Math.round(width / 160));
  const columns = Math.ceil(width / columnWidth) + 1;
  if (memory.ridge?.length !== columns) memory.ridge = new Float32Array(columns);
  const ridge = memory.ridge;
  const level = smooth(frame, 'level', band(freq, 0, freq.length * 0.6), 0.2);
  memory.scroll = (memory.scroll ?? 0) + stepOf(frame);
  while (memory.scroll >= 1) {
    memory.scroll -= 1;
    ridge.copyWithin(0, 1);
    const noise = (random(frame) - 0.5) * 0.12 * (0.3 + level);
    ridge[columns - 1] = Math.max(0, Math.min(1, level * 0.9 + noise));
  }
  // Green valleys, warm slopes, hot peaks.
  const gradient = context.createLinearGradient(0, height, 0, 0);
  gradient.addColorStop(0, palette.good);
  gradient.addColorStop(0.5, palette.warm);
  gradient.addColorStop(1, palette.hot);
  context.fillStyle = gradient;
  context.beginPath();
  context.moveTo(0, height);
  for (let column = 0; column < columns; column += 1) {
    context.lineTo(column * columnWidth, height - ridge[column] * height * 0.9);
  }
  context.lineTo(width, height);
  context.closePath();
  context.fill();
}

// One heartbeat, sample by sample: P wave, the QRS spike, then the T wave.
const ECG = Object.freeze([0.04, 0.09, 0.11, 0.07, 0, 0, -0.12, 0.95, -0.35, -0.08, 0, 0, 0.04, 0.11, 0.17, 0.17, 0.11, 0.04, 0]);

/** The next trace sample: the beat in progress, else the signal's own small noise. */
function heartbeatSample(memory, wave) {
  if (memory.beat < ECG.length) {
    memory.beat += 1;
    return ECG[memory.beat - 1] * memory.beatSize;
  }
  return wave.length ? ((wave[(memory.head * 7) % wave.length] - 128) / 128) * 0.06 : 0;
}

/** Heartbeat: a scrolling monitor trace; each bass hit is a beat, silence is flat. */
function drawHeartbeat(frame) {
  const { context, width, height, freq, wave, palette, memory } = frame;
  if (width < 4 || height < 4) return;
  const columnWidth = Math.max(1, width / 240);
  const columns = Math.max(2, Math.ceil(width / columnWidth));
  if (memory.trace?.length !== columns) {
    memory.trace = new Float32Array(columns);
    memory.head = 0;
    memory.beat = ECG.length;
    memory.beatSize = 0;
  }
  const bass = band(freq, 0, freq.length * 0.06);
  if (kick(frame, bass)) {
    memory.beat = 0;
    memory.beatSize = 0.4 + bass * 0.6;
  }
  memory.samples = (memory.samples ?? 0) + 2 * stepOf(frame);
  while (memory.samples >= 1) {
    memory.samples -= 1;
    memory.trace[memory.head] = heartbeatSample(memory, wave);
    memory.head = (memory.head + 1) % columns;
  }
  const middle = height / 2;
  context.fillStyle = palette.dim;
  for (let x = 0; x < width; x += columnWidth * 10) context.fillRect(x, middle, columnWidth * 6, 1);
  context.strokeStyle = palette.hot;
  context.lineWidth = Math.max(1.5, height / 100);
  context.beginPath();
  let lastY = middle;
  for (let step = 0; step < columns; step += 1) {
    lastY = middle - memory.trace[(memory.head + step) % columns] * height * 0.42;
    if (step === 0) context.moveTo(0, lastY);
    else context.lineTo(step * columnWidth, lastY);
  }
  context.stroke();
  const dot = Math.max(3, height / 50);
  context.fillStyle = palette.text;
  context.fillRect((columns - 1) * columnWidth - dot / 2, lastY - dot / 2, dot, dot);
}

/** Butterfly: the spectrum mirrored into two ink-blot wings either side of a spine. */
function drawButterfly(frame) {
  const { context, width, height, palette } = frame;
  if (width < 4 || height < 4) return;
  const t = tick(frame);
  const seed = seedOf(frame);
  const values = levels(frame, 18);
  const rows = 36;
  const centre = width / 2;
  const reach = width * 0.45;
  const cell = Math.max(height / rows, reach / 40);
  const flicker = Math.floor(t / 3);
  const half = rows / 2;
  for (let row = 0; row < rows; row += 1) {
    const ratio = row / rows;
    // Treble at the top of the wings, bass at the bottom; two lobes per side.
    const level = values[values.length - 1 - Math.floor(ratio * values.length)];
    const lobe = 0.55 + 0.45 * Math.sin(Math.PI * ((row % half) / half));
    const wing = reach * Math.min(1, level * 1.3) * lobe * (1 + 0.12 * Math.sin(row * 0.5 + t * 0.05));
    const steps = Math.floor(wing / cell);
    context.fillStyle = ratio < 0.33 ? palette.hot : ratio < 0.66 ? palette.accent : palette.warm;
    const y = row * (height / rows);
    for (let step = 0; step < steps; step += 1) {
      // Dense at the body, ragged at the edge.
      if (hash(seed + row * 97 + step, flicker, 17) > 1 - (step / steps) * 0.75) continue;
      context.fillRect(centre + step * cell + cell * 0.1, y, cell * 0.8, (height / rows) * 0.8);
      context.fillRect(centre - (step + 1) * cell + cell * 0.1, y, cell * 0.8, (height / rows) * 0.8);
    }
  }
  context.fillStyle = palette.text;
  context.fillRect(centre - cell * 0.4, height * 0.2, cell * 0.8, height * 0.6);
}

const RAMP = ' .:-=+*#%@';

/** Ascii: thin columns drawn in characters, densest at the base, with a falling peak. */
function drawAscii(frame) {
  const { context, width, height, palette, memory } = frame;
  if (width < 4 || height < 4) return;
  const cell = Math.max(10, height / 18);
  const cellWidth = cell * 0.62;
  const columns = Math.max(1, Math.floor(width / cellWidth));
  const rows = Math.max(1, Math.floor(height / cell));
  const values = levels(frame, Math.min(Math.ceil(columns / 2), 64));
  const held = peaks(memory, values, 0.01 * stepOf(frame));
  context.font = `${Math.floor(cell)}px monospace`;
  // One column of characters, one column of gap, as in ClassicPeak.
  for (let column = 0; column < columns; column += 2) {
    const index = Math.min(values.length - 1, Math.floor((column * values.length) / columns));
    const filled = values[index] * rows;
    const full = Math.floor(filled);
    const x = column * cellWidth;
    for (let row = 0; row <= full && row < rows; row += 1) {
      const ratio = row / rows;
      const glyph = row < full
        ? RAMP[Math.max(4, RAMP.length - 1 - Math.floor(ratio * 6))]
        : RAMP[Math.ceil((filled - full) * (RAMP.length - 1))];
      context.fillStyle = ratio > 0.75 ? palette.hot : ratio > 0.45 ? palette.warm : palette.accent;
      context.fillText(glyph, x, height - row * cell);
    }
    const peakRow = Math.min(rows - 1, Math.floor(held[index] * rows));
    context.fillStyle = palette.text;
    context.fillText('-', x, height - peakRow * cell - cell);
  }
}

/** Firefly: a meadow at dusk; treble lights the flies, bass leans the grass. */
function drawFirefly(frame) {
  const { context, width, height, freq, palette } = frame;
  if (width < 4 || height < 4) return;
  const t = tick(frame);
  const seed = seedOf(frame);
  const treble = smooth(frame, 'treble', band(freq, freq.length * 0.3, freq.length * 0.75), 0.2);
  const wind = smooth(frame, 'wind', band(freq, 0, freq.length * 0.06), 0.05);
  const unit = Math.max(1.5, Math.min(width, height) / 90);

  // Grass: one path of thin blades along the bottom.
  const blade = Math.max(3, width / 120);
  context.fillStyle = palette.good;
  context.globalAlpha = 0.55;
  context.beginPath();
  for (let index = 0; index * blade < width; index += 1) {
    const x = index * blade;
    const tall = height * (0.04 + 0.06 * hash(seed, index, 19));
    const lean = (wind * 3 + 0.3) * blade * Math.sin(t * 0.02 + index * 0.3);
    context.moveTo(x, height);
    context.lineTo(x + blade * 0.5 + lean, height - tall);
    context.lineTo(x + blade, height);
  }
  context.fill();

  // Flies: slow Lissajous paths, each lit by its own chance.
  for (let index = 0; index < 48; index += 1) {
    const drift = Math.sin(t * (0.004 + hash(seed, index, 21) * 0.006) + hash(seed, index, 22) * TAU);
    const bob = Math.sin(t * (0.005 + hash(seed, index, 23) * 0.007) + hash(seed, index, 24) * TAU);
    const x = ((((hash(seed, index, 25) + drift * 0.15 + wind * 0.08) % 1) + 1) % 1) * width;
    const y = height * (0.12 + 0.62 * (0.5 + 0.5 * bob));
    const lit = hash(seed + index, Math.floor(t / 12 + hash(seed, index, 26) * 12), 27) < 0.15 + treble * 0.85;
    if (lit) {
      context.globalAlpha = 0.12 + treble * 0.18;
      context.fillStyle = palette.hot;
      context.beginPath();
      context.arc(x, y, unit * 3, 0, TAU);
      context.fill();
      context.globalAlpha = 1;
      context.fillRect(x - unit / 2, y - unit / 2, unit, unit);
    } else {
      context.globalAlpha = 0.35;
      context.fillStyle = palette.muted;
      context.fillRect(x - unit * 0.3, y - unit * 0.3, unit * 0.6, unit * 0.6);
    }
  }
  context.globalAlpha = 1;
}

/** Mosaic: fixed tiles, each wired to a band and its own threshold, glow and fade. */
function drawMosaic(frame) {
  const { context, width, height, palette, memory } = frame;
  if (width < 4 || height < 4) return;
  const seed = seedOf(frame);
  const tile = Math.max(6, height / 14);
  const columns = Math.max(1, Math.floor(width / tile));
  const rows = Math.max(1, Math.floor(height / tile));
  const count = columns * rows;
  const bands = 24;
  const layout = `${columns}x${rows}`;
  if (memory.layout !== layout) {
    memory.layout = layout;
    memory.glow = new Float32Array(count);
    memory.wiring = new Uint8Array(count);
    memory.threshold = new Float32Array(count);
    for (let cell = 0; cell < count; cell += 1) {
      const row = Math.floor(cell / columns);
      // Top rows listen to treble, bottom rows to bass, with some jitter.
      const lean = 1 - row / Math.max(1, rows - 1);
      const wired = Math.round(lean * (bands - 1) + (hash(seed, cell, 29) - 0.5) * 4);
      memory.wiring[cell] = Math.max(0, Math.min(bands - 1, wired));
      memory.threshold[cell] = 0.04 + hash(seed, cell, 31) * 0.74;
    }
  }
  const values = levels(frame, bands);
  const gap = Math.max(1, tile * 0.15);
  const fade = 0.05 * stepOf(frame);
  for (let cell = 0; cell < count; cell += 1) {
    const level = values[memory.wiring[cell]];
    const threshold = memory.threshold[cell];
    const target = level > threshold ? Math.min(1, 0.35 + (level - threshold) * 2) : 0;
    const glow = Math.max(target, memory.glow[cell] - fade);
    memory.glow[cell] = glow;
    if (glow < 0.05) continue;
    context.fillStyle = glow > 0.8 ? palette.hot : glow > 0.55 ? palette.warm : glow > 0.3 ? palette.accent : palette.muted;
    context.fillRect((cell % columns) * tile, Math.floor(cell / columns) * tile, tile - gap, tile - gap);
  }
}

/** Grains fall straight down, or slide diagonally off a slope; bottom row first. */
function sandFall(frame, grid, columns, rows) {
  const leftFirst = random(frame) < 0.5;
  for (let row = rows - 2; row >= 0; row -= 1) {
    for (let scan = 0; scan < columns; scan += 1) {
      const column = leftFirst ? scan : columns - 1 - scan;
      const at = row * columns + column;
      if (grid[at]) sandMove(frame, grid, at, sandTarget(frame, grid, at + columns, column, columns));
    }
  }
}

/** Where the grain above `below` goes next, or -1 to stay. */
function sandTarget(frame, grid, below, column, columns) {
  if (!grid[below]) return below;
  const left = column > 0 && !grid[below - 1];
  const right = column < columns - 1 && !grid[below + 1];
  if (left && right) return random(frame) < 0.5 ? below - 1 : below + 1;
  if (left) return below - 1;
  return right ? below + 1 : -1;
}

function sandMove(frame, grid, from, to) {
  if (to < 0) return;
  grid[to] = grid[from];
  grid[from] = 0;
}

/** Open the floor one row at a time until the pile is low again. */
function sandDrain(frame, grid, columns, rows) {
  const { memory } = frame;
  const floor = (rows - 1) * columns;
  for (let column = 0; column < columns; column += 1) {
    if (grid[floor + column]) memory.grains -= 1;
    grid[floor + column] = 0;
  }
  if (memory.grains < columns * rows * 0.1) memory.draining = false;
}

/** New grains drop in above their band: bass hot, mids warm, treble the accent. */
function sandPour(frame, grid, columns, values) {
  for (let index = 0; index < values.length; index += 1) {
    if (random(frame) >= values[index] * 0.5) continue;
    const column = Math.min(columns - 1, Math.floor(((index + random(frame)) / values.length) * columns));
    if (grid[column]) continue;
    grid[column] = index < values.length / 3 ? 3 : index < (values.length * 2) / 3 ? 2 : 1;
    frame.memory.grains += 1;
  }
}

/** A bass hit nudges a few rows sideways, which starts small avalanches. */
function sandShake(frame, grid, columns, rows) {
  for (let shake = 0; shake < 3; shake += 1) {
    const row = Math.floor(random(frame) * rows);
    const direction = random(frame) < 0.5 ? -1 : 1;
    for (let column = 1; column < columns - 1; column += 1) {
      const at = row * columns + column;
      if (grid[at] && !grid[at + direction] && random(frame) < 0.5) sandMove(frame, grid, at, at + direction);
    }
  }
}

/** One falling-sand step: grains fall, then the panel drains or pours and shakes. */
function sandStep(frame, grid, columns, rows, values) {
  const { memory } = frame;
  sandFall(frame, grid, columns, rows);
  if (memory.grains > columns * rows * 0.5) memory.draining = true;
  if (memory.draining) {
    sandDrain(frame, grid, columns, rows);
    return;
  }
  sandPour(frame, grid, columns, values);
  if (kick(frame, values[0])) sandShake(frame, grid, columns, rows);
}

/** Sand: grains pour in by band, pile up, slide, and drain when the pile is high. */
function drawSand(frame) {
  const { context, width, height, palette, memory } = frame;
  if (width < 4 || height < 4) return;
  const cell = Math.max(3, height / 48);
  const columns = Math.max(1, Math.floor(width / cell));
  const rows = Math.max(2, Math.floor(height / cell));
  const layout = `${columns}x${rows}`;
  if (memory.layout !== layout) {
    memory.layout = layout;
    memory.grid = new Uint8Array(columns * rows);
    memory.grains = 0;
    memory.draining = false;
    memory.pending = 0;
  }
  const values = levels(frame, 12);
  memory.pending += stepOf(frame);
  while (memory.pending >= 1) {
    memory.pending -= 1;
    sandStep(frame, memory.grid, columns, rows, values);
  }
  const tiers = [null, palette.accent, palette.warm, palette.hot];
  let current = 0;
  for (let at = 0; at < memory.grid.length; at += 1) {
    const grain = memory.grid[at];
    if (!grain) continue;
    if (grain !== current) {
      current = grain;
      context.fillStyle = tiers[grain];
    }
    context.fillRect((at % columns) * cell, Math.floor(at / columns) * cell, cell - 0.5, cell - 0.5);
  }
}

const GEYSER_CAPACITY = 640;
const GEYSER_FIELDS = 6; // x, y, vx, vy, life, tier

/** Launch one geyser particle into the ring, overwriting the oldest. */
function geyserSpawn(frame, strength, shares) {
  const { memory, width, height } = frame;
  const unit = height / 100;
  const at = memory.nextParticle * GEYSER_FIELDS;
  memory.nextParticle = (memory.nextParticle + 1) % GEYSER_CAPACITY;
  const particles = memory.particles;
  particles[at] = width / 2 + (random(frame) - 0.5) * width * 0.04;
  particles[at + 1] = height;
  particles[at + 2] = (random(frame) - 0.5) * unit * 0.8 * (1 + shares.treble * 2);
  particles[at + 3] = -unit * (3 + strength * 7) * (0.7 + random(frame) * 0.3);
  particles[at + 4] = 1;
  const pick = random(frame);
  particles[at + 5] = pick < shares.bass ? 3 : pick < shares.bass + shares.mid ? 2 : 1;
}

/** Geyser: a fountain; loudness keeps it flowing, bass hits shoot jets. */
function drawGeyser(frame) {
  const { context, width, height, freq, palette, memory } = frame;
  if (width < 4 || height < 4) return;
  if (!memory.particles) {
    memory.particles = new Float32Array(GEYSER_CAPACITY * GEYSER_FIELDS);
    memory.nextParticle = 0;
    memory.spawnDebt = 0;
  }
  const step = stepOf(frame);
  const bass = band(freq, 0, freq.length * 0.06);
  const mid = band(freq, freq.length * 0.06, freq.length * 0.3);
  const treble = band(freq, freq.length * 0.3, freq.length * 0.7);
  const sum = bass + mid + treble || 1;
  const shares = { bass: bass / sum, mid: mid / sum, treble: treble / sum };
  const loud = band(freq, 0, freq.length * 0.5);
  memory.spawnDebt += (loud * 4 + bass * 6) * step;
  while (memory.spawnDebt >= 1) {
    memory.spawnDebt -= 1;
    geyserSpawn(frame, loud, shares);
  }
  if (kick(frame, bass)) {
    for (let jet = 0; jet < 40; jet += 1) geyserSpawn(frame, 0.6 + bass * 0.4, shares);
  }
  const unit = height / 100;
  const gravity = unit * 0.35 * step;
  const size = Math.max(1.5, unit * 0.8);
  const particles = memory.particles;
  const tiers = [null, palette.good, palette.warm, palette.hot];
  for (let at = 0; at < particles.length; at += GEYSER_FIELDS) {
    if (particles[at + 4] <= 0) continue;
    particles[at + 3] += gravity;
    particles[at] += particles[at + 2] * step;
    particles[at + 1] += particles[at + 3] * step;
    particles[at + 4] -= 0.006 * step;
    if (particles[at + 1] > height + 5) particles[at + 4] = 0;
    if (particles[at + 4] <= 0) continue;
    context.globalAlpha = particles[at + 4];
    context.fillStyle = tiers[particles[at + 5]];
    context.fillRect(particles[at], particles[at + 1], size, size);
  }
  context.globalAlpha = 1;
}

// ---------------------------------------------------------- registry ----

/**
 * The mode registry. `None` is a real mode, not an absence: choosing it must
 * stop the loop rather than leave a blank canvas being repainted forever.
 */
export const MODES = Object.freeze([
  // cliamp's order, with Milkdrop and None kept last.
  { id: 'bars', label: 'Bars', draw: drawBars },
  { id: 'bars-dot', label: 'Bars Dot', draw: drawBarsDot },
  { id: 'rain', label: 'Rain', draw: drawRain },
  { id: 'bars-outline', label: 'Bars Outline', draw: drawBarsOutline },
  { id: 'bricks', label: 'Bricks', draw: drawBricks },
  { id: 'columns', label: 'Columns', draw: drawColumns },
  { id: 'classic-peak', label: 'Classic Peak', draw: drawClassicPeak },
  { id: 'wave', label: 'Wave', draw: drawWave },
  { id: 'scatter', label: 'Scatter', draw: drawScatter },
  { id: 'flame', label: 'Flame', draw: drawFlame },
  { id: 'retro', label: 'Retro', draw: drawRetro },
  { id: 'pulse', label: 'Pulse', draw: drawPulse },
  { id: 'matrix', label: 'Matrix', draw: drawMatrix },
  { id: 'binary', label: 'Binary', draw: drawBinary },
  { id: 'sakura', label: 'Sakura', draw: drawSakura },
  { id: 'firework', label: 'Firework', draw: drawFirework },
  { id: 'bubbles', label: 'Bubbles', draw: drawBubbles },
  { id: 'logo', label: 'Logo', draw: drawLogo },
  { id: 'terrain', label: 'Terrain', draw: drawTerrain },
  { id: 'scope', label: 'Scope', draw: drawScope },
  { id: 'heartbeat', label: 'Heartbeat', draw: drawHeartbeat },
  { id: 'butterfly', label: 'Butterfly', draw: drawButterfly },
  { id: 'ascii', label: 'Ascii', draw: drawAscii },
  { id: 'firefly', label: 'Firefly', draw: drawFirefly },
  { id: 'mosaic', label: 'Mosaic', draw: drawMosaic },
  { id: 'sand', label: 'Sand', draw: drawSand },
  { id: 'geyser', label: 'Geyser', draw: drawGeyser },
  { id: 'classic-led', label: 'Classic LED', draw: drawClassicLed },
  { id: 'stereo', label: 'Stereo', draw: drawStereo, stereo: true },
  // Milkdrop is not a pure draw function: Butterchurn owns WebGL state, so the
  // driver runs it through `milkdrop.mjs` instead of `drawFrame`.
  { id: 'milkdrop', label: 'Milkdrop', draw: null, external: 'milkdrop' },
  { id: 'none', label: 'None', draw: null },
]);

export const MODE_IDS = Object.freeze(MODES.map(mode => mode.id));

/** True for every mode that animates: the drawn ones and the external ones. */
export function isAnimated(mode) {
  return Boolean(mode?.draw || mode?.external);
}

export function modeById(id) {
  return MODES.find(mode => mode.id === id) ?? MODES[0];
}

/** Paint one frame. Returns false for the None mode, which draws nothing. */
export function drawFrame(mode, frame) {
  if (!mode?.draw) return false;
  clear(frame.context, frame.width, frame.height, frame.palette);
  frame.context.save();
  try {
    mode.draw(frame);
  } finally {
    frame.context.restore();
  }
  return true;
}

export { bars as spectrumBars, band as spectrumBand };
