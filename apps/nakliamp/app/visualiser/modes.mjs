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
  const out = new Float32Array(count);
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

function drawScatter({ context, width, height, freq, palette, memory }) {
  memory.points ??= [];
  const level = band(freq, 0, freq.length * 0.5);
  memory.points.push({ x: Math.random() * width, y: height, life: 1, size: 1 + level * 5 });
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

function drawMatrix({ context, width, height, freq, palette, memory }) {
  const columns = Math.floor(width / 12) || 1;
  memory.drops ??= new Float32Array(columns).map(() => Math.random() * height);
  if (memory.drops.length !== columns) memory.drops = new Float32Array(columns).map(() => Math.random() * height);
  const level = band(freq, 0, freq.length * 0.4);
  context.fillStyle = palette.good;
  context.font = '11px monospace';
  for (let index = 0; index < columns; index += 1) {
    const glyph = String.fromCharCode(0x30a0 + Math.floor(Math.random() * 96));
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

// ---------------------------------------------------------- registry ----

/**
 * The mode registry. `None` is a real mode, not an absence: choosing it must
 * stop the loop rather than leave a blank canvas being repainted forever.
 */
export const MODES = Object.freeze([
  { id: 'bars', label: 'Bars', draw: drawBars },
  { id: 'bars-dot', label: 'Bars Dot', draw: drawBarsDot },
  { id: 'bars-outline', label: 'Bars Outline', draw: drawBarsOutline },
  { id: 'classic-peak', label: 'Classic Peak', draw: drawClassicPeak },
  { id: 'classic-led', label: 'Classic LED', draw: drawClassicLed },
  { id: 'wave', label: 'Wave', draw: drawWave },
  { id: 'scope', label: 'Scope', draw: drawScope },
  { id: 'stereo', label: 'Stereo', draw: drawStereo, stereo: true },
  { id: 'pulse', label: 'Pulse', draw: drawPulse },
  { id: 'bricks', label: 'Bricks', draw: drawBricks },
  { id: 'columns', label: 'Columns', draw: drawColumns },
  { id: 'scatter', label: 'Scatter', draw: drawScatter },
  { id: 'flame', label: 'Flame', draw: drawFlame },
  { id: 'matrix', label: 'Matrix', draw: drawMatrix },
  { id: 'none', label: 'None', draw: null },
]);

export const MODE_IDS = Object.freeze(MODES.map(mode => mode.id));

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
